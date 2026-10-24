/**
 * Code Analyzer — Scans codebase for symbols, functions, classes, imports
 * Uses acorn AST parser (tree-sitter quality, zero native dependencies)
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { parseFileAsync } from './parsers/dispatcher.js';
import { parseVueFile } from './parsers/vueSymbols.js';
import { extractLaravelRoutes } from './parsers/laravelRoutes.js';
import { extractUniPages } from './parsers/uniPages.js';
import { buildResolvedEdges } from './resolver/integrate.js';

export async function analyze(dirPath, options = {}) {
  const startTime = Date.now();
  const files = [];
  const symbols = [];
  const dependencies = [];
  const fileHashes = {};

  // `--ignore` support: this project's own bench/ fixtures (and any vendor tree)
  // live inside the repo and used to be indexed as if they were our code — a
  // self-review gave 5 836 symbols instead of 448 and 5 069 findings from
  // customer code. Patterns are gitignore-ish globs, matched against the
  // repo-relative POSIX path.
  const ignorePatterns = normalizeIgnore(options.ignore);
  const ignored = makeIgnoreFilter(ignorePatterns);

  // Walk directory
  await walkDir(dirPath, files, { ignored, baseDir: dirPath });
  
  // Parse each file
  const allCalls = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    // `.vue` needs the SFC-aware path: extract <script>/<script setup>, parse it,
    // and shift line numbers by the block offset. The generic dispatcher would
    // hand the whole file (template included) to acorn and report garbage
    // symbols; `parseVueFile` only emits real script symbols. It contributes no
    // `calls` — the resolver layer already owns .vue call edges.
    const result = /\.vue$/i.test(file)
      ? parseVueFile(file, dirPath, content)
      : await parseFileAsync(file, dirPath);
    const fileSymbols = result.symbols || [];
    symbols.push(...fileSymbols);
    if (result.calls) allCalls.push(...result.calls.map(c => ({ ...c, file: c.file || path.relative(dirPath, file) })));

    // Track file hash for staleness
    fileHashes[path.relative(dirPath, file)] = hashContent(content);
  }
  
  // Build dependency graph
  const depGraph = buildDependencyGraph(symbols);
  
  // Infer architecture layers
  const architecture = inferArchitecture(files, symbols, dirPath);
  
  // Detect communities (clusters) if requested
  const communities = options.cluster !== false ? detectCommunities(symbols, depGraph) : [];
  
  // Detect data flows
  const flows = detectFlows(symbols, depGraph, architecture);
  
  // Build layer mapping for each symbol
  const layerMap = {};
  for (const sym of symbols) {
    const layer = findLayerForFile(sym.file, architecture);
    if (layer) layerMap[sym.id] = layer;
  }

  // Build knowledge graph (nodes + edges for architecture visualization)
  const graphRaw = buildKnowledgeGraph(files, dirPath, architecture, communities, flows, depGraph, layerMap, symbols, allCalls, options);
  // Safety net: the resolver / route / page extractors can add nodes and edges for
  // paths the walker never visited; drop anything under an ignored path so the
  // index stays consistent no matter which subsystem produced it.
  const knowledgeGraph = ignorePatterns.length ? pruneIgnored(graphRaw, ignored) : graphRaw;
  
  const elapsed = Date.now() - startTime;
  
  return {
    type: 'analysis',
    projectName: path.basename(dirPath),
    projectPath: dirPath,
    files: files.length,
    symbols: symbols.length,
    dependencies: depGraph.length,
    layers: architecture.layers.length,
    clusters: communities.length,
    flows: flows.length,
    analysisTime: `${(elapsed / 1000).toFixed(1)}s`,
    files: files.map(f => path.relative(dirPath, f)),
    symbols: symbols,
    dependencyGraph: depGraph,
    architecture: {
      layers: architecture.layers,
      violations: architecture.violations,
    },
    communities,
    flows,
    fileHashes,
    layerMap,
    // recorded so `status`/staleness can honour the same exclusions instead of
    // reporting ignored files as newly added
    ignore: ignorePatterns,
    knowledgeGraph,
    // Laravel routes that could not be bound to a controller action — surfaced
    // here (and in index.json) so they are visible instead of silently dropped.
    unresolvedRoutes: knowledgeGraph?.unresolvedRoutes || [],
    routeStats: knowledgeGraph?.routeStats || null,
    // uni-app page/navigation/component structure that could not be resolved —
    // surfaced here (and in index.json) so it is visible, not silently dropped.
    uniPageStats: knowledgeGraph?.uniPageStats || null,
    unresolvedPages: knowledgeGraph?.unresolvedPages || [],
    _raw: {
      symbols, depGraph, architecture, fileHashes, layerMap, knowledgeGraph,
      // must be in `_raw` too: saveIndex() persists `_raw`, and without it the
      // staleness check would keep reporting ignored files as newly added
      ignore: ignorePatterns,
      unresolvedRoutes: knowledgeGraph?.unresolvedRoutes || [],
      routeStats: knowledgeGraph?.routeStats || null,
      uniPageStats: knowledgeGraph?.uniPageStats || null,
      unresolvedPages: knowledgeGraph?.unresolvedPages || [],
    },
  };
}

/**
 * Gitignore-ish glob → RegExp. Supports `**` (any depth), `*`, `?`; a pattern
 * without a slash also matches any path segment, so `--ignore bench` and
 * `--ignore bench/**` both do what people mean.
 */
export function globToRegExp(glob) {
  const g = String(glob).trim().replace(/^\.\//, '');
  if (!g) return null;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` (any dirs) or trailing `**` (everything below)
        if (g[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  // A bare name (no slash, no wildcard) matches the segment anywhere in the path.
  const bare = !g.includes('/') && !/[?*]/.test(g);
  if (bare) return new RegExp(`(?:^|/)${re}(?:/|$)`);
  return new RegExp(`^${re}(?:/.*)?$`);
}

export function normalizeIgnore(ignore) {
  if (!ignore) return [];
  const list = Array.isArray(ignore) ? ignore : String(ignore).split(',');
  return list.map((s) => String(s).trim()).filter(Boolean);
}

/** Build the predicate used by the walker *and* the post-filter. */
export function makeIgnoreFilter(patterns) {
  const res = normalizeIgnore(patterns).map(globToRegExp).filter(Boolean);
  if (!res.length) return () => false;
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  return (relPath) => {
    const p = norm(relPath);
    if (!p) return false;
    return res.some((re) => re.test(p));
  };
}

/**
 * Drop nodes/edges that belong to an ignored path. `file:` nodes carry a path, and
 * edges reference node ids, so filtering nodes is enough as long as edges whose
 * endpoints vanished go too.
 */
export function pruneIgnored(knowledgeGraph, ignored) {
  if (!knowledgeGraph) return knowledgeGraph;
  const pathOf = (id) => {
    const s = String(id);
    if (s.startsWith('file:')) return s.slice(5);
    if (s.startsWith('sym:')) return s.slice(4).split('::')[0];
    return null;
  };
  const nodes = (knowledgeGraph.nodes || []).filter((n) => {
    const p = pathOf(n.id) || n.file || null;
    return !p || !ignored(p);
  });
  const keptIds = new Set(nodes.map((n) => String(n.id)));
  const filePrefixOk = (id) => {
    const s = String(id);
    // layer:/dir:/route:/page:/flow:/comm: nodes are not per-file; page/route carry
    // a file themselves and are filtered by the node pass above
    if (!s.startsWith('file:') && !s.startsWith('sym:')) return true;
    const p = pathOf(s);
    return !p || !ignored(p);
  };
  const edges = (knowledgeGraph.edges || []).filter((e) => {
    const from = String(e.from);
    const to = String(e.to);
    if ((from.startsWith('file:') || from.startsWith('sym:')) && !keptIds.has(from)) return false;
    if ((to.startsWith('file:') || to.startsWith('sym:')) && !keptIds.has(to)) return false;
    return filePrefixOk(from) && filePrefixOk(to);
  });
  const prunedCount = (knowledgeGraph.nodes || []).length - nodes.length;
  return { ...knowledgeGraph, nodes, edges, prunedIgnored: prunedCount };
}

async function walkDir(dirPath, files, { ignored = () => false, baseDir = dirPath } = {}) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const rel = path.relative(baseDir, fullPath);
    if (ignored(rel)) continue; // skip the directory early: nothing below it is wanted
    if (entry.isDirectory()) {
      await walkDir(fullPath, files, { ignored, baseDir });
    } else if (entry.isFile() && /\.(js|ts|tsx|jsx|mjs|cjs|vue|py|go|rs|java|php|c|cpp|cc|cxx|h|hpp|hh|cs|rb|sh|bash|ps1|psm1|psd1)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
}

/**
 * Build knowledge graph — file/dir/layer/community/flow nodes + edges
 * Transforms flat analysis data into a queryable graph structure
 */
function buildKnowledgeGraph(files, baseDir, architecture, communities, flows, depGraph, layerMap, symbols, allCalls, resolveOptions = {}) {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();

  function addNode(id, type, name, meta = {}) {
    if (nodeIds.has(id)) return;
    nodeIds.add(id);
    nodes.push({ id, type, name, ...meta });
  }

  function addEdge(from, to, type, meta = {}) {
    edges.push({ from, to, type, ...meta });
  }

  // 1. File nodes
  const fileNodeIds = [];
  for (const file of files) {
    const relFile = typeof file === 'string' ? file : path.relative(baseDir, file);
    addNode(relFile, 'file', path.basename(relFile), { path: relFile });
    fileNodeIds.push(relFile);

    // 2. Directory nodes + CONTAINS edges
    const dirs = relFile.split(/[\\/]/);
    let dirPath = '';
    for (const d of dirs.slice(0, -1)) {
      dirPath = dirPath ? `${dirPath}/${d}` : d;
      addNode(`dir:${dirPath}`, 'directory', d, { path: dirPath });
      if (dirPath === d) {
        addEdge(`dir:${dirPath}`, relFile, 'CONTAINS');
      } else {
        const parentDir = dirPath.substring(0, dirPath.lastIndexOf('/'));
        addEdge(`dir:${parentDir}`, `dir:${dirPath}`, 'CONTAINS');
        addEdge(`dir:${dirPath}`, relFile, 'CONTAINS');
      }
    }
  }

  // 3. Layer nodes + BELONGS_TO edges
  for (const layer of architecture.layers) {
    const layerId = `layer:${layer.name}`;
    addNode(layerId, 'layer', layer.name, { priority: layer.priority || 99 });

    // Match files to layers
    for (const file of files) {
      const relFile = typeof file === 'string' ? file : path.relative(baseDir, file);
      if (layer.pattern && new RegExp(layer.pattern).test(relFile)) {
        addEdge(relFile, layerId, 'BELONGS_TO');
      }
    }
  }

  // 4. Community nodes + MEMBER_OF edges
  for (const comm of communities) {
    const commId = `comm:${comm.name}`;
    addNode(commId, 'community', comm.name, { fileCount: comm.fileCount });
    for (const symName of (comm.symbols || [])) {
      const symFile = layerMap ? Object.entries(layerMap).find(([k]) => k === symName)?.[0] : null;
      if (symFile) addEdge(`sym:${symName}`, commId, 'MEMBER_OF');
    }
  }

  // 5. Flow nodes + HAS_STEP edges
  for (const flow of flows) {
    const flowId = `flow:${flow.name}`;
    addNode(flowId, 'flow', flow.name);
    for (const step of (flow.path || [])) {
      const stepName = step.split(' ')[0]; // "symbolName (file)" → "symbolName"
      addEdge(flowId, `sym:${stepName}`, 'HAS_STEP');
    }
  }

  // 6. File-level IMPORTS edges
  const fileImports = new Map();
  for (const dep of depGraph) {
    const fromFile = dep.fromFile;
    const toFile = dep.toFile;
    const key = `${fromFile}→${toFile}`;
    if (!fileImports.has(key)) {
      fileImports.set(key, { fromFile, toFile, count: 0 });
    }
    fileImports.get(key).count++;
  }
  for (const [_, imp] of fileImports) {
    addEdge(imp.fromFile, imp.toFile, 'IMPORTS', { weight: imp.count });
  }

  // 7. Symbol nodes + edges
  for (const sym of (symbols || [])) {
    const symId = `sym:${sym.file}::${sym.name}`;  // unique per file+name
    addNode(symId, 'symbol', sym.name, {
      kind: sym.kind,
      line_start: sym.line_start,
      line_end: sym.line_end,
      file: sym.file,
    });
    // Symbol CONTAINS file
    addEdge(sym.file, symId, 'CONTAINS');
    // Symbol BELONGS_TO layer
    const layer = layerMap?.[sym.id];
    if (layer) addEdge(symId, `layer:${layer}`, 'BELONGS_TO');
  }

  // 8. Import package nodes — external npm package imports
  const knownLocal = new Set(['services', 'models', 'repositories', 'middleware', 'config', 'controllers', 'utils', 'api']);
  const seenPkgs = new Set();
  for (const dep of depGraph) {
    const name = dep.toFile;
    if (name && !name.includes('/') && name !== '.' && !knownLocal.has(name)) {
      const pkgId = `pkg:${name}`;
      if (!seenPkgs.has(name)) {
        seenPkgs.add(name);
        addNode(pkgId, 'package', name);
      }
      addEdge(dep.fromFile, pkgId, 'IMPORTS');
    }
  }

  // 9. Variable nodes — module-level variables (from Python + JS)
  for (const sym of (symbols || [])) {
    if (sym.kind === 'variable' && !nodeIds.has(`var:${sym.file}::${sym.name}`)) {
      const varId = `var:${sym.file}::${sym.name}`;
      addNode(varId, 'variable', sym.name, {
        file: sym.file, line_start: sym.line_start, line_end: sym.line_end,
      });
      addEdge(sym.file, varId, 'CONTAINS');
    }
  }

  // 10. Export edges for exported symbols
  for (const sym of (symbols || [])) {
    if (sym.exported) {
      const symId = `sym:${sym.file}::${sym.name}`;
      if (nodeIds.has(symId)) {
        addEdge(symId, `${sym.file}`, 'EXPORTS');
      }
    }
  }

  // 11. Route nodes — detect server-side Express/Koa/Fastify route registrations.
  //     Scoped on purpose: a bare `x.get('/y')` inside a front-end API wrapper or
  //     a .vue component is NOT a route. Before this filter the uni-app fixture
  //     produced 315 bogus route nodes (and they leaked an absolute path into the
  //     node id); only server-ish files with a server-ish receiver count.
  const SERVER_ROUTE_RE =
    /\b(?:app|router|server|route|api|fastify)\s*\.\s*(get|post|put|delete|patch|all)\s*\(\s*['"]([^'"]+)['"]/g;
  for (const file of files) {
    const relFile = relPosix(baseDir, file);
    if (!/\.(js|mjs|cjs|ts)$/i.test(relFile)) continue;
    if (/(^|\/)(components|pages|subpackage|mixins|store|utils)\//.test(relFile)) continue;
    try {
      const content = fs.readFileSync(path.resolve(baseDir, relFile), 'utf-8');
      for (const m of content.matchAll(SERVER_ROUTE_RE)) {
        const method = m[1].toUpperCase();
        const routePath = m[2];
        const routeId = `route:${relFile}::${method} ${routePath}`;
        addNode(routeId, 'route', `${method} ${routePath}`, {
          method, path: routePath, file: relFile,
        });
        addEdge(relFile, routeId, 'DEFINES_ROUTE');
      }
    } catch {}
  }

  // 12. Anonymous function nodes — unnamed arrow/function expressions
  for (const file of files) {
    const relFile = typeof file === 'string' ? file : path.relative(baseDir, file);
    try {
      const content = fs.readFileSync(path.resolve(baseDir, relFile), 'utf-8');
      // Count standalone arrow functions not assigned to const/let/var
      const arrows = content.match(/(?:=>\s*\{|=>\s*[^;]*\n)/g);
      const anonCount = Math.min(arrows ? arrows.length : 0, 30);
      for (let i = 0; i < anonCount; i++) {
        const anonId = `anon:${relFile}::fn${i + 1}`;
        addNode(anonId, 'anonymous', `λ#${i + 1}`, { file: relFile });
        addEdge(relFile, anonId, 'CONTAINS');
      }
    } catch {}
  }

  // 13. Export statement nodes — module.exports / export default blocks
  for (const file of files) {
    const relFile = typeof file === 'string' ? file : path.relative(baseDir, file);
    try {
      const content = fs.readFileSync(path.resolve(baseDir, relFile), 'utf-8');
      if (content.includes('module.exports')) {
        addNode(`export:${relFile}`, 'export', 'module.exports', { file: relFile });
        addEdge(relFile, `export:${relFile}`, 'DEFINES_EXPORT');
      }
    } catch {}
  }

  // 14. Call edges (DEPENDS_ON) — function-level call relationships from AST
  const symbolByName = new Map();
  for (const sym of (symbols || [])) {
    if (!symbolByName.has(sym.name)) symbolByName.set(sym.name, sym); // first match wins (previous linear-scan semantics)
  }
  for (const call of (allCalls || [])) {
    if (call.caller && call.callee) {
      const callerId = `sym:${call.file}::${call.caller}`;
      const target = symbolByName.get(call.callee);
      const calleeId = target ? `sym:${target.file}::${target.name}` : `sym:${call.file}::${call.callee}`;
      if (callerId !== calleeId) {
        const meta = { line: call.line };
        if (call.source_kind) meta.source_kind = call.source_kind; // 'ast' | 'heuristic' (how the target was resolved)
        if (call.receiver) meta.receiver = call.receiver;
        addEdge(callerId, calleeId, 'DEPENDS_ON', meta);
      }
    }
  }

  // 14b. Laravel route edges (DEPENDS_ON) — `routes/*.php` → controller action.
  //      Route files contribute no symbols, so without this step the graph had no
  //      "HTTP entry point → handler" edge and impact() treated controller actions
  //      as the outermost consumers. Unresolvable routes are collected loudly
  //      (`unresolvedRoutes`) instead of being dropped.
  let unresolvedRoutes = [];
  let routeStats = { routes: 0, edges: 0, unresolved: 0 };
  try {
    const { edges: routeEdges, routes: routeNodes, unresolved } = extractLaravelRoutes(baseDir, symbols);
    for (const r of routeNodes) {
      addNode(r.id, 'route', r.name, {
        method: r.method,
        uri: r.uri,
        file: r.file,
        line: r.line,
        ...(r.controller ? { controller: r.controller, action: r.action } : {}),
      });
    }
    for (const e of routeEdges) {
      addEdge(e.from, e.to, 'DEPENDS_ON', {
        line: e.line,
        source_kind: 'route',
        ...(e.action ? { action: e.action } : {}),
      });
    }
    unresolvedRoutes = unresolved;
    routeStats = { routes: routeNodes.length, edges: routeEdges.length, unresolved: unresolved.length };
  } catch (err) {
    routeStats = { error: String((err && err.message) || err) };
  }

  // 14c. uni-app page/component edges (DEPENDS_ON) — `pages.json` page nodes and
  //      the `page: → file:` edges that map them onto their .vue file, plus the
  //      `file: → page:` navigation edges (uni.navigateTo/… , <navigator url>)
  //      and `file: → file:` component edges (`@/components/…` imports).
  //      Without these, a `.vue` call site is a `file:` node with **zero incoming
  //      edges**, so a depth-2 reverse DEPENDS_ON walk (impact()) was
  //      structurally empty on the Vue side. Unresolvable references are kept in
  //      `unresolvedPages` instead of being dropped.
  let uniPageStats = { skipped: true };
  let unresolvedPages = [];
  try {
    const { edges: uniEdges, nodes: uniNodes, stats, unresolved } = extractUniPages(baseDir, symbols);
    for (const n of uniNodes) {
      addNode(n.id, n.type, n.name, {
        file: n.file,
        line: n.line,
        source: n.source,
        ...(n.sources ? { sources: n.sources } : {}),
        ...(n.path ? { path: n.path } : {}),
      });
    }
    for (const e of uniEdges) {
      addEdge(e.from, e.to, 'DEPENDS_ON', {
        line: e.line,
        source_kind: e.source_kind,
        ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
      });
    }
    unresolvedPages = unresolved;
    uniPageStats = stats;
  } catch (err) {
    uniPageStats = { error: String((err && err.message) || err) };
  }

  // 15. Resolver edges (DEPENDS_ON) — call sites the AST layer cannot see:
  //     Blade templates, Vue/JS calls nested inside callbacks, alias imports.
  //     Disable with `analyze --no-resolver` or ARCHNAV_NO_RESOLVER=1.
  let resolverStats = { skipped: true };
  const resolverEnabled = resolveOptions.resolver !== false && process.env.ARCHNAV_NO_RESOLVER !== '1';
  if (resolverEnabled) {
    try {
      const { edges: resolvedEdges, stats } = buildResolvedEdges(baseDir, { symbols });
      for (const e of resolvedEdges) {
        addNode(e.from, 'file-ref', stripFilePrefix(e.from), {});
        addEdge(e.from, e.to, e.type, {
          line: e.line,
          source_kind: e.source_kind,
          confidence: e.confidence,
          ...(e.note ? { note: e.note } : {}),
        });
      }
      resolverStats = stats;
    } catch (err) {
      resolverStats = { error: String((err && err.message) || err) };
    }
  }

  return { nodes, edges, resolverStats, unresolvedRoutes, routeStats, uniPageStats, unresolvedPages };
}

function stripFilePrefix(id) {
  return String(id).replace(/^(sym|file):/, '').split('::')[0];
}

/**
 * Repo-relative POSIX path for a file entry (which may already be relative or
 * absolute). Node ids must never carry an absolute path or a backslash — both
 * leaked into `route:` ids before this helper existed.
 */
function relPosix(baseDir, file) {
  const rel = typeof file === 'string' ? file : path.relative(baseDir, file);
  return String(rel).replace(/\\/g, '/');
}

function buildDependencyGraph(symbols) {
  const deps = [];
  for (const sym of symbols) {
    if (sym.imports) {
      for (const imp of sym.imports) {
        // imp can be a string (old format) or an object { source, specifiers } (treewalker format)
        const source = typeof imp === 'string' ? imp : imp.source;
        if (!source) continue;
        const resolved = resolveImport(source, sym.file);
        deps.push({
          from: sym.id,
          fromFile: sym.file,
          to: resolved,
          toFile: resolved,
          type: 'import',
        });
      }
    }
  }
  return deps;
}

function resolveImport(importPath, sourceFile) {
  // Simple resolution: extract the package/file name
  const name = importPath.replace(/^\.\.?\//, '').replace(/\/.*$/, '');
  return name;
}

function inferArchitecture(files, symbols, baseDir) {
  const layerPatterns = [
    { name: 'API (Controller)', pattern: /controllers?[\/\\]/i, priority: 1 },
    { name: 'Business (Service)', pattern: /services?[\/\\]/i, priority: 2 },
    { name: 'Data (Repository)', pattern: /repositor(?:y|ies)[\/\\]/i, priority: 3 },
    { name: 'Model / Validation', pattern: /models?[\/\\]/i, priority: 4 },
    { name: 'Middleware', pattern: /middleware[\/\\]/i, priority: 5 },
    { name: 'Configuration', pattern: /config[\/\\]/i, priority: 6 },
    { name: 'Utilities', pattern: /utils?[\/\\]/i, priority: 7 },
    { name: 'Infrastructure', pattern: /infrastructure[\/\\]|lib[\/\\]|shared[\/\\]/i, priority: 8 },
  ];

  const layerMap = {};
  const layers = [];
  const violations = [];

  // Map files to layers
  for (const file of files) {
    const relPath = typeof file === 'string' ? file : path.relative(baseDir, file);
    let matched = false;
    for (const lp of layerPatterns) {
      if (lp.pattern.test(relPath)) {
        if (!layerMap[lp.name]) {
          layerMap[lp.name] = { name: lp.name, files: [], symbols: [], dependencies: [], priority: lp.priority };
        }
        layerMap[lp.name].files.push(relPath);
        // Find symbols belonging to this file. `relPath` may be absolute while
        // symbol paths are repo-relative (and one parser emits backslashes,
        // another posix), so compare separator-normalised suffixes.
        const norm = (p) => String(p).replace(/\\/g, '/');
        const fileSymbols = symbols.filter((s) => {
          const sf = norm(s.file);
          return sf === norm(relPath) || norm(relPath).endsWith(`/${sf}`);
        });
        layerMap[lp.name].symbols.push(...fileSymbols.map(s => s.name));
        // Collect imports
        const fileImports = fileSymbols.filter(s => s.imports).flatMap(s => s.imports);
        layerMap[lp.name].dependencies.push(...fileImports);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Unmatched files go to a generic layer
      const name = 'Unknown / Other';
      if (!layerMap[name]) {
        layerMap[name] = { name, files: [], symbols: [], dependencies: [], priority: 99 };
      }
      layerMap[name].files.push(relPath);
    }
  }

  // Build layer violation checks
  const layerOrder = Object.values(layerMap).sort((a, b) => a.priority - b.priority);
  
  // Check for layer violations (e.g., controller directly importing repository)
  for (const layer of layerOrder) {
    for (const dep of layer.dependencies) {
      // `imports` entries are strings in the legacy shape but `{source,line}`
      // objects in the current parsers — calling .replace() on those throws and
      // takes the whole analyze() down, so normalise before matching.
      const depStr = typeof dep === 'string' ? dep : (dep && typeof dep === 'object' ? (dep.source || dep.from || '') : '');
      if (!depStr) continue;
      for (const otherLayer of layerOrder) {
        if (otherLayer.name === layer.name) continue;
        if (otherLayer.files.some(f => f.includes(depStr.replace(/^\.\.?\//, '').replace(/\/.*$/, '').replace(/'/g, '')))) {
          // Check if this is a "allowed" dependency direction
          if (layer.priority < otherLayer.priority) {
            // Higher layer depending on lower layer = OK (controller → service)
            // This is normal
          } else if (layer.priority > otherLayer.priority) {
            // Lower layer depending on higher layer = potential violation
            // (e.g., repository importing controller)
            violations.push({
              layer: layer.name,
              dependsOn: otherLayer.name,
              details: `${layer.name} depends on ${otherLayer.name}, which is against layering rules`,
            });
          }
        }
      }
    }
  }

  return {
    layers: layerOrder.map(l => ({
      name: l.name,
      pattern: layerPatterns.find(p => p.name === l.name)?.pattern?.source || 'auto-detected',
      files: l.files.length,
      symbols: l.symbols.length,
      dedupedSymbols: [...new Set(l.symbols)].length,
      dependencies: [...new Set(l.dependencies)].slice(0, 10),
    })),
    violations,
  };
}

function detectCommunities(symbols, depGraph) {
  // Simple community detection: group by directory
  const communities = {};
  for (const sym of symbols) {
    const dir = path.dirname(sym.file);
    if (!communities[dir]) communities[dir] = { name: dir, symbols: [], files: new Set() };
    communities[dir].symbols.push(sym.name);
    communities[dir].files.add(sym.file);
  }
  return Object.values(communities).map(c => ({
    name: c.name,
    symbols: [...new Set(c.symbols)].slice(0, 20),
    fileCount: c.files.size,
  }));
}

function detectFlows(symbols, depGraph, architecture) {
  // Detect data flows based on import chains
  const flows = [];
  const layers = architecture.layers;
  
  // Look for common flow patterns: API → Service → Repository
  const apiLayer = layers.find(l => l.name.includes('API'));
  const svcLayer = layers.find(l => l.name.includes('Business'));
  const repoLayer = layers.find(l => l.name.includes('Data'));
  
  if (apiLayer && svcLayer) {
    // Find symbols in API layer
    const apiSymbols = symbols.filter(s => apiLayer.pattern ? 
      new RegExp(apiLayer.pattern).test(s.file) : s.file.startsWith('src/controllers'));
    const svcSymbols = symbols.filter(s => svcLayer.pattern ?
      new RegExp(svcLayer.pattern).test(s.file) : s.file.startsWith('src/services'));
    const repoSymbols = repoLayer ? symbols.filter(s => repoLayer.pattern ?
      new RegExp(repoLayer.pattern).test(s.file) : s.file.startsWith('src/repositories')) : [];
    
    // Build flow
    const flowPath = [];
    for (const s of apiSymbols) flowPath.push(`${s.name} (${s.file})`);
    for (const s of svcSymbols.slice(0, 3)) flowPath.push(`${s.name} (${s.file})`);
    if (repoSymbols.length > 0) {
      for (const s of repoSymbols.slice(0, 2)) flowPath.push(`${s.name} (${s.file})`);
    }
    
    flows.push({
      name: 'API → Service → Data',
      path: flowPath.slice(0, 5),
    });
  }
  
  return flows;
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex').substring(0, 12);
}

function findLayerForFile(filePath, architecture) {
  for (const layer of architecture.layers) {
    // The layer patterns are written case-insensitive (`/controllers?[\/\\]/i`),
    // but the /i flag is NOT carried by `pattern.source` — recompiling without it
    // silently fails on every capitalized layer directory (Laravel: app/Http/
    // Controllers, app/Models, app/Repositories), leaving `layerMap` empty and
    // `impact` reporting `Layer: null` for the whole repo.
    if (layer.pattern && new RegExp(layer.pattern, 'i').test(filePath)) {
      return layer.name;
    }
  }
  return null;
}

/**
 * Index format generation. Bumped whenever the JSON shape changes. Readers accept the
 * whole supported window (raising MIN_SUPPORTED retires an old generation), and refuse
 * anything outside it instead of answering from a shape they don't understand.
 * v1 = the files written before this field existed (identical shape, no stamp).
 */
export const INDEX_SCHEMA_VERSION = 2;
export const INDEX_MIN_SUPPORTED = 1;

export function getIndex(baseDir) {
  // Load cached index if available
  const indexPath = path.join(baseDir, '.archnav', 'index.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch {
    return null;
  }
  // An index from a *newer* build is the dangerous case (unknown fields, missing ones
  // this build relies on) — answering from it silently is how wrong answers happen.
  // Retiring an old generation is a one-line change to INDEX_MIN_SUPPORTED.
  const version = parsed.schemaVersion ?? 1;
  if (version < INDEX_MIN_SUPPORTED || version > INDEX_SCHEMA_VERSION) {
    process.stderr.write(
      `archnav: index schema v${version} is not supported (this build reads v${INDEX_MIN_SUPPORTED}..v${INDEX_SCHEMA_VERSION}) — rebuild it with "archnav analyze ."\n`,
    );
    return null;
  }
  return parsed;
}

export function saveIndex(baseDir, data) {
  const indexDir = path.join(baseDir, '.archnav');
  fs.mkdirSync(indexDir, { recursive: true });
  const target = path.join(indexDir, 'index.json');
  const tmp = `${target}.${process.pid}.tmp`;
  data.schemaVersion = INDEX_SCHEMA_VERSION;
  // Atomic replace: this used to be a direct 1.8 MB writeFileSync, so a Ctrl-C, a full
  // disk or a crash left truncated JSON behind and *every* query failed until the next
  // analyze. rename(2) on the same filesystem publishes either the old file or the new.
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
  // Save commit hash for staleness tracking
  try {
    const headContent = fs.readFileSync(path.join(baseDir, '.git', 'HEAD'), 'utf-8').trim();
    let commitHash = headContent;
    if (headContent.startsWith('ref: ')) {
      const refPath = headContent.substring(5);
      commitHash = fs.readFileSync(path.join(baseDir, '.git', refPath), 'utf-8').trim();
    }
    fs.writeFileSync(path.join(indexDir, 'commit'), commitHash);
  } catch {}
}
