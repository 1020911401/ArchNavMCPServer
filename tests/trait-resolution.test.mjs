/**
 * Trait hops + honest risk — the two gaps a measured evaluation exposed (2026-11-02).
 *
 * On a 1,154-file Laravel repo, `callers stringParam` reported 13 of 19 real call
 * sites and `impact stringParam` printed `🟢 Risk: LOW` while 6 call sites lived in
 * classes that `use LegacyRequestParams;`. The missing hop was the trait: `$this->m()`
 * was resolved inside the file and through the parent class, never through a used
 * trait, so every such call fell into `unresolvedScopedCalls` — silently.
 *
 * Three guarantees are pinned here:
 *   1. `$this->m()` resolves into a used trait, and only into that trait;
 *   2. risk never says LOW while same-named scoped calls are unresolved;
 *   3. `read Class.method` answers (it used to fall back to grep and report "not found").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyze, saveIndex } from '../src/analyzer.js';
import { archNav, gradeRisk } from '../src/navigation.js';
import { readCode } from '../src/reader.js';

const writeRepo = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-trait-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return dir;
};
const php = (lines) => lines.join('\n');

const PARAMS_TRAIT = php([
  '<?php',
  'namespace App\\Concerns;',
  'trait LegacyRequestParams {',
  '  private function stringParam($request, $name, $default) { return $default; }',
  '}',
]);
const USER_A = php([
  '<?php',
  'namespace App\\Pc;',
  'use App\\Concerns\\LegacyRequestParams;',
  'class ProductController {',
  '  use LegacyRequestParams;',
  '  public function list($request) { return $this->stringParam($request, "kw", ""); }',
  '}',
]);
const USER_B = php([
  '<?php',
  'namespace App\\Kefu;',
  'use App\\Concerns\\LegacyRequestParams;',
  'class OrderController {',
  '  use LegacyRequestParams;',
  '  public function show($request) { return $this->stringParam($request, "id", ""); }',
  '}',
]);
// Same method name, no trait: must never become the target of the calls above.
const IMPOSTOR = php([
  '<?php',
  'namespace App\\Other;',
  'class OwnThing {',
  '  private function stringParam() { return 1; }',
  '}',
]);

test('$this->m() resolves into a used trait, not into a same-named method elsewhere', async () => {
  const dir = writeRepo({
    'Concerns/LegacyRequestParams.php': PARAMS_TRAIT,
    'Pc/ProductController.php': USER_A,
    'Kefu/OrderController.php': USER_B,
    'Other/OwnThing.php': IMPOSTOR,
  });
  try {
    const res = await analyze(dir, {});

    const cls = res.symbols.find((s) => s.name === 'ProductController' && s.kind === 'class');
    assert.deepEqual(cls.traits, ['LegacyRequestParams'], 'the class records the trait it uses');

    const edges = res.knowledgeGraph.edges
      .filter((e) => e.from === 'sym:Pc/ProductController.php::list' && e.type === 'DEPENDS_ON')
      .map((e) => e.to);
    assert.ok(edges.includes('sym:Concerns/LegacyRequestParams.php::stringParam'),
      'the call lands on the trait method');
    assert.equal(edges.some((t) => t.startsWith('sym:Other/OwnThing.php')), false,
      'a same-named method in an unrelated class is not the target');

    assert.ok(res.knowledgeGraph.scopedCallStats.resolvedViaTrait >= 2,
      'both trait-using call sites are counted as trait hops');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('callers for a trait method lists the using classes instead of (none)', async () => {
  const dir = writeRepo({
    'Concerns/LegacyRequestParams.php': PARAMS_TRAIT,
    'Pc/ProductController.php': USER_A,
    'Kefu/OrderController.php': USER_B,
  });
  try {
    const res = await analyze(dir, {});
    saveIndex(dir, res);
    const out = await archNav.callers('stringParam', dir, {});
    const files = (out.relations || []).map((r) => r.file);
    assert.ok(files.includes('Pc/ProductController.php'), 'the Pc controller is a caller');
    assert.ok(files.includes('Kefu/OrderController.php'), 'the Kefu controller is a caller');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('risk never reads LOW while same-named scoped calls are unresolved', () => {
  const clean = gradeRisk({ direct: [{ file: 'app/a/x.php' }], indirect: [] });
  assert.equal(clean.level, 'LOW', 'a small, fully resolved blast radius stays LOW');

  const capped = gradeRisk({ direct: [{ file: 'app/a/x.php' }], indirect: [], unresolvedSameName: 6 });
  assert.equal(capped.level, 'UNKNOWN', 'invisible call sites must not be graded safe');
  assert.equal(capped.unresolvedSameName, 6);
  assert.match(capped.note, /6 处同名/);

  const empty = gradeRisk({ direct: [], indirect: [], unresolvedSameName: 3 });
  assert.equal(empty.level, 'UNKNOWN', 'an empty list plus blind spots is UNKNOWN, not LOW');

  const trulyEmpty = gradeRisk({ direct: [], indirect: [] });
  assert.equal(trulyEmpty.level, 'LOW', 'nothing unresolved: an honest LOW is still allowed');
});

test('read Class.method returns the method body', async () => {
  const dir = writeRepo({
    'Greeter.php': php(['<?php', 'class Greeter {', '  public function hello($who) {', '    return "hi " . $who;', '  }', '}']),
  });
  try {
    const res = await analyze(dir, {});
    saveIndex(dir, res);
    const out = await readCode('Greeter.hello', dir, {});
    assert.equal(out.error, undefined, 'the dotted form resolves');
    assert.match(out.code, /function hello/);
    assert.equal(out.file, 'Greeter.php');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze prints a summary, never the whole index, unless --json is asked for', () => {
  const dir = writeRepo({
    'One.php': php(['<?php', 'class One {', '  public function m() { return 1; }', '}']),
  });
  const cli = path.resolve('src/index.js');
  try {
    const plain = execFileSync(process.execPath, [cli, 'analyze', dir, '--no-cluster'], { encoding: 'utf8' });
    assert.ok(plain.length < 2000, `stdout must stay a summary, got ${plain.length} bytes`);
    assert.match(plain, /Analysis Complete/);
    assert.equal(plain.includes('"symbols"'), false, 'no raw index on stdout');

    const json = execFileSync(process.execPath, [cli, 'analyze', dir, '--no-cluster', '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(json);
    assert.equal(parsed.type, 'analysis', '--json still yields machine-readable output');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
