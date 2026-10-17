# ArchNav MCP Server

> **Architecture-Aware Code Navigation** — Line-level precision · Architecture-layer awareness · Confidence-based staleness · Fused MCP entry (10 tools)

[English](#english) | [中文](#chinese)

---

<a name="english"></a>

## 🇬🇧 English

ArchNav is an **architecture-aware code navigation** system for AI agents (Hermes, Claude Code, Cursor, Codex). It builds a knowledge graph of your repo and answers the questions agents actually get wrong — *where is this symbol, who calls it, what breaks if I change it, what did my diff just touch* — with evidence attached to every answer.

- **Native engine** — 12-language AST parsing (zero native compilation), line-level symbol location, layered-architecture detection, gradient confidence scoring, and a `read` that always re-reads from disk.
- **Recall layer for what plain ASTs miss** — Blade template calls (Laravel), alias imports (`@/…`), calls nested inside Vue/JS callbacks, Laravel routes, and the uni-app page/component layer. Every edge carries `source_kind` (`ast` / `template` / `callback` / `route` / `navigation` / `component` / `heuristic`) plus a confidence, so consumers can down-weight guesses.
- **Diff-driven change impact** — `changes` maps a git diff (unstaged / staged / all / vs a base ref) to the symbols it touches and everything that breaks; without git it falls back to the index's content-drift signal and says so.
- **Graph-only impact** — `impact` walks real `DEPENDS_ON` edges 1–2 hops backwards (no filename guessing): a controller method surfaces its route, a component method surfaces the pages that render it.
- **Fused multi-engine** — optional adapters for **CodeGraph** and **GitNexus**; `callers` / `fusion_calls` fan out to `auto | codegraph | gitnexus | archnav` and merge, deduplicate and re-score the results.

### 🚧 Local deep ops, and the boundary they must respect

Four things this project originally delegated to GitNexus (`flows`, `clusters`, `risk
grading`, `cross-repo groups`) are now implemented locally — a CI pipeline cannot
depend on a third-party binary that needs a C++ toolchain. They are kept only under
these five constraints, each of which is enforced by code, not by intent:

1. **Off by default** — they live behind `--mode deep` or an explicit `--impact` /
   `--deep` / `--duplication` flag; the default `brief` mode never builds them
   (`MODE_PRESETS`, and brief mode filters the findings before rendering).
2. **Evidence or nothing** — every deep row carries `depth` / `via` / `source_kind` /
   `confidence`; flow steps that come from unbound placeholders or `heuristic` edges
   are dropped rather than reported (measured: they dominated the first Laravel run).
3. **Repo-level standing conditions never fail a build** — module risk and cycles are
   reported as `warn` with every factor listed; blocking is opt-in via
   `--module-max-risk` / `--impact-max-risk`. Only change-scoped defects gate `--gate`.
4. **Gate thresholds are calibrated on measured cases** — e.g. the new-clone gate sits
   at 6 because a legitimate rule-table addition produced 4 *renamed* clones while the
   genuine incident (a verbatim 13-line copy) produced 1 *exact* clone.
5. **Deletable in isolation** — the review path imports them lazily and works without
   them; `scripts/selftest.mjs` asserts that the default output contains no deep group.

**Still not done, on purpose:** `Cypher queries` (a query language is a product
surface with its own grammar, docs and injection surface — `--json` covers agent use)
and `PDG / taint data-flow` (needs a real SSA front end; edges we cannot evidence
would poison every number built on top — use Semgrep taint for that instead).

### 🔍 Review pipeline (diff-scoped)

The same index powers a review layer that answers *what did this change touch, which
rules does it break, which tests must run, how risky is it* — one command, one checklist:

```bash
node scripts/review-rules.mjs . --scope staged \
  --impact --deep --duplication --dup-kinds renamed,similar \
  --markdown review.md --sarif review.sarif --gate
```

- **Modes** — `--mode brief` (default: high-signal rules only, findings only, compact
  JSON — ~0.5 K tokens for a three-file diff), `--mode standard` (full task sheet,
  ~3.4 K), `--mode deep` (+ repo-level flows/clusters/module risk, ~3.9 K). Explicit
  `--impact` / `--deep` / `--duplication` flags upgrade the output automatically;
  `--all-rules` re-enables the context rules (`js-loose-equality` and friends fire on
  hundreds of files in a legacy repo, so they are opt-in), `--compact` / `--no-compact`
  control the JSON payload, `--no-checklist` drops the sheet entirely.
- **Task sheet** — 40 rules rendered as 通过 / 命中(N) / 不适用(+原因), plus 影响面
  (entry points, blast radius, explainable risk), 重复代码 (exact/renamed/similar/gap
  clone kinds) and 代码库深查 (flows, clusters, cycles, module risk). `--json` for tooling.
- **Gates** — `--gate` (error-severity findings), `--impact-max-risk`,
  `--module-max-risk`, `--dup-max-new-clones` (only clones *this* change introduces,
  measured against a jscpd baseline).
- **Outputs** — SARIF 2.1.0 for GitHub code scanning, `::error file=…,line=…`
  annotations for the job log, and a markdown task sheet for the PR comment /
  step summary.
- **Test selection** — `node scripts/test-select.mjs . --scope staged` lists the tests
  the change actually reaches (graph edges, depth ordered, uncovered symbols named).
- **Self-check** — `node scripts/selftest.mjs` exercises 25 designed behaviours on a
  throwaway repo and prints ✅/❌ with the evidence it used.

CI runs the whole thing on pull requests and pushes: [`.github/workflows/review.yml`](.github/workflows/review.yml).

### ✨ Features

Measured on two real fixtures (Laravel 286 PHP + 76 Blade; uni-app 269 Vue + 64 JS) — see [`bench/README.md`](bench/README.md) for the harness and raw numbers.

| Feature | ArchNav | GitNexus | CodeGraph |
|---------|---------|----------|-----------|
| Line-level navigation (file:line) | ✅ **exact** | ✅ (±1 line) | ✅ |
| Read-before-edit verification | ✅ **re-reads disk on every `read`** | ❌ graph-only | ⚠️ only on `explore` |
| Blade / template call sites | ✅ **40 sites found** | ❌ 0 | ❌ 0 |
| Vue/JS calls nested in callbacks | ✅ **3/3 real call sites** | ⚠️ 2/3 | ❌ 0 |
| Alias imports (`@/api/user.js`) | ✅ **28–31 of 32 caller files** | ⚠️ 9/32 | ⚠️ 1/32 |
| Laravel route → controller edges | ✅ **155 edges** | ❌ | ⚠️ route detection only |
| uni-app pages/components layer | ✅ **126 pages, 313 nav, 451 component edges** | ❌ | ❌ |
| `.vue` SFC symbol extraction | ✅ **3,610 extra symbols** | — | ✅ |
| Diff → symbols → blast radius (`changes`) | ✅ **1 file → 2 symbols → 6 direct + 7 indirect** | ✅ `detect-changes` (+ flows, risk grade) | ⚠️ `affected` (test files only) |
| Depth-2 recall on structured hops | ✅ **routes 1/1, component pages 5/5** | ⚠️ routes yes, component pages 0/5 | ⚠️ routes yes, component pages 0/5, no depth labels |
| Graph-only impact (depth 1–2 with evidence) | ✅ `depth`/`via`/`source_kind` on every row | ✅ processes/clusters | ⚠️ blast radius |
| Gradient staleness (content drift, not just commits) | ✅ **per-symbol, fileHashes as truth source** | binary | ✅ file watch |
| Deep codebase analysis (flows, clusters, risk grade, cross-repo) | ❌ | ✅ **best in class** | ⚠️ partial |
| MCP protocol tools | **10** (single fused entry) | 17 | 1 exposed + hidden |
| Languages | **12** + SFC/template/route layers | JS/TS + C++ build | 20+ (Rust kernel) |
| Windows compatibility | ✅ **all tools work, no toolchain** | ⚠️ query tools crash | ✅ |
| Index time (Laravel / uni-app fixtures) | **3.3s / 13.0s** | 23.0s / 45.4s | 7.7s / 16.6s |
| License | **MIT** | PolyForm Noncommercial | MIT |

### 🚀 Quick Start

```bash
# 1. Clone & install
git clone https://github.com/1020911401/ArchNavMCPServer.git
cd ArchNavMCPServer
npm install

# 2. Analyze your project
node src/index.js analyze /path/to/your-project

# 3. Navigate
node src/index.js locate "getOrderById"                    # symbol → file:line + confidence
node src/index.js arch                                      # architecture layers
node src/index.js callers "showSelectOptions" \
        --file app/Presenters/DepartmentPresenter.php       # who calls it (--file disambiguates same names)
node src/index.js impact "departments"                      # direct + indirect blast radius
node src/index.js read "calculateOrderTotal"                # the real code, re-read from disk
node src/index.js changes --scope unstaged                  # what does my current diff break?

# 4. Start the MCP server (Hermes / Claude Code / Cursor)
node src/mcp-server.js

# 5. Tests & benchmark
npm test                # node --test
npm run bench           # 3-engine head-to-head on the bundled fixtures
```

### 🏗️ Architecture Detection

ArchNav automatically detects 8 architecture layers from your codebase's directory structure:

```
src/controllers/  → API (Controller)   — Express routes, REST handlers
src/services/     → Business (Service)  — Business logic, orchestrators
src/repositories/ → Data (Repository)   — Database access
src/models/       → Model/Validation    — Schemas, validators
src/middleware/    → Middleware          — Auth, logging, error handling
src/config/       → Configuration       — App settings
src/utils/        → Utilities           — Shared helpers
```

### 🔌 MCP Tools (10, single fused entry)

| Tool | Description |
|------|-------------|
| `archnav_locate` | Locate a symbol → exact file:line range + confidence (returns candidates for same-named symbols) |
| `archnav_read` | Read the real source from disk (verification pattern) |
| `archnav_callers` | Who calls this symbol — graph edges + fused CodeGraph/GitNexus results |
| `archnav_changes` | Change impact: map a git diff (or content drift) to the touched symbols and everything that breaks |
| `archnav_impact` | Direct + indirect impact, every row carrying `depth`/`via`/`source_kind`/`confidence` |
| `archnav_trace` | Shortest call path between two symbols |
| `archnav_explore` | One-shot area/flow exploration; `op` selects the deeper engine operations (route map, cypher, rename, detect-changes, cross-repo groups, …) |
| `archnav_fusion_calls` | Cross-engine call query — `engine: auto \| codegraph \| gitnexus \| archnav` |
| `archnav_status` | Index freshness: content drift, changed files, per-symbol confidence |
| `archnav_analyze` | Build/update the knowledge graph |

### 🧠 Impact With Evidence

```
$ node src/index.js impact departments
💥 Impact Analysis: departments
   File: app/Http/Controllers/Controller.php:56

   🔴 Direct impact (will break):
      member   → app/Http/Controllers/AnalysesController.php:191
      create   → app/Http/Controllers/CustomersController.php:108
      transfer → app/Http/Controllers/MiniBookingsController.php:133
      listing  → app/Http/Controllers/PatientsController.php:198

   🟡 Indirect impact (may break):
      GET /analysis/member     → routes/web.php:98     ← route → controller edge
      GET customer/create      → routes/web.php:94
      index                    → app/Http/Controllers/PatientsController.php:92
```

### 🔀 What Does My Diff Break?

```
$ node src/index.js changes --scope unstaged
🔀 Change impact — 1 file(s) changed via git diff (unstaged)

   📝 Changed symbols:
      Controller (class) → app/Http/Controllers/Controller.php:13 50%
      departments (function) → app/Http/Controllers/Controller.php:56 50%

   🔴 Direct impact (6) — will break:
      member → app/Http/Controllers/AnalysesController.php:191
      transfer → app/Http/Controllers/MiniBookingsController.php:133
      …

   🟡 Indirect impact (7) — may break:
      GET /analysis/member → routes/web.php:98 (depth 2, via member) [route] 80%

   ⚪ Changed but unmapped (1) — no symbol covers these lines:
      views/home/index.blade.php
```

Scopes: `unstaged` (default) · `staged` · `all` (vs HEAD) · `compare --base main`.
Without git it falls back to content drift vs the index and states that in a
`note`; unchanged-but-unmapped files are reported instead of silently dropped.

### 📊 Comparison: measured, not claimed

Both fixtures, all three engines, via `bench/multi_dim.mjs` + `bench/deep_recall.mjs`
(full tables in [`bench/README.md`](bench/README.md)):

| dimension | ArchNav | CodeGraph | GitNexus |
|-----------|---------|-----------|----------|
| index (Laravel / uni-app) | **3.3s / 13.0s** | 7.7s / 16.6s | 23.0s / 45.4s |
| locate | 4/4 | 4/4 | 4/4 (needs `-f`, ±1 line) |
| callers | **5/5** | 2/5 | 3/5 |
| impact | 2/2 (depth-labelled) | 2/2 (flat) | 2/2 |
| read | 2/2 | 2/2 | 2/2 (`context --content`) |
| trace | **2/2** | no command | no command |
| arch layers | **7 / 3 layers** | no layer model | no layer model |
| status | 1.6s | 3.3s | **0.95s** |
| depth-2 recall (routes / component pages) | **1/1 · 5/5** | 1/1 · 0/5 | 1/1 · 0/5 |

Where GitNexus still wins and ArchNav does not compete: execution flows,
community clusters, change-risk grading, cross-repository groups, Cypher queries,
PDG data flow. Those stay reachable through the fused entry.

### 📁 Project Structure

```
├── src/
│   ├── index.js              # CLI entry (17 commands)
│   ├── mcp-server.js         # MCP Server (10 fused tools)
│   ├── analyzer.js           # Code analysis + knowledge graph
│   ├── navigation.js         # Navigation commands
│   ├── reader.js             # Disk-read verification
│   ├── confidence.js         # Staleness + confidence scoring
│   ├── kgraph.js             # Knowledge graph queries + HTML export
│   ├── treewalker.js         # JS AST parser (acorn)
│   └── parsers/
│       ├── dispatcher.js     # Unified parser router
│       ├── typescript.js     # TypeScript parser
│       ├── python.js         # Python parser (ast module)
│       └── wasmParser.js     # Go/Rust/Java/PHP/C/C++/C#/Ruby/Bash/PowerShell
├── scripts/
│   ├── py_ast_parser.py      # Python AST helper
│   └── register-mcp.sh       # MCP registration script
└── package.json
```

### 🛠️ Requirements

- **Node.js** 18+ (for native JS/WASM parsers)
- **Python** 3.10+ (optional, for Python file parsing)
- **GitNexus** (optional — enables the fused engines) `npm install -g gitnexus`

---

<a name="chinese"></a>

## 🇨🇳 中文

ArchNav 是一个**架构感知的代码导航系统**，为 AI 编程助手（Hermes、Claude Code、Cursor、Codex）设计。它为仓库建知识图谱，专门回答 Agent 真正容易答错的问题：*这个符号在哪、谁调用它、改它会炸哪里、我刚改的 diff 动了什么* —— 每条答案都带证据。

- **原生引擎** —— 12 语言 AST 解析（零原生编译）、行级符号定位、分层架构识别、渐变置信度；`read` 永远重新从磁盘读。
- **AST 看不到的召回层** —— Laravel Blade 模板调用、`@/…` 别名导入、写在 Vue/JS 回调里的调用、Laravel 路由、uni-app 页面/组件层。每条边带 `source_kind`（`ast` / `template` / `callback` / `route` / `navigation` / `component` / `heuristic`）与置信度，使用方可按需降权。
- **diff 驱动的变更影响** —— `changes` 把 git diff（未暂存 / 已暂存 / 全部 / 对比某个基线）映射到被改到的符号，以及因此受影响的一切；没有 git 时退回索引的内容漂移信号，并明确说明。
- **纯图谱影响分析** —— `impact` 沿真实 `DEPENDS_ON` 边反向走 1–2 跳（不靠文件名猜）：控制器方法能上溯到路由，组件方法能上溯到渲染它的页面。
- **多引擎融合** —— 可选接入 **CodeGraph** 与 **GitNexus**；`callers` / `fusion_calls` 支持 `engine: auto | codegraph | gitnexus | archnav`，并做合并、去重、重新打分。GitNexus 懒启动，只有深查操作（流程/聚类/风险分级）才需要它。

### ✨ 功能亮点

以下数字来自两个真实仓库实测（Laravel 286 PHP + 76 Blade；uni-app 269 Vue + 64 JS），跑分方法与原始数据见 [`bench/README.md`](bench/README.md)。

| 特性 | ArchNav | GitNexus | CodeGraph |
|------|---------|----------|-----------|
| 行级导航 (file:line) | ✅ **精确** | ✅（差 1 行） | ✅ |
| 改代码前读真码验证 | ✅ **每次 read 都读盘** | ❌ 纯图谱 | ⚠️ 仅 explore 时重读 |
| Blade / 模板层调用点 | ✅ **找到 40 处** | ❌ 0 | ❌ 0 |
| 回调里的 Vue/JS 调用 | ✅ **3/3 真实调用点** | ⚠️ 2/3 | ❌ 0 |
| 别名导入（`@/api/user.js`） | ✅ **32 个调用方文件中了 28–31** | ⚠️ 9/32 | ⚠️ 1/32 |
| Laravel 路由 → 控制器边 | ✅ **155 条** | ❌ | ⚠️ 仅路由识别 |
| uni-app 页面/组件层 | ✅ **126 页面 / 313 跳转 / 451 组件边** | ❌ | ❌ |
| `.vue` 单文件组件符号 | ✅ **多抽 3610 个符号** | — | ✅ |
| diff → 符号 → 影响面（`changes`） | ✅ **1 文件 → 2 符号 → 6 直接 + 7 间接** | ✅ `detect-changes`（另带流程与风险分级） | ⚠️ `affected`（只算测试文件） |
| 深度 2 召回（结构化跳） | ✅ **路由 1/1、组件页面 5/5** | ⚠️ 路由可以、组件页面 0/5 | ⚠️ 路由可以、组件页面 0/5，且无深度标注 |
| 纯图谱影响分析（1–2 跳带证据） | ✅ 每行带 `depth`/`via`/`source_kind` | ✅ 流程/聚类 | ⚠️ blast radius |
| 渐变过期检测（内容漂移，不只看 commit） | ✅ **每符号，fileHashes 为真值源** | 二进制 | ✅ 文件监听 |
| 代码库级深查（流程/聚类/风险分级/多仓） | ❌ | ✅ **这类它最强** | ⚠️ 部分 |
| MCP 工具数 | **10**（单入口、融合） | 17 | 1 个对外 + 隐藏 |
| 支持语言 | **12 种** + SFC/模板/路由层 | JS/TS + C++ 编译 | 20+（Rust 内核） |
| Windows 兼容 | ✅ **全功能、免工具链** | ⚠️ 查询崩溃 | ✅ |
| 索引耗时（Laravel / uni-app fixture） | **3.3s / 13.0s** | 23.0s / 45.4s | 7.7s / 16.6s |
| 许可 | **MIT** | PolyForm Noncommercial | MIT |

### 🚀 快速开始

```bash
# 1. 克隆安装
git clone https://github.com/1020911401/ArchNavMCPServer.git
cd ArchNavMCPServer
npm install

# 2. 分析项目
node src/index.js analyze /path/to/your-project

# 3. 导航
node src/index.js locate "getOrderById"                    # 符号 → 文件:行号 + 置信度
node src/index.js arch                                      # 架构层
node src/index.js callers "showSelectOptions" \
        --file app/Presenters/DepartmentPresenter.php       # 谁调用了它（同名符号用 --file 消歧）
node src/index.js impact "departments"                      # 直接 + 间接影响
node src/index.js read "calculateOrderTotal"                # 真实代码（从磁盘重读）
node src/index.js changes --scope unstaged                  # 当前 diff 会弄坏什么？

# 4. 启动 MCP Server（Hermes / Claude Code / Cursor）
node src/mcp-server.js

# 5. 测试与跑分
npm test                # node --test
npm run bench           # 三引擎在自带 fixture 上的同台跑分
```

### 🏗️ 架构检测

ArchNav 自动从目录结构检测 8 层架构：

```
src/controllers/  → API (Controller)   — Express 路由、REST 处理器
src/services/     → Business (Service)  — 业务逻辑、编排器
src/repositories/ → Data (Repository)   — 数据库访问
src/models/       → Model/Validation    — 模式、校验器
src/middleware/    → Middleware          — 认证、日志、错误处理
src/config/       → Configuration       — 应用配置
src/utils/        → Utilities           — 共享工具函数
```

### 🔌 MCP 工具（10 个，单入口）

| 工具 | 说明 |
|------|------|
| `archnav_locate` | 定位符号 → 精确 文件:行号 + 置信度（同名多定义会返回候选列表） |
| `archnav_read` | 从磁盘读真实代码（验证模式） |
| `archnav_callers` | 谁调用了它 —— 图谱边 + 融合 CodeGraph/GitNexus 的结果 |
| `archnav_changes` | 变更影响：把 git diff（或内容漂移）映射到被改到的符号及受影响的一切 |
| `archnav_impact` | 直接 + 间接影响，每行带 `depth`/`via`/`source_kind`/`confidence` |
| `archnav_trace` | 两符号之间的最短调用路径 |
| `archnav_explore` | 一次调用完成区域/流程探索；`op` 参数选择更深层的引擎操作（route map、cypher、rename、detect-changes、跨仓库组等） |
| `archnav_fusion_calls` | 跨引擎调用查询 —— `engine: auto \| codegraph \| gitnexus \| archnav` |
| `archnav_status` | 索引新鲜度：内容漂移、变更文件、每符号置信度 |
| `archnav_analyze` | 构建/更新知识图谱 |

### 🧠 带证据的影响分析

```
$ node src/index.js impact departments
💥 Impact Analysis: departments
   File: app/Http/Controllers/Controller.php:56

   🔴 Direct impact (will break):
      member   → app/Http/Controllers/AnalysesController.php:191
      transfer → app/Http/Controllers/MiniBookingsController.php:133
      listing  → app/Http/Controllers/PatientsController.php:198

   🟡 Indirect impact (may break):
      GET /analysis/member     → routes/web.php:98     ← 路由 → 控制器边
      GET customer/create      → routes/web.php:94
```

### 🔀 我这次改动会弄坏什么？

```
$ node src/index.js changes --scope unstaged
🔀 Change impact — 1 file(s) changed via git diff (unstaged)

   📝 Changed symbols:
      Controller (class) → app/Http/Controllers/Controller.php:13 50%
      departments (function) → app/Http/Controllers/Controller.php:56 50%

   🔴 Direct impact (6) — will break:
      member → app/Http/Controllers/AnalysesController.php:191
      transfer → app/Http/Controllers/MiniBookingsController.php:133
      …

   🟡 Indirect impact (7) — may break:
      GET /analysis/member → routes/web.php:98 (depth 2, via member) [route] 80%

   ⚪ Changed but unmapped (1) — no symbol covers these lines:
      views/home/index.blade.php
```

范围参数：`unstaged`（默认）· `staged` · `all`（对 HEAD）· `compare --base main`。
没有 git 时退回「索引 vs 磁盘内容漂移」判断，并写进 `note` 明确告知；改了但没被任何符号覆盖的文件会列在 `unmapped` 里，而不是被静默丢掉。

### 📊 三方对比：实测数字，不是宣称

两个 fixture、三个引擎，由 `bench/multi_dim.mjs` + `bench/deep_recall.mjs` 测出（完整表格见 [`bench/README.md`](bench/README.md)）：

| 维度 | ArchNav | CodeGraph | GitNexus |
|------|---------|-----------|----------|
| 索引（Laravel / uni-app） | **3.3s / 13.0s** | 7.7s / 16.6s | 23.0s / 45.4s |
| locate | 4/4 | 4/4 | 4/4（需 `-f`，行号差 1） |
| callers | **5/5** | 2/5 | 3/5 |
| impact | 2/2（带深度标注） | 2/2（扁平） | 2/2 |
| read | 2/2 | 2/2 | 2/2（`context --content`） |
| trace | **2/2** | 无此命令 | 无此命令 |
| 架构层 | **7 / 3 层** | 无层模型 | 无层模型 |
| status | 1.6s | 3.3s | **0.95s** |
| 深度 2 召回（路由 / 组件页面） | **1/1 · 5/5** | 1/1 · 0/5 | 1/1 · 0/5 |

GitNexus 仍然赢、ArchNav 有意不比的：执行流程、社区聚类、变更风险分级、跨仓库组、Cypher 查询、PDG 数据流 —— 这些通过融合入口照旧可用。

### 📁 项目结构

```
├── src/
│   ├── index.js              # CLI 入口（17 个命令）
│   ├── mcp-server.js         # MCP Server（10 个融合工具）
│   ├── analyzer.js           # 代码分析 + 知识图谱
│   ├── navigation.js         # 导航命令
│   ├── reader.js             # 磁盘读取验证
│   ├── confidence.js         # 过期检测 + 置信度打分
│   ├── kgraph.js             # 知识图谱查询 + HTML 导出
│   ├── treewalker.js         # JS AST 解析器 (acorn)
│   └── parsers/
│       ├── dispatcher.js     # 统一解析器路由
│       ├── typescript.js     # TypeScript 解析器
│       ├── python.js         # Python 解析器 (ast 模块)
│       └── wasmParser.js     # Go/Rust/Java/PHP/C/C++/C#/Ruby/Bash/PowerShell
├── scripts/
│   ├── py_ast_parser.py      # Python AST 辅助脚本
│   └── register-mcp.sh       # MCP 注册脚本
└── package.json
```

### 🛠️ 系统要求

- **Node.js** 18+ (用于原生 JS/WASM 解析器)
- **Python** 3.10+ (可选，用于 Python 文件解析)
- **GitNexus** (可选 —— 融合引擎所需) `npm install -g gitnexus`

---

### 📄 License

MIT
