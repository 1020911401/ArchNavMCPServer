#!/usr/bin/env node
/**
 * kanban-review.mjs — 把 ArchNav 的「审核任务书」接到 Hermes Kanban / Projects（项目管理），
 * 让每条命中项变成一张可「逐项审核确认」的任务卡，确认状态可回读成最终审核结论。
 *
 *   push   review.json ──► 父任务（审核批次）+ 子任务（逐条命中项，带 file:line/why/evidence）
 *   status 回读 kanban 状态 ──► 逐项确认清单（✅已确认 / ⛔驳回 / 🔎待复核 / ⬜待确认）+ 门禁退出码
 *
 * Usage:
 *   node scripts/kanban-review.mjs push review.json [--board <slug>] [--granularity rule|rule-file|finding]
 *                                                   [--min-severity info|warn|error] [--label <text>]
 *                                                   [--dry-run] [--json]
 *   node scripts/kanban-review.mjs status --board <slug> [--run <fp>] [--gate] [--json] [--markdown out.md]
 *
 * 约定（写死的字段用法，回读靠它们）：
 *   tenant = run fingerprint（本次审核批次）      priority = error 3 / warn 2 / info 0
 *   title  = [archnav] <rule> · <file>            idempotency-key = <fp>:<item-slug>（重复 push 不产生重复卡）
 * 逐项确认的动词就用 kanban 自带的：
 *   hermes kanban complete <id> --result "确认：..."   → ✅ 确认通过
 *   hermes kanban comment  <id> "..."                  → 追加确认证据
 *   hermes kanban block    <id>                        → ⛔ 驳回 / 待澄清
 *   hermes kanban request-review <id>                  → 🔎 待复核
 *   hermes kanban archive  <id>                        → ➖ 误报豁免（必须带 comment 说明）
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// 复用 review-rules 的豁免语义（同一条规则：没 reason 不生效、匹配不到报 stale），
// 免得两个脚本各写一套判定。导入成本实测 ~1.4s（一次性）。
import { applyWaivers, loadWaivers } from './review-rules.mjs';

const HERMES = process.env.HERMES_BIN || (process.platform === 'win32' ? 'hermes.exe' : 'hermes');
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = '.archnav';

/** 找能 import hermes_cli 的 python（快路径用；找不到就退回逐条 CLI）。 */
function pythonCandidates() {
  const home = process.env.HERMES_HOME
    || (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || '', 'hermes')
      : join(process.env.HOME || '', '.hermes'));
  const cands = [
    process.env.HERMES_PYTHON,
    process.platform === 'win32'
      ? join(home, 'hermes-agent', 'venv', 'Scripts', 'python.exe')
      : join(home, 'hermes-agent', 'venv', 'bin', 'python'),
    process.platform === 'win32' ? 'python.exe' : 'python3',
  ];
  return [...new Set(cands.filter(Boolean))];
}

function hermes(args, { board = null, allowFail = false } = {}) {
  const full = board ? ['kanban', '--board', board, ...args] : args;
  const r = spawnSync(HERMES, full, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`spawn ${HERMES} failed: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new Error(`hermes ${full.join(' ')} → exit ${r.status}\n${(r.stderr || '').trim()}`);
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--gate' || a === '--json') o[a.slice(2).replace('-', '')] = true;
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

const SEV_PRIORITY = { error: 3, warn: 2, info: 0 };
const SEV_RANK = { info: 0, warn: 1, error: 2 };
const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';

function fingerprint(review, label) {
  const h = createHash('sha1');
  h.update(JSON.stringify({
    label: label || null,
    scope: review.scope || null,
    hit: (review.checklist?.rows || []).filter((r) => r.status === 'hit').map((r) => `${r.id}:${r.hits}`),
    findings: (review.findings || []).map((f) => `${f.rule}|${f.severity}|${f.file}|${f.line ?? ''}`),
  }));
  return h.digest('hex').slice(0, 8);
}

/** findings → 确认项（每项 = 一张子任务卡） */
function groupFindings(findings, granularity, minSeverity) {
  const floor = SEV_RANK[minSeverity] ?? 0;
  const kept = findings.filter((f) => (SEV_RANK[f.severity] ?? 0) >= floor);
  const groups = new Map();
  for (const f of kept) {
    const file = f.file || '(repo)';
    const key = granularity === 'rule' ? f.rule
      : granularity === 'finding' ? `${f.rule}|${file}|${f.line ?? ''}|${(f.message || '').slice(0, 40)}`
        : `${f.rule}|${file}`;
    if (!groups.has(key)) groups.set(key, { rule: f.rule, file, severity: f.severity, findings: [] });
    const g = groups.get(key);
    g.findings.push(f);
    if ((SEV_RANK[f.severity] ?? 0) > (SEV_RANK[g.severity] ?? 0)) g.severity = f.severity;
  }
  return [...groups.values()].sort((a, b) => (SEV_RANK[b.severity] - SEV_RANK[a.severity]) || b.findings.length - a.findings.length);
}

function itemBody(g, fp, board) {
  const L = [];
  L.push(`**规则** \`${g.rule}\` · 严重度 **${g.severity}** · ${g.findings.length} 条证据`);
  L.push('');
  g.findings.slice(0, 40).forEach((f, i) => {
    L.push(`${i + 1}. \`${f.file || '(repo)'}${f.line ? ':' + f.line : ''}\` — ${f.message || ''}`);
    if (f.why) L.push(`   - 为什么: ${f.why}`);
    if (f.evidence) L.push(`   - 证据: \`${String(f.evidence).slice(0, 300)}\``);
  });
  if (g.findings.length > 40) L.push(`...（其余 ${g.findings.length - 40} 条同类证据见 review.json）`);
  L.push('');
  L.push('**逐项确认**（用 kanban 自带动词，确认结论即审核证据）');
  L.push(`- ✅ 确认通过: \`hermes kanban --board ${board} complete <id> --result "确认：..."\``);
  L.push(`- ⛔ 驳回/待澄清: \`hermes kanban --board ${board} block <id>\` + \`comment <id> "驳回理由"\``);
  L.push(`- 🔎 待复核: \`hermes kanban --board ${board} request-review <id>\``);
  L.push(`- ➖ 误报豁免: \`hermes kanban --board ${board} archive <id>\`（必须先 comment 说明为什么是误报）`);
  L.push('');
  L.push(`批次 fingerprint: \`${fp}\``);
  return L.join('\n');
}

function parentBody(review, fp, items, board, cwd) {
  const s = review.checklist?.summary || {};
  const L = [];
  L.push(`**仓库** \`${cwd}\` · **scope** \`${review.scope || '?'}\` · **via** \`${review.via || '?'}\``);
  L.push('');
  L.push(`规则任务书：${s.total ?? '?'} 条 —— ✅ 通过 ${s.pass ?? '?'} · ⚠️ 命中 ${s.hit ?? '?'} · ➖ 不适用 ${s.na ?? '?'}（findings ${s.findings ?? '?'}）`);
  L.push('');
  L.push(`本次生成 **${items.length}** 张逐项确认卡（子任务）：`);
  L.push('');
  L.push('| 规则 | 文件 | 严重度 | 证据 |');
  L.push('|---|---|---|---|');
  for (const g of items) L.push(`| \`${g.rule}\` | \`${g.file}\` | ${g.severity} | ${g.findings.length} |`);
  L.push('');
  L.push('**门禁**：`node scripts/kanban-review.mjs status --board ' + board + ' --run ' + fp + ' --gate` —— 只要还有未确认的 error/warn 项就 exit 1。');
  L.push('');
  L.push(`批次 fingerprint: \`${fp}\`（= 所有子任务的 tenant，回读就靠它）`);
  return L.join('\n');
}

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * 已豁免的条目不再建卡：卡片是 rule×file（或 rule）粒度，**组内每一处都被豁免了才整组跳过**
 * ——否则这一组里还有没看过的命中，卡得留着。豁免语义直接从 review-rules 复用。
 */
export function skipWaivedGroups(items, waivers) {
  const norm = (s) => String(s ?? '').replace(/\\/g, '/');
  const { waived } = applyWaivers(items.flatMap((g) => g.findings), waivers);
  const keys = new Set(waived.map((w) => `${w.rule}|${norm(w.file)}|${w.line ?? '*'}`));
  return items.filter((g) => !g.findings.every((f) => keys.has(`${f.rule}|${norm(f.file)}|${f.line ?? '*'}`)
    || keys.has(`${f.rule}|${norm(f.file)}|*`)));
}

function cmdPush(o) {
  const src = o._[1];
  if (!src) throw new Error('用法: push <review.json> [--board slug] ...');
  const abs = resolve(src);
  const review = JSON.parse(readFileSync(abs, 'utf8'));
  if (!review.checklist || !Array.isArray(review.findings)) {
    throw new Error(`输入不是完整的审核任务书（缺 checklist/findings。生成时用:\n  node scripts/review-rules.mjs . --scope <scope> --impact --deep --mode deep --no-compact --json > review.json\n注意必须加 --no-compact —— 默认 --json 是压缩摘要，没有 checklist / why / evidence。`);
  }
  if (review.findings.some((f) => !('why' in f))) {
    throw new Error('findings 缺 why/evidence 字段（压缩输出）。生成时加 --no-compact。');
  }
  const board = o.board || 'default';
  const granularity = o.granularity || 'rule-file';
  const minSeverity = o['min-severity'] || 'info';
  const cwd = o.cwd || process.cwd();
  const fp = fingerprint(review, o.label);
  let items = groupFindings(review.findings || [], granularity, minSeverity);

  // `push --waivers <file>`：已逐项豁免的条目不再建卡。
  // 为什么需要它：kanban 的幂等只对**未归档**任务生效（归档后同 key 会重新建卡），
  // 所以「豁免 → 再 push」会把这些条目又摆一遍。豁免语义直接复用 review-rules。
  let skippedWaived = [];
  if (o.waivers) {
    const loaded = loadWaivers(o.waivers);
    const before = items.length;
    items = skipWaivedGroups(items, loaded.list);
    const waivedCount = applyWaivers(items.flatMap((g) => g.findings), loaded.list).waived.length;
    skippedWaived = { file: loaded.source, groups: before - items.length, findings: waivedCount };
  }
  const plan = items.map((g) => ({
    key: `${fp}:${slug(g.rule)}:${slug(g.file)}:${g.findings.length}`,
    title: `[archnav] ${g.rule} · ${g.file}`,
    body: itemBody(g, fp, board),
    priority: String(SEV_PRIORITY[g.severity] ?? 0),
  }));

  if (o.dryrun) {
    console.log(`dry-run: board=${board} tenant=${fp} granularity=${granularity} min-severity=${minSeverity}`);
    console.log(`逐项确认卡 ${plan.length} 张 + 收口卡 1 张（审核任务书 · ${cwd.split(/[\\/]/).pop()} · ${review.scope || '?'}）`);
    if (o.waivers) console.log(`   （--waivers ${skippedWaived.file}：${skippedWaived.findings} 处命中已豁免 → 跳过 ${skippedWaived.groups} 组不建卡）`);
    for (const p of plan) console.log(`  · [${p.priority}] ${p.title}  (${p.body.length} chars)`);
    return 0;
  }

  const parentTitle = `[archnav] 审核任务书收口 · ${cwd.split(/[\\/]/).pop()} · ${review.scope || '?'} · ${plan.length} 项`;
  const headerKw = {
    title: parentTitle, body: parentBody(review, fp, items, board, cwd),
    tenant: fp, priority: 3, idempotency_key: `${fp}:root`, created_by: 'archnav',
    parents: '@items',
  };
  const itemKw = plan.map((p) => ({
    title: p.title, body: p.body, tenant: fp, priority: Number(p.priority),
    idempotency_key: p.key, created_by: 'archnav',
  }));

  // 快路径：单进程直接调 hermes_cli.kanban_db.create_task（同一实现、同一 DB、同一 idempotency 语义）。
  // 逐条 spawn `hermes kanban create` 实测 ~13s/次（CLI 每次都要 import 整个 agent），16 条要 3~4 分钟。
  let parentId = null; let map = []; let via = 'cli';
  const pyPlan = join(STATE_DIR, `kanban-plan-${fp}.json`);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(pyPlan, JSON.stringify({ items: itemKw, header: headerKw }, null, 2));
  for (const py of pythonCandidates()) {
    const r = spawnSync(py, [join(SELF_DIR, 'kanban_review_batch.py'), '--board', board, '--plan', pyPlan, '--json'],
      { encoding: 'utf8', windowsHide: true });
    if (r.error) continue;
    const parsed = r.status === 0 ? parseJson(r.stdout) : null;
    if (!parsed) continue;
    parentId = parsed.header_id;
    map = parsed.items.map((it, i) => ({ ...it, key: plan[i]?.key, header: parentId }));
    via = 'api';
    break;
  }
  if (!map.length) {
    // 退回逐条 CLI（无 python / import 不到 hermes_cli）：条目先建，收口卡最后建并指向所有条目
    for (const p of plan) {
      const r = hermes(['create', p.title, '--body', p.body,
        '--tenant', fp, '--priority', p.priority, '--idempotency-key', p.key, '--json'], { board });
      const id = parseJson(r.stdout)?.id;
      if (!id) throw new Error(`子任务创建失败: ${p.title}（注意：逐条 CLI 路径不带依赖关系，收口卡需手动 link）`);
      map.push({ id, title: p.title, priority: Number(p.priority), key: p.key });
    }
    const h = hermes(['create', parentTitle, '--body', headerKw.body,
      ...map.flatMap((m) => ['--parent', m.id]),
      '--tenant', fp, '--idempotency-key', `${fp}:root`, '--priority', '3', '--json'], { board });
    parentId = parseJson(h.stdout)?.id || null;
  }

  mkdirSync(STATE_DIR, { recursive: true });
  const stateFile = join(STATE_DIR, `kanban-review-${fp}.json`);
  writeFileSync(stateFile, JSON.stringify({ fp, board, cwd, scope: review.scope, granularity, minSeverity, parentId, skippedWaived, items: map }, null, 2));

  if (o.json) console.log(JSON.stringify({ fp, board, via, parentId, items: map.map((m) => ({ id: m.id, title: m.title, priority: m.priority })) }, null, 2));
  else {
    console.log(`✅ 已接入看板 '${board}'（${via === 'api' ? '批量 API，单进程' : '逐条 CLI'}）：${map.length} 张逐项确认卡 + 收口卡 ${parentId || '(无)'}（tenant=${fp}）`);
    console.log(`   状态文件: ${stateFile}`);
    console.log(`   回读: node scripts/kanban-review.mjs status --board ${board} --run ${fp}`);
    console.log(`   看板: hermes kanban --board ${board} list --sort priority-desc`);
  }
  return 0;
}

const STATUS_LABEL = {
  done: ['✅', '已确认'], blocked: ['⛔', '驳回/待澄清'], review: ['🔎', '待复核'],
  todo: ['⬜', '待确认'], ready: ['⬜', '待确认'], running: ['🔄', '处理中'],
  scheduled: ['⏰', '已排期'], triage: ['🤖', '待细化'], archived: ['➖', '已豁免'],
};

/** 批次 fingerprint：显式 --run 优先，否则取最近一个批次状态文件。 */
function resolveRun(o) {
  if (o.run) return o.run;
  const all = existsSync(STATE_DIR)
    ? readdirSync(STATE_DIR).filter((f) => f.startsWith('kanban-review-')).sort()
    : [];
  if (!all.length) throw new Error(`没有批次状态文件（${STATE_DIR}/kanban-review-*.json），先跑 push`);
  return all[all.length - 1].match(/kanban-review-(.+)\.json/)[1];
}

function cmdStatus(o) {
  const board = o.board || 'default';
  const fp = resolveRun(o);
  const stateFile = join(STATE_DIR, `kanban-review-${fp}.json`);
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
  const r = hermes(['list', '--tenant', fp, '--json', '--archived'], { board });
  const tasks = parseJson(r.stdout) || [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rows = (state?.items || tasks.filter((t) => t.tenant === fp && t.id !== state?.parentId)).map((it) => {
    const t = byId.get(it.id) || {};
    const [icon, label] = STATUS_LABEL[t.status] || ['?', t.status || 'missing'];
    return { id: it.id, title: it.title || t.title, priority: Number(t.priority ?? it.priority ?? 0), status: t.status || 'missing', icon, label, result: t.result || null };
  });
  const open = rows.filter((r) => ['todo', 'ready', 'running', 'review', 'triage'].includes(r.status));
  const blocking = open.filter((r) => r.priority >= 2);
  const header = state?.parentId ? byId.get(state.parentId) : null;
  const headerLabel = header ? (STATUS_LABEL[header.status] || ['?', header.status]).join(' ') : null;

  if (o.json) {
    console.log(JSON.stringify({ fp, board, total: rows.length, open: open.length, blocking: blocking.length, header: header ? { id: state.parentId, status: header.status } : null, rows }, null, 2));
    return o.gate && blocking.length ? 1 : 0;
  }
  console.log(`📋 逐项审核确认 — 批次 ${fp}（看板 ${board}）`);
  console.log(`   共 ${rows.length} 项：✅ 已确认 ${rows.filter((r) => r.status === 'done').length} · ⛔ 驳回 ${rows.filter((r) => r.status === 'blocked').length} · ➖ 豁免 ${rows.filter((r) => r.status === 'archived').length} · 未确认 ${open.length}`);
  if (headerLabel) console.log(`   收口卡 [${state.parentId}] ${headerLabel} —— 条目全部有结论后才 complete（看板父子依赖：父未完成时孩子 complete 会被拒）`);
  console.log('');
  for (const r of rows) console.log(`   ${r.icon} [${r.id}] ${r.title}${r.result ? `\n        └ ${String(r.result).slice(0, 120)}` : ''}`);
  if (o.markdown) {
    const md = ['| 状态 | 项 | 规则项 | 确认结论 | id |', '|---|---|---|---|---|', ...rows.map((r) => `| ${r.icon} ${r.label} | ${r.title.replace(/^\|/, '\\|')} | p${r.priority} | ${(r.result || '').replace(/\n/g, ' ').slice(0, 80)} | \`${r.id}\` |`)].join('\n');
    writeFileSync(o.markdown, `## 📋 逐项审核确认 — ${fp}\n\n${md}\n`);
    console.log(`\n   markdown → ${o.markdown}`);
  }
  if (blocking.length) console.log(`\n❌ 门禁未过：${blocking.length} 个 error/warn 级确认项仍未有结论`);
  else if (open.length) console.log(`\n⚠️  还有 ${open.length} 个 info 级项未确认（不阻塞门禁）`);
  else console.log('\n✅ 逐项确认完成，门禁通过');
  return o.gate && blocking.length ? 1 : 0;
}

/**
 * `waivers` — 把看板上「➖ archive 豁免」的条目导成 `review-rules.mjs --waivers` 能吃的文件。
 * 闭环：看板逐项确认 → 豁免清单落盘 → 下次 review 不再重复报同一条（且每条都留有理由）。
 */
function cmdWaivers(o) {
  const board = o.board || 'default';
  const fp = resolveRun(o);
  const stateFile = join(STATE_DIR, `kanban-review-${fp}.json`);
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;

  // 优先走批量 API（一次进程拿到任务 + 评论）；退化路径没有评论 → 少 reason → 豁免按规矩不生效
  let tasks = null;
  for (const py of pythonCandidates()) {
    const r = spawnSync(py, [join(SELF_DIR, 'kanban_review_batch.py'), '--board', board, '--dump', fp, '--json'],
      { encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0) continue;
    const parsed = parseJson(r.stdout);
    if (parsed?.tasks) { tasks = parsed.tasks; break; }
  }
  if (!tasks) {
    const r = hermes(['list', '--tenant', fp, '--json', '--archived'], { board });
    tasks = (parseJson(r.stdout) || []).map((t) => ({ ...t, comments: [] }));
    console.error('⚠️  没走成批量 API：拿不到评论 → 豁免条目会因缺 reason 被判无效（review-rules 的规矩）');
  }

  const items = tasks.filter((t) => t.status === 'archived' && /^\[archnav\] (?!审核任务书收口)/.test(t.title || ''));
  const unparsed = [];
  const waivers = items.map((t) => {
    const m = /^\[archnav\] (.+?) · (.*)$/.exec(t.title);
    if (!m) { unparsed.push(t.id); return null; }
    const comment = (t.comments || []).find((c) => String(c.body || '').trim());
    return {
      rule: m[1], file: m[2], line: null,
      reason: comment ? String(comment.body).trim() : (t.result || ''),
      by: comment?.author || null, task: t.id,
    };
  }).filter(Boolean);

  const payload = {
    generated: new Date().toISOString(),
    source: { board, tenant: fp, scope: state?.scope || null, repo: state?.cwd || null },
    waivers,
  };
  const out = o.out || `waivers-${fp}.json`;
  writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
  if (o.json) { console.log(JSON.stringify(payload, null, 2)); return 0; }
  console.log(`➖ 已导出 ${waivers.length} 条豁免 → ${out}（批次 ${fp} / 看板 ${board}）`);
  const noReason = waivers.filter((w) => !String(w.reason || '').trim()).length;
  if (noReason) console.log(`   ⚠️  ${noReason} 条没有理由（没写 comment）→ review-rules 会判它们无效，记得补理由`);
  if (unparsed.length) console.log(`   ⚠️  ${unparsed.length} 张卡标题无法解析（${unparsed.join(', ')}）`);
  console.log(`   下一步：node scripts/review-rules.mjs . --scope <scope> --waivers ${out}`);
  return 0;
}

function main(argv) {
  const o = parseArgs(argv);
  const cmd = o._[0];
  return cmd === 'push' ? cmdPush(o)
    : cmd === 'status' ? cmdStatus(o)
      : cmd === 'waivers' ? cmdWaivers(o)
        : (console.error('用法: kanban-review.mjs push|status|waivers ...'), 2);
}

export { parseArgs, fingerprint, groupFindings, itemBody, parentBody, cmdPush, cmdStatus, cmdWaivers, pythonCandidates, SEV_PRIORITY, SEV_RANK };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(2);
  }
}
