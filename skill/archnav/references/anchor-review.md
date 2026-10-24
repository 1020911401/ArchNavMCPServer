# ANCHOR 审核层（agent 版速查）

> 完整文档：`docs/anchor-review.md`。这里只写 agent 需要立刻知道的部分。

## 一句话

61 条规则判「diff 有没有踩坑」；ANCHOR 层判「这次任务有没有按约束完成」——
改了什么范围、按什么顺序、跑没跑测试、怎么汇报。默认 **off**。

## 四档（可切换）

| level | 判什么 | 额外证据 |
|---|---|---|
| `off` | 不动（默认，行为和以前完全一致） | — |
| `A` | diff 可判的约束：预算、lock/CI、销毁性命令、凭据打印、可移植路径 | git diff |
| `B` | A + 任务约束（原子 + `AND/THEN/PRIORITY`）+ `ACR/CCR/IPR/FCCR` | `.archnav/constraints.json` |
| `C` | B + 执行轨迹：工具协议、执行顺序、失败重试、汇报真实性 | `.archnav/trajectory.jsonl` |
| `full` | C + 语义项的 LLM 判官（`ANCHOR_LLM_JUDGE_CMD`） | 同上 |

## 怎么切

```bash
node scripts/review-rules.mjs . --anchor-init        # 生成 .archnav/{review.config.json,constraints.json,trajectory.jsonl}
node scripts/review-rules.mjs . --scope all --anchor C   # 单次覆盖
# 或者 MCP：
archnav_review { projectDir: "...", level: "C", scope: "all" }
```

配置文件 `.archnav/review.config.json`：`{"level":"B","failOn":{"FCCR":1}}`。
`--anchor off` 立刻关掉。

## 三个必知语义

1. **没有证据 = `na`，不是通过**。没给轨迹时 C1/C2/C10 的 1114 条原子约束（39.3%）全部 `na`；
   报告里写的是"未判定"，别把 `na` 读成"没问题"。
2. **指标是范围内的比率**。`ACR 100%` 在 level A 只代表 A 能看的 21.4% 全过（C 是 81.6%，full 才 100%）。
3. **`THEN` 没轨迹只验蕴含**：前置失败 → 关系成立（前置失败已计入 ACR）；有轨迹才验时间顺序，
   note 里会写清楚。

## 关系语义（照论文实现）

- `AND`：全过才过。
- `THEN`：`items[0]` 是前置；前置过而后置挂 → 关系失败。
- `PRIORITY`：`items[0]` 最高；高优先项挂且低优先项也挂 → 关系失败，**低优先项被标 `override` 并退出 ACR**。

## check 类型

diff 证据：`path_scope` / `file_scope` / `no_change` / `max_files` / `max_lines` /
`forbidden_patterns` / `required_patterns` / `test_added` / `lock_untouched` / `ci_untouched` /
`interface_stable` / `dep_not_added` / `changed_symbols_in`

轨迹证据（level C）：`order` / `tool_discipline` / `test_run` / `verify_after_edit` /
`report_references` / `report_evidence` / `report_template`

语义：`manual` / `llm`（无判官即 `na`）

## 轨迹格式（JSONL，形状已归一化）

```jsonl
{"type":"tool_call","tool":"read_file","args":{"path":"src/a.php"}}
{"type":"tool_call","tool":"bash","args":{"command":"phpunit --filter X"}}
{"type":"tool_result","ok":false,"text":"FAILED"}
{"type":"tool_call","tool":"edit_file","args":{"path":"src/a.php"}}
{"type":"commit","commit":{"message":"fix(a): ..."}}
{"type":"message","role":"assistant","content":"修复 src/a.php:3，前后对比：\n```\nFAILED\n```\n→\n```\nOK (2 tests)\n```"}
```

## 门禁

`--gate` 会因 ANCHOR 的 `error` 级命中、或 `failOn.FCCR`/`failOn.ACR` 不达标而退出 1。
实测：一份「改了 lock/CI、没有测试、`rm -rf`、打印密码、先改后测」的改动 → ACR 28.6% / FCCR 未通过 / 退出 1；
一份按约束完成的改动 → ACR·CCR·IPR 100% / FCCR 通过 / 退出 0。
