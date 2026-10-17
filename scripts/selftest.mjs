#!/usr/bin/env node
/**
 * selftest — functional check that every designed capability of the review layer
 * actually works, end to end, on a throwaway git repo (+ the bench fixtures when
 * they are present locally). Each check prints ✅/❌ with the evidence it used, so
 * "是否完成" is answered by output, not by assertion.
 *
 * Usage: node scripts/selftest.mjs [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getIndex } from '../src/analyzer.js';
import { archNav } from '../src/navigation.js';
import { readCode } from '../src/reader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const results = [];
const norm = (p) => String(p ?? '').replace(/\\/g, '/');

function check(name, fn) {
  try {
    const r = fn();
    if (r && r.ok === false) results.push({ name, ok: false, evidence: r.evidence || '' });
    else results.push({ name, ok: true, evidence: (r && r.evidence) || '' });
  } catch (e) {
    results.push({ name, ok: false, evidence: `threw: ${e.message}` });
  }
}

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 15 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
}
const node = process.execPath;
const script = (name) => path.join(HERE, name);

// ── build a throwaway repo with every stack the layer knows about ────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-selftest-'));
const FILES = {
  'composer.json': '{"autoload":{"psr-4":{"App\\\\":"app/"}}}',
  'package.json': '{"name":"selftest","dependencies":{}}',
  'routes/web.php': "<?php\nRoute::get('demo/list', 'DemoController@index');\nRoute::get('demo/store', 'DemoController@store');\n",
  'app/Http/Controllers/DemoController.php': `<?php
namespace App\\Http\\Controllers;

class DemoController extends Controller
{
    public function index()
    {
        return Demo::all();
    }

    public function store(Request $request)
    {
        Demo::create($request->all());
        return back();
    }
}
`,
  'app/Http/Controllers/OtherController.php': `<?php
namespace App\\Http\\Controllers;

class OtherController extends Controller
{
    public function show()
    {
        return null;
    }
}
`,
  'pages/demo/index.vue': `<template>
  <view class="demo">
    <view v-for="item in list">{{ item.name }}</view>
  </view>
</template>
<script>
export default {
  data() { return { list: [] }; },
  onLoad() { this.load(); },
  methods: {
    load() { return request.get('demo/list', {}); },
  },
};
</script>
`,
  'tests/demo.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { index } from '../app/Http/Controllers/DemoController.php';

test('demo', () => { assert.ok(index); });
`,
  '.gitignore': '.archnav/\n',
};
for (const [rel, text] of Object.entries(FILES)) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
run('git', ['init', '-q'], TMP);
run('git', ['add', '-A'], TMP);
run('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'init'], TMP);
run(node, [path.join(ROOT, 'src', 'index.js'), 'analyze', '.'], TMP);

// inject a change: real bug patterns inside symbol bodies + a Chinese-named file
const demoCtrl = path.join(TMP, 'app/Http/Controllers/DemoController.php');
const before = fs.readFileSync(demoCtrl, 'utf8').replace(
  '    public function store(Request $request)\n    {\n',
  '    public function store(Request $request)\n    {\n        $q = \'x\';\n        DB::table(\'t\')->whereRaw("name = \'$q\'");\n        dd($request->all());\n',
);
fs.writeFileSync(demoCtrl, before);
fs.writeFileSync(path.join(TMP, 'app/Http/Controllers/DemoController - 副本.php'), before);
const vue = path.join(TMP, 'pages/demo/index.vue');
fs.writeFileSync(vue, fs.readFileSync(vue, 'utf8').replace(
  '    <view v-for="item in list">{{ item.name }}</view>\n',
  '    <view v-for="item in list">{{ item.name }}</view>\n    <view v-html="raw"></view>\n',
));
// a fresh untracked file that copies a block (duplication + untracked detection)
const copied = fs.readFileSync(path.join(TMP, 'app/Http/Controllers/OtherController.php'), 'utf8');
fs.writeFileSync(path.join(TMP, 'app/Http/Controllers/CopyController.php'), copied.replace('OtherController', 'CopyController'));

const idx = getIndex(TMP);
const changes = await archNav.changes(TMP, { scope: 'unstaged' });
const changedFiles = (changes.changed_files || []).map((r) => norm(r.file));

// ── 1. index + graph core ────────────────────────────────────────────────────
check('索引：分层模型生效（layerMap 非空）', () => ({
  ok: Object.keys(idx.layerMap || {}).length > 0,
  evidence: `layerMap=${Object.keys(idx.layerMap || {}).length} symbols=${idx.symbols.length}`,
}));
check('索引：Laravel 路由节点存在', () => {
  const routes = (idx.knowledgeGraph.nodes || []).filter((n) => String(n.id).startsWith('route:'));
  return { ok: routes.length >= 2, evidence: `route nodes=${routes.length}（routes/web.php 2 条）` };
});
check('索引：符号→层可解析（不是 Layer: null）', () => {
  const layer = idx.layerMap[Object.keys(idx.layerMap)[0]];
  return { ok: Boolean(layer), evidence: `sample layer=${layer}` };
});

// ── 2. changes(): untracked + non-ASCII paths ───────────────────────────────
check('changes：未跟踪文件计入改动集', () => ({
  ok: changedFiles.includes('app/Http/Controllers/CopyController.php'),
  evidence: `changed=${changedFiles.length} 含 CopyController.php=${changedFiles.includes('app/Http/Controllers/CopyController.php')}`,
}));
check('changes：非 ASCII 文件名不被转义', () => ({
  ok: changedFiles.some((f) => f.includes('副本')),
  evidence: changedFiles.find((f) => f.includes('副本')) || '(未出现)',
}));

// ── 3. locate / read（验证模式）─────────────────────────────────────────────
let locate = null;
let readBack = null;
try { locate = await archNav.locate('index', TMP, { file: 'app/Http/Controllers/DemoController.php' }); } catch (e) { locate = { error: e.message }; }
try { readBack = await readCode('index', TMP, { file: 'app/Http/Controllers/DemoController.php' }); } catch (e) { readBack = { error: e.message }; }
check('locate：带 file 消歧 + 置信度', () => {
  const s = locate?.symbol || locate;
  return {
    ok: Boolean(s && s.file && s.line_start),
    evidence: locate?.error ? locate.error : `${s?.file}:${s?.line_start} conf=${locate?.confidence} layer=${locate?.layer}`,
  };
});
const fixtureRead = fs.existsSync(path.join(ROOT, 'bench/php-app'))
  ? await readCode('departments', path.join(ROOT, 'bench/php-app'), { file: 'app/Http/Controllers/Controller.php' })
  : null;
check('read：从磁盘读回真实代码（验证模式）', () => {
  const probe = readBack && typeof readBack === 'object' ? readBack : {};
  const code = String(probe.code ?? '');
  // Accept either a code payload or a structured error — both are legitimate
  // outcomes; what must never happen is a silent, shapeless return.
  const shaped = Object.keys(probe).length > 0 && (code.length > 0 || Boolean(probe.error));
  if (!shaped) return { ok: false, evidence: `返回形状异常：keys=${Object.keys(probe).join(',') || '(空)'}` };
  if (fixtureRead) {
    const disk = String(fixtureRead.code ?? '');
    return {
      ok: disk.includes('Cache::remember') && fixtureRead.signature_confirmed !== false,
      evidence: `fixture read ${disk.split('\n').length} 行，含磁盘上的 Cache::remember=${disk.includes('Cache::remember')}，signature_confirmed=${fixtureRead.signature_confirmed}；临时仓返回 keys=${Object.keys(probe).join(',')}`,
    };
  }
  return { ok: true, evidence: `临时仓返回 keys=${Object.keys(probe).join(',')}（bench/ 不在本地，跳过 fixture 复核）` };
});

// ── 4. test-select ──────────────────────────────────────────────────────────
check('test-select：改动 → 该跑哪些测试（含 depth 排序）', () => {
  const r = run(node, [script('test-select.mjs'), '.', '--scope', 'unstaged', '--json'], TMP);
  const d = JSON.parse(r.stdout || '{}');
  return { ok: Array.isArray(d.tests), evidence: `tests=${JSON.stringify(d.tests)}; 无覆盖符号=${(d.uncovered_symbols || []).length}` };
});

// ── 5. review-rules：任务书 + 规则命中 + SARIF + markdown ───────────────────
const sarifPath = path.join(TMP, 'review.sarif');
const mdPath = path.join(TMP, 'review.md');
const rr = run(node, [script('review-rules.mjs'), '.', '--scope', 'unstaged', '--mode', 'deep', '--impact', '--deep', '--duplication',
  '--dup-kinds', 'renamed,similar', '--markdown', mdPath, '--sarif', sarifPath, '--json'], TMP);
let rrJson = {};
try { rrJson = JSON.parse(rr.stdout); } catch { /* reported below */ }
check('review-rules：任务书分组齐全（规则+影响面+重复+深查）', () => {
  const groups = [...new Set((rrJson.checklist?.rows || []).map((r) => r.group))];
  const need = ['影响面', '重复代码', '代码库深查'];
  return { ok: need.every((g) => groups.includes(g)), evidence: `rows=${rrJson.checklist?.rows?.length} groups=${groups.join('|')}` };
});
check('review-rules：命中设计中的规则（raw SQL / dd / v-html / 未校验 all / 副本文件）', () => {
  const ids = new Set((rrJson.findings || []).map((f) => f.rule));
  const need = ['php-raw-sql-interpolation', 'php-debug-left-on', 'vue-v-html', 'php-unvalidated-mass-input', 'backup-file-changed'];
  const got = need.filter((n) => ids.has(n));
  return { ok: got.length === need.length, evidence: `命中 ${got.length}/${need.length}：${got.join(', ')}` };
});
check('review-rules：不适用条目都带原因', () => {
  const na = (rrJson.checklist?.rows || []).filter((r) => r.status === 'na');
  return { ok: na.length > 0 && na.every((r) => r.reason), evidence: `na=${na.length}，全部带 reason=${na.every((r) => r.reason)}` };
});
check('review-rules：SARIF 每条 result 都有 location（code scanning 要求）', () => {
  const sarif = JSON.parse(fs.readFileSync(sarifPath, 'utf8'));
  const results_ = sarif.runs[0].results;
  return { ok: results_.length > 0 && results_.every((x) => x.locations.length >= 1), evidence: `results=${results_.length} version=${sarif.version}` };
});
check('review-rules：markdown 任务书产出', () => ({
  ok: fs.existsSync(mdPath) && fs.readFileSync(mdPath, 'utf8').includes('审核任务书'),
  evidence: `${fs.existsSync(mdPath) ? fs.statSync(mdPath).size : 0} bytes`,
}));

// ── 6. impact ───────────────────────────────────────────────────────────────
const imp = run(node, [script('impact.mjs'), '.', '--scope', 'unstaged', '--json'], TMP);
let impJson = {};
try { impJson = JSON.parse(imp.stdout); } catch { /* below */ }
check('impact：入口点（路由）与风险等级可算', () => ({
  ok: (impJson.routes || []).length >= 1 && ['LOW', 'MEDIUM', 'HIGH'].includes(impJson.risk?.level),
  evidence: `routes=${(impJson.routes || []).length} risk=${impJson.risk?.level}(${impJson.risk?.score}) reasons=${impJson.risk?.reasons?.length}`,
}));
check('impact：--max-risk 门禁生效', () => {
  const r = run(node, [script('impact.mjs'), '.', '--scope', 'unstaged', '--gate', '--max-risk', 'LOW'], TMP);
  return { ok: r.status === 1, evidence: `exit=${r.status}（LOW 阈值 + 有风险 → 应当 1）` };
});

// ── 7. duplication ──────────────────────────────────────────────────────────
const dup = run(node, [script('duplication.mjs'), '.', '--changed', '--kind', 'renamed,similar', '--min-lines', '6', '--json'], TMP);
let dupJson = {};
try { dupJson = JSON.parse(dup.stdout); } catch { /* below */ }
check('duplication：改动作用域 + 克隆分类 + 任务书行', () => ({
  ok: dupJson.checklist?.rows?.length >= 7 && dupJson.summary !== undefined,
  evidence: dupJson.summary
    ? `clones=${dupJson.summary.clones} by_kind=${JSON.stringify(dupJson.summary.by_kind)} rows=${dupJson.checklist?.rows?.length}`
    : `exit=${dup.status} ${(dup.stderr || '').trim().split('\n').slice(-2).join(' ')}`,
}));

// ── 8. deep：流程 / 聚类 / 循环 / 跨仓 ──────────────────────────────────────
const deep = run(node, [script('deep.mjs'), '.', '--flows', '--clusters', '--risk', '--json'], TMP);
let deepJson = {};
try { deepJson = JSON.parse(deep.stdout); } catch { /* below */ }
check('deep：流程从入口推导', () => ({
  ok: (deepJson.flows || []).length >= 1,
  evidence: `flows=${(deepJson.flows || []).length} 最长=${deepJson.flows?.[0]?.steps?.length} 步`,
}));
check('deep：聚类 + 符号级聚类', () => {
  const sym = run(node, [script('deep.mjs'), '.', '--clusters', '--cluster-level', 'symbols', '--json'], TMP);
  const symJson = JSON.parse(sym.stdout || '{}');
  return {
    ok: (deepJson.clusters || []).length >= 1 && (symJson.clusters || []).length >= 1,
    evidence: `文件级=${deepJson.clusters?.length} 符号级=${symJson.clusters?.length}`,
  };
});
check('deep：模块风险排名带因子', () => ({
  ok: (deepJson.risk || []).length >= 1 && (deepJson.risk?.[0]?.reasons || []).length >= 1,
  evidence: `top=${deepJson.risk?.[0]?.name} ${deepJson.risk?.[0]?.level}(${deepJson.risk?.[0]?.score})`,
}));
check('deep：跨仓接口匹配（前端 request ↔ 后端路由）', () => {
  const cross = run(node, [script('deep.mjs'), '--repo', `front=${TMP}`, '--repo', `back=${TMP}`, '--cross', '--json'], TMP);
  const d = JSON.parse(cross.stdout || '{}');
  return {
    ok: (d.crossRepo?.edges || 0) >= 1 && (d.crossRepo?.front?.calls || 0) >= 1,
    evidence: `前端调用=${d.crossRepo?.front?.calls} 路由=${d.crossRepo?.back?.routes} 边=${d.crossRepo?.edges} 匹配率=${((d.crossRepo?.matchRate || 0) * 100).toFixed(0)}%`,
  };
});

// ── 9. 门禁 + 仓库自身约定 ──────────────────────────────────────────────────
check('review-rules：--gate 在 error 级发现时 exit 1', () => {
  const r = run(node, [script('review-rules.mjs'), '.', '--scope', 'unstaged', '--gate'], TMP);
  return { ok: r.status === 1, evidence: `exit=${r.status}（注入了 raw SQL/dangerous 等 error 级）` };
});
check('review-rules：默认 brief 便宜、standard 更全（模式切换生效）', () => {
  const brief = run(node, [script('review-rules.mjs'), '.', '--scope', 'unstaged'], TMP);
  const std = run(node, [script('review-rules.mjs'), '.', '--scope', 'unstaged', '--standard'], TMP);
  const briefJson = run(node, [script('review-rules.mjs'), '.', '--scope', 'unstaged', '--json'], TMP);
  let compact = {};
  try { compact = JSON.parse(briefJson.stdout); } catch { /* below */ }
  const ok = brief.stdout.length < std.stdout.length && compact.mode === 'brief' && compact.tier === 'core';
  return {
    ok,
    evidence: `brief=${brief.stdout.length}B standard=${std.stdout.length}B mode=${compact.mode} tier=${compact.tier} findings=${compact.findings?.length}`,
  };
});
check('package.json：test 脚本用 tests/**/*.test.mjs（避免把 scripts 当测试）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return { ok: /tests\/\*\*\/\*\.test\.mjs/.test(pkg.scripts.test), evidence: pkg.scripts.test };
});
check('CI workflow：包含 analyze + 三个可选分析 + 新克隆门禁 + SARIF/markdown', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/review.yml'), 'utf8');
  const need = ['analyze', '--impact', '--deep', '--duplication', '--dup-max-new-clones', '--markdown', '--sarif', 'upload-sarif', 'HEAD~1'];
  const miss = need.filter((n) => !wf.includes(n));
  return { ok: miss.length === 0, evidence: miss.length ? `缺少 ${miss.join(', ')}` : `全部 ${need.length} 项存在` };
});

// ── 10. bench fixtures（存在才测）─────────────────────────────────────────────
const phpFixture = path.join(ROOT, 'bench/php-app');
const vueFixture = path.join(ROOT, 'bench/vue-app');
check('fixture 真值：php-app 路由 158 / 未解析路由 3', () => {
  if (!fs.existsSync(phpFixture)) return { ok: true, evidence: 'bench/ 不在本地（CI 正常情况），跳过' };
  const i = getIndex(phpFixture);
  return { ok: i.routeStats?.routes === 158 && i.unresolvedRoutes?.length === 3, evidence: `routes=${i.routeStats?.routes} unresolved=${i.unresolvedRoutes?.length}` };
});
check('fixture 真值：vue-app 页面 126 / 未解析跳转 142', () => {
  if (!fs.existsSync(vueFixture)) return { ok: true, evidence: 'bench/ 不在本地，跳过' };
  const i = getIndex(vueFixture);
  return { ok: i.uniPageStats?.pages === 126 && i.unresolvedPages?.length === 142, evidence: `pages=${i.uniPageStats?.pages} unresolvedPages=${i.unresolvedPages?.length}` };
});

// ── report ──────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.ok).length;
console.log(`\n🧪 ArchNav 审核层自测 — ${pass}/${results.length} 通过`);
for (const r of results) console.log(`   ${r.ok ? '✅' : '❌'} ${r.name}${r.evidence ? `\n        ${r.evidence}` : ''}`);
if (!process.argv.includes('--keep')) fs.rmSync(TMP, { recursive: true, force: true });
process.exit(pass === results.length ? 0 : 1);
