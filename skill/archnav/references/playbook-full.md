---
name: archnav
description: Use when navigating or reviewing code with ArchNav. Layers, change impact, Vue/PHP review rules, test selection, FE/BE boundary, repo-level deep analysis (flows/clusters/risk).
version: 1.5.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [code-navigation, code-review, vue, php, laravel, uni-app, mcp, sarif, flows, clustering, risk-scoring]
    related_skills: [github-code-review, test-driven-development, systematic-debugging]
---

# ArchNav Skill

> **v1.5.0** — 新增 `archnav version <dir>`（目标仓版本：git HEAD/branch/tag/dirty、manifest 版本、索引建于哪个 commit）；自审与假阳性清单拆到 `references/self-review.md`（正文 27k → 23k 字符）。
> **v1.4.0** — 自审流程（`git add -N` 纳入未跟踪文件、先 `analyze` 再审、`--no-compact` 才可 triage）、六类"拿原始文本当代码"的假阳性、降噪四项（自审 25 → brief 模式 1 条）。
> **v1.3.0** — 看板逐项确认 / 豁免回流 / harness probe 评测回路。

## When to Use

- 在不熟悉的仓库里定位符号 / 看架构分层 → `locate` / `read` / `arch` / `whereami`
- 评审一个 diff、评估改动爆炸半径（含路由/页面层）→ `changes` / `impact`
- 要跑「Vue/PHP 容易犯的问题」规则、接 CI 门禁 → `scripts/review-rules.mjs`
- 想知道这次改动**该跑哪些单测** → `scripts/test-select.mjs`
- 核对前后端接口边界（前端在调、后端有没有这条路由）→ `review-rules.mjs --backend <后端仓>`
- **仓库级深查：执行流程 / 模块聚类 / 风险分级 / 多仓接口** → `scripts/deep.mjs`
- 规则清单、实测真值、坑位覆盖度、边界与设计取舍 → `references/code-review.md`（合并了原来的三份审核类文档）

ArchNav is a code navigation system designed for AI agents. Uses **acorn AST parser** (pure JS, tree-sitter quality, zero native dependencies). It provides **architecture-level awareness** (not just symbol-level) and enforces a **"navigate via graph, modify via code"** verification pattern.

## Core Principles

1. **图谱是索引，不是副本** — 图谱只负责"带路"（定位文件和行号）
2. **修改代码前必须读真实代码** — `read` 命令直接从磁盘读，不依赖图谱
3. **每符号都有置信度** — 渐变 0-100%，AI 根据分值决定是否验证
4. **架构感知** — 自动推断分层架构（API → Service → Repository），不仅仅是符号搜索

## CLI Commands

```bash
# Analysis
archnav analyze [dir] --ignore <globs>  # 分析代码库，构建架构知识图谱
                                          # --ignore: gitignore-ish 逗号分隔 glob（裸名/ */**/?），walker
                                          # 遇到就跳过 + 图谱建完后 pruneIgnored 再清一次节点/边；
                                          # 同时落盘到 _raw + 顶层，so status 不把被忽略的文件当新增

# Architecture navigation
archnav arch [dir]              # 展示架构地图（注意：目录是**位置参数**，不接受 --dir）
archnav status [dir]            # 索引新鲜度状态
archnav version [dir]           # **目标仓**的版本信息：git HEAD/branch/tag/dirty + 清单版本 + 索引建于哪个 commit
                               # （`-V` 是 ArchNav 自己的版本；这个命令回答「我看的是哪一版代码」）

# Symbol navigation (行级精度)
archnav locate <name>           # 定位符号：文件 + 起始行 + 结束行 + 置信度
archnav read <name>             # 从磁盘读取符号的实际代码（验证模式）
archnav calls <name>            # 这个符号调用了什么
archnav callers <name>          # 谁调用了这个符号（同名多定义加 --file）

# Trace & impact
archnav trace <from> <to>       # 最短调用路径追踪（含架构层跨越）
archnav impact <symbol>         # 影响分析（直接/间接影响 + 测试文件；同名多定义加 --file）
archnav changes [dir]           # diff 驱动的变更影响（--scope unstaged|staged|all|compare）

# Position
archnav whereami <file> [line]  # 指定文件行号属于哪个符号/层
```

### `changes` — 变更影响分析（GitNexus `detect-changes` 的对应物）

```bash
node src/index.js changes [dir] --scope unstaged|staged|all|compare [--base main] [--json]
```

管道：`git diff --unified=0` 解析出每个文件的新侧行区间 → 取 `[line_start, line_end]` 与区间重叠的符号（`getIndex` 的 `symbols`）→ 对每个被改符号跑 `graphImpact(depth 2)` → 合并去重（保留最小 depth），每条带 `from_changed`，且**不会把被改符号自己列为自己的受影响项**。输出分开：`changed_symbols` / `direct_impact` / `indirect_impact` / `affected_routes` / `affected_pages` / `unmapped_files`。

实测（Laravel fixture 的 git 副本，改 `departments()` 方法体内一行）：1 文件 → 符号 `[Controller, departments]` → 6 直接 + 7 间接（其中 5 条是路由）。同一 diff 下 GitNexus `detect-changes` 的符号集合一致，额外给 2 条执行流程 + 风险分级（ArchNav 没有这两个概念）。

实际踩过的坑：
- **`analyze()` 不落盘**：字节流只在 CLI 里调 `saveIndex(dir, result._raw || result)`。在测试/脚本里调 `analyze()` 后必须自己 `saveIndex`，否则 `getIndex()` 回 null，`changes` 报 `No index`。
- **索引里的文件名是反斜杠**（`app\Console\X.php`），`git diff` 是正斜杠 —— 不归一化就一条都映射不上。
- **纯删除 hunk 在新侧没有行号**（`+c,0`），要锛在接缝处（`[c,c]`），否则整个删除改动会被丢掉。
- **无 git 时退回内容漂移**（`checkStaleness().changedDetails`），行区间未知 → 整文件当改动；必须在 `note` 里写明，不能静默。
- **非法 `--scope` / `compare` 缺 `--base` 必须报错**，不能静默退化成漂移回退（那等于换了个问题回答）。
- fixture 仓要 `.gitignore` 掉 `.archnav/`，否则 `git add -A` 会把 7839 行的 `index.json` 带进 diff；曾因此让 GitNexus 报「未检测到变更」（两次 30s 超时后降级假阴）。

MCP 侧对应 `archnav_changes`（工具数 9 → 10，`tests/engines/mcp-tools.test.mjs` 的 `EXPECTED_TOOLS` 需同步）。

## 与代码审核 / 单元测试结合（2026-10-16 实测）

完整规则清单、每条规则的真值、坑位覆盖度、边界与设计取舍 → `references/code-review.md`。三个脚本：

| 脚本 | 干什么 | 单测 |
|---|---|---|
| `scripts/review-rules.mjs` | Vue/PHP 易犯问题 + 前后端边界；`--gate` / `--json` / `--sarif out.sarif` / `--github` | `tests/review-rules.test.mjs`（37 条）|
| `scripts/duplication.mjs` | 块级重复/克隆（包装 jscpd 5.4.1）；`--kind exact,renamed,similar,gap` / `--changed [--baseline X]` / `--max-new-clones N` / `--max-percent P` / `--sarif` | `tests/duplication.test.mjs`（7 条）|
| `scripts/test-select.mjs` | 这次改动该跑哪些测试；`--gate` | `tests/test-select.test.mjs`（7 条）|
| `src/index.js changes` | diff → 已改符号 + 直接影响/间接影响/路由/页面 | `tests/changes.test.mjs` |

```bash
node scripts/review-rules.mjs . --scope staged --gate                       # PR 门禁
node scripts/review-rules.mjs . --duplication --markdown review.md           # 规则+重复一张清单（PR 评论 / Step Summary）
node scripts/review-rules.mjs . --backend ../backend --scope staged          # 前后端边界
node scripts/review-rules.mjs . --sarif review.sarif --github                # SARIF + 工作流注解
node scripts/test-select.mjs . --scope staged --json                         # 只跑相关单测
npm test                                                                     # 全套件 160 run / 158 pass / 2 skipped
```

规则层实测：`php-route-unknown-action`（error，路由指向不存在的方法）、`backup-file-changed`、`php-blade-unverified-calls`（18 处调用 / 0 绑定）、`vue-page-not-registered`（178 个页面 .vue 里 52 个未注册）、`vue-nav-unknown-page`、`vue-component-orphan`、`vue-global-blast`、`fe-be-pairing-suspect` 等。

前后端边界**先算匹配率再逐条比对**：两个不是一对的仓（两个不相干的仓）匹配率 0.0%，只报一条 `fe-be-pairing-suspect`，不刷 39 条假 404；后端路由来自 `knowledgeGraph` 的 `route:` 节点（method/uri/controller/action）。

安全 / 性能也有一套内容级规则（只扫改动文件）：`php-raw-sql-interpolation`、`php-dangerous-function`、`php-debug-left-on`、`php-hardcoded-secret`、`php-unvalidated-mass-input`、`php-n-plus-one`、`php-unbounded-query`、`js-dangerous-function`、`vue-v-html`、`js-innerhtml`、`vue-vfor-missing-key`。实测分布与**安全边界声明**（无污点分析、依赖漏洞不在此层、密钥召回有限、性能只有静态启发式）→ `references/code-review.md` §2「误报防护」与 §4「GAP」。

三条现代审核原则已落入工具：**只看 diff 的爆炸半径**（`changes`）、**每条结论带 why+evidence**（不是“建议重构”而是“`VisitsController` 确实没有 `create()`”）、**可机器门禁 + 可进 PR 界面**（`--gate` 退出码 / SARIF 2.1.0 / `::error file=…,line=…` 注解）。

**代码审核**：`changes` 就是审核入口——`git diff` → 已改符号（带置信度）→ 直接/间接受影响 → 路由/页面层，产出的就是 PR 评论/审核清单该有的东西。实测（Laravel fixture，改 `departments()` 方法体内一行、干净 diff）：

```
📝 Changed symbols: Controller (class) 50%, departments (function) 50%
🔴 Direct impact (6): AnalysesController::member, CustomersController::create …
🟡 Indirect impact (7): GET /analysis/member → routes/web.php:98 (depth 2, via member) [route] 80% …
🛣️  Affected routes (5)
```

- 置信度 50% ⇒ 索引已落后于工作区，**先 `read` 真代码再评审**（验证模式）。
- CI/预提交：`archnav changes . --scope staged --json`（PR 用 `--scope compare --base main`）；`unmapped_files` 是“改了但没有符号”的文件，必须人工看。
- 非 git 目录会退化成内容漂移并**显式打 note**（“line ranges unknown, whole files are treated as changed”）——不要把这份结果当行级证据。

**单元测试**：`impact` 的 `suggested_tests` **不能直接用**——它是“索引里所有文件名含 test/spec 的文件”，与符号无关（实测查 `checkStaleness` 时列出 14/16 个测试文件）。真正的映射在图谱里就已经有了（测试文件 → 符号的 `DEPENDS_ON` 边），所以加一层过滤即可。

`scripts/test-select.mjs`（2026-10-16 新增，配 `tests/test-select.test.mjs` 7 条单测）：

```bash
node scripts/test-select.mjs . --scope unstaged        # 本次改动要跑哪些测试
node scripts/test-select.mjs . --scope staged --json   # 机器读
node scripts/test-select.mjs . --gate                  # 有“改动但零覆盖”的符号 → exit 1
```

它在 `changes()` 结果上做：受影响的测试文件（按 depth 排序，depth 1 = 直接 import）× 改动的测试文件 ∪，并逐符号列出覆盖它的测试、点名 `uncovered_symbols`。实测：改 `normalizeRel` → `tests/confidence.test.mjs`（唯一真值 importer，4 pass）；改 `checkStaleness` → 5 个（1 个 depth 1 + 4 个 depth 2，都真的经 navigation/CLI 走到它）；改 `parsePythonFile` → 0 个 + `--gate` exit 1（真值：无测试引用 `parsers/python.js`）。

> 与 `impact` 的 `suggested_tests` 对比：14 个 → 1~5 个。选择依据是图谱边，不是文件名；`--gate` 让"这版改动需要补测试"变成可自动化的门禁。

### 逐项审核确认（接 Hermes Kanban / 项目管理）

`--json --no-compact` 才是机器可读任务书（`checklist.rows` + 带 `why`/`evidence` 的 findings）；
`scripts/kanban-review.mjs push|status` 把它变成看板上的逐项确认卡（每条命中一张卡，
`complete`(✅确认) / `block`(⛔驳回) / `archive`(➖豁免) / `comment`(证据)，`status --gate` 回读结论）。
完整说明、字段约定与实测输出 → 仓库 `docs/kanban-review.md`。四条必须记住的坑：

- **默认 `--json` 是压缩摘要**（无 checklist/why/evidence），入板前必须 `--no-compact`。该 flag 曾经失效：
  `applyMode` 只在 `compactFlag === null` 时跟随 preset，而初始值 `compact: true` 胜出 → 永远关不掉（已修）。
  回归：brief=紧凑 / deep=完整 / `--compact`/`--no-compact` 双向都能覆盖。
- **依赖方向必须是「条目 → 收口卡」**。反过来死锁：kanban 要求父任务先完成，子任务才能 complete，
  CLI 报 `cannot complete t_…: unsatisfied parent dependencies`，于是每一条确认项都完不成。
  ⚠️ API 与 CLI 不一致：`complete_task()` 对未满足父依赖的任务**静默不改状态**（返回 True、状态仍 todo），
  只有 CLI 会报错——脚本里别拿返回值当成功。
- **`hermes kanban create` 实测 ~13s/次**（每次都要 import 整个 agent，16 张卡 3~4 分钟）→ 批量走单进程
  `scripts/kanban_review_batch.py`（直接 `hermes_cli.kanban_db.create_task`，同一 DB、同一幂等语义），16 张卡 3.2s。
- **`hermes kanban list --json` 不返回 idempotency_key** → 批次分组只能用 `tenant`（= 任务书内容指纹），
  门禁依据只能用 `priority`（error 3 / warn 2 / info 0）。

看板是本机的，CI runner 写不到 `kanban.db`：这一层是本地/agent 侧闭环（评审前 push → 逐项确认 → 门禁），
CI 侧继续用 `review-rules.mjs --gate` + SARIF，两者不冲突。

**豁免回流（`--waivers <file>`）**：看板 `archive` 的条目 → `kanban-review.mjs waivers --out x.json` →
`review-rules --waivers x.json` 不再重复报。三条硬规矩：**没有 reason 的豁免不生效**（否则豁免文件就是无痕静音器）、
**匹配不到的报 stale**（规则/行号漂了要重审）、**摘掉的 finding 进 `waived[]`**（理由/确认人/卡号，进 json/markdown/控制台）。
匹配键 = rule + 归一化 file + line（`line: null` = 该规则该文件全豁免）。
两个连带的坑：① 豁免后要 `buildChecklist({findings, meta})` **重建规则行**，否则出现「行写命中(1)、findings 里一条没有」；
② 豁免连 SARIF 与 `--gate` 一起吃（这是语义），所以豁免文件本身要跟 PR 一起 review，不能藏进 CI 变量。
CI 接入：`if [ -f review-waivers.json ]; then WAIVER_ARGS="--waivers review-waivers.json"; fi`，文件不在就保持原门禁行为。
单测 `tests/review-waivers.test.mjs` 7 条钉住上述规矩。

### Modes — 默认 brief，按需升级

同一套规则层支持三种输出档位，避免每次审核都吞 3-4 K tokens：

- **`brief`（默认）**：只跑高信号规则（`core` tier），findings 仅列命中项，JSON 自动 compact。本仓 3 文件 diff 实测 ≈1.5 KB / ~0.5 K tokens。
- **`standard`**（`--standard`）：完整任务书 + 影响面 + 重复代码（~10 KB / ~3.4 K）。
- **`deep`**（`--mode deep`）：standard + 代码库深查（流程/聚类/模块风险）（~12 KB / ~4 K）。

升级路径：显式 `--impact` / `--deep` / `--duplication` 会自动带上任务书（要分析却把清单藏掉才反直觉）；`--no-checklist` 仍然能关掉清单。**`--audit` / `--no-audit` 管依赖漏洞审计（OSV）**：`deep` 预设默认开，CI 加 `--no-audit`（网络问题只能变成 `➖ deps.osv`，永不 fail 构建）；**`--semgrep` 的查找顺序是 `$SEMGREP_BIN` → PATH → python 报出的 console scripts 目录（pip --user 装的位置不在 PATH，解释器自己的 Scripts 目录里没有）→ `python -m semgrep`（≥1.38 直接拒绝运行）**，跑不起来时任务书写 `➖ taint.semgrep` + 退出码/stderr 首行，绝不写 pass。`--all-rules` 把扩展规则（`js-loose-equality`、`php-loose-comparison`、`js-debug-left-on` 等 context 类规则）拉回来，**这些规则在遗留仓里是噪声**——本仓实测 `js-loose-equality` 160/333 文件触发、`php-loose-comparison` 34/286，单独跑会刷几百条 info 淹掉真正要看的 findings。`--compact` / `--no-compact` 控制 JSON payload。

## Harness probe — 把「改 harness」变成可归因实验（2026-10-21 落地）

评审层本身就是 harness（preset / tier / knobs / 阈值 / 豁免文件）。两个命令构成评测回路：

```bash
node scripts/review-rules.mjs . --scope unstaged --json --no-compact --harness-out harness.json
node scripts/probe.mjs . --scope unstaged \
  --variant "brief=" --variant "standard=--standard" --variant "deep=--mode deep --no-audit" \
  --out probe.json --markdown probe.md          # npm run probe 等价
```

- **manifest**（`review.json.harness`）：`preset` / 解析后 `knobs` / 启用规则集 sha256 前 16（`rules.ruleset`）/ `explicitFlags` / `index.commit` / `model:null`。没有它，改前改后无法归因，probe 全是噪声。
- **probe 的 key 是 `rule|file|归一化 message`**：去掉 `:12`、`L41`、`第 7 行`，但**保留计数**（“18 处调用”→“19 处”是真变化，行号不是）。行号变化单列 `lineDrift`，永不计入 added。不这么做就会拿自己的编辑当发现（实测：改两行 → 8 条假新增，1817→1819）。
- **死旋钮 vs 诚实 no-op**：manifest 除 `explicitFlags` 外全同 + findings 也同 = flag 没接线（bug 级）；manifest 变了但 findings 同 = 旋钮生效、此任务无影响（算证据）。`--fail-on-noop` → exit 1。
- 实测（本仓 12 文件 diff）：brief 29 findings / 28.4 KB / 2.4 s；`+all-rules` 31（+3%）；standard 40 / +42% / 10 s（多出的 11 条里 8 条 `duplication-clone`）；deep 41 / 79 规则行 / 7.7 s（再 +1 `deep-module-risk`）。probe 全程零模型调用。
- 抓到的真 bug：`--all-rules` 曾因 `applyMode()` 无条件 `out.tier = preset.tier` 完全失效（与 `--compact` 同族）→ 修法：`allRulesFlag` 参与解析优先级，`applyMode` 里 `opts.allRulesFlag ? 'all' : preset.tier`。
- 单测：`tests/probe.test.mjs`（10 条：key 稳定性 / 漂移 vs 新增 / 死旋钮 / 失败不抛 / 渲染）+ `review-rules.test.mjs` 的 manifest 用例；全套 252 run / 250 pass / 2 skipped。
- **边界（跨会话硬约束）**：probe 只跑本项目或显式传入的仓；证据件只存路径/提交/规则摘要/finding 结构字段，不写客户代码与凭据；不同项目的结果不可混算。详见 `docs/harness-probe.md`。
- **采纳台账**：`--adopt <变体> --lesson "..."` / `--reject ...` / `--list-ledger`，写 `.archnav/harness-ledger.jsonl`（gitignored，本机+本仓）。四条硬规矩：lesson 必填；死旋钮只能 reject；零差异不能 adopt；`ruleset` 不在当前 `{core,all}` 摘要里 → 标 stale 需复核。
- **标签回流**：`npm run labels`（= `scripts/label-stats.mjs`）把看板 ✅/⛔/➖ 换成 per-rule 精确率；`open` 卡不进分母，`n < --min-samples` 不评价，`< --low` 给 `demote-or-waive`。`--suggest-waivers` 只产人工真驳回过的「规则×文件」，形状与 `kanban-review waivers` 同源（同一个 `loadWaivers`）。实测闭环：16 卡 → `unmapped-change` 20% → 豁免接回 review，命中 35→34。
- 红线：豁免是 harness 动作；把规则挪进 `EXTENDED_RULES` 是**代码改动**，必须走单测，不许用精确率绕过测试。

## Architecture Layer Detection

自动检测以下架构层（基于目录结构 + 命名约定）：

| Layer | Pattern | Example |
|-------|---------|---------|
| API (Controller) | `controllers/` | Express routes, REST handlers |
| Business (Service) | `services/` | Business logic, orchestrators |
| Data (Repository) | `repositories/` | Database access |
| Model / Validation | `models/` | Schemas, validators |
| Middleware | `middleware/` | Auth, logging, error handling |
| Configuration | `config/` | App settings |
| Utilities | `utils/` | Shared helpers |

## Confidence Scoring

Confidence = 1.0 - stale_penalty - file_change_penalty - age_penalty

| Confidence | Meaning | AI Action |
|-----------|---------|-----------|
| 1.0 | 新鲜 | 直接使用 |
| 0.5-0.99 | 索引整体过期 | 验证行号后再操作 |
| 0.1-0.49 | 文件本身已变 | 必须读代码确认 |
| 0.0 | 文件不存在 | 用 grep 搜索 |

## Key File: `read` 命令（验证模式核心）

`read` 是 ArchNav 最重要的命令：
1. 用图谱 `locate` 找到符号位置（文件 + 行号范围）
2. **直接从磁盘读文件**（不用图谱缓存）
3. 验证签名是否匹配（调 confidence）
4. 返回真实代码 + line numbers

## Languages: JavaScript (acorn AST), TypeScript/TSX (@typescript-eslint/parser), Python (ast module), Go/Rust/Java (WASM tree-sitter via @vscode/tree-sitter-wasm); **Go 已有语言级规则 3 条**（`go-ignored-error`/`go-panic-in-library`/`go-sql-injection`），已用 cobra + sqlx 两个真实仓对过 grep 真值、自测锁定到 CI。

ArchNav is a Node.js CLI at `~/projects/archnav/`:

```
~/projects/archnav/
├── src/index.js        # CLI entry point (Commander.js)
├── src/analyzer.js     # Code analysis + architecture inference
├── src/navigation.js   # Navigation commands
├── src/reader.js       # Disk read (verification pattern)
├── src/confidence.js   # Staleness + confidence scoring
└── src/comparison.js   # GitNexus/Graphify benchmark
```

## Running

```bash
cd ~/projects/archnav
node src/index.js analyze /path/to/project
node src/index.js locate getOrderById
node src/index.js read calculateOrderTotal --lines

## MCP Server

ArchNav ships as an MCP (Model Context Protocol) server. Run it and connect any MCP-compatible AI agent (Claude Code, Hermes, Cursor, Codex):

```bash
cd ~/projects/archnav && node src/index.js mcp
```

### MCP Tools (10 fused tools)

| Tool | What it does |
|------|-------------|
| `archnav_locate` | Locate a symbol → file:line range + confidence (reports ambiguity) |
| `archnav_read` | Read actual code from disk (verification) |
| `archnav_callers` | Who calls this symbol (graph edges + fused engine results) |
| `archnav_impact` | Blast radius, every row carrying depth/via/source_kind/confidence |
| `archnav_trace` | Shortest call path between two symbols |
| `archnav_explore` | Area/flow exploration; `op` selects the deeper engine operations (route map, cypher, rename, detect-changes, groups) |
| `archnav_fusion_calls` | Cross-engine call query (`engine: auto\|codegraph\|gitnexus\|archnav`) |
| `archnav_status` | Index freshness: content drift + per-symbol confidence |
| `archnav_changes` | diff → changed symbols + direct/indirect impact + routes/pages |
| `archnav_analyze` | Build/update the knowledge graph |

> The old `archnav_arch` / `archnav_calls` entries are gone; use the CLI
> `archnav arch <dir>` and `archnav calls <sym>` (the layer map has no MCP tool).
## MCP Surface (10 tools)

ArchNav MCP 是**单入口 10 个工具**（`tests/engines/mcp-tools.test.mjs` 的
`EXPECTED_TOOLS` 是唯一真值，上限 `MAX_TOOLS = 12`），不是 22 —— 原来的 13 个 `gn_*`
GitNexus 代理工具已折进 `archnav_explore` 的 `op` 参数（route map / cypher / rename /
detect-changes / groups …）：

`archnav_analyze`, `archnav_callers`, `archnav_changes`, `archnav_explore`,
`archnav_fusion_calls`, `archnav_impact`, `archnav_locate`, `archnav_read`,
`archnav_status`, `archnav_trace`.

`archnav_fusion_calls` takes `engine: archnav | codegraph | gitnexus | auto`。**默认 `archnav`**（本仓自己的图谱，不 spawn 任何外部二进制）；`auto` 且显式传入时才并发调外部 CLI 交叉验证。

> **定位（2026-10-17 确认）**：GitNexus / CodeGraph 在本项目里已**降级为可选交叉验证**，不是管道依赖：
> - 审核路径（changes / review-rules / test-select / impact / deep / duplication）**全部只用 ArchNav 自己的索引**，`which gitnexus` 为空也能跑。
> - 原来“要 GitNexus 才能做的四件事”（flows / clusters / risk grading / cross-repo）已在本地实现，并受五条约束：默认关、无证据不报、仓库级状态不单独拦构建、门禁阈值必须实测标定、可单独删除（详见仓库 README 的 “Local deep ops” 段）。
> - `references/comparison.md` 的三方跑分是**证据**（用来说明差别在哪），不是运行依赖；`bench/run_bench.mjs`、`bench/multi_dim.mjs` 等只在做对比时手动跑。
> - 仍不做且不应做：`Cypher 查询`（产品面）、`PDG/污点数据流`（需要真 SSA 前端，编出来的边会污染结论）。

> 早期版本声称“Dual-Engine … 22 MCP tools (9 native + 13 GitNexus proxy)”。已作废：22 个工具的面比它回报的信息更费上下文，所以代理工具合并进 `archnav_explore`。

### Register with Hermes

Add to Hermes config (`~/.hermes/config.yaml` 或 `~/.config/hermes/config.yaml`)：

```yaml
mcpServers:
  archnav:
    command: node
    args: [~/projects/archnav/src/mcp-server.js]
```

## 仓库级深查（`scripts/deep.mjs`）

四件事：流程 / 聚类 / 风险 / 多仓接口。全部本地实现，**默认关**，只在 `--mode deep` 或显式 flag 下构建。

```bash
node scripts/deep.mjs . --flows                       # 路由/页面/命令/队列/监听器 → 调用链
node scripts/deep.mjs . --clusters --cluster-level symbols --top 20
node scripts/deep.mjs . --risk --top 10
node scripts/deep.mjs --repo front=<前> --repo back=<后> --cross
node scripts/deep.mjs . --json --markdown deep.md      # 机器读 / 贴 PR
node scripts/review-rules.mjs . --mode deep            # 四块并进任务书（── 代码库深查 ──）
```

- **流程**：入口是 `route:` / `page:` / `Commands/` / `Jobs/` / `Listeners/`；默认只走有证据的边（heuristic ≤ 0.6 过滤掉，否则 Eloquent 的 `find/all/update` 会把每条路径炸成 40 步噪声）。`--include-heuristic` 可回退。实测 php-app（286 个 PHP 文件）→ **155 条流程**；纯脚本仓没有入口节点 → 显示 `➖ 不适用`，这是正常状态。
- **聚类**：文件级 Louvain；`--cluster-level symbols` 更细也更吵，配 `--top` 用。断开的两个团不会被强行合并。
- **风险**：规模 / 外部耦合 / Tarjan SCC 循环 / 规则 error / 克隆 / 无测试覆盖。它是**仓库级既有状态**，不是本次改动引入的缺陷：`deep-module-risk`、`impact-risk` 常驻 warn，要拦必须显式 `--module-max-risk` / `--impact-max-risk`。
- **多仓**：前端抽 `request.get/post/…('path')`，后端抽 `route:` 节点；匹配率 < 20% 时只打一行警告（「这两个索引很可能不是同一对前后端」）而不是硬编出边 —— 看到这行先怀疑配对，不要当成接口缺失。

**缺口（诚实列明）**：动态调用（`$obj->$method()`、JS 回调间接调用）不解析；跨仓只连 HTTP，消息队列/gRPC/事件总线不连；不做类型推断（凭空造边会毒化所有下游数字）；SCC 是文件级，scripts/tests/bench 之间的正常互 import 也会成环。

**SARIF 上 code scanning 的坑**：本地只生成 JSON，`artifactLocation.uri` 格式错了不会报错；推到 GitHub 才被拒（`SARIF URI scheme "readme.md" did not match the checkout URI scheme "file"`）。只有 PR 事件能真正验证这条路径 —— 改 CI 后至少开一个 PR 跑一遍。


