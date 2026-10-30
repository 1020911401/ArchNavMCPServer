/**
 * whereami.test.mjs — "which symbol is at this file:line" must answer from the index,
 * not from a regex scan that only understands `function name` / `class Name`.
 *
 * Measured before the fix, on a 20-file Express app:
 *   locate getOrderById  → src/services/orderService.js:57-61  (exact)
 *   whereami ... :57     → "No symbol found at this position"
 * because `async getOrderById(orderId) {` is an object-literal method. The layer was
 * also computed from process.cwd(), so running from a sibling directory returned
 * `file: C:\...\src\controllers\x.js` with `layer: unknown`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO, 'src', 'index.js');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-whereami-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }) + '\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.archnav/\n');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  spawnSync('git', ['init', '-q', '.'], { cwd: dir });
  execFileSync(process.execPath, [CLI, 'analyze', '.'], { cwd: dir, encoding: 'utf8' });
  return dir;
}

const whereami = (file, line, opts = {}) =>
  execFileSync(process.execPath, [CLI, 'whereami', file, String(line), '--json'],
    { encoding: 'utf8', ...opts });

const service = [
  'const orderService = {',
  '  async getOrderById(orderId) {',
  '    return { id: orderId };',
  '  },',
  '  async cancelOrder(orderId, userId) {',
  '    return { id: orderId, userId };',
  '  },',
  '};',
  '',
  'module.exports = { orderService };',
  '',
].join('\n');

test('an object-literal method resolves from the index (regex cannot see it)', (t) => {
  const dir = fixture({ 'src/services/orderService.js': service });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const r = JSON.parse(whereami('src/services/orderService.js', 3, { cwd: dir }));
  assert.equal(r.symbol, 'getOrderById', 'line 3 is inside getOrderById');
  assert.equal(r.source, 'index', 'answered from the index, not the fallback scan');
  assert.equal(r.layer, 'Business (Service)');

  // the second method too — and `locate` agrees about the range
  const r2 = JSON.parse(whereami('src/services/orderService.js', 6, { cwd: dir }));
  assert.equal(r2.symbol, 'cancelOrder');
  const loc = JSON.parse(execFileSync(process.execPath, [CLI, 'locate', 'cancelOrder', '--json'],
    { cwd: dir, encoding: 'utf8' }));
  assert.ok(loc.symbol.line_start <= 6 && loc.symbol.line_end >= 6,
    `whereami(6) and locate must agree on the range (${loc.symbol.line_start}-${loc.symbol.line_end})`);
});

test('the answer does not depend on process.cwd()', (t) => {
  const dir = fixture({
    'src/controllers/orderController.js': [
      'const { orderService } = require(\'../services/orderService\');',
      '',
      'function get(req, res) {',
      '  return orderService.getOrderById(req.params.id);',
      '}',
      '',
      'module.exports = { get };',
      '',
    ].join('\n'),
    'src/services/orderService.js': service,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  // run from a directory that is NOT the repo root (the old code used cwd for relPath)
  const r = JSON.parse(whereami(path.join(dir, 'src', 'controllers', 'orderController.js'), 4,
    { cwd: os.tmpdir() }));
  assert.equal(r.symbol, 'get', 'cwd must not change which symbol is reported');
  assert.equal(r.layer, 'API (Controller)', 'layer from path relative to the index root');
  assert.match(r.file, /orderController\.js$/, 'file is repo-relative, not cwd-relative');
});

test('a line with no symbol says so instead of guessing', (t) => {
  const dir = fixture({ 'src/services/orderService.js': service });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  // line 1 is `const orderService = {` — outside every symbol span
  const r = JSON.parse(whereami('src/services/orderService.js', 1, { cwd: dir }));
  assert.equal(r.symbol, null);
  assert.match(r.note || '', /no symbol at this position/);
  assert.equal(r.layer, 'Business (Service)', 'layer still answerable from the path');
});
