#!/usr/bin/env node
/*
 * pending FluentMigrator migrations (code at a git ref x version table in a database)
 * -------------------------------------------------------------------------------------------
 * Read-only. Lists the [Migration(n)] classes declared at a git ref and compares them with the
 * versions recorded in the database's version table, to answer before a deploy or a manual run:
 *
 *   - what will MigrateUp apply here, and in which order? It stops at the FIRST failing
 *     migration, so a pending one with a lower version runs (and can fail) before yours;
 *   - "the migration is recorded as applied, why is the column missing?" — a migration file
 *     edited after it was applied never reaches databases that already recorded its version;
 *   - non-public classes are listed apart: FluentMigrator's assembly scan only picks exported
 *     types, so they show up as pending forever and never run;
 *   - the same version declared twice (DuplicateMigrationException at load time), told apart from
 *     the same file committed twice under paths that differ only in letter case;
 *   - versions recorded in the table and absent from the ref: another runner writing to the same
 *     table, or a ref older than the database.
 *
 * Reads the code through git (ls-tree + one cat-file --batch), so it needs no checkout and runs
 * against any clone without touching its working tree. Never writes to the database.
 *
 * Usage:
 *   node scripts/pending-migrations.js --conn <CONN> --repo <path-to-clone>
 *        [--ref <git ref, default HEAD>] [--path <dir inside the repo>]
 *        [--schema <schema of the version table>] [--table <version table, default VersionInfo>]
 *        [--json]
 *
 * Exit 0 when both sides were read; exit 1 on a usage or read error.
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const DBQ = path.join(__dirname, '..', 'index.js');
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// [Migration(n ...)] followed (possibly through other attributes) by the class declaration.
const MIGRATION_RE = /\[Migration\((\d+)[^\]]*\)\]\s*(?:\[[^\]]*\]\s*)*((?:public|internal|private|protected|sealed|abstract|partial|\s)*)class\s+(\w+)/g;

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return flags;
}

/** Pure: migrations declared in one C# source. Line comments are stripped first. */
function migrationsInSource(src, file) {
  const clean = src.replace(/\/\/[^\n]*/g, '');
  const out = [];
  let m;
  MIGRATION_RE.lastIndex = 0;
  while ((m = MIGRATION_RE.exec(clean))) {
    out.push({ version: m[1], visibility: /\bpublic\b/.test(m[2]) ? 'public' : 'non-public', className: m[3], file });
  }
  return out;
}

const byVersion = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

/**
 * Pure: classify code against the applied versions (a Set of strings).
 * A version declared more than once is a real duplicate only when the declarations live in
 * different files; the same path differing only in letter case is one file committed twice.
 */
function classify(codeMigrations, applied) {
  const groups = new Map();
  for (const c of codeMigrations) groups.set(c.version, [...(groups.get(c.version) || []), c]);
  const duplicated = [];
  const caseOnlyCopies = [];
  for (const [version, list] of groups) {
    if (list.length < 2) continue;
    const distinctPaths = new Set(list.map((c) => c.file.toLowerCase()));
    (distinctPaths.size === 1 ? caseOnlyCopies : duplicated).push({ version, files: list.map((c) => c.file) });
  }
  // One entry per version for pending lists (case-only copies are the same migration).
  const unique = [...groups.values()].map((list) => list[0]);
  return {
    pendingPublic: unique.filter((c) => c.visibility === 'public' && !applied.has(c.version)).sort((a, b) => byVersion(a.version, b.version)),
    pendingNonPublic: unique.filter((c) => c.visibility !== 'public' && !applied.has(c.version)).sort((a, b) => byVersion(a.version, b.version)),
    duplicated: duplicated.sort((a, b) => byVersion(a.version, b.version)),
    caseOnlyCopies: caseOnlyCopies.sort((a, b) => byVersion(a.version, b.version)),
    appliedNotInCode: [...applied].filter((v) => !groups.has(v)).sort(byVersion),
  };
}

function readCode(repo, ref, dir) {
  const opts = { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 };
  const tree = execFileSync('git', ['-C', repo, 'ls-tree', '-r', ref, '--', dir || '.'], opts)
    .split('\n').filter(Boolean)
    .map((line) => { const [meta, file] = line.split('\t'); return { blob: meta.split(' ')[2], file }; })
    .filter((e) => e.file.endsWith('.cs'));
  if (!tree.length) return [];
  // One process for every blob: --batch prints "<sha> blob <size>\n<content>\n" per input line.
  const buf = execFileSync('git', ['-C', repo, 'cat-file', '--batch'],
    { input: tree.map((e) => e.blob).join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024 });
  const out = [];
  let pos = 0;
  for (const entry of tree) {
    const headerEnd = buf.indexOf(0x0a, pos);
    const size = parseInt(buf.slice(pos, headerEnd).toString('utf8').split(' ')[2], 10);
    const src = buf.slice(headerEnd + 1, headerEnd + 1 + size).toString('utf8');
    pos = headerEnd + 1 + size + 1;
    if (src.includes('[Migration(')) out.push(...migrationsInSource(src, entry.file));
  }
  return out;
}

function readApplied(conn, schema, table) {
  const target = schema ? `${schema}.${table}` : table;
  // varchar(max): a plain STRING_AGG overflows 8000 bytes on a table with a few thousand versions.
  const sql = `SELECT STRING_AGG(CAST(Version AS varchar(max)), ',') v FROM ${target}`;
  const raw = execFileSync(process.execPath, [DBQ, 'query', conn, sql, '--format', 'tsv'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (/^ERROR:/m.test(raw)) throw new Error(raw.trim());
  const versions = raw.split(/[\r\n,]+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  if (!versions.length) throw new Error(`no version read from ${target} on ${conn}:\n${raw.trim()}`);
  return new Set(versions);
}

const USAGE = 'usage: node scripts/pending-migrations.js --conn <CONN> --repo <clone> [--ref <ref>] [--path <dir>] [--schema <s>] [--table <t>] [--json]';

function main() {
  const flags = parseFlags(process.argv.slice(2));
  const known = new Set(['conn', 'repo', 'ref', 'path', 'schema', 'table', 'json']);
  const unknown = Object.keys(flags).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`unknown flag(s): --${unknown.join(', --')}\n${USAGE}`);
  if (!flags.conn || !flags.repo || flags.conn === true || flags.repo === true) throw new Error(USAGE);
  const table = flags.table || 'VersionInfo';
  for (const id of [flags.schema, table].filter(Boolean)) {
    if (!IDENT.test(id)) throw new Error(`invalid identifier: ${id}`);
  }
  const ref = flags.ref || 'HEAD';

  const code = readCode(flags.repo, ref, flags.path);
  const applied = readApplied(flags.conn, flags.schema, table);
  const r = classify(code, applied);

  if (flags.json) {
    console.log(JSON.stringify({ conn: flags.conn, schema: flags.schema || null, table, ref, codeCount: code.length, appliedCount: applied.size, ...r }, null, 2));
    return;
  }

  const line = (p) => `    ${p.version}  ${p.className}  ${p.file}`;
  console.log(`${flags.conn}${flags.schema ? ` ${flags.schema}` : ''}.${table} x ${ref}`);
  console.log(`  migrations in code: ${code.length}   versions applied: ${applied.size}`);
  console.log(`  pending, public (MigrateUp applies them in this order): ${r.pendingPublic.length}`);
  r.pendingPublic.forEach((p) => console.log(line(p)));
  console.log(`  pending, non-public (never scanned, never run): ${r.pendingNonPublic.length}`);
  r.pendingNonPublic.forEach((p) => console.log(line(p)));
  if (r.duplicated.length) {
    console.log(`  DUPLICATED version in different files (DuplicateMigrationException on load): ${r.duplicated.length}`);
    r.duplicated.forEach((d) => console.log(`    ${d.version}  ${d.files.join('  |  ')}`));
  }
  if (r.caseOnlyCopies.length) {
    console.log(`  same file committed under paths differing only in case (one type on a case-insensitive checkout; a compile clash on a case-sensitive one): ${r.caseOnlyCopies.length}`);
    r.caseOnlyCopies.forEach((d) => console.log(`    ${d.version}  ${d.files.join('  |  ')}`));
  }
  console.log(`  applied but not in this ref (another runner on the same table, or an older ref): ${r.appliedNotInCode.length}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { migrationsInSource, classify };
