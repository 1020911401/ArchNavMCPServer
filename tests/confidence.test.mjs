/**
 * Confidence / staleness tests.
 *
 * The index records a content hash per file in `.archnav/index.json`
 * (`fileHashes`). These tests pin the requirement that staleness is driven by
 * *content* drift on disk, not just by git commit comparison — so a change made
 * outside of git (or in a tree with no `.git` at all, like the bench fixture)
 * is still detected.
 *
 * Run: node --test tests/confidence.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, saveIndex } from '../src/analyzer.js';
import { checkStaleness, computeConfidence, symbolConfidence } from '../src/confidence.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sourceDir = path.join(root, 'bench', 'php-app');

// Private working copy — keeps this test from racing the parallel tasks that
// use bench/php-app directly.
const workDir = path.join(root, 'bench', '.tmp-stale');

let index;
let targetKey;   // fileHashes key (host separators)
let targetRel;   // forward-slash relative path
let targetAbs;   // absolute path on disk

const norm = (p) => String(p).replace(/\\/g, '/');

before(async () => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, workDir, { recursive: true });

  // Build a fresh index for the copy (this is the source of truth we test against).
  const result = await analyze(workDir, { cluster: false });
  saveIndex(workDir, result._raw || result);

  index = JSON.parse(fs.readFileSync(path.join(workDir, '.archnav', 'index.json'), 'utf-8'));

  const keys = Object.keys(index.fileHashes || {});
  assert.ok(keys.length > 0, 'fixture index must contain fileHashes');
  targetKey = keys.find((k) => k.toLowerCase().endsWith('.php')) || keys[0];
  targetRel = norm(targetKey);
  targetAbs = path.resolve(workDir, targetKey);
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('an untouched tree reports fresh with full confidence', async () => {
  const r = await checkStaleness(workDir);
  assert.equal(r.stale, false, 'untouched copy must not be stale');
  assert.equal(r.overallConfidence, 1, 'untouched copy must be fully confident');
  assert.equal(r.changedFiles, 0);
  assert.deepEqual(r.changedDetails, []);
});

test('staleness detection works on a tree with no git metadata at all', async () => {
  assert.equal(fs.existsSync(path.join(workDir, '.git')), false);
  assert.equal(fs.existsSync(path.join(workDir, '.archnav', 'commit')), false);

  const r = await checkStaleness(workDir);
  assert.equal(r.stale, false);
  assert.equal(r.indexedCommit, null);
  assert.equal(r.currentHead, null);
});

test('appending a comment to an indexed .php file marks the index stale', async () => {
  fs.appendFileSync(targetAbs, '\n// stale probe\n');

  const r = await checkStaleness(workDir);
  assert.equal(r.stale, true, 'a content edit must make the index stale');
  assert.ok(r.overallConfidence < 1, `overallConfidence must drop below 1 (got ${r.overallConfidence})`);
  assert.ok(r.changedFiles >= 1, `changedFiles must be >= 1 (got ${r.changedFiles})`);
  assert.ok(
    r.changedDetails.some((d) => norm(d.file) === targetRel),
    `changedDetails must include ${targetRel} — got ${JSON.stringify(r.changedDetails)}`
  );
});

test('symbolConfidence graduates for a changed file and is 1.0 when untouched', () => {
  // An untouched file still matches its indexed hash.
  const freshKey = Object.keys(index.fileHashes).find(
    (k) => k.toLowerCase().endsWith('.php') && norm(k) !== targetRel
  );
  assert.ok(freshKey, 'expected a second indexed .php file');
  assert.equal(symbolConfidence({ file: norm(freshKey) }, index, workDir), 1);

  // The file we appended to must report a graduated value in [0.28, 0.5].
  const changed = symbolConfidence({ file: targetRel }, index, workDir);
  assert.ok(
    changed >= 0.28 && changed < 1 && changed <= 0.5,
    `expected a graduated value in [0.28, 0.5], got ${changed}`
  );

  // computeConfidence (the locate() path) must agree.
  assert.equal(computeConfidence(targetRel, index.fileHashes, {}, workDir), changed);
});
