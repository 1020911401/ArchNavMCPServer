# 豁免回流工作流（看板 → 任务书）

把「已逐项确认的误报」沉淀成豁免清单，让下一轮 review 不再重复报同一条。

## 步骤

```bash
# 1) 从看板导出豁免清单
node scripts/kanban-review.mjs waivers --board archnav-review --run <fp> --out waivers.json

# 2) 带入下一轮 review
node scripts/review-rules.mjs . --scope <scope> --waivers waivers.json

# 3) 再 push 到看板（skipWaivedGroups 会跳过整组豁免的条目，不再建卡）
node scripts/kanban-review.mjs push review.json --board archnav-review --waivers waivers.json
```

## 三条硬规矩（`tests/review-waivers.test.mjs` 7 条钉住）

| 规矩 | 为什么 |
|---|---|
| **没有 `reason` 的豁免不生效**：finding 照旧报，任务书写明「N 条缺 reason → 未生效」 | 豁免文件一旦能静音，审核就退化成「谁改文件谁放行」 |
| **匹配不到的豁免报 stale**（规则改了 / 行号漂了 → 建议重审） | 旧豁免不该继续默默生效 |
| **被摘掉的 finding 进 `waived[]`**：规则/文件/行/理由/确认人/卡号，进 json/markdown/控制台 | 审计时要能回答「这条为什么没报」 |

匹配键 = `rule` 精确 + `file` 归一化（反斜杠、`./` 前缀）+ `line`；`line` 省略（`null`）= 该规则该文件全豁免。

## 两条连带坑

1. **豁免后要重建规则行**：`buildChecklist({findings, meta})` 必须在 `applyWaivers` 之后调，否则会出现「行写命中(1)、findings 里却一条没有」的自相矛盾。
2. **豁免连 SARIF 与 `--gate` 一起吃**：这是语义——被豁免的 finding 不再进 SARIF、不再触发门禁。但也意味着**豁免文件本身是一道门**：它要跟着 PR 一起被 review，别藏进 CI 变量。

CI 接入：`.github/workflows/review.yml` 里
```yaml
if [ -f review-waivers.json ]; then WAIVER_ARGS="--waivers review-waivers.json"; fi
node scripts/review-rules.mjs . \
  --scope compare --base HEAD~1 \
  --impact --deep --duplication --dup-max-new-clones 0 \
  --gate --markdown review.md $WAIVER_ARGS
```
文件不在就保持原门禁行为，不引入新依赖。

## 实测样本

```
# 无豁免
findings 26 | waived 0 | ai-todo-left row hit hits=1

# 有豁免（1 条写了理由 + 1 条忘写）
findings 25 | waived 1 | ai-todo-left row pass hits=0
waivers row: hit 1 | 1 条已豁免（…/waivers.json）；1 条缺 reason → 未生效
➖ 已豁免 1 条 —— [ai-todo-left] scripts/review-rules.mjs:461 — 理由：…假阳性…（default / t_f80438d9）
```

## 看板幂等陷阱

kanban 的幂等只对**未归档**任务生效（CLI 原文：*if a non-archived task with this key exists*）。所以「豁免 → 再 push」会把这些条目**重新摆一遍卡**。两个应对：

1. `push --waivers`（已实现）：推之前先过豁免清单，整组豁免的条目不再建卡。
2. **不要在 push 后就地 archive 再 push**——先导出豁免清单，带 `--waivers` 再 push。

实测踩到：`js-unused-binding · scripts/review-rules.mjs` 因同一批次反复 push 出现重复卡（17→16 张），用 dedup 脚本按 `标题 × archived_titles` 比对后清掉。
