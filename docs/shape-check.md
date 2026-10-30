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
4. `npm test` / `selftest` / `audit` 全绿；`--mode standard` 输出体积不明显膨胀
   （形状只在 `--backend` 存在时出现）。

## 5. 里程碑

| 里程碑 | 内容 | 估时 | 可独立交付 |
| --- | --- | --- | --- |
| M1 | `resolveHandlerShape` L0+L1 + fixture 扩展 + 测试 | 0.5–1 天 | ✅（覆盖率报告即可交付） |
| M2 | 前端两跳字段收集 + 测试 | 1 天 | ✅ |
| M3 | 规则 `fe-be-shape-field-missing` + checklist 行 + 文档回填 | 0.5 天 | ✅ |

M1 单独就能给出「真实仓里多少 handler 可解析」的答案——**先做 M1 再决定 M2/M3 的优先级**。

## 6. 风险

- **假阳**：响应包装（`{code,data,msg}` 外层）会让 `data.<field>` 与 handler 顶层键不同名。
  缓解：M3 接入前先在真实对上人工核对 20 条；不确定就归 `unresolved`。
- **误判配对**：形状核对比路径核对更依赖配对质量（20.8% 已经贴着 20% 地板）。
  缓解：§3.1 硬约束，且真值 fixture 保证逻辑本身可测。
- **维护面**：多一条规则、多一个 resolver。缓解：全部在 `--backend` 路径上，默认不跑。
