/**
 * Navigation Module — Architecture-level code navigation
 */
import fs from 'fs';
import path from 'path';
import { analyze, getIndex } from './analyzer.js';
import { checkStaleness, computeConfidence } from './confidence.js';

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
    
    // Search in symbols
    const matches = index.symbols.filter(s => 
      s.name === name || s.name.toLowerCase().includes(name.toLowerCase())
    );
    
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
    const imports = fileSymbols.flatMap(s => s.imports || []);
    
    const relations = [];
    
    // Check DEPENDS_ON edges from knowledge graph
    const kg = index.knowledgeGraph || { edges: [] };
    const callerId = `sym:${sym.file}::${sym.name}`;
    const outgoingCalls = kg.edges.filter(e => e.from === callerId && e.type === 'DEPENDS_ON');
    
    for (const edge of outgoingCalls) {
      const calleeName = edge.to.split('::').pop();
      relations.push({
        symbol: calleeName,
        file: edge.to.split('::')[0].replace('sym:', ''),
        line: edge.line || '?',
        layer: index.layerMap?.[calleeName] || null,
        confidence: 0.8,
        source: 'call-graph',
      });
    }
    
    // Also find imports
    for (const imp of imports) {
      const resolvedName = imp.replace(/^.*[\/\\]/, '').replace(/\.[^/.]+$/, '').replace(/'/g, '');
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
  async callers(name, dirPath) {
    const index = getIndex(dirPath);
    if (!index) return { type: 'callers', error: 'No index', symbol: name };
    
    const sym = index.symbols.find(s => s.name === name);
    if (!sym) return { type: 'callers', error: `Symbol "${name}" not found`, symbol: name };
    
    const freshness = await checkStaleness(dirPath);
    
    // Find all files that import the file containing this symbol
    const targetFile = sym.file;
    const relations = [];
    
    // Check incoming DEPENDS_ON edges from knowledge graph
    const kg = index.knowledgeGraph || { edges: [] };
    const symId = `sym:${sym.file}::${sym.name}`;
    const incomingCalls = kg.edges.filter(e => e.to === symId && e.type === 'DEPENDS_ON');
    
    for (const edge of incomingCalls) {
      const callerName = edge.from.split('::').pop();
      const callerFile = edge.from.split('::')[0].replace('sym:', '');
      relations.push({
        symbol: callerName,
        file: callerFile,
        line: edge.line || '?',
        layer: index.layerMap?.[callerName] || null,
        confidence: 0.8,
        source: 'call-graph',
      });
    }
    
    // Also check file-level imports
    for (const otherSym of index.symbols) {
      if (otherSym.file === targetFile) continue;
      if (otherSym.imports?.some(imp => targetFile.includes(imp.replace(/^.*[\/\\]/, '').replace(/'/g, '')))) {
        relations.push({
          symbol: otherSym.name,
          file: otherSym.file,
          line: otherSym.line_start,
          layer: index.layerMap?.[otherSym.id] || null,
          confidence: computeConfidence(otherSym.file, index.fileHashes, freshness, dirPath),
        });
      }
    }
    
    return {
      type: 'callers',
      symbol: name,
      file: sym.file,
      line: sym.line_start,
      relations,
    };
  },

  /**
   * Impact analysis — what breaks if this symbol changes
   */
  async impact(name, dirPath) {
    const index = getIndex(dirPath);
    if (!index) return { type: 'impact', error: 'No index', symbol: name };
    
    const sym = index.symbols.find(s => s.name === name);
    if (!sym) return { type: 'impact', error: `Symbol "${name}" not found`, symbol: name };
    
    const freshness = await checkStaleness(dirPath);
    
    // Get callers (direct impact)
    const callerData = await this.callers(name, dirPath);
    const callerRelations = callerData?.relations || [];
    
    // Get indirect impact (callers of callers)
    const indirectSymbols = [];
    for (const caller of callerRelations) {
      const subCallers = index.symbols.filter(s => 
        s.file !== caller.file && 
        s.imports?.some(imp => caller.file.includes(imp.replace(/^.*[\/\\]/, '').replace(/'/g, '')))
      );
      for (const sc of subCallers.slice(0, 3)) {
        indirectSymbols.push({
          symbol: sc.name,
          file: sc.file,
          line: sc.line_start,
        });
      }
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
      layer: index.layerMap?.[sym.id] || null,
      direct_impact: callerRelations.map(r => ({
        symbol: r.symbol,
        file: r.file,
        line: r.line,
      })),
      indirect_impact: indirectSymbols,
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
    const imports = fileSyms.flatMap(s => s.imports || []);
    
    for (const imp of imports) {
      const resolved = imp.replace(/^.*[\/\\]/, '').replace(/\.[^/.]+$/, '').replace(/'/g, '');
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
