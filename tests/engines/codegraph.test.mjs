/**
 * CodeGraph adapter tests — fixture replay of captured CLI output plus the real
 * child_process failure path (missing binary).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callers, parseCallersText, parseCallersJson } from '../../src/engines/codegraph.js';
import { runCli } from '../../src/engines/exec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, '..', 'fixtures', name), 'utf-8');

/** A runner that answers every invocation with the same captured stdout. */
const staticRunner = (stdout) => () =>
  Promise.resolve({ stdout, stderr: '', code: 0, signal: null, error: null });

// ── text parser ──────────────────────────────────────────────

test('parseCallersText: zero-caller output yields no callers, no error', () => {
  const r = parseCallersText(fixture('codegraph-callers-orderTake.txt'), 'orderTake');
  assert.equal(r.symbol, 'orderTake');
  assert.deepEqual(r.callers, []);
});

test('parseCallersText: extracts method + import callers with provenance', () => {
  const r = parseCallersText(fixture('codegraph-callers-getOrderDetail.txt'), 'getOrderDetail');
  assert.equal(r.symbol, 'getOrderDetail');
  assert.equal(r.callers.length, 11);
  assert.deepEqual(r.callers[0], {
    file: 'pages/goods/order_pay_status/index.vue',
    line: 273,
    enclosing: 'getOrderPayInfo',
    engine: 'codegraph',
    source_kind: 'ast',
  });
  const imports = r.callers.filter((c) => c.source_kind === 'import');
  assert.equal(imports.length, 6);
  assert.ok(imports.every((c) => c.enclosing === null));
});

// ── json parser ──────────────────────────────────────────────

test('parseCallersJson: same 11 callers, split into ast + import', () => {
  const json = JSON.parse(fixture('codegraph-callers-getOrderDetail.json'));
  const r = parseCallersJson(json, 'getOrderDetail', json);
  assert.equal(r.callers.length, 11);
  assert.equal(r.callers.filter((c) => c.source_kind === 'ast').length, 5);
  assert.equal(r.callers.filter((c) => c.source_kind === 'import').length, 6);
  assert.ok(r.callers.every((c) => c.engine === 'codegraph'));
});

// ── callers() replay ─────────────────────────────────────────

test('callers(): prefers JSON when the CLI emits it', async () => {
  const r = await callers('getOrderDetail', { runner: staticRunner(fixture('codegraph-callers-getOrderDetail.json')) });
  assert.equal(r.error, undefined);
  assert.equal(r.symbol, 'getOrderDetail');
  assert.equal(r.callers.length, 11);
  assert.equal(typeof r.raw, 'object');
});

test('callers(): falls back to text parsing when JSON is absent', async () => {
  const r = await callers('getOrderDetail', { runner: staticRunner(fixture('codegraph-callers-getOrderDetail.txt')) });
  assert.equal(r.callers.length, 11);
  assert.equal(r.callers[0].enclosing, 'getOrderPayInfo');
});

test('callers(): a genuinely empty result is not an error', async () => {
  const r = await callers('orderTake', { runner: staticRunner(fixture('codegraph-callers-orderTake.json')) });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.callers, []);
  assert.equal(r.symbol, 'orderTake');
});

test('callers(): -f narrowing replay returns 0 callers for orderTake/order.js', async () => {
  const r = await callers('orderTake', { file: 'api/order.js', runner: staticRunner(fixture('codegraph-callers-orderTake-filtered.json')) });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.callers, []);
});

// ── error paths (never throw) ────────────────────────────────

test('callers(): missing CLI surfaces engine_unavailable, never throws', async () => {
  const runner = () => Promise.resolve({ stdout: '', stderr: "'codegraph' is not recognized", code: 1, signal: null, error: 'engine_unavailable' });
  const r = await callers('foo', { runner });
  assert.equal(r.error, 'engine_unavailable');
  assert.deepEqual(r.callers, []);
});

test('callers(): unparseable output surfaces parse_failed with raw preserved', async () => {
  const r = await callers('foo', { runner: staticRunner('<html>boom</html>') });
  assert.equal(r.error, 'parse_failed');
  assert.match(r.raw, /boom/);
  assert.deepEqual(r.callers, []);
});

test('callers(): timeout is surfaced, never throws', async () => {
  const runner = () => Promise.resolve({ stdout: 'partial', stderr: '', code: null, signal: 'SIGTERM', error: 'timeout' });
  const r = await callers('foo', { runner });
  assert.equal(r.error, 'timeout');
  assert.deepEqual(r.callers, []);
});

test('runCli(): real spawn of a missing binary reports engine_unavailable', async () => {
  const res = await runCli('archnav-definitely-not-a-real-cli-xyz', ['--help'], { timeoutMs: 8000 });
  assert.equal(res.error, 'engine_unavailable');
  assert.equal(typeof res.stdout, 'string');
});

test('runCli(): non-zero real exit is captured with code + stderr', async () => {
  // `node -e "process.exit(3)"` exits non-zero without being "missing".
  const res = await runCli(process.execPath, ['-e', 'process.stderr.write("nope"); process.exit(3)'], { timeoutMs: 8000 });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /nope/);
  assert.ok(res.error === 'cli_error' || res.error === 'engine_unavailable');
});

test('runCli(): timeout kills the child and reports timeout', async () => {
  const res = await runCli(process.execPath, ['-e', 'setTimeout(()=>{}, 100000)'], { timeoutMs: 700 });
  assert.equal(res.error, 'timeout');
});
