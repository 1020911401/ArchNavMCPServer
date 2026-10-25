---
name: archnav
description: Use when navigating or reviewing code with ArchNav — locate/impact/trace, diff-scoped review rules, test selection, repo-level deep analysis. Playbook short here; long references and the MCP prompts live in the repo.
version: 1.6.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [code-navigation, code-review, mcp, sarif]
---

# ArchNav (playbook)

> **v1.6.0** — 拆成「薄技能 + MCP prompts/resources + references」：正文只留触发条件与三个必知坑；四套工作流进 MCP `prompts`，长文进 `resources`（同一批文件）。完整旧版手册保留在 `references/playbook-full.md`。
> **v1.5.0** — 新增 `archnav version <dir>`（目标仓版本：git HEAD/branch/tag/dirty、manifest 版本、索引建于哪个 commit）。
> **v1.4.0** — 自审流程与六类假阳性、降噪四项（自审 25 → brief 模式 1 条）。

ArchNav 是给 agent 用的代码导航 + 评审层：图谱只负责带路（文件/行号），改代码前必须 `read` 真源码。

## When to Use

- 在不熟悉的仓里定位符号、看分层 → `locate` / `read` / `arch` / `whereami`
- 评审一个 diff、算爆炸半径 → `changes` / `impact`
- 想知道这次改动该跑哪些单测 → `scripts/test-select.mjs`
- 仓库级深查（流程/聚类/风险/多仓接口）→ `scripts/deep.mjs`
- 「我看的是哪一版代码」→ `archnav version <dir>`（git HEAD/branch/tag/dirty + 清单版本 + 索引建于哪个 commit）

## 三个必须先知道的坑

1. **未跟踪文件不进 diff**：审未提交的改动前先 `git add -N .`，否则新建文件根本不在 `git diff` 里。
2. **先 `analyze` 再审**：索引过期会把新文件全报成「import 解析不到」（candidates tried=7）——拿旧索引的结论当证据等于审了个旧仓。
3. **`--json` 默认是压缩摘要**（没有 message/evidence）：逐条 triage 必须 `--json --no-compact`。
4. **索引口径决定一切**：`analyze` 现在会读仓根 `.gitignore`（`{gitignore:false}` / `--no-gitignore` 可关），
   但**只认子集**（去掉首尾 `/`、跳过 `!` 否定行）。没写进 `.gitignore` 的构建产物（如 Laravel 的
   `storage/framework/views/`、编译后的 Blade 缓存）仍会被索引——那些文件里的 `> ''`、`foreach+->where(`
   会整片变成假阳。索引前先确认 `ignore` 字段是否覆盖了 vendor/构建目录；实测一个 Laravel 仓：不忽略
   vendor 是 129 MB / 5m22s，忽略后 2.7 MB / 15s。
5. **作用域调用（`$this->` / `self::` / `parent::`）不再按裸方法名跨文件解析**：解析不到会进
   `knowledgeGraph.unresolvedScopedCalls`（上限 200 条）+ `scopedCallStats`。看到 `parent::` 大量
   unresolved 是正常的（框架父类不在索引里），不要当成缺陷；反过来，如果某个 `$this->m()` 解析到了
   **别的文件**，那是 bug 而不是证据。

## MCP 侧（本仓 `src/mcp-server.js`）

装了 MCP 的客户端（Hermes / Claude Code / Cursor）可以直接拉：

| prompts（工作流） | resources（长文） |
|---|---|
| `archnav_review_diff` 评审当前 diff | `archnav://skill` 本页 |
| `archnav_self_review` 审自己未提交的改动 | `archnav://skill/code-review` 规则清单与真值 |
| `archnav_test_select` 只跑相关单测 | `archnav://skill/self-review` 假阳性/降噪清单 |
| `archnav_deep` 仓库级深查 | `archnav://skill/comparison` 三方跑分（证据，非依赖） |
| | `archnav://skill/kanban-review` 看板逐项确认 + 豁免回流 |

没装 MCP 的走 CLI（`node src/index.js …`、`node scripts/review-rules.mjs …`），能力完全一样，只是少了 prompts 这层模板；
长文可以直接读仓内文件 `skill/archnav/references/*.md`（MCP resource 就是这些文件的原文，内容一致）。

## 单一真源

`skill/archnav/**` 是唯一真源：MCP 的 `resources/read` 直接读这里的文件，Hermes 技能由这里同步（`node scripts/sync-skill.mjs`，`--check` 校验不写盘）。
完整旧版手册（CLI 全命令、`changes` 管道、harness probe、历史坑）留在 `references/playbook-full.md`，没有被丢。
不要在两处手改同一段文字 —— 之前手工同步把 SKILL.md 切片切坏过一次。
