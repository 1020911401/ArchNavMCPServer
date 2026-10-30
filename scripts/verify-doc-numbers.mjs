#!/usr/bin/env node
/**
 * verify-doc-numbers.mjs — the docs quote measured numbers ("48 files", "155 flows").
 * A quoted measurement is a claim like any other: rules improve, the number moves,
 * nobody re-runs the fixture, and the handbook quietly sells a stale truth.
 *
 *   node scripts/verify-doc-numbers.mjs          # exit 1 on any mismatch
 *   node scripts/verify-doc-numbers.mjs --json
 *
 * It re-measures the claims on the bench fixtures (they are customer-code copies and
 * stay out of git, so a clean clone skips this with a clear message instead of failing)
 * and cross-checks that the doc line still quotes the number this file claims.
 *
 * When a number legitimately moves: update the doc **and** the CLAIMS table here — the
 * two are deliberately redundant, so neither can drift alone.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');
const PHP = path.join(ROOT, 'bench', 'php-app');
const VUE = path.join(ROOT, 'bench', 'vue-app');

/**
 * `rule` claims are "how many files this rule fires in on this fixture".
 * `flows` is the number of entry-point flows the fixture produces.
 */
const CLAIMS = [
  { fixture: 'php-app', kind: 'rule', rule: 'php-loose-comparison', claimed: 48, doc: 'skill/archnav/references/code-review.md' },
  { fixture: 'php-app', kind: 'rule', rule: 'php-blade-unescaped-output', claimed: 40, doc: 'skill/archnav/references/code-review.md' },
  { fixture: 'php-app', kind: 'rule', rule: 'php-unbounded-query', claimed: 4, doc: 'docs/review-rules.md' },
  { fixture: 'vue-app', kind: 'rule', rule: 'js-loose-equality', claimed: 160, doc: 'skill/archnav/references/code-review.md' },
  { fixture: 'vue-app', kind: 'rule', rule: 'vue-v-if-with-v-for', claimed: 10, doc: 'skill/archnav/references/code-review.md' },
  { fixture: 'php-app', kind: 'flows', claimed: 155, doc: 'skill/archnav/references/playbook-full.md', docNeedle: '155' },
  { fixture: 'php-app', kind: 'routes', claimed: 155, doc: 'README.md', docNeedle: '155 edges' },
];

const missingFixtures = [PHP, VUE].filter((d) => !fs.existsSync(d));
if (missingFixtures.length) {
  const msg = `bench fixtures absent (${missingFixtures.map((d) => path.relative(ROOT, d)).join(', ')}) — doc numbers not re-measured`;
  if (JSON_OUT) console.log(JSON.stringify({ skipped: true, reason: msg }, null, 2));
  else console.log(`➖ ${msg}`);
  process.exit(0);
}

function runNode(rel, args, cwd) {
  const out = execFileSync(process.execPath, [path.join(ROOT, rel), ...args], { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  return out;
}

const reviewCache = new Map();
function corpus(dir) {
  if (!reviewCache.has(dir)) {
    const out = runNode('scripts/review-rules.mjs', ['.', '--scope', 'corpus', '--all-rules', '--json', '--no-compact'], dir);
    reviewCache.set(dir, JSON.parse(out.slice(out.indexOf('{'))));
  }
  return reviewCache.get(dir);
}

function measure(claim) {
  const dir = claim.fixture === 'php-app' ? PHP : VUE;
  if (claim.kind === 'rule') {
    return new Set((corpus(dir).findings || []).filter((f) => f.rule === claim.rule).map((f) => f.file)).size;
  }
  if (claim.kind === 'routes') {
    const index = JSON.parse(fs.readFileSync(path.join(dir, '.archnav', 'index.json'), 'utf8'));
    return (index.routeStats || {}).edges ?? -1;
  }
  const out = runNode('scripts/deep.mjs', ['.', '--flows', '--json'], dir);
  return (JSON.parse(out.slice(out.indexOf('{'))).flows || []).length;
}

/** The doc must still quote the number this file claims; otherwise one of the two moved. */
function docSays(claim) {
  const abs = path.join(ROOT, claim.doc);
  if (!fs.existsSync(abs)) return { ok: false, why: `doc missing: ${claim.doc}` };
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  const needle = claim.docNeedle || (claim.kind === 'rule' ? claim.rule : String(claim.claimed));
  const line = lines.find((l) => l.includes(needle));
  if (!line) return { ok: false, why: `doc no longer mentions ${needle}` };
  return { ok: line.includes(String(claim.claimed)), why: line.trim().slice(0, 140) };
}

const rows = [];
for (const claim of CLAIMS) {
  const measured = measure(claim);
  const doc = docSays(claim);
  rows.push({
    claim,
    measured,
    measuredOk: measured === claim.claimed,
    docOk: doc.ok,
    docLine: doc.why,
  });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ fixtures: { 'php-app': PHP, 'vue-app': VUE }, rows }, null, 2));
} else {
  for (const r of rows) {
    const label = r.claim.kind === 'rule' ? `${r.claim.fixture}:${r.claim.rule}` : `${r.claim.fixture}:${r.claim.kind}`;
    const measured = r.measuredOk ? '✅' : '❌';
    const doc = r.docOk ? '✅' : '❌';
    console.log(`${measured} measured ${label.padEnd(46)} ${String(r.claim.claimed).padStart(4)} → ${String(r.measured).padStart(4)}   doc:${doc} ${r.docOk ? '' : `— ${r.docLine}`}`);
  }
  const bad = rows.filter((r) => !r.measuredOk || !r.docOk);
  console.log(`\n${rows.length} claims · ${rows.length - bad.length} match · ${bad.length} drifted`);
  if (bad.length) {
    console.error('   update the measurement AND the doc line (and the CLAIMS table above)');
  }
}
process.exit(rows.some((r) => !r.measuredOk || !r.docOk) ? 1 : 0);
