/**
 * Optional real-CLI smoke tests.
 *
 * These hit the actual `codegraph` / `gitnexus` binaries against a freshly
 * indexed copy of the bench app. They SKIP (never fail) when the index, the
 * repo registration or the binary is missing — so `node --test tests/engines/`
 * is green on a clean checkout — and skip on a timeout too.
 *
 * Run against a fresh copy with:
 *   node --test tests/engines/smoke.test.mjs
 * (with bench/.tmp-fusion present), or force with ARCHNAV_SMOKE=1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callers as codegraphCallers } from '../../src/engines/codegraph.js';
import { callers as gitnexusCallers } from '../../src/engines/gitnexus.js';
import { mergeCalls } from '../../src/fusion.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const smokeDir = process.env.ARCHNAV_SMOKE_DIR || path.join(root, 'bench', '.tmp-fusion');
const forced = process.env.ARCHNAV_SMOKE === '1';
const hasIndex = fs.existsSync(path.join(smokeDir, '.codegraph'));

const SKIP = 'no freshly indexed bench/.tmp-fusion (run codegraph init there, or set ARCHNAV_SMOKE_DIR)';

test('smoke: real codegraph CLI finds callers on a fresh index', { timeout: 180000 }, async (t) => {
  if (!hasIndex && !forced) return t.skip(SKIP);
  const r = await codegraphCallers('getOrderDetail', { projectDir: smokeDir, timeoutMs: 120000 });
  if (r.error) return t.skip(`codegraph unavailable: ${r.error}`);
  assert.ok(r.callers.length >= 1, `expected callers for getOrderDetail, got ${r.callers.length}`);
  assert.ok(r.callers.every((c) => c.engine === 'codegraph'));
});

test('smoke: codegraph 0 · gitnexus 2 · fused 2 for orderTake', { timeout: 180000 }, async (t) => {
  if (!hasIndex && !forced) return t.skip(SKIP);

  const cg = await codegraphCallers('orderTake', { projectDir: smokeDir, timeoutMs: 120000 });
  if (cg.error) return t.skip(`codegraph unavailable: ${cg.error}`);

  const gn = await gitnexusCallers('orderTake', { projectDir: smokeDir, file: 'api/order.js', timeoutMs: 120000 });
  if (gn.error) return t.skip(`gitnexus unavailable: ${gn.error}`);

  // Documented divergence: codegraph's static index misses the call sites that
  // live inside nested `.vue` handlers; gitnexus resolves both of them.
  assert.equal(cg.callers.length, 0, 'codegraph is expected to report 0 callers for orderTake');
  assert.equal(gn.callers.length, 2, 'gitnexus is expected to report 2 callers for orderTake');

  const fused = mergeCalls([{ ...cg, engine: 'codegraph' }, { ...gn, engine: 'gitnexus' }]);
  assert.equal(fused.callers.length, 2);
  assert.deepEqual(fused.callers[0].engines, ['gitnexus']);
  assert.equal(fused.callers[0].confidence, 1);
});
