/**
 * ANCHOR tier B — the constraint layer.
 *
 * This is the part of ANCHOR that a house-rule list cannot express: constraints are
 * *per task*, they are typed (atomic items), and they compose into AND / THEN /
 * PRIORITY relations whose joint satisfaction is scored separately from the atoms.
 * ANCHOR measures that difference: 70.1% atomic compliance vs 63.7% relation
 * compliance vs 19.0% all-item FCCR — a rule list can only ever report the first.
 *
 * Constraint file: `.archnav/constraints.json` (see `constraintTemplate()`).
 *
 *   {
 *     "task": "fix duplicate crypto type registration",
 *     "constraints": [
 *       { "id": "c-scope", "leaf": "3.1.1", "text": "只改 src/crypto/ 下",
 *         "severity": "error", "check": { "type": "path_scope", "allow": ["src/crypto/**"] } },
 *       { "id": "c-test", "leaf": "9.1.1", "text": "必须加回归测试",
 *         "check": { "type": "test_added" } }
 *     ],
 *     "relations": [
 *       { "id": "r-and", "type": "AND", "items": ["c-scope", "c-test"] },
 *       { "id": "r-then", "type": "THEN", "items": ["c-test", "c-scope"], "note": "先写测试再改代码" }
 *     ],
 *     "failOn": { "FCCR": 1, "ACR": 0.9 }
 *   }
 *
 * Honest boundaries, encoded rather than described:
 *   - A check whose evidence is the trajectory (`order`, `llm`, …) returns `na` when no
 *     trajectory was supplied — never `pass`.
 *   - THEN without a trajectory can only test implication, and says so in `note`.
 *   - PRIORITY does not fail the task on an overridden lower item; it reports it as
 *     `override`, because that is exactly the semantic the paper scores.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ANCHOR_LEAF_BY_ID } from '../src/anchor-taxonomy.mjs';

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

const globToRe = (glob) => {
  const g = norm(glob).trim();
  if (!g) return null;
  if (!/[*?]/.test(g)) {
    // a bare directory means "everything under it", which is what users mean
    return new RegExp(`(?:^|/)${g.replace(/[.+^${}()|[\]\\]/g, '\\$&')}(?:/|$)`);
  }
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')      // **/  → optional path prefix
    .replace(/\*\*/g, '\u0002')        // **   → anything
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*');
  return new RegExp(`^${re}$`);
};

export function matchesAny(file, globs = []) {
  const f = norm(file);
  return globs.some((g) => { const re = globToRe(g); return re ? re.test(f) : false; });
}

/** Constraint file loading — a broken file is an error, never "no constraints". */
export function loadConstraints(file, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const raw = readFile(path.resolve(file));
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed?.constraints;
  if (!Array.isArray(list)) throw new Error(`constraints 文件形状不对（要 {constraints:[…]} 或数组）: ${file}`);
  const known = new Set(list.map((c) => c.id));
  const relations = Array.isArray(parsed?.relations) ? parsed.relations : [];
  for (const r of relations) {
    if (!['AND', 'THEN', 'PRIORITY'].includes(String(r.type).toUpperCase())) {
      throw new Error(`关系 ${r.id || '?'} 的 type 不支持：${r.type}（只支持 AND/THEN/PRIORITY）`);
    }
    for (const item of r.items || []) {
      if (!known.has(item)) throw new Error(`关系 ${r.id || '?'} 引用了不存在的约束：${item}`);
    }
  }
  return { file, task: parsed?.task || null, constraints: list, relations, failOn: parsed?.failOn || {}, source: 'file' };
}

/** A starting point a human can edit — every check type that works offline appears once. */
export function constraintTemplate() {
  return {
    task: '<一句话任务：这次要求 agent 做什么，并且必须怎么做到>',
    constraints: [
      { id: 'c-scope', leaf: '3.1.1', text: '只允许改 src/ 下的文件', severity: 'error', check: { type: 'path_scope', allow: ['src/**'] } },
      { id: 'c-budget', leaf: '3.2.2', text: 'diff 不超过 150 行', severity: 'warn', check: { type: 'max_lines', max: 150 } },
      { id: 'c-test', leaf: '9.1.1', text: '必须新增/修改测试', severity: 'error', check: { type: 'test_added' } },
      { id: 'c-lock', leaf: '7.2.1', text: '不允许改 lock 文件', severity: 'error', check: { type: 'lock_untouched' } },
      { id: 'c-ci', leaf: '7.3.1', text: '不允许改 CI 配置', severity: 'error', check: { type: 'ci_untouched' } },
      { id: 'c-route', leaf: '3.3.2', text: '保持现有 HTTP 路由不变', severity: 'error', check: { type: 'interface_stable', paths: ['routes/**'] } },
      { id: 'c-order', leaf: '2.1.1', text: '先复现 bug 再改代码', severity: 'error', check: { type: 'order', before: 'test|repro', after: 'edit' } },
      { id: 'c-report', leaf: '10.3.1', text: '报告必须引用 file:line', severity: 'warn', check: { type: 'report_references' } },
    ],
    relations: [
      { id: 'r-scope-and-test', type: 'AND', items: ['c-scope', 'c-test'] },
      { id: 'r-test-then-code', type: 'THEN', items: ['c-test', 'c-scope'], note: '测试先于实现' },
      { id: 'r-priority', type: 'PRIORITY', items: ['c-scope', 'c-budget'], note: '超预算是警告，越界是错误' },
    ],
    failOn: { FCCR: 1, ACR: 0.9 },
  };
}

const LOCK_RE = /(^|\/)(composer\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|go\.sum|Cargo\.lock)$/i;
const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec|e2e)\/.+|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|Test\.php$/i;
const CI_RE = /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.yml$|Jenkinsfile$|\.circleci\/)/i;

function hitFiles(files, globs) {
  return files.filter((f) => matchesAny(f, globs));
}

/**
 * One symbolic check. Returns `{status, evidence, note?}` where status is
 * pass | fail | na. `na` always carries the reason (missing evidence), because a
 * checklist item that cannot be judged must not look like a pass.
 */
export function runCheck(check = {}, ctx = {}) {
  const { diff, files = [], added = [], removed = [], trajectory = null, report = null, config = {} } = ctx;
  const type = String(check.type || '').toLowerCase();
  const noDiff = !diff || diff.via !== 'git';

  if (type === 'manual' || type === 'llm') {
    return { status: 'na', evidence: 'judge=llm/manual', note: '需要 LLM 判官或人工确认（本次未配置）' };
  }

  // ── evidence: trajectory ────────────────────────────────────────────────────
  if (['order', 'tool', 'tool_discipline', 'test_run', 'verify_after_edit', 'report_references', 'report_template', 'report_evidence'].includes(type)) {
    if (!trajectory) return { status: 'na', evidence: 'evidence=trajectory', note: '未提供执行轨迹（--anchor-trajectory），只能由 diff 判定的约束有效' };
    const TRAJ_ID = {
      order: 'traj-task-order',
      tool: 'traj-tool-prohibition',
      tool_discipline: 'traj-tool-prohibition',
      test_run: 'traj-test-selection',
      verify_after_edit: 'traj-result-verification',
      report_references: 'traj-code-references',
      report_evidence: 'traj-execution-evidence',
      report_template: 'traj-before-after',
    };
    const row = (ctx.trajectoryRows || []).find((r) => r.id === TRAJ_ID[type]);
    if (!row) return { status: 'na', evidence: 'evidence=trajectory', note: `轨迹层没有对应判据（${TRAJ_ID[type]}）` };
    return {
      status: row.status === 'pass' ? 'pass' : row.status === 'fail' ? 'fail' : 'na',
      evidence: `轨迹判据 ${row.title}：${row.evidence}`,
      note: row.note || null,
    };
  }

  if (noDiff) return { status: 'na', evidence: 'no-diff', note: '不是 git 仓库，取不到改动' };

  switch (type) {
    case 'path_scope': {
      const deny = check.deny || [];
      const allow = check.allow || [];
      const bad = files.filter((f) => (allow.length && !matchesAny(f, allow)) || matchesAny(f, deny));
      return bad.length
        ? { status: 'fail', evidence: `越界文件：${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ` …+${bad.length - 8}` : ''}` }
        : { status: 'pass', evidence: `改动文件全部落在 ${allow.join(' | ') || '允许范围'}` };
    }
    case 'file_scope': {
      const allow = check.allow || [];
      const bad = files.filter((f) => allow.length && !matchesAny(f, allow));
      return bad.length ? { status: 'fail', evidence: `不在允许清单：${bad.slice(0, 8).join(', ')}` } : { status: 'pass', evidence: `文件数 ${files.length}` };
    }
    case 'no_change': {
      const bad = hitFiles(files, check.paths || []);
      return bad.length ? { status: 'fail', evidence: `不该改的文件：${bad.slice(0, 8).join(', ')}` } : { status: 'pass', evidence: `未触碰 ${(check.paths || []).join(', ')}` };
    }
    case 'max_files': {
      const max = Number(check.max ?? 10);
      return files.length > max
        ? { status: 'fail', evidence: `files=${files.length} > ${max}` }
        : { status: 'pass', evidence: `files=${files.length} ≤ ${max}` };
    }
    case 'max_lines': {
      const max = Number(check.max ?? 200);
      const total = added.length + removed.length;
      return total > max ? { status: 'fail', evidence: `lines=${total} > ${max}` } : { status: 'pass', evidence: `lines=${total} ≤ ${max}` };
    }
    case 'forbidden_patterns': {
      const globs = check.files || [];
      const scoped = globs.length ? added.filter((a) => matchesAny(a.file, globs)) : added;
      const hits = [];
      for (const p of check.patterns || []) {
        let re;
        try { re = new RegExp(p, 'i'); } catch { return { status: 'na', evidence: `pattern 非法：${p}` }; }
        for (const a of scoped) if (re.test(a.text)) hits.push(`${a.file}:${a.line}`);
      }
      return hits.length ? { status: 'fail', evidence: `命中 ${hits.length} 处：${hits.slice(0, 6).join(', ')}` } : { status: 'pass', evidence: `patterns=${(check.patterns || []).length} 无命中` };
    }
    case 'required_patterns': {
      const misses = [];
      for (const p of check.patterns || []) {
        let re;
        try { re = new RegExp(p, 'i'); } catch { return { status: 'na', evidence: `pattern 非法：${p}` }; }
        if (!added.some((a) => re.test(a.text))) misses.push(p);
      }
      return misses.length ? { status: 'fail', evidence: `缺少：${misses.join(' | ')}` } : { status: 'pass', evidence: `patterns=${(check.patterns || []).length} 全部出现` };
    }
    case 'test_added': {
      const testFiles = files.filter((f) => TEST_FILE_RE.test(f));
      return testFiles.length
        ? { status: 'pass', evidence: `测试改动：${testFiles.slice(0, 5).join(', ')}` }
        : { status: 'fail', evidence: '本次改动没有触碰任何测试文件' };
    }
    case 'lock_untouched': {
      const bad = files.filter((f) => LOCK_RE.test(f));
      return bad.length ? { status: 'fail', evidence: `lock 被改：${bad.join(', ')}` } : { status: 'pass', evidence: 'lock 文件未改动' };
    }
    case 'ci_untouched': {
      const bad = files.filter((f) => CI_RE.test(f));
      return bad.length ? { status: 'fail', evidence: `CI 被改：${bad.join(', ')}` } : { status: 'pass', evidence: 'CI 配置未改动' };
    }
    case 'interface_stable': {
      // deletion of a declared route is the observable part of "interface compatible"
      const globs = check.paths || [];
      const lostRoutes = [];
      for (const r of removed) {
        if (globs.length && !matchesAny(r.file, globs)) continue;
        const m = /(Route::(?:get|post|put|patch|delete)|router\.(?:get|post|put|patch|delete)|app\.(?:get|post|put|patch|delete))\s*\(\s*['"]([^'"]+)['"]/.exec(r.text);
        if (m) lostRoutes.push(`${m[2]} (${r.file}:${r.line})`);
      }
      return lostRoutes.length
        ? { status: 'fail', evidence: `路由被删/改名：${lostRoutes.slice(0, 6).join(', ')}` }
        : { status: 'pass', evidence: `未删除已声明路由（扫描 ${globs.join(', ') || '全部改动文件'}）` };
    }
    case 'dep_not_added': {
      const manifest = files.filter((f) => /(composer\.json|package\.json|requirements\.txt|pyproject\.toml|go\.mod)$/i.test(f));
      return manifest.length ? { status: 'fail', evidence: `依赖清单被改：${manifest.join(', ')}` } : { status: 'pass', evidence: '未改依赖清单' };
    }
    case 'changed_symbols_in': {
      const globs = check.files || [];
      const hits = (config.changedSymbols || []).filter((s) => matchesAny(s.file, globs));
      return hits.length ? { status: 'pass', evidence: `${hits.length} 个改动符号在范围内` } : { status: 'na', evidence: '本次没有落到符号的改动' };
    }
    default:
      return { status: 'na', evidence: `未知 check.type：${check.type}`, note: '该约束无法判定，按未覆盖计' };
  }
}

/** Evaluate every atomic constraint. */
export function evaluateConstraints({ constraints, diff, trajectory = null, trajectoryRows = null, report = null, changedSymbols = [] } = {}) {
  const ctx = {
    diff,
    files: (diff?.files || []).map((f) => f.file),
    added: diff?.added || [],
    removed: diff?.removed || [],
    trajectory, trajectoryRows, report,
    config: { changedSymbols },
  };
  return constraints.map((c) => {
    const leaf = ANCHOR_LEAF_BY_ID.get(String(c.leaf || ''));
    const r = runCheck(c.check || {}, ctx);
    return {
      id: c.id,
      leaf: c.leaf || null,
      leafName: leaf ? leaf.nameZh : null,
      text: c.text || (leaf ? leaf.nameZh : c.id),
      severity: c.severity || (c.check?.severity) || 'error',
      judge: c.check?.type || null,
      ...r,
    };
  });
}

/**
 * Relation items (AND / THEN / PRIORITY) — the part of ANCHOR that is invisible in a
 * rule list, scored separately from the atomics.
 */
export function evaluateRelations({ relations = [], atomics = [], trajectory = null } = {}) {
  const byId = new Map(atomics.map((a) => [a.id, a]));
  const items = relations.map((rel) => {
    const type = String(rel.type).toUpperCase();
    const members = (rel.items || []).map((id) => byId.get(id)).filter(Boolean);
    const ids = members.map((m) => m.id);
    if (members.length < 2) return { id: rel.id || `${type}:${ids.join('+')}`, type, items: ids, status: 'na', evidence: '关系引用的约束不足 2 个', note: rel.note || null };

    if (type === 'AND') {
      const failed = members.filter((m) => m.status === 'fail');
      const unknown = members.filter((m) => m.status === 'na');
      const status = failed.length ? 'fail' : unknown.length ? 'na' : 'pass';
      return { id: rel.id || `AND:${ids.join('+')}`, type, items: ids, status, evidence: failed.length ? `未满足：${failed.map((m) => m.id).join(', ')}` : unknown.length ? `无法判定：${unknown.map((m) => m.id).join(', ')}` : '全部满足', note: rel.note || null };
    }

    if (type === 'THEN') {
      const [first, ...rest] = members;
      const later = rest;
      if (first.status === 'na') return { id: rel.id || `THEN:${ids.join('+')}`, type, items: ids, status: 'na', evidence: `前置项 ${first.id} 无法判定`, note: rel.note || null };
      if (first.status === 'fail') return { id: rel.id || `THEN:${ids.join('+')}`, type, items: ids, status: 'pass', evidence: `前置项 ${first.id} 未满足——THEN 语义下的后置要求不触发（但前置失败本身已计入 ACR）`, note: rel.note || null };
      const failed = later.filter((m) => m.status === 'fail');
      const unknown = later.filter((m) => m.status === 'na');
      const status = failed.length ? 'fail' : unknown.length ? 'na' : 'pass';
      return {
        id: rel.id || `THEN:${ids.join('+')}`, type, items: ids, status,
        evidence: failed.length ? `前置已满足，但 ${failed.map((m) => m.id).join(', ')} 未满足` : unknown.length ? `前置已满足，但 ${unknown.map((m) => m.id).join(', ')} 无法判定` : '顺序蕴含满足',
        note: trajectory ? (rel.note || null) : `${rel.note ? rel.note + '；' : ''}无轨迹：只验证了蕴含关系，时间顺序未验证`,
      };
    }

    // PRIORITY: items[0] is the highest priority. A failing higher item overrides the
    // lower ones instead of the task failing on every low-priority miss.
    const [top, ...lower] = members;
    const lowerFail = lower.filter((m) => m.status === 'fail');
    if (top.status === 'fail') {
      // 高优先项失败本身已经计入 ACR；PRIORITY 关系判的是"优先级有没有被正确处理"。
      // 低优先项也失败 → 关系失败并把它们标 override（退出 ACR）；低优先项都过 →
      // 没有可覆盖的东西，关系成立。
      if (!lowerFail.length) {
        return {
          id: rel.id || `PRIORITY:${ids.join('+')}`, type, items: ids, status: 'pass',
          evidence: `高优先项 ${top.id} 未满足（已计入 ACR），低优先项无冲突，优先级处理正确`,
          note: rel.note || null,
        };
      }
      return {
        id: rel.id || `PRIORITY:${ids.join('+')}`, type, items: ids,
        status: 'fail',
        evidence: `高优先项 ${top.id} 与低优先项 ${lowerFail.map((m) => m.id).join(', ')} 同时未满足`,
        overridden: lowerFail.map((m) => m.id),
        note: rel.note || null,
      };
    }
    const status = lowerFail.length ? 'fail' : (top.status === 'na' ? 'na' : 'pass');
    return { id: rel.id || `PRIORITY:${ids.join('+')}`, type, items: ids, status, evidence: lowerFail.length ? `低优先项未满足：${lowerFail.map((m) => m.id).join(', ')}` : '优先级处理正确', note: rel.note || null };
  });
  // PRIORITY overrides flip the overridden atomics to `override` so they stop
  // counting against ACR — exactly the semantic ANCHOR scores.
  const overridden = new Set(items.flatMap((i) => i.overridden || []));
  for (const a of atomics) if (overridden.has(a.id) && a.status === 'fail') a.status = 'override';
  return items;
}

/**
 * ACR / CCR / IPR / FCCR — same definitions as the paper, `na` excluded from the
 * denominators but reported, so a thin checklist cannot inflate the score silently.
 */
export function computeMetrics({ atomics = [], relations = [] } = {}) {
  const judgedA = atomics.filter((a) => a.status !== 'na' && a.status !== 'override');
  const passA = judgedA.filter((a) => a.status === 'pass').length;
  const judgedR = relations.filter((r) => r.status !== 'na');
  const passR = judgedR.filter((r) => r.status === 'pass').length;
  const naCount = atomics.filter((a) => a.status === 'na').length + relations.filter((r) => r.status === 'na').length;
  const overrideCount = atomics.filter((a) => a.status === 'override').length;
  const totalJudged = judgedA.length + judgedR.length;
  const passAll = passA + passR;
  const allPass = totalJudged > 0 && passAll === totalJudged;
  const round = (n) => Math.round(n * 1000) / 1000;
  return {
    ACR: judgedA.length ? round(passA / judgedA.length) : null,
    CCR: judgedR.length ? round(passR / judgedR.length) : null,
    IPR: totalJudged ? round(passAll / totalJudged) : null,
    FCCR: totalJudged ? (allPass ? 1 : 0) : null,
    counts: {
      atomics: atomics.length, atomicsJudged: judgedA.length, atomicsPass: passA,
      relations: relations.length, relationsJudged: judgedR.length, relationsPass: passR,
      na: naCount, overridden: overrideCount,
    },
    allPass,
  };
}

/** Human/gate summary for one constraint set. */
export function renderConstraints({ atomics = [], relations = [], metrics = null } = {}) {
  const L = [];
  const m = metrics || computeMetrics({ atomics, relations });
  L.push(`ACR ${m.ACR === null ? '—' : (m.ACR * 100).toFixed(1) + '%'} · CCR ${m.CCR === null ? '—' : (m.CCR * 100).toFixed(1) + '%'} · IPR ${m.IPR === null ? '—' : (m.IPR * 100).toFixed(1) + '%'} · FCCR ${m.FCCR === null ? '—' : m.FCCR === 1 ? '全项通过' : '未全项通过'}`);
  for (const a of atomics) {
    const mark = a.status === 'pass' ? '✅' : a.status === 'fail' ? '⛔' : a.status === 'override' ? '➖' : '❔';
    L.push(`   ${mark} [${a.id}${a.leaf ? ` · C${a.leaf}` : ''}] ${a.text} — ${a.evidence}${a.note ? `（${a.note}）` : ''}`);
  }
  for (const r of relations) {
    const mark = r.status === 'pass' ? '✅' : r.status === 'fail' ? '⛔' : '❔';
    L.push(`   ${mark} [${r.type} ${r.id}] ${r.items.join(' → ')} — ${r.evidence}${r.note ? `（${r.note}）` : ''}`);
  }
  return L.join('\n');
}
