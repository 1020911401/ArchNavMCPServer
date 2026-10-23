# 审核任务书 → Kanban 逐项审核确认

把 ArchNav 的**审核任务书**接到 Hermes Kanban（项目管理）上：每一条命中项变成一张
任务卡，人（或 agent）逐项 ✅ 确认 / ⛔ 驳回 / ➖ 豁免，确认结论回读成最终审核意见，
未确认的 error/warn 项直接卡门禁。

三层各管一段，谁都不用改谁的逻辑：

| 层 | 提供什么 | 在链路里的位置 |
|---|---|---|
| `scripts/review-rules.mjs` | 机器可读任务书：`checklist.rows`（id/status/hits/reason）+ `findings`（rule/severity/file/line/message/**why/evidence**） | 出「项」和「证据」 |
| `scripts/kanban-review.mjs` | `push` 入板、`status` 回读 + 门禁退出码 | 转换与汇总 |
| Hermes Kanban / Projects | 状态机：`create / comment / complete / block / request-review / archive` + 父子依赖 + `tenant` 分批 | 逐项确认的落点 |

## 用法

```bash
# 1. 出任务书（--no-compact 必须给：默认 --json 是压缩摘要，没有 checklist/why/evidence）
node scripts/review-rules.mjs . --scope unstaged \
  --impact --deep --mode deep --no-compact --json > review.json

# 2. 入板（先 --dry-run 看一眼要建哪些卡）
node scripts/kanban-review.mjs push review.json --board archnav-review --dry-run
node scripts/kanban-review.mjs push review.json --board archnav-review

# 3. 逐项确认（kanban 自带动词，确认结论就是审核证据）
hermes kanban --board archnav-review list --sort priority-desc
hermes kanban --board archnav-review comment  <id> "确认人=z：…（为什么接受/不接受）"
hermes kanban --board archnav-review complete <id> --result "确认通过：…"
hermes kanban --board archnav-review block    <id>          # 驳回 / 待澄清
hermes kanban --board archnav-review request-review <id>    # 转人工复核
hermes kanban --board archnav-review archive  <id>          # 误报豁免（先 comment 写理由）

# 4. 回读 + 门禁（未确认的 error/warn 项 > 0 → exit 1）
node scripts/kanban-review.mjs status --board archnav-review --run <fingerprint> --gate

# 5. 豁免回流：看板上「➖ archive 豁免」的条目 → 豁免清单 → 下次不再重复报
node scripts/kanban-review.mjs waivers --board archnav-review --run <fingerprint> --out waivers.json
node scripts/review-rules.mjs . --scope unstaged --waivers waivers.json
```

项目侧绑定（一个仓 = 一个项目 = 一个看板）：

```bash
hermes project create ArchNav --slug archnav --primary <repo> --board archnav-review
```

`npm run review:kanban -- push|status|waivers …` 等价于直接跑 `scripts/kanban-review.mjs`。

## 闭环：豁免不是「静音」，是「有理由的记录」

看板判一条为误报 → **先 `comment` 写理由**，再 `archive` → `waivers` 导出 → `review-rules --waivers`
下次不再重复报同一条。三条硬规矩（`tests/review-waivers.test.mjs` 7 条钉住）：

| 规矩 | 为什么 |
|---|---|
| **没有 `reason` 的豁免不生效**：finding 照旧报，任务书里写明「N 条缺 reason → 未生效」 | 豁免文件一旦能静音，审核就退化成「谁改文件谁放行」 |
| **匹配不到的豁免报失效**（`stale`，「建议重审」） | 规则改了 / 行号漂了，旧豁免不该继续默默生效 |
| **被摘掉的 finding 进 `waived[]`**：规则/文件/行/理由/确认人/卡号，进 `--json`、markdown 的 `<details>` 清单、控制台 | 审计时要能回答「这条为什么没报」 |

匹配键 = `rule` 精确 + `file` 归一化（反斜杠、`./` 前缀）+ `line`；`line` 省略（`null`）= 该规则该文件全豁免。
任务书里会多出一行 `豁免` 分组：「N 条已豁免；M 条缺 reason；K 条失效」，并且**规则行会按豁免后的
findings 重建**（否则会出现「行写着命中(1)、findings 里却一条没有」的自相矛盾）。

实测（archnav 工作区，1 条写了理由 + 1 条忘写）：

```
# 无豁免
findings 26 | waived 0 | ai-todo-left row hit hits=1
# 有豁免
findings 25 | waived 1 | ai-todo-left row pass hits=0
waivers row: hit 1 | 1 条已豁免（…/waivers.json）；1 条缺 reason → 未生效
➖ 已豁免 1 条 —— [ai-todo-left] scripts/review-rules.mjs:461 — 理由：…假阳性…（default / t_f80438d9）
```

⚠️ 被豁免的 finding 也不再进 SARIF、不再触发 `--gate`——这正是豁免的语义，但也意味着
**豁免文件本身是一道门**：它要跟着 PR 一起被 review，别藏进 CI 变量。

## 字段约定（回读靠它们，别改）

| 看板字段 | 承载 | 为什么 |
|---|---|---|
| `tenant` | 批次 fingerprint（`review-rules` 的 checklist hit + findings 内容哈希前 8 位） | `list --json` 不返回 idempotency_key，分批只能靠 tenant |
| `priority` | error 3 / warn 2 / info 0 | 门禁判定「未确认的 error/warn」直接读 priority |
| `idempotency-key` | `<fp>:<rule>:<file>:<证据数>` | 同一份任务书重复 push 不产生重复卡 |
| `title` | `[archnav] <rule> · <file>` | 看板上可读、可过滤 |
| 依赖 | **条目 → 收口卡**（收口卡是条目的子任务） | 方向见下面「坑 2」 |

`--granularity rule|rule-file|finding`（默认 `rule-file`）、`--min-severity info|warn|error`
控制卡片粒度与噪声。整仓 `--scope all` 的 `duplication-clone` 动辄上百条，入板前先
`--min-severity warn` 或按 `rule` 粒度合并。

## 实测（archnav 工作区未提交改动，15 项）

```
✅ 已接入看板 'archnav-review'（批量 API，单进程）：15 张逐项确认卡 + 收口卡 t_80317631（tenant=d093b2ab）

📋 逐项审核确认 — 批次 d093b2ab（看板 archnav-review）
   共 15 项：✅ 已确认 1 · ⛔ 驳回 1 · ➖ 豁免 1 · 未确认 12
   收口卡 [t_80317631] ⬜ 待确认 —— 条目全部有结论后才 complete
   ✅ [t_fd537181] [archnav] unmapped-change · .github/workflows/review.yml
        └ 确认通过：非代码文件，人工阅 diff 后接受
   ⛔ [t_06efb46a] [archnav] js-unresolved-local-import · scripts/review-rules.mjs
   ➖ [t_3a626a2b] [archnav] js-unused-binding · scripts/review-rules.mjs

❌ 门禁未过：8 个 error/warn 级确认项仍未有结论     # exit 1
```

## 坑（都实测过）

1. **`--json` 默认是压缩摘要**：`{mode,tier,summary,findings:[{rule,severity,file,line}]}`，
   没有 `checklist`、没有 `why/evidence`——拿它入板等于让确认人裸看规则名。
   必须 `--no-compact`；`push` 会对压缩输入直接报错并指路。
   （顺带修了 `applyMode`：`--no-compact` 原先被 `compact: true` 的初始值吃掉，永远关不掉。
   回归：`brief`=紧凑、`deep`=完整、`--compact`/`--no-compact` 双向可覆盖。）

2. **依赖方向不能反**：批次卡当「父」、确认项当「子」会**死锁**——kanban 要求父任务先完成，
   子任务才能 `complete`：
   ```
   cannot complete t_…: unsatisfied parent dependencies: t_… (ready);
   complete the parents first, or `hermes kanban unlink <parent> <child>`.
   ```
   于是每一条确认项都完不成。正确方向是 **条目 → 收口卡**：条目随时独立确认，
   收口卡只有全部条目有结论后才从 `todo` 变 `ready` 才可 `complete`（smoke 实测：
   建 2 条目 + 收口卡 → 条目未完成时收口卡 `todo` → 全完成后 `ready` → 收口 `done`）。
   ⚠️ 注意 API 与 CLI 不一致：CLI **报错**拦下，`kanban_db.complete_task()` 对未满足父依赖的
   任务是**静默不改状态**（返回 True、状态仍 `todo`）——脚本里别拿返回值当成功。

3. **逐条 CLI 太慢**：`hermes kanban create` 每次要 import 整个 agent，实测 **~13s/次**，
   16 张卡要 3~4 分钟。`push` 因此走单进程批量路径
   （`scripts/kanban_review_batch.py` → `hermes_cli.kanban_db.create_task`，同一实现、同一 DB、
   同一套 idempotency 语义），**16 张卡 3.2s**；找不到 python 才退回逐条 CLI。

4. **指纹只认审核内容**：改一行证据就是新批次（旧的确认结论不会串到新任务书上），
   同内容重复 push 则幂等复用已有卡（含已确认状态）。

5. **看板是本机的**：CI runner 写不到你的 `kanban.db`，所以这一层是**本地/agent 侧**闭环
   （评审前 push → 逐项确认 → 门禁）。CI 侧继续用 `review-rules.mjs --gate` + SARIF，
   两者不冲突：CI 管机器能判的，看板管必须有人给结论的。

## 测试

`tests/kanban-review.test.mjs`（8 条）钉纯逻辑：指纹稳定性、三种粒度分组、严重度→优先级、
`--min-severity` 过滤、卡片正文含 file:line/why/evidence 与四个确认动词、压缩输入被挡回。
`tests/review-waivers.test.mjs`（7 条）钉豁免的三条规矩（无理由不生效 / 失效报 stale / 摘掉的进 `waived[]`）
与匹配键归一化。写看板、逐项确认、门禁退出码属端到端，靠上面命令实测。
`scripts/kanban_review_batch.py --probe` 可单独检查 python 侧能否 import `hermes_cli`。
