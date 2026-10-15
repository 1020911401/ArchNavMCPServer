/**
 * Vue SFC call extraction — recall patch.
 *
 * `extractVueCalls(filePath)` parses every `<script>` / `<script setup>` block
 * and walks the program, descending into arrow functions, function expressions
 * and object methods — including `methods: { ... }` entries and nested
 * `success: (res) => { ... }` callbacks, which is exactly the shape a flat
 * "top-level function" index misses.
 *
 * Returns `[{ callee, line, enclosing, kind }]`:
 *   callee    the called identifier; for a member call the trailing name
 *             (`getUserInfo` for `this.getUserInfo()`, `showModal` for
 *             `uni.showModal()`); null for computed / non-identifier callees
 *   line      1-based line number in the .vue file
 *   enclosing nearest *named* enclosing function ('success', 'defaultTake',
 *             'run', ...) or null at the top level
 *   kind      'setup'    top level of a `<script setup>` block, or a setup() fn
 *             'method'   directly inside a named method / function declaration
 *             'callback' inside a nested function (property arrow like
 *                        `success: (res) => {}`, or an anonymous fn/arrow
 *                        passed as a call argument)
 *
 * `extractScriptBlocks` returns the raw script blocks of any file (a plain
 * .js/.jsx/.mjs file is treated as one block) so callers can share the parse.
 */
import fs from 'fs';
import { parse } from '@typescript-eslint/parser';

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

function lineOf(src, pos) {
  let line = 1;
  const end = Math.min(pos, src.length);
  for (let i = 0; i < end; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function isSfc(filePath) {
  return /\.vue$/i.test(filePath);
}

/**
 * All `<script>` blocks of a file. For a non-.vue file the whole file is one
 * block (a plain JS module has no SFC wrapper).
 */
export function extractScriptBlocks(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const blocks = [];
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(raw))) {
    const attrs = m[1] || '';
    const openTagLen = m[0].indexOf('>') + 1;
    const bodyStart = m.index + openTagLen;
    const bodyEnd = bodyStart + m[2].length;
    blocks.push({
      attrs,
      setup: /\bsetup\b/.test(attrs),
      jsx: /(?:babel|jsx)/i.test(attrs) || /\.(jsx|tsx)$/i.test(filePath),
      lang: (attrs.match(/lang\s*=\s*['"]?([\w-]+)/i) || [])[1] || 'js',
      body: m[2],
      // 1-based line of the block body's first character …
      startLine: lineOf(raw, bodyStart),
      // … and of its last character (inclusive), so consumers can report a
      // block's full line range. An empty body collapses onto startLine.
      endLine: lineOf(raw, Math.max(bodyStart, bodyEnd - 1)),
    });
  }
  if (!blocks.length && !isSfc(filePath)) {
    blocks.push({
      attrs: '',
      setup: false,
      jsx: /\.(jsx|tsx)$/i.test(filePath),
      lang: (filePath.split('.').pop() || 'js'),
      body: raw,
      startLine: 1,
      endLine: lineOf(raw, Math.max(0, raw.length - 1)),
    });
  }
  return blocks;
}

/** Parse a script source into an ESTree-ish AST, or null on failure. */
export function parseModule(source, { jsx = false } = {}) {
  const opts = {
    ecmaVersion: 'latest',
    sourceType: 'module',
    loc: true,
    range: true,
    jsx: !!jsx,
    errorRecovery: true,
    comment: false,
    tokens: false,
  };
  try {
    return parse(source, opts);
  } catch {
    try {
      return parse(source, { ...opts, errorRecovery: true });
    } catch {
      return null;
    }
  }
}

function keyName(k) {
  if (!k) return null;
  if (k.type === 'Identifier') return k.name;
  if (k.type === 'PrivateIdentifier') return `#${k.name}`;
  if (k.type === 'Literal') return String(k.value);
  return null;
}

function isFunctionNode(n) {
  return n && (n.type === 'FunctionDeclaration'
    || n.type === 'FunctionExpression'
    || n.type === 'ArrowFunctionExpression');
}

function fnName(node, parent) {
  if (node.type === 'FunctionDeclaration') return node.id ? node.id.name : null;
  if (node.id && node.id.name) return node.id.name; // named function expression
  if (!parent) return null;
  if ((parent.type === 'Property' || parent.type === 'PropertyDefinition') && parent.value === node) {
    return keyName(parent.key);
  }
  if (parent.type === 'MethodDefinition') return keyName(parent.key);
  if (parent.type === 'VariableDeclarator') return keyName(parent.id);
  if (parent.type === 'AssignmentExpression') return keyName(parent.left);
  return null;
}

/** Classify a function scope: 'method' (named/declared) or 'callback'. */
function hintFor(node, parent) {
  if (!parent) return 'method';
  if (node.type === 'FunctionDeclaration') return 'method';
  if (parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') return 'method';
  if (parent.type === 'Property' && parent.value === node) return parent.method ? 'method' : 'callback';
  if (parent.type === 'VariableDeclarator') return 'method';
  if (parent.type === 'AssignmentExpression') return 'method';
  return 'callback'; // anonymous function / arrow passed as a call argument
}

function calleeName(callee) {
  if (!callee) return null;
  switch (callee.type) {
    case 'ChainExpression':
      return calleeName(callee.expression);
    case 'TSNonNullExpression':
      return calleeName(callee.expression);
    case 'Identifier':
      return callee.name;
    case 'MemberExpression':
      return callee.computed ? null : keyName(callee.property);
    default:
      return null;
  }
}

function kindOf(scopes, setup) {
  if (scopes.length === 0) return setup ? 'setup' : 'method';
  if (scopes.length >= 2) return 'callback';
  const near = scopes[0];
  if (near.name === 'setup') return 'setup';
  return near.hint;
}

function enclosingOf(scopes) {
  for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].name) return scopes[i].name;
  return null;
}

/**
 * Walk a parsed module AST and collect calls.
 * @param {object|null} ast
 * @param {{lineOffset?: number, setup?: boolean}} opts lineOffset = 1-based
 *        line of the source's first line in the original file.
 */
export function collectCalls(ast, opts = {}) {
  const lineOffset = opts.lineOffset || 1;
  const setup = !!opts.setup;
  const out = [];
  if (!ast) return out;

  function walk(node, parent, scopes) {
    if (!node || typeof node.type !== 'string') return;
    let next = scopes;
    if (isFunctionNode(node)) {
      next = scopes.concat([{ name: fnName(node, parent), hint: hintFor(node, parent) }]);
    }
    if (node.type === 'CallExpression') {
      const callee = calleeName(node.callee);
      if (callee) {
        out.push({
          callee,
          line: lineOffset + node.loc.start.line - 1,
          enclosing: enclosingOf(scopes),
          kind: kindOf(scopes, setup),
        });
      }
    }
    for (const key in node) {
      if (key === 'loc' || key === 'range' || key === 'parent') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') walk(child, node, next);
      } else if (value && typeof value.type === 'string') {
        walk(value, node, next);
      }
    }
  }

  walk(ast, null, []);
  return out;
}

/**
 * Extract all identifiable calls from a .vue (or plain JS) file.
 * @param {string} filePath
 * @returns {{callee: string, line: number, enclosing: string|null, kind: string}[]}
 */
export function extractVueCalls(filePath) {
  const out = [];
  for (const block of extractScriptBlocks(filePath)) {
    const ast = parseModule(block.body, { jsx: block.jsx });
    for (const call of collectCalls(ast, { lineOffset: block.startLine, setup: block.setup })) {
      out.push(call);
    }
  }
  return out;
}
