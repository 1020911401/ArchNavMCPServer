/**
 * The index's `signature` field is what review-rules' arity check reads to decide
 * which parameters are required (it looks for `=`). Rebuilding an arrow function's
 * signature from bare parameter names therefore made every defaulted argument look
 * mandatory, and every call relying on the default look like a missing argument.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFileAst } from '../src/treewalker.js';

const write = (dir, name, body) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
};

test('arrow-function signature keeps default parameters (required vs total)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-signature-'));
  try {
    const file = write(dir, 'mod.mjs', [
      'export const finding = (rule, severity, file, line = 1, extra = {}) => rule;',
      'export const card = (over = {}) => over;',
      'export function plain(a, b = 2) { return a + b; }',
      '',
    ].join('\n'));
    const { symbols } = parseFileAst(file, dir);
    const sig = (name) => symbols.find((s) => s.name === name).signature;

    assert.match(sig('finding'), /line = /, 'a defaulted param must stay visible in the signature');
    assert.match(sig('finding'), /extra = /);
    assert.match(sig('card'), /over = /);
    assert.match(sig('plain'), /b = 2/, 'function declarations already kept defaults');

    // the params array stays bare names — only the signature renders defaults
    const finding = symbols.find((s) => s.name === 'finding');
    assert.deepEqual(finding.params, ['rule', 'severity', 'file', 'line', 'extra']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
