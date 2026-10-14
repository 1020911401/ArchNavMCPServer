/**
 * GitNexus adapter tests — fixture replay of `gitnexus list` and
 * `gitnexus context`, including repo resolution and ambiguity handling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callers, resolveRepo, parseRepoList, _resetRepoCache } from '../../src/engines/gitnexus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, '..', 'fixtures', name), 'utf-8');

const LIST = () => fixture('gitnexus-list.txt');
const FOUND = () => fixture('gitnexus-context-orderTake.json');
const FOUND_ACTIVITY = () => fixture('gitnexus-context-orderTake-activity.json');
const AMBIGUOUS = () => fixture('gitnexus-context-orderTake-ambiguous.json');

const ok = (stdout) => ({ stdout, stderr: '', code: 0, signal: null, error: null });

/** Runner: `list` → repo list; `context -f X` → the per-file fixture. */
const contextRunner = () => (bin, args) => {
  if (args[0] === 'list') return Promise.resolve(ok(LIST()));
  const f = args.includes('-f') ? args[args.indexOf('-f') + 1] : null;
  if (f === 'api/order.js') return Promise.resolve(ok(FOUND()));
  if (f === 'api/activity.js') return Promise.resolve(ok(FOUND_ACTIVITY()));
  if (f) return Promise.resolve(ok(AMBIGUOUS()));
  return Promise.resolve(ok(AMBIGUOUS()));
};

// ── repo list parsing / resolution ───────────────────────────

test('parseRepoList: parses every indexed repo from real CLI output', () => {
  const repos = parseRepoList(LIST());
  assert.equal(repos.length, 16);
  const target = repos.find((r) => r.name === 'ArchNavMCPServer');
  assert.ok(target, 'ArchNavMCPServer should be registered in the fixture');
  assert.equal(target.path, 'C:\\dev\\archnav\\bench\\.tmp-fusion');
  // alias form `name  (path)` must not swallow the parenthetical
  assert.equal(repos.find((r) => r.name === 'wxmpserver').path, 'C:\\temp\\backend-review2');
});

test('resolveRepo: explicit repo wins and skips the list call', async () => {
  let listCalls = 0;
  const runner = (bin, args) => { if (args[0] === 'list') listCalls++; return Promise.resolve(ok(LIST())); };
  const r = await resolveRepo({ repo: 'my-repo', runner });
  assert.equal(r.repo, 'my-repo');
  assert.equal(listCalls, 0);
});

test('resolveRepo: matches the repo whose Path equals projectDir', async () => {
  _resetRepoCache();
  const r = await resolveRepo({ projectDir: 'C:\\dev\\archnav\\bench\\.tmp-fusion', runner: contextRunner() });
  assert.equal(r.repo, 'ArchNavMCPServer');
  assert.equal(r.source, 'path_match');
});

test('resolveRepo: refuses to guess when several repos are indexed', async () => {
  _resetRepoCache();
  const r = await resolveRepo({ projectDir: 'C:\\nowhere', runner: contextRunner() });
  assert.equal(r.error, 'repo_required');
});

// ── callers() replay ─────────────────────────────────────────

test('callers(): found → normalised incoming.call edges', async () => {
  const r = await callers('orderTake', { repo: 'ArchNavMCPServer', file: 'api/order.js', runner: contextRunner() });
  assert.equal(r.error, undefined);
  assert.equal(r.repo, 'ArchNavMCPServer');
  assert.equal(r.callers.length, 2);
  assert.deepEqual(r.callers, [
    { file: 'pages/goods/order_details/index.vue', line: null, enclosing: 'success', engine: 'gitnexus', source_kind: 'ast' },
    { file: 'pages/users/user_invoice_order/index.vue', line: null, enclosing: 'success', engine: 'gitnexus', source_kind: 'ast' },
  ]);
});

test('callers(): ambiguous without --file resolves the best-ranked candidate', async () => {
  const r = await callers('orderTake', { repo: 'ArchNavMCPServer', runner: contextRunner() });
  assert.equal(r.ambiguous, true);
  assert.equal(r.resolved_by, 'first_candidate');
  assert.equal(r.candidates.length, 2);
  assert.equal(r.callers.length, 2); // api/order.js definition → 2 callers
  assert.equal(r.error, undefined);
});

test('callers(): allDefinitions merges every candidate definition', async () => {
  const r = await callers('orderTake', { repo: 'ArchNavMCPServer', allDefinitions: true, runner: contextRunner() });
  assert.equal(r.resolved_by, 'all_definitions');
  assert.equal(r.callers.length, 3); // order.js (2) + activity.js (1)
});

// ── error paths ──────────────────────────────────────────────

test('callers(): missing CLI on repo resolution → engine_unavailable', async () => {
  _resetRepoCache();
  const runner = () => Promise.resolve({ stdout: '', stderr: "'gitnexus' is not recognized", code: 1, signal: null, error: 'engine_unavailable' });
  const r = await callers('foo', { projectDir: 'C:\\x', runner });
  assert.equal(r.error, 'engine_unavailable');
  assert.deepEqual(r.callers, []);
});

test('callers(): unparseable context output → parse_failed', async () => {
  const runner = (bin, args) => Promise.resolve(ok(args[0] === 'list' ? LIST() : 'not json at all'));
  const r = await callers('foo', { repo: 'X', runner });
  assert.equal(r.error, 'parse_failed');
});

test('callers(): gitnexus symbol_not_found is surfaced, not thrown', async () => {
  const runner = (bin, args) => Promise.resolve(ok(JSON.stringify({ status: 'not_found' })));
  const r = await callers('nope', { repo: 'X', runner });
  assert.equal(r.error, 'symbol_not_found');
  assert.deepEqual(r.callers, []);
});

test('callers(): a throwing runner is contained — callers() still never throws', async () => {
  const runner = () => { throw new Error('boom'); };
  const r = await callers('foo', { repo: 'X', runner });
  assert.equal(r.error, 'cli_error');
  assert.deepEqual(r.callers, []);
});
