// bench/gen_ground_truth.test.mjs
//
// Run with:  node --test bench/gen_ground_truth.test.mjs
//
// Asserts the four independently verified ground-truth numbers against the
// bench/php-app and bench/vue-app fixtures.
//
// TWO MEASUREMENT NUANCES the parent's figures hinge on (documented in
// bench/README.md, both re-checked against grep here):
//
//  * showSelectOptions — the parent's "40 calls / 19 files" is scoped to
//    `*.blade.php`. A full-repo .php scan additionally finds 4 calls in the
//    stale backup view `views/patients/create.blade.20230516.php` (44/20).
//    This test asserts the blade-scoped 40/19 AND the full-repo 44/20.
//
//  * getUserInfo — "36 call sites" excludes the 2 definition lines
//    (api/user.js:17, api/admin.js:360) AND 8 object-method shorthand definitions
//    (`getUserInfo() {`), which are reported separately as `methodDefs`.
//    Call-site-bearing files = 32; files containing ANY bare mention
//    (definitions included) = 36 = the parent's grep `-l` figure.
//    `callerFiles` is the semantic "who calls it" set. This test asserts both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groundTruth, scanRepo } from './gen_ground_truth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHP = path.join(HERE, 'php-app');
const VUE = path.join(HERE, 'vue-app');

const pos = (list) => list.map((s) => `${s.file}:${s.line}`);

/** Files holding ANY non-comment bare mention of symbol, definitions included. */
function mentionFiles(repoDir, symbol) {
  const scan = scanRepo(repoDir);
  const set = new Set();
  for (const f of scan.files) {
    for (const ln of f.lines) {
      if (ln.isComment) continue;
      if (ln.defName === symbol || ln.callNames.includes(symbol)) set.add(f.rel);
    }
  }
  return [...set].sort();
}

test('php-app: departments -> 1 definition, 6 call sites in 4 files', () => {
  // --- scanRepo sanity: right extensions, skipped dirs, known files present ---
  const scan = scanRepo(PHP);
  assert.ok(scan.files.length > 0, 'expected to scan some files');
  for (const f of scan.files) {
    assert.ok(
      ['.php', '.js', '.mjs', '.ts', '.vue'].includes(f.ext),
      `unexpected extension scanned: ${f.rel}`,
    );
    for (const seg of f.rel.split('/')) {
      assert.ok(
        !['node_modules', '.git', '.codegraph', '.gitnexus', '.archnav'].includes(seg),
        `skipped dir leaked into scan: ${f.rel}`,
      );
    }
  }
  const rels = new Set(scan.files.map((f) => f.rel));
  assert.ok(rels.has('app/Http/Controllers/Controller.php'));
  assert.ok(rels.has('views/analyses/member.blade.php'));

  const gt = groundTruth(PHP, 'departments');

  assert.equal(gt.defs.length, 1);
  assert.deepEqual(pos(gt.defs), ['app/Http/Controllers/Controller.php:56']);

  assert.deepEqual(pos(gt.callSites), [
    'app/Http/Controllers/AnalysesController.php:191',
    'app/Http/Controllers/CustomersController.php:108',
    'app/Http/Controllers/MiniBookingsController.php:133',
    'app/Http/Controllers/PatientsController.php:198',
    'app/Http/Controllers/PatientsController.php:345',
    'app/Http/Controllers/PatientsController.php:430',
  ]);
  assert.equal(gt.callSites.length, 6);

  assert.deepEqual(gt.callerFiles, [
    'app/Http/Controllers/AnalysesController.php',
    'app/Http/Controllers/CustomersController.php',
    'app/Http/Controllers/MiniBookingsController.php',
    'app/Http/Controllers/PatientsController.php',
  ]);
  assert.equal(gt.callerFiles.length, 4);
});

test('php-app: showSelectOptions -> 8 definitions; 40 blade call sites in 19 files (44/20 full-repo)', () => {
  const gt = groundTruth(PHP, 'showSelectOptions');

  // --- the parent's figure: *.blade.php only ---
  const bladeSites = gt.callSites.filter((s) => s.file.endsWith('.blade.php'));
  assert.equal(bladeSites.length, 40);
  assert.equal(new Set(bladeSites.map((s) => s.file)).size, 19);

  // --- 8 definitions, all in app/Presenters/*Presenter.php ---
  assert.equal(gt.defs.length, 8);
  for (const d of gt.defs) {
    assert.match(d.file, /^app\/Presenters\/.*Presenter\.php$/);
  }

  // --- full-repo truth: 4 extra calls live in one stale dated backup view ---
  assert.equal(gt.callSites.length, 44);
  assert.equal(gt.callerFiles.length, 20);
  const extras = gt.callSites.filter((s) => !s.file.endsWith('.blade.php'));
  assert.deepEqual([...new Set(extras.map((s) => s.file))], [
    'views/patients/create.blade.20230516.php',
  ]);
  assert.equal(extras.length, 4);
});

test('vue-app: orderTake -> 3 call sites in 3 files', () => {
  const gt = groundTruth(VUE, 'orderTake');

  assert.equal(gt.callSites.length, 3);
  assert.deepEqual(gt.callerFiles, [
    'pages/goods/order_details/index.vue',
    'pages/points_mall/integral_order_details.vue',
    'pages/users/user_invoice_order/index.vue',
  ]);
  assert.equal(gt.callerFiles.length, 3);
});

test('vue-app: getUserInfo -> 36 call sites; definitions (incl. method shorthand) are excluded', () => {
  const gt = groundTruth(VUE, 'getUserInfo');

  // 36 call sites: the 2 `function getUserInfo(` definitions PLUS 8 object/class
  // method shorthand definitions (`getUserInfo() {` inside a Vue component's
  // methods object — Authorize.vue:99, libs/routine.js:80, scan_login:79, …)
  // are all excluded. Before the shorthand rule existed this number was 44;
  // the 8 extra "call sites" were local method declarations, verified by reading
  // each of them (they declare a same-named local symbol, they do not call it).
  assert.equal(gt.callSites.length, 36);

  // callerFiles = files carrying a real call site => 32 (was 34)
  assert.equal(gt.callerFiles.length, 32);

  // method-shorthand definitions are reported separately so the excluded lines
  // stay auditable instead of silently vanishing
  assert.equal(gt.methodDefs.length, 8);
  assert.ok(pos(gt.methodDefs).includes('components/Authorize.vue:99'));
  assert.ok(pos(gt.methodDefs).includes('libs/routine.js:80'));

  // files containing ANY bare mention, definitions included => parent's grep -l figure, 36
  assert.equal(mentionFiles(VUE, 'getUserInfo').length, 36);

  // the definition line must be recognised as a def, not a call site
  assert.ok(pos(gt.defs).includes('api/user.js:17'), 'api/user.js:17 must be a definition');
  assert.ok(pos(gt.defs).includes('api/admin.js:360'), 'api/admin.js:360 must be a definition');
  assert.ok(
    !pos(gt.callSites).includes('api/user.js:17'),
    'api/user.js:17 must NOT be counted as a call site',
  );
});
