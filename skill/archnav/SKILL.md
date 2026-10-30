---
name: archnav
description: Use when the question is about a codebase, not a file — locate a symbol, who calls it, what breaks if I change it, review this diff, which tests to run, repo-level flows/risk.
version: 1.9.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [code-navigation, code-review, mcp, sarif]
    linked_files: {references: [anchor-review.md, code-review.md, comparison.md, kanban-review.md, playbook-full.md, self-review.md]}
---

# ArchNav

图谱负责**带路**（文件:行 + 置信度），不负责真相：**改任何代码前先 `read` 取磁盘原文**。

## 何时用哪条

| 问题 | 入口 |
|---|---|
| 符号在哪、读它的真源码 | `locate` · `read` · `whereami <file> <line>` |
| 谁调用它 / 它调用谁 / 两点怎么连 | `callers` · `calls` · `trace` |
| 改它炸哪里 / 这次 diff 破了什么 | `impact` · `changes` |
| 分层 / 索引新鲜度 / 看的是哪一版 | `arch` · `status` · `version` |
| 审 diff：规则、证据、门禁 | `scripts/review-rules.mjs` |
| 该跑哪些单测 | `scripts/test-select.mjs` |
| 流程 / 聚类 / 模块风险 / 多仓接口 | `scripts/deep.mjs` |
| 逐条签字（ANCHOR A/B/C/full） | `scripts/anchor-review.mjs` |

统一入口 `node src/index.js <cmd>`；首次或改动后 `analyze` 建/重建索引。完整 CLI（`graph` / `flow` / `export` / `duplication` / `probe` / `kanban-review`）见 `archnav://skill/playbook-full`。

## 五个坑

1. **索引口径就是结论口径**：`analyze` 只认 `.gitignore` 的子集（去首尾 `/`、跳过 `!`），漏掉 vendor/构建产物会整片假阳；`.archnav/` 必须忽略，否则索引自己进 `changes`（实测 1 个改动变 3 个）。
2. **未跟踪文件已算改动**，不用 `git add -N`；但 `--scope staged` 只含「已暂存 + 未跟踪」，审工作区改动要用 `unstaged`。
3. **旧索引会撒谎**：新文件的 import 会被报成 `js-unresolved-local-import`；改前先 `analyze`，重建后同一条命令归零。
4. **输出粒度**：`--json` 默认压缩（无 message/evidence）→ triage 用 `--json --no-compact`；`brief` 只跑 core（55/62），`--mode standard` 或 `--all-rules` 才含 extended。
5. **作用域调用**（`$this->` / `self::` / `parent::`）不按裸名跨文件解析（见 `unresolvedScopedCalls`）：`parent::` 大量 unresolved 正常；`$this->m()` 落到**别的文件**才是 bug。

## 接口（MCP）

装了 MCP 的客户端（Hermes / Claude Code / Cursor）直接拉；没装就用上面的 CLI，能力相同。

| prompts（工作流） | resources（长文） |
|---|---|
| `archnav_review_diff` 审当前 diff | `archnav://skill` 本页 |
| `archnav_self_review` 审自己未提交的改动 | `archnav://skill/code-review` 规则目录 + 真值 |
| `archnav_test_select` 只跑相关单测 | `archnav://skill/self-review` 假阳性 / 降噪 |
| `archnav_deep` 仓库级深查 | `archnav://skill/comparison` 三方跑分 |
| | `archnav://skill/kanban-review` 看板逐项确认 |
| | `archnav://skill/anchor-review` ANCHOR 层 |
| | `archnav://skill/playbook-full` 完整手册 |

## 维护

`skill/archnav/**` 是唯一真源：MCP `resources/read` 读它，Hermes 由 `node scripts/sync-skill.mjs` 同步。改完跑 `node scripts/audit-skill.mjs`（校验本文的脚本/命令/flag/URI/链接、坑数与版本，已接进 `npm test`）。

> **v1.9.0** — 重排为「问题 → 入口」表 + 五条硬规则；历史版本见 `references/playbook-full.md`。
