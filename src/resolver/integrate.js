/**
 * Resolver → knowledge-graph integration ("recall patch" wiring).
 *
 * The extractors in ./index.js (blade templates, Vue nested callbacks, alias
 * imports) are pure scanners: they know call sites but not the graph. This module
 * turns their output into DEPENDS_ON edges using the SAME id convention the
 * analyzer uses, so navigation.callers()/calls()/impact() pick them up unchanged.
 *
 * Id convention (must match src/analyzer.js):
 *   symbol node : sym:<posix repo-relative file>::<symbol name>
 *   file node   : file:<posix repo-relative file>      (view/component file itself)
 *
 * source_kind on emitted edges:
 *   'template' — Blade call site, target class inferred from the `$var` name
 *   'callback' — Vue/JS call site inside a nested callback, target resolved
 *                through the file's `import { X } from '@/…'` specifier
 * Edges carry `confidence` so downstream consumers can down-weight heuristics.
 */

import { scanTemplateCalls, scanModuleGraph } from './index.js';

const toPosix = (p) => String(p || '').replace(/\\/g, '/');
const stripLead = (p) => toPosix(p).replace(/^\.\//, '');
/**
 * Build a symbol id that MATCHES the analyzer/navigation convention exactly:
 * navigation does `sym:${sym.file}::${sym.name}` using the symbol's own file
 * string, which is posix for the WASM parsers but backslashed for the TS one.
 * So never normalize a path that came from a symbol — pass it through verbatim.
 */
const symId = (file, name) => `sym:${file}::${name}`;
const fileId = (file) => `file:${stripLead(file)}`;

const CLASSY = new Set(['class', 'trait', 'interface', 'enum']);

/** Accept both {file} and {filePath} shapes from the extractors. */
const callFile = (c) => c.file ?? c.filePath ?? c.path;
const callCallee = (c) => c.callee ?? c.name ?? c.method;

/**
 * Build resolver edges for a repo.
 * @param {string} repoDir  repo root (the dir that was analyzed)
 * @param {object|Array} indexOrSymbols  the analyzed index object, or its symbols array
 * @param {{template?:boolean, callback?:boolean}} [opts]
 * @returns {{edges: Array, stats: object}}
 */
export function buildResolvedEdges(repoDir, indexOrSymbols = {}, opts = {}) {
  const symbols = Array.isArray(indexOrSymbols) ? indexOrSymbols : (indexOrSymbols.symbols || []);
  const t0 = Date.now();
  const edges = [];
  const seen = new Set();
  const stats = {
    templateCalls: 0, templateEdges: 0, templateUnresolved: 0,
    importEdges: 0, callbackCalls: 0, callbackEdges: 0, ms: 0,
  };

  const push = (from, to, line, source_kind, confidence, note) => {
    if (!from || !to || from === to) return false;
    const key = `${from}|${to}|${line}|${source_kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    edges.push({ from, to, type: 'DEPENDS_ON', line, source_kind, confidence, ...(note ? { note } : {}) });
    return true;
  };

  // Symbol lookups -----------------------------------------------------------
  const symbolsByFile = new Map();
  for (const s of symbols) {
    const f = stripLead(s.file);
    if (!symbolsByFile.has(f)) symbolsByFile.set(f, []);
    symbolsByFile.get(f).push(s);
  }
  const classByLower = new Map();
  for (const s of symbols) {
    if (!CLASSY.has(String(s.kind || ''))) continue;
    const k = String(s.name || '').toLowerCase();
    if (!classByLower.has(k)) classByLower.set(k, s);
  }

  // 1. Blade template call sites --------------------------------------------
  if (opts.template !== false) {
    let calls = [];
    try { calls = scanTemplateCalls(repoDir) || []; } catch { calls = []; }
    stats.templateCalls = calls.length;

    for (const c of calls) {
      const varName = String(c.var ?? '').replace(/^\$/, '');
      const callee = callCallee(c);
      const file = callFile(c);
      if (!varName || !callee || !file) { stats.templateUnresolved++; continue; }

      // `$departmentPresenter` → DepartmentPresenter (also tries camel/snake forms)
      const cands = [
        varName,
        varName.replace(/[_-](\w)/g, (_, ch) => ch.toUpperCase()),
        varName.charAt(0).toUpperCase() + varName.slice(1),
      ];
      let targetFile = null;
      let confidence = 0.75;
      for (const cand of cands) {
        const cls = classByLower.get(cand.toLowerCase());
        if (!cls) continue;
        const methods = (symbolsByFile.get(stripLead(cls.file)) || []).filter((s) => s.name === callee);
        if (methods.length) { targetFile = methods[0].file; confidence = 0.75; }
        else { targetFile = cls.file; confidence = 0.6; } // class known, method not indexed at method granularity
        break;
      }
      if (!targetFile) { stats.templateUnresolved++; continue; }
      if (push(fileId(file), symId(targetFile, callee), c.line, 'template', confidence, `$${varName}`)) {
        stats.templateEdges++;
      }
    }
  }

  // 2. Alias imports + 3. nested/direct calls — one parse pass for both
  let imports = [];
  let calls = [];
  if (opts.callback !== false) {
    try {
      const graph = scanModuleGraph(repoDir) || {};
      imports = graph.imports || [];
      calls = graph.calls || [];
    } catch {
      imports = [];
      calls = [];
    }
  }
  stats.importEdges = imports.length;
  stats.callbackCalls = calls.length;

  const importMap = new Map(); // `${fromFile}|${symbol}` → defining file
  for (const e of imports) {
    const from = stripLead(e.from ?? e.file);
    const to = stripLead(e.to ?? e.resolved ?? '');
    const symbol = e.symbol ?? e.name;
    if (from && to && symbol && to !== from) importMap.set(`${from}|${symbol}`, to);
  }

  // Only imported callees become edges: anything else is local noise (local
  // methods, uni.*/wx.* globals) and would flood the graph with false callers.
  for (const c of calls) {
    const file = stripLead(callFile(c));
    const callee = callCallee(c);
    if (!file || !callee) continue;
    const defFile = importMap.get(`${file}|${callee}`);
    if (!defFile) continue;
    const def = symbols.find((s) => stripLead(s.file) === defFile && s.name === callee);
    if (push(fileId(file), symId(def ? def.file : defFile, callee), c.line, 'callback', 0.85, c.enclosing || c.kind)) {
      stats.callbackEdges++;
    }
  }

  stats.ms = Date.now() - t0;
  return { edges, stats };
}
