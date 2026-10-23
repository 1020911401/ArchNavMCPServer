# ArchNav MCP Server

> **Architecture-aware code navigation — plus a diff-scoped review layer.**
> Line-level precision · architecture layers · gradient staleness · evidence on every answer · 10 fused MCP tools · 1 review checklist

[English](#english) | [中文](#chinese)

---

<a name="english"></a>

## 🇬🇧 English

ArchNav builds a knowledge graph of your repo and answers the questions agents get
wrong — *where is this symbol, who calls it, what breaks if I change it, what did my
diff just touch, which rules does it break, which tests must run* — with **evidence
attached to every answer**. Nothing in the pipeline requires a third-party binary.

- **Native engine** — 12-language AST parsing (zero native compilation), line-level
  symbol location, architecture-layer detection, gradient confidence scoring, and a
  `read` that always re-reads from disk.
- **Recall layer for what plain ASTs miss** — Blade template calls (Laravel), alias
  imports (`@/…`), calls nested inside Vue/JS callbacks, Laravel routes, and the
  uni-app page/component layer. Every edge carries `source_kind` (`ast` / `template` /
  `callback` / `route` / `navigation` / `component` / `heuristic`) plus a confidence,
  so consumers can down-weight guesses.
- **Diff-driven change impact** — `changes` maps a git diff (unstaged / staged / all /
  vs a base) to the symbols it touches and everything that breaks. **Untracked files
  count as changed** — that is exactly where an assistant's new files land. Without git
  it falls back to content drift and says so in a `note`.
- **Graph-only impact** — `impact` walks real `DEPENDS_ON` edges backwards, never
  guessing from filenames: a controller method surfaces its route, a component method
  surfaces the pages that render it. Every row carries `depth` / `via` / `source_kind` /
  `confidence`.
- **Review layer (diff-scoped)** — 61 rules for PHP/Laravel, JS/Vue/uni-app, Python and Go,
  plus a file-local taint tracker, an OSV dependency audit and an optional Semgrep pass for
  interprocedural taint,
  a front/back API-boundary check, affected-test selection, block-level duplication
  against a baseline, and one checklist that lists what was checked *and* what was
  skipped and why. See [the review pipeline](#-review-pipeline) and
  [`docs/review-rules.md`](docs/review-rules.md).
- **Optional external engines — cross-check only** — the **CodeGraph** and **GitNexus**
  adapters remain available for comparison (an explicit `engine`, or `engine: auto` in
  MCP), but **nothing in the pipeline requires them**: the default engine is ArchNav's
  own graph, and the local deep ops below cover flows / clusters / risk / cross-repo.
  `bench/` keeps the measured three-way comparison as *evidence*, not as a runtime
  dependency.

### 🚧 Local deep ops, and the boundary they must respect

Four things this project once delegated to GitNexus (`flows`, `clusters`, `risk
grading`, `cross-repo groups`) are now implemented locally — a CI pipeline cannot
depend on a third-party binary that needs a C++ toolchain. They are kept only under
these five constraints, and each is enforced by code rather than intent:

1. **Off by default** — they live behind `--mode deep` or an explicit `--impact` /
   `--deep` / `--duplication` flag; the default `brief` mode never builds them.
2. **Evidence or nothing** — every deep row carries `depth` / `via` / `source_kind` /
   `confidence`; flow steps coming from unbound placeholders or `heuristic` edges are
   dropped instead of reported (measured: they dominated the first Laravel run — 40
   steps, mostly `find` / `all` / `update` noise).
3. **Repo-level standing conditions never fail a build** — module risk and dependency
   cycles are `warn`, with every factor listed; blocking is opt-in via
   `--module-max-risk` / `--impact-max-risk`. Only change-scoped defects gate `--gate`.
4. **Gate thresholds are calibrated on measured cases** — the new-clone gate sits at 6
   because a legitimate rule-table addition produced 4 *renamed* clones, while the
   genuine incident (a verbatim 13-line copy) produced 1 *exact* clone.
5. **Deletable in isolation** — the review path imports them lazily and works without
   them; `scripts/selftest.mjs` asserts the default output carries no deep group.

Not done, on purpose: `Cypher queries` (product surface) and `PDG / taint data-flow`
(needs a real SSA front end — cross-function taint is delegated to Semgrep). Dependency
vulnerabilities stay out of the rule table: they are pre-existing state, not this change's
defect — `--audit` (on in `deep`, off in CI) reports them as warn/info, and gating is
opt-in via `--fail-on-cve`.

### 🔍 Review pipeline

One command, one checklist. Everything is diff-scoped, every finding carries `why` +
`evidence`, and the costs below are measured on a three-file diff.

```bash
# the cheap path (default): high-signal rules, findings only, compact JSON
node scripts/review-rules.mjs . --scope staged

# the full sheet before a PR
node scripts/review-rules.mjs . --scope compare --base main \
  --mode standard --markdown review.md --sarif review.sarif --gate

# repo-level depth (monthly / architecture review)
node scripts/review-rules.mjs . --mode deep --deep-cluster-level symbols

# front-end ↔ back-end API boundary
node scripts/review-rules.mjs <front-repo> --backend <backend-repo> --scope staged

# which tests does this change actually reach?
node scripts/test-select.mjs . --scope staged
```

| mode | what it adds | measured cost |
|---|---|---|
| `brief` (default) | high-signal rules, findings only, compact JSON | 1.5 KB ≈ **0.5 K tokens** |
| `standard` | full task sheet + 影响面 (entry points, blast radius, explainable risk) + duplication | 10.2 KB ≈ 3.4 K |
| `deep` | + repo-level flows / clusters / cycles / module risk | 11.6 KB ≈ 3.9 K |

Explicit `--impact` / `--deep` / `--duplication` flags upgrade the output automatically;
`--all-rules` re-enables the context rules that fire on half of a legacy repo
(`js-loose-equality` hits 160/333 files — opt-in by design); `--compact` / `--no-compact`
control the JSON payload; `--no-checklist` prints findings only.

**Item-by-item confirmation:** `--json --no-compact` is a machine-readable task sheet
(`checklist.rows` + `findings` with `why`/`evidence`). `scripts/kanban-review.mjs` pushes it
onto a Hermes Kanban board — one card per hit, confirmed one by one
(`complete` / `block` / `archive` / `comment`), then `status --gate` reads the verdicts back
and fails while any error/warn item has no conclusion. Waived items go back into the
pipeline via `waivers` → `--waivers <file>`, which **refuses a waiver with no reason** and
reports matched-nothing entries as stale. See [docs/kanban-review.md](docs/kanban-review.md).

Two optional engines the checklist reports honestly:

- **`--audit` / `--no-audit`** — dependency vulnerabilities via OSV (npm / Packagist / Go /
  requirements). `deep` turns it on, CI turns it back off (`--no-audit`) so a network hiccup
  can never fail a build; the row says what could not be scanned (missing lockfile,
  unpinned range, OSV error) instead of passing silently. `--fail-on-cve high|critical`
  turns it into a gate.
- **`--semgrep`** — interprocedural taint, from the real engine. Resolution order is
  `$SEMGREP_BIN` → `semgrep` on PATH → the console scripts the active python reports
  (a `pip --user` install lands in a Scripts dir that is **not** on PATH) → `python -m
  semgrep` (refused by semgrep ≥ 1.38, hence last). When nothing is usable the row is
  `➖ taint.semgrep` *with the reason* — never a silent pass.

**The task sheet** renders every rule as `✅ 通过` / `⚠️ 命中(N)` / `➖ 不适用(+原因)`,
then groups the analysis:

```
📋 审核任务书 — <repo>
   改动文件 9（PHP 0 / 前端 8 / 其他 1）　索引 5783 符号　后端索引 未提供
   规则 54 条：✅ 通过 20　⚠️ 命中 12　➖ 不适用 22
   栈 node（依据 package.json）　改动 .mjs×5 .yml×1 .md×1
   ── 结构 ── ✅ backup-file-changed …   ── PHP·安全 ── ➖ 不适用 —— 本次没有 PHP 改动
   ── 影响面 ──   ── 重复代码 ──   ── 代码库深查 ──
```

**Stack detection** decides which analyzers are worth running, with evidence:
`package.json` → `node`; `composer.json` + route nodes → `laravel`; `pages.json` + page
nodes → `uni-app`. A front-end repo without a backend index gets an actionable hint —
*“加 `--backend <后端仓>` 可做接口边界核对”* — instead of a silent gap.

**Gates** — `--gate` (error-severity findings only), `--dup-max-new-clones N` (only
clones *this* change introduces, against a jscpd baseline), `--impact-max-risk`,
`--module-max-risk` (both opt-in; see boundary constraint #3).

**Outputs** — SARIF 2.1.0 for GitHub code scanning (every result is validated to carry
a location), `::error file=…,line=…` annotations for the job log, and a markdown task
sheet used as the PR comment / step summary.

**CI** — [`.github/workflows/review.yml`](.github/workflows/review.yml) runs on pull
requests (diff against the base branch) and on pushes (`--base HEAD~1`, so the pushed
commit is really reviewed): fixture-independent unit tests → `analyze` → `selftest` →
the task sheet in `--mode deep` → step summary → SARIF upload → PR comment → artifacts.

**Self-check** — `node scripts/selftest.mjs` builds a throwaway git repo containing
every stack the layer knows, injects real defects, and verifies the designed behaviours
end to end, printing ✅/❌ with the evidence it used.

### ✨ Core features (measured on two real fixtures)

Laravel 286 PHP + 76 Blade; uni-app 269 Vue + 64 JS — harness and raw numbers in
[`bench/README.md`](bench/README.md).

| Feature | ArchNav | GitNexus | CodeGraph |
|---------|---------|----------|-----------|
| Line-level navigation (file:line) | ✅ **exact** | ✅ (±1 line) | ✅ |
| Read-before-edit verification | ✅ **re-reads disk on every `read`** | ❌ graph-only | ⚠️ only on `explore` |
| Blade / template call sites | ✅ **40 sites** | ❌ 0 | ❌ 0 |
| Vue/JS calls nested in callbacks | ✅ **3/3 real call sites** | ⚠️ 2/3 | ❌ 0 |
| Alias imports (`@/api/user.js`) | ✅ **28–31 of 32 caller files** | ⚠️ 9/32 | ⚠️ 1/32 |
| Laravel route → controller edges | ✅ **155 edges** | ❌ | ⚠️ route detection only |
| uni-app pages/components layer | ✅ **126 pages, 313 nav, 451 component edges** | ❌ | ❌ |
| `.vue` SFC symbol extraction | ✅ **3,610 extra symbols** | — | ✅ |
| Diff → symbols → blast radius | ✅ **1 file → 2 symbols → 6 direct + 7 indirect** | ✅ `detect-changes` | ⚠️ `affected` (test files only) |
| Depth-2 recall on structured hops | ✅ **routes 1/1, component pages 5/5** | ⚠️ pages 0/5 | ⚠️ pages 0/5, no depth labels |
| Gradient staleness (content drift) | ✅ **per-symbol, fileHashes as truth source** | binary | ✅ file watch |
| Repo-level depth (flows, clusters, risk, cross-repo) | ✅ local, off by default (see boundary) | ✅ | ⚠️ partial |
| MCP tools | **10** (single fused entry) | 17 | 1 exposed + hidden |
| Languages | **12** + SFC/template/route layers | JS/TS + C++ build | 20+ (Rust kernel) |
| Windows | ✅ **no toolchain** | ⚠️ query tools crash | ✅ |
| Index time (Laravel / uni-app) | **3.3s / 13.0s** | 23.0s / 45.4s | 7.7s / 16.6s |
| License | **MIT** | PolyForm Noncommercial | MIT |

### 🚀 Quick start

```bash
git clone https://github.com/1020911401/ArchNavMCPServer.git
cd ArchNavMCPServer && npm install

node src/index.js analyze /path/to/your-project      # build the index
node src/index.js analyze . --ignore "bench/**,**/vendor/**"   # keep fixtures/vendored code out
node src/index.js locate "getOrderById"              # symbol → file:line + confidence
node src/index.js arch                               # architecture layers
node src/index.js callers "showSelectOptions" \
     --file app/Presenters/DepartmentPresenter.php   # who calls it (--file disambiguates)
node src/index.js impact "departments"               # blast radius, depth-labelled
node src/index.js read "calculateOrderTotal"         # the real code, re-read from disk
node src/index.js changes --scope unstaged           # what does my diff break?
node src/index.js version .                          # which version of this repo is this? (git + manifests + index)

node src/mcp-server.js                               # MCP server (Hermes / Claude Code / Cursor)

npm test                                             # unit tests
node scripts/selftest.mjs                            # functional self-check
npm run bench                                        # three-engine head-to-head on the fixtures
```

`changes` scopes: `unstaged` (default) · `staged` · `all` (vs HEAD) · `compare --base main`.
Without git it falls back to content drift versus the index and states that in a `note`;
files that changed but carry no symbol are reported as `unmapped` instead of being
silently dropped.

`version` answers "which version of the *target* code am I looking at", not ArchNav's
own version (`-V`): git HEAD (short + full), branch, exact tag / nearest tag, dirty
worktree with file count, last commit date/author/subject, commit count, the declared
versions in `package.json` / `composer.json` / `pyproject.toml` / `go.mod`, and the
commit the index was built from (with `index vs HEAD: same commit | different commit`
plus content drift). Everything is read-only, each git call is time-boxed, and a
missing git or a non-repo directory degrades to nulls instead of throwing. `--json`
gives the same data for scripts.

### 🏗️ Architecture layers

Detected from directory structure (`controllers/`, `services/`, `repositories/`,
`models/`, `middleware/`, `config/`, `utils/`, …), matched **case-insensitively** — a
real bug once: `RegExp.source` does not carry the `/i` flag, so Laravel's
`app/Http/Controllers`, `app/Models` and `app/Repositories` were never classified and
every PHP repo reported `Layer: null`.

### 🔌 MCP tools (10, single fused entry)

| Tool | Description |
|------|-------------|
| `archnav_locate` | Symbol → exact file:line range + confidence (candidates for same-named symbols) |
| `archnav_read` | Read the real source from disk (verification pattern) |
| `archnav_callers` | Who calls this symbol — this repo's graph by default; `engine=auto` also asks the external CLIs |
| `archnav_changes` | Map a git diff (or content drift) to touched symbols and everything that breaks |
| `archnav_impact` | Direct + indirect impact, every row carrying `depth`/`via`/`source_kind`/`confidence` |
| `archnav_trace` | Shortest call path between two symbols |
| `archnav_explore` | Area/flow exploration; `op` selects the deeper operations (route map, cypher, rename, detect-changes, groups) |
| `archnav_fusion_calls` | Cross-engine call query — `engine: archnav (default) \| codegraph \| gitnexus \| auto` |
| `archnav_status` | Index freshness: content drift, changed files, per-symbol confidence |
| `archnav_analyze` | Build/update the knowledge graph |

### 📁 Project structure

```
├── src/
│   ├── index.js              # CLI entry
│   ├── mcp-server.js         # MCP server (10 fused tools)
│   ├── analyzer.js           # analysis + knowledge graph
│   ├── navigation.js         # navigation, changes, impact, callers
│   ├── reader.js             # disk-read verification
│   ├── confidence.js         # staleness + confidence scoring
│   ├── kgraph.js             # graph queries + HTML export
│   ├── treewalker.js         # JS AST parser (acorn)
│   └── parsers/              # dispatcher + TS / Python / WASM parsers
├── scripts/
│   ├── review-rules.mjs      # 61 rules + task sheet + SARIF / markdown / gates
│   ├── impact.mjs            # entry points, blast radius, explainable risk
│   ├── deep.mjs              # flows, clusters, cycles, module risk, cross-repo
│   ├── duplication.mjs       # jscpd wrapper: clone kinds + baseline gate
│   ├── test-select.mjs       # which tests a change reaches
│   └── selftest.mjs          # functional self-check of all of the above
├── docs/review-rules.md      # the rule handbook
├── bench/                    # fixtures + three-engine comparison harness
└── .github/workflows/review.yml
```

### 🛠️ Requirements

- **Node.js** 18+
- **Python** 3.10+ (optional, for `.py` parsing)
- **jscpd** (optional, for `scripts/duplication.mjs` — fetched via `npx`)
- **CodeGraph / GitNexus** (optional, cross-check only — never required)

---

<a name="chinese"></a>

## 🇨🇳 中文

ArchNav 为仓库建知识图谱，回答 Agent 最容易答错的问题 —— *符号在哪、谁调用它、改它会炸哪里、
我这次 diff 动了什么、破了哪些规则、该跑哪些测试* —— **每条结论都带证据**，而且管道里
**没有任何环节依赖第三方二进制**。

- **原生引擎**：12 语言 AST 解析（零原生编译）、行级符号定位、分层架构识别、渐变置信度；
  `read` 永远重新从磁盘读。
- **AST 看不到的召回层**：Blade 模板调用、`@/…` 别名导入、写在 Vue/JS 回调里的调用、
  Laravel 路由、uni-app 页面/组件层；每条边带 `source_kind` 与置信度。
- **diff 驱动的变更影响**：`changes` 把 git diff 映射到符号与受影响面；**未跟踪文件也算改动**
  （AI 新增文件正是未跟踪）；没有 git 时退回内容漂移并显式写进 `note`。
- **纯图谱影响分析**：`impact` 沿真实 `DEPENDS_ON` 边反向走，不靠文件名猜；每行带
  `depth` / `via` / `source_kind` / `confidence`。
- **审核层（diff 范围）**：61 条规则覆盖 PHP/Laravel、JS/Vue/uni-app、Python、Go；文件内污点
  追踪 + OSV 依赖漏洞审计（`--audit`，`deep` 默认开）+ 可选 Semgrep 跨函数污点；前后端接口
  边界核对；受影响测试选择；块级重复 + 基线门禁；一张清单同时列出**查过什么、跳过什么、为什么**。
- **外部引擎降级为交叉验证**：CodeGraph / GitNexus 适配器仍在（显式 `engine`，或 MCP 的
  `engine: auto`），但**默认引擎是 ArchNav 自己的图谱**，管道不依赖它们。

### 🚧 本地深查的边界（五条，全部由代码强制）

原来交给 GitNexus 的四件事（流程 / 聚类 / 风险分级 / 跨仓）现在本地实现，但只在以下约束内保留：

1. **默认关** —— 只在 `--mode deep` 或显式 `--impact/--deep/--duplication` 下构建；默认
   `brief` 模式根本不生成。
2. **无证据不报** —— 每条深查结果带 `depth/via/source_kind/confidence`；来自 heuristic 边或
   无行号占位符的流程步直接丢弃（实测：不过滤时 Laravel 首跑 40 步大半是 `find/all/update` 噪声）。
3. **仓库级既有状态永不单独拦构建** —— 模块风险/循环依赖只作 `warn` 并列出每个因子；要拦必须
   显式 `--module-max-risk` / `--impact-max-risk`。
4. **门禁阈值必须有实测标定** —— 新克隆门禁设在 6：合法规则表新增产生 4 个 *renamed* 克隆，
   而真正的事故（逐字复制 13 行）是 1 个 *exact* 克隆。
5. **可单独删除** —— 审核主路径 lazy import，删掉不影响主流程；自测断言默认输出不含深查分组。

**明令不做**：`Cypher 查询`（产品面：语法/文档/注入面，`--json` 对 agent 够用）、
`PDG/污点数据流`（需要真 SSA 前端，编出来的边会污染所有下游数字 —— 跨函数污点外包给 Semgrep）。
依赖漏洞不进主规则表：它是**既有状态**不是本次改动，走 `--audit`（`deep` 默认开、CI 用
`--no-audit` 关掉），命中只作 warn/info，要拦必须显式 `--fail-on-cve`。

### 🔍 审核层：一条命令，一张清单

| 模式 | 内容 | 3 文件 diff 实测成本 |
|---|---|---|
| `brief`（默认） | 只跑高信号规则、只列命中、JSON 自动紧凑 | 1.5 KB ≈ **0.5K tokens** |
| `standard` | 完整任务书 + 影响面 + 重复代码 | 10.2 KB ≈ 3.4K |
| `deep` | 再加代码库深查（流程/聚类/循环/模块风险） | 11.6 KB ≈ 3.9K |

```bash
node scripts/review-rules.mjs . --scope staged                        # 默认省钱路径
node scripts/review-rules.mjs . --scope compare --base main \
  --mode standard --markdown review.md --sarif review.sarif --gate     # PR 前
node scripts/review-rules.mjs <前端仓> --backend <后端仓> --scope staged  # 接口边界
node scripts/test-select.mjs . --scope staged                         # 该跑哪些测试
```

任务书把每条规则渲染成 `✅ 通过 / ⚠️ 命中(N) / ➖ 不适用(+原因)`，再分组给
**影响面**（入口点、爆炸半径、可解释风险）、**重复代码**（exact/renamed/similar/gap 四类克隆）、
**代码库深查**（流程/聚类/循环/模块风险）。**栈检测**用证据决定哪些分析值得跑：
`package.json` → node、`composer.json` + 路由节点 → laravel、`pages.json` + 页面节点 → uni-app；
前端仓没给后端索引时会提示 *“加 `--backend <后端仓>` 可做接口边界核对”*。

**门禁**：`--gate`（只看 error 级）、`--dup-max-new-clones N`（只算本次新引入的克隆，基于 jscpd 基线）、
`--impact-max-risk` / `--module-max-risk`（都要显式开）。
**逐项审核确认（接项目管理）**：`--json --no-compact` 产出机器可读任务书（`checklist.rows` +
带 `why`/`evidence` 的 `findings`），`scripts/kanban-review.mjs push` 把它灌进 Hermes Kanban ——
每条命中一张卡，逐项 `complete`（✅确认）/ `block`（⛔驳回）/ `archive`（➖豁免）/ `comment`（证据），
`status --gate` 回读结论，未确认的 error/warn 项直接 exit 1；全部条目有结论后收口卡才可完成。
看板上判为误报的条目可 `waivers` 导出成 `--waivers <file>` 的豁免清单回流（**没有理由的豁免不生效**，
匹配不到的按失效报出，被摘掉的进 `waived[]` 可审计）。
见 [docs/kanban-review.md](docs/kanban-review.md)。
**产物**：SARIF 2.1.0（可上 GitHub code scanning）、`::error file=…,line=…` 注解、markdown 任务书
（用作 PR 评论 / Step Summary）。CI 在 PR 与 push 两类事件上都跑（push 用 `--base HEAD~1`，
让推送的提交真的被审一遍）。

### 📊 三方对比：实测数字

两个 fixture、三个引擎（`bench/multi_dim.mjs` + `bench/deep_recall.mjs`，完整表格见
[`bench/README.md`](bench/README.md)）：

| 维度 | ArchNav | CodeGraph | GitNexus |
|------|---------|-----------|----------|
| 索引（Laravel / uni-app） | **3.3s / 13.0s** | 7.7s / 16.6s | 23.0s / 45.4s |
| callers | **5/5** | 2/5 | 3/5 |
| trace | **2/2** | 无此命令 | 无此命令 |
| 架构层 | **7 / 3 层** | 无层模型 | 无层模型 |
| 深度 2 召回（路由 / 组件页面） | **1/1 · 5/5** | 1/1 · 0/5 | 1/1 · 0/5 |
| 仓库级深查（流程/聚类/风险/跨仓） | ✅ 本地实现、默认关 | ⚠️ 部分 | ✅ |

这份对比是**证据**（说明差别在哪），不是运行依赖；CI 不需要安装对照引擎。

### 🛠️ 系统要求

- **Node.js** 18+
- **Python** 3.10+（可选，`.py` 解析）
- **jscpd**（可选，`scripts/duplication.mjs` 用，走 `npx`）
- **CodeGraph / GitNexus**（可选，仅交叉验证，永不必需）

---

### 📄 License

MIT
