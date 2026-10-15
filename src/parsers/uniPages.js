/**
 * uni-app page/reference parser — zero-dependency (regex + small hand scanners).
 *
 * Why: a uni-app project's `pages.json` is the single source of truth for which
 * `.vue` files are *pages*, and page → page navigation happens through
 * `uni.navigateTo/redirectTo/switchTab/reLaunch` calls and `<navigator>` tags —
 * none of which the AST / call-graph layer models. On the Vue side a call site is
 * recorded as a `file:<path>` node ("the call happens inside this file") and, in
 * the benchmark corpus, those nodes had **zero incoming edges**. A depth-2
 * reverse DEPENDS_ON walk was therefore structurally empty: `impact orderTake
 * --file api/order.js` returned the 2 call-site files and nothing else.
 *
 * This module emits three groups of `type:'DEPENDS_ON'` edges:
 *
 *   (a) page → file      `page:<path>`      → `file:<path>.vue`      source_kind 'pages.json'
 *       one per declaration in `pages[]`, in every `subPackages[].pages[]`
 *       (the page path is joined with its `root`) and in `tabBar.list[].pagePath`.
 *
 *   (b) file → page      `file:<referrer>`  → `page:<target>`        source_kind 'navigation'
 *       one per `uni.navigateTo|redirectTo|switchTab|reLaunch({url})` call and per
 *       `<navigator url="…">` tag. Query strings and hashes are stripped before
 *       matching, so `/pages/x/index?id=1#y` targets `pages/x/index`.
 *
 *   (c) file → file      `file:<referrer>`  → `file:<component>.vue`  source_kind 'component'
 *       one per `import … from '@/…'` (or `./…`/`../…`) specifier that
 *       src/resolver/alias.js resolves to a real `.vue` file on disk. This is
 *       real resolution, never an import-basename guess. kebab-case tag usage
 *       inside a template is *not* turned into an edge (no reliable mapping from
 *       a tag back to the imported file) — only the import edge is emitted.
 *
 * Graph id conventions (must match src/analyzer.js / src/navigation.js):
 *   page node : `page:<posix repo-relative page path, no extension>`
 *   file node : `file:<posix repo-relative path>`
 *   symbol    : `sym:<the symbol's own file string>::<name>`  — never normalized:
 *               the TS parser emits '\\', so normalizing would silently miss.
 *
 * Anything that looks like a reference but cannot be resolved is collected in
 * `unresolved` (with a `reason`) — never dropped silently.
 */

import fs from 'fs';
import path from 'path';
import { resolveAlias } from '../resolver/alias.js';

/** Directories that never contain project sources. */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'unpackage', 'coverage',
  '.archnav', '.codegraph', '.gitnexus', '.hermes', '.cache',
]);

const SCAN_EXT = /\.(vue|js)$/i;
const NAV_METHODS = ['navigateTo', 'redirectTo', 'switchTab', 'reLaunch'];

// ═══════════════════════════════════════════════
//  Small text helpers
// ═══════════════════════════════════════════════

const toPosix = (p) => String(p || '').split(path.sep).join('/');
const stripLead = (p) => toPosix(p).replace(/^\.\//, '');
const trimSlashes = (p) => String(p || '').replace(/^\/+/, '').replace(/\/+$/, '');

/** 0-based byte offsets at which each line starts. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 1-based line of an absolute offset (binary search). */
function lineAt(starts, offset) {
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
 * Blank out `//` and block comments in a JSONC document while preserving every
 * newline and every string literal (a `//` inside a string is not a comment).
 * Line numbers downstream stay correct because the input length is preserved.
 */
function stripJsonComments(src) {
  const chars = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { chars[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      chars[i] = ' '; chars[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') chars[i] = ' ';
        i++;
      }
      if (i < n) { chars[i] = ' '; chars[i + 1] = ' '; i += 2; }
      continue;
    }
    i++;
  }
  return chars.join('');
}

/** All matches of a global regex, with their 1-based line. */
function matchesWithLines(text, re, starts) {
  const out = [];
  for (const m of text.matchAll(re)) out.push({ value: m[1], index: m.index, line: lineAt(starts, m.index) });
  return out;
}

// ═══════════════════════════════════════════════
//  (a) pages.json → page declarations
// ═══════════════════════════════════════════════

/**
 * Read `pages.json` (JSONC) and return the declared page paths.
 * Structure comes from JSON (after comments are stripped); the line of each
 * declaration comes from a positional scan of the same text, aligned by order.
 *
 * @returns {{ path: string, line: number, source: 'pages.json'|'subPackages'|'tabBar' }[]}
 */
function readPageDeclarations(repoDir) {
  const file = path.join(repoDir, 'pages.json');
  if (!fs.existsSync(file)) return null;

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const text = stripJsonComments(raw);
  const starts = lineStarts(text);

  const pathMatches = matchesWithLines(text, /"path"\s*:\s*"([^"]*)"/g, starts);
  const rootMatches = matchesWithLines(text, /"root"\s*:\s*"([^"]*)"/g, starts);
  const pagePathMatches = matchesWithLines(text, /"pagePath"\s*:\s*"([^"]*)"/g, starts);
  const subKey = text.search(/"subPackages"\s*:/);

  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }

  const decls = [];

  if (json) {
    // Main pages: every `"path"` before the `subPackages` key, in order.
    const mainLines = pathMatches.filter((p) => subKey < 0 || p.index < subKey);
    for (const [i, pg] of (json.pages || []).entries()) {
      if (!pg || typeof pg.path !== 'string' || !pg.path) continue;
      decls.push({ path: pg.path, line: mainLines[i]?.line ?? 0, source: 'pages.json' });
    }
    // Sub-packages: the paths between a root and the next root belong to it.
    for (const sp of (json.subPackages || [])) {
      if (!sp || typeof sp.root !== 'string' || !sp.root) continue;
      const rootIdx = text.indexOf(`"${sp.root}"`);
      const nextRoots = rootMatches.map((r) => r.index).filter((idx) => idx > rootIdx).sort((a, b) => a - b);
      const endIdx = nextRoots.length ? nextRoots[0] : text.length;
      const subLines = pathMatches.filter((p) => p.index > rootIdx && p.index < endIdx);
      const root = trimSlashes(sp.root);
      for (const [j, pg] of (sp.pages || []).entries()) {
        if (!pg || typeof pg.path !== 'string' || !pg.path) continue;
        decls.push({ path: `${root}/${trimSlashes(pg.path)}`, line: subLines[j]?.line ?? 0, source: 'subPackages' });
      }
    }
    // tabBar page paths.
    for (const [i, item] of ((json.tabBar && json.tabBar.list) || []).entries()) {
      if (!item || typeof item.pagePath !== 'string' || !item.pagePath) continue;
      decls.push({ path: trimSlashes(item.pagePath), line: pagePathMatches[i]?.line ?? 0, source: 'tabBar' });
    }
  } else {
    // JSONC could not be parsed: fall back to the positional scan so a slightly
    // malformed pages.json still yields pages instead of nothing.
    const mainLines = pathMatches.filter((p) => p.value && (subKey < 0 || p.index < subKey));
    for (const p of mainLines) decls.push({ path: trimSlashes(p.value), line: p.line, source: 'pages.json' });
    for (const r of rootMatches) {
      const next = rootMatches.map((x) => x.index).filter((idx) => idx > r.index).sort((a, b) => a - b)[0] ?? text.length;
      for (const p of pathMatches.filter((x) => x.value && x.index > r.index && x.index < next)) {
        decls.push({ path: `${trimSlashes(r.value)}/${trimSlashes(p.value)}`, line: p.line, source: 'subPackages' });
      }
    }
    for (const t of pagePathMatches.filter((x) => x.value)) {
      decls.push({ path: trimSlashes(t.value), line: t.line, source: 'tabBar' });
    }
  }

  return decls;
}

// ═══════════════════════════════════════════════
//  (b) navigation references
// ═══════════════════════════════════════════════

/**
 * `/pages/x/index?id=1#y` → `pages/x/index`. Returns '' for a non-literal.
 * A template literal keeps its static prefix (`/pages/x/index?${id}` → the
 * static part before `${`), which is enough to name the page.
 */
function normalizeTarget(raw) {
  let s = String(raw ?? '').trim().split('${')[0];
  s = s.split(/[?#]/)[0];
  return trimSlashes(toPosix(s));
}

/** Read the `url` value of a `{…}` argument window. */
function readUrlLiteral(windowText, starts, baseOffset) {
  const um = /url\s*([:,}])/.exec(windowText);
  if (!um) return { dynamic: true };
  if (um[1] !== ':') return { dynamic: true }; // `{ url }` shorthand
  const after = windowText.slice(um.index + um[0].length);
  const offset = baseOffset + um.index + um[0].length;
  const trimmed = after.match(/^\s*/)[0].length;
  const q = after[trimmed];
  const at = offset + trimmed;
  if (q === "'" || q === '"') {
    const end = after.indexOf(q, trimmed + 1);
    if (end < 0) return { dynamic: true };
    return { raw: after.slice(trimmed + 1, end), line: lineAt(starts, at) };
  }
  if (q === '`') {
    const end = after.indexOf('`', trimmed + 1);
    const body = after.slice(trimmed + 1, end < 0 ? after.length : end);
    return { raw: body, line: lineAt(starts, at) };
  }
  return { dynamic: true, line: lineAt(starts, at) };
}

/**
 * All navigation references of one file's source text.
 * @returns {{raw: string|null, line: number, via: string}[]}
 */
function findNavigationRefs(src, starts) {
  const refs = [];

  // uni.navigateTo({ url: '…' }) and friends.
  const methodRe = new RegExp(`\\buni\\s*\\.\\s*(${NAV_METHODS.join('|')})\\s*\\(`, 'g');
  for (const m of src.matchAll(methodRe)) {
    const paren = m.index + m[0].length - 1;
    const windowEnd = Math.min(src.length, paren + 400);
    const windowText = src.slice(paren + 1, windowEnd);
    const hit = readUrlLiteral(windowText, starts, paren + 1);
    if (hit.dynamic) {
      refs.push({ raw: null, line: lineAt(starts, m.index), via: `uni.${m[1]}` });
    } else {
      refs.push({ raw: hit.raw, line: hit.line, via: `uni.${m[1]}` });
    }
  }

  // <navigator url="/pages/x"> / <navigator :url="…"> (bound → dynamic).
  const tagRe = /<navigator\b([^>]*)>/gi;
  for (const m of src.matchAll(tagRe)) {
    const attrs = m[1] || '';
    const bound = /:url\s*=/.test(attrs);
    const lit = /\burl\s*=\s*(['"])([^'"]*)\1/.exec(attrs);
    const line = lineAt(starts, m.index);
    if (bound || !lit) refs.push({ raw: null, line, via: 'navigator' });
    else refs.push({ raw: lit[2], line, via: 'navigator' });
  }

  return refs;
}

// ═══════════════════════════════════════════════
//  (c) component imports
// ═══════════════════════════════════════════════

/** `import X from '…'` / `import { a, b } from '…'` / `import '…'` specifiers. */
function findImportSpecs(src, starts) {
  const out = [];
  const re = /import\s+(?:[^'";]*?\sfrom\s*)?(['"])([^'"]+)\1/g;
  for (const m of src.matchAll(re)) {
    out.push({ spec: m[2], line: lineAt(starts, m.index) });
  }
  return out;
}

/**
 * Does this specifier plausibly name a component file? Used to decide whether a
 * specifier is worth resolving at all: `@/api/order.js` can never be a `.vue`,
 * and resolveAlias re-walks the fs on every call. A component is either an
 * explicit `.vue`, lives under a `components/` directory, or is an
 * extension-less *relative* import (which may point at `./Something.vue`).
 */
const looksLikeComponent = (spec) => /\.vue$/i.test(spec)
  || /(^|\/)components\//.test(spec)
  || (/^\.\.?\//.test(spec) && !/\.[a-z0-9]+$/i.test(spec));

// ═══════════════════════════════════════════════
//  Public entry point
// ═══════════════════════════════════════════════

/** Recursively collect `.vue` / `.js` files (repo-relative, posix). */
function discoverSources(repoDir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(path.join(abs, entry.name), childRel);
      } else if (entry.isFile() && SCAN_EXT.test(entry.name)) {
        out.push(childRel);
      }
    }
  };
  walk(repoDir, '');
  return out.sort();
}

/**
 * Extract uni-app page / navigation / component structure from a repo.
 *
 * @param {string} repoDir  repository root (the dir that was analyzed)
 * @param {Array}  symbols  the analysis symbol list. Kept in the signature for
 *                          parity with the other parsers; the page/component
 *                          edges are file-level and need no symbol lookup.
 * @returns {{ edges: Array, nodes: Array, stats: object, unresolved: Array }}
 */
export function extractUniPages(repoDir, symbols = []) { // eslint-disable-line no-unused-vars
  const root = path.resolve(repoDir);
  const t0 = Date.now();
  const edges = [];
  const nodes = [];
  const unresolved = [];
  const stats = {
    pages: 0,
    pagesFromPagesJson: 0,
    pagesFromSubPackages: 0,
    pagesFromTabBar: 0,
    pageEdges: 0,
    missingVue: 0,
    navigationRefs: 0,
    navigationEdges: 0,
    navigationUnresolved: 0,
    componentImports: 0,
    componentEdges: 0,
    componentUnresolved: 0,
    filesScanned: 0,
    unresolved: 0,
    ms: 0,
  };

  const decls = readPageDeclarations(root);
  const sources = discoverSources(root);

  // A repo with neither pages.json nor any .vue is not a uni-app front-end
  // (e.g. bench/php-app) — leave the graph untouched rather than pay for a scan.
  if (decls === null && !sources.some((s) => /\.vue$/i.test(s))) {
    stats.skipped = true;
    stats.ms = Date.now() - t0;
    return { edges, nodes, stats, unresolved };
  }

  // ── (a) page nodes + page → file edges ────────────────────────────────────
  const pageDecl = new Map(); // page path → merged declaration
  for (const d of decls || []) {
    const p = trimSlashes(d.path);
    if (!p) continue;
    const existing = pageDecl.get(p);
    if (existing) {
      existing.sources.add(d.source);
      continue;
    }
    pageDecl.set(p, { path: p, line: d.line, sources: new Set([d.source]) });
  }

  const knownPages = new Set(pageDecl.keys());
  for (const decl of pageDecl.values()) {
    const sourcesList = [...decl.sources];
    nodes.push({
      id: `page:${decl.path}`,
      type: 'page',
      name: decl.path,
      file: 'pages.json',
      line: decl.line,
      source: sourcesList[0],
      sources: sourcesList,
      path: decl.path,
    });
    stats.pages++;
    if (sourcesList.includes('pages.json')) stats.pagesFromPagesJson++;
    if (sourcesList.includes('subPackages')) stats.pagesFromSubPackages++;
    if (sourcesList.includes('tabBar')) stats.pagesFromTabBar++;

    const vueRel = `${decl.path}.vue`;
    if (fs.existsSync(path.join(root, vueRel))) {
      edges.push({
        from: `page:${decl.path}`,
        to: `file:${vueRel}`,
        type: 'DEPENDS_ON',
        line: decl.line,
        source_kind: 'pages.json',
      });
      stats.pageEdges++;
    } else {
      stats.missingVue++;
      unresolved.push({ kind: 'page', file: 'pages.json', line: decl.line, target: decl.path, reason: 'missing-vue' });
    }
  }

  // ── (b) navigation edges + (c) component edges ────────────────────────────
  // Per-run memo of alias resolution keyed by (importing dir, specifier): a page
  // directory imports the same components over and over and resolveAlias walks
  // the fs, so this is the difference between ~2.4s and ~0.9s on 300+ files.
  const aliasMemo = new Map();
  const resolveCached = (spec, dir, absFile) => {
    const key = `${dir}\u0000${spec}`;
    if (aliasMemo.has(key)) return aliasMemo.get(key);
    const hit = resolveAlias(spec, { repoDir: root, fromFile: absFile });
    aliasMemo.set(key, hit);
    return hit;
  };

  for (const rel of sources) {
    const abs = path.join(root, rel);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    stats.filesScanned++;
    const starts = lineStarts(src);

    for (const ref of findNavigationRefs(src, starts)) {
      stats.navigationRefs++;
      if (ref.raw === null) {
        stats.navigationUnresolved++;
        unresolved.push({ kind: 'navigation', file: rel, line: ref.line, target: null, via: ref.via, reason: 'dynamic-url' });
        continue;
      }
      const target = normalizeTarget(ref.raw);
      if (!target) {
        stats.navigationUnresolved++;
        unresolved.push({ kind: 'navigation', file: rel, line: ref.line, target: ref.raw, via: ref.via, reason: 'dynamic-url' });
        continue;
      }
      if (!knownPages.has(target)) {
        stats.navigationUnresolved++;
        unresolved.push({ kind: 'navigation', file: rel, line: ref.line, target, via: ref.via, reason: 'unknown-page' });
        continue;
      }
      edges.push({
        from: `file:${rel}`,
        to: `page:${target}`,
        type: 'DEPENDS_ON',
        line: ref.line,
        source_kind: 'navigation',
      });
      stats.navigationEdges++;
    }

    for (const imp of findImportSpecs(src, starts)) {
      const spec = imp.spec;
      if (!spec.startsWith('@/') && !/^\.\.?\//.test(spec)) continue;
      // Only component-shaped specifiers are resolved. `@/api/x.js` / `@/utils`
      // can never be a component file, so resolving them is wasted work; a
      // component imported from outside a `components/` dir is still caught by
      // the explicit `.vue` extension.
      if (!looksLikeComponent(spec)) continue;
      stats.componentImports++;
      const resolved = resolveCached(spec, path.dirname(abs), abs);
      if (resolved && /\.vue$/i.test(resolved) && resolved !== stripLead(rel)) {
        edges.push({
          from: `file:${rel}`,
          to: `file:${stripLead(resolved)}`,
          type: 'DEPENDS_ON',
          line: imp.line,
          source_kind: 'component',
        });
        stats.componentEdges++;
      } else if (!resolved) {
        stats.componentUnresolved++;
        unresolved.push({ kind: 'component', file: rel, line: imp.line, target: spec, reason: 'unresolved-import' });
      }
    }
  }

  stats.unresolved = unresolved.length;
  stats.ms = Date.now() - t0;
  return { edges, nodes, stats, unresolved };
}
