/**
 * Vue SFC symbol extraction — the `.vue` half of `src/analyzer.js`.
 *
 * Why: the analyzer's file walk never included `.vue`, so a uni-app project's
 * 269 single-file components contributed **0 symbols** — `locate`/`read`/`impact`
 * could not name a single method, and component-internal symbols (e.g.
 * `goPay` in `components/payment/index.vue`) were unreachable. Falling back to
 * the generic acorn path is not a fix either: it reports the SFC's `<template>`
 * text as garbage symbols (`✖:3`) and still misses every option-API method.
 *
 * What this module does, per `.vue` file:
 *   1. reuse `extractScriptBlocks()` (src/resolver/vue-sfc.js) to pull each
 *      `<script>` / `<script setup>` block and remember where it starts;
 *   2. parse the block with the project's TypeScript parser;
 *   3. if that throws (uni-app conditional compilation — `// #ifdef H5` — can
 *      leave two object properties without a separating comma, which is a hard
 *      syntax error), fall back to `acorn-loose`, an error-tolerant parser that
 *      is already a dependency and recovers the object literal intact;
 *   4. read symbols **by name only** from the object's own keys, and shift every
 *      line number by the block's `startLine`.
 *
 * Symbols extracted:
 *   - `export default { name: 'x' }`              → kind 'component'
 *   - `methods: { goPay() {} }`                   → kind 'method'
 *   - `data()` / `props` / `computed` / `watch`   → kind 'data' | 'props' | 'computed' | 'watch'
 *     (`computed`/`watch` object literals expand to one symbol per entry)
 *   - lifecycle hooks (Vue + uni-app: onLoad, onShow, mounted, …) → kind 'hook'
 *   - any other function-valued option, and `<script setup>` top-level
 *     `function f(){}` / `const f = () => {}`   → kind 'function'
 *
 * Deliberately NOT emitted: `<template>` content, spread elements, anonymous
 * values, and anything whose key is not an identifier/string — so no `✖` noise.
 */
import fs from 'fs';
import path from 'path';
import * as acornLoose from 'acorn-loose';
import { extractScriptBlocks, parseModule } from '../resolver/vue-sfc.js';

const looseParse = acornLoose?.parse || acornLoose?.default?.parse;
const isDummy = acornLoose?.isDummy || acornLoose?.default?.isDummy || (() => false);

/** Vue 2 + uni-app lifecycle hook names that deserve their own `kind`. */
const LIFECYCLE = new Set([
  'beforeCreate', 'created', 'beforeMount', 'mounted', 'beforeUpdate', 'updated',
  'beforeDestroy', 'destroyed', 'activated', 'deactivated', 'errorCaptured', 'serverPrefetch',
  // uni-app page / app hooks
  'onLoad', 'onShow', 'onReady', 'onHide', 'onUnload', 'onLaunch', 'onError',
  'onPullDownRefresh', 'onReachBottom', 'onPageScroll', 'onResize', 'onTabItemTap',
  'onShareAppMessage', 'onShareTimeline', 'onAddToFavorites', 'onNavigationBarButtonTap',
  'onBackPress', 'onPageNotFound', 'onThemeChange',
]);

// ═══════════════════════════════════════════════
//  AST helpers
// ═══════════════════════════════════════════════

const isFn = (n) => n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration');

function keyName(key) {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' || key.type === 'StringLiteral') return typeof key.value === 'string' ? key.value : null;
  if (key.type === 'TemplateLiteral' && key.expressions?.length === 0) return key.quasis?.[0]?.value?.raw ?? null;
  return null;
}

/** Param names for a light signature (`goPay(number, paytype)`). */
function paramNames(params) {
  return (params || []).map((p) => {
    if (!p) return '';
    if (p.type === 'Identifier') return p.name;
    if (p.type === 'AssignmentPattern') return p.left?.name || '...';
    if (p.type === 'RestElement') return `...${p.argument?.name || ''}`;
    if (p.type === 'ObjectPattern') return '{...}';
    if (p.type === 'ArrayPattern') return '[...]';
    return '';
  }).filter(Boolean);
}

// ═══════════════════════════════════════════════
//  Block → symbols
// ═══════════════════════════════════════════════

function lineIndex(body) {
  const starts = [0];
  for (let i = 0; i < body.length; i++) if (body.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOfOffset(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Collect symbols of one `<script>` block.
 * @param {object|null} ast      parsed block AST (already offset-free)
 * @param {{body:string, startLine:number}} block
 * @param {string} relPath       repo-relative path stored on every symbol
 */
function collectBlockSymbols(ast, block, relPath) {
  const out = [];
  if (!ast) return out;
  const starts = lineIndex(block.body);
  // @typescript-eslint emits `range: [start, end]`; acorn also sets `start`/`end`.
  const offStart = (n) => (Array.isArray(n.range) ? n.range[0] : (n.start ?? 0));
  const offEnd = (n) => (Array.isArray(n.range) ? n.range[1] : (n.end ?? n.start ?? 1));
  const absStart = (node) => block.startLine + lineOfOffset(starts, offStart(node)) - 1;
  const absEnd = (node) => block.startLine + lineOfOffset(starts, Math.max(offStart(node), offEnd(node) - 1)) - 1;
  const seen = new Set();

  const push = (name, kind, node, { value = null, signature = null } = {}) => {
    if (!name || typeof name !== 'string') return;
    if (!/^[^\s]+$/.test(name)) return;
    const line_start = absStart(node);
    const key = `${name}|${kind}|${line_start}`;
    if (seen.has(key)) return;
    seen.add(key);
    const valueNode = value || (isFn(node.value) ? node.value : null);
    out.push({
      id: name,
      name,
      kind,
      file: relPath,
      line_start,
      line_end: valueNode ? absEnd(valueNode) : absEnd(node),
      signature: signature || (valueNode ? `${name}(${paramNames(valueNode.params).join(', ')})` : name),
      params: valueNode ? paramNames(valueNode.params) : [],
      exported: true,
      ...(valueNode && valueNode.async ? { async: true } : {}),
    });
  };

  /** One symbol per entry of a `computed: {}` / `watch: {}` / `methods: {}` map. */
  const expandMap = (containerKey, valueNode, kind) => {
    if (valueNode && valueNode.type === 'ObjectExpression') {
      for (const prop of valueNode.properties || []) {
        if (isDummy(prop) || (prop.type !== 'Property' && prop.type !== 'MethodDefinition')) continue;
        const name = keyName(prop.key);
        if (!name) continue;
        push(name, kind, prop, { value: isFn(prop.value) ? prop.value : null });
      }
    } else if (valueNode) {
      push(containerKey, kind, valueNode);
    }
  };

  /** Walk the object literal passed to `export default`. */
  const collectOptions = (obj) => {
    if (!obj) return;
    if (obj.type === 'CallExpression') return collectOptions(obj.arguments?.[0]);
    if (obj.type !== 'ObjectExpression') return;
    for (const prop of obj.properties || []) {
      if (isDummy(prop) || prop.type !== 'Property' || prop.kind === 'get' || prop.kind === 'set') continue;
      const key = keyName(prop.key);
      if (!key) continue;
      if (key === 'name' && prop.value && typeof prop.value.value === 'string') {
        push(prop.value.value, 'component', prop);
      } else if (key === 'props') {
        push('props', 'props', prop);
      } else if (key === 'data') {
        push('data', 'data', prop, { value: isFn(prop.value) ? prop.value : null });
      } else if (key === 'computed' || key === 'watch') {
        expandMap(key, prop.value, key);
      } else if (key === 'methods') {
        expandMap(key, prop.value, 'method');
      } else if (key === 'mixins' || key === 'components' || key === 'directives') {
        continue; // containers, not symbols
      } else if (LIFECYCLE.has(key)) {
        push(key, 'hook', prop, { value: isFn(prop.value) ? prop.value : null });
      } else if (isFn(prop.value)) {
        push(key, 'function', prop, { value: prop.value });
      }
      // A non-function, non-lifecycle option (`foo: 1`) is config, not a symbol.
    }
  };

  const visitTopLevel = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'ExportDefaultDeclaration':
        collectOptions(node.declaration);
        break;
      case 'ExportNamedDeclaration':
        if (node.declaration) visitTopLevel(node.declaration);
        break;
      case 'FunctionDeclaration':
        if (node.id?.name) push(node.id.name, 'function', node, { value: node });
        break;
      case 'VariableDeclaration':
        for (const d of node.declarations || []) {
          if (d.id?.type === 'Identifier' && isFn(d.init)) push(d.id.name, 'function', d, { value: d.init });
        }
        break;
      default:
        break;
    }
  };

  for (const node of ast.body || []) {
    if (!node) continue;
    visitTopLevel(node);
  }
  return out;
}

/** Top-level `import` declarations of a block, in the analyzer's shape. */
function collectBlockImports(ast, block) {
  const out = [];
  if (!ast) return out;
  const starts = lineIndex(block.body);
  for (const node of ast.body || []) {
    if (!node || node.type !== 'ImportDeclaration' || !node.source?.value) continue;
    out.push({
      source: node.source.value,
      specifiers: (node.specifiers || []).map((s) => s.local?.name || s.imported?.name).filter(Boolean),
      line: block.startLine + lineOfOffset(starts, Array.isArray(node.range) ? node.range[0] : (node.start ?? 0)) - 1,
    });
  }
  return out;
}

// ═══════════════════════════════════════════════
//  Public entry point
// ═══════════════════════════════════════════════

/**
 * Parse a `.vue` single-file component and extract its script symbols.
 *
 * @param {string} filePath  absolute path to the .vue file
 * @param {string} baseDir   the directory that was analyzed (for the relative path)
 * @param {string} [content] the file's text, when the caller already read it
 * @returns {{ symbols: Array, imports: Array }}
 */
export function parseVueFile(filePath, baseDir, content) {
  let raw = content;
  if (typeof raw !== 'string') {
    try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return { symbols: [], imports: [] }; }
  }
  const relPath = path.relative(baseDir, filePath);
  const symbols = [];
  const imports = [];

  let blocks;
  try { blocks = extractScriptBlocks(filePath); } catch { return { symbols: [], imports: [] }; }

  for (const block of blocks) {
    let ast = parseModule(block.body, { jsx: block.jsx });
    if (!ast) {
      // Error-tolerant fallback: uni-app conditional compilation can leave a
      // hard syntax error the strict parser refuses to recover from.
      try {
        ast = looseParse(block.body, {
          ecmaVersion: 'latest',
          sourceType: 'module',
          allowReturnOutsideFunction: true,
        });
      } catch { ast = null; }
    }
    if (!ast) continue;
    symbols.push(...collectBlockSymbols(ast, block, relPath));
    imports.push(...collectBlockImports(ast, block));
  }

  // Attach the component's imports to its first symbol, the way the other
  // parsers do, so `calls()` has something to cross-reference.
  if (imports.length && symbols.length) symbols[0].imports = imports;

  return { symbols, imports };
}
