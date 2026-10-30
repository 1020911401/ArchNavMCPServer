# 任务书逐项确认接入 Hermes Kanban

## 背景

ArchNav `review-rules.mjs` 能产出机器可读的审核任务书（checklist.rows / findings.with_why），但「逐条确认」这个动作需要人参与——这正是 Kanban 的强项。把任务书推成卡片，人/agent 逐项 ✅确认/⛔驳回/➖豁免，最后汇总成「审核通过/失败」结论，可当 CI 门禁。

## 核心设计

| 概念 | 实现 |
|---|---|
| 一条审核条目 | 一张 Kanban 卡片（title = `<skill> rule-slug · file`，body 含 reason/evidence） |
| 确认动作 | `hermes kanban complete / block / archive` + comment 写结论依据 |
| 批次状态 | `.archnav/kanban-review-<fp>.json`（fingerprint=review.json 的 MD5） |
| 门禁汇总 | `kanban-review.mjs status --gate` exit 1 = 有未确认 error/warn 项，CI 红 |

## 前置：仓库级准备

```bash
# 1) 建看板（一次性）
hermes kanban create archnav-review --name "ArchNav Review"

# 2) 建项目并绑定看板
hermes project create ArchNav --slug archnav \
  --primary ~/projects/archnav \
  --description "审核任务书逐项确认" \
  --board archnav-review
```

## 工作流：一键推送 + 分批确认

### 推送到看板

```bash
cd ~/projects/archnav
S=.archnav/kanban-review-d093b2ab.json
node scripts/kanban-review.mjs push "$S" --board archnav-review
# 输出：✅ 已接入看板 …：15 张逐项确认卡 + 收口卡 t_80317631
```

### 批量确认（agent 场景，无需逐条 CLI）

```python
# .archnav/kanban-review-<fp>.json 里有 items[].id + status
# agent 读该 JSON → 逐项决定 complete/block/archive → 调 hermes kanban {cmd} <id>
# 最后 status --gate 看门禁是否过
```

实测：逐条 CLI ≈ 13s/次；同目录改走脚本里的批量 API 路径可降到 ~3s（16 张）。

### 回读状态

```bash
node scripts/kanban-review.mjs status --board archnav-review --run d093b2ab --gate
# 输出示例：
# ✅ 已确认 1 · ⛔ 驳回 1 · ➖ 豁免 1 · 未确认 12
# 收口卡 [t_xxx] ⬜ 待确认 —— 条目全部有结论后才 complete
# ❌ 门禁未过：8 个 error/warn 级确认项仍未有结论   EXIT=1
```

## 关键：父/子方向

**错误方向**：批次任务 = 父，确认项 = 子 → 先完不成子，永远无法 complete 父（死锁）。

**正确方向**：确认项 = 子，收口卡 = 父。每条子卡随时可独立确认；收口卡只有全部子卡有结论后才可以 complete。语义正好是「任务书全项确认完毕」。

```bash
# 收口卡（parent）
t_xxx  ──►  [Batch-<fp>] 审核任务书 · 2026-10-17
# 子卡（children，通过 kanban-link 绑到 parent）
t_abc  ──►  [Batch-<fp>] js-unused-binding · scripts/foo.mjs
t_def  ──►  [Batch-<fp>] empty-catch · scripts/bar.mjs
# ...
# 确认后子卡 complete/block/archive；父卡最后 complete
```

CLI 已内置这个约束：父未完成时 `hermes kanban complete <child>` 会被拒，报「unsatisfied parent dependencies」。这是**主动保护**，不是 bug。

## 结论写入规范

| 动作 | 命令 | 要求 |
|---|---|---|
| ✅ 确认 | `complete <tid> --result "简短结论"` | 必须写 result，附一行证据/理由 |
| ⛔ 驳回 | `block <tid>` + `comment <tid> "驳回理由"` | 理由要写清楚（假阳性路径/误判规则/已修复） |
| ➖ 豁免 | `archive <tid>` + `comment <tid> "豁免理由"` | 同 block，保留审计链 |

comment 里建议带 `规则名 · 文件:行号 · 为什么` 三段式，方便回查。

## 脚本说明

- `scripts/kanban-review.mjs`（Node）：push / status / close 三命令，CLI 为主、API 为辅
- `scripts/kanban_review_batch.py`（Python）：单次批量推送（`create + link` 同进程）
- 结构化 checklist 不另起脚本：`scripts/review-rules.mjs . --scope <scope> --json --no-compact` 的 `checklist.rows` + `findings[]`
  就是建表输入（`kanban-review.mjs push` 直接读它，手写表格会与规则表漂移）。

## 门禁集成建议

在 CI（如 GitHub Actions）里，审核任务书生成后自动推看板：

```yaml
- name: ArchNav review + push to kanban
  run: |
    node scripts/review-rules.mjs . --scope compare --base ${{ github.event.pull_request.base.sha }} \
      --impact --deep --duplication --json review.json
    node scripts/kanban-review.mjs push review.json --board archnav-review --run ${{ github.sha }}
    node scripts/kanban-review.mjs status --board archnav-review --run ${{ github.sha }} --gate
```

实际落地时把 `--run <fp>` 换成 `--run <pr-number>` 或 `--run <commit-sha>`，让多次推送共享同一批次 ID。

## Pitfalls

1. **默认 `brief` 会把整类规则滤掉**：`--no-compact` 已经有效（flags 生效后 `compact:false`，findings 带 message/why/evidence），但 `brief` 的 tier 是 `core`，`EXTENDED_RULES` 那 7 条（`php-loose-comparison`、`js-loose-equality`…）一条都不跑——`--json --no-compact` 时 `harness.rules.enabled` 是 **55 / registry 62**（compact 的 JSON 里这个字段根本不出现，只有 preset/tier/ruleset）。推看板当门禁时用 `--mode standard`（tier=all，62/62）或补 `--all-rules`，否则任务书缺一整类。
2. **Windows 反斜杠路径**：review.json 里 `file` 是 `scripts\\x.mjs`，kanban-review.mjs 在生成 title 时要 `replace(/\\/g, '/')` 统一成正斜杠，否则看板标题乱码。
3. **`batch-create` 是异步**：脚本里 `for await (... of batchCreate(...))` 是 generator，不是同步阻塞——如果要用结果要 `await` 或 `.toArray()`。
4. **`--gate` 只看 error/warn**：info 级 findings（如 `ai-todo-left`）不在 gate 范围，不会让 CI 红。这是有意设计，info 只入看板记录，不拦构建。
