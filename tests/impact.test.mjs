/**
 * impact() tests — the *indirect* impact of a symbol must be derived from the
 * knowledge graph (reverse DEPENDS_ON traversal, depth ≤ 2), never from
 * "this file imports that file" basename guesswork.
 *
 * These run against the real benchmark indexes committed-next-to-the-repo:
 *   bench/php-app  (Laravel)  — `node src/index.js analyze <dir>` rebuilds them
 *   bench/vue-app  (uni-app)
 *
 * Run: node --test tests/impact.test.mjs
 */
import { test } from 'node:test';
import { testWithFixtures } from './helpers/fixtures.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { archNav } from '../src/navigation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PHP = path.resolve(here, '..', 'bench', 'php-app');
const VUE = path.resolve(here, '..', 'bench', 'vue-app');

const posix = (p) => String(p ?? '').replace(/\\/g, '/');

/** Every relation (direct or indirect) of an impact result. */
function allRelations(r) {
  return [...(r.direct_impact || []), ...(r.indirect_relations ?? r.indirect_impact ?? [])];
}

/** Evidence required on every relation we emit. */
function assertEvidence(rel, where) {
  assert.equal(typeof rel.symbol, 'string', `${where}: symbol`);
  assert.equal(typeof rel.file, 'string', `${where}: file`);
  assert.ok(rel.line !== undefined && rel.line !== null, `${where}: line`);
  assert.equal(typeof rel.source_kind, 'string', `${where}: source_kind must record the graph evidence`);
  assert.equal(typeof rel.confidence, 'number', `${where}: confidence`);
  assert.ok(rel.confidence > 0 && rel.confidence <= 1, `${where}: confidence in (0,1]`);
}

// ── (a) direct impact comes from real call sites ────────────────────────────

testWithFixtures('impact(departments) direct impact covers the 6 real call sites', async () => {
  const r = await archNav.impact('departments', PHP);
  assert.equal(r.type, 'impact');
  assert.notEqual(r.ambiguous, true);
  assert.ok(Array.isArray(r.direct_impact));

  const got = r.direct_impact.map(d => `${posix(d.file)}:${d.line}`);
  for (const want of [
    'app/Http/Controllers/AnalysesController.php:191',
    'app/Http/Controllers/CustomersController.php:108',
    'app/Http/Controllers/MiniBookingsController.php:133',
    'app/Http/Controllers/PatientsController.php:198',
    'app/Http/Controllers/PatientsController.php:345',
    'app/Http/Controllers/PatientsController.php:430',
  ]) {
    assert.ok(got.includes(want), `missing direct call site ${want} (got ${got.join(', ')})`);
  }

  for (const d of r.direct_impact) {
    assert.equal(d.depth, 1, 'direct impact is depth 1');
    assert.equal(d.via, null, 'direct impact has no intermediate symbol');
    assertEvidence(d, 'direct');
  }
});

// ── (b) depth=2 indirect impact, reached through a caller, with `via` ───────

testWithFixtures('impact(departments) reports depth=2 indirect relations, each with a via', async () => {
  const r = await archNav.impact('departments', PHP);
  const ind = r.indirect_relations ?? r.indirect_impact;
  assert.ok(Array.isArray(ind), 'indirect_relations must be an array');
  assert.ok(ind.length > 0, 'expected at least one depth-2 relation');

  for (const rel of ind) {
    assert.equal(rel.depth, 2, 'indirect relations are depth 2');
    assert.equal(typeof rel.via, 'string', 'every indirect relation carries the intermediate symbol name');
    assert.ok(rel.via.length > 0, 'via must not be empty');
    assertEvidence(rel, 'indirect');
  }

  // DepartmentsController::listing() calls departments(); PatientsController::index()
  // calls listing() — so index() is a genuine 2-hop dependent.
  const hit = ind.find(x => x.file === 'app/Http/Controllers/PatientsController.php' && x.symbol === 'index');
  assert.ok(hit, `expected PatientsController::index at depth 2 (got ${JSON.stringify(ind)})`);
  assert.equal(hit.via, 'listing');
  assert.equal(hit.line, 92);
});

// ── (c) no import-basename heuristic in the impact result ───────────────────

testWithFixtures('impact(departments) emits only graph-evidenced relations (no import-heuristic)', async () => {
  const r = await archNav.impact('departments', PHP);
  const rels = allRelations(r);
  assert.ok(rels.length > 0, 'impact must not be empty');
  for (const rel of rels) {
    assert.notEqual(rel.source, 'import-heuristic', 'impact must not guess via file imports');
    assert.ok(
      ['ast', 'template', 'callback', 'heuristic', 'graph', 'route'].includes(rel.source_kind),
      `unexpected source_kind ${rel.source_kind}`,
    );
    assertEvidence(rel, 'departments');
  }
});

// ── (d) the known false positive is gone ────────────────────────────────────

testWithFixtures('impact(orderTake, {file: api/order.js}) drops the import-only mixin false positive', async () => {
  const r = await archNav.impact('orderTake', VUE, { file: 'api/order.js' });
  assert.notEqual(r.ambiguous, true);
  assert.equal(posix(r.file), 'api/order.js');

  const rels = allRelations(r);
  assert.ok(rels.length > 0, 'the 2 callback call sites must still be reported');
  assert.ok(
    !rels.some(x => /skuSelect/i.test(posix(x.file))),
    'mixins/skuSelect.js only *imports* api/order.js — it is not on the call chain',
  );
  assert.ok(!rels.some(x => x.source === 'import-heuristic'));

  const files = rels.map(x => posix(x.file));
  assert.ok(files.includes('pages/goods/order_details/index.vue'));
  assert.ok(files.includes('pages/users/user_invoice_order/index.vue'));
  for (const rel of rels) assertEvidence(rel, 'orderTake');
});

// ── (e) ambiguity is preserved ──────────────────────────────────────────────

testWithFixtures('impact(orderTake) without --file stays ambiguous with candidates', async () => {
  const r = await archNav.impact('orderTake', VUE);
  assert.equal(r.ambiguous, true);
  assert.ok(Array.isArray(r.candidates));
  assert.deepEqual(
    r.candidates.map(c => posix(c.file)).sort(),
    ['api/activity.js', 'api/order.js'],
  );
});

// ── file:-prefixed call sites (Blade / .vue) are files, not symbols ─────────

testWithFixtures('impact(showSelectOptions, {file: DepartmentPresenter}) reports Blade call sites as files', async () => {
  const r = await archNav.impact('showSelectOptions', PHP, { file: 'app/Presenters/DepartmentPresenter.php' });
  assert.notEqual(r.ambiguous, true);

  const blade = r.direct_impact.find(x => posix(x.file) === 'views/analyses/member.blade.php');
  assert.ok(blade, `expected the Blade call site (got ${JSON.stringify(r.direct_impact)})`);
  assert.equal(blade.line, 46);
  assert.equal(blade.symbol, 'member.blade.php', 'a file: node is attributed to the file, not to a symbol');
  assert.equal(blade.source_kind, 'template');
  assert.equal(blade.depth, 1);
  for (const rel of r.direct_impact) assertEvidence(rel, 'blade');
});

// ── backward compatibility ─────────────────────────────────────────────────

testWithFixtures('impact() keeps direct_impact/indirect_impact field names', async () => {
  const r = await archNav.impact('departments', PHP);
  assert.ok(Array.isArray(r.direct_impact));
  assert.ok(Array.isArray(r.indirect_impact), 'indirect_impact is kept as the legacy alias');
  assert.deepEqual(r.indirect_impact, r.indirect_relations);
});
