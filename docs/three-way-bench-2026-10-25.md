# 三方标准跑分 — ArchNav / CodeGraph / GitNexus（2026-10-25）

本篇是**一次完整标准测试的执行记录**：跑了什么命令、得到什么数字、哪些口径不能直接对比。
标准由 `bench/` 定义（`run_bench.mjs` 权威召回 + `multi_dim.mjs` 七维能力 + `deep_recall.mjs` 两跳深度召回），
ground truth 由 `bench/gen_ground_truth.mjs` 用纯正则现算，不依赖任何被测引擎。

## 1. 环境与口径

| 项 | 值 |
|---|---|
| 机器 | Windows 10，Node v26.7.0 |
| ArchNav | 本仓 `13369a9`（`node src/index.js …`，每次调用含 Node 启动 ~1.3s） |
| CodeGraph | `codegraph 1.6.2`（全局 CLI） |
| GitNexus | `gitnexus 1.6.6`（全局 CLI + 机器级注册表） |
| 后端 fixture | `bench/php-app` — 286 `*.php`（含 76 `*.blade.php`），Laravel |
| 前端 fixture | `bench/vue-app` — 269 `*.vue` + 64 `*.js`，uni-app |
| 索引 | 全部**首次重建**（`run_bench.mjs --fresh`），随后 `multi_dim.mjs --no-index` 复用同一批索引 |
| 样本量 | 单次运行；wall-clock 用于量级对比，不当性能基准 |

口径提醒：
- `callers` 比的是**调用方文件集合**（三家返回粒度不同：ArchNav 返回调用点、CodeGraph 返回外层定义、GitNexus 返回入边），文件级交集才是公平比法。
- ArchNav 的 `wall_ms` 含 Node 进程启动（CLI 形态）；MCP 长驻模式下没有这笔开销，因此**不要把它当作服务端延迟**读。
- `multi_dim` 的 `gt` 是「包含该字符串的文件数」= **上界**，其 recall 只是冒烟指标，权威数字看 `run_bench`。

## 2. 测试清单与结果

### 2.1 单元测试（`npm test`，Node 内置 runner）

```
ℹ tests 352   ℹ pass 350   ℹ fail 0   ℹ skipped 2
```

### 2.2 ground truth 自测（`node --test bench/gen_ground_truth.test.mjs`）

```
ℹ tests 4     ℹ pass 4     ℹ fail 0
```

pin 住的数字：`departments` 6 调用点 / 4 文件，`showSelectOptions` 40 调用点 / 19 blade 文件（全仓 44/20），
`orderTake` 3/3，`getUserInfo` 44 调用点 / 34 文件 / 36 提及文件。**这套 ground truth 变了就必须先人工核过再改断言。**

### 2.3 权威召回：`node bench/run_bench.mjs --fresh`

| repo | query | ArchNav | CodeGraph | GitNexus |
|---|---|---|---|---|
| php-app | callers departments | **4/4 (100%)** 1,530ms | **4/4 (100%)** 1,795ms | **4/4 (100%)** 3,415ms |
| php-app | callers showSelectOptions | **19/20 (95%)** 11,304ms | 0/20 (0%) 9,576ms | 0/20 (0%) 26,693ms |
| php-app | status | ok（stale=false, conf=1, syms=682）1,417ms | ok（274 files / 1,865 nodes / 2,285 edges）3,233ms | ok 867ms |
| vue-app | callers orderTake | **3/3 (100%)** 3,351ms | 0/3 (0%) 2,557ms | **3/3 (100%)** 6,729ms |
| vue-app | callers getUserInfo | **29/32 (91%)** 1,693ms | 1/32 (3%) 1,204ms | 9/32 (28%) 3,410ms |
| vue-app | status | ok（conf=1, syms=4,625）1,673ms | ok（333 files / 5,985 nodes / 12,380 edges）3,235ms | ok 865ms |

索引（prepare）耗时 —— 同一批 fixture，全量重建：

| engine | php-app | vue-app |
|---|---|---|
| ArchNav | 3.4s | 16.1s |
| CodeGraph | 3.3s | 5.0s |
| GitNexus | 23.3s | 41.8s |

索引体积：

| engine | php-app | vue-app |
|---|---|---|
| ArchNav | 2.8 MB | 9.0 MB |
| CodeGraph | 4.5 MB | 17 MB |
| GitNexus | 42 MB | 103 MB |

### 2.4 七维能力：`node bench/multi_dim.mjs --no-index`

汇总（只算**精确等价命令**；`+n~` = 用最近似命令凑的近似列，不计入通过）：

| dimension | ArchNav | CodeGraph | GitNexus |
|---|---|---|---|
| locate | **4/4** · 1,517ms | 4/4 · 1,207ms | 0/4 (+4~) · 3,401ms |
| callers | **5/5** · 1,594ms | 2/5 · 1,254ms | 0/5 (+3~) · 3,398ms |
| impact | **2/2** · 1,585ms | 2/2 · 1,209ms | 0/2 (+2~) · 3,398ms |
| read | **2/2** · 1,537ms | 2/2 · 1,606ms | 0/2 (+2~) · 3,319ms |
| trace | **2/2** · 1,519ms | 0/2 (+2~) · 2,080ms | 0/2 (+2~) · 4,287ms |
| arch | **2/2** · 1,577ms | 0/2 (+2~) · 3,155ms | 0/2 (+2~) · 902ms |
| status | 2/2 · 1,571ms | 2/2 · 3,204ms | **2/2** · 866ms |

值得单独点出的几行：

| 用例 | ArchNav | CodeGraph | GitNexus |
|---|---|---|---|
| php `locate showSelectOptions`（8 处定义） | `ambiguous (8 defs)` + 候选列表 | 直接给第一个（`DepartmentPresenter.php:25`） | 给第一个（`:24`，行号差 1） |
| php `impact departments` | 6 direct + 7 indirect（含 5 条路由） | 11 affected（无深度标注） | 12 impacted / risk=HIGH |
| php `arch` | 7 层命名 | 只报 1,865 节点 | 只报聚类 |
| vue `locate goPay`（7 处定义） | `ambiguous (7 defs)` | `components/payment/index.vue:121` | 同文件（`:121`） |
| vue `impact goPay` | 5 direct + 5 indirect | 11 affected | **0 impacted / risk=LOW**（漏） |
| vue `callers goPay` | 5 文件（1 条经调用点核实） | 0 | 0 |
| `read` 内容量 | 345 / 8,216 字符 | 836 / 12,061 | 314 / 5,016（`context --content`） |

`multi_dim` 里 GitNexus 的 `status` 两次都报 **⚠️ 已过期**，而同一批索引在 `run_bench` 里报「索引时间 2026/10/25 11:15，索引提交：当前」——
non-git fixture 上用 `analyze --skip-git --index-only` 建索引后，它自身的过期判定前后不一致，读它的 status 时要以 `run_bench` 的口径为准。

### 2.5 两跳深度召回：`node bench/deep_recall.mjs --json`

真值独立构造（深度1 = 调用点向上找最近定义行 → 深度2 = 路由跳 ∪ 组件跳）：

| 用例 | 真值 | ArchNav | CodeGraph | GitNexus |
|---|---|---|---|---|
| php `departments` | `routes/web.php`（`MiniBookingsController@transfer`、`AnalysesController@member`） | 1/1（带 depth/via/source_kind/confidence） | 1/1，但**无深度标注**且把定义文件自己列为受影响 | 1/1（有深度） |
| vue `orderPay` | 5 个 import 了 payment 组件的页面 | **5/5** | 0/5（回的是 `api/order.js`） | 0 行（深度 2 结构性为空） |

ArchNav 的 5 条命中都带 `via=index.vue src=component conf=0.8`，另有 1 条 `pages.json` 页面层记录；GitNexus 在 vue 侧深度 2 完全为空。

## 3. 结论（按能力维度，不按总分）

1. **召回**：Blade/模板调用与跨文件 Vue 调用 ArchNav 独有（19/20 vs 0/0；29/32 vs 1/32 vs 9/32）；纯 AST 能覆盖的 `departments` 三家打平。
2. **深度**：只有 ArchNav 在「路由层 + 页面/组件层」两跳都拿全，并且每行都带 `depth/via/source_kind/confidence`；CodeGraph 有闭包但没有深度语义，GitNexus 在 uni-app 仓深度 2 为空。
3. **歧义处理**：ArchNav 回 `ambiguous + candidates` 并要求 `--file/--kind` 消歧；另外两家静默取第一个定义（`showSelectOptions` 8 处定义时这是致命的）。
4. **延迟**：单次查询 CodeGraph 最快（~1.2s），ArchNav 次之（~1.5s，含 Node 启动），GitNexus 最慢（~3.4s）；`status` 是 GitNexus 唯一领先项（866ms）。
5. **索引成本**：体积 ArchNav < CodeGraph ≪ GitNexus（2.8/4.5/42 MB，9/17/103 MB）；全量耗时 vue-app 上 CodeGraph 5.0s 最快，ArchNav 16.1s，GitNexus 41.8s。
6. **能力缺口（不是跑分能补的）**：流程/风险分级仍只有 GitNexus 有；ArchNav 现在自己给风险打分（`13369a9`），但口径与 GitNexus 不同，不能直接对号。

## 4. 复现

```bash
cd <repo>

npm test                                        # 352 tests / 0 fail
node --test bench/gen_ground_truth.test.mjs      # 4 / 0 fail

node bench/run_bench.mjs --fresh   > /tmp/bench.log   < /dev/null
node bench/multi_dim.mjs --no-index > /tmp/multi.log  < /dev/null
node bench/deep_recall.mjs --json  > /tmp/deep.log    < /dev/null
```

### 这次踩到的坑（新增）

- **不要把 `run_bench.mjs` 接到 `| tail` 后面**：脚本对 stdout 的 `EPIPE` 直接 `exit(0)`，
  管道场景下表格会整段消失、只剩子进程漏出来的一行 `stdin is not a tty`，看起来像「跑通了但没结果」。
  **重定向到文件再看**（上面的写法）。`report.json` 仍会写盘，可用它兜底核对。
- 非 TTY 环境一律带 `< /dev/null`：有些 CLI 会探测终端，缺少时整体 abort。
- 三个引擎的查询形状差异（`codegraph status` 位置参数、`gitnexus -r <alias>`、`archnav callers --file` 要仓内相对路径）
  见 `bench/README.md`，照抄那里的命令才不会拿到 0 条被当成「引擎不会」。
