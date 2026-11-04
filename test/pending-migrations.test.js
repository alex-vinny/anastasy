'use strict';

// Unit tests for scripts/pending-migrations.js pure helpers. No git, no database.

const { test } = require('node:test');
const assert = require('node:assert');
const { migrationsInSource, classify } = require('../scripts/pending-migrations.js');

const src = (attr, decl) => `namespace Sample {\n    ${attr}\n    ${decl}\n    { }\n}`;
const mig = (version, file, visibility = 'public', className = `M${version}`) => ({ version, visibility, className, file });

test('migrationsInSource: a public class with the attribute is found', () => {
  const out = migrationsInSource(src('[Migration(202601011200)]', 'public class AddOrderTable : Migration'), 'a.cs');
  assert.deepStrictEqual(out, [{ version: '202601011200', visibility: 'public', className: 'AddOrderTable', file: 'a.cs' }]);
});

test('migrationsInSource: a class without access modifier is non-public (the scan never picks it)', () => {
  const out = migrationsInSource(src('[Migration(202601011300)]', 'class AddIndex : Migration'), 'b.cs');
  assert.strictEqual(out[0].visibility, 'non-public');
});

test('migrationsInSource: extra attribute arguments and stacked attributes are tolerated', () => {
  const out = migrationsInSource(
    src('[Migration(202601011400, TransactionBehavior.None)]\n    [Tags("x")]', 'public sealed class M : Migration'), 'c.cs');
  assert.strictEqual(out[0].version, '202601011400');
  assert.strictEqual(out[0].visibility, 'public');
});

test('migrationsInSource: a commented-out migration does not count', () => {
  assert.deepStrictEqual(migrationsInSource('// [Migration(1)]\n// public class Old : Migration {}', 'd.cs'), []);
});

test('classify: pending public / non-public, and versions only in the database', () => {
  const r = classify([mig('3', 'c.cs'), mig('1', 'a.cs'), mig('2', 'b.cs', 'non-public')], new Set(['1', '99']));
  assert.deepStrictEqual(r.pendingPublic.map((p) => p.version), ['3']);
  assert.deepStrictEqual(r.pendingNonPublic.map((p) => p.version), ['2']);
  assert.deepStrictEqual(r.appliedNotInCode, ['99']);
});

test('classify: same version in two different files is a real duplicate', () => {
  const r = classify([mig('4', 'Migrations/A/M4.cs'), mig('4', 'Migrations/B/Other.cs')], new Set(['4']));
  assert.deepStrictEqual(r.duplicated.map((d) => d.version), ['4']);
  assert.deepStrictEqual(r.caseOnlyCopies, []);
});

test('classify: same path differing only in case is one file committed twice, not a duplicate', () => {
  const r = classify([mig('5', 'Migrations/Core/M5.cs'), mig('5', 'Migrations/CORE/M5.cs')], new Set());
  assert.deepStrictEqual(r.duplicated, []);
  assert.deepStrictEqual(r.caseOnlyCopies.map((d) => d.version), ['5']);
  assert.strictEqual(r.pendingPublic.length, 1, 'counted once as pending');
});

test('classify: pending are in numeric order (the order the runner applies them)', () => {
  const r = classify([mig('202601011200', 'n.cs'), mig('20150831', 'i.cs')], new Set());
  assert.deepStrictEqual(r.pendingPublic.map((p) => p.version), ['20150831', '202601011200']);
});
