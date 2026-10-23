# 评审当前 diff

目标：只看这次改动会炸到什么，结论必须带证据（文件:行 + why），不要泛泛建议重构。

1. 确认索引新鲜：`node src/index.js status .`（`stale:true` 或 commit 不一致 → 先 `analyze`）
2. 生成任务书（机器可读、逐条可确认）：
   `node scripts/review-rules.mjs . --scope unstaged --json --no-compact`
   未提交改动含新文件时，先 `git add -N .`，否则新文件不进 diff。
3. 受影响面：`node src/index.js changes . --scope unstaged`（已改符号 + 直接/间接影响 + 路由/页面）
4. 该跑哪些单测：`node scripts/test-select.mjs . --scope unstaged --json`
5. 门禁：`node scripts/review-rules.mjs . --scope unstaged --gate`（exit 1 = error 级命中）
   需要 CI 形态：`--sarif review.sarif --github`
6. 逐条回报时按 rule/file/line/why/evidence 五段写；`unmapped-change` 只对**代码**文件当信号，
   文档/配置的聚合行不是缺陷。

规则口径与实测真值 → resource `archnav://skill/code-review`。
