/**
 * call-resolution.test.mjs — a member call must resolve through the binding the file
 * actually imported, not through "first symbol with that name in the repo".
 *
 * Measured before the fix, on a 20-file Express app: 16 of 37 resolvable `DEPENDS_ON`
 * edges pointed at the wrong file (`productRepository.findById` → `orderRepository`),
 * and a call inside an anonymous route handler produced no edge at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-resolve-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }) + '\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.archnav/\n');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  spawnSync('git', ['init', '-q', '.'], { cwd: dir });
  execFileSync(process.execPath, [path.join(REPO, 'src', 'index.js'), 'analyze', '.'], { cwd: dir, encoding: 'utf8' });
  const index = JSON.parse(fs.readFileSync(path.join(dir, '.archnav', 'index.json'), 'utf8'));
  return { dir, index };
}

const edgesFrom = (index, fromSuffix) => (index.knowledgeGraph?.edges || [])
  .filter((e) => e.type === 'DEPENDS_ON' && String(e.from).endsWith(fromSuffix));

const to = (edge) => String(edge.to).replace(/\\/g, '/');

test('two modules with the same method name are not confused', (t) => {
  const { dir, index } = fixture({
    'src/repos/orderRepo.js': 'const orderRepo = {\n  findById(id) { return { id }; },\n};\n\nmodule.exports = { orderRepo };\n',
    'src/repos/productRepo.js': 'const productRepo = {\n  findById(id) { return { id }; },\n};\n\nmodule.exports = { productRepo };\n',
    'src/service.js': [
      "const { orderRepo } = require('./repos/orderRepo');",
      "const { productRepo } = require('./repos/productRepo');",
      '',
      'function loadOrder(id) {',
      '  return orderRepo.findById(id);',
      '}',
      '',
      'function loadProduct(id) {',
      '  return productRepo.findById(id);',
      '}',
      '',
      'module.exports = { loadOrder, loadProduct };',
      '',
    ].join('\n'),
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const orderEdges = edgesFrom(index, '::loadOrder');
  const productEdges = edgesFrom(index, '::loadProduct');
  assert.equal(orderEdges.length, 1, 'loadOrder should have exactly one call edge');
  assert.equal(productEdges.length, 1, 'loadProduct should have exactly one call edge');
  assert.match(to(orderEdges[0]), /orderRepo\.js::findById$/, `loadOrder → ${to(orderEdges[0])}`);
  assert.match(to(productEdges[0]), /productRepo\.js::findById$/, `loadProduct → ${to(productEdges[0])}`);
});

test('a call inside an anonymous route handler is recorded at file level', (t) => {
  const { dir, index } = fixture({
    'src/service.js': 'const svc = {\n  doWork(x) { return x; },\n};\n\nmodule.exports = { svc };\n',
    'src/routes.js': [
      "const { svc } = require('./service');",
      "const express = require('express');",
      'const router = express.Router();',
      '',
      "router.get('/', async (req, res) => {",
      '  res.json({ v: svc.doWork(1) });',
      '});',
      '',
      'module.exports = router;',
      '',
    ].join('\n'),
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const incoming = (index.knowledgeGraph?.edges || []).filter(
    (e) => e.type === 'DEPENDS_ON' && /service\.js::doWork$/.test(to(e)),
  );
  assert.ok(incoming.length >= 1, 'the handler call must not disappear');
  // The edge starts at the file node (a route handler has no symbol of its own).
  const fromFile = incoming.find((e) => String(e.from).endsWith('routes.js'));
  assert.ok(fromFile, `expected a file-level edge, got ${incoming.map((e) => e.from).join(', ')}`);
  assert.equal(fromFile.line, 6);
  assert.equal(fromFile.source_kind, 'ast-file', 'the binding resolved, so this is not a guess');
});

test('an unbindable same-name call is kept but flagged as ambiguous', (t) => {
  const { dir, index } = fixture({
    'src/a.js': 'function helper() { return 1; }\nmodule.exports = { helper };\n',
    'src/b.js': 'function helper() { return 2; }\nmodule.exports = { helper };\n',
    // no require: the receiver is a parameter, so no binding can disambiguate
    'src/c.js': 'function run(helper) {\n  return helper();\n}\nmodule.exports = { run };\n',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const edge = edgesFrom(index, '::run')[0];
  assert.ok(edge, 'the call edge should still be recorded (recall first)');
  assert.equal(edge.ambiguous, 'helper', 'the edge must say which name was ambiguous');
  assert.equal(edge.confidence, 0.5, 'ambiguous edges are worth less than a bound one');
});

test('no edge is invented for a callee that exists nowhere', (t) => {
  const { dir, index } = fixture({
    'src/svc.js': 'const svc = {\n  send(x) { return x; },\n};\n\nmodule.exports = { svc };\n',
    // promise chain: `.catch` is not a symbol in any file, so the edge would be
    // `createOrder → svc.js::catch` — a node nobody indexed
    'src/job.js': [
      "const { svc } = require('./svc');",
      '',
      'function createOrder() {',
      '  return svc.send(1).catch(e => console.error(e));',
      '}',
      '',
      'module.exports = { createOrder };',
      '',
    ].join('\n'),
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const deps = (index.knowledgeGraph?.edges || []).filter((e) => e.type === 'DEPENDS_ON');
  const dangling = deps.filter((e) => /::(catch|then|error|console|log)$/.test(to(e)));
  assert.deepEqual(dangling.map(to), [], 'no edge to a symbol the index never had');
  // the real call (`svc.send`) is still there
  assert.ok(deps.some((e) => /svc\.js::send$/.test(to(e))), 'the resolvable call survives');
});
