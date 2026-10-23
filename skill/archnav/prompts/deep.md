# 仓库级深查（流程 / 聚类 / 风险 / 多仓）

单仓：
`node scripts/deep.mjs <repo> --flows --clusters --risk --top 10 --markdown deep.md`

多仓（前后端配对，只连 HTTP 边界）：
`node scripts/deep.mjs --repo front=<fe> --repo back=<be> --cross --markdown cross.md`
匹配率 < 20% 时只报 `cross-repo-pair-suspect`，不刷假 404。

与审核任务书合并：
`node scripts/review-rules.mjs . --scope staged --impact --json review.json`

边界（不要越过）：聚类是文件级不是符号级；动态调用不解析；类型推断刻意不造；
跨仓只有 HTTP（队列/gRPC/事件不连）；`--ignore` 不读 .gitignore。
