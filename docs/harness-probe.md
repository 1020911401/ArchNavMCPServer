# Harness probe — 让「harness 改动」变成可归因的实验

评审层本身就是一个 harness：preset（`brief|standard|deep`）、规则 tier、duplication /
impact / deep 的开关、阈值、豁免文件。改任何一个都会改变 agent 看到的东西。

在两个东西到位之前，这种改动是**不可证伪**的：

1. **manifest**（`review.json.harness`）——这次结果到底是哪个 harness 产出的；
2. **probe**（`scripts/probe.mjs`）——同一个任务、不同 harness，行为差在哪。

这两样构成 Propose–Probe–Compose 里可自动化的那一半：变体由你提出（propose），
probe 在同一个 diff、同一个 index、零模型调用下跑一遍（probe），产出的对比表就是
compose 的证据。

## 1. 结果里现在带 harness 指纹

```bash
node scripts/review-rules.mjs . --scope unstaged --json --no-compact --harness-out harness.json
```

```json
{
  "tool": "archnav/review-rules",
  "version": "1.0.0",
  "preset": "brief",
  "tier": "core",
  "rules": { "enabled": 54, "registry": 61, "extended": 7, "ruleset": "e6d1240b24f84b3a" },
  "knobs": { "duplication": false, "dupKinds": [], "dupMinLines": 10, "dupMaxNewClones": null, "audit": false, "pairingFloor": 0.2, "...": "..." },
  "explicitFlags": ["--scope", "--json", "--no-compact", "--harness-out"],
  "scope": { "mode": "unstaged", "via": "git", "files": 12 },
  "index": { "commit": "db4956795ba35a34b4325368945bfeae20ae5bd0", "dir": "C:\\Users\\z\\projects\\archnav" },
  "model": null
}
```

三个字段各自解决一个问题：

| 字段 | 解决什么 | 不写会怎样 |
|---|---|---|
| `rules.ruleset`（启用规则集 sha256 前 16 位） | 两次结果是不是同一套规则 | 规则 tier 一变，历史结论全部无法比较 |
| `knobs`（preset **解析后**的值，不是 flag 原文） | 同样的 flag 在不同 preset 下落到不同值 | `--dup-kinds` 在 brief 下被 preset 覆盖也看不出来 |
| `index.commit` | 结论挂在哪个索引版本上 | 索引过期时把「工具没看见」误判成「代码没问题」 |

`explicitFlags` 单独存原文：**「操作者要什么」和「preset 实际给了什么」是两件事**，
probe 判断死旋钮靠的正是这个差。

## 2. probe：同一任务跑 N 个 harness 变体

```bash
node scripts/probe.mjs . --scope unstaged \
  --variant "brief=" \
  --variant "all-rules=--all-rules" \
  --variant "standard=--standard" \
  --variant "deep=--mode deep --no-audit" \
  --out probe.json --markdown probe.md
```

`--variant "name=--flags..."` 可重复；第一个变体默认是基线（`--baseline <name>` 可改）。
每个变体都以 `--json --no-compact` 调用 `review-rules.mjs`，同一个 dir / scope / index。
**全程不调用模型**——这正是它比 Harness² 原版便宜的地方，因为评审层本身是确定性的。

实测（archnav 自身工作区，12 文件改动，2026-10-21）：

| 变体 | preset/tier | findings | 规则行 | payload | 耗时 | 相对基线 |
|---|---|---|---|---|---|---|
| `brief` | brief/core | 29 | 61 | 28.4 KB | 2.4 s | 基线 |
| `all-rules` | brief/all | 31 | 61 | 29.2 KB | 2.3 s | +2 / −0 |
| `standard` | standard/all | 40 | 75 | 40.5 KB | 10.0 s | +11 / −0 |
| `deep` | deep/all | 41 | 79 | 42.2 KB | 7.7 s | +12 / −0 |

可复现的结论：`standard` 相对 `brief` 多 11 条里，8 条是 `duplication-clone`、1 条
`impact-risk`，代价是 payload +42% / 耗时 +7.6 s；`deep` 再多 1 条 `deep-module-risk`。
这就是 compose 要的东西：**加分项、代价、来源规则，一次给全**。

## 3. two-key 设计：防「把自己的编辑当成新发现」

findings 有两种身份：

- `stableKey` = `rule | file | 归一化 message` — 去掉 `:12`、`L41`、`第 7 行` 这类行号引用，
  **保留计数**（"18 处调用"→"19 处" 是真变化，行号不是）。
- `exactKey` = `rule | file | line` — 只用来报 `lineDrift`。

不加这层，实测会出这种假报告：改两行代码 → 8 条「新增命中」，其实全是行号漂移
（1817→1819）。所以 probe 的输出把 `added` / `removed` / `lineDrift` 分开报，漂移永不
计入新增。

## 4. 死旋钮：两种"没变化"必须区分

| 观察 | 判定 | 含义 |
|---|---|---|
| manifest 除 `explicitFlags` 外完全一致 + findings 一致 | **死旋钮** `deadKnob` | flag 没到 resolver，**没接线**（bug 级） |
| manifest 变了（knobs/ruleset 有差）+ findings 一致 | 诚实 no-op | 旋钮生效了，但这个任务上没影响（证据，不是改进） |

第一种的真实案例：`--all-rules` 曾被 `applyMode()` 的 `out.tier = preset.tier` 无条件覆盖，
解析时设进 `tier` 的值永远输 —— 与 `--compact` 那个历史 bug 同族。修法是记录
`allRulesFlag` 并让它胜出；`--fail-on-noop` 可以把这类回归拦在 CI。

```bash
node scripts/probe.mjs . --variant "brief=" --variant "all-rules=--all-rules" --fail-on-noop
# 死旋钮存在 → exit 1
```

## 5. 两层递归怎么用这个

**任务层（单 diff，次次都跑）**：这一条 diff 落在遗留 PHP 仓里 → 本轮该降 context 规则、
抬 dup 阈值。probe 提供「换了之后多了什么、贵了多少」，人（或 agent）据此 compose 出本轮
harness，而不是全局改配置。

**鞍具层（跨任务，每周一次）**：把「某个域里哪种 harness 组合稳定更好」写进经验库，
只允许带 probe 证据 + 标签证据的教训入库。库按 `bench/executor/域` 隔离，任务在域内按序、
域间并行——与 Harness² 的 per-domain library 同构。

## 6. 采纳台账（③）：让 probe 累积，而不是一次性

```bash
# 采纳（必须带理由；死旋钮/零差异/基线 一律拒绝）
node scripts/probe.mjs . --variant "brief=" --variant "standard=--standard" \
  --adopt standard --lesson "遗留 PHP 仓：克隆命中是真问题，每轮 worth +42% payload" \
  --out runs/probe-2026-10-21.json

# 拒绝也是记录（死旋钮的正确写法）
node scripts/probe.mjs . --variant "brief=" --variant "nocompact=--no-compact" \
  --reject nocompact --lesson "probe 已传 --no-compact，此轮无意义"

node scripts/probe.mjs --list-ledger
```

记录形状（一行一条，append-only JSONL）：

```json
{"ts":"…","kind":"reject","variant":"nocompact","baseline":"brief",
 "lesson":"probe 已传 --no-compact","by":"z",
 "harness":{"baseline":{"preset":"brief","tier":"core","ruleset":"e6d1240b…"},
            "variant":{"preset":"brief","tier":"core","ruleset":"e6d1240b…","knobs":{…}}},
 "evidence":{"added":0,"removed":0,"lineDrift":0,"deltaBytes":22,"deltaMs":-4,"ruleDelta":{}},
 "task":{"dir":"…","scope":"unstaged","base":null,"at":"…"},"probe_out":null}
```

四条硬规矩（都有单测钉着）：

1. **`--lesson` 必填**——没理由的采纳等于静默改配置，和"没 reason 的豁免不生效"同一条纪律；
2. **死旋钮可 `--reject` 不可 `--adopt`**——flag 没到 resolver，谈不上改进；
3. **零行为差异不可采纳**（可以记录为 reject）——否则等于自欺；
4. **规则集变了就标 stale**：`ruleset` 不在当前 `{core, all}` 摘要里 → 台账行显示「⚠️ 规则集已变，需复核」，旧采纳不自动继承。

位置 `./.archnav/harness-ledger.jsonl`（gitignored）：本机 + 本仓的记忆，不进 git、不跨项目合并，只存计数/摘要/路径，不存 finding 正文。

## 7. 标签回流（④）：✅/⛔/➖ → 每条规则的精确率

probe 只能回答"变了什么"，"变好了没有"必须由人给。`kanban-review` 的逐项确认就是标注：

| 看板动作 | 标注 | 进不进精确率 |
|---|---|---|
| `complete`（✅ 确认） | TP | 进（分子） |
| `block`（⛔ 驳回，必须带理由） | FP | 进（分母） |
| `archive`（➖ 豁免） | waived | 不进（单独计数） |
| `todo/ready/review` | open | **不进**（未标注不算准确也不算误报） |

```bash
node scripts/label-stats.mjs --board default --min-samples 5 --low 0.4 --high 0.85 \
  --suggest-waivers waivers.json --markdown labels.md          # npm run labels
```

- n < `--min-samples` → `insufficient`，**不评价**（1 个样本的 0% 不是结论）；
- precision < `--low` → `demote-or-waive`：先修规则或按「规则×文件」豁免；
- precision ≥ `--high` → `keep`；中间 → `watch`。
- `--suggest-waivers` 只产出**人工真驳回过的规则×文件**组合，形状与 `kanban-review waivers` 完全一致（同一个 `loadWaivers` 吃进来，单测对过）。

闭环实测（离线快照 16 卡，n≥5 阈值）：

```
卡片 16：✅ 6 · ⛔ 8 · ➖ 1 · ⬜ 未确认 1
unmapped-change    TP 1 / FP 4 → 20%  ⚠️ 候选豁免
arity-mismatch     TP 2 / FP 2 → 50%  样本不足（4/5）
duplication-clone  TP 3 / FP 1 → 75%  样本不足（4/5）
```

产出的豁免接回 review：表内命中 **35 → 34**，被抑制的正是 `unmapped-change · .github/workflows/review.yml`，`waived[0].waiver.reason` = "人工驳回 4/5（精确率 20%）"。

> **红线**：`--suggest-waivers` 是建议，不是自动豁免；把规则从 core 挪进 `EXTENDED_RULES` 是**代码改动**，必须走单测——别让精确率数据绕过测试。

## 8. 项目边界（跨会话硬约束）

- probe 只跑在**本项目**（archnav 仓）或显式指定的仓上；`--out`/`--markdown` 写到本仓
  `runs/` 或仓库外临时目录，**不进别的项目目录**。
- 证据件里不写客户代码内容与任何凭据：manifest 只有路径/提交/规则摘要；probe.json 只存
  findings 的结构字段。客户仓（CRMEB / 医院站 / uni-app）的结论留在各自项目的记录里。
- 不同项目的 probe 结果不可混算：域、栈、规则基数都不同，混算等于换了个问题回答。
