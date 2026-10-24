/**
 * TDD test — PHP call edges must produce real CALLS/DEPENDS_ON relationships.
 *
 * Acceptance:
 *   - knowledgeGraph.edges contains type:'DEPENDS_ON' edges after indexing bench/php-app
 *   - callers('departments') covers all 6 known call sites (file + line, ±2)
 *
 * Run: node --test tests/php-calls.test.mjs
 */
import { test, before } from 'node:test';
import { testWithFixtures } from './helpers/fixtures.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const PHP_APP = path.join(REPO, 'bench', 'php-app');
const INDEX = path.join(PHP_APP, '.archnav', 'index.json');

// `departments()` is defined in app/Http/Controllers/Controller.php:56 and called at 6 sites.
const DEF_FILE = 'app/Http/Controllers/Controller.php';
const DEF_LINE = 56;
const EXPECTED_CALLS = [
  ['app/Http/Controllers/AnalysesController.php', 191],
  ['app/Http/Controllers/CustomersController.php', 108],
  ['app/Http/Controllers/MiniBookingsController.php', 133],
  ['app/Http/Controllers/PatientsController.php', 198],
  ['app/Http/Controllers/PatientsController.php', 345],
  ['app/Http/Controllers/PatientsController.php', 430],
];

const norm = (p) => String(p || '').replace(/\\/g, '/');

let index;

before(() => {
  const r = spawnSync(process.execPath, ['src/index.js', 'analyze', 'bench/php-app'], {
    cwd: REPO,
    stdio: 'ignore',
  });
  assert.equal(r.status, 0, 'analyze must exit 0');
  index = JSON.parse(fs.readFileSync(INDEX, 'utf-8'));
});

testWithFixtures('knowledgeGraph has DEPENDS_ON edges for PHP', () => {
  const edges = index.knowledgeGraph?.edges || [];
  const dependsOn = edges.filter((e) => e.type === 'DEPENDS_ON');
  // Diagnostic breadcrumb for the failure message
  const byType = {};
  for (const e of edges) byType[e.type] = (byType[e.type] || 0) + 1;
  assert.ok(
    dependsOn.length > 0,
    `expected DEPENDS_ON edges, got edge types: ${JSON.stringify(byType)}`
  );
});

testWithFixtures('callers(departments) covers all 6 call sites', () => {
  const r = spawnSync(
    process.execPath,
    ['src/index.js', 'callers', 'departments', '--dir', 'bench/php-app', '--json'],
    { cwd: REPO, encoding: 'utf-8' }
  );
  assert.equal(r.status, 0, `callers must exit 0 (stderr: ${r.stderr})`);
  const result = JSON.parse(r.stdout);
  const relations = result.relations || [];

  const covered = (file, line) =>
    relations.some((rel) => norm(rel.file) === file && Math.abs(Number(rel.line) - line) <= 2);

  const missing = EXPECTED_CALLS.filter(([f, l]) => !covered(f, l));
  assert.equal(
    missing.length,
    0,
    `missing call sites: ${JSON.stringify(missing)}\nrelations: ${JSON.stringify(relations, null, 2)}`
  );

  // The method *definition* must not be reported as a caller of itself.
  const defSelfCall = relations.find(
    (rel) => norm(rel.file) === DEF_FILE && Math.abs(Number(rel.line) - DEF_LINE) <= 2
  );
  assert.equal(defSelfCall, undefined, `definition reported as caller: ${JSON.stringify(defSelfCall)}`);
});
