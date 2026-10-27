'use strict';

// Unit tests for dbq's pure helpers. No database, no network, no journal.
// Run: npm test   (or: node --test)

const { test } = require('node:test');
const assert = require('node:assert');

const {
  parseArgs, unknownFlags, editDistance,
  qual, splitTarget, schemaFromEnvText,
  parseConnString, parseEnv, clampTop, ttlFromFlag,
  DEFAULT_SCHEMA, DEFAULT_TOP, MAX_TOP,
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
  const p = parseConnString('Data Source=srv.database.windows.net;Initial Catalog=appdb;User Id=reader;Password=s3cr3t');
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
  const conns = parseEnv('P=Data Source=s-prd;Initial Catalog=appprd;User Id=u;Password=p');
  assert.strictEqual(conns.P.prod, true);
  // prod implies read-only unless explicitly overridden — the safe default.
  assert.strictEqual(conns.P.readonly, true);
});

test('parseEnv: an explicit _READONLY=false overrides the inference', () => {
  const conns = parseEnv('W=Data Source=s;Initial Catalog=d;User Id=u;Password=p\nW_READONLY=false\nW_PROD=false');
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

// ── query read-only guard ────────────────────────────────────────────────────
const {
  stripSqlNoise, analyzeReadOnlySql, readOnlyRefusal,
  nonProdWriteRefusal, splitDdlBatches, execJsonDocument, KNOWN_FLAGS,
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
  'DECLARE then EXEC': ['DECLARE @x int = 1; EXEC tenant1.qualquer_proc', /EXEC\/EXECUTE/],
  'a harness call with named arguments': ["DECLARE @f bigint = 1; EXEC tenant1.usp_Harness_GenRunRollback @Proc='usp_Target', @ClientFilterId=@f", /EXEC\/EXECUTE/],
  'WITH ... DELETE': ['WITH c AS (SELECT 1 a) DELETE FROM t', /DELETE/],
  'WITH ... UPDATE': ['WITH c AS (SELECT Id FROM t) UPDATE c SET Id = 1', /UPDATE/],
  'sp_help then ;EXEC': ["exec sp_help 'x'; EXEC outra_proc", /EXEC\/EXECUTE/],
  'sp_help then a statement': ["exec sp_help 'x' SELECT 1", /whole batch/],
  'SELECT INTO': ['SELECT * INTO nova_tabela FROM tenant1.Lead', /INTO/],
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

test('readOnlyRefusal: names every problem and points at the write commands', () => {
  const msg = readOnlyRefusal('DECLARE @x int = 1; EXEC tenant1.p; DELETE FROM t');
  assert.match(msg, /EXEC\/EXECUTE/);
  assert.match(msg, /DELETE/);
  assert.match(msg, /insert\/update\/delete/);
  assert.match(msg, /exec <conn>/);
  assert.strictEqual(readOnlyRefusal('SELECT 1'), null);
});

// ── exec ─────────────────────────────────────────────────────────────────────
test('nonProdWriteRefusal: prod is refused with no override, read-only too, dev passes', () => {
  assert.match(nonProdWriteRefusal({ prod: true, readonly: true, user: 'r' }, 'ELPRD', 'exec'), /PRODUCTION.*no override/);
  assert.match(nonProdWriteRefusal({ prod: true, readonly: false, user: 'w' }, 'P', 'exec'), /PRODUCTION/);
  assert.match(nonProdWriteRefusal({ prod: false, readonly: true, user: 'app_reader' }, 'R', 'exec'), /read-only/);
  assert.match(nonProdWriteRefusal({ prod: true }, 'P', 'DDL'), /migrations pipeline/);
  assert.strictEqual(nonProdWriteRefusal({ prod: false, readonly: false }, 'DEV1', 'exec'), null);
});

test('splitDdlBatches: exec splits on GO lines only', () => {
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

test('exec: every flag it reads is a known flag', () => {
  for (const f of ['yes', 'file', 'format', 'timeout', 'stats', 'top', 'full', 'out']) assert.ok(KNOWN_FLAGS.has(f), f);
});

test('execJsonDocument uncapped (exec --out): every row, nulls kept, no truncation', () => {
  const rows = Array.from({ length: 700 }, (_, i) => ({ Id: i, Empty: null }));
  const doc = execJsonDocument([rows], [700], { top: '2', full: true }, { uncapped: true });
  assert.strictEqual(doc.resultSets[0].length, 700);
  assert.deepStrictEqual(doc.resultSets[0][0], { Id: 0, Empty: null });
  assert.ok(!('truncated' in doc));
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
    'FAKEPRD=Data Source=fake-prd.invalid;Initial Catalog=appprd;User Id=claude_reader;Password=x',
    'FAKEPRDW=Data Source=fake.invalid;Initial Catalog=d;User Id=w;Password=x',
    'FAKEPRDW_PROD=true',
    'FAKEPRDW_READONLY=false',
    'FAKEDEV=Data Source=fake-dev.invalid;Initial Catalog=appdev;User Id=w;Password=x',
  ].join('\n'));
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js'), ...args],
      { env: { ...process.env, DBQ_ENV_FILE: envFile }, encoding: 'utf8', timeout: 30000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI exec: a production connection is refused, even with --yes', () => {
  for (const conn of ['FAKEPRD', 'FAKEPRDW']) {
    const r = runCli(['exec', conn, 'SELECT 1', '--yes']);
    assert.strictEqual(r.code, 1, conn);
    assert.match(r.err, /PRODUCTION\. exec is blocked in prod \(no override\)/, conn);
  }
});

test('CLI exec: without --yes it is a dry-run that prints the batches and connects to nothing', () => {
  const r = runCli(['exec', 'FAKEDEV', 'EXEC tenant1.usp_X @a = 1\nGO\nSELECT 2']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /\[DRY-RUN\]/);
  assert.match(r.out, /batches: 2/);
  assert.match(r.out, /--- batch 1 ---\nEXEC tenant1\.usp_X @a = 1/);
  assert.match(r.out, /NOT revertible/);
});

test('CLI exec: an unknown --format is refused before anything runs', () => {
  const r = runCli(['exec', 'FAKEDEV', 'SELECT 1', '--format', 'tsv']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /--format must be one of: table, json/);
});

test('CLI query: DECLARE + EXEC is refused before connecting', () => {
  const r = runCli(['query', 'FAKEDEV', 'DECLARE @f bigint = 1; EXEC tenant1.usp_Y @F = @f']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /'query' is read-only/);
  assert.doesNotMatch(r.err, /fake-dev\.invalid|ENOTFOUND|getaddrinfo/);
});
