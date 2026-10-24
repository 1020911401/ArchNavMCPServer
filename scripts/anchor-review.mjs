/**
 * ANCHOR review orchestrator — one switchable layer with three tiers.
 *
 *   level off  → does nothing (default; existing behaviour is untouched)
 *   level A    → tier A only: diff-decidable ANCHOR leaves as rules
 *   level B    → A + task constraints (atomics + AND/THEN/PRIORITY + ACR/CCR/IPR/FCCR)
 *   level C    → B + trajectory judging (C1/C2/C10 — tool protocol, order, reporting)
 *   level full → C + LLM judge for the semantic leaves, when a judge is configured
 *
 * Everything is switchable from two places, and the file is the default so CI does not
 * need a flag: `.archnav/review.config.json`, overridden per-run by
 * `--anchor <level>` / `--anchor-constraints <file>` / `--anchor-trajectory <file>`.
 *
 * Output contract (so the caller can merge it into the 61-rule task sheet):
 *   { level, config, findings[], checklistRows[], constraints{atomics,relations,metrics},
 *     trajectory{rows,stats}, coverage, gate:{fail,reasons[]} }
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeLevel, LEVELS, coverage as taxonomyCoverage, ANCHOR_LEAF_BY_ID } from '../src/anchor-taxonomy.mjs';
import { collectDiff, anchorRuleFindings, ANCHOR_A_RULES } from './anchor-rules.mjs';
import { loadConstraints, evaluateConstraints, evaluateRelations, computeMetrics, renderConstraints, constraintTemplate } from './anchor-constraints.mjs';
import { loadTrajectory, trajectoryChecks, llmJudge } from './anchor-trajectory.mjs';

export const CONFIG_FILE = '.archnav/review.config.json';
const CONFIG_DIR = '.archnav';

/** Read `.archnav/review.config.json` (missing file = empty config, broken file = error). */
export function loadConfig(dir, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const file = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(file)) return { file: null, config: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFile(file));
  } catch (e) {
    throw new Error(`${CONFIG_FILE} 解析失败：${e.message}`);
  }
  if (parsed.level && !normalizeLevel(parsed.level)) {
    throw new Error(`${CONFIG_FILE} 的 level 非法：${parsed.level}（off|A|B|C|full）`);
  }
  return { file, config: parsed };
}

export function configTemplate() {
  return {
    $schema: 'archnav-review-config/1',
    level: 'A',
    constraints: '.archnav/constraints.json',
    trajectory: '.archnav/trajectory.jsonl',
    maxFiles: 20,
    maxLines: 400,
    forbidNewDeps: false,
    forbiddenCommands: [],
    failOn: { severity: 'error', FCCR: null, ACR: null },
  };
}

/** CLI flags win over the config file; the file wins over defaults. */
export function resolveConfig({ dir = '.', opts = {}, config = {} } = {}) {
  const level = normalizeLevel(opts.anchor) || normalizeLevel(config.level) || 'off';
  // Convention over configuration: if the file names nothing, use the standard paths —
  // but only when they exist, so "no constraints" stays an honest `na` instead of a
  // phantom pass.
  const pick = (explicit, fromConfig, fallback) => {
    const chosen = explicit || fromConfig || fallback;
    if (!chosen) return null;
    const abs = path.resolve(dir, chosen);
    if (!explicit && !fromConfig && !fs.existsSync(abs)) return null;
    return abs;
  };
  const constraintsFile = pick(opts.anchorConstraints, config.constraints, CONFIG_DIR + '/constraints.json');
  const trajectoryFile = pick(opts.anchorTrajectory, config.trajectory, CONFIG_DIR + '/trajectory.jsonl');
  return {
    level,
    mask: LEVELS[level],
    constraintsFile,
    trajectoryFile,
    maxFiles: opts.anchorMaxFiles ?? config.maxFiles ?? 20,
    maxLines: opts.anchorMaxLines ?? config.maxLines ?? 400,
    forbidNewDeps: Boolean(config.forbidNewDeps),
    forbiddenCommands: Array.isArray(config.forbiddenCommands) ? config.forbiddenCommands : [],
    failOn: { severity: 'error', FCCR: null, ACR: null, ...(config.failOn || {}) },
  };
}

/**
 * Run the enabled tiers.
 * `changes` / `meta` come from the existing 61-rule pipeline so both layers judge the
 * same diff; a missing diff is reported as `na`, never as a clean pass.
 */
export async function runAnchorReview({ dir = '.', changes = null, meta = {}, opts = {}, config = {}, tierImpl = {} } = {}) {
  const resolved = resolveConfig({ dir, opts, config });
  const level = resolved.level;
  if (level === 'off') return null;

  const diff = tierImpl.diff || collectDiff(dir, { scope: opts.scope || 'unstaged', base: opts.base || null });
  const findings = [];
  const rows = [];
  const aRules = tierImpl.aRules || anchorRuleFindings({ diff, meta, config: resolved });

  // ── tier A ────────────────────────────────────────────────────────────────
  if (resolved.mask.A) {
    findings.push(...aRules.findings);
    rows.push(...aRules.rows.map((r) => ({ ...r, group: 'ANCHOR·A', family: 'anchor' })));
  }

  // ── tier C evidence is loaded BEFORE tier B: a constraint whose evidence is the
  // trajectory (`order`, `report_references`, …) must be judged from the same rows the
  // C tier reports, otherwise the same fact gets two verdicts.
  let trajectoryResult = null;
  let trajectoryLoadError = null;
  if (resolved.mask.C) {
    if (resolved.trajectoryFile && fs.existsSync(resolved.trajectoryFile)) {
      try {
        const loaded = tierImpl.trajectory || loadTrajectory(resolved.trajectoryFile);
        trajectoryResult = { ...loaded, rows: trajectoryChecks({ events: loaded.events, report: loaded.report, config: resolved }) };
      } catch (e) {
        trajectoryLoadError = e.message;
      }
    }
  }
  const trajectoryRows = trajectoryResult?.rows || null;

  // ── tier B: constraints ───────────────────────────────────────────────────
  let constraintResult = null;
  if (resolved.mask.B) {
    if (!resolved.constraintsFile) {
      rows.push({ id: 'anchor-constraints', leaf: null, group: 'ANCHOR·B', family: 'anchor', title: '任务约束（AND/THEN/PRIORITY + ACR/CCR/FCCR）', status: 'na', hits: 0, reason: '未提供约束文件（--anchor-constraints 或 .archnav/constraints.json）——没有任务约束就没有 ACR/CCR 可算' });
    } else if (!fs.existsSync(resolved.constraintsFile)) {
      rows.push({ id: 'anchor-constraints', leaf: null, group: 'ANCHOR·B', family: 'anchor', title: '任务约束（AND/THEN/PRIORITY + ACR/CCR/FCCR）', status: 'na', hits: 0, reason: `约束文件不存在：${resolved.constraintsFile}` });
    } else {
      let bundle;
      try {
        bundle = tierImpl.constraints || loadConstraints(resolved.constraintsFile);
      } catch (e) {
        rows.push({ id: 'anchor-constraints', leaf: null, group: 'ANCHOR·B', family: 'anchor', title: '任务约束', status: 'na', hits: 0, reason: `约束文件读不了：${e.message}` });
        bundle = null;
      }
      if (bundle) {
        const atomics = evaluateConstraints({
          constraints: bundle.constraints,
          diff,
          trajectory: trajectoryResult,
          trajectoryRows,
          report: trajectoryResult?.report || null,
          changedSymbols: (changes?.changed_symbols || []).map((s) => ({ symbol: s.symbol, file: String(s.file || '').replace(/\\/g, '/') })),
        });
        const relations = evaluateRelations({ relations: bundle.relations, atomics, trajectory: trajectoryResult });
        const metrics = computeMetrics({ atomics, relations });
        constraintResult = { task: bundle.task, atomics, relations, metrics, file: resolved.constraintsFile };
        for (const a of atomics) {
          const leaf = a.leaf ? ANCHOR_LEAF_BY_ID.get(a.leaf) : null;
          rows.push({
            id: `anchor:${a.id}`, leaf: a.leaf, group: 'ANCHOR·B', family: 'anchor',
            title: `${leaf ? leaf.nameZh + ' — ' : ''}${a.text}`,
            status: a.status === 'pass' ? 'pass' : a.status === 'na' ? 'na' : a.status === 'override' ? 'na' : 'hit',
            hits: a.status === 'fail' ? 1 : 0,
            reason: `${a.evidence}${a.note ? `（${a.note}）` : ''}`,
          });
          if (a.status === 'fail') {
            findings.push({
              rule: `anchor:${a.id}`, leaf: a.leaf, severity: a.severity, file: null, line: null, source: 'anchor-b',
              message: `约束未满足：${a.text}`,
              why: `ANCHOR C${a.leaf || '?'} 任务约束（judge=${a.judge}）`,
              evidence: a.evidence,
            });
          }
        }
        for (const rel of relations) {
          rows.push({
            id: `anchor:${rel.id}`, leaf: null, group: 'ANCHOR·B', family: 'anchor',
            title: `${rel.type} 关系：${rel.items.join(` ${rel.type === 'THEN' ? '→' : ' + '} `)}`,
            status: rel.status === 'pass' ? 'pass' : rel.status === 'na' ? 'na' : 'hit',
            hits: rel.status === 'fail' ? 1 : 0,
            reason: `${rel.evidence}${rel.note ? `（${rel.note}）` : ''}`,
          });
          if (rel.status === 'fail') {
            findings.push({
              rule: `anchor-rel:${rel.id}`, leaf: null, severity: 'error', file: null, line: null, source: 'anchor-b',
              message: `${rel.type} 关系未满足：${rel.items.join(' / ')}`,
              why: 'ANCHOR 关系合规（CCR）：单项都过不代表组合过——AND/THEN/PRIORITY 是独立能力维度',
              evidence: rel.evidence,
            });
          }
        }
        if (metrics.counts.na) {
          rows.push({
            id: 'anchor:unjudged', leaf: null, group: 'ANCHOR·B', family: 'anchor',
            title: '无法判定的约束（缺证据）', status: 'na', hits: 0,
            reason: `${metrics.counts.na} 项未计入 ACR/CCR（缺轨迹或需要 LLM 判官）——不计入通过`,
          });
        }
      }
    }
  }

  // ── tier C: report the trajectory rows (evidence already loaded above) ────
  if (resolved.mask.C) {
    if (trajectoryLoadError) {
      rows.push({ id: 'anchor-trajectory', leaf: null, group: 'ANCHOR·C', family: 'anchor', title: '执行轨迹判定', status: 'na', hits: 0, reason: `轨迹读不了：${trajectoryLoadError}` });
    } else if (!trajectoryResult) {
      rows.push({
        id: 'anchor-trajectory', leaf: null, group: 'ANCHOR·C', family: 'anchor', title: '执行轨迹判定（C1/C2/C10）',
        status: 'na', hits: 0,
        reason: resolved.trajectoryFile
          ? `轨迹文件不存在：${resolved.trajectoryFile}`
          : '未提供执行轨迹——C1 工具协议(371)/C2 工作流(512)/C10 汇报(231) 这 1114 条原子约束本次无法判定（不是通过）',
      });
    } else {
      for (const r of trajectoryResult.rows) {
        rows.push({ id: `anchor:${r.id}`, leaf: r.leaf, group: 'ANCHOR·C', family: 'anchor', title: r.title, status: r.status === 'pass' ? 'pass' : r.status === 'na' ? 'na' : 'hit', hits: r.status === 'fail' ? 1 : 0, reason: `${r.evidence}${r.note ? `（${r.note}）` : ''}` });
        if (r.status === 'fail') {
          findings.push({
            rule: `anchor:${r.id}`, leaf: r.leaf, severity: r.leaf === '1.3.1' ? 'error' : 'warn',
            file: null, line: null, source: 'anchor-c',
            message: `${r.title} 未满足`,
            why: `ANCHOR C${r.leaf || '?'} 轨迹约束`,
            evidence: r.evidence,
          });
        }
      }
    }
  }

  // ── tier L: LLM judge for the semantic leaves (opt-in) ────────────────────
  let llmRows = [];
  if (resolved.mask.L && trajectoryResult) {
    const pending = [];
    if (constraintResult) {
      for (const a of constraintResult.atomics.filter((x) => x.status === 'na' && /llm|manual/i.test(String(x.judge)))) pending.push({ id: `anchor:${a.id}`, leaf: a.leaf, title: a.text, text: a.text });
    }
    for (const d of ['2.3.2', '2.3.3', '10.1.1', '10.1.2', '10.2.1']) {
      const leaf = ANCHOR_LEAF_BY_ID.get(d);
      if (leaf && !rows.some((r) => r.leaf === d && r.status === 'pass')) pending.push({ id: `anchor-llm:${d}`, leaf: d, title: leaf.nameZh, text: `检查最终报告是否满足：${leaf.nameZh}` });
    }
    llmRows = llmJudge({ items: pending, trajectory: trajectoryResult });
    for (const r of llmRows) {
      rows.push({ id: r.id, leaf: r.leaf, group: 'ANCHOR·L', family: 'anchor', title: r.title, status: r.status === 'pass' ? 'pass' : r.status === 'na' ? 'na' : 'hit', hits: r.status === 'fail' ? 1 : 0, reason: `${r.evidence}${r.note ? `（${r.note}）` : ''}` });
    }
  }

  // ── coverage + gate ───────────────────────────────────────────────────────
  const cov = taxonomyCoverage(level);
  const metrics = constraintResult?.metrics || null;
  const gateReasons = [];
  for (const f of findings) {
    if (f.severity === 'error' || f.severity === 'critical') gateReasons.push(`[${f.rule}] ${f.message}`);
  }
  if (metrics && resolved.failOn.FCCR !== null && metrics.FCCR !== null && metrics.FCCR < Number(resolved.failOn.FCCR)) {
    gateReasons.push(`FCCR ${metrics.FCCR} < ${resolved.failOn.FCCR}`);
  }
  if (metrics && resolved.failOn.ACR !== null && metrics.ACR !== null && metrics.ACR < Number(resolved.failOn.ACR)) {
    gateReasons.push(`ACR ${metrics.ACR} < ${resolved.failOn.ACR}`);
  }

  return {
    level, config: resolved, diffStats: diff.stats, diffVia: diff.via,
    findings, checklistRows: rows,
    constraints: constraintResult,
    trajectory: trajectoryResult ? { file: trajectoryResult.file, stats: trajectoryResult.stats, rows: trajectoryResult.rows } : null,
    llm: llmRows.length ? llmRows : null,
    coverage: cov,
    metrics,
    gate: { fail: gateReasons.length > 0, reasons: gateReasons },
  };
}

/** One-screen summary for CLI/console output. */
export function renderAnchorReport(result) {
  if (!result) return '';
  const L = [];
  const head = `🧭 ANCHOR 层 level=${result.level}（覆盖 ${result.coverage.atoms.pct}% 原子约束 · ${result.coverage.leaves.reachable}/${result.coverage.leaves.total} 叶子）`;
  L.push(head);
  if (result.diffVia !== 'git') L.push('   ⚠️  非 git 仓库：diff 取不到，A 档规则全部按未覆盖计');
  const hits = result.checklistRows.filter((r) => r.status === 'hit');
  L.push(`   检查项 ${result.checklistRows.length}：命中 ${hits.length} · 通过 ${result.checklistRows.filter((r) => r.status === 'pass').length} · 未覆盖 ${result.checklistRows.filter((r) => r.status === 'na').length}`);
  if (result.metrics) {
    const m = result.metrics;
    const pct = (v) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
    L.push(`   ACR ${pct(m.ACR)} · CCR ${pct(m.CCR)} · IPR ${pct(m.IPR)} · FCCR ${m.FCCR === null ? '—' : m.FCCR === 1 ? '全项通过' : '未通过'}（原子 ${m.counts.atomicsPass}/${m.counts.atomicsJudged}，关系 ${m.counts.relationsPass}/${m.counts.relationsJudged}，未判定 ${m.counts.na}）`);
  }
  if (result.trajectory) {
    const s = result.trajectory.stats;
    L.push(`   轨迹 ${s.events} 事件：工具 ${s.toolCalls}（编辑 ${s.edits}/读 ${s.reads}）· 测试 ${s.testRuns} · lint ${s.lintRuns} · 失败 ${s.failures} · 提交 ${s.commits}`);
  }
  const byGroup = {};
  for (const r of hits) byGroup[r.group || 'other'] = (byGroup[r.group || 'other'] || 0) + 1;
  for (const [g, n] of Object.entries(byGroup)) L.push(`   ${g}：${n} 项命中`);
  if (result.gate.fail) {
    L.push(`   ⛔ 门禁不通过 ${result.gate.reasons.length} 条：`);
    for (const r of result.gate.reasons.slice(0, 8)) L.push(`      · ${r}`);
  } else {
    L.push('   ✅ 门禁通过（按当前 level 的判定范围）');
  }
  for (const r of result.checklistRows.filter((x) => x.status === 'hit').slice(0, 12)) {
    L.push(`   ⚠️  [${r.id}${r.leaf ? ` · C${r.leaf}` : ''}] ${r.title} — ${r.reason || ''}`);
  }
  if (result.constraints) L.push('', renderConstraints(result.constraints));
  return L.join('\n');
}

/** Convenience: a config object pinned to one level (used by `--anchor-config` docs/tests). */
export function buildConfigFromLevel(level = 'A') {
  return { ...configTemplate(), level };
}

export { constraintTemplate, ANCHOR_A_RULES };
