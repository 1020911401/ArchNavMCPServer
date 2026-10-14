# 融合式代码智能引擎（ArchNav + CodeGraph + GitNexus 优势合并）实施计划

> **For Hermes:** 用 subagent-driven-development 逐任务执行；每任务 2–5 分钟、TDD、每任务一提交。
> 语言决策（D1）未定前，只执行 Phase 0/1（与语言无关，纯 JS 现状修复）。

**Goal:** 把 CodeGraph 的速度与 Hermes 接入、ArchNav 的"图谱带路 + 读盘验证 + 渐变置信度"协议、GitNexus 的深查能力（流程/影响面/变更映射）合成一个 MCP 入口，并把实测出的三类召回盲区补上（Blade 模板调用、Vue 嵌套回调调用、`@/` 别名导入）。

**Architecture:** 四层可插拔——L1 解析适配器（codegraph / gitnexus CLI 输出 + 自有 resolver）、L2 本地 SQLite(FTS5) 图存储、L3 融合层（合并去重、置信度合成、召回补丁）、L4 查询与 MCP 协议层（locate/read/callers/impact/trace/explore）。不 fork、不复制 GitNexus 代码（PolyForm Noncommercial），只调用其 CLI/MCP 输出。

**Tech Stack:** Node.js ≥ 22（现有 ArchNav 代码基线）+ 自有 Rust 内核（可选，Phase 2 之后评估）；测试用内置 `node --test`；存储 SQLite（`node:sqlite` / better-sqlite3）。

---

## 1. 目标与验收标准（可量化，全部有基准仓）

基准仓（已就绪，见 §2）：
- `bench/php-app`：Laravel 后端，286 PHP / 305 文件（`C:\projects\admin-app` 的 app+routes+config+views 副本）
- `bench/vue-app`：uni-app 前端，269 Vue / 64 JS / 456 文件（`a uni-app e-commerce template` 源码子集）

| # | 验收项 | 现状（三方最好） | 目标 |
|---|---|---|---|
| A1 | 全量建索引耗时 | 4.8s (CodeGraph, vue-app) | ≤ 8s (php-app) / ≤ 15s (vue-app) |
| A2 | `callers departments()`（真实 6 调用方） | 6/6（CodeGraph、GitNexus） | 6/6 且带调用行号 |
| A3 | `callers showSelectOptions`（真实 44 处 / 20 个 Blade 文件） | 0/44 | 文件级 ≥ 18/20，调用点 ≥ 40/44 |
| A4 | `callers orderTake`（真实 3 个 .vue，均在嵌套回调内） | 2/3（GitNexus） | 3/3 |
| A5 | `callers getUserInfo`（真实 34 文件 / 44 处，`@/api/user.js` 别名） | 9/34（GitNexus） | ≥ 32/34 |
| A6 | 误报率（报告的调用方里 grep 查不到的比例） | 未测 | ≤ 5% |
| A7 | 定义行号误差 | GitNexus 差 1 行 | 0 行 |
| A8 | 单文件改动后过期检测 / 增量 | CodeGraph sync 1.9–2.4s ✅ / ArchNav 报 fresh ❌ | 检测 ≤ 1s，增量 ≤ 3s |
| A9 | 许可 | GitNexus = PolyForm NC ❌ | 本项目 MIT/自有，无 PolyForm 代码 |
| A10 | Hermes 接入 | 仅 CodeGraph 官方支持 | `hermes-fusion install` 一条命令写好 MCP 配置 |

---

## 2. 现状基线（2026-10-14 实测，两仓同一套 ground truth）

### php-app（Laravel）

| 指标 | CodeGraph 1.6.2 | GitNexus 1.6.6 | ArchNav |
|---|---|---|---|
| 全量索引 | **4.4s** / 1,865 节点 2,285 边 | 27.6s / 1,457 节点 2,286 边 59 簇 29 流程 | 17.9s / 682 符号 |
| 索引体积 | 4.5 MB | — | 2.1 MB |
| `callers departments()` | 6/6 ✅ | 6/6 ✅ | **0/6 ❌**（KG 只有 CONTAINS/BELONGS_TO，无 CALLS） |
| 定义行号 | 56 ✅ | 55 ❌ | 56 ✅ |
| Blade 调用（44 处） | 0/44 ❌ | 0/44 ❌ | — |
| 非 git 目录 | ✅ | 需 `--skip-git` | ✅ |
| 1 文件增量 | sync 1.9–2.4s ✅ | analyze 17.1s + `detect-changes` ✅ | `status` 报 fresh ❌ |

### vue-app（uni-app）

| 指标 | CodeGraph | GitNexus | ArchNav |
|---|---|---|---|
| 全量索引 | **4.8s** / 5,985 节点 12,380 边 | 65.1s / 6,826 节点 16,895 边 816 簇 | 4.5s / 1,015 符号（DEPENDS_ON 7,495、DEFINES_ROUTE 307） |
| 索引体积 | 17 MB | 102 MB | 3 MB |
| `callers orderTake`（3） | **0/3 ❌** | 2/3 | 崩溃 ❌ |
| `callers getUserInfo`（34） | 2/34 ❌ | 9/34 | 崩溃 ❌ |
| `callers orderPay`（2） | **2/2 ✅** | — | 崩溃 ❌ |

**已定位的三个根因（本计划要治的病）**
1. **嵌套回调丢失**：`orderTake(...)` 写在 `success: (res) => {...}` 里 → CodeGraph 直接判"无调用方"；同一文件里写在方法体的 `orderPay(...)` 它 2/2 全中。
2. **模板层丢失**：Blade `{!! $departmentPresenter->showSelectOptions(...) !!}` 44 处，CodeGraph 与 GitNexus 均为 0。
3. **别名导入未解析**：`import { getUserInfo } from '@/api/user.js'` 未解析成具体文件 → 召回 2/34、9/34。

基准资产（Phase 0 需从 scratch 迁到项目内持久化）：
- `…\cache\scratch\bench\php-app`、`…\bench\vue-app`（含三家的索引目录 + git 仓库）
- `gt_vue.json`、`ground_truth.json`、`groundcheck.py`、`gt_vue.py`（grep ground truth 生成脚本）

---

## 3. 语言与实现载体（决策点 D1，含 "RUSE" 调研结论）

**调研结论：不存在可用的 Ruse 语言。** 逐个核实（GitHub API + 仓库页）：
- `alilleybrinker/ruse` ★62 — "A Scheme embedded in Rust"，嵌入式脚本语言，非编译型系统语言；
- `supercooldave/ruse` ★2 — Rocq/Coq 形式化玩具，139 commits；
- `e3prom/ruse` ★33 — Go 写的红队反代；`JanneM/Ruse` ★24 — 命令行资源测量工具；`rusefi` — 发动机 ECU，无关。
- npm `ruse` = "deploy static apps to s3"；PyPI `ruse` 不存在。

结论：用 Ruse 重构 = 先自造一门语言再自建 tree-sitter 绑定 + MCP SDK + Windows 工具链，收益为零、风险极高。**建议**：

- **D1-a（推荐）**：Rust 内核（解析/建图）+ TypeScript/Node（融合层、CLI、MCP）。理由：CodeGraph 已用 Rust + tree-sitter 证明可行且不需要 C++ 工具链；MCP SDK 与三家的适配器样例都在 TS；现有 ArchNav 是 Node，可渐进迁移。
- **D1-b**：纯 Node/TS，直接 `codegraph`/`gitnexus` 作为外部解析后端（最快出成果，0 内核工作量）。
- **D1-c**：若你的 "Ruse" 是内部私有语言/团队叫法，请给出仓库或规范——本计划的分层边界（§4）与语言无关，只需重写 L1 适配器与 L4 服务端。

---

## 4. 架构（四层，接口先定，实现可换）

```
                ┌──────────────────────── L4 查询/协议层 ────────────────────────┐
                │  locate · read(读盘) · callers · callees · impact · trace ·     │
                │  explore · detect-changes        →  MCP server (单入口)         │
                └───────────────▲─────────────────────────────▲──────────────────┘
                                │  合并/去重/置信度合成          │
                ┌───────────────┴──────────── L3 融合层 (fusion) ────────────────┐
                │ ① 结果归并（同一符号多引擎取并集，按 file:line 去重）           │
                │ ② confidence 合成（ArchNav 渐变分 × 引擎一致度）                │
                │ ③ **Resolver 召回补丁**：Vue 嵌套回调 / Blade 模板 / @ 别名     │
                └───────────────▲─────────────────────────────▲──────────────────┘
                                │                             │
      ┌─────────────────────────┴──────────┐   ┌──────────────┴───────────────────┐
      │ L2 图存储 SQLite(FTS5)             │   │ L1 解析适配器（可插拔）           │
      │ symbols / edges / files / hashes   │◄──│ codegraph(CLI -j) / gitnexus(JSON)│
      │ 读盘校验用的 file hash             │   │ / 自有 resolver（AST 遍历）       │
      └────────────────────────────────────┘   └──────────────────────────────────┘
```

**关键协议（沿用 ArchNav，实测有效，不改）**：图谱只负责带路 → `read` 一律从磁盘读真实代码 → 返回置信度；Agent 只在置信度低时回退 grep。

---

## 5. 里程碑

| Phase | 内容 | 交付物 | 预计 |
|---|---|---|---|
| 0 | 基准与回归 harness 固化（迁出 scratch） | `bench/` + `bench/run_bench.mjs` + ground truth JSON | 0.5 天 |
| 1 | ArchNav 4 个已确认缺陷修复 | 崩溃消失、PHP 有 CALLS 边、status 敏感、同名可消歧 | 1–2 天 |
| 2 | Resolver 召回补丁三件套 | `.vue` 嵌套回调 / Blade 模板 / `@/` 别名 | 2–3 天 |
| 3 | 多引擎融合层 | 结果归并 + 置信度合成 + 去重 | 1–2 天 |
| 4 | MCP 单入口 + Hermes 一键配置 | `fusion mcp` + `fusion install` | 1 天 |
| 5 | 回归跑分 | A1–A10 对照表（改前/改后） | 0.5 天 |

总计约 **6–9 个工作日**（不含 D1-a 的 Rust 内核，内核可后置）。

---

## 6. 任务分解（TDD，每任务 2–5 分钟）

### Phase 0：基准固化

#### Task 0.1：把基准仓迁入项目并去掉三家索引目录
**Files:** 新建 `~/projects/archnav/bench/php-app/`、`bench/vue-app/`
**Steps:**
1. `cp -r "…/cache/scratch/bench/php-app" archnav/bench/php-app`（vue-app 同理），删掉 `.codegraph .gitnexus .archnav`
2. 校验：`find bench -name '*.php' | wc -l` → 286；`-name '*.vue' | wc -l` → 269
3. 提交：`git add bench && git commit -m "test: add php-app/vue-app benchmark fixtures"`

#### Task 0.2：把 ground truth 生成器变成脚本
**Files:** 新建 `bench/gen_ground_truth.mjs`（由 `gt_vue.py` / `groundcheck.py` 移植）
**Step 1（先写断言）:**
```js
// bench/gen_ground_truth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { groundTruth } from './gen_ground_truth.mjs';
test('getUserInfo 的 ground truth 命中 34 个文件 44 处调用', async () => {
  const gt = await groundTruth('vue-app', 'getUserInfo');
  assert.equal(gt.callerFiles.length, 34);
  assert.equal(gt.callSites.length, 44);
});
```
**Step 2:** `node --test bench/gen_ground_truth.test.mjs` → 预期 FAIL（模块不存在）
**Step 3:** 实现正则扫描（排除 `node_modules/.git/.codegraph/.gitnexus/.archnav`，跳过 `function X(` 定义行）
**Step 4:** 重跑 → 预期 PASS（34 / 44）
**Step 5:** 提交 `test: add ground truth harness`

#### Task 0.3：跑分入口
**Files:** 新建 `bench/run_bench.mjs`
对每个引擎执行索引 + 5 条固定查询，输出 Markdown 表（A1–A8 列）。命令：`node bench/run_bench.mjs > bench/report.md`，预期生成 php-app / vue-app 两张表。

---

### Phase 1：修 ArchNav 已知缺陷（与 D1 无关，先做）

#### Task 1.1：修 `callers`/`impact` 崩溃（优先级最高）
**Files:** 改 `~/projects/archnav/src/navigation.js:234`
**Step 1（复现测试）:**
```js
// tests/navigation.imports.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { callers } from '../src/navigation.js';
test('imports 里混入非字符串元素时 callers 不抛异常', async () => {
  const r = await callers({ file: 'bench/vue-app', symbol: 'orderTake', imports: [{ from: './x' }, 'y'] });
  assert.ok(Array.isArray(r));
});
```
**Step 2:** `node --test tests/navigation.imports.test.mjs` → 预期 FAIL：`TypeError: imp.replace is not a function`
**Step 3（最小修复）:** 把该行改为归一化后比较
```js
imports: (otherSym.imports ?? [])
  .map((imp) => String(typeof imp === 'string' ? imp : (imp?.from ?? '')))
  .filter(Boolean)
```
**Step 4:** 重跑测试 → PASS；再跑真机 `node src/index.js callers orderTake`（cwd=`bench/vue-app`）→ 预期不再崩溃
**Step 5:** 提交 `fix: normalize imports entries in navigation.callers`

#### Task 1.2：PHP 建立 CALLS 边（或明确降级）
**Files:** `src/analyzer.js`、新增 `src/langs/php.js`
**Step 1:** 测试 `tests/analyzer.php.test.mjs`：索引 `bench/php-app` 后断言
```js
assert.ok(kg.edges.some(e => e.type === 'CALLS' && e.to.includes('Controller.php')));
```
预期 FAIL（当前只有 CONTAINS/BELONGS_TO）。
**Step 2:** 用 PHP 方法体正则 + 类名/注入属性映射补边：`$this->repository->method(`、`$this->departments(`、`Class::method(`、`(new X)->method(`
**Step 3:** 重跑 → 断言 PASS；`callers departments` 目标 6/6（A2）
**Step 4（降级路径）:** 若 1 小时内做不出可靠类型推断，就**显式标注** PHP 为"符号级只读"，`callers` 返回 `unsupported_language`，避免"返回 none 被当成真没有"——这比错答更安全。
**Step 5:** 提交 `feat(php): emit CALLS edges for method-body calls`

#### Task 1.3：`status` 过期检测
**Files:** `src/confidence.js`、`src/index.js`
**Step 1:** 测试：索引后 `touch`/改写一个文件 → 断言 `status().stale === true`、`confidence < 1`
**Step 2:** 当前预期 FAIL（报 fresh、`Indexed commit: N/A`）
**Step 3:** 以 `fileHashes` 为真值源比对（不依赖 git），mtime+size 快速筛、hash 兜底
**Step 4:** 重跑 → PASS；再用真机验证 `locate allow` 后置信度下降
**Step 5:** 提交 `fix: detect content edits in status/confidence`

#### Task 1.4：同名符号消歧
**Files:** `src/navigation.js`、`src/index.js`
**Step 1:** 测试：`locate getUserInfo` 命中 2 个定义时，返回 `{ambiguous: true, candidates:[...]}` 而非静默取第一个；新增 `--file` 过滤
**Step 2:** 预期 FAIL（当前返回 `api/admin.js`）
**Step 3:** 实现候选列表 + `--file/--kind` 过滤
**Step 4:** 重跑 → PASS
**Step 5:** 提交 `feat: disambiguate duplicate symbols with --file/--kind`

---

### Phase 2：Resolver 召回补丁（本计划的核心价值）

#### Task 2.1：别名导入解析（`@/x/y.js` → 真实文件）
**Files:** 新增 `src/resolver/alias.js`
**Step 1:** 测试：
```js
assert.equal(resolveAlias('@/api/user.js', { root: 'bench/vue-app' }), 'api/user.js');
assert.equal(resolveAlias('@/api/user', { root: 'bench/vue-app' }), 'api/user.js'); // 补扩展名
```
**Step 2:** 预期 FAIL → **Step 3:** 读 `jsconfig/tsconfig.paths`（缺失则用 `@/`→`./` 默认约定），返回仓库相对路径
**Step 4:** PASS → **Step 5:** 提交

#### Task 2.2：`.vue` SFC 方法体 + 嵌套回调调用抽取
**Files:** 新增 `src/resolver/vue-sfc.js`
**Step 1:** 测试（用真实文件）：
```js
const calls = extractVueCalls('bench/vue-app/pages/goods/order_details/index.vue');
assert.ok(calls.some(c => c.callee === 'orderTake' && c.enclosing === 'success@1316'));
```
**Step 2:** 预期 FAIL → **Step 3:** 解析 `<script>` 段，遍历 `methods`/对象字面量，递归进入箭头函数与函数表达式（这正是 CodeGraph 的盲区），记录最内层包围函数 + 行号
**Step 4:** PASS → **Step 5:** 提交 `feat(resolver): capture calls nested in .vue callbacks`

#### Task 2.3：Blade 模板调用抽取
**Files:** 新增 `src/resolver/blade.js`
**Step 1:** 测试：
```js
const calls = extractBladeCalls('bench/php-app/views/analyses/member.blade.php');
assert.equal(calls.length, 3); // groupPresenter/hospitalPresenter/departmentPresenter
```
**Step 2:** 预期 FAIL → **Step 3:** 匹配 `{!! $var->method(`、`{{ $var->method(`、`@if($v->m(`，并把 `$var` 绑到控制器 `compact('var' => Presenter)` 的注入（`ViewComposers` 兜底）
**Step 4:** PASS；对 `showSelectOptions` 目标文件级 ≥ 18/20（A3）
**Step 5:** 提交 `feat(resolver): extract Blade template call sites`

#### Task 2.4：把 resolver 结果并入图存储
**Files:** `src/analyzer.js`、图 schema 加 `edge.source_kind`（`ast`/`template`/`heuristic`）
**Step 1:** 测试：索引后 `callers showSelectOptions` 返回 ≥ 40 条且 `source_kind==='template'`
**Step 2:** FAIL → **Step 3:** 合并进 SQLite（`INSERT OR IGNORE`，按 `(from,to,line,type)` 去重）
**Step 4:** PASS → **Step 5:** 提交

---

### Phase 3：多引擎融合

#### Task 3.1：CodeGraph / GitNexus 适配器
**Files:** 新增 `src/engines/codegraph.js`（`codegraph callers X -j`）、`src/engines/gitnexus.js`（`gitnexus context X -r <repo>`，注意多仓索引必须带 `-r`）
**验收：** 两个适配器的 `callers()` 都返回统一 `{symbol, callers:[{file,line,enclosing,engine}]}`；单测用固定 JSON 回放，不打真机。

#### Task 3.2：归并 + 置信度合成
**Files:** `src/fusion.js`
规则：并集去重（键 `file:line`）→ 一致性加权（两引擎同报 +，仅一引擎报且 `source_kind==='heuristic'` −）→ 输出 `confidence`（沿用 ArchNav 渐变 0–100）。
**验收：** `callers orderTake` 3/3（A4）、`getUserInfo` ≥ 32/34（A5）、误报 ≤ 5%（A6）。

#### Task 3.3：`read` 永远读盘
**验收：** 索引后改写文件，`read <symbol>` 返回新内容（此项现已通过，加回归测试防退化）。

---

### Phase 4：MCP 单入口 + Hermes 接入

- Task 4.1：`src/mcp-server.js` 暴露 8 个工具（locate/read/callers/impact/trace/explore/status/analyze），删掉重复代理工具，控制工具数量（token 预算：每个工具描述 ≤ 40 词）
- Task 4.2：`fusion install` 写 Hermes MCP 配置（参考 CodeGraph `codegraph install --print-config` 的写法，`--print-config` 先行、幂等）
- Task 4.3：验收：Hermes 里 `mcp list` 能看到 fusion；一次 `callers` 往返 ≤ 1.5s

---

### Phase 5：回归跑分

- Task 5.1：`node bench/run_bench.mjs` 生成改前/改后对照表（A1–A10）
- Task 5.2：把结果写回 `skills/software-development/archnav/references/comparison.md`

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| GitNexus 许可（PolyForm Noncommercial） | 商用侵权 | 只调用其 CLI/MCP 输出，不复制代码；工具许可靠自有 + CodeGraph(MIT) |
| 模板/动态语言召回永远做不到 100% | 误以为"没人调用"而误删代码 | 输出必须带 `source_kind` 与置信度；低置信度强制 `read`/grep 复核；PHP 不可靠时显式返回 unsupported |
| 多引擎结果冲突 | Agent 被误导 | 归并以 AST 证据优先，heuristic 降权；冲突时两条都给出并标 engine |
| Windows 工具链 | 装不上 | Rust 内核只用 tree-sitter 预编译；CI 加 Windows 矩阵 |
| 索引体积增长（GitNexus 102MB） | 磁盘/迁移成本 | 只保留 SQLite 单文件 + FTS5；不落 packfile 式冗余 |
| 维护成本（三家上游都会变） | 适配器腐烂 | 适配器只解析 JSON（不打屏），版本探测 + 固定回放测试 |
| 遥测默认开（CodeGraph） | 隐私 | 首次运行 `codegraph telemetry off` 写进安装脚本 |

---

## 8. 开放问题（需你拍板）

- **D1 语言**：Rust 内核 + TS 融合层（推荐）／纯 TS 只做融合层／你确有内部 Ruse（给仓库或规范）。
- **D2 依赖形态**：调用外部 `codegraph` CLI（快，但用户需另装）／把解析内核 vendor 进本项目（体积大，许可 MIT 可 vendor）。
- **D3 GitNexus 是否保留**：仅作可选后端（推荐）／完全不依赖（召回会掉，实测 orderTake 2/3 就是它贡献的）。
- **D4 首个落地语言优先级**：先治 PHP+Laravel+Blade（你的主力栈）还是先治 Vue（uni-app，本次数据更差）。

---

## 9. 验证方式（每次都跑同一套）

```bash
cd ~/projects/archnav
node --test tests/                                  # 单测全绿
node src/index.js analyze bench/php-app             # A1/A7/A8
node src/index.js callers departments               # A2 = 6/6
node src/index.js callers showSelectOptions         # A3 ≥ 40/44
node src/index.js analyze bench/vue-app
node src/index.js callers orderTake                 # A4 = 3/3
node src/index.js callers getUserInfo               # A5 ≥ 32/34
node bench/run_bench.mjs > bench/report.md          # 全量对照表
```

对每条查询，用 `bench/gen_ground_truth.mjs` 现算的 grep 集合做分母，人工不得手改数字（A6 误报率同源计算）。
