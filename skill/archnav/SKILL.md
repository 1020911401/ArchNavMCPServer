---
name: archnav
description: Use when navigating or reviewing code with ArchNav — locate/impact/trace, diff-scoped review, test selection, deep analysis. Thin trigger page; long text lives in references/.
version: 1.8.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [code-navigation, code-review, mcp, sarif]
    linked_files: {references: [anchor-review.md, code-review.md, comparison.md, kanban-review.md, playbook-full.md, self-review.md]}
---

# ArchNav (playbook)

> **v1.8.0** — 正文只留 5 条坑（两条 PHP 专项坑挪进 `references/code-review.md`），历史版本见 `references/playbook-full.md`；实测数字由 `npm run verify:numbers` 复测。

ArchNav 是给 agent 用的代码导航 + 评审层：图谱只负责带路（文件/行号），改代码前必须 `read` 真源码。

## When to Use

- 陌生仓定位符号、看分层 → `locate` / `read` / `arch` / `whereami`
- 评审 diff、算爆炸半径 → `changes` / `impact`
- 该跑哪些单测 → `scripts/test-select.mjs`
- 仓库级深查（流程/聚类/风险/多仓）→ `scripts/deep.mjs`
- 逐条签字、留审计链 → `scripts/anchor-review.mjs`（ANCHOR 层）
- 「我看的是哪一版」→ `archnav version <dir>`

## 五个必须先知道的坑

1. **`.archnav/` 会把自己算成改动**：没忽略时一次单文件改动被列成 3 个改动文件（多出 `.archnav/index.json`、`.archnav/commit`，都映射不到符号）。接手任何仓先把它写进 `.gitignore`。未跟踪的新文件**不用** `git add -N` —— `changes` 已经算了；但 `--scope staged` 只含「已暂存 + 未跟踪」，工作区改动得用 `unstaged`，选错就是审了个空 diff。
2. **先 `analyze` 再审**：旧索引把新文件的 import 报成 `js-unresolved-local-import`，重建索引后同一条命令归零。
3. **`--json` 默认是压缩摘要**（无 message/evidence）：逐条 triage 要 `--json --no-compact`；`--mode standard|deep` 本来就带。
4. **索引口径决定一切**：读仓根 `.gitignore`（`--no-gitignore` 关），但只认子集（去首尾 `/`、跳过 `!`）。没忽略的构建产物（`storage/framework/views/`、Blade 缓存）会把 `> ''`、`foreach+->where(` 变成整片假阳；实测 vendor 129 MB/5m22s vs 忽略后 2.7 MB/15s。
5. **作用域调用**（`$this->` / `self::` / `parent::`）不按裸方法名跨文件解析：进 `knowledgeGraph.unresolvedScopedCalls` + `scopedCallStats`；`parent::` 大量 unresolved 正常，`$this->m()` 解析到**别的文件**才是 bug。

> PHP 仓另有两个最容易被骗的度量假象（`no-test-coverage` 的 HTTP 契约假象、`php-loose-comparison` 的三条语义）→ `archnav://skill/code-review`。

## MCP 侧

装了 MCP 的客户端（Hermes / Claude Code / Cursor）可以直接拉：

| prompts（工作流） | resources（长文） |
|---|---|
| `archnav_review_diff` 评审当前 diff | `archnav://skill` 本页 |
| `archnav_self_review` 审自己未提交的改动 | `archnav://skill/code-review` 规则清单与真值 |
| `archnav_test_select` 只跑相关单测 | `archnav://skill/self-review` 假阳性/降噪 |
| `archnav_deep` 仓库级深查 | `archnav://skill/comparison` 三方跑分 |
| | `archnav://skill/kanban-review` 看板逐项确认 |
| | `archnav://skill/anchor-review` ANCHOR 层 |
| | `archnav://skill/playbook-full` 完整旧版手册 |

没装 MCP 的走 CLI（`node src/index.js …`、`node scripts/review-rules.mjs …`），能力相同；长文直接读 `skill/archnav/references/*.md`。

## 单一真源

`skill/archnav/**` 是唯一真源：`resources/read` 读这里，Hermes 由 `node scripts/sync-skill.mjs` 同步（`--check` 不写盘）。改完跑 `node scripts/audit-skill.mjs`（URI/脚本/flag/坑数/版本一致性，已接进 `npm test`）。不要在两处手改同一段文字。
