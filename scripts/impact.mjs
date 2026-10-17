#!/usr/bin/env node
/**
 * impact — change-set impact analysis with entry points, execution flows and a
 * risk grade. Built on ArchNav's own graph; no GitNexus dependency.
 *
 * What GitNexus's `detect-changes` has that `archnav changes` alone does not:
 *   1. it says which *execution flows* / user-facing entry points a change hits,
 *   2. it grades the change (risk), so a reviewer knows where to look first.
 * Both are computable from what the index already stores (route:, page:, flow:
 * nodes, layerMap, HAS_STEP edges) — that is what this script does. It does NOT
 * try to copy GitNexus's type inference / PDG: those need a real compiler front
 * end, and inventing edges we cannot evidence is exactly how impact reports get
 * ignored.
 *
 * Usage:
 *   node scripts/impact.mjs [dir] [--scope unstaged|staged|all|compare] [--base REF]
 *                           [--symbol NAME [--file PATH]] [--depth N]
 *                           [--json] [--markdown FILE|-] [--gate --max-risk LOW|MEDIUM|HIGH]
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { archNav } from '../src/navigation.js';
import { getIndex } from '../src/analyzer.js';

const norm = (p) => String(p ?? '').replace(/\\/g, '/');

/** Node id → what kind of entry point it is (or null). */
export function classifyNode(id) {
  const s = norm(id);
  if (s.startsWith('route:')) return 'route';
  if (s.startsWith('page:')) return 'page';
  if (s.startsWith('flow:')) return 'flow';
  return null;
}

/** File-level entry heuristics for stacks where the graph has no entry nodes. */
export function classifyFile(file) {
  const f = norm(file);
  if (/(^|\/)Console\/Commands\//i.test(f) || /(^|\/)Commands\//i.test(f)) return 'command';
  if (/(^|\/)Jobs\//i.test(f)) return 'job';
  if (/(^|\/)Listeners?\//i.test(f) || /(^|\/)Events?\//i.test(f)) return 'event';
  if (/(^|\/)Middleware\//i.test(f)) return 'middleware';
  if (/(^|\/)routes\//i.test(f)) return 'routes-file';
  return null;
}

/**
 * Deterministic, explainable risk grade. Every component is reported, so nobody
 * has to trust a magic number: the reasons are the model.
 */
export function scoreRisk({
  direct = 0, indirect = 0, routes = 0, pages = 0, flows = 0,
  commands = 0, layers = 0, errors = 0, uncovered = 0, newClones = 0, maxDepth = 0,
} = {}) {
  const reasons = [];
  const add = (label, points, detail) => {
    if (points <= 0) return;
    reasons.push({ label, points, detail });
  };
  add('直接影响面', Math.min(direct * 2, 20), `${direct} 个直接调用方`);
  add('间接受影响', Math.min(Math.floor(indirect / 2), 15), `${indirect} 个间接受影响符号`);
  add('HTTP 入口', routes * 3, `${routes} 条路由`);
  add('页面入口', pages * 4, `${pages} 个页面`);
  add('执行流程', flows * 5, `${flows} 条流程`);
  add('命令/任务入口', commands * 3, `${commands} 个命令/任务/事件`);
  add('跨层', (layers - 1) * 2, `${layers} 个层被波及`);
  add('安全/规则阻断项', errors * 5, `${errors} 个 error 级发现`);
  add('无测试覆盖', uncovered * 4, `${uncovered} 个改动符号无测试可达`);
  add('新引入重复', newClones * 3, `${newClones} 个新克隆`);
  const score = reasons.reduce((s, r) => s + r.points, 0);
  const level = score >= 40 ? 'HIGH' : score >= 18 ? 'MEDIUM' : 'LOW';
  return { score, level, reasons, maxDepth };
}

const RISK_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Reverse walk over the knowledge graph. Unlike `archnav changes` (hardcoded
 * depth 2) this takes a depth and keeps the traversal path, so entry points and
 * flows at depth 3-4 are still attributable to the symbol that caused them.
 */
export function buildImpact({ index, seedNodes, depth = 4 }) {
  const kg = index?.knowledgeGraph || {};
  const edges = kg.edges || [];
  const nodes = new Map((kg.nodes || []).map((n) => [norm(n.id), n]));
  const incoming = new Map();
  for (const e of edges) {
    const to = norm(e.to);
    if (!incoming.has(to)) incoming.set(to, []);
    incoming.get(to).push(e);
  }
  const seen = new Map();
  const queue = [];
  for (const seed of seedNodes) {
    // a symbol node and the file that owns it are both legitimate seeds
    if (!seen.has(norm(seed))) { seen.set(norm(seed), { id: norm(seed), depth: 0, via: null }); queue.push(norm(seed)); }
  }
  const rows = [];
  while (queue.length) {
    const cur = queue.shift();
    const info = seen.get(cur);
    if (info.depth >= depth) continue;
    for (const e of incoming.get(cur) || []) {
      const from = norm(e.from);
      if (seen.has(from)) continue;
      const next = { id: from, depth: info.depth + 1, via: norm(e.note || e.source_kind || e.type || ''), };
      seen.set(from, next);
      queue.push(from);
      const entry = classifyNode(from) ? classifyNode(from) : null;
      const node = nodes.get(from);
      rows.push({
        node: from,
        entry,
        entryFile: node ? norm(node.file || '') : '',
        entryLine: node?.line ?? null,
        kind: node?.type || (from.startsWith('sym:') ? 'symbol' : 'file'),
        depth: next.depth,
        via: cur,
        edgeType: e.type || null,
        sourceKind: e.source_kind || null,
        confidence: e.confidence ?? null,
      });
    }
  }
  rows.sort((a, b) => a.depth - b.depth || a.node.localeCompare(b.node));
  return rows;
}

export function summarizeImpact({ rows, changedSymbols = [], layerMap = {}, fileLayers = null, depth = 4 }) {
  const isSym = (n) => n.startsWith('sym:');
  const direct = rows.filter((r) => r.depth === 1 && r.kind === 'symbol').length;
  const indirect = rows.filter((r) => r.depth > 1 && r.kind === 'symbol').length;
  const routes = rows.filter((r) => r.entry === 'route');
  const pages = rows.filter((r) => r.entry === 'page');
  const flows = rows.filter((r) => r.entry === 'flow');
  const commands = rows.filter((r) => !r.entry && classifyFile(r.entryFile || r.node));
  // layerMap is keyed by symbol id; map through the file the node belongs to so
  // the "波及层" line works for symbols, files, routes and pages alike. Only real
  // strings are accepted — a non-string value used to render as a blank/odd row.
  const layerOfFile = fileLayers || new Map();
  const layers = new Set();
  for (const r of rows) {
    const file = r.entryFile || (isSym(r.node) ? norm(r.node).slice(4).split('::')[0] : norm(r.node).replace(/^(file|sym):/, ''));
    const l = layerOfFile.get(norm(file));
    if (typeof l === 'string' && l) layers.add(l);
  }
  return {
    depth,
    direct, indirect,
    routes, pages, flows,
    commands: commands.map((r) => ({ node: r.node, kind: classifyFile(r.entryFile || r.node), file: r.entryFile, depth: r.depth })),
    layers: [...layers].sort(),
    deepest: rows.reduce((m, r) => Math.max(m, r.depth), 0),
    rows,
  };
}

/** file → layer, derived from the symbols the index assigned to a layer. */
export function fileLayerMap(index) {
  const out = new Map();
  const lm = index?.layerMap || {};
  for (const s of index?.symbols || []) {
    const l = lm[s.id];
    if (l && !out.has(norm(s.file))) out.set(norm(s.file), l);
  }
  return out;
}

/**
 * Impact half of the review task sheet — same row shape as the rule registry, so
 * `review-rules.mjs --impact` can print one checklist instead of two reports.
 * `available` says which entry kinds this repo/index even has (a Laravel index has
 * routes but no pages; uni-app is the other way round), so an empty section reads
 * as 不适用 with a reason rather than a silent pass.
 */
export function buildImpactChecklist({ summary, risk, available = {}, changedCount = 0 }) {
  const row = (id, title, hits, naReason, extraReason = null) => {
    if (naReason) return { id, group: '影响面', family: 'impact', title, status: 'na', hits: 0, reason: naReason };
    return { id, group: '影响面', family: 'impact', title, status: hits ? 'hit' : 'pass', hits, reason: extraReason };
  };
  const rows = [
    row('impact.blast', '爆炸半径（直接 + 间接受影响符号）',
      summary.direct + summary.indirect,
      changedCount ? null : '本次没有改动符号',
      `直接 ${summary.direct} · 间接 ${summary.indirect} · 最深 ${summary.deepest} 跳`),
    row('impact.routes', '受影响的 HTTP 路由入口', summary.routes.length,
      available.routes ? null : '本仓索引里没有路由节点（非 Laravel/Express 风格）'),
    row('impact.pages', '受影响的页面入口', summary.pages.length,
      available.pages ? null : '本仓索引里没有页面节点（非 uni-app）'),
    row('impact.flows', '受影响的执行流程',
      summary.flows.length,
      available.flows ? null : '索引里没有流程节点（detectFlows 只在 API→Service→Repository 分层齐全时才产出）'),
    row('impact.commands', '命令/任务/事件入口', summary.commands.length, null),
    {
      id: 'impact.risk', group: '影响面', family: 'impact', title: '风险等级（可解释加总）',
      status: risk.level === 'LOW' ? 'pass' : 'hit',
      hits: risk.score,
      reason: `${risk.level}（${risk.reasons.map((r) => `${r.label} +${r.points}`).join('，') || '无风险因子'}）`,
    },
    row('impact.layers', '波及的架构层', summary.layers.length, null, summary.layers.join(' / ') || '—'),
  ];
  const summaryOut = {
    total: rows.length,
    hit: rows.filter((r) => r.status === 'hit').length,
    pass: rows.filter((r) => r.status === 'pass').length,
    na: rows.filter((r) => r.status === 'na').length,
    findings: 0,
  };
  return { rows, summary: summaryOut, risk };
}

/** One call to get rows + summary + risk for a set of seed nodes. */
export function runImpact({ index, seedNodes, depth = 4, extras = { errors: 0, uncovered: 0, newClones: 0 }, changedCount = 0 }) {
  const rows = buildImpact({ index, seedNodes, depth });
  const summary = summarizeImpact({ rows, changedSymbols: new Array(changedCount).fill(null), fileLayers: fileLayerMap(index), depth });
  const risk = scoreRisk({
    direct: summary.direct, indirect: summary.indirect,
    routes: summary.routes.length, pages: summary.pages.length, flows: summary.flows.length,
    commands: summary.commands.length, layers: summary.layers.length,
    errors: extras.errors || 0, uncovered: extras.uncovered || 0, newClones: extras.newClones || 0,
    maxDepth: summary.deepest,
  });
  const nodeIds = new Set((index?.knowledgeGraph?.nodes || []).map((n) => norm(n.id)));
  const available = {
    routes: [...nodeIds].some((id) => id.startsWith('route:')),
    pages: [...nodeIds].some((id) => id.startsWith('page:')),
    flows: [...nodeIds].some((id) => id.startsWith('flow:')),
  };
  return { rows, summary, risk, available };
}

function renderImpact(summary, { changedSymbols = [], meta = {} } = {}) {
  const L = [];
  L.push(`\n💥 影响分析 — ${meta.dir || '.'}（深度 ${summary.depth}）`);
  L.push(`   改动符号 ${changedSymbols.length}　直接 ${summary.direct}　间接 ${summary.indirect}　最深 ${summary.deepest} 跳`);
  L.push(`   入口：路由 ${summary.routes.length}　页面 ${summary.pages.length}　流程 ${summary.flows.length}　命令/任务 ${summary.commands.length}　波及层 ${summary.layers.join(', ') || '—'}`);
  if (summary.routes.length) {
    L.push('\n   🛣️  受影响路由：');
    for (const r of summary.routes.slice(0, 12)) L.push(`      ${r.node.replace(/^route:/, '')}　${r.entryFile}:${r.entryLine}　(depth ${r.depth}, via ${r.via})`);
  }
  if (summary.pages.length) {
    L.push('\n   📄 受影响页面：');
    for (const r of summary.pages.slice(0, 12)) L.push(`      ${r.node.replace(/^page:/, '')}　(depth ${r.depth}, via ${r.via})`);
  }
  if (summary.flows.length) {
    L.push('\n   🔗 受影响执行流程：');
    for (const r of summary.flows.slice(0, 12)) L.push(`      ${r.node.replace(/^flow:/, '')}　(depth ${r.depth}, via ${r.via})`);
  }
  if (summary.commands.length) {
    L.push('\n   ⚙️  命令/任务/事件入口：');
    for (const c of summary.commands.slice(0, 10)) L.push(`      [${c.kind}] ${c.node}　${c.file}`);
  }
  return L.join('\n');
}

function parseArgs(argv) {
  const out = { dir: '.', scope: null, base: null, symbol: null, file: null, depth: 4, json: false, markdown: null, gate: false, maxRisk: 'HIGH', withRules: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') out.scope = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--symbol') out.symbol = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--depth') out.depth = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--markdown') out.markdown = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '-';
    else if (a === '--gate') out.gate = true;
    else if (a === '--max-risk') out.maxRisk = String(argv[++i]).toUpperCase();
    else if (a === '--with-rules') out.withRules = true;
    else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
    else out.dir = a;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = path.resolve(opts.dir);
  const index = getIndex(dir);
  if (!index) { console.error(`No index — run \`archnav analyze ${dir}\` first`); process.exit(2); }

  let changedSymbols = [];
  let changedFiles = [];
  let scopeLabel = opts.symbol ? `symbol:${opts.symbol}` : opts.scope || 'unstaged';
  if (opts.symbol) {
    const syms = (index.symbols || []).filter((s) => s.name === opts.symbol && (!opts.file || norm(s.file).endsWith(norm(opts.file))));
    if (!syms.length) { console.error(`symbol not found: ${opts.symbol}${opts.file ? ` in ${opts.file}` : ''}`); process.exit(2); }
    changedSymbols = syms;
    changedFiles = [...new Set(syms.map((s) => norm(s.file)))];
  } else {
    const changes = await archNav.changes(dir, { scope: opts.scope || 'unstaged', base: opts.base });
    if (changes.error) { console.error(changes.error); process.exit(2); }
    changedSymbols = (changes.changed_symbols || []).map((s) => ({ name: s.symbol, file: norm(s.file), line_start: s.line_start, id: s.symbol }));
    changedFiles = (changes.changed_files || []).map((r) => norm(r.file));
    scopeLabel = `${changes.scope}${changes.note ? ' (drift)' : ''} via ${changes.via}`;
  }
  if (!changedSymbols.length) {
    console.log(`\n💥 影响分析 — ${dir}\n   本次没有改动符号（scope=${scopeLabel}），没有可分析的影响面。`);
    if (opts.gate) process.exit(0);
    return;
  }

  const seedNodes = [];
  for (const s of changedSymbols) {
    seedNodes.push(`sym:${norm(s.file)}::${s.name}`);
    seedNodes.push(norm(s.file));
  }
  const rows = buildImpact({ index, seedNodes, depth: opts.depth });
  const summary = summarizeImpact({ rows, changedSymbols, layerMap: index.layerMap || {}, fileLayers: fileLayerMap(index), depth: opts.depth });

  // Optional inputs: rule errors / uncovered symbols / new clones, each counted
  // only when the corresponding engine actually ran (no pretending).
  let errors = 0; let uncovered = 0; let newClones = 0; const extras = [];
  if (opts.withRules) {
    try {
      const { reviewFindings } = await import('./review-rules.mjs');
      const changes = await archNav.changes(dir, { scope: opts.scope || 'unstaged', base: opts.base });
      const findings = reviewFindings({
        changes, index,
        readFile: (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } },
      });
      errors = findings.filter((f) => f.severity === 'error').length;
      extras.push(`review-rules: ${errors} 个 error 级`);
    } catch (e) { extras.push(`review-rules 未运行：${e.message}`); }
    try {
      const { selectTests } = await import('./test-select.mjs');
      const changes = await archNav.changes(dir, { scope: opts.scope || 'unstaged', base: opts.base });
      const sel = selectTests(changes);
      uncovered = sel.uncovered_symbols.length;
      extras.push(`test-select: ${uncovered} 个改动符号无测试可达`);
    } catch (e) { extras.push(`test-select 未运行：${e.message}`); }
  }

  const risk = scoreRisk({
    direct: summary.direct, indirect: summary.indirect,
    routes: summary.routes.length, pages: summary.pages.length, flows: summary.flows.length,
    commands: summary.commands.length, layers: summary.layers.length,
    errors, uncovered, newClones, maxDepth: summary.deepest,
  });

  const result = {
    dir, scope: scopeLabel, depth: opts.depth,
    changed: changedSymbols.map((s) => { const c = (index.symbols || []).find((x) => x.name === s.name && norm(x.file) === norm(s.file)); return { symbol: s.name, file: norm(s.file), line: s.line_start ?? c?.line_start ?? null, confidence: c ? undefined : undefined }; }),
    direct: summary.direct, indirect: summary.indirect,
    routes: summary.routes.map((r) => ({ route: r.node, file: r.entryFile, line: r.entryLine, depth: r.depth, via: r.via, confidence: r.confidence })),
    pages: summary.pages.map((r) => ({ page: r.node, depth: r.depth, via: r.via })),
    flows: summary.flows.map((r) => ({ flow: r.node, depth: r.depth, via: r.via })),
    commands: summary.commands,
    layers: summary.layers,
    deepest: summary.deepest,
    risk,
    extras,
  };

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(renderImpact(summary, { changedSymbols, meta: { dir } }));
    console.log(`\n   🎚️  风险等级：${risk.level}（score ${risk.score}）`);
    for (const r of risk.reasons) console.log(`      +${String(r.points).padStart(2, ' ')}　${r.label}：${r.detail}`);
    if (extras.length) console.log(`   附加输入：${extras.join('；')}`);
  }
  if (opts.markdown) {
    const md = [
      `## 💥 影响分析 — \`${dir}\``,
      '',
      `**scope** ${scopeLabel} · **深度** ${opts.depth} · **风险** ${risk.level}（score ${risk.score}）`,
      '',
      `直接 ${summary.direct} · 间接 ${summary.indirect} · 路由 ${summary.routes.length} · 页面 ${summary.pages.length} · 流程 ${summary.flows.length} · 命令 ${summary.commands.length} · 波及层 ${summary.layers.join('/') || '—'}`,
      '',
      '| 风险因子 | 分 | 依据 |',
      '|---|---|---|',
      ...risk.reasons.map((r) => `| ${r.label} | +${r.points} | ${r.detail} |`),
      '',
      '### 受影响入口',
      '',
      ...summary.routes.slice(0, 20).map((r) => `- 🛣️ \`${r.node.replace(/^route:/, '')}\` — ${r.entryFile}:${r.entryLine}（depth ${r.depth}, via ${r.via}）`),
      ...summary.pages.slice(0, 20).map((r) => `- 📄 \`${r.node.replace(/^page:/, '')}\`（depth ${r.depth}, via ${r.via}）`),
      ...summary.flows.slice(0, 20).map((r) => `- 🔗 \`${r.node.replace(/^flow:/, '')}\`（depth ${r.depth}）`),
      ...summary.commands.slice(0, 20).map((c) => `- ⚙️ [${c.kind}] \`${c.node}\``),
    ].join('\n');
    if (opts.markdown === '-') console.log(md);
    else { fs.writeFileSync(path.resolve(opts.markdown), md); console.error(`Markdown written to ${path.resolve(opts.markdown)}`); }
  }
  if (opts.gate && RISK_ORDER[risk.level] >= RISK_ORDER[opts.maxRisk]) {
    console.error(`risk ${risk.level} >= --max-risk ${opts.maxRisk} → gate failed`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
