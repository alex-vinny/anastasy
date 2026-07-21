#!/usr/bin/env node
/*
 * anastasy (dbq) — CLI reversível para SQL Server
 * -----------------------------------------------
 * Executa SELECT/INSERT/UPDATE/DELETE de forma estruturada e mantém um
 * "git-like" undo journal: toda mutação grava o estado anterior (ou as PKs
 * inseridas) para permitir revert.
 *
 * Armazenamento: SQLite local (node:sqlite, embutido no Node 22+) em dbq.sqlite —
 *   journal (com snapshot gzipado), schema_cache e result_cache.
 *
 * Uso:
 *   node index.js <comando> [opções]
 *
 * Comandos:
 *   conns                                  Lista as conexões configuradas
 *   query    <conn> "<SELECT ...>"         SQL somente-leitura (SELECT/WITH) [--cache [ttl]]
 *   select   <conn> --table T [--schema sch] [--where "..."] [--top N] [--columns "a,b"]
 *   count    <conn> --table T [--where "..."]        Só a contagem (barato em tokens)
 *   describe <conn> <table> [--schema sch] [--refresh]   Colunas/tipos (usa schema_cache)
 *   auth     <conn> [--password <senha>] [--ttl <min>] [--clear]
 *                                          Cacheia senha de sessão (conexões sem Password= no .env)
 *   insert   <conn> --table T [--schema sch] --values '{json}' [--pk Id]
 *   update   <conn> --table T [--schema sch] --set '{json}' --where "..." [--pk Id]
 *   delete   <conn> --table T [--schema sch] --where "..." [--pk Id]
 *   ddl      <conn> "<CREATE/ALTER/DROP ...>" | --file <a.sql>   DDL (só dev/hml) [--yes] [--no-tx]
 *   log [--all]                            Lista o histórico de mutações
 *   show     <id> [--full]                 Detalha uma entrada (compacto; --full = snapshot)
 *   revert   <id>                          Desfaz uma mutação
 *   revert-last                            Desfaz a última mutação não-revertida
 *   cache-clear                            Limpa o result_cache
 *
 * Saída (economia de tokens):
 *   --format table|tsv|jsonl|json|count    (default: table)
 *   --full                                 Não esconde colunas nulas
 *   --top N                                Limite de linhas (default 50, máx 500)
 *
 * Segurança:
 *   - Mutações exigem --yes (sem isso, faz dry-run e mostra o snapshot/efeito).
 *   - Conexões readonly (claude_reader) recusam mutações.
 *   - Conexões prod recusam mutações sem --force-prod (evite!).
 *   - ddl só roda em conexões de ESCRITA não-prod (dev/hml); é BLOQUEADO em prod
 *     (sem override) e não é revertível automaticamente pelo journal (op=ddl, undo=none).
 *   - Conexão SEM Password= no .env usa senha de sessão: resolvida via env DBQ_PASSWORD,
 *     cache do 'auth' (com TTL) ou prompt interativo. Nunca fica em arquivo de config.
 */

// node:sqlite é experimental — silencia só esse warning (polui stdout/tokens).
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const msg = typeof warning === 'string' ? warning : warning && warning.message;
  if (msg && /SQLite is an experimental feature/i.test(msg)) return;
  return _emitWarning(warning, ...rest);
};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

let sql;
try {
  sql = require('mssql');
} catch (e) {
  console.error("Dependência ausente: rode 'npm install' em " + __dirname);
  process.exit(1);
}

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'dbq.sqlite');
const CONFIG_PATH = path.join(ROOT, 'connections.json');
const ENV_PATH = path.join(ROOT, '.env');
const DEFAULT_SCHEMA = 'sch';
const DEFAULT_TOP = 50;
const MAX_TOP = 500;
const DEFAULT_CACHE_TTL = 300; // segundos

// ---------------------------------------------------------------- args ----
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

// ------------------------------------------------------------- sqlite ----
let _db;
function db() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS journal (
      seq          INTEGER PRIMARY KEY,
      id           TEXT,
      ts           TEXT,
      connection   TEXT,
      database     TEXT,
      schema       TEXT,
      "table"      TEXT,
      pk           TEXT,
      op           TEXT,
      statement    TEXT,
      affected     INTEGER,
      where_clause TEXT,
      set_json     TEXT,
      values_json  TEXT,
      undo_kind    TEXT,
      snapshot_gz  BLOB,
      reverted     INTEGER DEFAULT 0,
      reverted_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS schema_cache (
      key          TEXT PRIMARY KEY,
      connection   TEXT,
      schema       TEXT,
      "table"      TEXT,
      columns_json TEXT,
      fetched_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS result_cache (
      hash       TEXT PRIMARY KEY,
      connection TEXT,
      sql        TEXT,
      rows_json  TEXT,
      fetched_at TEXT,
      ttl_sec    INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, val TEXT );
    CREATE TABLE IF NOT EXISTS credentials (
      connection TEXT PRIMARY KEY,
      secret     TEXT,
      expires_at TEXT,
      created_at TEXT
    );
  `);
  return _db;
}

// --------------------------------------------------------- connections ----
// Converte uma connection string ADO.NET no formato interno usado pelo mssql.
function parseConnString(cs) {
  const map = {};
  cs.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    map[part.slice(0, idx).trim().toLowerCase()] = part.slice(idx + 1).trim();
  });
  const truthy = (v, def) => (v === undefined ? def : /^(true|yes|1)$/i.test(v));
  return {
    server: map['data source'] || map['server'] || map['address'] || map['addr'],
    database: map['initial catalog'] || map['database'],
    user: map['user id'] || map['uid'] || map['user'],
    password: map['password'] || map['pwd'],
    encrypt: truthy(map['encrypt'], true),
    trustServerCertificate: truthy(map['trustservercertificate'] || map['trust server certificate'], true)
  };
}

// Lê um .env (KEY=connstring). Sufixos opcionais <NOME>_READONLY / <NOME>_PROD.
function parseEnv(text) {
  const raw = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    raw[key] = val;
  }
  const conns = {};
  for (const [key, val] of Object.entries(raw)) {
    if (/_(READONLY|PROD)$/i.test(key)) continue;
    if (!/data source\s*=|server\s*=/i.test(val)) continue; // apenas connection strings
    const p = parseConnString(val);
    const isReader = (p.user || '').toLowerCase().includes('reader');
    const looksProd = /prd|prod|pro-/i.test(`${p.database || ''} ${p.server || ''}`);
    const roFlag = raw[key + '_READONLY'];
    const prodFlag = raw[key + '_PROD'];
    p.prod = prodFlag !== undefined ? /^(true|1|yes)$/i.test(prodFlag) : looksProd;
    p.readonly = roFlag !== undefined ? /^(true|1|yes)$/i.test(roFlag) : (isReader || p.prod);
    conns[key] = p;
  }
  return conns;
}

function loadConnections() {
  let conns = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { conns = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).connections || {}; } catch (e) {}
  }
  if (fs.existsSync(ENV_PATH)) {
    Object.assign(conns, parseEnv(fs.readFileSync(ENV_PATH, 'utf8'))); // .env tem precedência
  }
  if (Object.keys(conns).length === 0) {
    fail('Nenhuma conexão configurada. Crie .env (veja .env.example) ou connections.json.');
  }
  return conns;
}

function getConn(name) {
  const conns = loadConnections();
  const c = conns[name];
  if (!c) fail(`Conexão "${name}" não existe. Use 'conns' para listar.`);
  return c;
}

// --- senha de sessão (conexões sem Password= no .env) ---
// Cache em dbq.sqlite (base64 = ofuscação, não criptografia — mesmo nível do .env,
// mas com TTL e fora de arquivo durável de config).
function getCachedCredential(name) {
  const row = db().prepare('SELECT secret, expires_at FROM credentials WHERE connection=?').get(name);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) return { expired: true, expiresAt: row.expires_at };
  return { secret: Buffer.from(row.secret, 'base64').toString('utf8'), expiresAt: row.expires_at };
}

function storeCredential(name, password, ttlMin) {
  const expires = new Date(Date.now() + ttlMin * 60000).toISOString();
  db().prepare(`INSERT OR REPLACE INTO credentials(connection,secret,expires_at,created_at)
                VALUES(?,?,?,?)`).run(name, Buffer.from(password, 'utf8').toString('base64'), expires, nowIso());
  return expires;
}

function promptHidden(msg) {
  return new Promise(resolve => {
    const readline = require('readline');
    process.stderr.write(msg);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = () => {}; // não ecoa a senha
    rl.question('', ans => { rl.close(); process.stderr.write('\n'); resolve(ans); });
  });
}

async function resolveSessionPassword(name) {
  if (process.env.DBQ_PASSWORD) return process.env.DBQ_PASSWORD;
  const cached = getCachedCredential(name);
  if (cached && !cached.expired) return cached.secret;
  if (process.stdin.isTTY) return promptHidden(`Senha para ${name}: `);
  fail(cached && cached.expired
    ? `Credencial de sessão de "${name}" EXPIROU em ${cached.expiresAt}. Rode: dbq auth ${name} --password <senha> [--ttl <min>]`
    : `Conexão "${name}" usa senha de sessão e não há credencial em cache. Rode: dbq auth ${name} --password <senha> [--ttl <min>]`);
}

async function getPool(name, passwordOverride) {
  const c = getConn(name);
  const password = passwordOverride ?? c.password ?? await resolveSessionPassword(name);
  const pool = new sql.ConnectionPool({
    server: c.server,
    database: c.database,
    user: c.user,
    password,
    options: {
      encrypt: c.encrypt !== false,
      trustServerCertificate: c.trustServerCertificate !== false
    },
    requestTimeout: 120000
  });
  try {
    await pool.connect();
  } catch (e) {
    if (!c.password && !passwordOverride && /login failed/i.test(e.message)) {
      fail(`Login falhou em "${name}" (${e.message}). A senha de sessão pode ter expirado no servidor — rode: dbq auth ${name} --password <senha>`);
    }
    throw e;
  }
  return pool;
}

function assertWritable(name, flags) {
  const c = getConn(name);
  if (c.readonly) {
    fail(`Conexão "${name}" é somente-leitura (usuário ${c.user}). Configure uma credencial de escrita em connections.json.`);
  }
  if (c.prod && !flags['force-prod']) {
    fail(`Conexão "${name}" é PRODUÇÃO. Mutação bloqueada. (use --force-prod só se tiver absoluta certeza)`);
  }
}

// DDL é mais perigoso e não-revertível: só permite em conexões de ESCRITA não-prod
// (dev/hml). Produção é bloqueada SEM override — DDL de prod vai pela pipeline de migrations.
function assertDdlAllowed(name) {
  const c = getConn(name);
  if (c.readonly) {
    fail(`Conexão "${name}" é somente-leitura (usuário ${c.user}). DDL exige conexão de escrita (dev/hml).`);
  }
  if (c.prod) {
    fail(`Conexão "${name}" é PRODUÇÃO. DDL é bloqueado em prod (sem override). Use a pipeline de migrations.`);
  }
}

// -------------------------------------------------------------- journal ----
function nextSeq() {
  const r = db().prepare('SELECT MAX(seq) AS m FROM journal').get();
  return (r && r.m ? r.m : 0) + 1;
}

function writeJournalEntry(entry) {
  const gz = gzipSync(Buffer.from(JSON.stringify(entry.undo || {})));
  db().prepare(`INSERT INTO journal
    (seq,id,ts,connection,database,schema,"table",pk,op,statement,affected,where_clause,set_json,values_json,undo_kind,snapshot_gz,reverted,reverted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL)`).run(
    entry.seq, entry.id, entry.timestamp, entry.connection, entry.database ?? null,
    entry.schema, entry.table, entry.pk, entry.op, entry.statement ?? null, entry.affected ?? 0,
    entry.where ?? null, entry.set ? JSON.stringify(entry.set) : null,
    entry.values ? JSON.stringify(entry.values) : null, entry.undo.kind, gz);
}

function rowToEntry(row) {
  const undo = JSON.parse(gunzipSync(Buffer.from(row.snapshot_gz)).toString('utf8'));
  return {
    seq: row.seq, id: row.id, timestamp: row.ts, connection: row.connection, database: row.database,
    op: row.op, schema: row.schema, table: row.table, pk: row.pk, statement: row.statement,
    affected: row.affected, where: row.where_clause,
    set: row.set_json ? JSON.parse(row.set_json) : undefined,
    values: row.values_json ? JSON.parse(row.values_json) : undefined,
    undo, reverted: !!row.reverted, revertedAt: row.reverted_at
  };
}

function findEntry(id) {
  const d = db();
  let row = d.prepare('SELECT * FROM journal WHERE seq=?').get(Number(id));
  if (!row) row = d.prepare('SELECT * FROM journal WHERE id=?').get(String(id));
  if (!row) fail(`Entrada de journal "${id}" não encontrada.`);
  return rowToEntry(row);
}

function markReverted(seq) {
  db().prepare('UPDATE journal SET reverted=1, reverted_at=? WHERE seq=?').run(nowIso(), seq);
}

// ----------------------------------------------------------- schema cache ----
async function fetchTableMeta(pool, schema, table) {
  const cols = await pool.request()
    .input('obj', `${schema}.${table}`).input('schema', schema).input('table', table)
    .query(`SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS type,
                   c.CHARACTER_MAXIMUM_LENGTH AS maxlen, c.IS_NULLABLE AS nullable,
                   COLUMNPROPERTY(OBJECT_ID(@obj), c.COLUMN_NAME, 'IsIdentity') AS ident
            FROM INFORMATION_SCHEMA.COLUMNS c
            WHERE c.TABLE_SCHEMA=@schema AND c.TABLE_NAME=@table
            ORDER BY c.ORDINAL_POSITION`);
  if (cols.recordset.length === 0) return null;
  const pk = await pool.request().input('schema', schema).input('table', table)
    .query(`SELECT k.COLUMN_NAME AS name
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
              ON k.CONSTRAINT_NAME=t.CONSTRAINT_NAME AND k.TABLE_SCHEMA=t.TABLE_SCHEMA
            WHERE t.CONSTRAINT_TYPE='PRIMARY KEY' AND t.TABLE_SCHEMA=@schema AND t.TABLE_NAME=@table`);
  const pks = new Set(pk.recordset.map(x => x.name));
  return cols.recordset.map(c => ({
    name: c.name, type: c.type, maxlen: c.maxlen,
    nullable: c.nullable === 'YES', identity: c.ident === 1, pk: pks.has(c.name)
  }));
}

async function getTableMeta(pool, conn, schema, table, refresh) {
  const key = `${conn}:${schema}.${table}`;
  const d = db();
  if (!refresh) {
    const row = d.prepare('SELECT columns_json FROM schema_cache WHERE key=?').get(key);
    if (row) return JSON.parse(row.columns_json);
  }
  const cols = await fetchTableMeta(pool, schema, table);
  if (cols) {
    d.prepare(`INSERT OR REPLACE INTO schema_cache(key,connection,schema,"table",columns_json,fetched_at)
               VALUES(?,?,?,?,?,?)`).run(key, conn, schema, table, JSON.stringify(cols), nowIso());
  }
  return cols;
}

// ----------------------------------------------------------- result cache ----
function cacheHash(conn, text) {
  return crypto.createHash('sha1').update(conn + '\n' + text).digest('hex');
}
function ttlFromFlag(flag) {
  if (!flag) return 0;
  if (flag === true) return DEFAULT_CACHE_TTL;
  const n = parseInt(flag, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_TTL;
}
function cacheGet(conn, text) {
  const h = cacheHash(conn, text);
  const row = db().prepare('SELECT rows_json, fetched_at, ttl_sec FROM result_cache WHERE hash=?').get(h);
  if (!row) return null;
  const age = (Date.now() - Date.parse(row.fetched_at)) / 1000;
  if (age > row.ttl_sec) { db().prepare('DELETE FROM result_cache WHERE hash=?').run(h); return null; }
  return JSON.parse(row.rows_json);
}
function cachePut(conn, text, rows, ttl) {
  db().prepare(`INSERT OR REPLACE INTO result_cache(hash,connection,sql,rows_json,fetched_at,ttl_sec)
                VALUES(?,?,?,?,?,?)`).run(cacheHash(conn, text), conn, text, JSON.stringify(rows), nowIso(), ttl);
}

// --------------------------------------------------------------- utils ----
function fail(msg) { console.error('ERRO: ' + msg); process.exit(1); }
function qual(schema, table) { return `[${schema}].[${table}]`; }
function nowIso() { return new Date().toISOString(); }

// Aplica valores de um objeto JS como parâmetros nomeados a um request mssql.
function bindParams(request, obj, prefix) {
  const names = {};
  let i = 0;
  for (const [k, v] of Object.entries(obj)) {
    const p = `${prefix}${i++}`;
    names[k] = p;
    request.input(p, v === null ? null : v);
  }
  return names;
}

function clampTop(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP;
  return Math.min(n, MAX_TOP);
}

// ------------------------------------------------------------ output (A) ----
function fmtVal(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function visibleColumns(rows, full) {
  const cols = Object.keys(rows[0]);
  if (full) return cols;
  const kept = cols.filter(c => rows.some(r => r[c] !== null && r[c] !== undefined));
  return kept.length ? kept : cols; // não esconde tudo se a(s) linha(s) forem toda(s) nula(s)
}

function renderTable(rows, cols) {
  const data = rows.map(r => cols.map(c => { const f = fmtVal(r[c]); return f === null ? 'NULL' : f; }));
  const w = cols.map((c, i) => Math.max(c.length, ...data.map(d => d[i].length)));
  const line = arr => arr.map((s, i) => s.padEnd(w[i])).join('  ').trimEnd();
  const out = [line(cols), w.map(x => '-'.repeat(x)).join('  ')];
  for (const d of data) out.push(line(d));
  return out.join('\n');
}

// Imprime um recordset de forma compacta. opts.fromCache → adiciona "cached".
function printRows(rows, flags, opts = {}) {
  const fmt = (flags.format || 'table').toLowerCase();
  if (fmt === 'count') { console.log(rows ? rows.length : 0); return; }
  if (!rows || rows.length === 0) { console.log('(0 linhas)'); return; }

  const cap = clampTop(flags.top || DEFAULT_TOP);
  const truncated = rows.length > cap;
  const shown = truncated ? rows.slice(0, cap) : rows;
  const allCols = Object.keys(shown[0]).length;
  const cols = visibleColumns(shown, flags.full);
  const hidden = allCols - cols.length;

  if (fmt === 'tsv') {
    console.log(cols.join('\t'));
    for (const r of shown) console.log(cols.map(c => { const f = fmtVal(r[c]); return f === null ? '' : f; }).join('\t'));
  } else if (fmt === 'jsonl') {
    for (const r of shown) {
      const o = {};
      for (const c of cols) { const v = r[c]; if (v !== null && v !== undefined) o[c] = v instanceof Date ? v.toISOString() : v; }
      console.log(JSON.stringify(o));
    }
  } else if (fmt === 'json') {
    if (flags.full) console.log(JSON.stringify(shown));
    else console.log(JSON.stringify(shown.map(r => {
      const o = {}; for (const c of cols) o[c] = r[c] instanceof Date ? r[c].toISOString() : r[c]; return o;
    })));
  } else {
    console.log(renderTable(shown, cols));
  }

  const parts = [`${shown.length}${truncated ? ` de ${rows.length}` : ''} linha(s)`];
  if (hidden > 0) parts.push(`${hidden} coluna(s) nula(s) ocultada(s) (use --full)`);
  if (opts.fromCache) parts.push('cached');
  console.log(`(${parts.join(', ')})`);
  if (truncated) console.log(`... truncado em ${cap}. use --top N (máx ${MAX_TOP}), refine --where, ou 'count'.`);
}

// ------------------------------------------------------------ commands ----
async function cmdConns() {
  const conns = loadConnections();
  for (const [name, c] of Object.entries(conns)) {
    const tags = [c.readonly ? 'readonly' : 'WRITE', c.prod ? 'PROD' : 'nonprod'];
    if (!c.password) {
      const cached = getCachedCredential(name);
      tags.push(!cached ? 'auth: pendente'
        : cached.expired ? 'auth: EXPIRADA'
        : `auth ok até ${cached.expiresAt.slice(11, 16)}Z`);
    }
    console.log(`${name.padEnd(12)} ${c.server} / ${c.database}  [${tags.join(' ')}]  user=${c.user}`);
  }
}

async function cmdAuth(connName, flags) {
  if (!connName) fail('uso: auth <conn> [--password <senha>] [--ttl <min>] [--clear]');
  const c = getConn(connName);
  if (flags.clear) {
    const r = db().prepare('DELETE FROM credentials WHERE connection=?').run(connName);
    console.log(r.changes ? `Credencial de ${connName} removida.` : `Nenhuma credencial em cache para ${connName}.`);
    return;
  }
  if (c.password) {
    console.error(`Aviso: "${connName}" tem Password= no .env — o cache do auth não será usado. Remova a senha do .env para ativar a senha de sessão.`);
  }
  let password = typeof flags.password === 'string' ? flags.password : null;
  if (!password) {
    if (!process.stdin.isTTY) fail('Sem terminal interativo: informe --password <senha>.');
    password = await promptHidden(`Senha para ${connName} (user ${c.user}): `);
  }
  if (!password) fail('Senha vazia.');

  // valida conectando de verdade antes de cachear
  const pool = await getPool(connName, password);
  await pool.close();

  const ttlMin = Math.max(1, parseInt(flags.ttl, 10) || 480);
  const expires = storeCredential(connName, password, ttlMin);
  console.log(`OK auth: credencial de ${connName} validada e cacheada até ${expires} (ttl ${ttlMin} min).`);
  console.log(`Limpar antes do vencimento: dbq auth ${connName} --clear`);
}

function ensureSelectOnly(text) {
  const t = text.trim().replace(/^\(+/, '').toLowerCase();
  if (!(t.startsWith('select') || t.startsWith('with') || t.startsWith('exec sp_help') || t.startsWith('declare'))) {
    fail("'query' só executa leitura (SELECT/WITH). Para mutações use insert/update/delete.");
  }
  if (/\b(update|delete|insert|drop|truncate|alter|merge)\b/.test(t) && !t.startsWith('with')) {
    fail('A query parece conter mutação. Use os comandos estruturados (insert/update/delete) para manter o journal.');
  }
}

async function cmdQuery(connName, queryText, flags) {
  if (!queryText) fail('Informe o SQL: query <conn> "SELECT ..."');
  ensureSelectOnly(queryText);
  const ttl = ttlFromFlag(flags.cache);
  if (ttl) {
    const hit = cacheGet(connName, queryText);
    if (hit) { printRows(hit, flags, { fromCache: true }); return; }
  }
  const pool = await getPool(connName);
  try {
    const r = await pool.request().query(queryText);
    if (ttl) cachePut(connName, queryText, r.recordset, ttl);
    printRows(r.recordset, flags);
  } finally {
    await pool.close();
  }
}

async function cmdSelect(connName, flags) {
  const schema = flags.schema || DEFAULT_SCHEMA;
  const table = flags.table || fail('--table obrigatório');
  const cols = flags.columns ? flags.columns : '*';
  const top = clampTop(flags.top || DEFAULT_TOP);
  const where = flags.where ? `WHERE ${flags.where}` : '';
  const q = `SELECT TOP (${top}) ${cols} FROM ${qual(schema, table)} ${where}`.trim();
  const ttl = ttlFromFlag(flags.cache);
  if (ttl) {
    const hit = cacheGet(connName, q);
    if (hit) { console.log('SQL> ' + q); printRows(hit, flags, { fromCache: true }); return; }
  }
  const pool = await getPool(connName);
  try {
    console.log('SQL> ' + q);
    const r = await pool.request().query(q);
    if (ttl) cachePut(connName, q, r.recordset, ttl);
    printRows(r.recordset, flags);
  } finally {
    await pool.close();
  }
}

async function cmdCount(connName, flags) {
  const schema = flags.schema || DEFAULT_SCHEMA;
  const table = flags.table || fail('--table obrigatório');
  const where = flags.where ? `WHERE ${flags.where}` : '';
  const q = `SELECT COUNT(*) AS n FROM ${qual(schema, table)} ${where}`.trim();
  const pool = await getPool(connName);
  try {
    const r = await pool.request().query(q);
    console.log(r.recordset[0].n);
  } finally {
    await pool.close();
  }
}

async function cmdDescribe(connName, table, flags) {
  const schema = flags.schema || DEFAULT_SCHEMA;
  const tbl = table || flags.table || fail('uso: describe <conn> <table> [--schema sch]');
  const pool = await getPool(connName);
  try {
    const meta = await getTableMeta(pool, connName, schema, tbl, !!flags.refresh);
    if (!meta) fail(`Tabela ${schema}.${tbl} não encontrada (confira --schema).`);
    console.log(`${schema}.${tbl}  (${meta.length} colunas)`);
    for (const c of meta) {
      const len = c.maxlen && c.maxlen > 0 ? `(${c.maxlen})` : (c.maxlen === -1 ? '(max)' : '');
      const tags = [c.pk ? 'PK' : '', c.identity ? 'IDENTITY' : '', c.nullable ? '' : 'NOT NULL'].filter(Boolean).join(' ');
      console.log(`  ${c.name.padEnd(28)} ${(c.type + len).padEnd(16)} ${tags}`.trimEnd());
    }
  } finally {
    await pool.close();
  }
}

async function cmdUpdate(connName, flags) {
  assertWritable(connName, flags);
  const schema = flags.schema || DEFAULT_SCHEMA;
  const table = flags.table || fail('--table obrigatório');
  const pk = flags.pk || 'Id';
  const where = flags.where || fail('--where obrigatório (evita UPDATE sem filtro)');
  const setObj = JSON.parse(flags.set || fail('--set \'{"col":valor}\' obrigatório'));

  const pool = await getPool(connName);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    // 1) snapshot das linhas afetadas (estado anterior)
    const snap = await new sql.Request(tx).query(`SELECT * FROM ${qual(schema, table)} WHERE ${where}`);
    const before = snap.recordset;

    if (before.length === 0) {
      await tx.rollback();
      console.log('Nenhuma linha corresponde ao filtro. Nada a fazer.');
      await pool.close();
      return;
    }
    if (before.some(r => r[pk] === undefined)) {
      await tx.rollback();
      fail(`A PK "${pk}" não existe no resultado. Informe --pk correto (necessário para o revert).`);
    }

    // 2) monta SET
    const setReq = new sql.Request(tx);
    const setNames = bindParams(setReq, setObj, 'set');
    const setClause = Object.keys(setObj).map(k => `[${k}] = @${setNames[k]}`).join(', ');
    const updSql = `UPDATE ${qual(schema, table)} SET ${setClause} WHERE ${where}`;

    if (!flags.yes) {
      await tx.rollback();
      console.log('[DRY-RUN] (sem --yes não aplica)');
      console.log('SQL>  ' + updSql);
      console.log(`Linhas que seriam alteradas: ${before.length}`);
      console.log('Colunas alteradas: ' + Object.keys(setObj).join(', '));
      printRows(before, { ...flags, top: 20 });
      await pool.close();
      return;
    }

    const upd = await setReq.query(updSql);

    // 3) journal (undo = restaurar valores anteriores por PK)
    const entry = {
      seq: nextSeq(),
      id: `u${Date.now()}`,
      timestamp: nowIso(),
      connection: connName,
      database: getConn(connName).database,
      op: 'update',
      schema, table, pk,
      statement: updSql,
      set: setObj,
      where,
      affected: upd.rowsAffected[0],
      undo: { kind: 'restore', rows: before },
      reverted: false
    };
    writeJournalEntry(entry);
    await tx.commit();
    console.log(`OK update: ${entry.affected} linha(s) alterada(s). journal #${entry.seq}. revert: node index.js revert ${entry.seq}`);
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    fail('update falhou: ' + e.message);
  } finally {
    await pool.close();
  }
}

async function cmdDelete(connName, flags) {
  assertWritable(connName, flags);
  const schema = flags.schema || DEFAULT_SCHEMA;
  const table = flags.table || fail('--table obrigatório');
  const pk = flags.pk || 'Id';
  const where = flags.where || fail('--where obrigatório (evita DELETE sem filtro)');

  const pool = await getPool(connName);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const snap = await new sql.Request(tx).query(`SELECT * FROM ${qual(schema, table)} WHERE ${where}`);
    const before = snap.recordset;
    if (before.length === 0) {
      await tx.rollback();
      console.log('Nenhuma linha corresponde ao filtro. Nada a fazer.');
      await pool.close();
      return;
    }

    const delSql = `DELETE FROM ${qual(schema, table)} WHERE ${where}`;
    if (!flags.yes) {
      await tx.rollback();
      console.log('[DRY-RUN] (sem --yes não aplica)');
      console.log('SQL>  ' + delSql);
      console.log(`Linhas que seriam removidas: ${before.length}`);
      printRows(before, { ...flags, top: 20 });
      await pool.close();
      return;
    }

    const del = await new sql.Request(tx).query(delSql);
    const entry = {
      seq: nextSeq(),
      id: `d${Date.now()}`,
      timestamp: nowIso(),
      connection: connName,
      database: getConn(connName).database,
      op: 'delete',
      schema, table, pk,
      statement: delSql,
      where,
      affected: del.rowsAffected[0],
      undo: { kind: 'reinsert', rows: before },
      reverted: false
    };
    writeJournalEntry(entry);
    await tx.commit();
    console.log(`OK delete: ${entry.affected} linha(s) removida(s). journal #${entry.seq}. revert: node index.js revert ${entry.seq}`);
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    fail('delete falhou: ' + e.message);
  } finally {
    await pool.close();
  }
}

async function cmdInsert(connName, flags) {
  assertWritable(connName, flags);
  const schema = flags.schema || DEFAULT_SCHEMA;
  const table = flags.table || fail('--table obrigatório');
  const pk = flags.pk || 'Id';
  const values = JSON.parse(flags.values || fail('--values \'{"col":valor}\' obrigatório'));

  const pool = await getPool(connName);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const req = new sql.Request(tx);
    const names = bindParams(req, values, 'v');
    const colList = Object.keys(values).map(k => `[${k}]`).join(', ');
    const valList = Object.keys(values).map(k => `@${names[k]}`).join(', ');
    // OUTPUT ... INTO @tbl (em vez de OUTPUT direto) p/ funcionar em tabelas com triggers
    // (SQL Server proíbe OUTPUT sem INTO quando há trigger habilitada).
    const insSql = `DECLARE @ids TABLE ([pk] sql_variant); INSERT INTO ${qual(schema, table)} (${colList}) OUTPUT INSERTED.[${pk}] INTO @ids ([pk]) VALUES (${valList}); SELECT [pk] AS pk FROM @ids;`;

    if (!flags.yes) {
      await tx.rollback();
      console.log('[DRY-RUN] (sem --yes não aplica)');
      console.log('SQL>  ' + insSql);
      console.log('Valores: ' + JSON.stringify(values));
      await pool.close();
      return;
    }

    const ins = await req.query(insSql);
    const insertedPks = ins.recordset.map(r => r.pk);
    const entry = {
      seq: nextSeq(),
      id: `i${Date.now()}`,
      timestamp: nowIso(),
      connection: connName,
      database: getConn(connName).database,
      op: 'insert',
      schema, table, pk,
      statement: insSql,
      values,
      affected: insertedPks.length,
      undo: { kind: 'delete-pks', pks: insertedPks },
      reverted: false
    };
    writeJournalEntry(entry);
    await tx.commit();
    console.log(`OK insert: PK(s) ${insertedPks.join(', ')}. journal #${entry.seq}. revert: node index.js revert ${entry.seq}`);
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    fail('insert falhou: ' + e.message);
  } finally {
    await pool.close();
  }
}

// Divide um script em batches por linhas contendo apenas GO (separador estilo sqlcmd).
function splitDdlBatches(text) {
  return text.split(/^\s*GO\s*;?\s*$/im).map(s => s.trim()).filter(Boolean);
}

async function cmdDdl(connName, stmtText, flags) {
  assertDdlAllowed(connName);

  let text = stmtText;
  if (flags.file) {
    try { text = fs.readFileSync(flags.file, 'utf8'); }
    catch (e) { fail('Não consegui ler --file: ' + e.message); }
  }
  if (!text || !text.trim()) {
    fail('Informe o DDL: ddl <conn> "CREATE TABLE ..." ou --file <arquivo.sql>');
  }

  const batches = splitDdlBatches(text);
  if (batches.length === 0) fail('Nenhum statement encontrado.');

  if (!flags.yes) {
    console.log('[DRY-RUN] (sem --yes não aplica)');
    console.log(`Conexão: ${connName} (${getConn(connName).database})  |  batches: ${batches.length}`);
    batches.forEach((b, i) => console.log(`--- batch ${i + 1} ---\n${b}`));
    console.log('⚠️  DDL NÃO é revertível pelo journal. Confira antes de rodar com --yes.');
    return;
  }

  const pool = await getPool(connName);
  const useTx = !flags['no-tx'];
  const tx = useTx ? new sql.Transaction(pool) : null;
  let ran = 0;
  try {
    if (useTx) await tx.begin();
    for (const b of batches) {
      const req = useTx ? new sql.Request(tx) : pool.request();
      await req.query(b);
      ran++;
    }
    const entry = {
      seq: nextSeq(),
      id: `x${Date.now()}`,
      timestamp: nowIso(),
      connection: connName,
      database: getConn(connName).database,
      op: 'ddl',
      schema: flags.schema || '-', table: '-', pk: '-',
      statement: text,
      affected: ran,
      undo: { kind: 'none' },
      reverted: false
    };
    writeJournalEntry(entry);
    if (useTx) await tx.commit();
    console.log(`OK ddl: ${ran} batch(es) executado(s)${useTx ? ' (em transação)' : ' (--no-tx)'}. journal #${entry.seq} (op=ddl, não auto-revertível).`);
  } catch (e) {
    if (useTx) { try { await tx.rollback(); } catch (_) {} }
    fail(`ddl falhou no batch ${ran + 1}/${batches.length}: ${e.message}`);
  } finally {
    await pool.close();
  }
}

function cmdLog(flags) {
  const rows = db().prepare(
    `SELECT seq, ts, op, connection, schema, "table" AS tbl, affected, where_clause, reverted
     FROM journal ${flags.all ? '' : 'WHERE reverted=0'} ORDER BY seq`).all();
  if (rows.length === 0) { console.log('(journal vazio)'); return; }
  for (const e of rows) {
    const rev = e.reverted ? ' [REVERTED]' : '';
    console.log(`#${String(e.seq).padStart(4)} ${e.ts}  ${String(e.op).toUpperCase().padEnd(6)} ${e.connection}:${e.schema}.${e.tbl}  afetadas=${e.affected}${rev}`);
    if (e.where_clause) console.log(`        where: ${e.where_clause}`);
  }
}

function cmdShow(id, flags) {
  const e = findEntry(id);
  if (flags.full) { console.log(JSON.stringify(e, null, 2)); return; }
  const undoSize = e.undo.rows ? `${e.undo.rows.length} linha(s) snapshot`
    : e.undo.pks ? `${e.undo.pks.length} pk(s)` : '-';
  console.log(JSON.stringify({
    seq: e.seq, id: e.id, timestamp: e.timestamp, connection: e.connection, database: e.database,
    op: e.op, table: `${e.schema}.${e.table}`, pk: e.pk, affected: e.affected,
    where: e.where, set: e.set, values: e.values,
    undo: `${e.undo.kind} (${undoSize})`, reverted: e.reverted, revertedAt: e.revertedAt
  }, null, 2));
  console.log(`(use 'show ${e.seq} --full' para ver o snapshot completo)`);
}

function cmdCacheClear() {
  const r = db().prepare('DELETE FROM result_cache').run();
  console.log(`result_cache limpo (${r.changes} entrada(s)).`);
}

async function cmdRevert(id, flags) {
  const entry = findEntry(id);
  if (entry.reverted) fail(`Entrada #${entry.seq} já foi revertida.`);
  assertWritable(entry.connection, flags);

  const pool = await getPool(entry.connection);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const { schema, table, pk } = entry;

    if (entry.undo.kind === 'restore') {
      // UPDATE: restaura cada linha pelos valores anteriores
      for (const row of entry.undo.rows) {
        const req = new sql.Request(tx);
        const cols = Object.keys(row).filter(c => c !== pk);
        const names = bindParams(req, Object.fromEntries(cols.map(c => [c, row[c]])), 'r');
        req.input('pkval', row[pk]);
        const setClause = cols.map(c => `[${c}] = @${names[c]}`).join(', ');
        await req.query(`UPDATE ${qual(schema, table)} SET ${setClause} WHERE [${pk}] = @pkval`);
      }
      console.log(`Revert update: ${entry.undo.rows.length} linha(s) restaurada(s).`);
    } else if (entry.undo.kind === 'reinsert') {
      // DELETE: reinsere as linhas removidas (com IDENTITY_INSERT se necessário).
      // Identidade: usa schema_cache se disponível, senão consulta ao vivo.
      const meta = await getTableMeta(pool, entry.connection, schema, table, false).catch(() => null);
      let identity = meta ? !!(meta.find(c => c.name === pk) || {}).identity : null;
      if (identity === null) {
        const r = await pool.request().query(
          `SELECT COLUMNPROPERTY(OBJECT_ID('${schema}.${table}'), '${pk}', 'IsIdentity') AS isId`);
        identity = r.recordset[0] && r.recordset[0].isId === 1;
      }
      if (identity) await new sql.Request(tx).query(`SET IDENTITY_INSERT ${qual(schema, table)} ON`);
      for (const row of entry.undo.rows) {
        const req = new sql.Request(tx);
        const cols = Object.keys(row);
        const names = bindParams(req, row, 'r');
        const colList = cols.map(c => `[${c}]`).join(', ');
        const valList = cols.map(c => `@${names[c]}`).join(', ');
        await req.query(`INSERT INTO ${qual(schema, table)} (${colList}) VALUES (${valList})`);
      }
      if (identity) await new sql.Request(tx).query(`SET IDENTITY_INSERT ${qual(schema, table)} OFF`);
      console.log(`Revert delete: ${entry.undo.rows.length} linha(s) reinserida(s).`);
    } else if (entry.undo.kind === 'delete-pks') {
      // INSERT: remove as PKs inseridas
      const req = new sql.Request(tx);
      const list = entry.undo.pks.map((p, i) => { req.input('p' + i, p); return '@p' + i; }).join(', ');
      const r = await req.query(`DELETE FROM ${qual(schema, table)} WHERE [${pk}] IN (${list})`);
      console.log(`Revert insert: ${r.rowsAffected[0]} linha(s) removida(s).`);
    } else if (entry.undo.kind === 'none') {
      await tx.rollback();
      fail(`Entrada #${entry.seq} é DDL (op=ddl) e não é revertível automaticamente. Desfaça manualmente com outro 'ddl'.`);
    } else {
      await tx.rollback();
      fail('Tipo de undo desconhecido: ' + entry.undo.kind);
    }

    await tx.commit();
    markReverted(entry.seq);
    console.log(`OK revert #${entry.seq}.`);
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    fail('revert falhou: ' + e.message);
  } finally {
    await pool.close();
  }
}

async function cmdRevertLast(flags) {
  const row = db().prepare('SELECT seq FROM journal WHERE reverted=0 ORDER BY seq DESC LIMIT 1').get();
  if (!row) fail('Nenhuma mutação pendente para reverter.');
  await cmdRevert(row.seq, flags);
}

// --------------------------------------------------------------- main ----
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { positionals, flags } = parseArgs(argv.slice(1));

  switch (cmd) {
    case 'conns': return cmdConns();
    case 'auth': return cmdAuth(positionals[0], flags);
    case 'query': return cmdQuery(positionals[0], positionals[1], flags);
    case 'select': return cmdSelect(positionals[0], flags);
    case 'count': return cmdCount(positionals[0], flags);
    case 'describe': return cmdDescribe(positionals[0], positionals[1], flags);
    case 'update': return cmdUpdate(positionals[0], flags);
    case 'delete': return cmdDelete(positionals[0], flags);
    case 'insert': return cmdInsert(positionals[0], flags);
    case 'ddl': return cmdDdl(positionals[0], positionals[1], flags);
    case 'log': return cmdLog(flags);
    case 'show': return cmdShow(positionals[0], flags);
    case 'revert': return cmdRevert(positionals[0], flags);
    case 'revert-last': return cmdRevertLast(flags);
    case 'cache-clear': return cmdCacheClear();
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace('#!/usr/bin/env node', '').trim());
      if (cmd) fail('Comando desconhecido: ' + cmd);
  }
}

main().catch(e => fail(e.message));
