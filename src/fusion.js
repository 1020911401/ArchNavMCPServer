/**
 * Fusion layer — merge normalised caller/impact results from several engines
 * into a single ranked view.
 *
 * Pure functions only: no processes are ever started here, so the whole module
 * is directly unit-testable (see tests/engines/fusion.test.mjs).
 *
 * Confidence model
 *   base per edge provenance:  ast 1.0 | template 0.9 | import 0.85 | heuristic 0.6
 *   two or more independent engines agreeing on the same call site: +0.1 (cap 1.0)
 */

export const SOURCE_BASE = Object.freeze({
  ast: 1.0,
  template: 0.9,
  import: 0.85,
  heuristic: 0.6,
});

export const DEFAULT_BASE = 0.6; // unknown provenance → conservative

function kindsOf(edge) {
  if (Array.isArray(edge?.source_kinds) && edge.source_kinds.length) return edge.source_kinds;
  if (edge?.source_kind) return [edge.source_kind];
  return [];
}

function enginesOf(edge) {
  if (Array.isArray(edge?.engines) && edge.engines.length) return edge.engines;
  if (edge?.engine) return [edge.engine];
  return [];
}

function baseOf(kinds) {
  if (!kinds.length) return DEFAULT_BASE;
  return kinds.reduce((best, k) => Math.max(best, SOURCE_BASE[k] ?? DEFAULT_BASE), 0);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Confidence of a single (merged or raw) edge.
 * Accepts { source_kind? , source_kinds? , engine? , engines? }.
 */
export function confidenceOf(edge) {
  const base = baseOf(kindsOf(edge));
  const engines = enginesOf(edge);
  const bonus = engines.length >= 2 ? 0.1 : 0;
  return Math.min(1, round3(base + bonus));
}

/** Stable file for a call site (forward slashes, no leading ./). */
function normFile(file) {
  return String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Dedup key for a call site: file + line, degrading to file + enclosing name
 * when a line number is unavailable (some engines omit call-site lines).
 */
function edgeKey(entry) {
  const file = normFile(entry.file);
  if (entry.line !== null && entry.line !== undefined) return `${file}|L:${entry.line}`;
  return `${file}|E:${entry.enclosing ?? ''}`;
}

function asResults(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter(Boolean);
  if (typeof input === 'object' && Array.isArray(input.callers)) return [input];
  if (typeof input === 'object') return Object.values(input).filter(Boolean); // {engine: result}
  return [];
}

function mergeEntries(entries) {
  const byKey = new Map();
  for (const e of entries) {
    if (!e || e.file === undefined || e.file === null) continue;
    const key = edgeKey(e);
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        file: normFile(e.file),
        line: e.line ?? null,
        enclosing: e.enclosing ?? null,
        engines: new Set(),
        source_kinds: new Set(),
      };
      byKey.set(key, acc);
    }
    if (acc.line === null && e.line !== null && e.line !== undefined) acc.line = e.line;
    if (!acc.enclosing && e.enclosing) acc.enclosing = e.enclosing;
    if (e.engine) acc.engines.add(e.engine);
    for (const k of kindsOf(e)) acc.source_kinds.add(k);
  }

  const merged = [...byKey.values()].map((acc) => {
    const engines = [...acc.engines].sort();
    const source_kinds = [...acc.source_kinds].sort();
    const primary = source_kinds.length
      ? source_kinds.reduce((best, k) => ((SOURCE_BASE[k] ?? DEFAULT_BASE) > (SOURCE_BASE[best] ?? DEFAULT_BASE) ? k : best), source_kinds[0])
      : 'heuristic';
    return {
      file: acc.file,
      line: acc.line,
      enclosing: acc.enclosing,
      engines,
      source_kinds,
      source_kind: primary,
      confidence: confidenceOf({ source_kinds, engines }),
    };
  });

  // stable sort: file asc, then line asc (missing lines last)
  merged.sort((a, b) => {
    if (a.file < b.file) return -1;
    if (a.file > b.file) return 1;
    const al = a.line === null || a.line === undefined ? Number.POSITIVE_INFINITY : a.line;
    const bl = b.line === null || b.line === undefined ? Number.POSITIVE_INFINITY : b.line;
    return al - bl;
  });
  return merged;
}

/**
 * Merge normalised `callers` results from N engines.
 * @param {Array|Object} results array of {symbol, callers:[...]} (or a single one,
 *        or an {engine: result} map).
 * @returns {{symbol:string|null, callers:Array, engines:string[], sources:Array, errors:Array}}
 */
export function mergeCalls(results) {
  const list = asResults(results);
  const entries = [];
  const engines = new Set();
  const sources = [];
  const errors = [];
  let symbol = null;

  for (const r of list) {
    const engine = r.engine || r.engineName || null;
    if (r.symbol && !symbol) symbol = r.symbol;
    if (r.error) errors.push({ engine, error: r.error });
    sources.push({ engine, count: Array.isArray(r.callers) ? r.callers.length : 0, error: r.error || null });
    for (const c of r.callers || []) {
      if (c.engine) engines.add(c.engine);
      entries.push(c);
    }
  }

  const callers = mergeEntries(entries);
  return { symbol, callers, engines: [...engines].sort(), sources, errors };
}

/**
 * Merge normalised impact results from N engines.
 * Accepts objects carrying `direct_impact`/`direct` and `indirect_impact`/`indirect`.
 */
export function mergeImpact(impacts) {
  const list = Array.isArray(impacts) ? impacts.filter(Boolean) : [impacts].filter(Boolean);
  const direct = [];
  const indirect = [];
  const engines = new Set();
  const errors = [];
  let symbol = null;
  let risk = null;

  for (const r of list) {
    if (r.symbol && !symbol) symbol = r.symbol;
    if (r.engine) engines.add(r.engine);
    if (r.error) errors.push({ engine: r.engine || null, error: r.error });
    if (r.risk && (risk === null || RISK_ORDER.indexOf(r.risk) > RISK_ORDER.indexOf(risk))) risk = r.risk;
    for (const item of r.direct_impact || r.direct || []) {
      direct.push({ ...item, engine: item.engine || r.engine });
    }
    for (const item of r.indirect_impact || r.indirect || []) {
      indirect.push({ ...item, engine: item.engine || r.engine });
    }
  }

  return {
    symbol,
    direct: mergeEntries(direct),
    indirect: mergeEntries(indirect),
    engines: [...engines].sort(),
    risk,
    errors,
  };
}

const RISK_ORDER = ['low', 'medium', 'high', 'critical'];
