#!/usr/bin/env node
/*
 * anastasy (dbq) — reversible CLI for SQL Server
 * ----------------------------------------------
 * Runs SELECT/INSERT/UPDATE/DELETE in a structured way and keeps a
 * "git-like" undo journal: every mutation records the prior state (or the
 * inserted PKs) so it can be reverted.
 *
 * Storage: local SQLite (node:sqlite, built into Node 22+) in dbq.sqlite —
 *   journal (with a gzipped snapshot), schema_cache and result_cache.
 *
 * Usage:
 *   node index.js <command> [options]
 *
 * Commands:
 *   conns                                  List the configured connections
 *   query    <conn> "<SELECT ...>"         Read-only SQL (SELECT/WITH) [--cache [ttl]]
 *   select   <conn> --table T [--schema sch] [--where "..."] [--top N] [--columns "a,b"]
 *   count    <conn> --table T [--where "..."]        Just the count (cheap in tokens)
 *   describe <conn> <table> [--schema sch] [--refresh]   Columns/types (uses schema_cache)
 *   auth     <conn> [--password <pwd>] [--ttl <min>] [--clear] [--device]
 *                                          Cache a session password (connections without Password= in .env)
 *                                          or sign in with Azure AD (Authentication=Active Directory ... in .env)
 *   insert   <conn> --table T [--schema sch] --values '{json}' [--pk Id]
 *   update   <conn> --table T [--schema sch] --set '{json}' --where "..." [--pk Id]
 *   delete   <conn> --table T [--schema sch] --where "..." [--pk Id]
 *   ddl      <conn> "<CREATE/ALTER/DROP ...>" | --file <a.sql>   DDL (dev/hml only) [--yes] [--no-tx]
 *   log [--all]                            List the mutation history
 *   show     <id> [--full]                 Detail one entry (compact; --full = snapshot)
 *   revert   <id>                          Undo one mutation
 *   revert-last                            Undo the most recent non-reverted mutation
 *   cache-clear                            Clear the result_cache
 *
 * Output (token economy):
 *   --format table|tsv|jsonl|json|count    (default: table)
 *   --full                                 Do not hide null columns
 *   --top N                                Row limit (default 50, max 500)
 *
 * Safety:
 *   - Mutations require --yes (without it, a dry-run showing the snapshot/effect).
 *   - Read-only connections (reader user) refuse mutations.
 *   - Prod connections refuse mutations without --force-prod (avoid it!).
 *   - ddl runs only on non-prod WRITE connections (dev/hml); it is BLOCKED in prod
 *     (no override) and is not auto-revertible by the journal (op=ddl, undo=none).
 *   - A connection WITHOUT Password= in .env uses a session password: resolved via the
 *     DBQ_PASSWORD env var, the 'auth' cache (with a TTL) or an interactive prompt.
 *     It never lives in a config file.
 *   - Authentication=Active Directory Interactive|Device Code|Default uses your own Azure AD
 *     user (MFA in the browser, once per device). Token cached in dbq.sqlite; DBQ_TOKEN env
 *     var overrides it (e.g. from `az account get-access-token --resource https://database.windows.net/`).
 */

// node:sqlite is experimental — silence only that warning (it pollutes stdout/tokens).
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
  console.error("Missing dependency: run 'npm install' in " + __dirname);
  process.exit(1);
}

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'dbq.sqlite');
const CONFIG_PATH = path.join(ROOT, 'connections.json');
const ENV_PATH = path.join(ROOT, '.env');
const DEFAULT_SCHEMA = 'sch';
const DEFAULT_TOP = 50;
const MAX_TOP = 500;
const DEFAULT_CACHE_TTL = 300; // seconds

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

// Every flag any command reads. parseArgs takes anything after `--`, so a typo used
// to be swallowed and the command ran as if the flag had not been passed — on a
// mutation that means `--yes` silently missing, or `--where` quietly not applied.
// Warns rather than exiting, so existing scripted calls keep working.
const KNOWN_FLAGS = new Set([
  'all', 'cache', 'clear', 'columns', 'device', 'file', 'force-prod', 'format', 'full',
  'no-tx', 'password', 'pk', 'refresh', 'schema', 'set', 'table', 'top', 'ttl', 'values',
  'where', 'yes',
]);

/** Pure: the unknown flags, each with a spelling suggestion when one is close. */
function unknownFlags(flags, known = KNOWN_FLAGS) {
  return Object.keys(flags || {})
    .filter((k) => !known.has(k))
    .map((k) => ({
      flag: k,
      suggestion: [...known].find((c) => Math.abs(c.length - k.length) <= 2 && editDistance(k, c) <= 2) || null,
    }));
}

function warnUnknownFlags(flags) {
  for (const { flag, suggestion } of unknownFlags(flags)) {
    console.error(`warning: unknown flag --${flag}${suggestion ? ` (did you mean --${suggestion}?)` : ''} — it was ignored.`);
  }
}

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
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
// Converts an ADO.NET connection string into the internal shape used by mssql.
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
    // Authentication=Active Directory Interactive|Device Code|Default → Azure AD (see aad section)
    authMode: normalizeAuthMode(map['authentication']),
    tenantId: map['tenant id'] || map['tenantid'] || map['authority id'],
    encrypt: truthy(map['encrypt'], true),
    trustServerCertificate: truthy(map['trustservercertificate'] || map['trust server certificate'], true)
  };
}

// Reads a .env (KEY=connstring). Optional suffixes <NAME>_READONLY / <NAME>_PROD / <NAME>_DESC.
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
    if (/_(READONLY|PROD|DESC|SCHEMA)$/i.test(key)) continue;
    if (!/data source\s*=|server\s*=/i.test(val)) continue; // connection strings only
    const p = parseConnString(val);
    const isReader = (p.user || '').toLowerCase().includes('reader');
    const looksProd = /prd|prod|pro-/i.test(`${p.database || ''} ${p.server || ''}`);
    const roFlag = raw[key + '_READONLY'];
    const prodFlag = raw[key + '_PROD'];
    p.prod = prodFlag !== undefined ? /^(true|1|yes)$/i.test(prodFlag) : looksProd;
    p.readonly = roFlag !== undefined ? /^(true|1|yes)$/i.test(roFlag) : (isReader || p.prod);
    p.desc = (raw[key + '_DESC'] || '').trim() || undefined;
    // A schema here is a TENANT, so the right default is per-connection, not global.
    p.schema = (raw[key + '_SCHEMA'] || '').trim() || undefined;
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
    Object.assign(conns, parseEnv(fs.readFileSync(ENV_PATH, 'utf8'))); // .env takes precedence
  }
  if (Object.keys(conns).length === 0) {
    fail('No connection configured. Create .env (see .env.example) or connections.json.');
  }
  return conns;
}

function getConn(name) {
  const conns = loadConnections();
  const c = conns[name];
  if (!c) fail(`Connection "${name}" does not exist. Use 'conns' to list.`);
  return c;
}

// --- session password (connections without Password= in .env) ---
// Cached in dbq.sqlite (base64 = obfuscation, not encryption — same level as .env,
// but with a TTL and outside a durable config file).
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
    rl._writeToOutput = () => {}; // do not echo the password
    rl.question('', ans => { rl.close(); process.stderr.write('\n'); resolve(ans); });
  });
}

async function resolveSessionPassword(name) {
  if (process.env.DBQ_PASSWORD) return process.env.DBQ_PASSWORD;
  const cached = getCachedCredential(name);
  if (cached && !cached.expired) return cached.secret;
  if (process.stdin.isTTY) return promptHidden(`Password for ${name}: `);
  fail(cached && cached.expired
    ? `Session credential for "${name}" EXPIRED at ${cached.expiresAt}. Run: dbq auth ${name} --password <pwd> [--ttl <min>]`
    : `Connection "${name}" uses a session password and there is no cached credential. Run: dbq auth ${name} --password <pwd> [--ttl <min>]`);
}

// --- Azure AD / Entra ID (Authentication= in the connection string) -----------
// Modes (ADO.NET-style values, case-insensitive):
//   Active Directory Interactive  → browser sign-in with MFA (your own user)
//   Active Directory Device Code  → prints a URL + code; sign in from any device
//   Active Directory Default      → DefaultAzureCredential (az login / Azure PowerShell / env / MSI)
// Interactive/Device Code: the access token (~1h) is cached in the credentials table;
// the MSAL refresh-token cache (@azure/identity-cache-persistence, OS keychain/DPAPI)
// plus the stored authentication record renew it silently, so MFA happens once per device.
// No password is ever stored. `User Id=` is used only as a login hint; `Tenant Id=` is optional.
const AAD_SCOPE = 'https://database.windows.net/.default';
const AAD_MODES = {
  'active directory interactive': 'interactive',
  'active directory device code': 'devicecode',
  'active directory default': 'default',
  'active directory azure cli': 'default'
};

function normalizeAuthMode(v) {
  if (!v) return undefined;
  const k = v.trim().toLowerCase().replace(/\s+/g, ' ');
  return AAD_MODES[k] || AAD_MODES['active directory ' + k] || ('unsupported:' + v.trim());
}

let _identity, _persistence;
function identity() { return _identity || (_identity = require('@azure/identity')); }
function aadPersistence() {
  if (_persistence !== undefined) return _persistence;
  try {
    const { cachePersistencePlugin } = require('@azure/identity-cache-persistence');
    identity().useIdentityPlugin(cachePersistencePlugin);
    _persistence = { enabled: true, name: 'dbq-anastasy' };
  } catch (e) { _persistence = null; } // plugin missing → login again when the token expires
  return _persistence;
}

function buildAadCredential(c, mode, { record, silent } = {}) {
  const id = identity();
  const opts = { tenantId: c.tenantId || 'organizations', disableAutomaticAuthentication: !!silent };
  const persistence = aadPersistence();
  if (persistence) opts.tokenCachePersistenceOptions = persistence;
  if (record) opts.authenticationRecord = record;
  if (mode === 'devicecode') {
    return new id.DeviceCodeCredential({ ...opts, userPromptCallback: info => console.error(info.message) });
  }
  if (c.user) opts.loginHint = c.user;
  return new id.InteractiveBrowserCredential(opts);
}

function getCachedAad(name) {
  const row = db().prepare('SELECT secret, expires_at FROM credentials WHERE connection=?').get(name);
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(Buffer.from(row.secret, 'base64').toString('utf8')); } catch (e) { return null; }
  if (data.kind !== 'aad') return null;
  const record = data.record ? identity().deserializeAuthenticationRecord(data.record) : undefined;
  return { token: data.token, record, account: data.account, expiresAt: row.expires_at, expired: Date.parse(row.expires_at) < Date.now() };
}

function storeAadToken(name, token, record) {
  // keep a 2-minute safety margin before the real expiry
  const expires = new Date(token.expiresOnTimestamp - 120000).toISOString();
  const payload = {
    kind: 'aad', token: token.token, account: record && record.username,
    record: record ? identity().serializeAuthenticationRecord(record) : undefined
  };
  db().prepare(`INSERT OR REPLACE INTO credentials(connection,secret,expires_at,created_at)
                VALUES(?,?,?,?)`).run(name, Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'), expires, nowIso());
  return expires;
}

// Explicit sign-in (browser / device code). Always allowed, even without a TTY — `dbq auth` is a deliberate act.
async function aadLogin(name, c, mode) {
  const cred = buildAadCredential(c, mode);
  const record = await cred.authenticate(AAD_SCOPE);
  const token = await cred.getToken(AAD_SCOPE);
  const expires = storeAadToken(name, token, record);
  return { token: token.token, record, expires };
}

async function resolveAadToken(name, c, mode, { allowPrompt } = {}) {
  if (process.env.DBQ_TOKEN) return process.env.DBQ_TOKEN; // e.g. az account get-access-token --resource https://database.windows.net/
  const cached = getCachedAad(name);
  if (cached && !cached.expired) return cached.token;
  if (cached && cached.record) {
    // silent renewal from the persisted MSAL cache — no browser, no MFA
    try {
      const t = await buildAadCredential(c, mode, { record: cached.record, silent: true }).getToken(AAD_SCOPE);
      storeAadToken(name, t, cached.record);
      return t.token;
    } catch (e) { /* refresh token gone/expired → interactive below */ }
  }
  if (!allowPrompt) {
    fail(`Azure AD token for "${name}" is ${cached ? 'expired' : 'missing'} and silent renewal is not possible. Run: dbq auth ${name} (opens the browser for MFA; add --device for device-code).`);
  }
  return (await aadLogin(name, c, mode)).token;
}

async function getPool(name, passwordOverride) {
  const c = getConn(name);
  const cfg = {
    server: c.server,
    database: c.database,
    options: {
      encrypt: c.encrypt !== false,
      trustServerCertificate: c.trustServerCertificate !== false
    },
    requestTimeout: 120000
  };
  if (c.authMode) {
    if (c.authMode.startsWith('unsupported:')) {
      fail(`Connection "${name}": Authentication="${c.authMode.slice(12)}" is not supported. Use: Active Directory Interactive | Active Directory Device Code | Active Directory Default.`);
    }
    if (c.authMode === 'default') {
      cfg.authentication = { type: 'azure-active-directory-default', options: {} };
    } else {
      const token = await resolveAadToken(name, c, c.authMode, { allowPrompt: !!process.stdin.isTTY });
      cfg.authentication = { type: 'azure-active-directory-access-token', options: { token } };
    }
  } else {
    cfg.user = c.user;
    cfg.password = passwordOverride ?? c.password ?? await resolveSessionPassword(name);
  }
  const pool = new sql.ConnectionPool(cfg);
  try {
    await pool.connect();
  } catch (e) {
    if (c.authMode && /login failed/i.test(e.message)) {
      fail(`Login failed for "${name}" with Azure AD (${e.message}). Either the token is stale (dbq auth ${name} --clear, then dbq auth ${name}) or your account is not a user in database "${c.database}".`);
    }
    if (!c.authMode && !c.password && !passwordOverride && /login failed/i.test(e.message)) {
      fail(`Login failed for "${name}" (${e.message}). The session password may have expired on the server — run: dbq auth ${name} --password <pwd>`);
    }
    throw e;
  }
  return pool;
}

function assertWritable(name, flags) {
  const c = getConn(name);
  if (c.readonly) {
    fail(`Connection "${name}" is read-only (user ${c.user}). Configure a write credential in connections.json.`);
  }
  if (c.prod && !flags['force-prod']) {
    fail(`Connection "${name}" is PRODUCTION. Mutation blocked. (use --force-prod only if you are absolutely sure)`);
  }
}

// DDL is more dangerous and not revertible: allowed only on non-prod WRITE connections
// (dev/hml). Production is blocked with NO override — prod DDL goes through the migrations pipeline.
function assertDdlAllowed(name) {
  const c = getConn(name);
  if (c.readonly) {
    fail(`Connection "${name}" is read-only (user ${c.user}). DDL requires a write connection (dev/hml).`);
  }
  if (c.prod) {
    fail(`Connection "${name}" is PRODUCTION. DDL is blocked in prod (no override). Use the migrations pipeline.`);
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
  if (!row) fail(`Journal entry "${id}" not found.`);
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
function fail(msg) { console.error('ERROR: ' + msg); process.exit(1); }
// Bracket-quote a schema/table pair.
//
// This used to take whatever it was handed, so a caller doing the natural thing and
// passing `--table sch1.Contract` got `[sch].[sch1.Contract]` — one broken identifier
// rather than a two-part name, and SQL Server then complains about the *table*, which
// sends you looking in the wrong place. splitTarget() resolves that before we get here.
function qual(schema, table) { return `[${schema}].[${table}]`; }

// Split a possibly-qualified table name. `sch1.Contract` -> { schema: 'sch1', table: 'Contract' };
// `[sch1].[Contract]` likewise. An unqualified name keeps the caller's schema.
// Throws rather than calling fail(): fail() exits the process, which makes the
// function impossible to unit-test. resolveTarget translates the throw back into
// the usual CLI error, so behaviour at the command line is unchanged.
function splitTarget(rawTable, fallbackSchema) {
  const raw = String(rawTable == null ? '' : rawTable).trim();
  const bracketed = raw.match(/^\[([^\]]+)\]\.\[([^\]]+)\]$/);
  if (bracketed) return { schema: bracketed[1], table: bracketed[2], qualified: true };
  const plain = raw.match(/^([A-Za-z_][\w$#@]*)\.([A-Za-z_][\w$#@]*)$/);
  if (plain) return { schema: plain[1], table: plain[2], qualified: true };
  if (raw.split('.').length > 2) {
    throw new Error(`--table "${raw}" has more than two parts. Pass <schema>.<table>, or use --schema with a bare table name.`);
  }
  return { schema: fallbackSchema, table: raw.replace(/^\[|\]$/g, ''), qualified: false };
}

/**
 * The one place that decides which schema a command runs against.
 *
 * Resolution order: an explicit `<schema>.<table>` › `--schema` › the connection's
 * own default (`<CONN>_SCHEMA` in .env) › DEFAULT_SCHEMA.
 *
 * The global default cannot be made "right": in these databases a schema is a
 * TENANT, so the correct value depends on the connection, the environment and the
 * client. That is why the per-connection key exists and why `dbq schemas <conn>`
 * does — guessing schN until one works is not a workflow.
 */
function resolveTarget(connName, flags, { requireTable = true, perConnSchema } = {}) {
  const explicit = (flags.schema && flags.schema !== true) ? flags.schema : null;
  const perConn = perConnSchema !== undefined ? perConnSchema : connDefaultSchema(connName);
  const fallback = explicit || perConn || DEFAULT_SCHEMA;
  const rawTable = flags.table || (requireTable ? fail('--table required') : '');
  let t;
  try { t = splitTarget(rawTable, fallback); }
  catch (e) { return fail(e.message); }
  if (t.qualified && explicit && explicit !== t.schema) {
    fail(`Conflicting schema: --table "${rawTable}" says "${t.schema}" but --schema says "${explicit}". Pass one.`);
  }
  return { schema: t.schema, table: t.table, source: t.qualified ? 'table' : (explicit ? '--schema' : (perConn ? '.env' : 'default')) };
}

// Optional per-connection schema, e.g. `ELHML_SCHEMA=sch1` — the same sidecar shape
// the file already uses for `<CONN>_DESC`.
//
// Reads the raw .env rather than going through loadConnections(): that helper calls
// fail() (process.exit) when no connection is configured, which a lookup for an
// optional default has no business triggering.
function schemaFromEnvText(text, connName) {
  if (!connName) return null;
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() !== `${connName}_SCHEMA`) continue;
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    return val.trim() || null;
  }
  return null;
}

function connDefaultSchema(connName) {
  if (!connName) return null;
  try {
    if (!fs.existsSync(ENV_PATH)) return null;
    return schemaFromEnvText(fs.readFileSync(ENV_PATH, 'utf8'), connName);
  } catch { return null; }
}
function nowIso() { return new Date().toISOString(); }

// Binds a JS object's values as named parameters on an mssql request.
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

// ------------------------------------------------------------ output ----
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
  return kept.length ? kept : cols; // don't hide everything if the row(s) are entirely null
}

function renderTable(rows, cols) {
  const data = rows.map(r => cols.map(c => { const f = fmtVal(r[c]); return f === null ? 'NULL' : f; }));
  const w = cols.map((c, i) => Math.max(c.length, ...data.map(d => d[i].length)));
  const line = arr => arr.map((s, i) => s.padEnd(w[i])).join('  ').trimEnd();
  const out = [line(cols), w.map(x => '-'.repeat(x)).join('  ')];
  for (const d of data) out.push(line(d));
  return out.join('\n');
}

// Prints a recordset compactly. opts.fromCache → append "cached".
function printRows(rows, flags, opts = {}) {
  const fmt = (flags.format || 'table').toLowerCase();
  if (fmt === 'count') { console.log(rows ? rows.length : 0); return; }
  if (!rows || rows.length === 0) { console.log('(0 rows)'); return; }

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

  const parts = [`${shown.length}${truncated ? ` of ${rows.length}` : ''} row(s)`];
  if (hidden > 0) parts.push(`${hidden} null column(s) hidden (use --full)`);
  if (opts.fromCache) parts.push('cached');
  console.log(`(${parts.join(', ')})`);
  if (truncated) console.log(`... truncated at ${cap}. use --top N (max ${MAX_TOP}), refine --where, or 'count'.`);
}

// ------------------------------------------------------------ commands ----
async function cmdConns() {
  const conns = loadConnections();
  for (const [name, c] of Object.entries(conns)) {
    const tags = [c.readonly ? 'readonly' : 'WRITE', c.prod ? 'PROD' : 'nonprod'];
    if (c.authMode) {
      tags.push(`aad:${c.authMode}`);
      if (c.authMode === 'interactive' || c.authMode === 'devicecode') {
        const cached = getCachedAad(name);
        tags.push(!cached ? 'auth: pending (dbq auth)'
          : cached.expired ? (cached.record ? 'auth: token expired (renews silently)' : 'auth: EXPIRED')
          : `auth ok until ${cached.expiresAt.slice(11, 16)}Z`);
      }
    } else if (!c.password) {
      const cached = getCachedCredential(name);
      tags.push(!cached ? 'auth: pending'
        : cached.expired ? 'auth: EXPIRED'
        : `auth ok until ${cached.expiresAt.slice(11, 16)}Z`);
    }
    console.log(`${name.padEnd(12)} ${c.server} / ${c.database}  [${tags.join(' ')}]  user=${c.user || '(azure ad)'}`);
    if (c.desc) console.log(`${' '.repeat(12)}   ↳ ${c.desc}`);
  }
}

async function cmdAuth(connName, flags) {
  if (!connName) fail('usage: auth <conn> [--password <pwd>] [--ttl <min>] [--clear] [--device]');
  const c = getConn(connName);
  if (flags.clear) {
    const r = db().prepare('DELETE FROM credentials WHERE connection=?').run(connName);
    console.log(r.changes ? `Credential for ${connName} removed.` : `No cached credential for ${connName}.`);
    return;
  }
  if (c.authMode) {
    if (c.authMode.startsWith('unsupported:')) await getPool(connName); // emits the proper error
    if (c.authMode === 'default') {
      console.log(`"${connName}" uses Active Directory Default: sign in once with "az login" (or Azure PowerShell). Nothing to cache in dbq.`);
      const pool = await getPool(connName); await pool.close();
      console.log('OK auth: connection verified with the current Azure credential.');
      return;
    }
    const mode = flags.device ? 'devicecode' : c.authMode;
    console.error(mode === 'devicecode'
      ? `Signing in to ${connName} with a device code...`
      : `Signing in to ${connName}: a browser window will open for Azure AD (MFA)...`);
    const { record, expires } = await aadLogin(connName, c, mode);
    const pool = await getPool(connName); await pool.close(); // validate against the database
    console.log(`OK auth: signed in as ${record.username} — token for ${connName} cached until ${expires}.`);
    console.log(aadPersistence()
      ? 'Renewal after expiry is silent (persisted refresh token); MFA again only when the tenant requires it.'
      : 'Renewal after expiry opens the browser again (install @azure/identity-cache-persistence for silent renewal).');
    console.log(`Sign out: dbq auth ${connName} --clear`);
    return;
  }
  if (c.password) {
    console.error(`Warning: "${connName}" has Password= in .env — the auth cache will not be used. Remove the password from .env to enable the session password.`);
  }
  let password = typeof flags.password === 'string' ? flags.password : null;
  if (!password) {
    if (!process.stdin.isTTY) fail('No interactive terminal: pass --password <pwd>.');
    password = await promptHidden(`Password for ${connName} (user ${c.user}): `);
  }
  if (!password) fail('Empty password.');

  // validate by actually connecting before caching
  const pool = await getPool(connName, password);
  await pool.close();

  const ttlMin = Math.max(1, parseInt(flags.ttl, 10) || 480);
  const expires = storeCredential(connName, password, ttlMin);
  console.log(`OK auth: credential for ${connName} validated and cached until ${expires} (ttl ${ttlMin} min).`);
  console.log(`Clear before expiry: dbq auth ${connName} --clear`);
}

function ensureSelectOnly(text) {
  const t = text.trim().replace(/^\(+/, '').toLowerCase();
  if (!(t.startsWith('select') || t.startsWith('with') || t.startsWith('exec sp_help') || t.startsWith('declare'))) {
    fail("'query' runs reads only (SELECT/WITH). For mutations use insert/update/delete.");
  }
  if (/\b(update|delete|insert|drop|truncate|alter|merge)\b/.test(t) && !t.startsWith('with')) {
    fail('The query looks like it contains a mutation. Use the structured commands (insert/update/delete) to keep the journal.');
  }
}

async function cmdQuery(connName, queryText, flags) {
  if (!queryText) fail('Provide the SQL: query <conn> "SELECT ..."');
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
  const { schema, table } = resolveTarget(connName, flags);
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
  const { schema, table } = resolveTarget(connName, flags);
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

/**
 * `dbq schemas <conn> [--table T]` — which schemas this database actually has.
 *
 * A schema in these databases is a tenant, so "which schema?" has no global answer
 * and the previous workflow was to try `--schema sch1`, `sch2`, … until a command
 * stopped failing. With `--table`, it answers the more useful question: which
 * tenants have this table, and how many rows does each hold.
 */
async function cmdSchemas(connName, flags) {
  const table = (flags.table && flags.table !== true) ? String(flags.table).replace(/^.*\./, '') : null;
  const pool = await getPool(connName);
  try {
    const req = pool.request();
    let q;
    if (table) {
      req.input('t', table);
      q = `SELECT s.name AS [schema], COUNT(c.column_id) AS columns
           FROM sys.schemas s
           JOIN sys.tables  t ON t.schema_id = s.schema_id AND t.name = @t
           LEFT JOIN sys.columns c ON c.object_id = t.object_id
           GROUP BY s.name ORDER BY s.name`;
    } else {
      q = `SELECT s.name AS [schema], COUNT(t.object_id) AS tables
           FROM sys.schemas s
           LEFT JOIN sys.tables t ON t.schema_id = s.schema_id
           WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin',
                'db_securityadmin','db_ddladmin','db_backupoperator','db_datareader',
                'db_datawriter','db_denydatareader','db_denydatawriter')
           GROUP BY s.name ORDER BY s.name`;
    }
    const r = await req.query(q);
    const rows = r.recordset || [];
    if (!rows.length) {
      console.log(table ? `No schema in this database has a table named "${table}".` : 'No user schemas found.');
      return;
    }
    const perConn = connDefaultSchema(connName);
    console.log(table
      ? `Schemas holding "${table}" on ${connName}:`
      : `User schemas on ${connName}:`);
    for (const row of rows) {
      const isDefault = row.schema === (perConn || DEFAULT_SCHEMA);
      const count = table ? `${row.columns} column(s)` : `${row.tables} table(s)`;
      console.log(`  ${String(row.schema).padEnd(12)} ${count}${isDefault ? '   <- current default' : ''}`);
    }
    console.log(`\nDefault in use: ${perConn ? `${perConn} (from ${connName}_SCHEMA in .env)` : `${DEFAULT_SCHEMA} (global fallback)`}.`);
    if (!perConn) console.log(`Pin one per connection by adding  ${connName}_SCHEMA=<schema>  to .env.`);
  } finally {
    await pool.close();
  }
}

async function cmdDescribe(connName, table, flags) {
  if (!table && !flags.table) fail('usage: describe <conn> <table> [--schema sch]');
  const { schema, table: tbl } = resolveTarget(connName, { ...flags, table: table || flags.table });
  const pool = await getPool(connName);
  try {
    const meta = await getTableMeta(pool, connName, schema, tbl, !!flags.refresh);
    if (!meta) fail(`Table ${schema}.${tbl} not found.\n`
      + `The schema here is a TENANT, so "${schema}" may simply be the wrong one — `
      + `list what this database actually has with:  dbq schemas ${connName} --table ${tbl}`);
    console.log(`${schema}.${tbl}  (${meta.length} columns)`);
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
  const { schema, table } = resolveTarget(connName, flags);
  const pk = flags.pk || 'Id';
  const where = flags.where || fail('--where required (prevents UPDATE without a filter)');
  const setObj = JSON.parse(flags.set || fail('--set \'{"col":value}\' required'));

  const pool = await getPool(connName);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    // 1) snapshot of the affected rows (prior state)
    const snap = await new sql.Request(tx).query(`SELECT * FROM ${qual(schema, table)} WHERE ${where}`);
    const before = snap.recordset;

    if (before.length === 0) {
      await tx.rollback();
      console.log('No row matches the filter. Nothing to do.');
      await pool.close();
      return;
    }
    if (before.some(r => r[pk] === undefined)) {
      await tx.rollback();
      fail(`The PK "${pk}" is not in the result. Pass the correct --pk (required for revert).`);
    }

    // 2) build SET
    const setReq = new sql.Request(tx);
    const setNames = bindParams(setReq, setObj, 'set');
    const setClause = Object.keys(setObj).map(k => `[${k}] = @${setNames[k]}`).join(', ');
    const updSql = `UPDATE ${qual(schema, table)} SET ${setClause} WHERE ${where}`;

    if (!flags.yes) {
      await tx.rollback();
      console.log('[DRY-RUN] (no --yes, not applied)');
      console.log('SQL>  ' + updSql);
      console.log(`Rows that would change: ${before.length}`);
      console.log('Changed columns: ' + Object.keys(setObj).join(', '));
      printRows(before, { ...flags, top: 20 });
      await pool.close();
      return;
    }

    const upd = await setReq.query(updSql);

    // 3) journal (undo = restore prior values by PK)
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
    console.log(`OK update: ${entry.affected} row(s) changed. journal #${entry.seq}. revert: node index.js revert ${entry.seq}`);
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    fail('update failed: ' + e.message);
  } finally {
    await pool.close();
  }
}

async function cmdDelete(connName, flags) {
  assertWritable(connName, flags);
  const { schema, table } = resolveTarget(connName, flags);
  const pk = flags.pk || 'Id';
  const where = flags.where || fail('--where required (prevents DELETE without a filter)');

  const pool = await getPool(connName);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const snap = await new sql.Request(tx).query(`SELECT * FROM ${qual(schema, table)} WHERE ${where}`);
    const before = snap.recordset;
    if (before.length === 0) {
      await tx.rollback();
      console.log('No row matches the filter. Nothing to do.');
      await pool.close();
      return;
    }

    const delSql = `DELETE FROM ${qual(schema, table)} WHERE ${where}`;
    if (!flags.yes) {
      await tx.rollback();
      console.log('[DRY-RUN] (no --yes, not applied)');
      console.log('SQL>  ' + delSql);
      console.log(`Rows that would be removed: ${before.length}`);
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
    console.log(`OK delete: ${entry.affected} row(s) removed. journal #${entry.seq}. revert: node index.js revert ${entry.seq}`);
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    fail('delete failed: ' + e.message);
  } finally {
    await pool.close();
  }
}

async function cmdInsert(connName, flags) {
  assertWritable(connName, flags);
  const { schema, table } = resolveTarget(connName, flags);
  const pk = flags.pk || 'Id';
  const values = JSON.parse(flags.values || fail('--values \'{"col":value}\' required'));

  const pool = await getPool(connName);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const req = new sql.Request(tx);
    const names = bindParams(req, values, 'v');
    const colList = Object.keys(values).map(k => `[${k}]`).join(', ');
    const valList = Object.keys(values).map(k => `@${names[k]}`).join(', ');
    // OUTPUT ... INTO @tbl (instead of a direct OUTPUT) to work on tables with triggers
    // (SQL Server forbids OUTPUT without INTO when a trigger is enabled).
    const insSql = `DECLARE @ids TABLE ([pk] sql_variant); INSERT INTO ${qual(schema, table)} (${colList}) OUTPUT INSERTED.[${pk}] INTO @ids ([pk]) VALUES (${valList}); SELECT [pk] AS pk FROM @ids;`;

    if (!flags.yes) {
      await tx.rollback();
      console.log('[DRY-RUN] (no --yes, not applied)');
      console.log('SQL>  ' + insSql);
      console.log('Values: ' + JSON.stringify(values));
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
    fail('insert failed: ' + e.message);
  } finally {
    await pool.close();
  }
}

// Splits a script into batches on lines containing only GO (sqlcmd-style separator).
function splitDdlBatches(text) {
  return text.split(/^\s*GO\s*;?\s*$/im).map(s => s.trim()).filter(Boolean);
}

async function cmdDdl(connName, stmtText, flags) {
  assertDdlAllowed(connName);

  let text = stmtText;
  if (flags.file) {
    try { text = fs.readFileSync(flags.file, 'utf8'); }
    catch (e) { fail('Could not read --file: ' + e.message); }
  }
  if (!text || !text.trim()) {
    fail('Provide the DDL: ddl <conn> "CREATE TABLE ..." or --file <file.sql>');
  }

  const batches = splitDdlBatches(text);
  if (batches.length === 0) fail('No statement found.');

  if (!flags.yes) {
    console.log('[DRY-RUN] (no --yes, not applied)');
    console.log(`Connection: ${connName} (${getConn(connName).database})  |  batches: ${batches.length}`);
    batches.forEach((b, i) => console.log(`--- batch ${i + 1} ---\n${b}`));
    console.log('⚠️  DDL is NOT revertible by the journal. Review before running with --yes.');
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
    console.log(`OK ddl: ${ran} batch(es) executed${useTx ? ' (in a transaction)' : ' (--no-tx)'}. journal #${entry.seq} (op=ddl, not auto-revertible).`);
  } catch (e) {
    if (useTx) { try { await tx.rollback(); } catch (_) {} }
    fail(`ddl failed on batch ${ran + 1}/${batches.length}: ${e.message}`);
  } finally {
    await pool.close();
  }
}

function cmdLog(flags) {
  const rows = db().prepare(
    `SELECT seq, ts, op, connection, schema, "table" AS tbl, affected, where_clause, reverted
     FROM journal ${flags.all ? '' : 'WHERE reverted=0'} ORDER BY seq`).all();
  if (rows.length === 0) { console.log('(journal empty)'); return; }
  for (const e of rows) {
    const rev = e.reverted ? ' [REVERTED]' : '';
    console.log(`#${String(e.seq).padStart(4)} ${e.ts}  ${String(e.op).toUpperCase().padEnd(6)} ${e.connection}:${e.schema}.${e.tbl}  affected=${e.affected}${rev}`);
    if (e.where_clause) console.log(`        where: ${e.where_clause}`);
  }
}

function cmdShow(id, flags) {
  const e = findEntry(id);
  if (flags.full) { console.log(JSON.stringify(e, null, 2)); return; }
  const undoSize = e.undo.rows ? `${e.undo.rows.length} row(s) snapshot`
    : e.undo.pks ? `${e.undo.pks.length} pk(s)` : '-';
  console.log(JSON.stringify({
    seq: e.seq, id: e.id, timestamp: e.timestamp, connection: e.connection, database: e.database,
    op: e.op, table: `${e.schema}.${e.table}`, pk: e.pk, affected: e.affected,
    where: e.where, set: e.set, values: e.values,
    undo: `${e.undo.kind} (${undoSize})`, reverted: e.reverted, revertedAt: e.revertedAt
  }, null, 2));
  console.log(`(use 'show ${e.seq} --full' to see the full snapshot)`);
}

function cmdCacheClear() {
  const r = db().prepare('DELETE FROM result_cache').run();
  console.log(`result_cache cleared (${r.changes} entries).`);
}

async function cmdRevert(id, flags) {
  const entry = findEntry(id);
  if (entry.reverted) fail(`Entry #${entry.seq} was already reverted.`);
  assertWritable(entry.connection, flags);

  const pool = await getPool(entry.connection);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const { schema, table, pk } = entry;

    if (entry.undo.kind === 'restore') {
      // UPDATE: restore each row to its prior values
      for (const row of entry.undo.rows) {
        const req = new sql.Request(tx);
        const cols = Object.keys(row).filter(c => c !== pk);
        const names = bindParams(req, Object.fromEntries(cols.map(c => [c, row[c]])), 'r');
        req.input('pkval', row[pk]);
        const setClause = cols.map(c => `[${c}] = @${names[c]}`).join(', ');
        await req.query(`UPDATE ${qual(schema, table)} SET ${setClause} WHERE [${pk}] = @pkval`);
      }
      console.log(`Revert update: ${entry.undo.rows.length} row(s) restored.`);
    } else if (entry.undo.kind === 'reinsert') {
      // DELETE: reinsert the removed rows (with IDENTITY_INSERT when needed).
      // Identity: use schema_cache if available, otherwise query live.
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
      console.log(`Revert delete: ${entry.undo.rows.length} row(s) reinserted.`);
    } else if (entry.undo.kind === 'delete-pks') {
      // INSERT: remove the inserted PKs
      const req = new sql.Request(tx);
      const list = entry.undo.pks.map((p, i) => { req.input('p' + i, p); return '@p' + i; }).join(', ');
      const r = await req.query(`DELETE FROM ${qual(schema, table)} WHERE [${pk}] IN (${list})`);
      console.log(`Revert insert: ${r.rowsAffected[0]} row(s) removed.`);
    } else if (entry.undo.kind === 'none') {
      await tx.rollback();
      fail(`Entry #${entry.seq} is DDL (op=ddl) and is not auto-revertible. Undo it manually with another 'ddl'.`);
    } else {
      await tx.rollback();
      fail('Unknown undo kind: ' + entry.undo.kind);
    }

    await tx.commit();
    markReverted(entry.seq);
    console.log(`OK revert #${entry.seq}.`);
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    fail('revert failed: ' + e.message);
  } finally {
    await pool.close();
  }
}

async function cmdRevertLast(flags) {
  const row = db().prepare('SELECT seq FROM journal WHERE reverted=0 ORDER BY seq DESC LIMIT 1').get();
  if (!row) fail('No pending mutation to revert.');
  await cmdRevert(row.seq, flags);
}

// --------------------------------------------------------------- main ----
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { positionals, flags } = parseArgs(argv.slice(1));

  warnUnknownFlags(flags);

  switch (cmd) {
    case 'conns': return cmdConns();
    case 'schemas': return cmdSchemas(positionals[0], flags);
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
      if (cmd) fail('Unknown command: ' + cmd);
  }
}

// Only run the CLI when invoked as a program. Without this guard, importing the
// module for a unit test executes main() and the test run becomes a CLI run.
if (require.main === module) {
  main().catch(e => fail(e.message));
}

// Pure helpers, exported for `npm test`. Nothing here touches the network, the
// database or the journal.
module.exports = {
  parseArgs, unknownFlags, editDistance,
  qual, splitTarget, resolveTarget, schemaFromEnvText,
  parseConnString, parseEnv, clampTop, ttlFromFlag,
  DEFAULT_SCHEMA, DEFAULT_TOP, MAX_TOP, KNOWN_FLAGS,
};
