# 审 ArchNav 自己未提交的改动

1. `git add -N .`（让未跟踪文件进 diff）
2. `node src/index.js analyze . --ignore "bench/**,node_modules/**,.archnav/**"`（必须先跑，索引过期会造假阳性）
3. `node scripts/review-rules.mjs . --scope unstaged --json --no-compact`
4. 逐条判定：真 bug / 规则假阳性 / 可接受噪声。假阳性要落到**规则**上修，不要靠豁免静音。
5. 改完跑 `npm test`（全量），再重复 2–3 看数字是否下降。
6. 需要更深的档位：`--mode deep --no-audit`（会多出 impact-risk / deep-module-risk / duplication-clone）

六类已修假阳性的根因（blankNonCode / 签名默认值 / arity 跨文件 / countArgs 字符串逗号 / joinPosix 三段 /
TODO 注释区间）与降噪四项（25 → brief 1 条）→ resource `archnav://skill/self-review`。
