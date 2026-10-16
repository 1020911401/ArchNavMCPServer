#!/usr/bin/env node
/**
 * deep — repo-level deep analysis: execution flows, clusters (modules), risk
 * ranking, and multi-repo (front/back) wiring. Built from ArchNav's own index.
 *
 * Why not just call GitNexus:
 *   - GitNexus's flows come out of a 14-stage pipeline (type inference, PDG). Its
 *     *reports* are also just: processes, clusters, risk, cross-repo groups.
 *     Three of those four are graph computations we can do ourselves on the
 *     index we already build, and the fourth (cross-repo) we can do *better*,
 *     because we know the HTTP boundary (route ↔ request call sites).
 *   - Copying the type inference is not on the table: we would be inventing edges
 *     we cannot evidence, and every downstream number would inherit that.
 *
 * Usage:
 *   node scripts/deep.mjs <dir> [--flows] [--clusters] [--risk] [--top N]
 *                             [--json] [--markdown FILE|-]
 *   node scripts/deep.mjs --repo front=<dir> --repo back=<dir> [--cross]   # multi-repo
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getIndex } from '../src/analyzer.js';
import { extractFrontCalls, backendRoutes, pathMatches } from './review-rules.mjs';

const norm = (p) => String(p ?? '').replace(/\\/g, '/');
const topDir = (file, segs = 2) => norm(file).split('/').slice(0, segs).join('/');

/** Entry nodes: graph entries first, then file-level heuristics. */
export function entryPoints(index) {
  const kg = index?.knowledgeGraph || {};
  const nodes = kg.nodes || [];
  const entries = [];
  for (const n of nodes) {
    const id = norm(n.id);
    if (id.startsWith('route:') || id.startsWith('page:')) {
      entries.push({ id, kind: id.startsWith('route:') ? 'route' : 'page', file: norm(n.file || ''), line: n.line ?? null, name: id.replace(/^(route|page):/, '') });
    }
  }
  for (const n of nodes) {
    const id = norm(n.id);
    if (!id.startsWith('file:')) continue;
    const file = id.slice(5);
    const kind = /(^|\/)Console\/Commands\//i.test(file) || /(^|\/)Commands\//i.test(file) ? 'command'
      : /(^|\/)Jobs\//i.test(file) ? 'job'
        : /(^|\/)Listeners?\//i.test(file) ? 'listener'
          : null;
    if (kind) entries.push({ id, kind, file, line: null, name: file.split('/').pop() });
  }
  return entries;
}

/**
 * Flow = an entry point walked forward through call edges. GitNexus calls these
 * processes; naming them after their entry beats "process_17".
 */
export function extractFlows(index, { maxDepth = 6, maxSteps = 40, maxFlows = 500, includeHeuristic = false, includeUnresolved = false, minConfidence = null } = {}) {
  const kg = index?.knowledgeGraph || {};
  const edges = kg.edges || [];
  const nodes = new Map((kg.nodes || []).map((n) => [norm(n.id), n]));
  const outgoing = new Map();
  // Flow quality: `heuristic` edges are the resolver's "same name somewhere"
  // guesses (confidence <= 0.6) and they turn every Eloquent `find`/`all`/`update`
  // into a bogus step (measured: they dominated the first 155 Laravel flows).
  // Default is to walk only evidenced edges (route/ast/template/import); pass
  // --include-heuristic to see the noisy version.
  const usable = (e) => {
    if (e.source_kind === 'heuristic' && !includeHeuristic) return false;
    if (minConfidence !== null && (e.confidence ?? 1) < minConfidence) return false;
    return true;
  };
  for (const e of edges) {
    if (!usable(e)) continue;
    const from = norm(e.from);
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push(e);
  }
  const fileOf = (id) => {
    const s = norm(id);
    if (s.startsWith('sym:')) return s.slice(4).split('::')[0];
    if (s.startsWith('file:')) return s.slice(5);
    const n = nodes.get(s);
    return n ? norm(n.file || '') : '';
  };
  const flows = [];
  for (const entry of entryPoints(index)) {
    if (flows.length >= maxFlows) break;
    const steps = [];
    const seen = new Set([entry.id]);
    let frontier = [entry.id];
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const next = [];
      for (const cur of frontier) {
        for (const e of outgoing.get(cur) || []) {
          const to = norm(e.to);
          // symbols are call steps; files are imports/navigations (what a uni-app
          // flow actually consists of: page → component → subpage)
          if (seen.has(to) || !(to.startsWith('sym:') || to.startsWith('file:'))) continue;
          // A call target with no line is a placeholder the resolver created for a
          // name it could not bind (PHP builtins like strtotime/time land here).
          // Counting those as flow steps is what made the first Laravel run noisy.
          if (to.startsWith('sym:') && !includeUnresolved) {
            const node0 = nodes.get(to);
            const line0 = node0?.line ?? node0?.line_start ?? null;
            if (!node0 || line0 === null) continue;
          }
          seen.add(to);
          const node = nodes.get(to);
          const step = {
            node: to, depth, via: cur,
            kind: to.startsWith('file:') ? 'file' : 'symbol',
            file: norm(node?.file || fileOf(to)),
            line: node?.line ?? node?.line_start ?? null,
            sourceKind: e.source_kind || null,
            confidence: e.confidence ?? null,
          };
          steps.push(step);
          next.push(to);
          if (steps.length >= maxSteps) break;
        }
        if (steps.length >= maxSteps) break;
      }
      frontier = next;
    }
    if (steps.length) flows.push({ entry: entry.name, entryKind: entry.kind, entryId: entry.id, entryFile: entry.file, steps, depth: steps.reduce((m, s) => Math.max(m, s.depth), 0) });
  }
  return flows.sort((a, b) => b.steps.length - a.steps.length || a.entry.localeCompare(b.entry));
}

/**
 * Louvain-style modularity clustering over the file-level dependency graph.
 * GitNexus reports clusters too, but unnamed; we name them by dominant directory
 * + layer, which is what a human actually needs from a cluster.
 */
export function clusterFiles(index, { maxPasses = 8, minGain = 1e-6, level = 'files' } = {}) {
  const kg = index?.knowledgeGraph || {};
  const nodes = kg.nodes || [];
  const fileOf = (id) => {
    const s = norm(id);
    if (s.startsWith('sym:')) return s.slice(4).split('::')[0];
    if (s.startsWith('file:')) return s.slice(5);
    const n = nodes.find((x) => norm(x.id) === s);
    return n ? norm(n.file || '') : null;
  };
  // `files` is the coarse level (a module = a directory-ish group of files);
  // `symbols` is the fine level GitNexus reports (their 816 clusters vs our 28 on
  // the same uni-app repo) — same Louvain, different node set.
  const symIdOf = (id) => {
    const s = norm(id);
    if (s.startsWith('sym:')) return s;
    const n = nodes.find((x) => norm(x.id) === s);
    if (!n || !n.name) return null;
    const f = norm(n.file || '');
    return f ? `sym:${f}::${n.name}` : null;
  };
  const nodeOf = (id) => (level === 'symbols' ? symIdOf(id) : fileOf(id));
  const fileForNode = (nodeId) => (level === 'symbols' ? norm(nodeId).slice(4).split('::')[0] : norm(nodeId));
  const weights = new Map(); // "a\u0000b" sorted pair → weight
  const incident = new Map();
  const bump = (a, b, w = 1) => {
    if (!a || !b || a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = `${x}\u0000${y}`;
    weights.set(k, (weights.get(k) || 0) + w);
  };
  for (const e of kg.edges || []) {
    const a = nodeOf(e.from);
    const b = nodeOf(e.to);
    if (!a || !b || a === b) continue;
    bump(a, b);
  }
  const files = level === 'symbols'
    ? [...new Set((index.symbols || []).map((s) => `sym:${norm(s.file)}::${s.id}`))]
    : [...new Set((index.symbols || []).map((s) => norm(s.file)))];
  for (const f of files) if (!incident.has(f)) incident.set(f, []);
  for (const k of weights.keys()) {
    const [a, b] = k.split('\u0000');
    if (!incident.has(a)) incident.set(a, []);
    if (!incident.has(b)) incident.set(b, []);
    incident.get(a).push(b);
    incident.get(b).push(a);
  }
  for (const [k, w] of weights) {
    const [a, b] = k.split('\u0000');
    weights.set(`${a}\u0000${b}`, w);
    void a; void b;
  }
  const deg = new Map();
  let m2 = 0;
  for (const [k, w] of weights) {
    const [a, b] = k.split('\u0000');
    deg.set(a, (deg.get(a) || 0) + w);
    deg.set(b, (deg.get(b) || 0) + w);
    m2 += 2 * w;
  }
  const community = new Map(files.map((f) => [f, f]));
  const wdeg = (f) => deg.get(f) || 0;
  const link = (a, b) => weights.get(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`) || 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = 0;
    for (const f of [...files].sort()) {
      const own = community.get(f);
      const totals = new Map();
      for (const nb of incident.get(f) || []) {
        const c = community.get(nb);
        totals.set(c, (totals.get(c) || 0) + link(f, nb));
      }
      const kf = wdeg(f);
      let best = own;
      let bestGain = minGain;
      const sumOwn = [...community.entries()].filter(([, c]) => c === own).reduce((s, [g]) => s + wdeg(g), 0);
      for (const [c, kfC] of totals) {
        if (c === own) continue;
        const sumC = [...community.entries()].filter(([, cc]) => cc === c).reduce((s, [g]) => s + wdeg(g), 0);
        const gain = (kfC / (m2 || 1)) - (sumOwn * sumC) / ((m2 || 1) * (m2 || 1));
        if (gain > bestGain) { bestGain = gain; best = c; }
      }
      if (best !== own) { community.set(f, best); moved++; }
    }
    if (!moved) break;
  }
  // group files into clusters
  const groups = new Map();
  for (const f of files) {
    const c = community.get(f);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(f);
  }
  const clusterList = [];
  for (const [, fs_] of groups) {
    const dirs = new Map();
    const layers = new Map();
    const symById = new Map((index.symbols || []).map((s) => [s.id, s]));
    for (const nodeId of fs_) {
      const file = fileForNode(nodeId);
      const d = topDir(file);
      dirs.set(d, (dirs.get(d) || 0) + 1);
      const sym = level === 'symbols'
        ? symById.get(norm(nodeId).split('::').pop())
        : (index.symbols || []).find((s) => norm(s.file) === file);
      const l = sym ? (index.layerMap || {})[sym.id] : null;
      if (l) layers.set(l, (layers.get(l) || 0) + 1);
    }
    let internal = 0;
    let external = 0;
    for (const [k, w] of weights) {
      const [a, b] = k.split('\u0000');
      const inA = community.get(a) === community.get(fs_[0]);
      const inB = community.get(b) === community.get(fs_[0]);
      if (inA && inB) internal += w; else if (inA || inB) external += w;
    }
    const topDirName = [...dirs.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || '(root)';
    const topLayer = [...layers.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
    clusterList.push({
      name: topLayer ? `${topDirName} · ${topLayer}` : topDirName,
      dir: topDirName,
      layer: topLayer,
      level,
      files: fs_.length,
      symbols: level === 'symbols'
        ? fs_.length
        : (index.symbols || []).filter((s) => fs_.includes(norm(s.file))).length,
      internalEdges: internal,
      externalEdges: external,
      cohesion: internal + external ? internal / (internal + external) : 0,
      members: fs_.slice(0, 40),
    });
  }
  // cluster names are formed from the dominant dir + layer, which repeats when a
  // directory splits into several modules — number the repeats instead of printing
  // five rows all called "pages/users · Utilities".
  const used = new Map();
  const sorted = clusterList.sort((a, b) => b.files - a.files);
  for (const c of sorted) {
    const n = (used.get(c.name) || 0) + 1;
    used.set(c.name, n);
    if (n > 1) c.name = `${c.name} #${n}`;
  }
  return sorted;
}

/** Cycle detection on the file graph (Tarjan SCC, size > 1 = cycle). */
export function findCycles(index) {
  const kg = index?.knowledgeGraph || {};
  const adj = new Map();
  const nodes = kg.nodes || [];
  const fileOf = (id) => {
    const s = norm(id);
    if (s.startsWith('sym:')) return s.slice(4).split('::')[0];
    if (s.startsWith('file:')) return s.slice(5);
    const n = nodes.find((x) => norm(x.id) === s);
    return n ? norm(n.file || '') : null;
  };
  for (const e of kg.edges || []) {
    const a = fileOf(e.from);
    const b = fileOf(e.to);
    if (!a || !b || a === b) continue;
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
    if (!adj.has(b)) adj.set(b, new Set());
  }
  let idx = 0;
  const stack = [];
  const onStack = new Set();
  const indexOf = new Map();
  const low = new Map();
  const sccs = [];
  const strongConnect = (v) => {
    indexOf.set(v, idx);
    low.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) || []) {
      if (!indexOf.has(w)) { strongConnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), indexOf.get(w)));
    }
    if (low.get(v) === indexOf.get(v)) {
      const comp = [];
      for (;;) {
        const w = stack.pop();
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length > 1) sccs.push(comp);
    }
  };
  for (const v of [...adj.keys()].sort()) if (!indexOf.has(v)) strongConnect(v);
  return sccs.sort((a, b) => b.length - a.length);
}

/**
 * Repo-level risk per cluster. Same banding as the change-level score so the two
 * numbers mean the same thing; every component is reported.
 */
export function scoreModules({ clusters = [], cycles = [], testFiles = new Set(), findings = [], duplicates = [] } = {}) {
  const cycleFiles = new Set(cycles.flat());
  const rows = clusters.map((c) => {
    const reasons = [];
    const add = (label, points, detail) => { if (points > 0) reasons.push({ label, points, detail }); };
    add('规模', Math.min(c.files, 20), `${c.files} 个文件`);
    add('外部耦合', Math.min(c.externalEdges, 30), `${c.externalEdges} 条跨模块边`);
    const cyc = c.members.filter((f) => cycleFiles.has(f)).length;
    add('循环依赖', cyc * 6, `${cyc} 个文件在循环里`);
    const risky = findings.filter((f) => f.file && c.members.includes(norm(f.file)));
    const errs = risky.filter((f) => f.severity === 'error').length;
    add('规则阻断项', errs * 5, `${errs} 个 error 级发现`);
    const dupLines = duplicates.filter((d) => d.file && c.members.includes(norm(d.file))).length;
    add('重复代码', dupLines * 2, `${dupLines} 处克隆`);
    const untested = c.members.filter((f) => !testFiles.has(f) && !/\.(test|spec)\./.test(f)).length;
    if (testFiles.size) add('无测试覆盖文件', Math.min(untested, 20), `${untested}/${c.files} 个文件`);
    const score = reasons.reduce((s, r) => s + r.points, 0);
    const level = score >= 40 ? 'HIGH' : score >= 18 ? 'MEDIUM' : 'LOW';
    return { ...c, score, level, reasons };
  });
  return rows.sort((a, b) => b.score - a.score);
}

/** Cross-repo edges: front-end request call sites ↔ backend routes. */
export function crossRepoEdges({ frontIndex, backIndex, frontPaths = [], routes = [] }) {
  const edges = [];
  for (const call of frontPaths) {
    for (const route of routes) {
      if (!pathMatches(route.uri, call.path)) continue;
      edges.push({
        front: call.file, frontLine: call.line ?? null, frontMethod: call.method, frontPath: call.path,
        backRoute: `${route.method} ${route.uri}`, backFile: route.file, backLine: route.line,
        controller: route.controller, action: route.action,
        sameMethod: route.method === call.method,
      });
    }
  }
  return edges;
}

/**
 * Repo-level half of the review task sheet — same row shape as the rule registry
 * so `review-rules.mjs --deep` can print one checklist (GitNexus-style flow /
 * cluster / risk numbers are otherwise a second report nobody reads).
 */
export function buildDeepChecklist({ flows = [], clusters = [], risk = [], cycles = [], clusterLevel = 'files', top = 5 } = {}) {
  const rows = [];
  rows.push({
    id: 'deep.flows', group: '代码库深查', family: 'deep', title: `执行流程（${clusterLevel === 'symbols' ? '符号级' : '文件级'}聚类并存）`,
    status: flows.length ? 'hit' : 'na',
    hits: flows.length,
    reason: flows.length ? `最长 ${flows[0].steps.length} 步：${flows[0].entry}` : '没有入口节点（路由/页面/命令），无法推导流程',
  });
  const biggest = clusters[0];
  rows.push({
    id: 'deep.clusters', group: '代码库深查', family: 'deep', title: '模块聚类（Louvain 模块度）',
    status: clusters.length ? 'hit' : 'na',
    hits: clusters.length,
    reason: biggest ? `最大模块 ${biggest.name}（${biggest.files} ${clusterLevel === 'symbols' ? '符号' : '文件'}，内聚 ${(biggest.cohesion * 100).toFixed(0)}%）` : '索引里没有依赖边，无法聚类',
  });
  const worst = risk[0];
  rows.push({
    id: 'deep.module-risk', group: '代码库深查', family: 'deep', title: '模块风险排名（最高）',
    status: worst ? (worst.level === 'LOW' ? 'pass' : 'hit') : 'na',
    hits: worst ? worst.score : 0,
    reason: worst ? `${worst.level}（${worst.score}）${worst.name} —— ${worst.reasons.map((r) => `${r.label} +${r.points}`).join('，')}` : '没有聚类结果',
  });
  rows.push({
    id: 'deep.cycles', group: '代码库深查', family: 'deep', title: '循环依赖（Tarjan SCC）',
    status: cycles.length ? 'hit' : 'pass',
    hits: cycles.length,
    reason: cycles.length ? `最大一环 ${cycles[0].length} 个文件：${cycles[0].slice(0, 5).join(', ')}` : '文件级依赖图无环',
  });
  const summary = {
    total: rows.length,
    hit: rows.filter((r) => r.status === 'hit').length,
    pass: rows.filter((r) => r.status === 'pass').length,
    na: rows.filter((r) => r.status === 'na').length,
    findings: 0,
  };
  void top;
  return { rows, summary };
}

/** One call for the whole repo-level analysis (flows + clusters + cycles + risk). */
export function runDeep({ index, clusterLevel = 'files', maxFlows = 500 } = {}) {
  const flows = extractFlows(index, { maxFlows });
  const clusters = clusterFiles(index, { level: clusterLevel });
  const cycles = findCycles(index);
  const testFiles = new Set((index.symbols || [])
    .filter((s) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(norm(s.file)))
    .map((s) => norm(s.file)));
  const risk = scoreModules({ clusters, cycles, testFiles });
  return { flows, clusters, risk, cycles, clusterLevel };
}

function parseArgs(argv) {
  const out = { dir: null, repos: [], doFlows: false, doClusters: false, doRisk: false, cross: false, top: 10, json: false, markdown: null, clusterLevel: 'files' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') { const v = argv[++i] || ''; const [name, p] = v.includes('=') ? v.split('=') : [`repo${out.repos.length + 1}`, v]; out.repos.push({ name, dir: path.resolve(p) }); }
    else if (a === '--cluster-level') out.clusterLevel = argv[++i] === 'symbols' ? 'symbols' : 'files';
    else if (a === '--flows') out.doFlows = true;
    else if (a === '--clusters') out.doClusters = true;
    else if (a === '--risk') out.doRisk = true;
    else if (a === '--cross') out.cross = true;
    else if (a === '--top') out.top = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--markdown') out.markdown = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '-';
    else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
    else out.dir = a;
  }
  if (!out.doFlows && !out.doClusters && !out.doRisk && !out.cross) { out.doFlows = true; out.doClusters = true; out.doRisk = true; }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = {};

  if (opts.repos.length >= 2 || opts.cross) {
    const loaded = [];
    for (const r of opts.repos) {
      const idx = getIndex(r.dir);
      if (!idx) { console.error(`No index in ${r.dir} — run \`archnav analyze ${r.dir}\` first`); process.exit(2); }
      loaded.push({ ...r, index: idx });
    }
    const front = loaded.find((r) => (r.index.knowledgeGraph?.nodes || []).some((n) => String(n.id).startsWith('page:'))) || loaded[0];
    const back = loaded.find((r) => r !== front) || loaded[0];
    const frontFiles = (front.index.symbols || []).map((s) => norm(s.file));
    const calls = extractFrontCalls([...new Set(frontFiles)].slice(0, 400), (rel) => {
      try { return fs.readFileSync(path.join(front.dir, rel), 'utf8'); } catch { return null; }
    });
    const staticCalls = calls.filter((c) => !c.dynamic);
    const routes = backendRoutes(back.index);
    const edges = crossRepoEdges({ frontPaths: staticCalls, routes });
    const uniquePaths = new Set(staticCalls.map((c) => c.path.replace(/^\/+|\/+$/g, '').toLowerCase())).size;
    const matchedPaths = new Set(edges.map((e) => e.frontPath.replace(/^\/+|\/+$/g, '').toLowerCase())).size;
    report.crossRepo = {
      front: { name: front.name, dir: front.dir, calls: staticCalls.length, uniquePaths },
      back: { name: back.name, dir: back.dir, routes: routes.length },
      edges: edges.length,
      matchedPaths,
      matchRate: uniquePaths ? matchedPaths / uniquePaths : 0,
      sample: edges.slice(0, 20),
      methodMismatch: edges.filter((e) => !e.sameMethod).slice(0, 10),
    };
  }

  if (opts.dir) {
    const dir = path.resolve(opts.dir);
    const index = getIndex(dir);
    if (!index) { console.error(`No index in ${dir} — run \`archnav analyze ${dir}\` first`); process.exit(2); }
    if (opts.doFlows) report.flows = extractFlows(index);
    let clusters = null;
    if (opts.doClusters || opts.doRisk) clusters = clusterFiles(index, { level: opts.clusterLevel });
    if (opts.doClusters) report.clusters = clusters;
    report.clusterLevel = opts.clusterLevel;
    if (opts.doRisk) {
      const cycles = findCycles(index);
      const testFiles = new Set((index.symbols || []).filter((s) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(norm(s.file))).map((s) => norm(s.file)));
      report.cycles = cycles.slice(0, 20).map((c) => ({ size: c.length, files: c.slice(0, 8) }));
      report.risk = scoreModules({ clusters, cycles, testFiles });
    }
    report.index = { dir, symbols: (index.symbols || []).length, files: new Set((index.symbols || []).map((s) => norm(s.file))).size };
  }

  if (opts.json) { console.log(JSON.stringify(report, null, 2)); }
  else {
    if (report.index) {
      console.log(`\n🔬 代码库深查 — ${report.index.dir}`);
      console.log(`   ${report.index.symbols} 符号 / ${report.index.files} 文件`);
    }
    if (report.flows) {
      console.log(`\n   🧭 执行流程（入口前向调用链，共 ${report.flows.length} 条）`);
      for (const f of report.flows.slice(0, opts.top)) {
        console.log(`      [${f.entryKind}] ${f.entry} — ${f.steps.length} 步 / 最深 ${f.depth} 跳　${f.entryFile}`);
        for (const s of f.steps.slice(0, 4)) console.log(`          → ${s.node.replace(/^sym:/, '')}　${s.file}:${s.line ?? '?'}（depth ${s.depth}${s.sourceKind ? `, ${s.sourceKind}` : ''}）`);
        if (f.steps.length > 4) console.log(`          … +${f.steps.length - 4} 步`);
      }
    }
    if (report.clusters) {
      console.log(`\n   🧩 聚类（模块，共 ${report.clusters.length} 个）`);
      for (const c of report.clusters.slice(0, opts.top)) {
        const unit = report.clusterLevel === 'symbols' ? `${c.symbols} 符号` : `${c.files} 文件 / ${c.symbols} 符号`;
        console.log(`      ${c.name}　${unit}　内聚 ${(c.cohesion * 100).toFixed(0)}%　跨模块边 ${c.externalEdges}`);
      }
    }
    if (report.risk) {
      console.log(`\n   🎚️  模块风险排名（前 ${Math.min(opts.top, report.risk.length)}）`);
      for (const r of report.risk.slice(0, opts.top)) {
        console.log(`      ${r.level}（${r.score}）　${r.name}　${r.reasons.map((x) => `${x.label} +${x.points}`).join('，')}`);
      }
    }
    if (report.cycles?.length) {
      console.log(`\n   ♻️  循环依赖 ${report.cycles.length} 组，最大 ${report.cycles[0].size} 个文件：${report.cycles[0].files.join(', ')}`);
    }
    if (report.crossRepo) {
      const c = report.crossRepo;
      console.log(`\n   🔗 跨仓接口（${c.front.name} → ${c.back.name}）`);
      console.log(`      前端静态调用 ${c.front.calls}（去重路径 ${c.front.uniquePaths}）　后端路由 ${c.back.routes}　匹配 ${c.matchedPaths} 条路径 / ${c.edges} 条边（匹配率 ${(c.matchRate * 100).toFixed(1)}%）`);
      if (c.matchRate < 0.2) console.log('      ⚠️  匹配率过低：这两个索引很可能不是同一对前后端，逐条结论不可信');
      for (const e of c.sample.slice(0, opts.top)) {
        console.log(`      ${e.frontMethod} ${e.frontPath}　${e.front}:${e.frontLine}　↔　${e.backRoute}　${e.backFile}:${e.backLine}${e.controller ? `（${e.controller}@${e.action}）` : ''}${e.sameMethod ? '' : '　⚠️ 方法不一致'}`);
      }
      if (c.methodMismatch.length) console.log(`      ⚠️  方法不一致 ${c.methodMismatch.length} 条`);
    }
  }

  if (opts.markdown) {
    const L = ['## 🔬 代码库深查', ''];
    if (report.index) L.push(`**${report.index.symbols}** 符号 / **${report.index.files}** 文件`, '');
    if (report.flows) {
      L.push(`### 执行流程（${report.flows.length} 条）`, '', '| 入口 | 类型 | 步数 | 最深 | 首步 |', '|---|---|---|---|---|');
      for (const f of report.flows.slice(0, opts.top)) L.push(`| \`${f.entry}\` | ${f.entryKind} | ${f.steps.length} | ${f.depth} | \`${f.steps[0].node.replace(/^sym:/, '')}\` |`);
      L.push('');
    }
    if (report.clusters) {
      L.push(`### 聚类（${report.clusters.length} 个模块）`, '', '| 模块 | 文件 | 符号 | 内聚 | 跨模块边 |', '|---|---|---|---|---|');
      for (const c of report.clusters.slice(0, opts.top)) L.push(`| ${c.name} | ${c.files} | ${c.symbols} | ${(c.cohesion * 100).toFixed(0)}% | ${c.externalEdges} |`);
      L.push('');
    }
    if (report.risk) {
      L.push('### 模块风险排名', '', '| 等级 | 分 | 模块 | 因子 |', '|---|---|---|---|');
      for (const r of report.risk.slice(0, opts.top)) L.push(`| ${r.level} | ${r.score} | ${r.name} | ${r.reasons.map((x) => `${x.label} +${x.points}`).join('，')} |`);
      L.push('');
    }
    if (report.crossRepo) {
      const c = report.crossRepo;
      L.push(`### 跨仓接口（${c.front.name} → ${c.back.name}）`, '', `匹配率 **${(c.matchRate * 100).toFixed(1)}%**（${c.matchedPaths}/${c.uniquePaths} 条路径，${c.edges} 条边）${c.matchRate < 0.2 ? '　⚠️ 可能不是同一对前后端' : ''}`, '');
      L.push('| 前端调用 | 位置 | 后端路由 | 位置 |', '|---|---|---|---|');
      for (const e of c.sample.slice(0, opts.top)) L.push(`| \`${e.frontMethod} ${e.frontPath}\` | ${e.front}:${e.frontLine} | \`${e.backRoute}\` | ${e.backFile}:${e.backLine} |`);
    }
    const md = L.join('\n');
    if (opts.markdown === '-') console.log(md);
    else { fs.writeFileSync(path.resolve(opts.markdown), md); console.error(`Markdown written to ${path.resolve(opts.markdown)}`); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
