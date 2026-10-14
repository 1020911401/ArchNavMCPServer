/**
 * src/resolver/index.js — the single public entry point of the recall-patch
 * resolver. Three pure extractors plus the repo-wide scans and the unified edge
 * aggregate.
 *
 * ── Edge shape convention (see `toEdges`) ────────────────────────────────────
 *   { from, to, line, type: 'CALLS', source_kind: 'template'|'callback'|'import' }
 *
 *   `from` is ALWAYS a posix, repo-relative path of the file that contains the
 *   reference.
 *
 *   `to` is either a posix, repo-relative path OR a symbol id, chosen by kind:
 *     - source_kind === 'import'   → `to` is the resolved definition *file*
 *       (posix, repo-relative; falls back to the raw specifier when the target
 *       cannot be located on disk).
 *     - source_kind === 'template' → `to` is the callee *symbol name*
 *     - source_kind === 'callback' → `to` is the callee *symbol name*
 *       (Blade / Vue call sites carry no definition location, so a symbol id is
 *       the only meaningful target here.)
 *
 *   `line` is a 1-based line number inside `from`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import fs from 'fs';
import path from 'path';

import { extractBladeCalls } from './blade.js';
import { extractScriptBlocks, parseModule, collectCalls } from './vue-sfc.js';
import { resolveAlias } from './alias.js';

export { extractBladeCalls } from './blade.js';
export { extractVueCalls, extractScriptBlocks, parseModule, collectCalls } from './vue-sfc.js';
export { resolveAlias } from './alias.js';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.archnav', '.codegraph', '.gitnexus', '.hermes', '.cache',
  '.tmp-fusion', '.tmp-nav',
]);

const MODULE_EXTS = ['.vue', '.js', '.mjs', '.cjs', '.jsx'];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function rel(root, abs) {
  return toPosix(path.relative(root, abs));
}

function walkFiles(root, accept, acc = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walkFiles(p, accept, acc);
    } else if (e.isFile() && accept(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

function isModuleFile(name) {
  return MODULE_EXTS.some(ext => name.endsWith(ext));
}

/** Top-level `import { X } from '...'` declarations of a parsed AST. */
function collectImports(ast, block) {
  const out = [];
  if (!ast || !Array.isArray(ast.body)) return out;
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const source = node.source && node.source.value;
    if (typeof source !== 'string') continue;
    const symbols = [];
    for (const s of node.specifiers || []) {
      if (s.type === 'ImportSpecifier') {
        const imported = s.imported;
        const name = imported && (imported.name || imported.value);
        if (name) symbols.push({ name: String(name) });
      } else if (s.type === 'ImportDefaultSpecifier') {
        symbols.push({ name: 'default' });
      } else if (s.type === 'ImportNamespaceSpecifier') {
        symbols.push({ name: '*' });
      }
    }
    if (!symbols.length) continue; // side-effect import
    out.push({ symbols, source, line: block.startLine + node.loc.start.line - 1 });
  }
  return out;
}

/**
 * Parse every module file under `root` exactly once and return both the call
 * list and the import edges. Shared by scanCallbackCalls / scanImportEdges /
 * toEdges so a full-repo aggregate never parses a file twice.
 */
function scanModules(root, options = {}) {
  const calls = [];
  const imports = [];
  for (const file of walkFiles(root, isModuleFile)) {
    const from = rel(root, file);
    for (const block of extractScriptBlocks(file)) {
      const ast = parseModule(block.body, { jsx: block.jsx });
      if (!ast) continue;
      for (const c of collectCalls(ast, { lineOffset: block.startLine, setup: block.setup })) {
        calls.push({ file: from, callee: c.callee, line: c.line, enclosing: c.enclosing, kind: c.kind });
      }
      for (const imp of collectImports(ast, block)) {
        const resolved = options.resolve === false
          ? null
          : resolveAlias(imp.source, { repoDir: root, fromFile: file });
        for (const s of imp.symbols) {
          imports.push({
            from,
            to: resolved || imp.source,
            symbol: s.name,
            line: imp.line,
            source_kind: 'import',
          });
        }
      }
    }
  }
  return { calls, imports };
}

/**
 * Repo-wide Blade scan.
 * @returns {{file: string, var: string, callee: string, line: number}[]}
 */
export function scanTemplateCalls(repoDir) {
  const root = path.resolve(repoDir);
  const out = [];
  for (const file of walkFiles(root, n => n.endsWith('.blade.php'))) {
    for (const c of extractBladeCalls(file)) {
      out.push({ file: rel(root, file), var: c.var, callee: c.callee, line: c.line });
    }
  }
  return out;
}

/**
 * Repo-wide .vue / .js nested-callback scan.
 * @returns {{file: string, callee: string, line: number, enclosing: string|null, kind: string}[]}
 */
export function scanCallbackCalls(repoDir, options = {}) {
  const root = path.resolve(repoDir);
  const calls = scanModules(root, options).calls;
  // `allKinds` keeps direct method-body / setup calls too — needed when the
  // consumer already filters by symbol (imported callees), and dropping them
  // would silently lose e.g. `getUserInfo()` called straight in a method.
  return options.allKinds ? calls : calls.filter(c => c.kind === 'callback');
}

/**
 * Parse each module once and return BOTH calls and imports.
 * Use this when a consumer needs both — calling scanCallbackCalls() and
 * scanImportEdges() separately parses every file twice.
 * @returns {{calls: object[], imports: object[]}}
 */
export function scanModuleGraph(repoDir, options = {}) {
  return scanModules(path.resolve(repoDir), options);
}

/**
 * Repo-wide `import { X } from '…'` edges → { from: file, to: definition file }.
 * @returns {{from: string, to: string, symbol: string, line: number, source_kind: 'import'}[]}
 */
export function scanImportEdges(repoDir, options = {}) {
  const root = path.resolve(repoDir);
  return scanModules(root, options).imports;
}

/**
 * Aggregate everything into the unified edge shape documented at the top of
 * this file.
 */
export function toEdges(repoDir, options = {}) {
  const root = path.resolve(repoDir);
  const edges = [];

  for (const c of scanTemplateCalls(root)) {
    edges.push({ from: c.file, to: c.callee, line: c.line, type: 'CALLS', source_kind: 'template' });
  }

  const { calls, imports } = scanModules(root, options);

  for (const c of calls) {
    if (c.kind !== 'callback') continue;
    edges.push({ from: c.file, to: c.callee, line: c.line, type: 'CALLS', source_kind: 'callback' });
  }

  for (const e of imports) {
    edges.push({ from: e.from, to: e.to, line: e.line, type: 'CALLS', source_kind: 'import' });
  }

  return edges;
}
