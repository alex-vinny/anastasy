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
  const { positionals, flags } = parseArgs(['DEVEL', 'sch1.Contract', '--top', '10', '--full']);
  assert.deepStrictEqual(positionals, ['DEVEL', 'sch1.Contract']);
  assert.strictEqual(flags.top, '10');
  assert.strictEqual(flags.full, true);
});

test('parseArgs: a flag followed by another flag is boolean, not a value', () => {
  const { flags } = parseArgs(['--refresh', '--schema', 'sch1']);
  assert.strictEqual(flags.refresh, true);
  assert.strictEqual(flags.schema, 'sch1');
});

// ── splitTarget — the qualified-name bug ─────────────────────────────────────
test('splitTarget: a qualified name is understood, not prefixed again', () => {
  // The bug: qual() used to wrap this blindly into [sch].[sch1.Contract] — one
  // broken identifier — and SQL Server then complained about the TABLE, which
  // sends you looking in the wrong place.
  assert.deepStrictEqual(splitTarget('sch1.Contract', 'sch'),
    { schema: 'sch1', table: 'Contract', qualified: true });
});

test('splitTarget: bracketed qualified names too', () => {
  assert.deepStrictEqual(splitTarget('[sch1].[Contract]', 'sch'),
    { schema: 'sch1', table: 'Contract', qualified: true });
});

test('splitTarget: a bare name keeps the caller fallback and is flagged unqualified', () => {
  assert.deepStrictEqual(splitTarget('Contract', 'sch17'),
    { schema: 'sch17', table: 'Contract', qualified: false });
});

test('splitTarget: brackets are stripped from a bare name', () => {
  assert.strictEqual(splitTarget('[Contract]', 'sch1').table, 'Contract');
});

test('splitTarget: a three-part name is refused instead of silently mangled', () => {
  assert.throws(() => splitTarget('db.sch1.Contract', 'sch'), /more than two parts/);
});

test('splitTarget: tolerates surrounding whitespace', () => {
  assert.deepStrictEqual(splitTarget('  sch2.Widget  ', 'sch'),
    { schema: 'sch2', table: 'Widget', qualified: true });
});

test('qual: still brackets both halves once they are separated', () => {
  assert.strictEqual(qual('sch1', 'Contract'), '[sch1].[Contract]');
});

// ── schemaFromEnvText — the per-connection default ───────────────────────────
const ENV_SAMPLE = [
  '# comentário',
  'DEVEL=Data Source=srv;Initial Catalog=elos;User Id=u;Password=p',
  'DEVEL_DESC=dev do time',
  'DEVEL_SCHEMA=sch1',
  'ELHML=Data Source=h;Initial Catalog=elos;User Id=u;Password=p',
  "ELHML_SCHEMA='sch2'",
  'HMLADM_SCHEMA=',
].join('\n');

test('schemaFromEnvText: reads <CONN>_SCHEMA', () => {
  assert.strictEqual(schemaFromEnvText(ENV_SAMPLE, 'DEVEL'), 'sch1');
});

test('schemaFromEnvText: strips surrounding quotes', () => {
  assert.strictEqual(schemaFromEnvText(ENV_SAMPLE, 'ELHML'), 'sch2');
});

test('schemaFromEnvText: an empty value is null, not an empty schema', () => {
  assert.strictEqual(schemaFromEnvText(ENV_SAMPLE, 'HMLADM'), null);
});

test('schemaFromEnvText: a connection without the key is null', () => {
  assert.strictEqual(schemaFromEnvText(ENV_SAMPLE, 'ELPRD'), null);
  assert.strictEqual(schemaFromEnvText(ENV_SAMPLE, null), null);
  assert.strictEqual(schemaFromEnvText('', 'DEVEL'), null);
});

test('schemaFromEnvText: does not confuse _SCHEMA with _DESC on the same connection', () => {
  assert.strictEqual(schemaFromEnvText('X_DESC=sch9\nX_SCHEMA=sch3', 'X'), 'sch3');
});

// ── parseEnv ─────────────────────────────────────────────────────────────────
test('parseEnv: sidecar keys never become connections of their own', () => {
  // _SCHEMA joined _READONLY/_PROD/_DESC in the skip list; without that, a key
  // like DEVEL_SCHEMA would surface as a phantom connection in `dbq conns`.
  const conns = parseEnv(ENV_SAMPLE);
  assert.deepStrictEqual(Object.keys(conns).sort(), ['DEVEL', 'ELHML']);
});

test('parseEnv: the per-connection schema rides on the connection object', () => {
  assert.strictEqual(parseEnv(ENV_SAMPLE).DEVEL.schema, 'sch1');
  assert.strictEqual(parseEnv(ENV_SAMPLE).ELHML.schema, 'sch2');
});

test('parseEnv: a value that is not a connection string is ignored', () => {
  assert.deepStrictEqual(Object.keys(parseEnv('NOT_A_CONN=hello world')), []);
});

test('parseEnv: comments and blank lines are skipped', () => {
  assert.deepStrictEqual(Object.keys(parseEnv('# X=Data Source=a;\n\n')), []);
});

// ── parseConnString ──────────────────────────────────────────────────────────
test('parseConnString: reads the ADO.NET keys case-insensitively', () => {
  const p = parseConnString('Data Source=srv.database.windows.net;Initial Catalog=elos;User Id=reader;Password=s3cr3t');
  assert.strictEqual(p.server, 'srv.database.windows.net');
  assert.strictEqual(p.database, 'elos');
  assert.strictEqual(p.user, 'reader');
});

test('parseConnString: accepts the Server=/Database= spelling too', () => {
  const p = parseConnString('Server=s;Database=d;Uid=u;Pwd=p');
  assert.strictEqual(p.server, 's');
  assert.strictEqual(p.database, 'd');
  assert.strictEqual(p.user, 'u');
});

test('parseEnv: a "reader" user is marked read-only without needing a flag', () => {
  const conns = parseEnv('R=Data Source=s;Initial Catalog=d;User Id=elos_reader;Password=p');
  assert.strictEqual(conns.R.readonly, true);
});

test('parseEnv: a prod-looking database is treated as prod by default', () => {
  const conns = parseEnv('P=Data Source=s-prd;Initial Catalog=elosprd;User Id=u;Password=p');
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
  assert.deepStrictEqual(unknownFlags({ table: 'x', schema: 'sch1', yes: true, top: '5' }), []);
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
  // right; DEVEL has sch1/sch2/sch3/sch8/sch17 and no bare `sch` at all. The fix
  // is `dbq schemas <conn>` plus <CONN>_SCHEMA, not a different global guess.
  assert.strictEqual(DEFAULT_SCHEMA, 'sch');
});
