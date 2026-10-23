#!/usr/bin/env node
/**
 * label-stats.mjs — 把看板上的人工逐项确认（✅/⛔/➖）汇总成**每条规则的精确率**。
 *
 * 这是整个 RSI 回路里唯一有真值的一环：probe 能告诉你"harness 变了什么"，
 * 但"变好了没有"只能由人给。`kanban-review.mjs push` 把每条 finding 变成一张卡，
 * 人确认/驳回/豁免之后，这里把结果折回规则层：
 *
 *   done    ✅ → TP（真问题）
 *   blocked ⛔ → FP（误报，必须带 comment 说明驳回理由）
 *   archived ➖ → 豁免（不进 TP/FP，单独计数）
 *   todo/ready/review/… → open（未标注，不进分母）
 *
 * 输出三样东西：
 *   1. 每条规则的 precision = TP / (TP + FP)，样本不足（n < --min-samples）不评价；
 *   2. 建议动作：`keep` / `watch` / `demote-or-waive`（候选降层或按规则×文件豁免）；
 *   3. `--suggest-waivers <file>` 产出 `review-rules --waivers` 能直接吃的文件——
 *      按「规则 × 文件」维度，只收人工真驳回过的组合。豁免是 harness 层动作，
 *      所以它可以走 probe 的采纳台账；改 EXTENDED_RULES（层级归属）是代码改动，
 *      必须走单测，这里只给证据，不自动改。
 *
 * Usage:
 *   node scripts/label-stats.mjs [--board default] [--from cards.json]
 *                                [--min-samples 5] [--low 0.4] [--high 0.85]
 *                                [--json] [--out stats.json] [--markdown stats.md]
 *                                [--suggest-waivers waivers.json]
 *
 * 数据来源：`hermes kanban --board <b> list --json --archived`（或 --from 离线快照，
 * 便于在没有看板数据的机器上验算）。找不到 hermes 时 exit 2，不假装"没有误报"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXTENDED_RULES } from './review-rules.mjs';

const HERMES = process.env.HERMES_BIN || (process.platform === 'win32' ? 'hermes.exe' : 'hermes');
const TITLE_RE = /^\[archnav\] (.+?)(?: · (.+))?$/;
const CARD_PREFIX = '[archnav]';
const CLOSE_CARD = '审核任务书收口';

/** kanban 状态 → 标注类别。未知状态算 open，绝不默认成 TP。 */
export function classify(status) {
  if (status === 'done') return 'tp';
  if (status === 'blocked') return 'fp';
  if (status === 'archived') return 'waived';
  return 'open';
}

/** 一张卡 → {rule, file, label}；非 archnav 卡或收口卡返回 null。 */
export function parseCard(task) {
  const title = String(task?.title || '');
  if (!title.startsWith(CARD_PREFIX)) return null;
  if (title.includes(CLOSE_CARD)) return null;
  const m = TITLE_RE.exec(title);
  if (!m) return null;
  return {
    id: task.id || null,
    rule: m[1].trim(),
    file: m[2] ? m[2].trim() : null,
    priority: Number(task.priority ?? 0),
    status: task.status || 'missing',
    label: classify(task.status),
    tenant: task.tenant || null,
    result: task.result || null,
  };
}

export function parseCards(tasks = []) {
  return tasks.map(parseCard).filter(Boolean);
}

/**
 * 聚合到「规则」和「规则×文件」两级。
 * precision 的分母只用已标注的 TP+FP：未确认的卡不算"准确"，也不算"误报"。
 */
export function aggregate(cards = [], { minSamples = 5, low = 0.4, high = 0.85 } = {}) {
  const byRule = new Map();
  const byPair = new Map();
  const batches = new Map();
  const bump = (map, key, card) => {
    if (!map.has(key)) map.set(key, { key, tp: 0, fp: 0, waived: 0, open: 0, ids: [] });
    const row = map.get(key);
    row[card.label] += 1;
    if (card.id && card.label !== 'open') row.ids.push(card.id);
  };
  for (const c of cards) {
    bump(byRule, c.rule, c);
    const pairKey = `${c.rule} · ${c.file || '(规则级)'}`;
    bump(byPair, pairKey, c);
    // 规则×文件这一级要保留拆分字段：豁免建议必须能拿到 file
    const pair = byPair.get(pairKey);
    pair.rule = c.rule;
    pair.file = c.file;
    if (!batches.has(c.tenant || '(no tenant)')) batches.set(c.tenant || '(no tenant)', { tenant: c.tenant || null, cards: 0, tp: 0, fp: 0, waived: 0, open: 0 });
    const b = batches.get(c.tenant || '(no tenant)');
    b.cards += 1;
    b[c.label] += 1;
  }
  const finalize = (row) => {
    const n = row.tp + row.fp;
    const precision = pc(n ? row.tp / n : null);
    return { ...row, n, precision, label: n ? (row.tp / n) : null };
  };
  const pc = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  const rules = [...byRule.values()].map((row) => {
    const r = finalize(row);
    return { ...r, suggestion: suggest(r, { minSamples, low, high }) };
  }).sort((a, b) => (b.n - a.n) || (a.precision ?? 1) - (b.precision ?? 1));
  const pairs = [...byPair.values()].map(finalize).sort((a, b) => (b.n - a.n) || (a.precision ?? 1) - (b.precision ?? 1));
  return {
    totals: {
      cards: cards.length,
      tp: cards.filter((c) => c.label === 'tp').length,
      fp: cards.filter((c) => c.label === 'fp').length,
      waived: cards.filter((c) => c.label === 'waived').length,
      open: cards.filter((c) => c.label === 'open').length,
    },
    rules,
    pairs,
    batches: [...batches.values()].map((b) => ({ ...b, precision: pc(b.tp + b.fp ? b.tp / (b.tp + b.fp) : null) })).sort((a, b) => b.cards - a.cards),
  };
}

export function suggest(row, { minSamples = 5, low = 0.4, high = 0.85 } = {}) {
  if ((row.tp + row.fp) < minSamples) return { verdict: 'insufficient', text: `样本不足（${row.tp + row.fp}/${minSamples}）` };
  const p = row.tp / (row.tp + row.fp);
  const tier = EXTENDED_RULES.has(row.key) ? 'extended' : 'core';
  if (p < low) return { verdict: 'demote-or-waive', text: `精确率 ${Math.round(p * 100)}%（${tier}）：先修规则或按规则×文件豁免；改层级属代码改动，走单测` };
  if (p >= high) return { verdict: 'keep', text: `精确率 ${Math.round(p * 100)}%（${tier}）：保持` };
  return { verdict: 'watch', text: `精确率 ${Math.round(p * 100)}%（${tier}）：继续观察` };
}

/** 只收「人工真驳回」的规则×文件组合——它们才有资格变成豁免。 */
export function suggestedWaivers(pairs, { minSamples = 5, low = 0.4 } = {}) {
  return pairs
    .filter((p) => p.file && p.n >= minSamples && p.fp > 0 && p.tp / p.n < low)
    .map((p) => ({
      rule: p.rule,
      file: p.file,
      line: null,
      reason: `人工驳回 ${p.fp}/${p.n}（精确率 ${Math.round((p.tp / p.n) * 100)}%，看板逐项确认）`,
      by: 'label-stats',
      task: p.ids?.[0] || null,
    }));
}

export function renderMarkdown(stats, { board = null, from = null, minSamples = 5, low = 0.4, high = 0.85 } = {}) {
  const L = [];
  L.push('# 规则精确率（来自看板逐项确认）');
  L.push('');
  L.push(`来源：${from ? `\`${from}\`` : `看板 \`${board || 'default'}\``} · 阈值：n≥${minSamples} 才评价，<${Math.round(low * 100)}% 建议降级/豁免，≥${Math.round(high * 100)}% 保持`);
  L.push('');
  const t = stats.totals;
  L.push(`卡片 ${t.cards}：✅ ${t.tp} · ⛔ ${t.fp} · ➖ ${t.waived} · ⬜ 未确认 ${t.open}`);
  L.push('');
  if (!t.tp && !t.fp) {
    L.push('> 还没有任何 ✅/⛔ 标注 —— 精确率需要人工确认，不能从 open 卡里推断。');
    return L.join('\n');
  }
  L.push('| 规则 | TP | FP | 豁免 | 未确认 | 精确率 | 建议 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of stats.rules) {
    const mark = r.suggestion.verdict === 'demote-or-waive' ? '⚠️ ' : r.suggestion.verdict === 'keep' ? '✅ ' : '';
    L.push(`| \`${r.key}\` | ${r.tp} | ${r.fp} | ${r.waived} | ${r.open} | ${r.precision == null ? '—' : `${Math.round(r.precision * 100)}%`} | ${mark}${r.suggestion.text} |`);
  }
  L.push('');
  const bad = stats.rules.filter((r) => r.suggestion.verdict === 'demote-or-waive');
  if (bad.length) {
    L.push('## 候选动作', '');
    L.push('- **豁免（harness 层，可走 probe 台账）**：`--suggest-waivers` 产出规则×文件豁免，人工过一遍再启用。');
    L.push('- **降层（代码层，必须走单测）**：把规则加进 `EXTENDED_RULES` 只影响 `--all-rules`，这是代码改动，不是配置。');
    L.push('');
    for (const r of bad) L.push(`- \`${r.key}\`：${r.fp}/${r.n} 被人驳回`);
    L.push('');
  }
  L.push('> 标注是唯一的真值来源：`open` 卡不算准确、也不算误报，绝不用它凑分母。');
  return L.join('\n');
}

export function parseArgs(argv) {
  const out = { board: 'default', from: null, minSamples: 5, low: 0.4, high: 0.85, json: false, out: null, markdown: null, suggestWaivers: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--board') out.board = argv[++i];
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--min-samples') out.minSamples = Number(argv[++i]);
    else if (a === '--low') out.low = Number(argv[++i]);
    else if (a === '--high') out.high = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--markdown') out.markdown = argv[++i];
    else if (a === '--suggest-waivers') out.suggestWaivers = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
    else { console.error(`unexpected argument ${a}`); process.exit(2); }
  }
  return out;
}

export function fetchCards({ board = 'default', from = null } = {}) {
  if (from) {
    const raw = JSON.parse(fs.readFileSync(from, 'utf8'));
    return Array.isArray(raw) ? raw : raw.tasks || [];
  }
  const r = spawnSync(HERMES, ['kanban', '--board', board, 'list', '--json', '--archived'], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`spawn ${HERMES} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`hermes kanban list → exit ${r.status}: ${(r.stderr || '').trim().split('\n')[0] || ''}`);
  try { return JSON.parse(r.stdout) || []; } catch (e) { throw new Error(`kanban list 返回的不是 JSON：${e.message}`); }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  let tasks;
  try { tasks = fetchCards({ board: o.board, from: o.from }); } catch (e) {
    console.error(`label-stats: ${e.message}`);
    process.exit(2);
  }
  const cards = parseCards(tasks);
  const stats = aggregate(cards, { minSamples: o.minSamples, low: o.low, high: o.high });
  const waivers = suggestedWaivers(stats.pairs, { minSamples: o.minSamples, low: o.low });
  const payload = { generated: new Date().toISOString(), source: { board: o.from ? null : o.board, from: o.from }, thresholds: { minSamples: o.minSamples, low: o.low, high: o.high }, ...stats, suggestedWaivers: waivers };
  if (o.out) { fs.writeFileSync(path.resolve(o.out), JSON.stringify(payload, null, 2)); console.error(`JSON written to ${path.resolve(o.out)}`); }
  if (o.suggestWaivers) {
    const file = path.resolve(o.suggestWaivers);
    if (!waivers.length) {
      console.error(`没有达到阈值的规则×文件组合（n≥${o.minSamples} 且精确率<${o.low}）→ 不生成 ${file}`);
    } else {
      fs.writeFileSync(file, JSON.stringify({ generated: payload.generated, source: payload.source, waivers }, null, 2));
      console.error(`豁免建议 ${waivers.length} 条 → ${file}（人工过一遍再用 --waivers 接进 review）`);
    }
  }
  if (o.markdown) { fs.writeFileSync(path.resolve(o.markdown), renderMarkdown(stats, o)); console.error(`Markdown written to ${path.resolve(o.markdown)}`); }
  if (o.json) { console.log(JSON.stringify(payload, null, 2)); return; }
  if (!o.quiet) console.log(renderMarkdown(stats, o));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
