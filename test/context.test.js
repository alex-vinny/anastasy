'use strict';

// Tests for lib/context.js (catalog, read history, joins, prune) and the CLI commands built on it.
// The storage tests run against an in-memory SQLite; the CLI tests against a temp dbq.sqlite
// (DBQ_DB_FILE) and fake connections (DBQ_ENV_FILE). No SQL Server is contacted.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning'); // node:sqlite is experimental; its warning is noise here
const { DatabaseSync } = require('node:sqlite');
const c = require('../lib/context.js');
const { KNOWN_FLAGS } = require('../index.js');

const names = (refs) => refs.map(r => `${r.schema ? r.schema + '.' : ''}${r.table}${r.alias ? ' ' + r.alias : ''}${r.kind === 'proc' ? ' (proc)' : ''}`);
const tablesIn = (sqlText) => names(c.tablesOf(c.scanSql(sqlText)));
const joinsIn = (sqlText) => {
  const tokens = c.scanSql(sqlText);
  return c.joinEdges(tokens, c.tablesOf(tokens)).map(e => `${e.a.table}.${e.a.col}=${e.b.table}.${e.b.col}`);
};

// ── tokenizer / fingerprint ──────────────────────────────────────────────────
test('scanSql: comments go, literals become ?, bracketed names keep their text', () => {
  const t = c.scanSql("SELECT [Order Id], N'x''y' /* a /* nested */ b */ FROM t -- tail\nWHERE v = 1.5e3");
  assert.deepStrictEqual(t.map(x => x.k === 'ident' ? `[${x.v}]` : x.v),
    ['SELECT', '[Order Id]', ',', '?', 'FROM', 't', 'WHERE', 'v', '=', '?']);
});

test('scanSql: an unterminated literal or comment never throws (it runs to the end)', () => {
  assert.doesNotThrow(() => c.scanSql("SELECT 'open"));
  assert.doesNotThrow(() => c.scanSql('SELECT 1 /* open'));
  assert.doesNotThrow(() => c.scanSql('SELECT [open'));
});

test('fingerprint: the same query with other literals is the same fingerprint', () => {
  const a = c.fingerprint("select * from tenant1.Client where Name = 'Ana' and Id in (1,2,3)", 'DEV');
  const b = c.fingerprint("SELECT *   FROM tenant1.Client WHERE Name = N'Bia' AND Id IN (9)", 'DEV');
  assert.strictEqual(a.fp, 'SELECT * FROM tenant1.Client WHERE Name = ? AND Id IN (?)');
  assert.strictEqual(a.hash, b.hash);
  assert.strictEqual(a.hasLiterals, true);
});

test('fingerprint: carries no literal, and the connection is part of the hash', () => {
  const f = c.fingerprint("SELECT 1 FROM t WHERE Doc = '123.456.789-00' AND Phone = 5511999999999", 'DEV');
  assert.doesNotMatch(f.fp, /123|5511|789/);
  assert.notStrictEqual(f.hash, c.fingerprint("SELECT 1 FROM t WHERE Doc = '1' AND Phone = 2", 'HML').hash);
  assert.strictEqual(c.fingerprint('SELECT a FROM t').hasLiterals, false);
});

test('fingerprint: a VALUES list of any length is one shape', () => {
  assert.strictEqual(c.fingerprint('insert into T (a,b) values (1,2),(3,4),(5,6)').fp, 'INSERT INTO T(a, b) VALUES (?)');
});

// ── tables / joins ───────────────────────────────────────────────────────────
test('tablesOf: FROM, JOIN, aliases, comma joins, bracketed and three-part names', () => {
  assert.deepStrictEqual(
    tablesIn('SELECT * FROM [tenant1].[Order] o WITH (NOLOCK), tenant1.Item AS i JOIN db.tenant1.Client c ON c.Id = o.ClientId'),
    ['tenant1.Order o', 'tenant1.Item i', 'tenant1.Client c']);
});

test('tablesOf: a comma after JOIN ... ON still starts another table; one in a column list does not', () => {
  assert.deepStrictEqual(tablesIn('SELECT a.x, b.y FROM A a JOIN B b ON b.AId = a.Id, C cc WHERE cc.AId = a.Id'), ['A a', 'B b', 'C cc']);
  assert.deepStrictEqual(tablesIn('SELECT a, b FROM T WHERE x IN (SELECT y FROM U)'), ['T', 'U']);
});

test('tablesOf: CTEs, temp tables, table variables and table-valued functions are left out', () => {
  assert.deepStrictEqual(tablesIn('WITH x AS (SELECT Id FROM s.T), y (a) AS (SELECT 1) SELECT * FROM x JOIN y ON 1=1 JOIN #tmp t ON 1=1'), ['s.T']);
  assert.deepStrictEqual(tablesIn('SELECT * FROM dbo.fn_List(1) f JOIN s.T t ON t.Id = f.Id'), ['s.T t']);
  assert.deepStrictEqual(tablesIn('SELECT * FROM @rows r'), []);
});

test('tablesOf: procedures, EXEC @rc = proc, and the alias target of UPDATE ... FROM', () => {
  assert.deepStrictEqual(tablesIn('EXEC @rc = tenant1.usp_Report @Id = 7'), ['tenant1.usp_Report (proc)']);
  assert.deepStrictEqual(tablesIn('UPDATE t SET a = 1 FROM s.T t JOIN s.U u ON u.TId = t.Id'), ['s.T t', 's.U u']);
});

test('joinEdges: aliases resolve to tables, the order is canonical, same-table and unknown sides are dropped', () => {
  assert.deepStrictEqual(joinsIn('SELECT 1 FROM s.[Order] o JOIN s.Item i ON i.OrderId = o.Id'), ['Item.OrderId=Order.Id']);
  assert.deepStrictEqual(joinsIn('SELECT 1 FROM s.Item i JOIN s.[Order] o ON o.Id = i.OrderId AND o.Rows = i.Rows'), ['Item.OrderId=Order.Id', 'Item.Rows=Order.Rows']);
  assert.deepStrictEqual(joinsIn('SELECT 1 FROM s.T a JOIN s.T b ON a.ParentId = b.Id'), []);
  assert.deepStrictEqual(joinsIn('SELECT 1 FROM s.T a JOIN dbo.fn(1) f ON f.Id = a.Id'), []);
  assert.deepStrictEqual(joinsIn('SELECT 1 FROM s.A, s.B WHERE A.Id = B.AId AND A.Kind = 1'), ['A.Id=B.AId']);
});

// ── small helpers ────────────────────────────────────────────────────────────
test('parseAgeDays: days only; a typo throws instead of pruning everything', () => {
  assert.strictEqual(c.parseAgeDays(undefined), 30);
  assert.strictEqual(c.parseAgeDays('7d'), 7);
  assert.strictEqual(c.parseAgeDays('14'), 14);
  for (const bad of ['3x', '0d', '-1', 'all', '']) assert.throws(() => c.parseAgeDays(bad), /takes days/);
});

test('sanitizeError: values are masked, object names stay', () => {
  assert.strictEqual(c.sanitizeError("Invalid column name 'Foo'."), "Invalid column name 'Foo'.");
  assert.strictEqual(c.sanitizeError("Conversion failed when converting the nvarchar value 'Ana Lima' to data type int."),
    "Conversion failed when converting the nvarchar value '?' to data type int.");
  assert.strictEqual(
    c.sanitizeError("Violation of UNIQUE KEY constraint 'UQ_X'. Cannot insert duplicate key in object 's.T'. The duplicate key value is (123)."),
    "Violation of UNIQUE KEY constraint 'UQ_X'. Cannot insert duplicate key in object 's.T'. The duplicate key value is (?).");
  assert.strictEqual(c.sanitizeError("Login failed for user 'someone'."), "Login failed for user '?'.");
});

test('gitBranch: a clone, a worktree (.git file), a detached HEAD, and no repo at all', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbq-git-'));
  try {
    const clone = path.join(root, 'clone');
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
    fs.mkdirSync(path.join(clone, 'sub', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(clone, '.git', 'HEAD'), 'ref: refs/heads/users/me/topic\n');
    assert.strictEqual(c.gitBranch(path.join(clone, 'sub', 'deeper')), 'users/me/topic');

    const wtGit = path.join(root, 'meta', 'worktrees', 'wt');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'HEAD'), '0123456789abcdef\n');
    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
    assert.strictEqual(c.gitBranch(wt), '01234567');

    assert.strictEqual(c.taskLabel({ DBQ_TASK: 'wi-1' }, clone), 'wi-1');
    assert.strictEqual(c.taskLabel({}, clone), 'users/me/topic');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('typeLabel and groupAcrossSchemas', () => {
  assert.strictEqual(c.typeLabel('nvarchar', 50), 'nvarchar(50)');
  assert.strictEqual(c.typeLabel('varbinary', -1), 'varbinary(max)');
  assert.strictEqual(c.typeLabel('int', null), 'int');
  const g = c.groupAcrossSchemas([{ schema: 'a', t: 'X', n: 1 }, { schema: 'b', t: 'x', n: 2 }, { schema: 'a', t: 'Y', n: 3 }], r => r.t.toLowerCase(), 'b');
  assert.deepStrictEqual(g.map(x => [x.first.t, x.schemas, x.preferred.n]), [['X', ['a', 'b'], 2], ['Y', ['a'], 3]]);
});

// ── storage (in-memory SQLite) ───────────────────────────────────────────────
function memoryDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE journal (seq INTEGER PRIMARY KEY, ts TEXT, connection TEXT DEFAULT 'DEV', "table" TEXT, op TEXT, reverted INTEGER DEFAULT 0);
          CREATE TABLE result_cache (hash TEXT PRIMARY KEY, fetched_at TEXT, ttl_sec INTEGER);`);
  c.initContextSchema(d);
  return d;
}

const CATALOG = {
  tables: [
    { sch: 'tenant1', tbl: 'Order', rows_est: 10, descr: 'One order per sale' },
    { sch: 'tenant2', tbl: 'Order', rows_est: 20, descr: null },
    { sch: 'tenant1', tbl: 'OrderItem', rows_est: 30, descr: null },
  ],
  columns: [
    { sch: 'tenant1', tbl: 'Order', col: 'Id', ord: 1, type: 'bigint', maxlen: null, nullable: false, ident: true, pk: true },
    { sch: 'tenant1', tbl: 'Order', col: 'Code', ord: 2, type: 'nvarchar', maxlen: 20, nullable: true, ident: false, pk: false, descr: 'Shown to the customer' },
    { sch: 'tenant2', tbl: 'Order', col: 'Id', ord: 1, type: 'bigint', maxlen: null, nullable: false, ident: true, pk: true },
    { sch: 'tenant1', tbl: 'OrderItem', col: 'Id', ord: 1, type: 'bigint', maxlen: null, nullable: false, ident: true, pk: true },
    { sch: 'tenant1', tbl: 'OrderItem', col: 'OrderId', ord: 2, type: 'bigint', maxlen: null, nullable: false, ident: false, pk: false },
  ],
  fks: [{ sch: 'tenant1', tbl: 'OrderItem', col: 'OrderId', ref_sch: 'tenant1', ref_tbl: 'Order', ref_col: 'Id' }],
};

test('recordRead: one row per fingerprint; runs, failures and the masked error are kept', () => {
  const d = memoryDb();
  const q = (lit) => `SELECT COUNT(*) FROM tenant1.OrderItem i JOIN tenant1.[Order] o ON o.Id = i.OrderId WHERE o.Code = '${lit}'`;
  c.recordRead(d, { conn: 'DEV', op: 'query', text: q('A-1'), ok: true, ms: 10, rows: 1, task: 't1' });
  c.recordRead(d, { conn: 'DEV', op: 'query', text: q('B-2'), ok: true, ms: 30, rows: 1 });
  c.recordRead(d, { conn: 'DEV', op: 'query', text: q('C-3'), ok: false, ms: 5, error: "Conversion failed for value 'C-3'" });
  const rows = d.prepare('SELECT * FROM query_log').all();
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.deepStrictEqual([r.runs, r.ok_runs, r.last_ok, r.ms_total, r.task], [3, 2, 0, 45, 't1']);
  assert.strictEqual(r.last_error, "Conversion failed for value '?'");
  assert.match(r.sql_raw, /C-3/); // raw text stays local, for --raw, until prune
  assert.doesNotMatch(r.sql_fp, /A-1|B-2|C-3/);
  // the join was seen in the two successful runs only
  assert.deepStrictEqual(d.prepare('SELECT a_tbl, a_col, b_tbl, b_col, seen FROM join_edge').all().map(x => ({ ...x })),
    [{ a_tbl: 'Order', a_col: 'Id', b_tbl: 'OrderItem', b_col: 'OrderId', seen: 2 }]);
  assert.deepStrictEqual(d.prepare('SELECT tbl FROM query_table ORDER BY tbl').all().map(x => x.tbl), ['Order', 'OrderItem']);
});

test('historyRows: filters by connection, table, text and last outcome', () => {
  const d = memoryDb();
  c.recordRead(d, { conn: 'DEV', op: 'query', text: 'SELECT 1 FROM s.A', ok: true, ms: 1, rows: 1, now: '2026-01-01T00:00:00.000Z' });
  c.recordRead(d, { conn: 'HML', op: 'query', text: 'SELECT 1 FROM s.B', ok: false, ms: 1, error: 'x', now: '2026-01-02T00:00:00.000Z' });
  c.recordRead(d, { conn: 'DEV', op: 'count', text: 'SELECT COUNT(*) FROM s.B', ok: true, ms: 1, rows: 1, now: '2026-01-03T00:00:00.000Z' });
  assert.deepStrictEqual(c.historyRows(d).map(r => r.sql_fp), ['SELECT COUNT(*) FROM s.B', 'SELECT ? FROM s.B', 'SELECT ? FROM s.A']);
  assert.strictEqual(c.historyRows(d, { conn: 'DEV' }).length, 2);
  assert.strictEqual(c.historyRows(d, { table: 's.B' }).length, 2);
  assert.strictEqual(c.historyRows(d, { grep: 'COUNT' }).length, 1);
  assert.deepStrictEqual(c.historyRows(d, { failed: true }).map(r => r.conn), ['HML']);
  assert.strictEqual(c.historyRows(d, { top: 1 }).length, 1);
});

test('storeCatalog + searchCatalog: names grouped across schemas, preferred schema for the row count', () => {
  const d = memoryDb();
  c.storeCatalog(d, 'DEV', CATALOG, '2026-01-01T00:00:00.000Z');
  assert.deepStrictEqual({ ...c.catalogMeta(d, 'DEV') },
    { conn: 'DEV', fetched_at: '2026-01-01T00:00:00.000Z', schemas: 2, tables: 3, columns: 5, fks: 1 });
  const r = c.searchCatalog(d, 'DEV', 'order', { preferSchema: 'tenant2' });
  assert.deepStrictEqual(r.tables.map(t => [t.table, t.schemas, t.rowsEst]), [['Order', ['tenant1', 'tenant2'], 20], ['OrderItem', ['tenant1'], 30]]);
  assert.deepStrictEqual(r.columns.map(x => `${x.table}.${x.column} ${x.type}`), ['OrderItem.OrderId bigint']);
  assert.strictEqual(c.searchCatalog(d, 'DEV', '%').tablesTotal, 0); // LIKE wildcards are literal
  // a second store replaces, never appends
  c.storeCatalog(d, 'DEV', CATALOG);
  assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM catalog_column').get().n, 5);
});

test('catalogStale: missing or older than the TTL', () => {
  const d = memoryDb();
  assert.strictEqual(c.catalogStale(d, 'DEV'), true);
  c.storeCatalog(d, 'DEV', CATALOG, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(c.catalogStale(d, 'DEV', Date.parse('2026-01-05T00:00:00.000Z')), false);
  assert.strictEqual(c.catalogStale(d, 'DEV', Date.parse('2026-01-09T00:00:00.000Z')), true);
});

test('joinRows: declared FKs and joins seen in reads merge into one edge', () => {
  const d = memoryDb();
  c.storeCatalog(d, 'DEV', CATALOG);
  c.recordRead(d, { conn: 'DEV', op: 'query', text: 'SELECT 1 FROM tenant1.[Order] o JOIN tenant1.OrderItem i ON i.OrderId = o.Id', ok: true, ms: 1, rows: 1 });
  const rows = c.joinRows(d, 'DEV', 'tenant1.Order');
  assert.deepStrictEqual(rows.map(j => `${j.from.t}.${j.from.c}=${j.to.t}.${j.to.c} ${j.source} ${j.seen}`), ['Order.Id=OrderItem.OrderId fk+log 1']);
});

test('contextData + formatContext: shape, FKs, joins, recent reads as fingerprints, journal counts only', () => {
  const d = memoryDb();
  c.storeCatalog(d, 'DEV', CATALOG);
  c.recordRead(d, { conn: 'DEV', op: 'query', text: "SELECT Id FROM tenant1.OrderItem WHERE OrderId = 4242 AND Note = 'private'", ok: true, ms: 1, rows: 1 });
  c.recordRead(d, { conn: 'DEV', op: 'query', text: 'SELECT Nope FROM tenant1.OrderItem', ok: false, ms: 1, error: 'x' });
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  d.prepare('INSERT INTO journal (ts, "table", op) VALUES (?,?,?)').run('2026-01-25T00:00:00.000Z', 'OrderItem', 'update');
  d.prepare('INSERT INTO journal (ts, "table", op) VALUES (?,?,?)').run('2025-06-01T00:00:00.000Z', 'OrderItem', 'delete');
  const ctxData = c.contextData(d, 'DEV', 'OrderItem', { defaultSchema: 'tenant1', now });
  assert.strictEqual(ctxData.schema, 'tenant1');
  assert.deepStrictEqual(ctxData.columns.map(x => [x.name, x.fk]), [['Id', null], ['OrderId', 'Order.Id']]);
  assert.strictEqual(ctxData.queries.length, 1); // the failed read is not offered as an example
  assert.deepStrictEqual(ctxData.mutations30d, { update: 1 });
  const text = c.formatContext(ctxData);
  assert.match(text, /^tenant1\.OrderItem on DEV: 2 columns, ~30 rows/);
  assert.match(text, /OrderId\s+bigint\s+NOT NULL FK -> Order\.Id/);
  assert.match(text, /OrderItem\.OrderId = Order\.Id\s+fk/);
  assert.match(text, /journal, last 30 days, this project: update 1/);
  assert.doesNotMatch(text, /4242|private/);
  assert.strictEqual(c.contextData(d, 'DEV', 'Missing'), null);
  assert.strictEqual(c.contextData(d, 'DEV', 'OrderItem', { schema: 'tenant2' }), null);
  // a table held by two schemas: the default schema wins, the other is mentioned
  assert.match(c.formatContext(c.contextData(d, 'DEV', 'Order', { defaultSchema: 'tenant2' })), /^tenant2\.Order on DEV: 1 columns, ~20 rows \(also in 1 other schema\(s\)\)/);
});

test('projects: dev/hml of one system share history and joins; another project with the same table names never mixes in', () => {
  const d = memoryDb();
  c.storeCatalog(d, 'DEV', CATALOG);
  c.storeCatalog(d, 'HML', CATALOG);
  c.storeCatalog(d, 'MINE', CATALOG);
  const join = 'SELECT 1 FROM tenant1.[Order] o JOIN tenant1.OrderItem i ON i.OrderId = o.Id';
  c.recordRead(d, { conn: 'HML', project: 'shop', op: 'query', text: join, ok: true, ms: 1, rows: 1 });
  c.recordRead(d, { conn: 'MINE', op: 'query', text: 'SELECT 1 FROM tenant1.[Order] o JOIN tenant1.OrderItem i ON i.Id = o.Code', ok: true, ms: 1, rows: 1 });
  d.prepare('INSERT INTO journal (ts, connection, "table", op) VALUES (?,?,?,?)').run(new Date().toISOString(), 'MINE', 'OrderItem', 'delete');
  // DEV belongs to "shop": it sees what was learned on HML, not MINE's join nor MINE's journal
  const dev = c.contextData(d, 'DEV', 'OrderItem', { project: 'shop', conns: ['DEV', 'HML'], defaultSchema: 'tenant1' });
  assert.deepStrictEqual(dev.joins.map(j => `${j.to.t}.${j.to.c} ${j.source}`), ['Order.Id fk+log']);
  assert.deepStrictEqual(dev.queries.map(q => q.conn), ['HML']);
  assert.deepStrictEqual(dev.mutations30d, {});
  // MINE has no project set: it is its own
  const mine = c.contextData(d, 'MINE', 'OrderItem', { defaultSchema: 'tenant1' });
  assert.deepStrictEqual(mine.joins.map(j => `${j.from.c}=${j.to.t}.${j.to.c} ${j.source}`).sort(), ['Id=Order.Code log', 'OrderId=Order.Id fk']);
  assert.deepStrictEqual(mine.queries.map(q => q.conn), ['MINE']);
  assert.deepStrictEqual(mine.mutations30d, { delete: 1 });
  assert.strictEqual(c.historyRows(d, { project: 'shop' }).length, 1);
});

test('prunePlan + applyPrune: old journal and raw texts go, fingerprints and recent entries stay', () => {
  const d = memoryDb();
  const now = Date.parse('2026-03-01T00:00:00.000Z');
  d.prepare('INSERT INTO journal (ts, "table", op, reverted) VALUES (?,?,?,?)').run('2026-01-01T00:00:00.000Z', 'T', 'insert', 0);
  d.prepare('INSERT INTO journal (ts, "table", op, reverted) VALUES (?,?,?,?)').run('2026-01-02T00:00:00.000Z', 'T', 'insert', 1);
  d.prepare('INSERT INTO journal (ts, "table", op, reverted) VALUES (?,?,?,?)').run('2026-02-25T00:00:00.000Z', 'T', 'update', 0);
  c.recordRead(d, { conn: 'DEV', op: 'query', text: "SELECT 1 FROM s.T WHERE x = 'old'", ok: true, ms: 1, rows: 1, now: '2026-01-01T00:00:00.000Z' });
  c.recordRead(d, { conn: 'DEV', op: 'query', text: "SELECT 2 FROM s.U WHERE x = 'new'", ok: true, ms: 1, rows: 1, now: '2026-02-28T00:00:00.000Z' });
  d.prepare('INSERT INTO result_cache VALUES (?,?,?)').run('h', '2026-01-01T00:00:00.000Z', 300);
  const plan = c.prunePlan(d, 30, now);
  assert.deepStrictEqual({ journal: plan.journal, journalLive: plan.journalLive, rawQueries: plan.rawQueries, resultCache: plan.resultCache },
    { journal: 2, journalLive: 1, rawQueries: 1, resultCache: 1 });
  c.applyPrune(d, plan);
  assert.deepStrictEqual(d.prepare('SELECT op FROM journal').all().map(x => x.op), ['update']);
  assert.deepStrictEqual(d.prepare('SELECT sql_raw IS NULL AS gone FROM query_log ORDER BY last_at').all().map(x => x.gone), [1, 0]);
  assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM query_log').get().n, 2);
  assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM result_cache').get().n, 0);
});

test('retentionSetting: the environment wins over .env; only whole days turn it on', () => {
  const s = c.retentionSetting;
  assert.deepStrictEqual(s(undefined, ''), { days: null, bad: null });
  assert.deepStrictEqual(s('5', 'DBQ_JOURNAL_DAYS=30'), { days: 5, bad: null });
  assert.deepStrictEqual(s(undefined, 'A=Data Source=x\nDBQ_JOURNAL_DAYS=7\n'), { days: 7, bad: null });
  // the last line wins, like any other key of the file; quotes and the 3d form are accepted
  assert.deepStrictEqual(s(undefined, 'DBQ_JOURNAL_DAYS=7\r\n  DBQ_JOURNAL_DAYS = "3d" \r\n'), { days: 3, bad: null });
  // a commented line or another key is not the setting
  assert.deepStrictEqual(s(undefined, '# DBQ_JOURNAL_DAYS=5\nXDBQ_JOURNAL_DAYS=5'), { days: null, bad: null });
  // an explicit off in the environment beats the file
  for (const off of ['', '0', '0d', 'off', 'FALSE', 'no']) assert.deepStrictEqual(s(off, 'DBQ_JOURNAL_DAYS=9'), { days: null, bad: null }, off);
  // a typo must not delete history: it stays off and is reported
  for (const bad of ['all', '-1', '1.5', '5 days']) assert.deepStrictEqual(s(bad, ''), { days: null, bad }, bad);
  assert.deepStrictEqual(s(undefined, 'DBQ_JOURNAL_DAYS=soon'), { days: null, bad: 'soon' });
});

test('applyJournalRetention: entries older than N days go, reverted or not; recent ones stay', () => {
  const d = memoryDb();
  const now = Date.parse('2026-03-10T00:00:00.000Z');
  const ins = d.prepare('INSERT INTO journal (ts, "table", op, reverted) VALUES (?,?,?,?)');
  ins.run('2026-03-01T00:00:00.000Z', 'T', 'insert', 0);
  ins.run('2026-03-04T23:59:59.000Z', 'T', 'delete', 1);
  ins.run('2026-03-05T00:00:01.000Z', 'T', 'update', 0);
  ins.run('2026-03-09T12:00:00.000Z', 'T', 'ddl', 0);
  assert.strictEqual(c.applyJournalRetention(d, 5, now), 2);
  assert.deepStrictEqual(d.prepare('SELECT op FROM journal ORDER BY seq').all().map(x => x.op), ['update', 'ddl']);
  assert.strictEqual(c.applyJournalRetention(d, 5, now), 0); // nothing left to drop
});

test('applyJournalRetention: the dropped snapshot does not linger in the file (no VACUUM needed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbq-ret-'));
  const file = path.join(dir, 'j.sqlite');
  const marker = 'CLIENT-ROW-MARKER-';
  try {
    let d = new DatabaseSync(file);
    d.exec('CREATE TABLE journal (seq INTEGER PRIMARY KEY, ts TEXT, statement TEXT, snapshot_gz BLOB, reverted INTEGER DEFAULT 0)');
    d.prepare('INSERT INTO journal (ts, statement, snapshot_gz) VALUES (?,?,?)')
      .run('2020-01-01T00:00:00.000Z', marker + 'statement', Buffer.from((marker + 'blob;').repeat(2000))); // spills into overflow pages
    d.prepare('INSERT INTO journal (ts, statement) VALUES (?,?)').run(new Date().toISOString(), 'recent');
    d.close();
    assert.ok(fs.readFileSync(file).includes(marker), 'the snapshot is in the file before');
    const sizeBefore = fs.statSync(file).size;
    d = new DatabaseSync(file);
    assert.strictEqual(c.applyJournalRetention(d, 5), 1);
    d.close();
    assert.ok(!fs.readFileSync(file).includes(marker), 'the snapshot bytes are gone from the file');
    assert.strictEqual(fs.statSync(file).size, sizeBefore); // the pages stay, zeroed, for the next entries
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── CLI (temp dbq.sqlite, fake connections) ──────────────────────────────────
function runCli(args, dbFile, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbq-ctx-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, ['FAKEDEV=Data Source=fake-dev.invalid;Initial Catalog=appdev;User Id=w;Password=x', ...(extra.envLines || [])].join('\n') + '\n');
  // The retention setting of whoever runs the suite must not reach the cases: only extra.env turns it on.
  const env = { ...process.env, DBQ_ENV_FILE: envFile, DBQ_DB_FILE: dbFile || path.join(dir, 'dbq.sqlite') };
  delete env.DBQ_JOURNAL_DAYS;
  Object.assign(env, extra.env || {});
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js'), ...args], {
      env,
      encoding: 'utf8', timeout: 30000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('KNOWN_FLAGS: the context commands flags are known', () => {
  for (const f of ['older-than', 'grep', 'failed', 'raw', 'refresh', 'top']) assert.ok(KNOWN_FLAGS.has(f), f);
});

test('CLI: help lists the context commands', () => {
  const r = runCli(['--help']);
  for (const cmd of ['prune', 'catalog', 'find', 'context', 'joins', 'history']) assert.match(r.out, new RegExp(`\\n \\*?\\s*${cmd}\\b`));
});

test('CLI history / prune / log on an empty database', () => {
  assert.match(runCli(['history']).out, /no read recorded/);
  const p = runCli(['prune']);
  assert.strictEqual(p.code, 0);
  assert.match(p.out, /DRY RUN/);
  assert.match(runCli(['log']).out, /journal empty/);
});

test('CLI prune: a bad --older-than is refused; --yes prunes and reports the size', () => {
  const bad = runCli(['prune', '--older-than', 'all']);
  assert.strictEqual(bad.code, 1);
  assert.match(bad.err, /takes days/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbq-prune-'));
  const dbFile = path.join(dir, 'dbq.sqlite');
  try {
    runCli(['history'], dbFile); // creates the schema
    const d = new DatabaseSync(dbFile);
    d.prepare(`INSERT INTO journal (seq, ts, op, "table", snapshot_gz, reverted) VALUES (1, '2020-01-01T00:00:00.000Z', 'insert', 'T', x'00', 0)`).run();
    d.close();
    const r = runCli(['prune', '--older-than', '30d', '--yes'], dbFile);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /journal entries\s+1\s+\(1 not reverted/);
    assert.match(r.out, /OK prune: [\d.]+ MB -> [\d.]+ MB/);
    assert.match(runCli(['log', '--all'], dbFile).out, /journal empty/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI DBQ_JOURNAL_DAYS: a working command drops the old entries; log does not; unset, off or bad leaves them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbq-ret-cli-'));
  const dbFile = path.join(dir, 'dbq.sqlite');
  const seed = () => {
    const d = new DatabaseSync(dbFile);
    d.exec('DELETE FROM journal');
    d.prepare(`INSERT INTO journal (seq, id, ts, op, "table", reverted) VALUES (1, 'old1', '2020-01-01T00:00:00.000Z', 'insert', 'T', 0)`).run();
    d.prepare(`INSERT INTO journal (seq, id, ts, op, "table", reverted) VALUES (2, 'new1', ?, 'update', 'T', 0)`).run(new Date().toISOString());
    d.close();
  };
  const count = () => { const d = new DatabaseSync(dbFile); const n = d.prepare('SELECT COUNT(*) AS n FROM journal').get().n; d.close(); return n; };
  try {
    runCli(['history'], dbFile); // creates the schema
    seed();
    // unset: nothing happens
    let r = runCli(['history'], dbFile);
    assert.strictEqual(count(), 2);
    assert.doesNotMatch(r.err, /journal:/);
    // a bad value is reported and ignored; the command still runs
    r = runCli(['history'], dbFile, { env: { DBQ_JOURNAL_DAYS: 'all' } });
    assert.strictEqual(r.code, 0);
    assert.match(r.err, /DBQ_JOURNAL_DAYS="all" ignored/);
    assert.strictEqual(count(), 2);
    // the journal commands never trigger it
    r = runCli(['log', '--all'], dbFile, { env: { DBQ_JOURNAL_DAYS: '5' } });
    assert.match(r.out, /2020-01-01/); // the old entry is still listed
    assert.strictEqual(count(), 2);
    // a working command does, from the environment; stdout stays the command's own
    r = runCli(['history'], dbFile, { env: { DBQ_JOURNAL_DAYS: '5' } });
    assert.strictEqual(r.code, 0);
    assert.match(r.err, /journal: 1 entry older than 5 day\(s\) dropped/);
    assert.match(r.out, /no read recorded/);
    assert.doesNotMatch(r.out, /journal:/);
    assert.strictEqual(count(), 1);
    // from a line in .env too; an explicit off in the environment wins over the file
    seed();
    r = runCli(['conns'], dbFile, { envLines: ['DBQ_JOURNAL_DAYS=5'], env: { DBQ_JOURNAL_DAYS: 'off' } });
    assert.strictEqual(count(), 2);
    r = runCli(['conns'], dbFile, { envLines: ['DBQ_JOURNAL_DAYS=5'] });
    assert.strictEqual(r.code, 0);
    assert.match(r.err, /journal: 1 entry older than 5 day\(s\) dropped/);
    assert.strictEqual(count(), 1);
    assert.doesNotMatch(r.out, /DBQ_JOURNAL_DAYS/); // the setting is not listed as a connection
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI DBQ_JOURNAL_DAYS: without a dbq.sqlite the setting creates nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbq-ret-none-'));
  const dbFile = path.join(dir, 'none.sqlite');
  try {
    const r = runCli(['conns'], dbFile, { env: { DBQ_JOURNAL_DAYS: '5' } });
    assert.strictEqual(r.code, 0);
    assert.ok(!fs.existsSync(dbFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI catalog/find/context/joins: an unknown connection fails before any network', () => {
  for (const args of [['catalog', 'NOPE'], ['find', 'NOPE', 'x'], ['context', 'NOPE', 'T'], ['joins', 'NOPE', 'T']]) {
    const r = runCli(args);
    assert.strictEqual(r.code, 1, args.join(' '));
    assert.match(r.err, /Connection "NOPE" does not exist/);
  }
});

test('CLI find/context: missing arguments print the usage', () => {
  assert.match(runCli(['find', 'FAKEDEV']).err, /usage: find <conn> <term>/);
  assert.match(runCli(['context', 'FAKEDEV']).err, /usage: context <conn> <table>/);
});

// ── failure hints (C): the catalog's answer to a wrong name ─────────────────
const HINT_CATALOG = {
  tables: ['Order', 'OrderItem', 'Client', 'Invoice'].map(tbl => ({ sch: 'tenant1', tbl })).concat([{ sch: 'tenant2', tbl: 'Order' }]),
  columns: [
    ['Order', 'Id'], ['Order', 'Code'], ['Order', 'ClientId'],
    ['OrderItem', 'Id'], ['OrderItem', 'OrderId'], ['OrderItem', 'Qty'],
    ['Client', 'Id'], ['Client', 'Name'],
    ['Invoice', 'Id'], ['Invoice', 'ClientId'],
  ].map(([tbl, col], i) => ({ sch: 'tenant1', tbl, col, ord: i, type: 'int' })).concat([{ sch: 'tenant2', tbl: 'Order', col: 'Id', ord: 1, type: 'int' }]),
  fks: [
    { sch: 'tenant1', tbl: 'OrderItem', col: 'OrderId', ref_sch: 'tenant1', ref_tbl: 'Order', ref_col: 'Id' },
    { sch: 'tenant1', tbl: 'Order', col: 'ClientId', ref_sch: 'tenant1', ref_tbl: 'Client', ref_col: 'Id' },
    { sch: 'tenant1', tbl: 'Invoice', col: 'ClientId', ref_sch: 'tenant1', ref_tbl: 'Client', ref_col: 'Id' },
  ],
};
function hintsFor(text, error) {
  const d = memoryDb();
  c.storeCatalog(d, 'DEV', HINT_CATALOG);
  return c.failureHints(d, 'DEV', { text, error, defaultSchema: 'tenant1' });
}

test('closestNames: short typos and comparable containment; a prefix shared by every table is not close', () => {
  assert.deepStrictEqual(c.closestNames('Qtty', ['Id', 'OrderId', 'Qty']), ['Qty']);
  assert.deepStrictEqual(c.closestNames('Expiration', ['ItemExpiration', 'Order', 'Other']), ['ItemExpiration']);
  assert.deepStrictEqual(c.closestNames('OrderLineExpirations', ['OrderLineExpiration', 'OrderLine', 'Order']), ['OrderLineExpiration']);
  assert.deepStrictEqual(c.closestNames('Zzz', ['Order', 'Client']), []);
});

test('failureNames: column, object and ambiguous names, quotes unescaped; other errors give none', () => {
  assert.deepStrictEqual(c.failureNames("Invalid column name 'A'. Invalid column name 'B''x'."),
    [{ kind: 'column', name: 'A' }, { kind: 'column', name: "B'x" }]);
  assert.deepStrictEqual(c.failureNames("Invalid object name 'tenant1.T'."), [{ kind: 'object', name: 'tenant1.T' }]);
  assert.deepStrictEqual(c.failureNames("Ambiguous column name 'Id'."), [{ kind: 'ambiguous', name: 'Id' }]);
  assert.deepStrictEqual(c.failureNames('Conversion failed when converting'), []);
});

test('failureHints: a typo gets the closest column of the tables the query reads', () => {
  assert.deepStrictEqual(hintsFor('SELECT Qtty FROM tenant1.OrderItem', "Invalid column name 'Qtty'."),
    ['no column "Qtty" in OrderItem — closest: OrderItem.Qty']);
});

test('failureHints: the column is on another table of the same query — the qualifier is wrong', () => {
  assert.deepStrictEqual(
    hintsFor('SELECT i.Code FROM tenant1.[Order] o JOIN tenant1.OrderItem i ON i.OrderId = o.Id', "Invalid column name 'Code'."),
    ['"Code" is a column of Order (alias o) in this query — o.Code']);
});

test('failureHints: the column is one FK away; farther, only the count and the find command', () => {
  assert.deepStrictEqual(hintsFor('SELECT ClientId FROM tenant1.OrderItem', "Invalid column name 'ClientId'."),
    ['"ClientId" is a column of Order (FK with OrderItem) — one join away from this query']);
  assert.deepStrictEqual(hintsFor('SELECT Name FROM tenant1.OrderItem', "Invalid column name 'Name'."),
    ['"Name" is a column of 1 other table(s), none one FK away from this query — dbq find DEV Name']);
});

test('failureHints: a table in the wrong schema names the schemas that hold it; a typo gets the closest table', () => {
  assert.deepStrictEqual(hintsFor('SELECT 1 FROM tenant2.OrderItem', "Invalid object name 'tenant2.OrderItem'."),
    ['table OrderItem exists in schema(s) tenant1, not in tenant2 — the schema is the tenant']);
  assert.deepStrictEqual(hintsFor('SELECT 1 FROM tenant1.OrderItems', "Invalid object name 'tenant1.OrderItems'."),
    ['no table "OrderItems" — closest: OrderItem']);
});

test('failureHints: an ambiguous column names both tables and the qualified form', () => {
  assert.deepStrictEqual(
    hintsFor('SELECT Id FROM tenant1.[Order] o JOIN tenant1.OrderItem i ON i.OrderId = o.Id', "Ambiguous column name 'Id'."),
    ['"Id" is in Order (alias o) and OrderItem (alias i) — qualify it: o.Id']);
});

test('failureHints: nothing to say means no hint, never a guess', () => {
  assert.deepStrictEqual(hintsFor('SELECT Zzzz FROM tenant1.OrderItem', "Invalid column name 'Zzzz'."), []);
  assert.deepStrictEqual(hintsFor('SELECT 1 FROM tenant1.OrderItem', 'Timeout expired'), []);
  const empty = memoryDb(); // no catalog for the connection
  assert.deepStrictEqual(c.failureHints(empty, 'DEV', { text: 'SELECT Qtty FROM t', error: "Invalid column name 'Qtty'." }), []);
});
