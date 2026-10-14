/**
 * Navigation Module — Architecture-level code navigation
 */
import fs from 'fs';
import path from 'path';
import { analyze, getIndex } from './analyzer.js';
import { checkStaleness, computeConfidence } from './confidence.js';

/**
 * Normalize a single element of a symbol's `imports` array to a string.
 *
 * Historically imports were plain strings, but the current parsers attach
 * objects like `{ source, specifiers, line }` (and some legacy shapes use
 * `from`). Calling `.replace()` on those crashes callers()/impact(). This
 * helper is the single safe funnel every import consumer must go through.
 */
function normalizeImport(imp) {
  if (typeof imp === 'string') return imp;
  if (imp && typeof imp === 'object') {
    const v = imp.source ?? imp.from ?? imp.path ?? imp.module ?? imp.value ?? '';
    return typeof v === 'string' ? v : String(v ?? '');
  }
  return '';
}

/** All import strings of a symbol, normalized, trimmed and empty-filtered. */
function importStrings(sym) {
  const list = Array.isArray(sym?.imports) ? sym.imports : [];
  return list.map(normalizeImport).map(s => s.trim()).filter(Boolean);
}

/** basename of an import string, quotes stripped (used for loose file matching). */
function importBasename(imp) {
  return normalizeImport(imp).replace(/^.*[\/\\]/, '').replace(/'/g, '');
}

/** basename without extension (used by calls()/trace). */
function importStem(imp) {
  return normalizeImport(imp)
    .replace(/^.*[\/\\]/, '')
    .replace(/\.[^/.]+$/, '')
    .replace(/'/g, '');
}

/**
 * Split a graph node id into {name, file}.
 * Handles `sym:<file>::<name>`, `file:<file>` (resolver edges), and bare/relative
 * file paths (file nodes), so callers()/calls() render every edge kind sensibly.
 */
function refNodeParts(id) {
  const raw = String(id || '');
  // Route nodes (`route:GET /analysis/member`) are not files: render them as
  // "METHOD uri" with no file, and let the caller enrich file/line from the
  // route node's metadata when it is available.
  if (raw.startsWith('route:')) {
    return { name: raw.slice('route:'.length), file: '', kind: 'route' };
  }
  const [head, ...rest] = raw.split('::');
  const file = head.replace(/^(sym|file|dir):/, '');
  const name = rest.length ? rest.join('::') : (file.split('/').pop() || file);
  return { name, file };
}

/** Compare two repo-relative paths with either separator. */
function sameFile(a, b) {
  return String(a ?? '').replace(/\\/g, '/') === String(b ?? '').replace(/\\/g, '/');
}

/**
 * Apply optional { file, kind } narrowing to a list of candidate symbols.
 * `file` matches on exact path, suffix, or substring (either separator).
 */
function applyDisambiguation(symbols, options = {}) {
  let out = symbols;
  if (options.file) {
    const want = String(options.file).replace(/\\/g, '/');
    out = out.filter(s => {
      const sf = String(s.file ?? '').replace(/\\/g, '/');
      return sf === want || sf.endsWith('/' + want) || sf.includes(want);
    });
  }
  if (options.kind) {
    out = out.filter(s => s.kind === options.kind);
  }
  return out;
}

/** Shape a symbol into an ambiguity candidate. */
function toCandidate(s) {
  return { name: s.name, file: s.file, line: s.line_start, kind: s.kind };
}

/**
 * Resolve a symbol name to its definition(s), honoring { file, kind } narrowing.
 *
 * Semantics of --file / --kind:
 *   - matches exactly one definition  → { symbols: [def] }
 *   - matches 2+ definitions          → { ambiguous: true, candidates }
 *   - matches none, name has defs     → the filter names a *caller* file, so it
 *                                       is returned as { resultFilter } for
 *                                       callers/impact to filter their output
 *                                       (allowResultFilter) — or, for locate,
 *                                       we fall back to every definition so the
 *                                       user still sees the candidate list.
 *   - no matching definition at all    → { missing: true }
 */
function resolveSymbols(index, name, options = {}, { allowResultFilter = false } = {}) {
  const all = (index?.symbols || []).filter(s => s.name === name);
  if (all.length === 0) return { missing: true };

  const hasFilter = Boolean(options.file || options.kind);
  let set = hasFilter ? applyDisambiguation(all, options) : all;

  if (set.length === 0) {
    if (allowResultFilter) {
      return { symbols: all, resultFilter: { file: options.file, kind: options.kind } };
    }
    // locate: no result list to filter — show every definition instead.
    set = all;
  }

  if (set.length >= 2) return { ambiguous: true, candidates: set.map(toCandidate) };
  return { symbols: set };
}

/** Filter a relation list by the result-level { file, kind } filter. */
function applyResultFilter(relations, filter, index) {
  let out = relations;
  if (filter.file) {
    const want = String(filter.file).replace(/\\/g, '/');
    out = out.filter(r => {
      const rf = String(r.file ?? '').replace(/\\/g, '/');
      return rf === want || rf.endsWith('/' + want) || rf.includes(want);
    });
  }
  if (filter.kind) {
    out = out.filter(r => {
      const s = (index.symbols || []).find(x => x.name === r.symbol && sameFile(x.file, r.file));
      return s ? s.kind === filter.kind : false;
    });
  }
  return out;
}

/** De-duplicate relations by symbol+file+line. */
function dedupeRelations(relations) {
  const seen = new Set();
  const out = [];
  for (const r of relations) {
    const key = `${r.symbol}|${r.file}|${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ═══════════════════════════════════════════════
//  Impact traversal over the knowledge graph
// ═══════════════════════════════════════════════

/**
 * Reverse DEPENDS_ON adjacency: target node id → incoming edges.
 *
 * Node ids are used verbatim, never normalized: `sym:<file>::<name>` embeds the
 * parser's own file string (the PHP/WASM parser emits '/' while the TS/Vue
 * parser emits '\'), and `file:<path>` means "the call happens inside this
 * file" (Blade view, .vue component) rather than a symbol.
 */
function buildDependents(edges) {
  const dependents = new Map();
  for (const edge of edges) {
    if (!edge || edge.type !== 'DEPENDS_ON') continue;
    const list = dependents.get(edge.to);
    if (list) list.push(edge);
    else dependents.set(edge.to, [edge]);
  }
  return dependents;
}

/** Confidence carried by a graph edge (explicit value wins). */
function edgeConfidence(edge) {
  if (typeof edge.confidence === 'number') return edge.confidence;
  switch (edge.source_kind) {
    case 'template': return 0.75;
    case 'callback': return 0.85;
    case 'heuristic': return 0.6;
    default: return 0.8;
  }
}

/** `source` label for a graph edge — same convention as callers(). */
function edgeSource(edge) {
  return edge.source_kind ? `call-graph:${edge.source_kind}` : 'call-graph';
}

/** Graph node id of a symbol definition. */
function symbolNodeId(sym) {
  return `sym:${sym.file}::${sym.name}`;
}

/** Turn one incoming DEPENDS_ON edge into a relation record. */
function edgeRelation(edge, depth, via) {
  const { name, file, kind } = refNodeParts(edge.from);
  return {
    symbol: name,
    file,
    line: edge.line ?? '?',
    depth,
    via: via ?? null,
    kind: kind || 'symbol',
    source_kind: edge.source_kind || 'graph',
    confidence: edgeConfidence(edge),
    source: edgeSource(edge),
  };
}

/**
 * Fill a route relation's file/line from the route node's metadata, so the CLI
 * reads `GET /analysis/member → routes/web.php:98` instead of an empty file.
 * Route nodes live in knowledgeGraph.nodes with {id, type:'route', file, line, ...}.
 */
function enrichRouteRelation(rel, nodeById) {
  if (rel.kind !== 'route') return rel;
  const meta = nodeById.get(`route:${rel.symbol}`);
  if (!meta) return rel;
  if (meta.file) rel.file = meta.file;
  if (meta.line !== undefined && meta.line !== null) rel.line = meta.line;
  return rel;
}

/**
 * What depends on `defs`, according to the graph alone.
 *
 * depth 1 — every symbol/file the graph says calls into `defs` (reverse
 *           DEPENDS_ON edge). A `file:` source is attributed to that file.
 * depth 2 — reverse DEPENDS_ON from each depth-1 caller, so a controller
 *           action that calls the target surfaces the action's own callers.
 *           `via` names the intermediate caller the path went through and
 *           `confidence` is the weakest hop of the path.
 *
 * No import-basename guessing: "this file imports that file" is not a call.
 */
function graphImpact(index, defs, { maxDepth = 2 } = {}) {
  const dependents = buildDependents(index.knowledgeGraph?.edges || []);
  const nodeById = new Map((index.knowledgeGraph?.nodes || []).map((n) => [n.id, n]));
  const startIds = new Set(defs.map(symbolNodeId));

  const direct = [];
  const directSites = new Set();  // symbol|file
  const indirect = [];
  const indirectKeys = new Set();

  for (const startId of startIds) {
    for (const edge of dependents.get(startId) || []) {
      const rel = enrichRouteRelation(edgeRelation(edge, 1, null), nodeById);
      directSites.add(`${rel.symbol}|${rel.file}`);
      direct.push(rel);
      if (maxDepth < 2) continue;

      for (const hop of dependents.get(edge.from) || []) {
        if (startIds.has(hop.from)) continue;                     // cycle back to the target
        const second = enrichRouteRelation(edgeRelation(hop, 2, rel.symbol), nodeById);
        if (directSites.has(`${second.symbol}|${second.file}`)) continue;
        if (`${second.symbol}|${second.file}` === `${rel.symbol}|${rel.file}`) continue;
        const key = `${second.symbol}|${second.file}|${second.line}`;
        if (indirectKeys.has(key)) continue;
        indirectKeys.add(key);
        second.confidence = Math.min(rel.confidence, second.confidence);
        indirect.push(second);
      }
    }
  }

  return {
    direct: dedupeRelations([...new Map(direct.map(r => [`${r.symbol}|${r.file}|${r.line}`, r])).values()]),
    // A caller that is already reported as direct must not reappear as indirect.
    indirect: indirect.filter(r => !directSites.has(`${r.symbol}|${r.file}`)),
  };
}

export const archNav = {
  /**
   * Show architecture map
   */
  async architecture(dirPath) {
    const index = getIndex(dirPath);
    const freshness = await checkStaleness(dirPath);
    
    if (!index) {
      return { type: 'architecture', error: 'No index found. Run "archnav analyze ." first', projectName: path.basename(dirPath) };
    }
    
    const arch = index.architecture || { layers: [] };
    
    return {
      type: 'architecture',
      projectName: path.basename(dirPath),
      projectPath: dirPath,
      layers: arch.layers.map(l => ({
        ...l,
        violations: arch.violations?.filter(v => v.layer === l.name).length || 0,
      })),
      violations: arch.violations || [],
      flows: index.flows || [],
      stale: freshness.stale,
      confidence: freshness.overallConfidence,
    };
  },

  /**
   * Locate a symbol with line numbers and confidence
   */
  async locate(name, dirPath, options = {}) {
    const index = getIndex(dirPath);
    
    if (!index) {
      return { type: 'locate', error: 'No index found. Run "archnav analyze ." first' };
    }
    
    const freshness = await checkStaleness(dirPath);
    
    // Exact-name definitions, honoring --file / --kind narrowing.
    const exactAll = index.symbols.filter(s => s.name === name);
    let exact = applyDisambiguation(exactAll, options);
    // A filter that names no definition (e.g. a *caller* file) still shows all defs.
    if (exact.length === 0 && exactAll.length > 0) exact = exactAll;
    
    // Two or more definitions of the same name → report ambiguity, never guess.
    if (exact.length >= 2) {
      return {
        type: 'locate',
        symbol: name,
        ambiguous: true,
        candidates: exact.map(toCandidate),
      };
    }
    
    // Fuzzy fallback (backward-compatible) — used only when no exact match.
    const fuzzyAll = index.symbols.filter(s =>
      s.name === name || s.name.toLowerCase().includes(name.toLowerCase())
    );
    let fuzzy = applyDisambiguation(fuzzyAll, options);
    if (fuzzy.length === 0) fuzzy = fuzzyAll;
    // A unique exact match wins; keep fuzzy hits as --all alternatives.
    const matches = exact.length === 1
      ? [exact[0], ...fuzzy.filter(s => s !== exact[0])]
      : fuzzy;
    
    if (matches.length === 0) {
      return { type: 'locate', error: `Symbol "${name}" not found in index` };
    }
    
    const best = matches[0];
    const alternatives = matches.slice(1);
    
    // Compute confidence
    const confidence = computeConfidence(best.file, index.fileHashes, freshness, dirPath);
    
    // Find which layer this belongs to
    const layer = index.layerMap?.[best.id] || null;
    
    return {
      type: 'locate',
      symbol: {
        name: best.name,
        kind: best.kind,
        file: best.file,
        line_start: best.line_start,
        line_end: best.line_end,
        signature: best.signature,
        params: best.params,
        exported: best.exported,
      },
      layer,
      confidence,
      alternatives: options.all ? alternatives.slice(0, 5).map(a => ({
        name: a.name,
        file: a.file,
        line_start: a.line_start,
      })) : [],
    };
  },

  /**
   * Trace shortest path between two symbols
   */
  async trace(fromName, toName, dirPath) {
    const index = getIndex(dirPath);
    
    if (!index) {
      return { type: 'trace', error: 'No index found. Run "archnav analyze ." first', from: fromName, to: toName };
    }
    
    const freshness = await checkStaleness(dirPath);
    
    // Find both symbols
    const fromSym = index.symbols.find(s => s.name === fromName);
    const toSym = index.symbols.find(s => s.name === toName);
    
    if (!fromSym) return { type: 'trace', error: `Symbol "${fromName}" not found`, from: fromName, to: toName };
    if (!toSym) return { type: 'trace', error: `Symbol "${toName}" not found`, from: fromName, to: toName };
    
    // Build path by looking at dependency chains
    const path_ = buildTracePath(fromSym, toSym, index);
    
    // Layer crossings
    const layers = path_.map(s => {
      const l = index.layerMap?.[s.symbol];
      return l || 'unknown';
    });
    const uniqueLayers = [...new Set(layers)];
    
    return {
      type: 'trace',
      from: fromName,
      to: toName,
      path: path_.map(s => ({
        symbol: s.symbol,
        file: s.file,
        line: s.line,
        layer: s.layer || 'unknown',
        call_type: s.callType || 'calls',
        confidence: s.confidence || 1.0,
      })),
      crossesLayers: uniqueLayers.length > 1 ? uniqueLayers : undefined,
    };
  },

  /**
   * What does this symbol call?
   */
  async calls(name, dirPath) {
    const index = getIndex(dirPath);
    if (!index) return { type: 'calls', error: 'No index', symbol: name };
    
    const sym = index.symbols.find(s => s.name === name);
    if (!sym) return { type: 'calls', error: `Symbol "${name}" not found`, symbol: name };
    
    const freshness = await checkStaleness(dirPath);
    
    // Find imports from this file, cross-reference with known symbols
    const fileSymbols = index.symbols.filter(s => s.file === sym.file);
    const imports = fileSymbols.flatMap(s => importStrings(s));
    
    const relations = [];
    
    // Check DEPENDS_ON edges from knowledge graph
    const kg = index.knowledgeGraph || { edges: [] };
    const callerId = `sym:${sym.file}::${sym.name}`;
    const outgoingCalls = kg.edges.filter(e => e.from === callerId && e.type === 'DEPENDS_ON');
    
    for (const edge of outgoingCalls) {
      const { name: calleeName, file: calleeFile } = refNodeParts(edge.to);
      relations.push({
        symbol: calleeName,
        file: calleeFile,
        line: edge.line || '?',
        layer: index.layerMap?.[calleeName] || null,
        confidence: 0.8,
        source: 'call-graph',
      });
    }
    
    // Also find imports
    for (const imp of imports) {
      const resolvedName = importStem(imp);
      // Check if this resolved name matches a known symbol
      const matched = index.symbols.filter(s => 
        s.file.includes(resolvedName) || s.name.toLowerCase() === resolvedName.toLowerCase()
      );
      for (const m of matched.slice(0, 3)) {
        relations.push({
          symbol: m.name,
          file: m.file,
          line: m.line_start,
          layer: index.layerMap?.[m.id] || null,
          confidence: computeConfidence(m.file, index.fileHashes, freshness, dirPath),
        });
      }
    }
    
    return {
      type: 'calls',
      symbol: name,
      file: sym.file,
      line: sym.line_start,
      relations,
    };
  },

  /**
   * Who calls this symbol?
   */
  async callers(name, dirPath, options = {}) {
    const index = getIndex(dirPath);
    if (!index) return { type: 'callers', error: 'No index', symbol: name };
    
    const resolved = resolveSymbols(index, name, options, { allowResultFilter: true });
    if (resolved.ambiguous) {
      return { type: 'callers', symbol: name, ambiguous: true, candidates: resolved.candidates };
    }
    if (resolved.missing) {
      return { type: 'callers', error: `Symbol "${name}" not found`, symbol: name };
    }
    const defs = resolved.symbols;
    const filter = resolved.resultFilter || null;
    
    const freshness = await checkStaleness(dirPath);
    const kg = index.knowledgeGraph || { edges: [] };
    const relations = [];
    
    // Compute callers for every resolved definition (1 normally; >1 only when
    // --file/--kind named a caller file rather than a definition).
    for (const sym of defs) {
      // Find all files that import the file containing this symbol
      const targetFile = sym.file;
      
      // Check incoming DEPENDS_ON edges from knowledge graph
      const symId = `sym:${sym.file}::${sym.name}`;
      const incomingCalls = kg.edges.filter(e => e.to === symId && e.type === 'DEPENDS_ON');
      
      for (const edge of incomingCalls) {
        const { name: callerName, file: callerFile, kind: callerKind } = refNodeParts(edge.from);
        const rel = enrichRouteRelation(
          {
            symbol: callerName,
            file: callerFile,
            line: edge.line || '?',
            kind: callerKind || 'symbol',
            layer: index.layerMap?.[callerName] || null,
            confidence: edge.confidence ?? (edge.source_kind === 'heuristic' ? 0.6 : 0.8),
            source: edge.source_kind ? `call-graph:${edge.source_kind}` : 'call-graph',
          },
          new Map((index.knowledgeGraph?.nodes || []).map((n) => [n.id, n])),
        );
        relations.push(rel);
      }
      
      // Also check file-level imports (normalize first — elements may be objects)
      for (const otherSym of index.symbols) {
        if (otherSym.file === targetFile) continue;
        if (importStrings(otherSym).some(imp => targetFile.includes(importBasename(imp)))) {
          relations.push({
            symbol: otherSym.name,
            file: otherSym.file,
            line: otherSym.line_start,
            layer: index.layerMap?.[otherSym.id] || null,
            // Weak signal: "this file imports/mentions the defining file" is not
            // proof of a call (measured: 1 false positive out of 3 on orderTake).
            // Labeled + demoted so consumers can filter on `source`.
            confidence: Math.min(0.4, computeConfidence(otherSym.file, index.fileHashes, freshness, dirPath)),
            source: 'import-heuristic',
          });
        }
      }
    }
    
    let outRelations = defs.length > 1 ? dedupeRelations(relations) : relations;
    if (filter) outRelations = applyResultFilter(outRelations, filter, index);
    
    return {
      type: 'callers',
      symbol: name,
      file: defs[0].file,
      line: defs[0].line_start,
      ...(defs.length > 1 ? { definitions: defs.map(toCandidate) } : {}),
      ...(filter ? {
        filtered_by_file: filter.file || null,
        ...(filter.kind ? { filtered_by_kind: filter.kind } : {}),
      } : {}),
      relations: outRelations,
    };
  },

  /**
   * Impact analysis — what breaks if this symbol changes
   */
  async impact(name, dirPath, options = {}) {
    const index = getIndex(dirPath);
    if (!index) return { type: 'impact', error: 'No index', symbol: name };
    
    const resolved = resolveSymbols(index, name, options, { allowResultFilter: true });
    if (resolved.ambiguous) {
      return { type: 'impact', symbol: name, ambiguous: true, candidates: resolved.candidates };
    }
    if (resolved.missing) {
      return { type: 'impact', error: `Symbol "${name}" not found`, symbol: name };
    }
    const sym = resolved.symbols[0];
    const filter = resolved.resultFilter || null;
    
    const freshness = await checkStaleness(dirPath);

    // Direct *and* indirect impact are knowledge-graph queries: a reverse
    // DEPENDS_ON walk of depth 2. The previous "this file imports the caller's
    // file ⇒ it is affected" heuristic is gone — it produced 1 false positive
    // out of 3 on `orderTake` and nothing at all on `departments`.
    const { direct, indirect } = graphImpact(index, resolved.symbols, { maxDepth: 2 });
    let directImpact = direct;
    let indirectRelations = indirect;
    if (filter) {
      directImpact = applyResultFilter(directImpact, filter, index);
      indirectRelations = applyResultFilter(indirectRelations, filter, index);
    }
    
    // Find test files
    const allFiles = [...new Set((index.symbols || []).map(s => s.file))];
    const testFiles = allFiles.filter(f => 
      f.includes('test') || f.includes('spec') || f.includes('__tests__')
    );
    
    return {
      type: 'impact',
      symbol: name,
      file: sym.file,
      line_start: sym.line_start,
      ...(filter ? {
        filtered_by_file: filter.file || null,
        ...(filter.kind ? { filtered_by_kind: filter.kind } : {}),
      } : {}),
      layer: index.layerMap?.[sym.id] || null,
      direct_impact: directImpact,
      indirect_relations: indirectRelations,
      // Legacy alias: older consumers (and the CLI renderer) read this name.
      indirect_impact: indirectRelations,
      suggested_tests: testFiles,
      confidence: computeConfidence(sym.file, index.fileHashes, freshness, dirPath),
    };
  },

  /**
   * Where am I? Figure out what symbol is at a given file:line
   */
  async whereami(filePath, line) {
    if (!fs.existsSync(filePath)) {
      return { type: 'whereami', error: `File not found: ${filePath}` };
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    if (line !== undefined && (line < 1 || line > lines.length)) {
      return { type: 'whereami', error: `Line ${line} out of range (1-${lines.length})` };
    }
    
    const targetLine = line || 1;
    const lineContent = lines[targetLine - 1];
    
    // Find enclosing function/class
    let enclosingFunction = null;
    let enclosingClass = null;
    
    for (let i = targetLine - 1; i >= 0; i--) {
      const funcMatch = lines[i].match(/(?:async\s+)?function\s+(\w+)/);
      const classMatch = lines[i].match(/class\s+(\w+)/);
      if (funcMatch && !enclosingFunction) enclosingFunction = funcMatch[1];
      if (classMatch && !enclosingClass) enclosingClass = classMatch[1];
    }
    
    // Determine layer from path
    const relPath = path.relative(process.cwd(), filePath);
    let layer = 'unknown';
    if (/controllers?[/\\]/.test(relPath)) layer = 'API (Controller)';
    else if (/services?[/\\]/.test(relPath)) layer = 'Business (Service)';
    else if (/repositor(?:y|ies)[/\\]/.test(relPath)) layer = 'Data (Repository)';
    else if (/middleware[/\\]/.test(relPath)) layer = 'Middleware';
    else if (/config[/\\]/.test(relPath)) layer = 'Configuration';
    else if (/models?[/\\]/.test(relPath)) layer = 'Model / Validation';
    
    return {
      type: 'whereami',
      file: relPath,
      line: targetLine,
      content: lineContent?.trim(),
      symbol: enclosingFunction || enclosingClass || null,
      kind: enclosingFunction ? 'function' : enclosingClass ? 'class' : null,
      enclosing: enclosingFunction ? (enclosingClass ? `${enclosingClass}.${enclosingFunction}` : enclosingFunction) : enclosingClass || null,
      layer,
    };
  },

  /**
   * Staleness status
   */
  async status(dirPath) {
    const freshness = await checkStaleness(dirPath);
    const index = getIndex(dirPath);
    
    return {
      type: 'status',
      project: path.basename(dirPath),
      ...freshness,
      symbols: index?.symbols?.length || 0,
      warnings: index?.architecture?.violations?.map(v => `${v.layer}: ${v.details}`) || [],
    };
  },
};

function buildTracePath(fromSym, toSym, index) {
  // Simple BFS through the dependency graph
  const queue = [{ symbol: fromSym.name, file: fromSym.file, line: fromSym.line_start, layer: index.layerMap?.[fromSym.id], path: [] }];
  const visited = new Set();
  
  while (queue.length > 0) {
    const current = queue.shift();
    const currentKey = `${current.symbol}:${current.file}`;
    if (visited.has(currentKey)) continue;
    visited.add(currentKey);
    
    const newPath = [...current.path, { symbol: current.symbol, file: current.file, line: current.line, layer: current.layer, callType: current.callType }];
    
    if (current.symbol === toSym.name || current.file === toSym.file) {
      return newPath;
    }
    
    // Find what this symbol's file imports
    const fileSyms = index.symbols.filter(s => s.file === current.file);
    const imports = fileSyms.flatMap(s => importStrings(s));
    
    for (const imp of imports) {
      const resolved = importStem(imp);
      const matched = index.symbols.filter(s => s.file.includes(resolved));
      for (const m of matched) {
        queue.push({
          symbol: m.name,
          file: m.file,
          line: m.line_start,
          layer: index.layerMap?.[m.id],
          callType: 'imports',
          path: newPath,
        });
      }
    }
  }
  
  return [{ symbol: fromSym.name, file: fromSym.file, line: fromSym.line_start, layer: index.layerMap?.[fromSym.id], callType: 'start' }];
}
