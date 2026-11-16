#!/usr/bin/env node
/*
 * anastasy (dbq) — reversible CLI for SQL Server
 * ----------------------------------------------
 * Runs SELECT/INSERT/UPDATE/DELETE in a structured way and keeps a
 * "git-like" undo journal: every mutation records the prior state (or the
 * inserted PKs) so it can be reverted.
 *
 * Storage: local SQLite (node:sqlite, built into Node 22+) in dbq.sqlite, one per user, never
 *   committed — journal (with a gzipped snapshot), schema_cache, result_cache, and the context
 *   tables: catalog (tables/columns/PK/FK per connection), query history (fingerprints) and joins.
 *
 * Usage:
 *   node index.js <command> [options]
 *
 * Commands:
 *   conns                                  List the configured connections
 *   schemas  <conn> [--table T]            The user schemas of the database; with --table, which hold it
 *   query    <conn> "<SELECT ...>" | --file <a.sql>   Read-only SQL (SELECT/WITH) [--cache [ttl]] [--stats]
 *                                          --stats: logical/physical reads per table + server time (stderr)
 *                                          Allowed: SELECT / WITH ... SELECT, optionally after scalar
 *                                          DECLARE @v type = x / SET @v = x; or ONE system sp_help* (closed
 *                                          list) | sp_columns | sp_helptext | sp_describe_first_result_set |
 *                                          sp_spaceused as the whole batch. Procedures go to `exec`.
 *   select   <conn> --table T [--schema sch] [--where "..."] [--top N] [--columns "a,b"]
 *   count    <conn> <table> | --table T [--where "..."]   Just the count (cheap in tokens)
 *   describe <conn> <table> [--schema sch] [--refresh]   Columns/types (uses schema_cache)
 *   auth     <conn> [--password <pwd>] [--ttl <min>] [--clear] [--device]
 *                                          Cache a session password (connections without Password= in .env)
 *                                          or sign in with Azure AD (Authentication=Active Directory ... in .env)
 *   insert   <conn> --table T [--schema sch] --values '{json}' [--pk Id]
 *   update   <conn> --table T [--schema sch] --set '{json}' --where "..." [--pk Id]
 *   delete   <conn> --table T [--schema sch] --where "..." [--pk Id]
 *   ddl      <conn> "<CREATE/ALTER/DROP ...>" | --file <a.sql>   DDL (dev/hml only) [--yes] [--no-tx]
 *   exec     <conn> "EXEC schema.Proc ..." | --file <a.sql>   One procedure call in a transaction that is
 *                                          ALWAYS rolled back; prints every result set [--stats].
 *                                          Refused on PROD write connections (reader user is fine).
 *                                          [--format table|json] json = {"resultSets":[[...],...]} (one document)
 *                                          [--out file] the whole json document, no --top cap; stdout gets counts
 *   log [--all] [--top N]                  The mutation history, newest N (default 50); --all includes reverted
 *   show     <id> [--full]                 Detail one entry (compact; --full = snapshot)
 *   revert   <id>                          Undo one mutation
 *   revert-last                            Undo the most recent non-reverted mutation
 *   cache-clear                            Clear the result_cache
 *   prune    [--older-than 30d] [--yes]    Drop journal entries and raw query texts older than N days,
 *                                          expired cache rows, then VACUUM. Preview without --yes.
 *
 * Context (what dbq.sqlite remembers; every read that reaches the server is recorded):
 *   catalog  <conn> [--refresh]            Tables/columns/PK/FK/descriptions of every schema, one bulk
 *                                          read of sys.*; refreshed by itself when older than 7 days
 *   find     <conn> <term> [--schema s]    Tables and columns whose name contains <term>, grouped across
 *                                          the schemas (tenants) that hold them
 *   context  <conn> <table> [--schema s]   One block: columns with PK/FK, joins, recent successful reads,
 *                                          journal counts of the last 30 days [--format json]
 *   The catalog is per connection; history and joins are per PROJECT: <CONN>_PROJECT=<name> in .env
 *   groups the connections of one system (dev/hml/prd); unset, a connection is its own project.
 *   joins    <conn> <table>                Join columns of a table: declared FKs + equalities seen in reads
 *   history  [<conn>] [--table T] [--grep text] [--failed] [--top N] [--raw]
 *                                          Reads as fingerprints (literals shown as ?); --raw shows the last
 *                                          raw text while prune keeps it. Task label: DBQ_TASK or git branch.
 *   On a failed read, "Invalid column name", "Invalid object name" and "Ambiguous column name" come back
 *   with hints from the catalog under the error: the closest name, the table of the query (or one FK
 *   away) that has the column, the schemas that hold the table, the qualified form.
 *
 * Output (token economy):
 *   --format table|tsv|jsonl|json|count    (default: table)
 *   --full                                 Do not hide null columns
 *   --top N                                Row limit (default 50, max 500)
 *   --timeout <s>                          Per-request timeout in seconds (default 120)
 *
 * Safety:
 *   - Mutations require --yes (without it, a dry-run showing the snapshot/effect).
 *   - Read-only connections (reader user) refuse mutations.
 *   - Prod connections refuse mutations without --force-prod (avoid it!).
 *   - ddl runs only on non-prod WRITE connections (dev/hml); it is BLOCKED in prod
 *     (no override) and is not auto-revertible by the journal (op=ddl, undo=none).
 *   - query strips comments, string literals and [bracketed]/"quoted" identifiers, then refuses
 *     anywhere in the batch: EXEC/EXECUTE (except the sp_help family above), INSERT, UPDATE,
 *     DELETE, MERGE, DROP, TRUNCATE, ALTER, CREATE, GRANT/REVOKE/DENY, BACKUP/RESTORE, DBCC,
 *     KILL, SHUTDOWN, BULK, OPENROWSET/OPENQUERY/OPENDATASOURCE, sp_executesql, xp_*,
 *     SELECT ... INTO, BEGIN/COMMIT/ROLLBACK, WAITFOR, control flow, cursors and table variables.
 *     An unterminated literal or comment is refused (fails closed).
 *   - DBQ_ENV_FILE=<path> reads connections from another .env (tests; announced on stderr).
 *     DBQ_DB_FILE=<path> uses another dbq.sqlite (tests).
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

const ctx = require('./lib/context.js');

const ROOT = __dirname;
const DB_PATH = process.env.DBQ_DB_FILE ? path.resolve(process.env.DBQ_DB_FILE) : path.join(ROOT, 'dbq.sqlite');
const CONFIG_PATH = path.join(ROOT, 'connections.json');
// DBQ_ENV_FILE points at another .env — the test suite uses it to run the CLI against fake
// connections without touching the real file. It is not a new trust boundary (whoever sets the
// variable could edit .env), but it is announced on stderr so a run against an unexpected file shows.
const ENV_PATH = process.env.DBQ_ENV_FILE ? path.resolve(process.env.DBQ_ENV_FILE) : path.join(ROOT, '.env');
if (process.env.DBQ_ENV_FILE && require.main === module) {
  console.error(`-- connections from DBQ_ENV_FILE=${ENV_PATH}`);
}
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

// Every flag any command reads. parseArgs takes anything after `--`, so a typo is
// swallowed and the command runs as if the flag had never been passed.
//
// Here that is worse than elsewhere, and it FAILS rather than warning: `--yess`
// means the mutation falls back to a dry-run and the caller believes it wrote;
// `--wher` means a DELETE loses its filter. The caller is usually an agent, which
// reads the exit code — a warning plus exit 0 reads as success and the wrong belief
// propagates. `--no-strict-flags` is the escape hatch.
const KNOWN_FLAGS = new Set([
  'all', 'cache', 'clear', 'columns', 'device', 'failed', 'file', 'force-prod', 'format', 'full',
  'grep', 'no-strict-flags', 'no-tx', 'older-than', 'out', 'password', 'pk', 'raw', 'refresh',
  'schema', 'set', 'table', 'stats', 'timeout', 'top', 'ttl', 'values', 'values-file', 'where', 'yes',
]);

/**
 * Pure: the unknown flags, each with a spelling suggestion when one is close.
 *
 * Picks the CLOSEST candidate, not the first within the threshold — taking the first
 * makes the suggestion depend on set order, and a wrong suggestion is worse than
 * none when the caller is an agent that will act on it.
 */
function closestFlag(name, known = KNOWN_FLAGS) {
  let best = null;
  let bestDistance = 3; // more than 2 edits is not a suggestion
  for (const candidate of known) {
    const d = editDistance(name, candidate);
    if (d < bestDistance) { best = candidate; bestDistance = d; }
  }
  return best;
}

// Flags people reach for from other CLIs, with no near miss in KNOWN_FLAGS. Edit distance
// cannot find these (`--json` is far from `--format`), so the refusal said "(no close match)"
// and the caller had to guess. The refusal still fails; it just names the real spelling.
const FLAG_HINTS = {
  json: 'use --format json',
  jsonl: 'use --format jsonl',
  tsv: 'use --format tsv',
  csv: 'use --format tsv',
  limit: `use --top N (default ${DEFAULT_TOP}, max ${MAX_TOP})`,
  rows: `use --top N (default ${DEFAULT_TOP}, max ${MAX_TOP})`,
  'max-rows': `use --top N (default ${DEFAULT_TOP}, max ${MAX_TOP})`,
  conn: 'the connection is the first positional: dbq <command> <conn> ... (see dbq conns)',
  connection: 'the connection is the first positional: dbq <command> <conn> ... (see dbq conns)',
  db: 'the connection is the first positional: dbq <command> <conn> ... (see dbq conns)',
};

function unknownFlags(flags, known = KNOWN_FLAGS) {
  return Object.keys(flags || {})
    .filter((k) => !known.has(k))
    .map((k) => ({ flag: k, suggestion: closestFlag(k, known), hint: FLAG_HINTS[k] || null }));
}

function checkUnknownFlags(flags) {
  const unknown = unknownFlags(flags);
  if (!unknown.length) return;
  const lines = unknown.map(({ flag, suggestion, hint }) => {
    if (hint) return `  --${flag}   ${hint}`;
    return `  --${flag}${suggestion ? `   did you mean --${suggestion}?` : '   (no close match)'}`;
  });
  if (flags['no-strict-flags']) {
    console.error(`warning: ignoring unknown flag(s):\n${lines.join('\n')}`);
    return;
  }
  fail(`Unknown flag(s) — nothing was run:\n${lines.join('\n')}\n`
    + 'An unknown flag is silently dropped, so the command would have run WITHOUT it '
    + '(a missing --yes turns a mutation into a dry-run; a missing --where drops a filter). '
    + 'Fix the spelling, or pass --no-strict-flags to proceed anyway. Usage: dbq --help');
}

// Pure: did the caller ask for usage? `--help` used to hit the strict-flag check and exit 1
// as an unknown flag, so the one way to discover a flag (e.g. --top) was itself refused.
// Checked BEFORE parsing: help never runs the command, whatever else is on the line.
function wantsHelp(argv) {
  const [cmd, ...rest] = argv || [];
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return true;
  return rest.includes('--help') || rest.includes('-h');
}

function usageText() {
  return fs.readFileSync(__filename, 'utf8').split('*/')[0].replace('#!/usr/bin/env node', '').trim();
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
  ctx.initContextSchema(_db);
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

// Reads a .env (KEY=connstring). Optional suffixes <NAME>_READONLY / _PROD / _DESC / _SCHEMA / _PROJECT.
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
    if (/_(READONLY|PROD|DESC|SCHEMA|PROJECT)$/i.test(key)) continue;
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
    // Connections of one system (dev/hml/prd) share history and joins; unset = its own project.
    p.project = (raw[key + '_PROJECT'] || '').trim() || undefined;
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

// Per-request timeout. --timeout <seconds> raises it for one call (a full scan measured with --stats can
// take minutes on a 10-million-row table); the default stays 120 s.
let REQUEST_TIMEOUT_MS = 120000;

// Throws on a bad value instead of falling back: a silently ignored --timeout leaves the caller
// believing a long scan has minutes when it still has 120 s.
function timeoutFromFlag(v) {
  if (v === undefined) return undefined;
  const s = Number(v);
  if (v === true || !Number.isFinite(s) || s <= 0) throw new Error('--timeout <seconds> needs a positive number');
  return Math.round(s * 1000);
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
    requestTimeout: REQUEST_TIMEOUT_MS
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
// Pure (returns the refusal text, or null) so the rule can be unit-tested without a .env.
function nonProdWriteRefusal(c, name, what) {
  if (!c) return `Connection "${name}" does not exist. Use 'conns' to list.`;
  if (c.prod) {
    return `Connection "${name}" is PRODUCTION. ${what} is blocked in prod (no override). Use the migrations pipeline.`;
  }
  if (c.readonly) {
    return `Connection "${name}" is read-only (user ${c.user}). ${what} requires a write connection (dev/hml).`;
  }
  return null;
}

function assertDdlAllowed(name) {
  const refusal = nonProdWriteRefusal(getConn(name), name, 'DDL');
  if (refusal) fail(refusal);
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
    // A cached shape older than a week is fetched again: a column a migration added since would
    // otherwise stay invisible to describe/insert/update until someone passed --refresh.
    const row = d.prepare('SELECT columns_json, fetched_at FROM schema_cache WHERE key=?').get(key);
    if (row && !ctx.olderThan(row.fetched_at, ctx.SCHEMA_CACHE_TTL_DAYS)) return JSON.parse(row.columns_json);
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
// passing `--table tenant1.Contract` got `[sch].[tenant1.Contract]` — one broken identifier
// rather than a two-part name, and SQL Server then complains about the *table*, which
// sends you looking in the wrong place. splitTarget() resolves that before we get here.
function qual(schema, table) { return `[${schema}].[${table}]`; }

// Split a possibly-qualified table name. `tenant1.Contract` -> { schema: 'tenant1', table: 'Contract' };
// `[tenant1].[Contract]` likewise. An unqualified name keeps the caller's schema.
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

// Optional per-connection schema, e.g. `HML2_SCHEMA=tenant1` — the same sidecar shape
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

/** The project a connection belongs to (`<CONN>_PROJECT`), and every connection of that project. */
function connProject(connName) {
  return getConn(connName).project || connName;
}
function projectConns(project) {
  return Object.entries(loadConnections()).filter(([n, c]) => (c.project || n) === project).map(([n]) => n);
}

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
    if (c.project) console.log(`${' '.repeat(12)}   ↳ project ${c.project} (history and joins shared with its other connections)`);
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

/**
 * Pure: the SQL with comments, string literals and [bracketed identifiers] blanked out, lower-cased.
 * Keyword checks run on this, so a literal 'update' or a column [Delete] is not a false alarm, and a
 * keyword hidden after a comment is still seen.
 */
function sqlCode(text) {
  return String(text)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/N?'(?:[^']|'')*'/g, "''")
    .replace(/\[[^\]]*\]/g, '[]')
    .toLowerCase();
}

const MUTATION_RE = /\b(update|delete|insert|drop|truncate|alter|merge|create|grant|revoke|deny|commit)\b/;

// ------------------------------------------------------- read-only guard ----
// `query` is the only read path that takes free SQL, and it runs against production too, so
// this guard is the whole of "read-only" there. It blanks out comments, string literals and
// delimited identifiers (so a word inside them neither trips nor hides anything), tokenizes,
// and looks at EVERY token of the batch. The grammar accepted is deliberately small — scalar
// DECLARE / SET @v, then SELECT / WITH ... SELECT; or one sp_help-family procedure as the whole
// batch. Anything else has a command that journals it or rolls it back.

/**
 * Pure: the SQL with comments replaced by a space, string literals by '' and delimited
 * identifiers ([x] and "x") by []. Block comments nest, as in SQL Server. Throws on an
 * unterminated literal, identifier or comment — the guard fails closed.
 */
function stripSqlNoise(text) {
  const s = String(text);
  const n = s.length;
  let out = '';
  let i = 0;
  const closeQuoted = (open, close, what) => {
    i++;
    for (;;) {
      if (i >= n) throw new Error(`unterminated ${what} (opened with ${open})`);
      if (s[i] === close) {
        if (s[i + 1] === close) { i += 2; continue; } // doubled = escaped
        i++;
        return;
      }
      i++;
    }
  };
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '-' && d === '-') {
      const j = s.indexOf('\n', i);
      i = j === -1 ? n : j;
      out += ' ';
    } else if (c === '/' && d === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (s[i] === '/' && s[i + 1] === '*') { depth++; i += 2; }
        else if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('unterminated /* comment');
      out += ' ';
    } else if (c === "'") {
      closeQuoted("'", "'", 'string literal');
      out += "''";
    } else if (c === '[') {
      closeQuoted('[', ']', 'bracketed identifier');
      out += '[]';
    } else if (c === '"') {
      closeQuoted('"', '"', 'quoted identifier');
      out += '[]';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Words refused anywhere in a `query` batch, with the command that does the job instead.
const QUERY_REFUSED = (() => {
  const m = new Map();
  const add = (words, hint) => words.split(' ').forEach(w => m.set(w, hint));
  add('insert update delete merge truncate into', 'row changes go through insert/update/delete (journaled, revertible); SELECT ... INTO needs ddl on a non-prod connection');
  add('drop alter create grant revoke deny enable disable', 'schema/permission changes go through ddl (non-prod only)');
  add('backup restore dbcc kill shutdown reconfigure checkpoint setuser', 'server administration is not run by dbq query');
  add('bulk openrowset openquery opendatasource writetext updatetext', 'external/bulk data access or text writes are not reads');
  add('sp_executesql', 'dynamic SQL cannot be checked — not run by dbq');
  add('begin commit rollback save waitfor', 'transactions, blocks and waits are not reads');
  add('if while goto cursor open deallocate use receive send move', 'control flow, cursors, USE and Service Broker statements are not reads');
  return m;
})();

// Read-only system procedures `query` accepts — only as the whole batch, unqualified or `sys.`.
// A closed list, not /^sp_help\w*$/: anyone with CREATE PROCEDURE can make `dbo.sp_help_purge`,
// and a dbo/user-schema qualifier would run THAT one. Unqualified system names resolve to sys first.
const QUERY_SAFE_PROCS = new Set([
  'sp_help', 'sp_helpconstraint', 'sp_helpdb', 'sp_helpdbfixedrole', 'sp_helpfile', 'sp_helpfilegroup',
  'sp_helpindex', 'sp_helplanguage', 'sp_helprole', 'sp_helprolemember', 'sp_helprotect', 'sp_helpsort',
  'sp_helpsrvrole', 'sp_helpsrvrolemember', 'sp_helpstats', 'sp_helptext', 'sp_helptrigger', 'sp_helpuser',
  'sp_columns', 'sp_describe_first_result_set', 'sp_spaceused',
]);
const isSafeProc = (name) => QUERY_SAFE_PROCS.has(name);

/** Pure: tokens of noise-stripped SQL — { t: lowercase text, kind: word|var|num|punct, at, end }. */
function sqlTokens(clean) {
  const re = /(0x[0-9a-f]*)|((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)|([@#][\p{L}\p{N}_@#$]*)|([\p{L}_][\p{L}\p{N}_@#$]*)|(\S)/giu;
  const out = [];
  for (const m of String(clean).matchAll(re)) {
    const kind = m[1] || m[2] ? 'num' : m[3] ? 'var' : m[4] ? 'word' : 'punct';
    out.push({ t: m[0].toLowerCase(), kind, at: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Pure: is this batch a read `query` may run? Returns { ok, problems[] } — every problem found,
 * not just the first, so one round trip fixes them all.
 */
function analyzeReadOnlySql(text) {
  let clean;
  try { clean = stripSqlNoise(text); }
  catch (e) { return { ok: false, problems: [`${e.message} — cannot check a batch whose literals or comments do not close`] }; }
  const tokens = sqlTokens(clean);
  const problems = [];
  const seen = new Set();
  const add = (p) => { if (!seen.has(p)) { seen.add(p); problems.push(p); } };

  const first = tokens.find(t => t.t !== ';' && t.t !== '(');
  if (!first) return { ok: false, problems: ['empty query'] };
  if (first.kind !== 'word' || !['select', 'with', 'declare', 'set', 'exec', 'execute'].includes(first.t)) {
    // A procedure name as the first statement of a batch runs WITHOUT the word EXEC.
    add(`must start with SELECT or WITH (optionally after DECLARE @v / SET @v); starts with "${first.t}"`);
  }

  let execCount = 0;
  tokens.forEach((tok, i) => {
    const next = tokens[i + 1];
    if (tok.kind === 'num' && next && next.at === tok.end && (next.kind === 'word' || next.kind === 'var')) {
      add(`a number glued to a word ("${clean.slice(tok.at, next.end)}") — put a space or an operator between them`);
    }
    if (tok.kind !== 'word') return;
    const w = tok.t;
    if (QUERY_REFUSED.has(w)) {
      add(`${w.toUpperCase()}: ${QUERY_REFUSED.get(w)}`);
    } else if (/^xp_/.test(w)) {
      add(`${w}: extended procedures are not run by dbq query`);
    } else if (w === 'exec' || w === 'execute') {
      execCount++;
    } else if (w === 'declare' && !(next && next.kind === 'var' && next.t.startsWith('@'))) {
      add('DECLARE: only scalar variables (DECLARE @v type = value) are allowed');
    } else if (w === 'set' && !(next && next.kind === 'var' && next.t.startsWith('@') && !next.t.startsWith('@@'))) {
      add('SET: only SET @variable = value is allowed (no session options)');
    } else if (w === 'next' && next && next.t === 'value' && tokens[i + 2] && tokens[i + 2].t === 'for') {
      add('NEXT VALUE FOR advances a sequence — not a read');
    }
  });

  // DECLARE @t TABLE (also inside a comma list: DECLARE @a int, @t TABLE (...)).
  if (/@[\p{L}\p{N}_@#$]+\s+(?:as\s+)?table\b/iu.test(clean)) {
    add('table variables (DECLARE @t TABLE) are not allowed — only scalar variables');
  }

  if (execCount) {
    const reason = safeExecProblem(clean, execCount, first);
    if (reason) add(reason);
  }
  return { ok: problems.length === 0, problems };
}

// EXEC passes only as `EXEC [sys.]sp_help|sp_columns|... args` filling the whole batch.
function safeExecProblem(clean, execCount, first) {
  const generic = 'EXEC/EXECUTE: query runs only system sp_help* / sp_columns / sp_helptext / '
    + 'sp_describe_first_result_set / sp_spaceused (unqualified or sys.), alone in the batch — '
    + "a procedure call goes through 'dbq exec <conn> \"EXEC schema.Proc ...\"', which always rolls back";
  if (execCount > 1 || first.t !== 'exec' && first.t !== 'execute') return generic;
  const body = clean.trim().replace(/[\s;]+$/, '').toLowerCase();
  const ARG = String.raw`(?:@[\p{L}\p{N}_@#$]+\s*=\s*)?(?:n?''|[-+]?[\p{L}\p{N}_.]+|\[\](?:\.\[\])*)(?:\s+out(?:put)?)?`;
  const m = body.match(new RegExp(String.raw`^;*\s*exec(?:ute)?\s+(?:sys\.)?([\p{L}_][\p{L}\p{N}_]*)((?:\s+${ARG}(?:\s*,\s*${ARG})*)?)$`, 'u'));
  if (!m) {
    const proc = (body.match(/exec(?:ute)?\s+(?:sys\.)?([\p{L}_][\p{L}\p{N}_]*)(?![\p{L}\p{N}_.])/u) || [])[1];
    return proc && isSafeProc(proc)
      ? `EXEC ${proc}: must be the whole batch (only its arguments may follow) — nothing after it`
      : generic;
  }
  if (!isSafeProc(m[1])) return generic;
  // sp_spaceused @updateusage = 'true' (or a 2nd positional) runs DBCC UPDATEUSAGE — a write.
  if (m[1] === 'sp_spaceused' && (/@updateusage/.test(m[2]) || m[2].includes(','))) {
    return 'sp_spaceused: only the object name is allowed (@updateusage runs DBCC UPDATEUSAGE)';
  }
  return null;
}

/** Pure: the CLI refusal text for a batch `query` will not run, or null. */
function readOnlyProblem(text) {
  const r = analyzeReadOnlySql(text);
  if (r.ok) return null;
  return "'query' is read-only and refused this batch (comments, strings and [identifiers] were ignored):\n"
    + r.problems.map(p => `  - ${p}`).join('\n')
    + '\nUse insert/update/delete for journaled row changes, ddl for CREATE/ALTER/DROP, or'
    + " 'dbq exec <conn> \"EXEC schema.Proc ...\"' (always rolled back) for a procedure."
    + '\nA column named like a keyword can be written [Bracketed].';
}

function ensureSelectOnly(text) {
  const problem = readOnlyProblem(text);
  if (problem) fail(problem);
}

/**
 * Pure: why `exec` must refuse this SQL, or null. One EXEC of a named procedure, nothing else:
 * no mutation keyword in the batch itself (what the procedure does inside is the rollback's job),
 * no second statement chained after it.
 */
function execProblem(text) {
  const t = sqlCode(text).trim().replace(/;\s*$/, '');
  if (!/^exec(?:ute)?\s+[\w\[\]."]+/.test(t)) {
    return "'exec' runs one procedure call: exec <conn> \"EXEC schema.Proc @a = 1, ...\".";
  }
  if (/\bsp_executesql\b|\bexec(?:ute)?\s*\(/.test(t)) {
    return "'exec' does not run dynamic SQL (sp_executesql / EXEC('...')).";
  }
  if ((t.match(/\bexec(?:ute)?\b/g) || []).length > 1 || t.includes(';')) {
    return "'exec' runs a single procedure call; split the batch.";
  }
  if (MUTATION_RE.test(t)) {
    return "The batch has a mutation keyword outside the procedure call. Use insert/update/delete.";
  }
  return null;
}

/**
 * Pure: may `exec` run on this connection? A procedure can write, and the only undo is the rollback.
 * A PROD connection with write rights is refused with no override: one COMMIT inside the procedure
 * would make its writes permanent. A read-only connection (reader user) is allowed — the server
 * refuses any write anyway.
 */
function execConnProblem(c) {
  if (c.prod && !c.readonly) {
    return `Connection is PRODUCTION with write rights. 'exec' is blocked there (no override); use a read-only connection or dev/hml.`;
  }
  return null;
}

/**
 * Sums the messages of SET STATISTICS IO, TIME: reads per table and execution time. Logical reads are
 * the number a DBA trusts (pages touched, independent of what was in memory); elapsed time varies with
 * cache and load. Parse/compile time is reported apart from execution time.
 */
function parseStatsMessages(messages) {
  const tables = new Map();
  const exec = { cpuMs: 0, elapsedMs: 0 };
  const compile = { cpuMs: 0, elapsedMs: 0 };
  for (const m of messages) {
    // A time line belongs to the section header above it ("parse and compile time:" or
    // "Execution Times:"), which may sit in the same message or in the one before.
    let section = exec;
    for (const line of String(m).split(/\r?\n/)) {
      if (/parse and compile time/i.test(line)) { section = compile; continue; }
      if (/Execution Times/i.test(line)) { section = exec; continue; }
      const t = line.match(/Table '([^']+)'\. Scan count (\d+), logical reads (\d+), physical reads (\d+)/);
      if (t) {
        const ra = line.match(/(?:^|[ ,])read-ahead reads (\d+)/);
        const e = tables.get(t[1]) || { table: t[1], scans: 0, logical: 0, physical: 0, readAhead: 0 };
        e.scans += +t[2]; e.logical += +t[3]; e.physical += +t[4]; e.readAhead += ra ? +ra[1] : 0;
        tables.set(t[1], e);
        continue;
      }
      const time = line.match(/CPU time = (\d+) ms,\s+elapsed time = (\d+) ms/);
      if (time) { section.cpuMs += +time[1]; section.elapsedMs += +time[2]; }
    }
  }
  const list = [...tables.values()].sort((a, b) => b.logical - a.logical);
  const total = list.reduce((s, e) => ({ logical: s.logical + e.logical, physical: s.physical + e.physical, readAhead: s.readAhead + e.readAhead }),
    { logical: 0, physical: 0, readAhead: 0 });
  return { tables: list, total, exec, compile };
}

function printStats(stats, wallMs) {
  const n = v => v.toLocaleString('en-US');
  const out = [`-- stats: logical reads ${n(stats.total.logical)}, physical ${n(stats.total.physical)}, read-ahead ${n(stats.total.readAhead)}`
    + ` | server CPU ${n(stats.exec.cpuMs)} ms, elapsed ${n(stats.exec.elapsedMs)} ms (compile ${n(stats.compile.elapsedMs)} ms) | client ${n(wallMs)} ms`];
  for (const e of stats.tables) {
    out.push(`--   ${e.table}: logical ${n(e.logical)}, physical ${n(e.physical)}, read-ahead ${n(e.readAhead)}, scans ${n(e.scans)}`);
  }
  console.error(out.join('\n'));
}

/**
 * The SQL of a command that takes it inline or from `--file`. A long query (a VALUES list,
 * a CTE chain) does not survive shell quoting, so the file is the only way to send it as written.
 * Throws instead of failing so the rule is testable; the caller turns it into `fail`.
 */
function sqlFromArgs(inline, file, usage, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  const fromFile = file && file !== true;
  if (file === true) throw new Error('--file needs a path: ' + usage);
  if (inline && fromFile) throw new Error('Pass the SQL inline OR --file, not both.');
  if (fromFile) {
    let text;
    try { text = readFile(file); }
    catch (e) { throw new Error('Could not read --file: ' + e.message); }
    if (!String(text).trim()) throw new Error('--file is empty: ' + file);
    return text;
  }
  if (!inline) throw new Error('Provide the SQL: ' + usage);
  return inline;
}

/**
 * `count <conn> <table>` reads like `describe <conn> <table>`; `--table` still works.
 * Both at once must name the same table, or the count would silently pick one.
 */
function withPositionalTable(flags, positional) {
  if (!positional) return flags;
  const given = flags.table && flags.table !== true ? String(flags.table) : null;
  if (given && given !== positional) {
    throw new Error(`Conflicting table: "${positional}" and --table "${given}". Pass one.`);
  }
  return { ...flags, table: positional };
}

/**
 * Runs one read against the server and records it in the history (fingerprint, outcome, time,
 * row count, task label). A failure to record is reported on stderr and never fails the read.
 */
async function logged(connName, op, text, run, rowsOf = (r) => r?.recordset?.length ?? null) {
  const t0 = Date.now();
  const record = (outcome) => {
    try { ctx.recordRead(db(), { conn: connName, project: connProject(connName), op, text, task: ctx.taskLabel(), ms: Date.now() - t0, ...outcome }); }
    catch (e) { console.error('-- history not recorded: ' + e.message); }
  };
  let result;
  try { result = await run(); }
  catch (e) {
    record({ ok: false, error: e.message });
    const hints = await failureHints(connName, text, e.message);
    if (hints.length) e.message += '\n' + hints.map(h => `-- hint (catalog of ${connName}): ${h}`).join('\n');
    throw e;
  }
  record({ ok: true, rows: rowsOf(result) });
  return result;
}

/**
 * The catalog's answer to "Invalid column/object name" and "Ambiguous column name": the closest
 * names, the schema that holds a table, the table that holds a column. Reads the catalog first when
 * the connection has none (once; it is then kept for a week). Never masks the original error.
 */
async function failureHints(connName, text, message) {
  if (!ctx.failureNames(message).length) return [];
  try {
    if (!ctx.catalogMeta(db(), connName)) await ensureCatalog(connName, false);
    return ctx.failureHints(db(), connName, { text, error: message, defaultSchema: connDefaultSchema(connName) || DEFAULT_SCHEMA });
  } catch (e) {
    return [`none (${e.message})`];
  }
}

async function cmdQuery(connName, inlineSql, flags) {
  let queryText;
  try { queryText = sqlFromArgs(inlineSql, flags.file, 'query <conn> "SELECT ..." | --file <a.sql>'); }
  catch (e) { return fail(e.message); }
  ensureSelectOnly(queryText);
  if (flags.stats) return cmdQueryWithStats(connName, queryText, flags);
  const ttl = ttlFromFlag(flags.cache);
  if (ttl) {
    const hit = cacheGet(connName, queryText);
    if (hit) { printRows(hit, flags, { fromCache: true }); return; }
  }
  const pool = await getPool(connName);
  try {
    const r = await logged(connName, 'query', queryText, () => pool.request().query(queryText));
    if (ttl) cachePut(connName, queryText, r.recordset, ttl);
    printRows(r.recordset, flags);
  } finally {
    await pool.close();
  }
}

// --stats: no result cache (a cached answer has no reads to report). The SET runs in the same batch, after
// ensureSelectOnly has checked the caller's SQL, so the guard still sees only what the caller wrote.
async function cmdQueryWithStats(connName, queryText, flags) {
  const pool = await getPool(connName);
  try {
    const req = pool.request();
    const messages = [];
    req.on('info', m => messages.push(m.message));
    const t0 = Date.now();
    const r = await logged(connName, 'query', queryText, () => req.query(`SET STATISTICS IO, TIME ON;\n${queryText}`));
    const wallMs = Date.now() - t0;
    printRows(r.recordset, flags);
    printStats(parseStatsMessages(messages), wallMs);
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
    const r = await logged(connName, 'select', q, () => pool.request().query(q));
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
    const r = await logged(connName, 'count', q, () => pool.request().query(q));
    console.log(r.recordset[0].n);
  } finally {
    await pool.close();
  }
}

/**
 * `dbq schemas <conn> [--table T]` — which schemas this database actually has.
 *
 * A schema in these databases is a tenant, so "which schema?" has no global answer
 * and the previous workflow was to try `--schema tenant1`, `tenant2`, … until a command
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

/**
 * The rows of an insert: one JSON object, or an array of them inserted in ONE transaction and ONE
 * journal entry (revert deletes them all). Throws on anything that would bind no columns.
 */
function parseInsertRows(text) {
  let values;
  try { values = JSON.parse(text); } catch (e) { throw new Error(`--values is not valid JSON: ${e.message}`); }
  const rows = Array.isArray(values) ? values : [values];
  if (rows.length === 0) throw new Error('--values array is empty');
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length === 0) {
      throw new Error(`--values row ${i + 1} must be a non-empty JSON object of column: value`);
    }
  });
  return { values, rows };
}

async function cmdInsert(connName, flags) {
  assertWritable(connName, flags);
  const { schema, table } = resolveTarget(connName, flags);
  const pk = flags.pk || 'Id';
  // --values-file: a JSON array of many rows does not fit the Windows command line (32 KB).
  const valuesText = flags['values-file'] ? fs.readFileSync(flags['values-file'], 'utf8') : flags.values;
  if (!valuesText) fail('--values \'{"col":value}\' (or --values-file <file.json>) required');
  let values, rows;
  try { ({ values, rows } = parseInsertRows(valuesText)); } catch (e) { fail(e.message); }

  const insertSql = (row, names) => {
    const colList = Object.keys(row).map(k => `[${k}]`).join(', ');
    const valList = Object.keys(row).map(k => `@${names[k]}`).join(', ');
    // OUTPUT ... INTO @tbl (instead of a direct OUTPUT) to work on tables with triggers
    // (SQL Server forbids OUTPUT without INTO when a trigger is enabled).
    return `DECLARE @ids TABLE ([pk] sql_variant); INSERT INTO ${qual(schema, table)} (${colList}) OUTPUT INSERTED.[${pk}] INTO @ids ([pk]) VALUES (${valList}); SELECT [pk] AS pk FROM @ids;`;
  };

  const pool = await getPool(connName);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const firstReq = new sql.Request(tx);
    const insSql = insertSql(rows[0], bindParams(firstReq, rows[0], 'v'));

    if (!flags.yes) {
      await tx.rollback();
      console.log('[DRY-RUN] (no --yes, not applied)');
      console.log('SQL>  ' + insSql);
      console.log(rows.length === 1 ? 'Values: ' + JSON.stringify(values) : `Rows: ${rows.length} (first: ${JSON.stringify(rows[0])})`);
      await pool.close();
      return;
    }

    const insertedPks = (await firstReq.query(insSql)).recordset.map(r => r.pk);
    for (const row of rows.slice(1)) {
      const req = new sql.Request(tx);
      const res = await req.query(insertSql(row, bindParams(req, row, 'v')));
      insertedPks.push(...res.recordset.map(r => r.pk));
    }
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

/**
 * `exec`: runs one procedure call inside a transaction that is ALWAYS rolled back, to read what it
 * returns and, with --stats, measure it (reads per table + server time). For procedures that only
 * read, or that write to #temp tables. Every result set is printed.
 *
 * If the procedure ends the transaction itself (COMMIT or ROLLBACK inside it), @@TRANCOUNT comes back
 * 0 and there is nothing left to roll back: the command fails and says so, because any write the
 * procedure made is now permanent.
 */
/**
 * Pure: the json document `exec --format json` prints — ONE document on stdout, so a script can
 * parse it whole. Each result set follows the same --top / --full rules as `query`; a cut result
 * set is listed in `truncated` (only present when something was cut). `uncapped` (exec --out)
 * keeps every row.
 */
function execJsonDocument(recordsets, rowsAffected, flags, { uncapped = false } = {}) {
  const cap = uncapped ? Infinity : clampTop(flags.top || DEFAULT_TOP);
  const truncated = [];
  const resultSets = recordsets.map((rows, i) => {
    const shown = rows.length > cap ? rows.slice(0, cap) : rows;
    if (shown.length < rows.length) truncated.push({ resultSet: i + 1, shown: shown.length, total: rows.length });
    if (!shown.length) return [];
    const cols = visibleColumns(shown, flags.full);
    return shown.map(r => {
      const o = {};
      for (const c of cols) o[c] = r[c] instanceof Date ? r[c].toISOString() : r[c];
      return o;
    });
  });
  const doc = { resultSets, rowsAffected };
  if (truncated.length) doc.truncated = truncated;
  return doc;
}

async function cmdExec(connName, inlineSql, flags) {
  let text;
  try { text = sqlFromArgs(inlineSql, flags.file, 'exec <conn> "EXEC schema.Proc ..." | --file <a.sql>'); }
  catch (e) { return fail(e.message); }
  const problem = execProblem(text) || execConnProblem(getConn(connName));
  if (problem) return fail(problem);
  if (flags.out === true || flags.out === '') return fail('--out needs a file path.');
  const json = String(flags.format || '').toLowerCase() === 'json';

  const pool = await getPool(connName);
  const tx = new sql.Transaction(pool);
  let open = false;
  try {
    await tx.begin();
    open = true;
    const req = new sql.Request(tx);
    const messages = [];
    req.on('info', m => messages.push(m.message));
    const t0 = Date.now();
    const r = await logged(connName, 'exec', text,
      () => req.query(`${flags.stats ? 'SET STATISTICS IO, TIME ON;\n' : ''}${text}\n;SELECT @@TRANCOUNT AS __dbq_trancount;`),
      (res) => (res?.recordsets || []).slice(0, -1).reduce((s, set) => s + set.length, 0));
    const wallMs = Date.now() - t0;
    const sets = r.recordsets.slice(0, -1);
    const tranCount = r.recordsets[r.recordsets.length - 1]?.[0]?.__dbq_trancount;
    if (tranCount === 0) {
      open = false;
      fail('The procedure ended the transaction itself (COMMIT/ROLLBACK inside it). Nothing was rolled back by dbq: '
        + 'any write it made is PERMANENT. Check it with select before running it again.');
    }
    const rowsAffected = (r.rowsAffected || []).slice(0, -1); // the last one is the @@TRANCOUNT probe
    if (flags.out) {
      // A proof needs every row, the transcript only the counts: the cap protects the reader, not the file.
      fs.writeFileSync(flags.out, JSON.stringify(execJsonDocument(sets, rowsAffected, { ...flags, full: true }, { uncapped: true })));
      console.log(`wrote ${sets.length} result set(s) [${sets.map(s => s.length).join(', ')} row(s)] to ${flags.out}`);
    } else if (json) {
      console.log(JSON.stringify(execJsonDocument(sets, rowsAffected, flags)));
    } else {
      sets.forEach((rows, i) => {
        if (sets.length > 1) console.log(`-- result set ${i + 1}/${sets.length}`);
        printRows(rows, flags);
      });
      if (sets.length === 0) console.log('(no result set)');
    }
    if (flags.stats) printStats(parseStatsMessages(messages), wallMs);
  } finally {
    if (open) {
      try { await tx.rollback(); console.error('-- exec: rolled back.'); }
      catch (e) { console.error('-- exec: rollback failed: ' + e.message); }
    }
    await pool.close();
  }
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
  // Newest N, printed oldest first: the whole journal (thousands of entries) in an agent's context
  // costs tokens and repeats WHERE clauses that may carry customer values.
  const top = clampTop(flags.top || DEFAULT_TOP);
  const filter = flags.all ? '' : 'WHERE reverted=0';
  const total = db().prepare(`SELECT COUNT(*) AS n FROM journal ${filter}`).get().n;
  const rows = db().prepare(
    `SELECT seq, ts, op, connection, schema, "table" AS tbl, affected, where_clause, reverted
     FROM journal ${filter} ORDER BY seq DESC LIMIT ?`).all(top).reverse();
  if (rows.length === 0) { console.log('(journal empty)'); return; }
  if (total > rows.length) console.log(`(newest ${rows.length} of ${total}; --top N for more, max ${MAX_TOP})`);
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

function cmdPrune(flags) {
  let days;
  try { days = ctx.parseAgeDays(flags['older-than']); } catch (e) { return fail(e.message); }
  const d = db();
  const plan = ctx.prunePlan(d, days);
  const sizeOf = () => { try { return fs.statSync(DB_PATH).size; } catch { return 0; } };
  const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
  console.log(`prune: older than ${days} day(s) (before ${plan.cutoff.slice(0, 10)})`);
  console.log(`  journal entries      ${plan.journal}  (${plan.journalLive} not reverted: they can no longer be undone)`);
  console.log(`  raw query texts      ${plan.rawQueries}  (fingerprints stay)`);
  console.log(`  expired cache rows   ${plan.resultCache}`);
  if (!flags.yes) { console.log(`\nDRY RUN (${mb(sizeOf())} now) — nothing removed. Re-run with --yes.`); return; }
  const before = sizeOf();
  ctx.applyPrune(d, plan);
  console.log(`\nOK prune: ${mb(before)} -> ${mb(sizeOf())}.`);
}

/** The catalog of `conn`, read again from sys.* when missing, older than a week, or on --refresh. */
async function ensureCatalog(connName, refresh) {
  getConn(connName); // unknown connection fails here, before any network
  const d = db();
  if (!refresh && !ctx.catalogStale(d, connName)) return ctx.catalogMeta(d, connName);
  const pool = await getPool(connName);
  try {
    const t0 = Date.now();
    const [tables, columns, fks] = await Promise.all(
      ['tables', 'columns', 'fks'].map(k => pool.request().query(ctx.CATALOG_SQL[k]).then(r => r.recordset)));
    ctx.storeCatalog(d, connName, { tables, columns, fks });
    console.error(`-- catalog of ${connName} read: ${tables.length} tables, ${columns.length} columns, ${fks.length} FK columns (${Date.now() - t0} ms)`);
  } finally {
    await pool.close();
  }
  return ctx.catalogMeta(d, connName);
}

async function cmdCatalog(connName, flags) {
  if (!connName) fail('usage: catalog <conn> [--refresh]');
  const m = await ensureCatalog(connName, !!flags.refresh);
  console.log(`${connName}: ${m.schemas} schema(s), ${m.tables} tables, ${m.columns} columns, ${m.fks} FK columns`
    + ` — read ${m.fetched_at.slice(0, 16).replace('T', ' ')} UTC, refreshed by itself after ${ctx.CATALOG_TTL_DAYS} days.`);
}

async function cmdFind(connName, term, flags) {
  if (!connName || !term) fail('usage: find <conn> <term> [--schema s] [--top N]');
  await ensureCatalog(connName, false);
  const top = clampTop(flags.top || 30);
  const schema = flags.schema && flags.schema !== true ? String(flags.schema) : null;
  const r = ctx.searchCatalog(db(), connName, term, { schema, top, preferSchema: connDefaultSchema(connName) || DEFAULT_SCHEMA });
  if (String(flags.format || '').toLowerCase() === 'json') { console.log(JSON.stringify(r)); return; }
  const where = (schemas) => schemas.length === 1 ? schemas[0] : `${schemas.length} schemas`;
  console.log(`Tables matching "${term}" on ${connName}: ${r.tablesTotal}${r.tablesTotal > r.tables.length ? ` (first ${r.tables.length})` : ''}`);
  for (const t of r.tables) {
    const rows = t.rowsEst === null || t.rowsEst === undefined ? '' : `~${Number(t.rowsEst).toLocaleString('en-US')} rows`;
    console.log(`  ${t.table.padEnd(40)} ${where(t.schemas).padEnd(12)} ${rows}${t.descr ? `  -- ${t.descr}` : ''}`.trimEnd());
  }
  console.log(`Columns matching "${term}": ${r.columnsTotal}${r.columnsTotal > r.columns.length ? ` (first ${r.columns.length})` : ''}`);
  for (const c of r.columns) {
    console.log(`  ${`${c.table}.${c.column}`.padEnd(56)} ${c.type.padEnd(16)} ${where(c.schemas)}`);
  }
}

async function cmdContext(connName, table, flags) {
  if (!connName || !table) fail('usage: context <conn> <table> [--schema s] [--format json]');
  await ensureCatalog(connName, false);
  const { schema, table: tbl } = splitTarget(String(table), null);
  const wanted = flags.schema && flags.schema !== true ? String(flags.schema) : schema;
  const project = connProject(connName);
  const c = ctx.contextData(db(), connName, tbl, {
    schema: wanted, defaultSchema: connDefaultSchema(connName) || DEFAULT_SCHEMA, project, conns: projectConns(project),
  });
  if (!c) {
    fail(`No table "${tbl}"${wanted ? ` in schema ${wanted}` : ''} in the catalog of ${connName}. `
      + `Search by part of the name:  dbq find ${connName} ${tbl.slice(0, 12)}   (or catalog ${connName} --refresh after a migration)`);
  }
  if (String(flags.format || '').toLowerCase() === 'json') { console.log(JSON.stringify(c)); return; }
  console.log(ctx.formatContext(c));
}

async function cmdJoins(connName, table, flags) {
  if (!connName || !table) fail('usage: joins <conn> <table> [--top N]');
  await ensureCatalog(connName, false);
  const rows = ctx.joinRows(db(), connName, table, { top: clampTop(flags.top || 20), project: connProject(connName) });
  if (!rows.length) { console.log(`No join known for ${table}: no FK declared and none seen in your reads yet.`); return; }
  console.log(`Joins of ${table} (fk = declared on ${connName}, log = seen in reads of project ${connProject(connName)}):`);
  for (const j of rows) console.log(`  ${`${j.from.t}.${j.from.c} = ${j.to.t}.${j.to.c}`.padEnd(70)} ${j.source}${j.seen ? ` x${j.seen}` : ''}`);
}

function cmdHistory(connName, flags) {
  const rows = ctx.historyRows(db(), {
    conn: connName || null,
    table: flags.table && flags.table !== true ? String(flags.table) : null,
    grep: flags.grep && flags.grep !== true ? String(flags.grep) : null,
    failed: !!flags.failed,
    top: clampTop(flags.top || 20),
  });
  if (String(flags.format || '').toLowerCase() === 'json') {
    console.log(JSON.stringify(rows.map(r => ({ ...r, sql_raw: flags.raw ? r.sql_raw : undefined }))));
    return;
  }
  if (!rows.length) { console.log('(no read recorded for this filter)'); return; }
  for (const r of rows) {
    const failedRuns = r.runs - r.ok_runs;
    const avg = Math.round(r.ms_total / Math.max(r.runs, 1));
    console.log(`[${r.hash}] ${r.last_at.slice(0, 16).replace('T', ' ')}  ${r.conn}  ${r.op}  x${r.runs}${failedRuns ? ` (${failedRuns} failed)` : ''}`
      + `  avg ${avg} ms${r.rows_last !== null ? `  rows ${r.rows_last}` : ''}${r.task ? `  task ${r.task}` : ''}`);
    console.log(`    ${flags.raw && r.sql_raw ? r.sql_raw.replace(/\s+/g, ' ').trim() : r.sql_fp}`);
    if (!r.last_ok && r.last_error) console.log(`    last error: ${r.last_error}`);
  }
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
  if (wantsHelp(argv)) { console.log(usageText()); return; }
  const cmd = argv[0];
  const { positionals, flags } = parseArgs(argv.slice(1));

  checkUnknownFlags(flags);
  try { REQUEST_TIMEOUT_MS = timeoutFromFlag(flags.timeout) ?? REQUEST_TIMEOUT_MS; } catch (e) { fail(e.message); }

  switch (cmd) {
    case 'conns': return cmdConns();
    case 'schemas': return cmdSchemas(positionals[0], flags);
    case 'auth': return cmdAuth(positionals[0], flags);
    case 'query': return cmdQuery(positionals[0], positionals[1], flags);
    case 'select': return cmdSelect(positionals[0], flags);
    case 'count': {
      let countFlags;
      try { countFlags = withPositionalTable(flags, positionals[1]); } catch (e) { return fail(e.message); }
      return cmdCount(positionals[0], countFlags);
    }
    case 'describe': return cmdDescribe(positionals[0], positionals[1], flags);
    case 'update': return cmdUpdate(positionals[0], flags);
    case 'delete': return cmdDelete(positionals[0], flags);
    case 'insert': return cmdInsert(positionals[0], flags);
    case 'ddl': return cmdDdl(positionals[0], positionals[1], flags);
    case 'exec': return cmdExec(positionals[0], positionals[1], flags);
    case 'log': return cmdLog(flags);
    case 'show': return cmdShow(positionals[0], flags);
    case 'revert': return cmdRevert(positionals[0], flags);
    case 'revert-last': return cmdRevertLast(flags);
    case 'cache-clear': return cmdCacheClear();
    case 'prune': return cmdPrune(flags);
    case 'catalog': return cmdCatalog(positionals[0], flags);
    case 'find': return cmdFind(positionals[0], positionals[1], flags);
    case 'context': return cmdContext(positionals[0], positionals[1], flags);
    case 'joins': return cmdJoins(positionals[0], positionals[1], flags);
    case 'history': return cmdHistory(positionals[0], flags);
    default:
      console.log(usageText());
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
  parseArgs, unknownFlags, checkUnknownFlags, editDistance, wantsHelp, FLAG_HINTS,
  qual, splitTarget, resolveTarget, schemaFromEnvText,
  parseConnString, parseEnv, clampTop, ttlFromFlag,
  parseStatsMessages, timeoutFromFlag, parseInsertRows, sqlFromArgs, withPositionalTable,
  sqlCode, readOnlyProblem, execProblem, execConnProblem,
  stripSqlNoise, analyzeReadOnlySql, nonProdWriteRefusal, splitDdlBatches, execJsonDocument,
  DEFAULT_SCHEMA, DEFAULT_TOP, MAX_TOP, KNOWN_FLAGS,
};
