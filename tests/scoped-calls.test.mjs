/**
 * Scoped calls (`$this->m()`, `self::m()`, `parent::m()`) must resolve inside the
 * class, not by bare method name across the repo.
 *
 * Measured on a real Laravel repo before this existed: 246 of 572 `$this` edges and
 * 36 of 36 `parent` edges pointed at another file, and one of them invented a
 * `EnsureLegacySiteOpen ↔ LegacyApiException` cycle (a middleware's `__construct`
 * stood in for `RuntimeException::__construct`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../src/analyzer.js';

const writeRepo = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-scoped-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, 'utf8');
  return dir;
};

const php = (lines) => lines.join('\n');

test('parent::m() resolves through the declared base class, never by bare method name', async () => {
  const dir = writeRepo({
    'Base.php': php(['<?php', 'class Base {', '  public function __construct() {}', '}']),
    'Other.php': php(['<?php', 'class Other {', '  public function __construct() {}', '}']),
    'Child.php': php(['<?php', 'class Child extends Base {', '  public function __construct() { parent::__construct(); }', '}']),
  });
  try {
    const res = await analyze(dir, {});
    const cls = res.symbols.find((s) => s.name === 'Child' && s.kind === 'class');
    assert.equal(cls.superClass, 'Base', 'the base clause is captured for PHP classes');

    const edges = res.knowledgeGraph.edges.filter((e) => e.from === 'sym:Child.php::__construct' && e.type === 'DEPENDS_ON');
    const targets = edges.map((e) => e.to);
    assert.ok(targets.includes('sym:Base.php::__construct'), 'parent::__construct → the real base class');
    assert.equal(targets.includes('sym:Other.php::__construct'), false, 'a same-named method elsewhere is not the target');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parent::m() with a framework base class is reported, not guessed', async () => {
  const dir = writeRepo({
    'Boom.php': php(['<?php', 'class Boom extends RuntimeException {', '  public function __construct() { parent::__construct("x"); }', '}']),
  });
  try {
    const res = await analyze(dir, {});
    const edges = res.knowledgeGraph.edges.filter((e) => e.from === 'sym:Boom.php::__construct' && e.type === 'DEPENDS_ON');
    assert.deepEqual(edges, [], 'no edge when the parent class is not in the index');
    const unresolved = res.knowledgeGraph.unresolvedScopedCalls;
    assert.equal(unresolved.length >= 1, true, 'the dropped call is visible');
    assert.equal(unresolved[0].receiver, 'parent');
    assert.equal(unresolved[0].parent, 'RuntimeException');
    assert.equal(res.knowledgeGraph.scopedCallStats.unresolved >= 1, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('$this->m() stays inside its own class when another class defines the same name', async () => {
  const dir = writeRepo({
    'A.php': php(['<?php', 'class A {', '  public function go() { return $this->helper(); }', '  public function helper() { return 1; }', '}']),
    'B.php': php(['<?php', 'class B {', '  public function helper() { return 2; }', '}']),
  });
  try {
    const res = await analyze(dir, {});
    const edges = res.knowledgeGraph.edges.filter((e) => e.from === 'sym:A.php::go' && e.type === 'DEPENDS_ON');
    assert.deepEqual(edges.map((e) => e.to), ['sym:A.php::helper'], 'resolved in-file, not to B.php');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
