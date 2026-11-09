'use strict';

// Unit tests for dbq's pure helpers. No database, no network, no journal.
// Run: npm test   (or: node --test)

const { test } = require('node:test');
const assert = require('node:assert');

const {
  parseArgs, unknownFlags, editDistance, wantsHelp, FLAG_HINTS, KNOWN_FLAGS,
  qual, splitTarget, schemaFromEnvText,
  parseConnString, parseEnv, clampTop, ttlFromFlag,
  DEFAULT_SCHEMA, DEFAULT_TOP, MAX_TOP, sqlFromArgs, withPositionalTable,
} = require('../index.js');

// ── parseArgs ────────────────────────────────────────────────────────────────
test('parseArgs: separates positionals, valued flags and boolean flags', () => {
  const { positionals, flags } = parseArgs(['DEV1', 'tenant1.Contract', '--top', '10', '--full']);
  assert.deepStrictEqual(positionals, ['DEV1', 'tenant1.Contract']);
  assert.strictEqual(flags.top, '10');
  assert.strictEqual(flags.full, true);
});

test('parseArgs: a flag followed by another flag is boolean, not a value', () => {
  const { flags } = parseArgs(['--refresh', '--schema', 'tenant1']);
  assert.strictEqual(flags.refresh, true);
  assert.strictEqual(flags.schema, 'tenant1');
});

// ── splitTarget — the qualified-name bug ─────────────────────────────────────
test('splitTarget: a qualified name is understood, not prefixed again', () => {
  // The bug: qual() used to wrap this blindly into [sch].[tenant1.Contract] — one
  // broken identifier — and SQL Server then complained about the TABLE, which
  // sends you looking in the wrong place.
  assert.deepStrictEqual(splitTarget('tenant1.Contract', 'sch'),
    { schema: 'tenant1', table: 'Contract', qualified: true });
});

test('splitTarget: bracketed qualified names too', () => {
  assert.deepStrictEqual(splitTarget('[tenant1].[Contract]', 'sch'),
    { schema: 'tenant1', table: 'Contract', qualified: true });
});

test('splitTarget: a bare name keeps the caller fallback and is flagged unqualified', () => {
  assert.deepStrictEqual(splitTarget('Contract', 'tenant17'),
    { schema: 'tenant17', table: 'Contract', qualified: false });
});

test('splitTarget: brackets are stripped from a bare name', () => {
  assert.strictEqual(splitTarget('[Contract]', 'tenant1').table, 'Contract');
});

test('splitTarget: a three-part name is refused instead of silently mangled', () => {
  assert.throws(() => splitTarget('db.tenant1.Contract', 'sch'), /more than two parts/);
});

test('splitTarget: tolerates surrounding whitespace', () => {
  assert.deepStrictEqual(splitTarget('  tenant2.Widget  ', 'sch'),
    { schema: 'tenant2', table: 'Widget', qualified: true });
});

test('qual: still brackets both halves once they are separated', () => {
  assert.strictEqual(qual('tenant1', 'Contract'), '[tenant1].[Contract]');
});

// ── schemaFromEnvText — the per-connection default ───────────────────────────
const ENV_SAMPLE = [
  '# comentário',
  'DEV1=Data Source=srv;Initial Catalog=appdb;User Id=u;Password=p',
  'DEV1_DESC=dev do time',
  'DEV1_SCHEMA=tenant1',
  'HML2=Data Source=h;Initial Catalog=appdb;User Id=u;Password=p',
  "HML2_SCHEMA='tenant2'",
  'HMLADM_SCHEMA=',
].join('\n');

test('schemaFromEnvText: reads <CONN>_SCHEMA', () => {
  assert.strictEqual(schemaFromEnvText(ENV_SAMPLE, 'DEV1'), 'tenant1');
});

test('schemaFromEnvText: strips surrounding quotes', () => {
  assert.strictEqual(schemaFromEnvText(ENV_SAMPLE, 'HML2'), 'tenant2');
});

test('schemaFromEnvText: an empty value is null, not an empty schema', () => {
  assert.strictEqual(schemaFromEnvText(ENV_SAMPLE, 'HMLADM'), null);
});

test('schemaFromEnvText: a connection without the key is null', () => {
  assert.strictEqual(schemaFromEnvText(ENV_SAMPLE, 'ELPRD'), null);
  assert.strictEqual(schemaFromEnvText(ENV_SAMPLE, null), null);
  assert.strictEqual(schemaFromEnvText('', 'DEV1'), null);
});

test('schemaFromEnvText: does not confuse _SCHEMA with _DESC on the same connection', () => {
  assert.strictEqual(schemaFromEnvText('X_DESC=tenant9\nX_SCHEMA=tenant3', 'X'), 'tenant3');
});

// ── parseEnv ─────────────────────────────────────────────────────────────────
test('parseEnv: sidecar keys never become connections of their own', () => {
  // _SCHEMA joined _READONLY/_PROD/_DESC in the skip list; without that, a key
  // like DEV1_SCHEMA would surface as a phantom connection in `dbq conns`.
  const conns = parseEnv(ENV_SAMPLE);
  assert.deepStrictEqual(Object.keys(conns).sort(), ['DEV1', 'HML2']);
});

test('parseEnv: the per-connection schema rides on the connection object', () => {
  assert.strictEqual(parseEnv(ENV_SAMPLE).DEV1.schema, 'tenant1');
  assert.strictEqual(parseEnv(ENV_SAMPLE).HML2.schema, 'tenant2');
});

test('parseEnv: a value that is not a connection string is ignored', () => {
  assert.deepStrictEqual(Object.keys(parseEnv('NOT_A_CONN=hello world')), []);
});

test('parseEnv: comments and blank lines are skipped', () => {
  assert.deepStrictEqual(Object.keys(parseEnv('# X=Data Source=a;\n\n')), []);
});

// ── parseConnString ──────────────────────────────────────────────────────────
test('parseConnString: reads the ADO.NET keys case-insensitively', () => {
  const p = parseConnString('Data Source=srv.database.windows.net;Initial Catalog=appdb;User Id=reader;Password=***');
  assert.strictEqual(p.server, 'srv.database.windows.net');
  assert.strictEqual(p.database, 'appdb');
  assert.strictEqual(p.user, 'reader');
});

test('parseConnString: accepts the Server=/Database= spelling too', () => {
  const p = parseConnString('Server=s;Database=d;Uid=u;Pwd=p');
  assert.strictEqual(p.server, 's');
  assert.strictEqual(p.database, 'd');
  assert.strictEqual(p.user, 'u');
});

test('parseEnv: a "reader" user is marked read-only without needing a flag', () => {
  const conns = parseEnv('R=Data Source=s;Initial Catalog=d;User Id=app_reader;Password=p');
  assert.strictEqual(conns.R.readonly, true);
});

test('parseEnv: a prod-looking database is treated as prod by default', () => {
  const conns = parseEnv('P=Data Source=s-prd;Initial Catalog=appdbprd;User Id=u;Password=p');
  assert.strictEqual(conns.P.prod, true);
  // prod implies read-only unless explicitly overridden — the safe default.
  assert.strictEqual(conns.P.readonly, true);
});

test('parseEnv: an explicit _READONLY=false overrides the inference', () => {
  const conns = parseEnv('W=Data Source=s;Initial Catalog=d;User Id=u;Password=p;\nW_READONLY=false\nW_PROD=false');
  assert.strictEqual(conns.W.readonly, false);
  assert.strictEqual(conns.W.prod, false);
});

// ── clampTop / ttlFromFlag ───────────────────────────────────────────────────
test('clampTop: clamps to MAX_TOP and falls back on nonsense', () => {
  assert.strictEqual(clampTop('10'), 10);
  assert.strictEqual(clampTop(String(MAX_TOP + 5000)), MAX_TOP);
  assert.strictEqual(clampTop('0'), DEFAULT_TOP);
  assert.strictEqual(clampTop('-3'), DEFAULT_TOP);
  assert.strictEqual(clampTop('abc'), DEFAULT_TOP);
  assert.strictEqual(clampTop(undefined), DEFAULT_TOP);
});

test('ttlFromFlag: absent means no caching', () => {
  assert.ok(!ttlFromFlag(undefined));
});

// ── unknownFlags ─────────────────────────────────────────────────────────────
test('unknownFlags: a typo is reported with the near miss', () => {
  const out = unknownFlags({ tabel: 'Contract' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].flag, 'tabel');
  assert.strictEqual(out[0].suggestion, 'table');
});

test('unknownFlags: known flags produce nothing', () => {
  assert.deepStrictEqual(unknownFlags({ table: 'x', schema: 'tenant1', yes: true, top: '5' }), []);
});

test('unknownFlags: something far from every known flag has no suggestion', () => {
  const out = unknownFlags({ zzzzzzzzzz: true });
  assert.strictEqual(out[0].suggestion, null);
});

test('unknownFlags: catches a missed --yes, which would silently skip a mutation', () => {
  assert.strictEqual(unknownFlags({ yess: true })[0].suggestion, 'yes');
});

test('editDistance: basic sanity', () => {
  assert.strictEqual(editDistance('table', 'table'), 0);
  assert.strictEqual(editDistance('tabel', 'table'), 2);
  assert.strictEqual(editDistance('', 'abc'), 3);
});

// ── the default that does not exist ──────────────────────────────────────────
test('DEFAULT_SCHEMA is still "sch" — changing it is a contract change', () => {
  // Deliberately pinned. A schema here is a TENANT, so no global default can be
  // right; DEV1 has tenant1/tenant2/tenant3/tenant8/tenant17 and no bare `sch` at all. The fix
  // is `dbq schemas <conn>` plus <CONN>_SCHEMA, not a different global guess.
  assert.strictEqual(DEFAULT_SCHEMA, 'sch');
});

// ── strict flags ─────────────────────────────────────────────────────────────
test('unknownFlags: catches a typo that would turn a mutation into a dry-run', () => {
  // --yess is not --yes, so the mutation would have previewed while the caller
  // believed it wrote. This is why the check fails instead of warning.
  const out = unknownFlags({ yess: true, table: 'Contract' });
  assert.deepStrictEqual(out.map((u) => u.flag), ['yess']);
  assert.strictEqual(out[0].suggestion, 'yes');
});

// ── discoverability ──────────────────────────────────────────────────────────
test('wantsHelp: --help and -h anywhere, and the help command, ask for usage', () => {
  assert.strictEqual(wantsHelp(['query', '--help']), true);
  assert.strictEqual(wantsHelp(['query', 'CONN', '-h']), true);
  assert.strictEqual(wantsHelp(['--help']), true);
  assert.strictEqual(wantsHelp(['help']), true);
});

test('wantsHelp: a normal command line does not', () => {
  assert.strictEqual(wantsHelp(['query', 'CONN', 'SELECT 1']), false);
  assert.strictEqual(wantsHelp([]), false);
});

test('unknownFlags: flags from other CLIs get the real spelling, still refused', () => {
  const out = unknownFlags({ json: true, conn: 'X', limit: '100' });
  assert.deepStrictEqual(out.map((u) => u.flag), ['json', 'conn', 'limit']);
  assert.match(out[0].hint, /--format json/);
  assert.match(out[1].hint, /first positional/);
  assert.match(out[2].hint, new RegExp(`--top N \\(default ${DEFAULT_TOP}, max ${MAX_TOP}\\)`));
});

test('unknownFlags: a plain typo has no hint, only the near miss', () => {
  const out = unknownFlags({ yess: true });
  assert.strictEqual(out[0].hint, null);
  assert.strictEqual(out[0].suggestion, 'yes');
});

test('FLAG_HINTS: no hint shadows a real flag', () => {
  for (const k of Object.keys(FLAG_HINTS)) assert.ok(!KNOWN_FLAGS.has(k), k);
});

test('unknownFlags: --no-strict-flags is itself a known flag', () => {
  assert.deepStrictEqual(unknownFlags({ 'no-strict-flags': true }), []);
});

test('unknownFlags: a dropped --where filter is caught too', () => {
  assert.strictEqual(unknownFlags({ wher: "Id=1" })[0].suggestion, 'where');
});

// ── query --stats ────────────────────────────────────────────────────────────
const { parseStatsMessages, timeoutFromFlag, parseInsertRows } = require('../index.js');

test('parseStatsMessages: sums reads per table and splits compile from execution time', () => {
  // Shape of the info messages SQL Server (Azure SQL) sends for SET STATISTICS IO, TIME ON.
  const s = parseStatsMessages([
    'SQL Server parse and compile time: \n   CPU time = 15 ms, elapsed time = 2514 ms.',
    "Table 'OrderLine'. Scan count 4, logical reads 174423, physical reads 0, page server reads 0, read-ahead reads 6263, page server read-ahead reads 0, lob logical reads 0.",
    "Table 'Product'. Scan count 2, logical reads 19, physical reads 0, page server reads 0, read-ahead reads 0, page server read-ahead reads 0, lob logical reads 0.",
    "Table 'Product'. Scan count 1, logical reads 1, physical reads 2, page server reads 0, read-ahead reads 0, page server read-ahead reads 0, lob logical reads 0.",
    '\n SQL Server Execution Times:\n   CPU time = 1406 ms,  elapsed time = 8541 ms.',
  ]);
  assert.strictEqual(s.tables[0].table, 'OrderLine');
  assert.strictEqual(s.tables[0].readAhead, 6263, 'read-ahead is not confused with "page server read-ahead"');
  assert.deepStrictEqual(s.tables[1], { table: 'Product', scans: 3, logical: 20, physical: 2, readAhead: 0 });
  assert.deepStrictEqual(s.total, { logical: 174443, physical: 2, readAhead: 6263 });
  assert.deepStrictEqual(s.exec, { cpuMs: 1406, elapsedMs: 8541 });
  assert.deepStrictEqual(s.compile, { cpuMs: 15, elapsedMs: 2514 });
});

test('parseStatsMessages: no messages gives zeros, not a crash', () => {
  const s = parseStatsMessages([]);
  assert.deepStrictEqual(s.total, { logical: 0, physical: 0, readAhead: 0 });
  assert.strictEqual(s.tables.length, 0);
});

test('parseStatsMessages: compile and execution time in ONE message go to their own sections', () => {
  const s = parseStatsMessages([
    'SQL Server parse and compile time: \n   CPU time = 3 ms, elapsed time = 7 ms.\n'
    + ' SQL Server Execution Times:\n   CPU time = 40 ms,  elapsed time = 90 ms.',
  ]);
  assert.deepStrictEqual(s.compile, { cpuMs: 3, elapsedMs: 7 });
  assert.deepStrictEqual(s.exec, { cpuMs: 40, elapsedMs: 90 });
});

test('timeoutFromFlag: seconds to ms; absent stays undefined', () => {
  assert.strictEqual(timeoutFromFlag('600'), 600000);
  assert.strictEqual(timeoutFromFlag('1.5'), 1500);
  assert.strictEqual(timeoutFromFlag(undefined), undefined);
});

test('timeoutFromFlag: a bare, zero, negative or non-numeric value is refused, not ignored', () => {
  for (const v of [true, '0', '-5', 'abc']) {
    assert.throws(() => timeoutFromFlag(v), /positive number/, String(v));
  }
});

// ── insert rows ──────────────────────────────────────────────────────────────
test('parseInsertRows: one object is one row', () => {
  const { values, rows } = parseInsertRows('{"Name":"a","Qty":1}');
  assert.deepStrictEqual(values, { Name: 'a', Qty: 1 });
  assert.deepStrictEqual(rows, [{ Name: 'a', Qty: 1 }]);
});

test('parseInsertRows: an array is every row, in order', () => {
  const { rows } = parseInsertRows('[{"Name":"a"},{"Name":"b"}]');
  assert.deepStrictEqual(rows.map(r => r.Name), ['a', 'b']);
});

test('parseInsertRows: refuses an empty array, a row that is not an object, and bad JSON', () => {
  assert.throws(() => parseInsertRows('[]'), /array is empty/);
  assert.throws(() => parseInsertRows('[{"Name":"a"}, 3]'), /row 2 must be a non-empty JSON object/);
  assert.throws(() => parseInsertRows('[{"Name":"a"}, {}]'), /row 2/);
  assert.throws(() => parseInsertRows('null'), /row 1/);
  assert.throws(() => parseInsertRows('{"Name":'), /not valid JSON/);
});

// ── query --file / count <table> ─────────────────────────────────────────────

const USAGE = 'query <conn> "SELECT ..." | --file <a.sql>';

test('sqlFromArgs: inline SQL passes through', () => {
  assert.strictEqual(sqlFromArgs('SELECT 1', undefined, USAGE), 'SELECT 1');
});

test('sqlFromArgs: --file is read as written', () => {
  const sql = 'SELECT v FROM (VALUES (1),(2)) t(v)';
  assert.strictEqual(sqlFromArgs(undefined, 'a.sql', USAGE, (f) => (f === 'a.sql' ? sql : '')), sql);
});

test('sqlFromArgs: inline and --file together are refused', () => {
  assert.throws(() => sqlFromArgs('SELECT 1', 'a.sql', USAGE, () => 'SELECT 2'), /not both/);
});

test('sqlFromArgs: neither inline nor --file names the usage', () => {
  assert.throws(() => sqlFromArgs(undefined, undefined, USAGE), /Provide the SQL: query/);
});

test('sqlFromArgs: --file without a path is refused, not read as "true"', () => {
  assert.throws(() => sqlFromArgs(undefined, true, USAGE), /--file needs a path/);
});

test('sqlFromArgs: an empty file is refused instead of sent', () => {
  assert.throws(() => sqlFromArgs(undefined, 'a.sql', USAGE, () => ' \t\n '), /--file is empty/);
});

test('sqlFromArgs: an unreadable file says which read failed', () => {
  assert.throws(() => sqlFromArgs(undefined, 'x.sql', USAGE, () => { throw new Error('ENOENT'); }), /Could not read --file: ENOENT/);
});

test('withPositionalTable: positional table becomes --table', () => {
  assert.deepStrictEqual(withPositionalTable({ where: 'Id > 1' }, 'KanbanCard'), { where: 'Id > 1', table: 'KanbanCard' });
});

test('withPositionalTable: without a positional the flags are untouched', () => {
  const flags = { table: 'KanbanCard' };
  assert.strictEqual(withPositionalTable(flags, undefined), flags);
});

test('withPositionalTable: the same table twice is fine', () => {
  assert.strictEqual(withPositionalTable({ table: 'KanbanCard' }, 'KanbanCard').table, 'KanbanCard');
});

test('withPositionalTable: two different tables are refused', () => {
  assert.throws(() => withPositionalTable({ table: 'KanbanPipe' }, 'KanbanCard'), /Conflicting table/);
});

// ── readOnlyProblem / execProblem — the read guard and procedure calls (2026-11-09) ──
const { readOnlyProblem, execProblem, execConnProblem, sqlCode } = require('../index.js');

test('readOnlyProblem: plain reads pass', () => {
  assert.strictEqual(readOnlyProblem('SELECT 1'), null);
  assert.strictEqual(readOnlyProblem('WITH c AS (SELECT 1 x) SELECT * FROM c'), null);
  assert.strictEqual(readOnlyProblem('exec sp_helptext [tenant1].[Proc]'), null);
  assert.strictEqual(readOnlyProblem("DECLARE @d date = '2026-01-01'; SELECT @d"), null);
});

test('readOnlyProblem: a WITH query no longer skips the mutation check', () => {
  assert.match(readOnlyProblem('WITH c AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM c)'), /mutation/);
});

test('readOnlyProblem: DECLARE does not let an EXEC through', () => {
  assert.match(readOnlyProblem('DECLARE @x int = 1; EXEC tenant1.WritesSomething @x'), /dbq exec/);
  assert.match(readOnlyProblem('DECLARE @s nvarchar(100) = N\'x\'; EXECUTE sp_executesql @s'), /dbq exec/);
});

test('readOnlyProblem: keywords inside literals, comments and [identifiers] are not mutations', () => {
  assert.strictEqual(readOnlyProblem("SELECT [Update], 'delete me' AS t FROM x -- drop later"), null);
  assert.strictEqual(readOnlyProblem('SELECT LastUpdateUTC FROM x /* insert */'), null);
});

test('readOnlyProblem: a keyword hidden after a comment is still seen', () => {
  assert.match(readOnlyProblem('SELECT 1 /* x */ ; DELETE FROM t'), /mutation/);
});

test('execProblem: one named procedure call passes', () => {
  assert.strictEqual(execProblem("EXEC tenant1.usp_Report '912', 0, 57410063, '1,2,3', NULL, 0, 0, 0"), null);
  assert.strictEqual(execProblem('execute [tenant1].[Proc] @a = 1;'), null);
  assert.strictEqual(execProblem("EXEC tenant1.P 'insert; delete'"), null); // inside a literal
});

test('execProblem: refuses anything that is not a single procedure call', () => {
  assert.match(execProblem('SELECT 1'), /one procedure call/);
  assert.match(execProblem('EXEC tenant1.P; DELETE FROM t'), /single procedure call|mutation/);
  assert.match(execProblem('EXEC tenant1.P; EXEC tenant1.Q'), /single procedure call/);
  assert.match(execProblem("EXEC('DELETE FROM t')"), /one procedure call|dynamic SQL/);
  assert.match(execProblem("EXEC sp_executesql N'DELETE FROM t'"), /dynamic SQL/);
});

test('execConnProblem: PROD with write rights is refused; reader user and nonprod pass', () => {
  assert.match(execConnProblem({ prod: true, readonly: false }), /PRODUCTION/);
  assert.strictEqual(execConnProblem({ prod: true, readonly: true }), null);
  assert.strictEqual(execConnProblem({ prod: false, readonly: false }), null);
});

test('sqlCode: blanks literals (with escaped quotes), comments and brackets', () => {
  assert.strictEqual(sqlCode("SELECT 'it''s update' -- delete\n FROM [Drop]").replace(/\s+/g, ' ').trim(), "select '' from []");
});
