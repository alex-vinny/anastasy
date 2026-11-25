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

test('readOnlyProblem: a WITH query does not skip the mutation check', () => {
  assert.match(readOnlyProblem('WITH c AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM c)'), /DELETE/);
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
  assert.match(readOnlyProblem('SELECT 1 /* x */ ; DELETE FROM t'), /DELETE/);
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

// ── query read-only guard: token analysis of the whole batch ─────────────────
const {
  stripSqlNoise, analyzeReadOnlySql, nonProdWriteRefusal, splitDdlBatches, execJsonDocument,
} = require('../index.js');

const MUST_PASS = [
  'SELECT 1 AS ok',
  'select top 5 * from tenant1.Lead with (nolock) where Id > 10 order by Id',
  ';WITH c AS (SELECT 1 AS a) SELECT a FROM c',
  'WITH c AS (SELECT Id FROM tenant1.Lead) SELECT COUNT(*) FROM c OPTION (RECOMPILE)',
  '(SELECT 1) UNION ALL (SELECT 2)',
  'DECLARE @f bigint = 1; SELECT @f',
  "DECLARE @f bigint = 1, @d datetime = '2026-10-26'; SET @f = @f + 1; SELECT @f, @d",
  'DECLARE @n int; SELECT @n = COUNT(*) FROM tenant1.Lead; SELECT @n',
  "exec sp_help 'tenant1.Lead'",
  "EXEC sys.sp_helptext N'tenant1.usp_X';",
  "execute sp_columns @table_name = 'Lead', @table_owner = 'tenant1'",
  "EXEC sp_describe_first_result_set @tsql = N'DELETE FROM tenant1.Lead; EXEC tenant1.x'",
  "EXEC sp_spaceused 'tenant1.Lead'",
  // forbidden words where they are NOT code
  "SELECT 'update, delete; EXEC tenant1.x; drop table t' AS txt",
  "SELECT N'it''s an insert' AS txt",
  'SELECT 1 -- update everything\n, 2',
  'SELECT /* delete /* nested exec */ still comment */ 1',
  'SELECT [Delete], [Update], [exec] FROM tenant1.Weird',
  'SELECT "Insert" FROM tenant1.Weird',
  'SELECT @@ROWCOUNT, 0x1F, 1.5e3, .5',
  "SELECT * FROM OPENJSON(@j) WITH (Id int '$.id')",
  'SELECT x FROM t ORDER BY x OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY',
];

const MUST_FAIL = {
  'DECLARE then EXEC': ['DECLARE @x int = 1; EXEC tenant1.any_proc', /EXEC\/EXECUTE/],
  'a harness call with named arguments': ["DECLARE @f bigint = 1; EXEC tenant1.usp_Harness @Proc='usp_Target', @FilterId=@f", /EXEC\/EXECUTE/],
  'WITH ... DELETE': ['WITH c AS (SELECT 1 a) DELETE FROM t', /DELETE/],
  'WITH ... UPDATE': ['WITH c AS (SELECT Id FROM t) UPDATE c SET Id = 1', /UPDATE/],
  'sp_help then ;EXEC': ["exec sp_help 'x'; EXEC other_proc", /EXEC\/EXECUTE/],
  'sp_help then a statement': ["exec sp_help 'x' SELECT 1", /whole batch/],
  'SELECT INTO': ['SELECT * INTO new_table FROM tenant1.Lead', /INTO/],
  'SELECT INTO #temp': ['SELECT Id INTO #t FROM tenant1.Lead', /INTO/],
  'sp_executesql': ["EXEC sp_executesql N'SELECT 1'", /SP_EXECUTESQL/],
  'sp_executesql after SELECT': ["SELECT 1; sp_executesql N'x'", /SP_EXECUTESQL/],
  'BEGIN TRAN': ['BEGIN TRAN; SELECT 1; ROLLBACK', /BEGIN/],
  'COMMIT': ['SELECT 1; COMMIT', /COMMIT/],
  'WAITFOR': ["DECLARE @h int = 0; WAITFOR DELAY '00:00:03'; SELECT 1", /WAITFOR/],
  'INSERT after SELECT': ['SELECT 1; INSERT INTO t VALUES (1)', /INSERT/],
  'MERGE': ['WITH s AS (SELECT 1 a) MERGE t USING s ON 1=0 WHEN NOT MATCHED THEN INSERT VALUES (1);', /MERGE/],
  'DROP / TRUNCATE / ALTER / CREATE': ['SELECT 1; DROP TABLE t; TRUNCATE TABLE u; ALTER TABLE v ADD c int; CREATE TABLE w (a int)', /DROP[\s\S]*TRUNCATE[\s\S]*ALTER[\s\S]*CREATE/],
  'GRANT': ['SELECT 1; GRANT SELECT ON t TO u', /GRANT/],
  'DBCC': ['SELECT 1; DBCC CHECKIDENT', /DBCC/],
  'KILL': ['SELECT 1; KILL 52', /KILL/],
  'SHUTDOWN': ['SELECT 1 SHUTDOWN', /SHUTDOWN/],
  'BACKUP': ["SELECT 1; BACKUP DATABASE d TO DISK='x'", /BACKUP/],
  'OPENROWSET BULK': ["SELECT * FROM OPENROWSET(BULK 'c:/x', SINGLE_CLOB) a", /BULK|OPENROWSET/],
  'OPENQUERY': ["SELECT * FROM OPENQUERY(srv, 'DELETE x')", /OPENQUERY/],
  'xp_cmdshell': ["SELECT 1; EXEC xp_cmdshell 'dir'", /xp_cmdshell/],
  'EXEC of a string': ["EXEC('DELETE FROM t')", /EXEC\/EXECUTE/],
  'a procedure with no EXEC as first statement': ['tenant1.usp_Purge @Id = 1', /must start with SELECT/],
  'table variable': ['DECLARE @t TABLE (Id int); SELECT * FROM @t', /table variables/],
  'table variable in a list': ['DECLARE @a int, @t AS TABLE (Id int); SELECT 1', /table variables/],
  'cursor': ['DECLARE c CURSOR FOR SELECT 1', /DECLARE: only scalar|CURSOR/],
  'SET option': ['SET NOCOUNT ON; SELECT 1', /SET: only SET @variable/],
  'user proc named like sp_help': ["EXEC dbo.sp_help_purge 'x'", /EXEC\/EXECUTE/],
  'sp_spaceused @updateusage': ["EXEC sp_spaceused 'tenant1.Lead', @updateusage = 'true'", /updateusage/],
  'keyword after an empty comment still counts': ['SELECT 1;/**/DELETE FROM t', /DELETE/],
  'keyword glued to a string': ["SELECT ''DELETE FROM t", /DELETE/],
  'number glued to a keyword': ['SELECT 1eDELETE FROM t', /glued|DELETE/],
  'unterminated string': ["SELECT 'abc", /unterminated string/],
  'unterminated comment': ['SELECT 1 /* DELETE FROM t', /unterminated \/\* comment/],
  'NEXT VALUE FOR': ['SELECT NEXT VALUE FOR tenant1.Seq', /sequence/],
  'IF block': ['IF 1=1 SELECT 1', /must start|IF/],
  'empty': ['   ', /empty/],
};

for (const sqlText of MUST_PASS) {
  test(`query guard accepts: ${sqlText.replace(/\s+/g, ' ').slice(0, 70)}`, () => {
    const r = analyzeReadOnlySql(sqlText);
    assert.deepStrictEqual(r.problems, [], sqlText);
    assert.strictEqual(r.ok, true);
  });
}

for (const [name, [sqlText, why]] of Object.entries(MUST_FAIL)) {
  test(`query guard refuses: ${name}`, () => {
    const r = analyzeReadOnlySql(sqlText);
    assert.strictEqual(r.ok, false, sqlText);
    assert.match(r.problems.join('\n'), why);
  });
}

test('stripSqlNoise: comments become a space, literals and identifiers become placeholders', () => {
  assert.strictEqual(stripSqlNoise("SELECT 'a''b' -- x\n, [c]]d], \"e\" /* f */ FROM t"), "SELECT ''  \n, [], []   FROM t");
});

test('readOnlyProblem: names every problem and points at the right commands', () => {
  const msg = readOnlyProblem('DECLARE @x int = 1; EXEC tenant1.p; DELETE FROM t');
  assert.match(msg, /EXEC\/EXECUTE/);
  assert.match(msg, /DELETE/);
  assert.match(msg, /insert\/update\/delete/);
  assert.match(msg, /dbq exec <conn>/);
});

// ── ddl connection rule, exec json output ────────────────────────────────────
test('nonProdWriteRefusal: prod is refused with no override, read-only too, dev passes', () => {
  assert.match(nonProdWriteRefusal({ prod: true, readonly: true, user: 'r' }, 'PRD', 'DDL'), /PRODUCTION.*no override.*migrations pipeline/);
  assert.match(nonProdWriteRefusal({ prod: true, readonly: false, user: 'w' }, 'P', 'DDL'), /PRODUCTION/);
  assert.match(nonProdWriteRefusal({ prod: false, readonly: true, user: 'app_reader' }, 'R', 'DDL'), /read-only/);
  assert.match(nonProdWriteRefusal(undefined, 'NOPE', 'DDL'), /does not exist/);
  assert.strictEqual(nonProdWriteRefusal({ prod: false, readonly: false }, 'DEV', 'DDL'), null);
});

test('splitDdlBatches: splits on GO lines only', () => {
  assert.deepStrictEqual(splitDdlBatches('EXEC a\nGO\nSELECT 1 AS go_on\ngo;\nSELECT 2'), ['EXEC a', 'SELECT 1 AS go_on', 'SELECT 2']);
});

test('execJsonDocument: one array per result set, --top per set, truncation reported', () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ Id: i, Empty: null }));
  const doc = execJsonDocument([rows, [], [{ Q: 'x' }]], [0, 3], { top: '2' });
  assert.deepStrictEqual(doc.resultSets, [[{ Id: 0 }, { Id: 1 }], [], [{ Q: 'x' }]]);
  assert.deepStrictEqual(doc.rowsAffected, [0, 3]);
  assert.deepStrictEqual(doc.truncated, [{ resultSet: 1, shown: 2, total: 3 }]);
  assert.ok(!('truncated' in execJsonDocument([[{ a: 1 }]], [], {})));
});

test('execJsonDocument uncapped (exec --out): every row, nulls kept, no truncation', () => {
  const rows = Array.from({ length: 700 }, (_, i) => ({ Id: i, Empty: null }));
  const doc = execJsonDocument([rows], [700], { top: '2', full: true }, { uncapped: true });
  assert.strictEqual(doc.resultSets[0].length, 700);
  assert.deepStrictEqual(doc.resultSets[0][0], { Id: 0, Empty: null });
  assert.ok(!('truncated' in doc));
});

test('exec: every flag it reads is a known flag', () => {
  for (const f of ['file', 'format', 'timeout', 'stats', 'top', 'full', 'out']) assert.ok(KNOWN_FLAGS.has(f), f);
});

// The CLI itself, against fake connections in a temp .env (DBQ_ENV_FILE). Every case below
// must stop BEFORE connecting — the servers do not exist, so a connection attempt would fail
// with a network error instead of the message asserted.
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function runCli(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbq-test-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, [
    'FAKEPRD=Data Source=fake-prd.invalid;Initial Catalog=appprd;User Id=app_reader;Password=x',
    'FAKEPRDW=Data Source=fake.invalid;Initial Catalog=d;User Id=w;Password=x',
    'FAKEPRDW_PROD=true',
    'FAKEPRDW_READONLY=false',
    'FAKEDEV=Data Source=fake-dev.invalid;Initial Catalog=appdev;User Id=w;Password=x',
  ].join('\n'));
  // A temporary dbq.sqlite and state folder: the journal expires by itself now (3 days by default), and a
  // test run must never open, let alone prune, the real one. The runner's retention setting stays out.
  const env = { ...process.env, DBQ_ENV_FILE: envFile, DBQ_DB_FILE: path.join(dir, 'dbq.sqlite'), DBQ_STATE_DIR: path.join(dir, 'estado') };
  delete env.DBQ_JOURNAL_DAYS;
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js'), ...args],
      { env, encoding: 'utf8', timeout: 30000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI exec: a production connection with write rights is refused before connecting', () => {
  const r = runCli(['exec', 'FAKEPRDW', 'EXEC tenant1.usp_X @a = 1']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /PRODUCTION with write rights/);
  assert.doesNotMatch(r.err, /fake\.invalid|ENOTFOUND|getaddrinfo/);
});

test('CLI exec: --out without a path is refused before connecting', () => {
  const r = runCli(['exec', 'FAKEDEV', 'EXEC tenant1.usp_X @a = 1', '--out']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /--out needs a file path/);
});

test('CLI query: DECLARE + EXEC is refused before connecting', () => {
  const r = runCli(['query', 'FAKEDEV', 'DECLARE @f bigint = 1; EXEC tenant1.usp_Y @F = @f']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /'query' is read-only/);
  assert.doesNotMatch(r.err, /fake-dev\.invalid|ENOTFOUND|getaddrinfo/);
});

// ── migrateLegacyDb: dbq.sqlite sai da pasta da ferramenta para a pasta de estado ─────────────
// Pasta temporária e arquivo fictício: nenhum dbq.sqlite real é aberto.
{
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { migrateLegacyDb, resolveStateDir, moveFile } = require('../index.js');
  const ctx = require('../lib/context.js');

  const pastas = (t) => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'dbq-migra-'));
    t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
    const legado = path.join(raiz, 'ferramenta');
    fs.mkdirSync(legado);
    return { legado, estado: path.join(raiz, 'estado', 'dbq') };
  };

  test('migrateLegacyDb: move dbq.sqlite e o rollback journal, uma vez', (t) => {
    const { legado, estado } = pastas(t);
    fs.writeFileSync(path.join(legado, 'dbq.sqlite'), 'ficticio');
    fs.writeFileSync(path.join(legado, 'dbq.sqlite-journal'), 'ficticio-j');
    assert.strictEqual(migrateLegacyDb(legado, estado), path.join(estado, 'dbq.sqlite'));
    assert.strictEqual(fs.readFileSync(path.join(estado, 'dbq.sqlite'), 'utf8'), 'ficticio');
    assert.ok(fs.existsSync(path.join(estado, 'dbq.sqlite-journal')));
    assert.deepStrictEqual(fs.readdirSync(legado), []);
    assert.strictEqual(migrateLegacyDb(legado, estado), path.join(estado, 'dbq.sqlite'));
  });

  test('migrateLegacyDb: sem banco antigo, usa a pasta de estado sem criar nada', (t) => {
    const { legado, estado } = pastas(t);
    assert.strictEqual(migrateLegacyDb(legado, estado), path.join(estado, 'dbq.sqlite'));
    assert.ok(!fs.existsSync(estado));
  });

  test('migrateLegacyDb: em conflito vale o novo e o antigo fica intacto', (t) => {
    const { legado, estado } = pastas(t);
    fs.mkdirSync(estado, { recursive: true });
    fs.writeFileSync(path.join(estado, 'dbq.sqlite'), 'novo');
    fs.writeFileSync(path.join(legado, 'dbq.sqlite'), 'antigo');
    assert.strictEqual(migrateLegacyDb(legado, estado), path.join(estado, 'dbq.sqlite'));
    assert.strictEqual(fs.readFileSync(path.join(estado, 'dbq.sqlite'), 'utf8'), 'novo');
    assert.strictEqual(fs.readFileSync(path.join(legado, 'dbq.sqlite'), 'utf8'), 'antigo');
  });

  test('migrateLegacyDb: pasta de estado igual a da ferramenta nao move nada', (t) => {
    const { legado } = pastas(t);
    fs.writeFileSync(path.join(legado, 'dbq.sqlite'), 'x');
    assert.strictEqual(migrateLegacyDb(legado, legado), path.join(legado, 'dbq.sqlite'));
    assert.deepStrictEqual(fs.readdirSync(legado), ['dbq.sqlite']);
  });

  test('moveFile: nunca sobrescreve e diz quando nao havia o que mover', (t) => {
    const { legado, estado } = pastas(t);
    assert.strictEqual(moveFile(path.join(legado, 'nada'), path.join(estado, 'nada')), 'absent');
    fs.writeFileSync(path.join(legado, 'a'), '1');
    fs.mkdirSync(estado, { recursive: true });
    fs.writeFileSync(path.join(estado, 'a'), '2');
    assert.strictEqual(moveFile(path.join(legado, 'a'), path.join(estado, 'a')), 'conflict');
    assert.strictEqual(fs.readFileSync(path.join(estado, 'a'), 'utf8'), '2');
  });

  // Onde mora o dbq.sqlite: ambiente > linha do .env > pasta de estado do hospedeiro > pasta da ferramenta.
  const semHost = () => null;
  const hostEm = (pasta) => () => ({ pastaDeEstado: (nome) => path.join(pasta, nome) });
  const RAIZ = path.resolve(__dirname, '..');

  test('resolveStateDir: DBQ_STATE_DIR do ambiente vence o .env e o hospedeiro', () => {
    const r = resolveStateDir({ env: { DBQ_STATE_DIR: '/tmp/a' }, envText: 'DBQ_STATE_DIR=/tmp/b', host: hostEm('/tmp/h') });
    assert.strictEqual(r, path.resolve('/tmp/a'));
  });

  test('resolveStateDir: linha do .env vale sem a variavel; ~ vira a home', () => {
    const r = resolveStateDir({ env: {}, envText: 'X=1\nDBQ_STATE_DIR="~/estado-dbq"', host: hostEm('/tmp/h'), home: '/home/dev' });
    assert.strictEqual(r, path.resolve('/home/dev/estado-dbq'));
  });

  test('resolveStateDir: sem configuracao, a pasta de estado do hospedeiro; sem hospedeiro, a da ferramenta', () => {
    assert.strictEqual(resolveStateDir({ env: {}, envText: '', host: hostEm('/tmp/h') }), path.join('/tmp/h', 'dbq'));
    assert.strictEqual(resolveStateDir({ env: {}, envText: '', host: semHost }), RAIZ);
  });

  test('resolveStateDir: caminho relativo e a partir da pasta da ferramenta', () => {
    assert.strictEqual(resolveStateDir({ env: { DBQ_STATE_DIR: 'dados' }, envText: '', host: semHost }), path.join(RAIZ, 'dados'));
  });

  test('settingFromEnv: o ambiente vence, a ultima linha do .env vale e as aspas saem', () => {
    assert.strictEqual(ctx.settingFromEnv('K', 'amb', 'K=arq'), 'amb');
    assert.strictEqual(ctx.settingFromEnv('K', undefined, "K=1\nK='2'"), '2');
    assert.strictEqual(ctx.settingFromEnv('K', undefined, 'OUTRO=1'), undefined);
  });
}
