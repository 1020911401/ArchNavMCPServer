/**
 * Tests for src/resolver/index.js — repo-wide scans and the unified edge shape.
 *
 * NOTE: the relative-path assertions ('bench/php-app') assume the tests are run
 * from the repository root, e.g. `node --test tests/resolver/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scanTemplateCalls,
  scanCallbackCalls,
  scanImportEdges,
  toEdges,
} from '../../src/resolver/index.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('scanTemplateCalls: showSelectOptions → >=40 sites across >=19 files', () => {
  const calls = scanTemplateCalls('bench/php-app');
  const sel = calls.filter(c => c.callee === 'showSelectOptions');
  assert.ok(sel.length >= 40, `call sites >= 40, got ${sel.length}`);
  const files = new Set(sel.map(c => c.file));
  assert.ok(files.size >= 19, `distinct files >= 19, got ${files.size}`);
  // shape
  assert.ok(sel.every(c => typeof c.file === 'string' && typeof c.var === 'string' && typeof c.line === 'number'));
});

test('scanTemplateCalls: absolute repoDir behaves the same', () => {
  const calls = scanTemplateCalls(path.join(repo, 'bench', 'php-app'));
  assert.ok(calls.filter(c => c.callee === 'showSelectOptions').length >= 40);
});

test('scanCallbackCalls: orderTake@1316 is recovered as a callback call', () => {
  const calls = scanCallbackCalls(path.join(repo, 'bench', 'vue-app'));
  const hit = calls.find(c => c.callee === 'orderTake'
    && c.file === 'pages/goods/order_details/index.vue'
    && c.line === 1316);
  assert.ok(hit, 'orderTake@1316 found by the repo-wide callback scan');
  assert.equal(hit.kind, 'callback');
  assert.match(String(hit.enclosing), /success/);
});

test('scanImportEdges: getUserInfo covers >=30 distinct `from` files', () => {
  const edges = scanImportEdges(path.join(repo, 'bench', 'vue-app'));
  const g = edges.filter(e => e.symbol === 'getUserInfo');
  const froms = new Set(g.map(e => e.from));
  assert.ok(froms.size >= 30, `distinct from files >= 30, got ${froms.size}`);
  assert.ok(g.every(e => e.source_kind === 'import'), 'all are import edges');
  assert.ok(g.every(e => typeof e.line === 'number' && typeof e.to === 'string'));
});

test('toEdges: unified {from,to,line,type,source_kind} shape for all three kinds', () => {
  const edges = toEdges(repo);
  assert.ok(edges.length > 0, 'edges produced');
  assert.ok(edges.every(e =>
    typeof e.from === 'string' && typeof e.to === 'string'
    && typeof e.line === 'number' && e.type === 'CALLS'
    && ['template', 'callback', 'import'].includes(e.source_kind)));
  const kinds = new Set(edges.map(e => e.source_kind));
  assert.ok(kinds.has('template'), 'has template edges');
  assert.ok(kinds.has('callback'), 'has callback edges');
  assert.ok(kinds.has('import'), 'has import edges');
});
