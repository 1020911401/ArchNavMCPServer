# 响应形状核对（shape check）— 立项书

> 状态：**已测量、未实现**。本文件是「先立项再做」里立项那一步：数字来自 2026-10-30 在本机
> 真实前后端对上的只读测量，设计与验收标准都写死在下面，实现时按里程碑走。
> 为什么立项而不是直接写规则：见 [能力边界](../skill/archnav/references/code-review.md) §6。

## 1. 要解决什么

前端读了响应里不存在的字段（`res.data.foo`，后端从未返回 `foo`）——这类缺陷
**路径/方法边界核对看不见**：`fe-be-path-not-found` 只能证明「端点存在」，不能证明
「字段存在」。GitNexus 有对应能力（`shape_check`：handler 响应结构 vs consumer 属性访问）。

## 2. 测量依据（为什么不能一条规则了事）

真实配对：`D:\wwwroot\CRMEB\template\uni-app` ↔ `D:\wwwroot\laravel_crmeb`
（`pathMatches` 配对 **20.8% = 48/231** 条唯一路径，49 个对上的接口）。

| 事实 | 数字 | 含义 |
| --- | --- | --- |
| handler 里有字面返回键（`$data['k']=…`） | **3/49（6%）** | L0 直接可提取的比例 |
| 形状委托给 `app('json')->success($this->service->…)` | **34/49（69%）** | 必须多跳一层 service |
| controller 方法找不到 / 无字面形状 | 12/49 | 解析不到 → 必须报 `未核对` 而非静音 |
| 读 `<resp>.data*` 的前端文件 | **141** | 字段读取不在调用点 |
| 发请求的前端文件 | **18** | 端点在 api 层 → 要补「端点→调用页」一跳 |

结论：**两跳（service 返回解析、端点→调用页），是一个项目。** 6% 的 L0 单独上没有价值，
69% 的 L1 才是主菜。

### 2.1 实现后的复测（M1，`scripts/response-shape.mjs` + `scripts/shape-coverage.mjs`）

> 数字必须带时间戳：**这对是活的生产仓**。测量当天 145 → 155 条路由（同一会话内 10 分钟，
> `routes/api/out.php` 等文件在被并行编辑），配对数也随之变化——下面每个数字都写死了时刻与路由数。

| 指标 | 实测（2026-10-30T09:48Z，后端 155 路由） | 立项前 |
| --- | --- | --- |
| 匹配接口对 | 62 | 49 |
| `local`（controller 里有字面键） | 7（11%） | 3（6%） |
| `service`（L1 解析到 service 层） | 20（32%） | — |
| **resolved 合计** | **27/62 = 44%** | 6% |
| `unresolved` | 35（56%） | — |

`unresolved` 的构成（35 条）：

- **21 条 `service-has-no-literal-shape`** — 抽样核对过 constructor hint（如 `articles:ArticleReadService`）
  指向的确实是 picked 文件，且**同名方法在全仓任何文件里都没有字面键**：真实代码用 collection/`toArray()` 组装，
  属立项书 §3.2 明令「不猜」的那类；
- **13 条 `depth-cap`** — service 再委托给 `repository/reader`（`read.pcIssueCouponRows()` 等），
  按 §3.2 策略上限 2 跳不追；
- **1 条 `no-literal-shape-no-delegate`**。

**复现**：`node scripts/shape-coverage.mjs <frontendDir> <backendDir>`（只读，自动打时间戳）。
真值 fixture 上同一条命令给 **91%（10/11）**——resolver 本身没问题，差的是真实代码的形状风格。

**两个口径，别混（2026-11-01 起工具同时报）**：

- `resolved` = resolver 能读出形状（§2.1 的 44% 是这个）；
- `comparable` = 规则**真正肯比较**的，过 `shapeIsComparable`（不完整 / 包裹型都拒）。

同一对最新一次实测（**260 条后端路由**，比 10-30 的 155 又涨 105 条——生产仓一直在动，
这正是所有数字必须带时间戳的原因）：`resolved 41/93 = 44%`、`comparable 36/93 = **39%**`
（守卫拒掉 partial 3 + wrapper 2）。真值 fixture 上两者相等（91%），因为干净代码里没有这两种形态。

### 2.2 端到端核验：规则在真实配对上会报什么（2026-11-01）

把 M3 规则整条链路搬到真实配对上跑，并对每条命中**人工核对源码**。命中数的轨迹，
每一步都是一个具体缺陷被修掉：

| 阶段 | 命中 | 修掉的东西 |
| --- | --- | --- |
| 原始 | **7** | — |
| 方法调用守卫 | 4 | `res.data.map/filter` 是方法不是字段；负向预查被 `\w*` **回溯**骗过（`map` 失败退成 `ma`）→ 改为显式判断后面是否 `(` |
| 窗口截断修复 | 3 | 600 字符窗口把 `res.data.customer_url` **从中间切断**成幻影字段 `customer`（该文件全文 0 处裸 `.data.customer`）→ 从完整源码拼回标识符尾部 |
| partial + 包裹守卫 | **1** | `localShape` 只读第一个 return → 改为**所有 return 取并集 + 无法展开的分支标 `partial`**；payload 含 `data` 键（经典包裹）拒绝比较 |

**最终 1 条命中，且已人工核过源码**：

```
GET v2/user/service/record  ->  KefuV2Controller@record
  客户端 chat.vue:515,518,534,541,546  共 5 处 res.data.serviceList.length
  后端只返回 list, count      →  运行时 serviceList 为 undefined，.length 直接抛
```

配套核验：后端包装器 `CrmebApiResponse::success($message,$data,$replace)` **只包装不注入键**
（我们未传 `$replace`），所以「客户端读的字段后端没返回」在机制上成立。
可比 6 对、沉默 56 对——`partial`/`data` 守卫拦掉的 `bindName`、`id` 两条都是**可能的假阳**
（`bindName` 完全可能由另一个 return 分支返回），宁可沉默也不编造。

**结论**：这条规则现在是「少而准」——1 条经过人工核对的命中，胜过 7 条含 3 个已知假阳的命中。

## 3. 设计

### 3.1 复用既有的诚实性基建（硬约束）

只有在配对可信时才比形状，否则该行 `未核对`：

- `fe-be-pairing-suspect` 未命中（配对率 ≥ 20%）**且**后端索引路由数 > 0；
- 真值由 `bench/fe-be-pair/` 端到端钉住（已有 2/1/3/0/1 五个计数）。

### 3.2 后端：形状解析器 `resolveHandlerShape(root, controller, action)`

```
L0  方法体内字面形状：return [ … ] / $data['k'] = … / response()->json([ … ])
L1  委托：return app('json')->success($this->service->foo(…))
        → 定位 app/Services/*Service.php 的 foo() 方法体 → 重复 L0 规则
深度上限 2 跳（controller → service）；超出 → unresolved，不猜 repository/ORM 形状
返回：{ level: 'local' | 'service' | 'unresolved', keys: string[], via: string[] }
```

**不做的**：递归穿过 Repository/Resource 集合、数组拼装、`array_merge`。任何一层看不见
就是 `unresolved` —— 宁可少报，不出假阳（与 README 约束「无证据不报」一致）。

### 3.3 前端：字段读取两跳

```
1. 端点 → api 函数：request.get('/path') 所在的函数名（同文件符号）
2. api 函数 → 调用页：谁调用它，在 `.then(res => …)` / `await …` 的作用域里
   收集 res.data.<field> / r.<field> / response.<field>
每条读取带 source_kind（direct | via-caller）与 confidence
```

### 3.4 产出形态

| 两边状态 | 产出 |
| --- | --- |
| 两边都 resolved | 新规则 `fe-be-shape-field-missing`（warn）：前端读了、后端没返回的字段，逐字段列 evidence |
| 任一边 unresolved | **不报 findings**，checklist 行 `未核对` + 原因（`后端形状解析不到（service 深度超限）` 等） |
| 配对不可信 | 沿用现有 `fe-be-pairing-suspect` → 三行 + shape 行全部 `未核对` |

## 4. 验收标准（做完必须全绿）

1. `bench/fe-be-pair` 扩展：新增 1 个 service-delegating handler + 前端调用，其中
   **1 个字段故意不返回**；真值 = `fe-be-shape-field-missing: 1`、`shape resolved: L0+L1 = N`、
   `unresolved: M`，写进 fixture README 并由测试断言（与现有 2/1/3/0/1 同一套机制）。
2. 两边任一解析不到时，形状行必须是 `未核对`（单测覆盖，不许 `通过`）。
3. 真实配对上复测覆盖率并把数字写进本文件 §2：**L0+L1 目标 ≥ 60%**（起点 6%）。
   **实测判定：44%（见 §2.1），未达目标** —— 差距不是实现 bug，是 21 条无字面形状 + 13 条按策略不追的
   深度。见 §5 的 M1.1：**目标已下修至 L0+L1 的现实上限 45–50%**（真值 fixture 91% 证明解析器不是瓶颈）；
   要在真实仓上过 60% 需要 repository 层键语义核验，属 M4。
4. `npm test` / `selftest` / `audit` 全绿；`--mode standard` 输出体积不明显膨胀
   （形状只在 `--backend` 存在时出现）。

## 5. 里程碑

| 里程碑 | 内容 | 估时 | 可独立交付 |
| --- | --- | --- | --- |
| ~~M1~~ | `resolveHandlerShape` L0+L1 + fixture 扩展 + 测试 | **已完成 2026-10-30** | ✅ 交付物：`scripts/response-shape.mjs`、`scripts/shape-coverage.mjs`、9 项测试、§2.1 覆盖率 44% |
| ~~M1.1~~ | 把 44% 推过 60% 的判断题 | **已完成 2026-11-01，判定：目标下修** | ✅ 见下 |
| ~~M2~~ | 前端两跳字段收集 + 测试 | **已完成 2026-11-01** | ✅ `collectFrontendReads`：端点 → api 函数 → 调用方的 `res.data.*`；没有调用方 = `unresolved`（不是空 pass） |
| ~~M3~~ | 规则 + checklist 行 + 文档回填 | **已完成 2026-11-01** | ✅ `fe-be-shape-field-missing`（第 63 条规则）；两侧任一解析不到 → 行 `未核对`；fixture 真值 1 条 |

### M1.1 判定（2026-11-01，实测两条路线）

| 路线 | 实测 | 结论 |
| --- | --- | --- |
| ① 解析 collection/`toArray()` 形状（`service-has-no-literal-shape` 21 条） | **0/20 有任何数组痕迹**（`$var['k']=` 0、`->map/collect` 0、`->toArray` 0、什么都没有 20） | **放弃**：方法体里没有可读的东西，谈不上「解析」 |
| ② `depth-cap` 放行第 3 跳（全量 155 路由里 57 条） | **19/57 有字面键**（抽样：`LegacyAppVersionRepository`、`AdminLangService` 等） | **不默认放行**：第 3 跳多在 repository 层，键语义（行字段 vs 响应字段）未核验；只值约 +5 个配对对（44% → ~51%），**仍到不了 60%** |

**目标因此下修**：`L0+L1 的现实上限 ≈ 45–50%`（真值 fixture 上 91% 说明解析器本身没有瓶颈，
差的是真实代码的形状风格）。要在真实仓上过 60%，需要的是「repository 层键语义核验」，
那是 M4 级别的工作，不在本立项范围。

**M2 顺手修掉的两个实现 bug**：① binding 取名把 `export const coupons = () =>` 的首词
`export` 当成了函数名，导致所有调用方搜索落空；② `callRe` 少了 `g` 标志——`while (exec())`
一旦命中就会死循环。两者都有回归测试。

M1 过程中修掉的实现 bug：controller **同名类歧义**——真实仓有两个 `ThemeController`
（`Admin/…/Diy/` 与 `System/…/`），按短名取第一个导致 5 个 handler 报 `method-not-found`；
现在按「谁真的声明了该动作」择优，并把被否候选记进 `via`（有回归测试）。
这与 §4.1 的「解析不到就报 unresolved」是同一条纪律：**歧义必须暴露，不许静默选边**。

**当前状态（2026-11-01）**：M1–M3 全部完成并入主干。规则 `fe-be-shape-field-missing`
在真值 fixture 上产出 1 条（`pages/coupons.js:7` 读 `res.data.nope`），
`fe-be-pair.test.mjs` 与 `response-shape.test.mjs` 共 15 项断言；全量 `npm test`
396 run / 394 pass / 0 fail。覆盖率口径见 §2.1，目标已按 M1.1 判定下修。

## 6. 风险

- **假阳**：响应包装（`{code,data,msg}` 外层）会让 `data.<field>` 与 handler 顶层键不同名。
  缓解：M3 接入前先在真实对上人工核对 20 条；不确定就归 `unresolved`。
- **误判配对**：形状核对比路径核对更依赖配对质量（20.8% 已经贴着 20% 地板）。
  缓解：§3.1 硬约束，且真值 fixture 保证逻辑本身可测。
- **维护面**：多一条规则、多一个 resolver。缓解：全部在 `--backend` 路径上，默认不跑。
