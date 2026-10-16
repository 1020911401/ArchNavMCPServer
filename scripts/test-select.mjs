#!/usr/bin/env node
/**
 * test-select — pick the unit tests a change actually touches, using ArchNav's
 * own graph instead of a "file name contains test" guess.
 *
 * Why: `archnav impact` exposes `suggested_tests`, which is every test-looking
 * file in the index (measured: 14 of 16 test files for one symbol). The graph
 * already holds the edges that answer the real question — a test file that
 * imports/calls a symbol has a DEPENDS_ON edge into it — so filtering the
 * change-impact result by "is this row a test file" gives per-change precision.
 *
 * Usage:
 *   node scripts/test-select.mjs [dir] [--scope unstaged|staged|all|compare]
 *                                [--base <ref>] [--json] [--gate]
 *
 *   --gate  exit 1 when a changed symbol has no covering test (CI gate for
 *           "this diff needs a new test before review").
 *
 * Assumes the index is current; run `archnav analyze <dir>` first.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archNav } from '../src/navigation.js';

function parseArgs(argv) {
  const out = { dir: '.', scope: 'unstaged', base: null, json: false, gate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') out.scope = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--gate') out.gate = true;
    else if (a.startsWith('--')) {
      console.error(`unknown option ${a}`);
      process.exit(2);
    } else out.dir = a;
  }
  return out;
}

export const isTestFile = (f) =>
  /(^|\/)(__tests__|tests?|spec|e2e)\//i.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(f);

const posix = (p) => String(p).replace(/\\/g, '/');

export function selectTests(changeResult) {
  const changedFiles = (changeResult.changed_files || []).map((r) => posix(r.file));
  const rows = changeResult.impacted || [];

  const testRows = rows.filter((r) => isTestFile(posix(r.file)));
  const depthOf = new Map();
  for (const r of testRows) {
    const f = posix(r.file);
    const d = r.depth ?? 1;
    if (!depthOf.has(f) || d < depthOf.get(f)) depthOf.set(f, d);
  }
  const testsFromImpact = new Set(testRows.map((r) => posix(r.file)));
  // A test file you edited yourself is in scope even without an inbound edge.
  for (const f of changedFiles) if (isTestFile(f)) testsFromImpact.add(f);
  // Closest dependents first: a depth-1 test imports the symbol directly.
  const byDepth = (a, b) => (depthOf.get(a) ?? 99) - (depthOf.get(b) ?? 99) || a.localeCompare(b);

  // Which changed symbol is covered by which test (via the merged from_changed tag).
  const covered = new Map();
  for (const r of testRows) {
    const key = r.from_changed ?? '(unknown)';
    if (!covered.has(key)) covered.set(key, new Set());
    covered.get(key).add(posix(r.file));
  }

  const changedSymbols = (changeResult.changed_symbols || []).map((s) => ({
    symbol: s.symbol,
    file: posix(s.file),
    line_start: s.line_start,
    confidence: s.confidence,
    tests: [...(covered.get(s.symbol) || [])].sort(byDepth),
  }));

  return {
    via: changeResult.via,
    note: changeResult.note ?? null,
    scope: changeResult.scope,
    changed_files: changedFiles,
    changed_symbols: changedSymbols,
    tests: [...testsFromImpact].sort(byDepth),
    test_depths: Object.fromEntries([...testsFromImpact].sort(byDepth).map((t) => [t, depthOf.get(t) ?? null])),
    uncovered_symbols: changedSymbols.filter((s) => s.tests.length === 0),
    impacted_non_test: rows.length - testRows.length,
    unmapped_files: (changeResult.unmapped_files || []).map(posix),
  };
}

function render(sel, { runHint = 'node --test' } = {}) {
  const L = [];
  L.push(`\n🧪 test-select — scope=${sel.scope} via=${sel.via}  (${sel.changed_files.length} file(s) changed)`);
  if (sel.note) L.push(`   ⚠️  ${sel.note}`);
  if (!sel.changed_files.length) {
    L.push('   nothing changed vs the index — no tests to select.');
    return L.join('\n');
  }
  L.push('\n   📝 Changed symbols:');
  for (const s of sel.changed_symbols) {
    const t = s.tests.length ? `→ ${s.tests.join(', ')}` : '→ ⚠️ no test';
    L.push(`      ${s.symbol} (${s.file}:${s.line_start}) conf ${Math.round((s.confidence ?? 1) * 100)}% ${t}`);
  }
  L.push(`\n   🧪 Tests to run (${sel.tests.length}):`);
  if (!sel.tests.length) L.push('      (none — nothing in the graph reaches the change)');
  for (const t of sel.tests) {
    const d = sel.test_depths?.[t];
    L.push(`      ${t}${d ? `  (depth ${d}${d === 1 ? ' — imports it directly' : ''})` : ''}`);
  }
  L.push(`\n   🌐 Non-test impacted symbols (review checklist): ${sel.impacted_non_test}`);
  if (sel.uncovered_symbols.length) {
    L.push(`   🚨 Changed symbols with no covering test: ${sel.uncovered_symbols.map((s) => s.symbol).join(', ')}`);
  }
  if (sel.unmapped_files.length) {
    L.push(`   ⚠️  Changed files with no indexed symbol (review by hand): ${sel.unmapped_files.join(', ')}`);
  }
  if (sel.tests.length) L.push(`\n   ▶ ${runHint} ${sel.tests.map((t) => `"${t}"`).join(' ')}`);
  return L.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = path.resolve(opts.dir);
  const res = await archNav.changes(dir, { scope: opts.scope, base: opts.base });
  if (res.error) {
    console.error(res.error);
    process.exit(2);
  }
  const sel = selectTests(res);
  if (opts.json) console.log(JSON.stringify(sel, null, 2));
  else console.log(render(sel));
  if (opts.gate && sel.uncovered_symbols.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
