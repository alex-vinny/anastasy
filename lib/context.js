'use strict';
/**
 * What dbq remembers about the databases it talks to, kept in the local dbq.sqlite:
 *
 *   catalog_*   tables, columns, PKs, FKs and descriptions of a connection (one bulk read of sys.*)
 *   query_log   every read that reached the server, as a fingerprint (literals replaced by ?),
 *               plus the last raw text, which `prune` drops with the journal
 *   query_table which tables / procedures each fingerprint touched
 *   join_edge   column equalities (a.x = b.y) mined from reads that succeeded
 *
 * Scope: the catalog belongs to one connection (environments drift between migrations). History
 * and joins belong to a PROJECT — `<CONN>_PROJECT` in .env, the connection name when unset — so
 * dev/hml/prd of one system share what was learned, and an unrelated database never mixes in.
 *
 * Everything here is either pure or takes the DatabaseSync handle as its first argument, so the
 * test suite runs it against an in-memory database. Nothing opens a SQL Server connection.
 *
 * Privacy rule: what goes back to the caller (history, joins, context) is built from fingerprints,
 * identifiers and counts. Raw SQL — which may carry a literal from a customer row — only comes back
 * with an explicit --raw, and journal values never come back from here at all.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CATALOG_TTL_DAYS = 7;
const SCHEMA_CACHE_TTL_DAYS = 7;
const DAY_MS = 86400000;

// ----------------------------------------------------------- tokenizer ----
// Words that end a name or can never be an alias. Not every T-SQL keyword: just the ones that
// can follow a table reference, so `FROM T WHERE` does not read WHERE as the alias of T.
const RESERVED = new Set((
  'select from where join inner left right full outer cross apply on and or not group by order '
  + 'having union all except intersect with as into values set update delete insert merge output '
  + 'option for top distinct pivot unpivot tablesample case when then else end is null like in '
  + 'exists between go exec execute declare begin commit rollback offset fetch next rows only asc '
  + 'desc over partition using matched table'
).split(' '));

const WORD_RE = /[#\p{L}_][\p{L}\p{N}_@#$]*/uy;
const VAR_RE = /@@?[\p{L}\p{N}_@#$]*/uy;
const NUM_RE = /0x[0-9a-f]*|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iy;
const OPS = new Set(['<>', '>=', '<=', '!=', '!<', '!>', '+=', '-=', '*=', '/=', '::']);

function sticky(re, s, i) {
  re.lastIndex = i;
  const m = re.exec(s);
  return m ? m[0] : null;
}

/**
 * Pure: tokens of a T-SQL batch — { k: word|ident|var|str|num|punct, v }. Comments are dropped,
 * string and number literals become `?`, bracketed/quoted identifiers keep their inner text.
 * Never throws: an unterminated literal or comment just runs to the end of the text.
 */
function scanSql(text) {
  const s = String(text ?? '');
  const n = s.length;
  const out = [];
  let i = 0;
  const quoted = (open, close) => {
    let j = i + 1;
    let v = '';
    while (j < n) {
      if (s[j] === close) {
        if (s[j + 1] === close) { v += close; j += 2; continue; }
        j++;
        return { v, end: j };
      }
      v += s[j++];
    }
    return { v, end: n };
  };
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && d === '-') { const j = s.indexOf('\n', i); i = j === -1 ? n : j; continue; }
    if (c === '/' && d === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (s[i] === '/' && s[i + 1] === '*') { depth++; i += 2; }
        else if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (c === "'" || ((c === 'N' || c === 'n') && d === "'")) {
      if (c !== "'") i++;
      i = quoted("'", "'").end;
      out.push({ k: 'str', v: '?' });
      continue;
    }
    if (c === '[') { const q = quoted('[', ']'); out.push({ k: 'ident', v: q.v }); i = q.end; continue; }
    if (c === '"') { const q = quoted('"', '"'); out.push({ k: 'ident', v: q.v }); i = q.end; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d || ''))) {
      const m = sticky(NUM_RE, s, i);
      out.push({ k: 'num', v: '?' });
      i += m.length;
      continue;
    }
    if (c === '@') { const m = sticky(VAR_RE, s, i); out.push({ k: 'var', v: m }); i += m.length; continue; }
    const w = sticky(WORD_RE, s, i);
    if (w) { out.push({ k: 'word', v: w }); i += w.length; continue; }
    const two = s.slice(i, i + 2);
    if (OPS.has(two)) { out.push({ k: 'punct', v: two }); i += 2; continue; }
    out.push({ k: 'punct', v: c });
    i++;
  }
  return out;
}

const isName = (t) => t && (t.k === 'ident' || (t.k === 'word' && !RESERVED.has(t.v.toLowerCase())));
const isWord = (t, w) => t && t.k === 'word' && t.v.toLowerCase() === w;
const isPunct = (t, p) => t && t.k === 'punct' && t.v === p;

function renderTokens(tokens) {
  let out = '';
  let prev = null;
  for (const t of tokens) {
    let v = t.v;
    if (t.k === 'ident') v = /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.v) && !RESERVED.has(t.v.toLowerCase()) ? t.v : `[${t.v.replace(/]/g, ']]')}]`;
    else if (t.k === 'word' && RESERVED.has(t.v.toLowerCase())) v = t.v.toUpperCase();
    const tight = t.k === 'punct' && [',', ')', '.', ';'].includes(t.v);
    const afterOpen = prev && prev.k === 'punct' && (prev.v === '(' || prev.v === '.');
    const call = t.k === 'punct' && t.v === '(' && prev && (prev.k === 'ident' || (prev.k === 'word' && !RESERVED.has(prev.v.toLowerCase())));
    if (out && !tight && !afterOpen && !call) out += ' ';
    out += v;
    prev = t;
  }
  // `IN (?, ?, ?)` and `VALUES (?, ?), (?, ?)` are the same query whatever the list length.
  return out.replace(/\(\?(?:, \?)+\)/g, '(?)').replace(/\(\?\)(?:, \(\?\))+/g, '(?)');
}

/**
 * Pure: the fingerprint of a batch — the text with every literal replaced by `?`, comments gone,
 * whitespace and keyword case normalized. `hash` identifies it per connection.
 */
function fingerprint(text, conn = '') {
  const tokens = scanSql(text);
  const fp = renderTokens(tokens);
  const hash = crypto.createHash('sha1').update(`${conn}\n${fp.toLowerCase()}`).digest('hex').slice(0, 12);
  return { fp, hash, tokens, hasLiterals: tokens.some(t => t.k === 'str' || t.k === 'num') };
}

// ------------------------------------------------------- tables / joins ----
/** Reads a dotted name at i: { parts, next } or null. `db..T` keeps an empty middle part. */
function readName(tokens, i) {
  if (!isName(tokens[i])) return null;
  const parts = [tokens[i].v];
  let j = i + 1;
  // After a dot any word is a name (`t.Rows`, `o.Order`): only the first part can be a keyword.
  const part = (t) => t && (t.k === 'ident' || t.k === 'word');
  while (isPunct(tokens[j], '.')) {
    if (isPunct(tokens[j + 1], '.')) { parts.push(''); j++; continue; }
    if (!part(tokens[j + 1])) break;
    parts.push(tokens[j + 1].v);
    j += 2;
  }
  return { parts, next: j };
}

/** Names a WITH clause defines: `WITH a AS (`, `, b AS (`, `WITH c (x, y) AS (`. */
function cteNames(tokens) {
  const names = new Set();
  tokens.forEach((t, i) => {
    if (!isName(t)) return;
    const before = tokens[i - 1];
    if (!(isWord(before, 'with') || isPunct(before, ','))) return;
    let j = i + 1;
    if (isPunct(tokens[j], '(')) {
      let depth = 0;
      for (; j < tokens.length; j++) {
        if (isPunct(tokens[j], '(')) depth++;
        else if (isPunct(tokens[j], ')') && --depth === 0) { j++; break; }
      }
    }
    if (isWord(tokens[j], 'as') && isPunct(tokens[j + 1], '(')) names.add(t.v.toLowerCase());
  });
  return names;
}

const AFTER_NAME = new Set(['from', 'join', 'into', 'update', 'exec', 'execute']);

/**
 * Pure: the tables and procedures a batch names — [{ schema, table, kind: table|proc, alias }].
 * One-part names keep schema null (the connection's default applies). CTEs, temp tables, table
 * variables and table-valued functions are left out: they are not objects of the database.
 */
// Clause keywords: a comma inside a FROM clause (JOIN ... ON included) starts another table,
// anywhere else it separates columns, values or assignments.
const FROM_CLAUSE = new Set(['from', 'join', 'on', 'apply']);
const OTHER_CLAUSE = new Set(['select', 'where', 'group', 'order', 'having', 'set', 'values', 'union',
  'except', 'intersect', 'option', 'for', 'into', 'update', 'output', 'when', 'then']);

function tablesOf(tokens) {
  const ctes = cteNames(tokens);
  const refs = [];
  const clause = ['']; // per parenthesis depth
  const readRef = (j, kind) => {
    const name = readName(tokens, j);
    if (!name) return;
    const parts = name.parts;
    const table = parts[parts.length - 1];
    const schema = parts.length >= 2 ? (parts[parts.length - 2] || null) : null;
    let k = name.next;
    const isFunction = kind === 'table' && isPunct(tokens[k], '(');
    let alias = null;
    if (!isFunction && kind === 'table') {
      if (isWord(tokens[k], 'as')) k++;
      if (isName(tokens[k])) alias = tokens[k].v;
    }
    const skip = isFunction || table.startsWith('#') || (schema === null && ctes.has(table.toLowerCase()));
    if (!skip) refs.push({ schema, table, kind, alias });
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isPunct(t, '(')) { clause.push(''); continue; }
    if (isPunct(t, ')')) { if (clause.length > 1) clause.pop(); continue; }
    if (isPunct(t, ';')) { clause[clause.length - 1] = ''; continue; }
    if (isPunct(t, ',') && clause[clause.length - 1] === 'from') { readRef(i + 1, 'table'); continue; }
    if (t.k !== 'word') continue;
    const kw = t.v.toLowerCase();
    if (FROM_CLAUSE.has(kw)) clause[clause.length - 1] = 'from';
    else if (OTHER_CLAUSE.has(kw)) clause[clause.length - 1] = kw;
    if (!AFTER_NAME.has(kw)) continue;
    const kind = kw === 'exec' || kw === 'execute' ? 'proc' : 'table';
    let j = i + 1;
    if (kind === 'proc' && tokens[j] && tokens[j].k === 'var' && isPunct(tokens[j + 1], '=')) j += 2; // EXEC @rc = proc
    readRef(j, kind);
  }
  // `UPDATE t SET ... FROM s.T t`: the UPDATE target is an alias, not a table.
  const aliases = new Set(refs.filter(r => r.alias).map(r => r.alias.toLowerCase()));
  return refs.filter(r => !(r.schema === null && !r.alias && aliases.has(r.table.toLowerCase())));
}

/**
 * Pure: column equalities between two different tables (`a.x = b.y`, in ON or WHERE), with the
 * aliases resolved through `refs`. Edges are ordered so the same join read either way is one key.
 */
function joinEdges(tokens, refs) {
  const byName = new Map();
  for (const r of refs) {
    if (r.kind !== 'table') continue;
    byName.set(r.table.toLowerCase(), r);
    if (r.alias) byName.set(r.alias.toLowerCase(), r);
  }
  const column = (i) => {
    const name = readName(tokens, i);
    if (!name || name.parts.length < 2) return null;
    const ref = byName.get(name.parts[name.parts.length - 2].toLowerCase());
    return ref ? { ref, col: name.parts[name.parts.length - 1], next: name.next } : null;
  };
  const edges = new Map();
  for (let i = 0; i < tokens.length; i++) {
    if (isPunct(tokens[i - 1], '.')) continue; // middle of a longer name
    const left = column(i);
    if (!left || !isPunct(tokens[left.next], '=')) continue;
    const right = column(left.next + 1);
    if (!right) continue;
    const a = { table: left.ref.table, col: left.col };
    const b = { table: right.ref.table, col: right.col };
    if (a.table.toLowerCase() === b.table.toLowerCase()) continue;
    const [x, y] = `${a.table}.${a.col}`.toLowerCase() < `${b.table}.${b.col}`.toLowerCase() ? [a, b] : [b, a];
    edges.set(`${x.table}.${x.col}=${y.table}.${y.col}`.toLowerCase(), { a: x, b: y });
  }
  return [...edges.values()];
}

// --------------------------------------------------------------- misc ----
/** Pure: `30d` / `30` -> 30. Anything else throws (a typo must not prune everything). */
function parseAgeDays(v, fallback = 30) {
  if (v === undefined || v === null || v === true) return fallback;
  const m = /^(\d+)d?$/i.exec(String(v).trim());
  if (!m || Number(m[1]) < 1) throw new Error(`--older-than takes days, e.g. 30d (got "${v}")`);
  return Number(m[1]);
}

// Server messages whose quoted text is an identifier, not a value: kept, they are the useful part.
const IDENTIFIER_QUOTE = /\b(?:column name|object name|object|stored procedure|column prefix|table|column|index|constraint|schema|database|function|procedure)\s+'(?:[^']|'')*'/gi;

/**
 * Pure: a server error with its literals masked. SQL Server quotes the offending value
 * ("Conversion failed when converting the varchar value '...'"), and that value is customer data.
 * Quotes after a word that names an object ("Invalid column name 'X'") are identifiers and stay.
 */
function sanitizeError(msg) {
  const kept = [];
  return String(msg || '')
    .replace(IDENTIFIER_QUOTE, (m) => { kept.push(m); return `\u0000${kept.length - 1}\u0000`; })
    .replace(/N?'(?:[^']|'')*'/g, "'?'")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)])
    .replace(/(value is|values are) \([^)]*\)/gi, '$1 (?)')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** The git branch of `dir` or a parent (worktrees too), or null. Reads files only; never runs git. */
function gitBranch(dir, fsImpl = fs) {
  let cur = path.resolve(dir || '.');
  for (;;) {
    const dotGit = path.join(cur, '.git');
    try {
      let gitDir = dotGit;
      if (fsImpl.statSync(dotGit).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fsImpl.readFileSync(dotGit, 'utf8'));
        if (!m) return null;
        gitDir = path.resolve(cur, m[1].trim());
      }
      const head = fsImpl.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return ref ? ref[1] : head.slice(0, 8);
    } catch { /* not here — go up */ }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function taskLabel(env = process.env, cwd = process.cwd(), fsImpl = fs) {
  return (env.DBQ_TASK && String(env.DBQ_TASK).trim()) || gitBranch(cwd, fsImpl);
}

const isoDaysAgo = (days, now = Date.now()) => new Date(now - days * DAY_MS).toISOString();
const olderThan = (iso, days, now = Date.now()) => !iso || (now - Date.parse(iso)) > days * DAY_MS;

// ------------------------------------------------------------- storage ----
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS catalog_meta (
    conn TEXT PRIMARY KEY, fetched_at TEXT, schemas INTEGER, tables INTEGER, columns INTEGER, fks INTEGER);
  CREATE TABLE IF NOT EXISTS catalog_table (
    conn TEXT, schema TEXT, tbl TEXT COLLATE NOCASE, rows_est INTEGER, descr TEXT,
    PRIMARY KEY (conn, schema, tbl));
  CREATE TABLE IF NOT EXISTS catalog_column (
    conn TEXT, schema TEXT, tbl TEXT COLLATE NOCASE, col TEXT COLLATE NOCASE, ord INTEGER, type TEXT,
    maxlen INTEGER, nullable INTEGER, ident INTEGER, pk INTEGER, descr TEXT,
    PRIMARY KEY (conn, schema, tbl, col));
  CREATE TABLE IF NOT EXISTS catalog_fk (
    conn TEXT, schema TEXT, tbl TEXT COLLATE NOCASE, col TEXT COLLATE NOCASE,
    ref_schema TEXT, ref_tbl TEXT COLLATE NOCASE, ref_col TEXT COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS ix_catalog_fk_tbl ON catalog_fk (conn, tbl);
  CREATE INDEX IF NOT EXISTS ix_catalog_fk_ref ON catalog_fk (conn, ref_tbl);
  CREATE TABLE IF NOT EXISTS query_log (
    hash TEXT PRIMARY KEY, conn TEXT, project TEXT, op TEXT, sql_fp TEXT, sql_raw TEXT, raw_at TEXT,
    runs INTEGER, ok_runs INTEGER, last_ok INTEGER, last_error TEXT, ms_total INTEGER,
    rows_last INTEGER, task TEXT, first_at TEXT, last_at TEXT);
  CREATE TABLE IF NOT EXISTS query_table (
    hash TEXT, schema TEXT, tbl TEXT COLLATE NOCASE, kind TEXT, PRIMARY KEY (hash, tbl, kind));
  CREATE INDEX IF NOT EXISTS ix_query_table_tbl ON query_table (tbl);
  CREATE INDEX IF NOT EXISTS ix_query_log_project ON query_log (project, last_at);
  CREATE TABLE IF NOT EXISTS join_edge (
    project TEXT, a_tbl TEXT COLLATE NOCASE, a_col TEXT COLLATE NOCASE, b_tbl TEXT COLLATE NOCASE,
    b_col TEXT COLLATE NOCASE, seen INTEGER, last_at TEXT, PRIMARY KEY (project, a_tbl, a_col, b_tbl, b_col));
`;

function initContextSchema(d) { d.exec(SCHEMA_SQL); }

function inTransaction(d, fn) {
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; }
  catch (e) { d.exec('ROLLBACK'); throw e; }
}

/** Records one read that reached the server. Joins are mined only from reads that succeeded. */
function recordRead(d, { conn, project, op, text, ok, ms, rows, error, task, now = new Date().toISOString() }) {
  const f = fingerprint(text, conn);
  const proj = project || conn;
  inTransaction(d, () => {
    const prev = d.prepare('SELECT hash FROM query_log WHERE hash=?').get(f.hash);
    const err = ok ? null : sanitizeError(error);
    if (prev) {
      d.prepare(`UPDATE query_log SET runs=runs+1, ok_runs=ok_runs+?, last_ok=?, last_error=COALESCE(?, last_error),
                 ms_total=ms_total+?, rows_last=COALESCE(?, rows_last), task=COALESCE(?, task), last_at=?,
                 sql_raw=?, raw_at=? WHERE hash=?`)
        .run(ok ? 1 : 0, ok ? 1 : 0, err, Math.round(ms || 0), ok ? (rows ?? null) : null, task || null, now, String(text), now, f.hash);
    } else {
      d.prepare(`INSERT INTO query_log (hash,conn,project,op,sql_fp,sql_raw,raw_at,runs,ok_runs,last_ok,last_error,ms_total,rows_last,task,first_at,last_at)
                 VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`)
        .run(f.hash, conn, proj, op, f.fp, String(text), now, ok ? 1 : 0, ok ? 1 : 0, err, Math.round(ms || 0),
          ok ? (rows ?? null) : null, task || null, now, now);
    }
    const refs = tablesOf(f.tokens);
    const ins = d.prepare('INSERT OR IGNORE INTO query_table (hash,schema,tbl,kind) VALUES (?,?,?,?)');
    for (const r of refs) ins.run(f.hash, r.schema, r.table, r.kind);
    if (ok) {
      const up = d.prepare(`INSERT INTO join_edge (project,a_tbl,a_col,b_tbl,b_col,seen,last_at) VALUES (?,?,?,?,?,1,?)
                            ON CONFLICT (project,a_tbl,a_col,b_tbl,b_col) DO UPDATE SET seen=seen+1, last_at=excluded.last_at`);
      for (const e of joinEdges(f.tokens, refs)) up.run(proj, e.a.table, e.a.col, e.b.table, e.b.col, now);
    }
  });
  return f.hash;
}

/** Replaces a connection's catalog with what one bulk read of sys.* returned. */
function storeCatalog(d, conn, { tables, columns, fks }, now = new Date().toISOString()) {
  inTransaction(d, () => {
    for (const t of ['catalog_table', 'catalog_column', 'catalog_fk']) d.prepare(`DELETE FROM ${t} WHERE conn=?`).run(conn);
    const it = d.prepare('INSERT OR REPLACE INTO catalog_table (conn,schema,tbl,rows_est,descr) VALUES (?,?,?,?,?)');
    for (const t of tables) it.run(conn, t.sch, t.tbl, t.rows_est ?? null, t.descr ?? null);
    const ic = d.prepare(`INSERT OR REPLACE INTO catalog_column (conn,schema,tbl,col,ord,type,maxlen,nullable,ident,pk,descr)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const c of columns) ic.run(conn, c.sch, c.tbl, c.col, c.ord, c.type, c.maxlen ?? null, c.nullable ? 1 : 0, c.ident ? 1 : 0, c.pk ? 1 : 0, c.descr ?? null);
    const ifk = d.prepare('INSERT INTO catalog_fk (conn,schema,tbl,col,ref_schema,ref_tbl,ref_col) VALUES (?,?,?,?,?,?,?)');
    for (const f of fks) ifk.run(conn, f.sch, f.tbl, f.col, f.ref_sch, f.ref_tbl, f.ref_col);
    const schemas = new Set(tables.map(t => t.sch)).size;
    d.prepare('INSERT OR REPLACE INTO catalog_meta (conn,fetched_at,schemas,tables,columns,fks) VALUES (?,?,?,?,?,?)')
      .run(conn, now, schemas, tables.length, columns.length, fks.length);
  });
}

function catalogMeta(d, conn) {
  return d.prepare('SELECT * FROM catalog_meta WHERE conn=?').get(conn) || null;
}

function catalogStale(d, conn, now = Date.now()) {
  const m = catalogMeta(d, conn);
  return !m || olderThan(m.fetched_at, CATALOG_TTL_DAYS, now);
}

/**
 * Tables and columns whose name contains `term`, each grouped across the schemas that hold it —
 * a tenant database repeats every table per schema, and 23 identical lines say less than one.
 */
function searchCatalog(d, conn, term, { schema = null, top = 30, preferSchema = null } = {}) {
  const like = `%${String(term).replace(/[\\%_]/g, '\\$&')}%`;
  const sch = schema ? ' AND schema=?' : '';
  const args = schema ? [conn, like, schema] : [conn, like];
  const tableRows = d.prepare(`SELECT tbl, schema, rows_est, descr FROM catalog_table
                               WHERE conn=? AND tbl LIKE ? ESCAPE '\\'${sch} ORDER BY tbl, schema`).all(...args);
  const colRows = d.prepare(`SELECT tbl, col, type, maxlen, schema FROM catalog_column
                             WHERE conn=? AND col LIKE ? ESCAPE '\\'${sch} ORDER BY tbl, col, schema`).all(...args);
  const tables = groupAcrossSchemas(tableRows, r => r.tbl.toLowerCase(), preferSchema)
    .map(g => ({ table: g.first.tbl, schemas: g.schemas, rowsEst: g.preferred.rows_est, descr: g.preferred.descr }));
  const columns = groupAcrossSchemas(colRows, r => `${r.tbl}.${r.col}`.toLowerCase(), preferSchema)
    .map(g => ({ table: g.first.tbl, column: g.first.col, type: typeLabel(g.first.type, g.first.maxlen), schemas: g.schemas }));
  return {
    tables: tables.slice(0, top), tablesTotal: tables.length,
    columns: columns.slice(0, top), columnsTotal: columns.length,
  };
}

/** Pure: rows grouped by `keyOf`, keeping every schema and the row of the preferred one. */
function groupAcrossSchemas(rows, keyOf, preferSchema = null) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, { first: r, preferred: r, schemas: [] });
    const g = groups.get(k);
    g.schemas.push(r.schema);
    if (preferSchema && r.schema === preferSchema) g.preferred = r;
  }
  return [...groups.values()];
}

/** Pure: `nvarchar(50)`, `varchar(max)`, `int`. */
function typeLabel(type, maxlen) {
  if (maxlen === -1) return `${type}(max)`;
  if (maxlen && maxlen > 0 && /char|binary/i.test(type)) return `${type}(${maxlen})`;
  return type;
}

/** Fingerprints, newest first, filtered by connection, table, text and outcome. */
function historyRows(d, { conn = null, project = null, table = null, grep = null, failed = false, top = 20 } = {}) {
  const where = [];
  const args = [];
  if (conn) { where.push('q.conn=?'); args.push(conn); }
  if (project) { where.push('q.project=?'); args.push(project); }
  if (table) { where.push('EXISTS (SELECT 1 FROM query_table t WHERE t.hash=q.hash AND t.tbl=?)'); args.push(String(table).replace(/^.*\./, '')); }
  if (grep) { where.push("q.sql_fp LIKE ? ESCAPE '\\'"); args.push(`%${String(grep).replace(/[\\%_]/g, '\\$&')}%`); }
  if (failed) where.push('q.last_ok=0');
  const sqlText = `SELECT * FROM query_log q ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY q.last_at DESC LIMIT ?`;
  return d.prepare(sqlText).all(...args, top);
}

/** Joins of `table`: equalities seen in the project's successful reads, merged with the declared FKs of `conn`. */
function joinRows(d, conn, table, { top = 20, project = null } = {}) {
  const tbl = String(table).replace(/^.*\./, '');
  const edges = new Map();
  const put = (a, b, source, seen = 0) => {
    const [x, y] = `${a.t}.${a.c}`.toLowerCase() < `${b.t}.${b.c}`.toLowerCase() ? [a, b] : [b, a];
    const key = `${x.t}.${x.c}=${y.t}.${y.c}`.toLowerCase();
    const e = edges.get(key) || { a: x, b: y, sources: new Set(), seen: 0 };
    e.sources.add(source);
    e.seen += seen;
    edges.set(key, e);
  };
  for (const r of d.prepare('SELECT * FROM join_edge WHERE project=? AND (a_tbl=? OR b_tbl=?)').all(project || conn, tbl, tbl)) {
    put({ t: r.a_tbl, c: r.a_col }, { t: r.b_tbl, c: r.b_col }, 'log', r.seen);
  }
  if (conn) {
    const fks = d.prepare(`SELECT DISTINCT tbl, col, ref_tbl, ref_col FROM catalog_fk
                           WHERE conn=? AND (tbl=? OR ref_tbl=?)`).all(conn, tbl, tbl);
    for (const f of fks) put({ t: f.tbl, c: f.col }, { t: f.ref_tbl, c: f.ref_col }, 'fk');
  }
  return [...edges.values()]
    .map(e => {
      const mineFirst = e.a.t.toLowerCase() === tbl.toLowerCase() ? [e.a, e.b] : [e.b, e.a];
      return { from: mineFirst[0], to: mineFirst[1], source: [...e.sources].sort().join('+'), seen: e.seen };
    })
    .sort((x, y) => y.seen - x.seen || (y.source.includes('fk') - x.source.includes('fk')) || `${x.to.t}`.localeCompare(`${y.to.t}`))
    .slice(0, top);
}

/**
 * Everything dbq knows about one table, in one call: shape (from the catalog), joins, the last
 * successful reads that touched it (fingerprints) and how many mutations the journal holds
 * (counts only, never values). Null when the catalog has no such table.
 */
function contextData(d, conn, table, { schema = null, defaultSchema = null, project = null, conns = null, now = Date.now(), recent = 5, joins = 5 } = {}) {
  const proj = project || conn;
  const projectConns = conns && conns.length ? conns : [conn];
  const tbl = String(table).replace(/^.*\./, '');
  const holders = d.prepare('SELECT schema, rows_est, descr, tbl FROM catalog_table WHERE conn=? AND tbl=? ORDER BY schema').all(conn, tbl);
  if (!holders.length) return null;
  const pick = holders.find(h => h.schema === schema) || holders.find(h => h.schema === defaultSchema) || holders[0];
  if (schema && pick.schema !== schema) return null;
  const fkOf = new Map(d.prepare('SELECT col, ref_schema, ref_tbl, ref_col FROM catalog_fk WHERE conn=? AND schema=? AND tbl=?')
    .all(conn, pick.schema, tbl).map(f => [f.col.toLowerCase(), `${f.ref_tbl}.${f.ref_col}`]));
  const columns = d.prepare('SELECT col, type, maxlen, nullable, ident, pk, descr FROM catalog_column WHERE conn=? AND schema=? AND tbl=? ORDER BY ord')
    .all(conn, pick.schema, tbl)
    .map(c => ({
      name: c.col, type: typeLabel(c.type, c.maxlen), pk: !!c.pk, identity: !!c.ident, nullable: !!c.nullable,
      fk: fkOf.get(c.col.toLowerCase()) || null, descr: c.descr || null,
    }));
  const queries = d.prepare(`SELECT q.hash, q.conn, q.op, q.sql_fp, q.runs, q.last_at FROM query_log q
                             WHERE q.last_ok=1 AND q.project=? AND EXISTS (SELECT 1 FROM query_table t WHERE t.hash=q.hash AND t.tbl=?)
                             ORDER BY q.last_at DESC LIMIT ?`).all(proj, tbl, recent);
  const since = isoDaysAgo(30, now);
  let mutations = {};
  try {
    const inConns = projectConns.map(() => '?').join(',');
    for (const m of d.prepare(`SELECT op, COUNT(*) AS n FROM journal WHERE "table"=? COLLATE NOCASE AND ts>=? AND connection IN (${inConns}) GROUP BY op`)
      .all(tbl, since, ...projectConns)) mutations[m.op] = m.n;
  } catch { mutations = {}; } // no journal table (fresh database)
  return {
    conn, project: proj, table: pick.tbl, schema: pick.schema, schemas: holders.map(h => h.schema),
    rowsEst: pick.rows_est, descr: pick.descr || null, columns,
    joins: joinRows(d, conn, tbl, { top: joins, project: proj }), queries, mutations30d: mutations,
  };
}

/** Pure: the context block as text — short enough to paste into an agent's working memory. */
function formatContext(c) {
  const n = (v) => (v === null || v === undefined ? '?' : Number(v).toLocaleString('en-US'));
  const lines = [];
  const others = c.schemas.length > 1 ? ` (also in ${c.schemas.length - 1} other schema(s))` : '';
  const proj = c.project && c.project !== c.conn ? ` (project ${c.project})` : '';
  lines.push(`${c.schema}.${c.table} on ${c.conn}${proj}: ${c.columns.length} columns, ~${n(c.rowsEst)} rows${others}`);
  if (c.descr) lines.push(`  ${c.descr}`);
  lines.push('columns:');
  const w = Math.min(32, Math.max(...c.columns.map(x => x.name.length), 4));
  for (const col of c.columns) {
    const tags = [col.pk ? 'PK' : '', col.identity ? 'IDENTITY' : '', col.nullable ? '' : 'NOT NULL', col.fk ? `FK -> ${col.fk}` : ''].filter(Boolean).join(' ');
    lines.push(`  ${col.name.padEnd(w)} ${col.type.padEnd(16)} ${tags}${col.descr ? `  -- ${col.descr}` : ''}`.trimEnd());
  }
  lines.push(c.joins.length ? 'joins (fk = declared, log = seen in your reads):' : 'joins: none declared or seen yet');
  for (const j of c.joins) {
    lines.push(`  ${j.from.t}.${j.from.c} = ${j.to.t}.${j.to.c}   ${j.source}${j.seen ? ` x${j.seen}` : ''}`);
  }
  lines.push(c.queries.length ? 'recent successful reads (literals shown as ?):' : 'recent successful reads: none recorded yet');
  for (const q of c.queries) lines.push(`  [${q.hash}] ${q.conn} x${q.runs}  ${q.sql_fp}`);
  const muts = Object.entries(c.mutations30d).map(([op, k]) => `${op} ${k}`).join(', ');
  lines.push(`journal, last 30 days, this project: ${muts || 'no mutations'}`);
  return lines.join('\n');
}

/**
 * What `prune` would remove: journal entries and raw query texts older than `days`, plus
 * expired result-cache rows. Fingerprints stay — they carry no literal.
 */
function prunePlan(d, days, now = Date.now()) {
  const cutoff = isoDaysAgo(days, now);
  const one = (q, ...a) => { try { return d.prepare(q).get(...a).n; } catch { return 0; } };
  return {
    cutoff,
    journal: one('SELECT COUNT(*) AS n FROM journal WHERE ts < ?', cutoff),
    journalLive: one('SELECT COUNT(*) AS n FROM journal WHERE ts < ? AND reverted=0', cutoff),
    rawQueries: one('SELECT COUNT(*) AS n FROM query_log WHERE sql_raw IS NOT NULL AND raw_at < ?', cutoff),
    resultCache: one("SELECT COUNT(*) AS n FROM result_cache WHERE (julianday('now') - julianday(fetched_at)) * 86400 > ttl_sec"),
  };
}

function applyPrune(d, plan) {
  inTransaction(d, () => {
    d.prepare('DELETE FROM journal WHERE ts < ?').run(plan.cutoff);
    d.prepare('UPDATE query_log SET sql_raw=NULL, raw_at=NULL WHERE raw_at < ?').run(plan.cutoff);
    d.prepare("DELETE FROM result_cache WHERE (julianday('now') - julianday(fetched_at)) * 86400 > ttl_sec").run();
  });
  d.exec('VACUUM');
}

// The bulk read behind `catalog refresh`: three statements, every user schema at once.
const CATALOG_SQL = {
  tables: `SELECT s.name AS sch, t.name AS tbl, CAST(ep.value AS nvarchar(4000)) AS descr,
                  (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) AS rows_est
           FROM sys.tables t
           JOIN sys.schemas s ON s.schema_id = t.schema_id
           LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
           WHERE t.is_ms_shipped = 0`,
  columns: `SELECT s.name AS sch, t.name AS tbl, c.name AS col, c.column_id AS ord, ty.name AS type,
                   CASE WHEN c.max_length = -1 THEN -1
                        WHEN ty.name IN ('nchar', 'nvarchar') THEN c.max_length / 2
                        WHEN ty.name IN ('char', 'varchar', 'binary', 'varbinary') THEN c.max_length
                        ELSE NULL END AS maxlen,
                   c.is_nullable AS nullable, c.is_identity AS ident,
                   CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i
                                     JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                                     WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id)
                        THEN 1 ELSE 0 END AS pk,
                   CAST(ep.value AS nvarchar(4000)) AS descr
            FROM sys.columns c
            JOIN sys.tables t ON t.object_id = c.object_id
            JOIN sys.schemas s ON s.schema_id = t.schema_id
            JOIN sys.types ty ON ty.user_type_id = c.user_type_id
            LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
            WHERE t.is_ms_shipped = 0`,
  fks: `SELECT ps.name AS sch, pt.name AS tbl, pc.name AS col, rs.name AS ref_sch, rt.name AS ref_tbl, rc.name AS ref_col
        FROM sys.foreign_key_columns f
        JOIN sys.tables pt ON pt.object_id = f.parent_object_id
        JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
        JOIN sys.columns pc ON pc.object_id = f.parent_object_id AND pc.column_id = f.parent_column_id
        JOIN sys.tables rt ON rt.object_id = f.referenced_object_id
        JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
        JOIN sys.columns rc ON rc.object_id = f.referenced_object_id AND rc.column_id = f.referenced_column_id`,
};

module.exports = {
  CATALOG_TTL_DAYS, SCHEMA_CACHE_TTL_DAYS, CATALOG_SQL,
  scanSql, renderTokens, fingerprint, tablesOf, joinEdges, cteNames,
  parseAgeDays, sanitizeError, gitBranch, taskLabel, olderThan, isoDaysAgo, typeLabel, groupAcrossSchemas,
  initContextSchema, recordRead, storeCatalog, catalogMeta, catalogStale, searchCatalog,
  historyRows, joinRows, contextData, formatContext, prunePlan, applyPrune,
};
