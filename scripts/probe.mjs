#!/usr/bin/env node
/**
 * probe.mjs — harness probe: run the SAME review task under N harness variants
 * and diff the behavior.
 *
 * Why this exists
 * ---------------
 * The review layer is a harness: preset (`brief|standard|deep`), rule tier,
 * duplication/impact/deep knobs, thresholds, waiver file. Changing any of them
 * changes what the agent sees — but until `review.json` carried a harness
 * manifest there was no way to attribute a result to a harness version, so a
 * "before vs after" comparison had no evidence chain.
 *
 * This script is the deterministic half of the Propose–Probe–Compose loop:
 *
 *   propose  → the variants you name on the command line
 *   probe    → each variant runs on the same diff, same index, no model call
 *   compose  → the diff table tells you which change actually moved behavior
 *
 * Two failure modes it is built to catch:
 *
 * 1. **Dead knob** — a flag that parses but never reaches the resolver. Manifests
 *    differing only in `explicitFlags` (identical preset/tier/rules/knobs) means
 *    the flag did not resolve to anything, regardless of the findings.
 * 2. **Line drift** — findings are keyed by `rule + file + normalized message`,
 *    not by line, so editing two lines of the reviewed repo does not masquerade
 *    as "8 new findings". Real line moves are reported separately as `lineDrift`.
 *
 * Usage
 * -----
 *   node scripts/probe.mjs [dir] --scope unstaged \
 *     --variant "brief=" \
 *     --variant "all-rules=--all-rules" \
 *     --variant "standard=--standard" \
 *     [--base <ref>] [--baseline <name>] [--timeout 300] \
 *     [--out probe.json] [--markdown probe.md] [--fail-on-noop] [--quiet]
 *
 * Exit codes: 0 = probe ran (dead knobs are data, not errors); 1 = --fail-on-noop
 * and at least one variant was a dead knob; 2 = the probe itself could not run.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { rulesetDigest } from './review-rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW = path.join(HERE, 'review-rules.mjs');

// ── identity ────────────────────────────────────────────────────────────────
/**
 * Normalize the volatile parts of a finding message so the same defect keeps the
 * same identity after the file is edited around it. Only line-ish references are
 * normalized: counts ("18 处调用") are left alone on purpose — a changing count
 * is a real behavioral difference, a shifting line number is not.
 */
export function normalizeMessage(msg = '') {
  return String(msg)
    .replace(/[A-Za-z]:[\\/][^\s）)，,;；]+/g, '<path>')
    .replace(/:\d+(?::\d+)?/g, ':#')
    .replace(/\bL\d+\b/g, 'L#')
    .replace(/\bline\s+\d+\b/gi, 'line #')
    .replace(/第\s*\d+\s*行/g, '第 # 行')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normFile(file = '') {
  return String(file).replace(/\\/g, '/');
}

/** Identity that survives edits elsewhere in the file (the default for diffs). */
export function stableKey(f) {
  return `${f.rule}|${normFile(f.file)}|${normalizeMessage(f.message || f.evidence || '')}`;
}

/** Identity that also pins the line: used only to report line drift. */
export function exactKey(f) {
  return `${f.rule}|${normFile(f.file)}|${f.line ?? ''}`;
}

// ── diffing ─────────────────────────────────────────────────────────────────
export function indexFindings(findings = []) {
  const stable = new Map();
  for (const f of findings) {
    const k = stableKey(f);
    if (!stable.has(k)) stable.set(k, []);
    stable.get(k).push(f);
  }
  return stable;
}

/**
 * Compare a variant against the baseline on stable keys.
 * `added` / `removed` are real behavioral differences; `lineDrift` is the same
 * finding at a new line (the reviewed code moved), reported so it never gets
 * counted as a new finding.
 */
export function diffFindings(baseFindings = [], variantFindings = []) {
  const base = indexFindings(baseFindings);
  const variant = indexFindings(variantFindings);
  const added = [];
  const lineDrift = [];
  for (const [k, list] of variant) {
    if (!base.has(k)) { added.push(...list); continue; }
    const baseLines = new Set(base.get(k).map((f) => f.line ?? null));
    for (const f of list) {
      if (!baseLines.has(f.line ?? null)) lineDrift.push({ finding: f, baseLines: [...baseLines] });
    }
  }
  const removed = [];
  for (const [k, list] of base) if (!variant.has(k)) removed.push(...list);
  return { added, removed, lineDrift };
}

// ── variant stats ───────────────────────────────────────────────────────────
export function countByRule(findings = []) {
  const out = {};
  for (const f of findings) out[f.rule] = (out[f.rule] || 0) + 1;
  return out;
}

export function ruleDelta(baseFindings = [], variantFindings = []) {
  const a = countByRule(baseFindings);
  const b = countByRule(variantFindings);
  const delta = {};
  for (const rule of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[rule] || 0) - (a[rule] || 0);
    if (d !== 0) delta[rule] = d;
  }
  return delta;
}

/** Everything a harness manifest says, minus what the operator typed. */
export function resolvedHarness(manifest) {
  if (!manifest) return null;
  const { explicitFlags, ...rest } = manifest;
  return rest;
}

export function summarizeVariant({ name, args = [], ok = true, error = null, ms = null, bytes = null, json = null }) {
  const findings = json?.findings || [];
  const rows = json?.checklist?.rows || [];
  return {
    name, args, ok, error, ms, bytes,
    checks: rows.length,
    summary: json?.checklist?.summary || null,
    findings: findings.length,
    byRule: countByRule(findings),
    harness: json?.harness || null,
    findingsList: findings,
  };
}

// ── the probe loop ──────────────────────────────────────────────────────────
export function defaultRunner({ dir, scope, base, args, timeoutMs }) {
  const argv = [REVIEW, dir, '--scope', scope, '--json', '--no-compact'];
  if (base) argv.push('--base', base);
  argv.push(...args);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 28 });
  const ms = Date.now() - t0;
  if (res.error) return { ok: false, error: String(res.error.message || res.error), ms, bytes: 0, json: null };
  if (res.status !== 0) {
    const firstErr = String(res.stderr || '').split('\n').find((l) => l.trim()) || `exit ${res.status}`;
    return { ok: false, error: firstErr.trim(), ms, bytes: Buffer.byteLength(res.stdout || ''), json: null };
  }
  try {
    const json = JSON.parse(res.stdout);
    return { ok: true, error: null, ms, bytes: Buffer.byteLength(res.stdout || ''), json };
  } catch (e) {
    return { ok: false, error: `unparseable JSON: ${e.message}`, ms, bytes: Buffer.byteLength(res.stdout || ''), json: null };
  }
}

export function runProbe({
  dir,
  scope = 'unstaged',
  base = null,
  variants = [],
  timeoutMs = 300000,
  baseline = null,
  runner = defaultRunner,
  now = () => new Date().toISOString(),
}) {
  if (!variants.length) throw new Error('no variants');
  const runs = variants.map((v) => {
    const r = runner({ dir, scope, base, args: v.args, timeoutMs });
    return { ...summarizeVariant({ name: v.name, args: v.args, ...r }), json: r.json };
  });
  const baselineName = baseline || runs[0].name;
  const baseRun = runs.find((r) => r.name === baselineName);
  if (!baseRun) throw new Error(`baseline variant ${baselineName} not found`);

  const diffs = {};
  const deadKnobs = [];
  for (const run of runs) {
    if (run.name === baselineName) continue;
    if (!run.ok || !baseRun.ok) {
      diffs[run.name] = run.ok
        ? { error: `baseline ${baselineName} failed: ${baseRun.error}` }
        : { error: run.error };
      continue;
    }
    const d = diffFindings(baseRun.findingsList, run.findingsList);
    const resolvedSame = JSON.stringify(resolvedHarness(run.harness)) === JSON.stringify(resolvedHarness(baseRun.harness));
    const entry = {
      added: d.added.length,
      removed: d.removed.length,
      lineDrift: d.lineDrift.length,
      addedByRule: countByRule(d.added),
      removedByRule: countByRule(d.removed),
      ruleDelta: ruleDelta(baseRun.findingsList, run.findingsList),
      // manifest identical except explicitFlags → the flag never reached the resolver
      resolvedIdentical: resolvedSame,
      behaviorIdentical: d.added.length === 0 && d.removed.length === 0,
      deltaBytes: run.bytes != null && baseRun.bytes != null ? run.bytes - baseRun.bytes : null,
      deltaMs: run.ms != null && baseRun.ms != null ? run.ms - baseRun.ms : null,
    };
    entry.deadKnob = entry.resolvedIdentical && entry.behaviorIdentical;
    if (entry.deadKnob) deadKnobs.push(run.name);
    diffs[run.name] = entry;
  }

  return {
    task: { dir: path.resolve(dir), scope, base, at: now() },
    baseline: baselineName,
    variants: runs.map(({ findingsList, json, ...rest }) => rest),
    diffs,
    deadKnobs,
  };
}

// ── adoption ledger (③) ─────────────────────────────────────────────────────
/**
 * The ledger is what makes probing cumulative instead of episodic: it records
 * which harness variant was adopted or rejected **for which task**, with the
 * evidence that justified it. Two rules keep it from becoming a diary:
 *
 *   · `--lesson` is mandatory — an adoption with no stated reason is a silent
 *     config change, exactly like a waiver with no reason;
 *   · a dead knob can be *rejected* but never *adopted* — a flag that never
 *     reached the resolver cannot be an improvement.
 *
 * Default location is `<repo>/.archnav/harness-ledger.jsonl`, which is
 * gitignored: the ledger is this machine's memory for this repo, never a
 * cross-project file and never a place for client code (records hold counts,
 * digests and paths — no finding bodies).
 */
export const DEFAULT_LEDGER = path.join('.archnav', 'harness-ledger.jsonl');

export function planLedgerWrite({ result, kind, variant, lesson, by = null, probeOut = null, ts = new Date().toISOString() }) {
  const reason = (m) => ({ ok: false, reason: m, record: null });
  if (kind !== 'adopt' && kind !== 'reject') return reason(`kind 必须是 adopt|reject（收到 ${kind}）`);
  const text = String(lesson || '').trim();
  if (text.length < 3) return reason('--lesson 必填：没有理由的采纳/拒绝等于静默改配置');
  if (!variant || variant === result.baseline) return reason('必须指明一个非基线变体（基线就是现状，无所谓采纳）');
  const run = result.variants.find((v) => v.name === variant);
  if (!run) return reason(`变体 ${variant} 不在本次 probe 里`);
  if (!run.ok) return reason(`变体 ${variant} 跑失败了，不能据此改 harness`);
  const diff = result.diffs[variant];
  if (!diff || diff.error) return reason(diff?.error || `变体 ${variant} 没有对比结果`);
  if (kind === 'adopt') {
    if (diff.deadKnob) return reason('死旋钮不可采纳：manifest 除 explicitFlags 外没变 → flag 没接线，先修接线');
    if (diff.behaviorIdentical) return reason('行为零差异：这个旋钮在本任务上没有改变任何 findings，采纳等于自欺（要记录请用 --reject）');
  }
  const baseRun = result.variants.find((v) => v.name === result.baseline);
  const record = {
    ts, kind, variant, baseline: result.baseline, lesson: text, by,
    task: { ...result.task, dir: result.task.dir },
    harness: {
      baseline: baseRun?.harness ? { preset: baseRun.harness.preset, tier: baseRun.harness.tier, ruleset: baseRun.harness.rules?.ruleset, knobs: baseRun.harness.knobs } : null,
      variant: run.harness ? { preset: run.harness.preset, tier: run.harness.tier, ruleset: run.harness.rules?.ruleset, knobs: run.harness.knobs } : null,
    },
    evidence: {
      added: diff.added, removed: diff.removed, lineDrift: diff.lineDrift,
      deltaBytes: diff.deltaBytes, deltaMs: diff.deltaMs, ruleDelta: diff.ruleDelta,
    },
    probe_out: probeOut,
  };
  return { ok: true, reason: null, record };
}

export function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { out.push({ bad: s.slice(0, 120) }); }
  }
  return out;
}

export function appendLedger(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  return file;
}

/** A record is stale when the rule set it was adopted against no longer exists. */
export function ledgerFreshness(record, knownRulesets = []) {
  const rs = record?.harness?.variant?.ruleset ?? record?.harness?.variant?.rules?.ruleset;
  if (!rs) return 'unknown';
  return knownRulesets.includes(rs) ? 'current' : 'stale';
}

export function renderLedger(records, { file = null, knownRulesets = null } = {}) {
  const known = knownRulesets || [rulesetDigest('core').digest, rulesetDigest('all').digest];
  const lines = [`# Harness ledger${file ? ` — ${file}` : ''}`, ''];
  if (!records.length) {
    lines.push('（空：还没有采纳/拒绝记录。`--adopt <变体> --lesson "..."` 写入第一条。）');
    return lines.join('\n');
  }
  lines.push('| 时间 | 结论 | 变体 | 理由 | 证据（+新增 / −消失 / 代价） | ruleset | 状态 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of records) {
    if (r.bad) { lines.push(`| — | ⚠️ 坏行 | — | \`${r.bad}\` | — | — | unreadable |`); continue; }
    const e = r.evidence || {};
    const fresh = ledgerFreshness(r, known);
    const icon = r.kind === 'adopt' ? '✅ 采纳' : '⛔ 拒绝';
    const cost = [e.deltaBytes != null ? `${e.deltaBytes > 0 ? '+' : ''}${e.deltaBytes} B` : null, e.deltaMs != null ? `${e.deltaMs > 0 ? '+' : ''}${e.deltaMs} ms` : null].filter(Boolean).join(' / ') || '—';
    lines.push(`| ${String(r.ts || '').slice(0, 16).replace('T', ' ')} | ${icon} | \`${r.variant}\` | ${String(r.lesson || '').replace(/\|/g, '\\|')} | +${e.added ?? '?'} / −${e.removed ?? '?'} / ${cost} | \`${r.harness?.variant?.ruleset || '?'}\` | ${fresh === 'current' ? '有效' : fresh === 'stale' ? '⚠️ 规则集已变，需复核' : '?'} |`);
  }
  lines.push('');
  lines.push(`> 台账是「本机 + 本仓」的记忆：默认 \`.archnav/harness-ledger.jsonl\`（gitignored），不进 git、不跨项目合并。`);
  return lines.join('\n');
}

// ── rendering ───────────────────────────────────────────────────────────────
const kb = (n) => (n == null ? '—' : `${(n / 1024).toFixed(1)} KB`);
const pct = (n, base) => (base ? `${n > 0 ? '+' : ''}${Math.round((100 * n) / base)}%` : '—');

export function renderMarkdown(result) {
  const { task, baseline, variants, diffs, deadKnobs } = result;
  const baseRun = variants.find((v) => v.name === baseline);
  const lines = [];
  lines.push(`# Harness probe — ${task.dir}`);
  lines.push('');
  lines.push(`任务：scope=\`${task.scope}\`${task.base ? ` base=\`${task.base}\`` : ''} · 基线=\`${baseline}\` · ${task.at}`);
  const h = baseRun?.harness;
  if (h) {
    lines.push(`基线 harness：preset=\`${h.preset}\` tier=\`${h.tier}\` ruleset=\`${h.rules?.ruleset}\`（${h.rules?.enabled}/${h.rules?.registry} 条规则）· index commit \`${String(h.index?.commit || '').slice(0, 7)}\` · model=${h.model === null ? 'none' : h.model}`);
  }
  lines.push('');
  lines.push('| 变体 | preset/tier | findings | 规则行 | payload | 耗时 | 相对基线 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const v of variants) {
    const d = diffs[v.name];
    const rel = v.name === baseline ? '基线' : d?.error ? `❌ ${d.error}` : `${d.added >= 0 ? '+' : ''}${d.added} / −${d.removed}${d.lineDrift ? `（漂移 ${d.lineDrift}）` : ''}`;
    lines.push(`| \`${v.name}\`${v.deadKnob ? ' ⚠️' : ''} | ${v.harness ? `${v.harness.preset}/${v.harness.tier}` : '—'} | ${v.ok ? v.findings : '—'} | ${v.ok ? v.checks : '—'} | ${kb(v.bytes)} | ${v.ms == null ? '—' : `${v.ms} ms`} | ${rel} |`);
  }
  lines.push('');

  for (const [name, d] of Object.entries(diffs)) {
    if (d.error) { lines.push(`## \`${name}\` — 失败：${d.error}`, ''); continue; }
    lines.push(`## \`${name}\` vs \`${baseline}\``);
    lines.push('');
    lines.push(`- 行为：新增 ${d.added} 条 / 消失 ${d.removed} 条 / 行号漂移 ${d.lineDrift} 条（漂移不算新增）`);
    if (d.deltaBytes != null) lines.push(`- 代价：payload ${d.deltaBytes > 0 ? '+' : ''}${d.deltaBytes} B（${pct(d.deltaBytes, baseRun?.bytes)}），耗时 ${d.deltaMs > 0 ? '+' : ''}${d.deltaMs} ms`);
    const delta = Object.entries(d.ruleDelta).sort((a, b) => b[1] - a[1]);
    if (delta.length) {
      lines.push(`- 规则增减：${delta.map(([r, n]) => `${r} ${n > 0 ? '+' : ''}${n}`).join('、')}`);
    }
    if (d.addedByRule && Object.keys(d.addedByRule).length) {
      const top = Object.entries(d.addedByRule).sort((a, b) => b[1] - a[1]).slice(0, 8);
      lines.push(`- 新增集中在：${top.map(([r, n]) => `${r}×${n}`).join('、')}`);
    }
    if (d.deadKnob) {
      lines.push('');
      lines.push(`> ⚠️ **死旋钮**：manifest 除 \`explicitFlags\` 外与基线完全一致，且 findings 无差异 → 这个 flag 没有到达 resolver（不是"没影响"，是"没接线"）。`);
    } else if (d.behaviorIdentical) {
      lines.push(`- 结论：manifest 变了但行为一致 → 该旋钮在这个任务上没有影响（保留为证据，不当作改进）。`);
    }
    lines.push('');
  }

  if (deadKnobs.length) {
    lines.push('## 死旋钮汇总', '');
    lines.push(deadKnobs.map((n) => `- \`${n}\``).join('\n'));
    lines.push('');
  }
  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const out = { dir: '.', scope: 'unstaged', base: null, variants: [], baseline: null, timeout: 300, out: null, markdown: null, json: false, failOnNoop: false, quiet: false, adopt: null, reject: null, lesson: null, ledger: DEFAULT_LEDGER, by: null, listLedger: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') out.scope = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--variant') {
      const raw = String(argv[++i] ?? '');
      const eq = raw.indexOf('=');
      if (eq < 0) { out.variants.push({ name: raw, args: [] }); continue; }
      const name = raw.slice(0, eq).trim();
      const args = raw.slice(eq + 1).trim().split(/\s+/).filter(Boolean);
      out.variants.push({ name, args });
    }
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--markdown') out.markdown = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--fail-on-noop') out.failOnNoop = true;
    else if (a === '--adopt') out.adopt = argv[++i];
    else if (a === '--reject') out.reject = argv[++i];
    else if (a === '--lesson') out.lesson = argv[++i];
    else if (a === '--ledger') out.ledger = argv[++i];
    else if (a === '--by') out.by = argv[++i];
    else if (a === '--list-ledger') out.listLedger = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
    else out.dir = a;
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.listLedger) {
    const file = path.resolve(opts.ledger);
    const md = renderLedger(readLedger(file), { file });
    if (opts.json) console.log(JSON.stringify({ file, records: readLedger(file) }, null, 2));
    else console.log(md);
    return;
  }
  if (opts.adopt && opts.reject) { console.error('--adopt 与 --reject 只能二选一'); process.exit(2); }
  if (!opts.variants.length) {
    console.error('usage: node scripts/probe.mjs [dir] --variant "name=--flags" [--variant ...] [--scope unstaged] [--out probe.json] [--markdown probe.md]');
    console.error('       采纳/拒绝: --adopt <变体> --lesson "..." | --reject <变体> --lesson "..." | --list-ledger');
    process.exit(2);
  }
  let result;
  try {
    result = runProbe({ dir: opts.dir, scope: opts.scope, base: opts.base, variants: opts.variants, baseline: opts.baseline, timeoutMs: Math.max(1000, opts.timeout * 1000) });
  } catch (e) {
    console.error(`probe failed: ${e.message}`);
    process.exit(2);
  }
  const md = renderMarkdown(result);
  if (opts.markdown) {
    const p = path.resolve(opts.markdown);
    fs.writeFileSync(p, md);
    console.error(`Markdown written to ${p}`);
  }
  if (opts.out) {
    const p = path.resolve(opts.out);
    fs.writeFileSync(p, JSON.stringify(result, null, 2));
    console.error(`JSON written to ${p}`);
  }
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else if (!opts.quiet) console.log(md);
  if (opts.failOnNoop && result.deadKnobs.length) {
    console.error(`dead knob(s): ${result.deadKnobs.join(', ')}`);
    process.exit(1);
  }
  const kind = opts.adopt ? 'adopt' : opts.reject ? 'reject' : null;
  if (kind) {
    const plan = planLedgerWrite({
      result, kind,
      variant: kind === 'adopt' ? opts.adopt : opts.reject,
      lesson: opts.lesson,
      by: opts.by || process.env.HERMES_PROFILE || process.env.USERNAME || null,
      probeOut: opts.out ? path.resolve(opts.out) : null,
    });
    if (!plan.ok) {
      console.error(`ledger 拒绝写入：${plan.reason}`);
      process.exit(1);
    }
    const file = path.resolve(opts.ledger);
    appendLedger(file, plan.record);
    console.error(`ledger ← ${kind} \`${plan.record.variant}\`（${file}）`);
  } else if (opts.lesson) {
    console.error('提示：--lesson 只在配合 --adopt / --reject 时写入台账');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
