/**
 * fe-be-pair.test.mjs — the three front/back boundary rules validated end to end
 * against known ground truth.
 *
 * Why this fixture exists: the tracked customer fixtures (php-app / vue-app) pair at
 * 3.6% — they are not a front/back pair — so `fe-be-path-not-found`,
 * `fe-be-method-mismatch` and `fe-be-route-unused` were only unit-tested, and one run
 * showed all three reporting ✅ 通过 for a comparison that never happened.
 * `bench/fe-be-pair/` is invented, tiny and tracked so the counts are checkable on
 * every run, including CI (where php-app/vue-app are absent).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'bench', 'fe-be-pair');
const CLI = path.join(ROOT, 'src', 'index.js');
const REVIEW = path.join(ROOT, 'scripts', 'review-rules.mjs');

// ground truth, also documented in bench/fe-be-pair/README.md
const EXPECT = {
  'fe-be-path-not-found': 2,      // /api/ghost-a, /api/ghost-b
  'fe-be-method-mismatch': 1,     // POST /api/wrong-method vs a GET route
  'fe-be-route-unused': 3,        // health, legacy, and GET wrong-method
  'fe-be-pairing-suspect': 0,     // 6/9 unique paths = 67%, floor is 20%
  'fe-dynamic-request-path': 1,   // '/api/orders?status=' + status
  'fe-be-shape-field-missing': 2, // nope (M3) + ghostField (M5 second stage: 0 declarations backend-wide)
};

function hermeticCopy() {
  // copy instead of analyzing in place: a test must not depend on (or leave behind)
  // an index inside the tracked fixture
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-be-pair-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  execFileSync(process.execPath, [CLI, 'analyze', 'backend'], { cwd: dir, encoding: 'utf8' });
  execFileSync(process.execPath, [CLI, 'analyze', 'frontend'], { cwd: dir, encoding: 'utf8' });
  return dir;
}

function review(dir) {
  const out = execFileSync(process.execPath,
    [REVIEW, path.join(dir, 'frontend'), '--backend', path.join(dir, 'backend'),
      '--scope', 'corpus', '--mode', 'standard', '--json', '--no-compact'],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.slice(out.indexOf('{')));
}

test('the tracked pair produces the fe-be findings its README promises', (t) => {
  const dir = hermeticCopy();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  const result = review(dir);
  const counts = {};
  for (const f of result.findings || []) counts[f.rule] = (counts[f.rule] || 0) + 1;

  const rows = [];
  for (const [rule, want] of Object.entries(EXPECT)) {
    const got = counts[rule] || 0;
    if (got !== want) rows.push(`${rule}: want ${want}, got ${got}`);
  }
  assert.deepEqual(rows, [], `findings differ from bench/fe-be-pair/README.md:\n${rows.join('\n')}`);

  // the pair must be recognised as a pair: these rows are "checked" again, so they
  // report 命中/通过 rather than 未核对 (see the honesty fix for pairing < 20%)
  const checklist = result.checklist?.rows || [];
  const statusOf = (id) => checklist.find((r) => r.id === id)?.status;
  assert.equal(statusOf('fe-be-pairing-suspect'), 'pass', 'pairing must be above the floor');
  for (const id of ['fe-be-path-not-found', 'fe-be-method-mismatch', 'fe-be-route-unused']) {
    assert.notEqual(statusOf(id), 'na', `${id} was not checked although the pair is real`);
  }
  assert.equal(statusOf('fe-be-path-not-found'), 'hit', 'the two ghosts must be reported');
  assert.equal(statusOf('fe-be-method-mismatch'), 'hit', 'the wrong verb must be reported');
  assert.equal(statusOf('fe-be-route-unused'), 'hit', 'the uncalled routes must be reported');

  // M3: the planted missing field is found, with both shapes as evidence
  const shapeFinding = (result.findings || []).find((f) => f.rule === 'fe-be-shape-field-missing');
  assert.ok(shapeFinding, 'res.data.nope must be reported');
  assert.match(shapeFinding.evidence, /returns: list,image,show/, 'the backend shape is the evidence');
  assert.match(shapeFinding.evidence, /reads: list,nope/, 'the frontend reads are the evidence');
  assert.equal(shapeFinding.line, 7, 'points at the exact read');
  assert.equal(statusOf('fe-be-shape-field-missing'), 'hit');

  // M5 second stage: /api/deep's shape is NOT comparable (depth-cap), so the rule asks
  // the declaration question instead. `ghostField` is declared nowhere in the fixture;
  // `image` is declared in another handler — one is reported, the other is not.
  const shapeFindings = (result.findings || []).filter((f) => f.rule === 'fe-be-shape-field-missing');
  const ghost = shapeFindings.find((f) => /res\.data\.ghostField/.test(f.message));
  assert.ok(ghost, 'a field declared nowhere must be reported even when the shape is unreadable');
  assert.match(ghost.evidence, /declared: 0 of \d+ php files/, `declaration search is the evidence: ${ghost.evidence}`);
  assert.match(ghost.evidence, /depth-cap/, 'names why the shape could not be compared');
  assert.ok(!shapeFindings.some((f) => /res\.data\.image/.test(f.message)),
    'a field declared elsewhere is a pairing question, not a missing field');

  const ledger = result.shape || {};
  assert.ok(ledger.checked >= 1, `comparable pairs are counted: ${JSON.stringify(ledger)}`);
  assert.ok(ledger.fallbackPairs >= 1, `the second stage ran and says so: ${JSON.stringify(ledger)}`);
  assert.equal(ledger.confirmedByDeclaration, 1, 'exactly one field had zero declarations');
  assert.ok(ledger.declaredElsewhere >= 1, 'the read declared elsewhere is counted, not reported');
});

test('the same pair keeps 未核对 rows honest when the backend is swapped for an unrelated repo', (t) => {
  const dir = hermeticCopy();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  // pair the frontend against a "backend" whose index declares no routes at all:
  // `compareBoundary` is skipped entirely (`calls.length && routes.length`), so the
  // three rows would get 0 findings — and reporting 通过 for a comparison that never
  // ran is the exact dishonesty the pairing-suspect fix targets. They must say 未核对.
  const out = execFileSync(process.execPath,
    [REVIEW, path.join(dir, 'frontend'), '--backend', path.join(dir, 'frontend'),
      '--scope', 'corpus', '--mode', 'standard', '--json', '--no-compact'],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const result = JSON.parse(out.slice(out.indexOf('{')));

  const checklist = result.checklist?.rows || [];
  for (const id of ['fe-be-path-not-found', 'fe-be-method-mismatch', 'fe-be-route-unused']) {
    const row = checklist.find((r) => r.id === id);
    assert.ok(row, `${id} must exist in the checklist`);
    assert.equal(row.status, 'na', `${id} must be 未核对 when the backend has no routes`);
    assert.match(row.reason, /0 条路由/, `${id} says why: ${row.reason}`);
    assert.match(row.reason, /未核对/, `${id} explains itself`);
  }

  // the shape check never ran either (0 comparable pairs) — it must say so, not pass
  const shape = checklist.find((r) => r.id === 'fe-be-shape-field-missing');
  assert.ok(shape, 'the shape row exists even when it cannot run');
  assert.equal(shape.status, 'na', 'shape row is 未核对 when nothing was compared');
  assert.match(shape.reason, /未核对/, `shape row explains itself: ${shape.reason}`);
});
