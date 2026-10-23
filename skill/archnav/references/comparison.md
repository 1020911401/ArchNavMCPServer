# ArchNav vs GitNexus vs Graphify — 实测对比

## 索引数据（同一 20 文件 JS 项目）

| 指标 | GitNexus | Graphify | **ArchNav** |
|------|----------|----------|-------------|
| 总节点 | 161 | 165 | **163** |
| 总边数 | 294 | 222 | **540** |
| 架构感知 | 11 社区(无命名) | ❌ 无 | **8 层命名** |
| 行级精度 | ❌ 无 | ❌ 文件级 | **✅ 每个符号** |
| Staleness | 二进制(stale/fresh) | ❌ 无 | **✅ 渐变 28%-100%** |
| 支持语言 | JS/TS (需 C++编译) | 36+ (WASM) | **✅ 12 语言** |
| Windows 兼容 | ⚠️ query tools 崩溃 | ✅ | **✅ 全功能** |
| MCP 协议 | 17 tools | ❌ | **✅ 9 tools** |
| 安装 | ~54MB + C++ build | ~30MB pip | **~15MB npm,零编译** |
| 验证模式 | ❌ 纯图谱数据 | ❌ 纯图谱数据 | **✅ read 读磁盘** |

## ArchNav 优势

1. **行级精度** — 每个符号 exact file:line_start-line_end
2. **渐变置信度** — 改代码后 100%→28%，GitNexus 只有 stale/fresh
3. **读代码验证** — read 从磁盘读真实代码再改
4. **12 语言零编译** — 纯 JS + WASM，Windows 开箱即用
5. **架构命名** — 8 层命名（GitNexus 只有未命名社区聚类）

## GitNexus 优势

1. **解析深度** — 14 阶段 pipeline (SRO/MRO/type inference)
2. **MCP 数量** — 17 vs 9（trace/context/cypher/route_map/rename）
3. **跨仓库组** — 多仓库联合分析
4. **PDG 数据流** — 程序依赖图

---

## 2026-10-14 复测：两个真实仓库（Laravel PHP + uni-app Vue）

方法：同一份代码副本三方各建一次索引；查询符号的“谁调用我”，用 grep 统计真实调用点做 ground truth。

### A. Laravel 后端（286 PHP，含 Blade 视图）

| 指标 | CodeGraph 1.6.2 | GitNexus 1.6.6 | ArchNav |
|---|---|---|---|
| 全量建索引 | **4.4s**（1,865 节点/2,285 边） | 27.6s（1,457 节点/2,286 边/59 簇/29 流程） | 17.9s（682 符号） |
| 索引体积 | 4.5 MB | — | 2.1 MB |
| `callers departments()`（真实 6 个调用方） | **6/6 ✅** | **6/6 ✅** | 0/6 ❌（PHP 无 CALLS 边） |
| 方法定义行号 | 56 ✅ | 55（差 1 行） | 56 ✅（带置信度） |
| `showSelectOptions` 调用方（真实 44 处，全在 Blade 视图） | 0/44 ❌ | 0/44 ❌ | — |
| 非 git 目录 | 可直接索引 | 需 `--skip-git` | 可直接索引 |
| 改 1 个文件后增量 | **sync 1.9–2.4s ✅** | analyze 17.1s（全量 27.2s）+ `detect-changes` ✅ | `status` 仍报 fresh ❌ |

### B. uni-app 前端（269 Vue / 64 JS）

| 指标 | CodeGraph | GitNexus | ArchNav |
|---|---|---|---|
| 全量建索引 | **4.8s**（5,985 节点/12,380 边） | 65.1s（6,826 节点/16,895 边/816 簇/300 流程） | **4.5s**（1,015 符号；DEPENDS_ON 7,495 / DEFINES_ROUTE 307） |
| 索引体积 | 17 MB | 102 MB | 3 MB |
| `callers orderTake`（真实 3 个 .vue 文件） | 0/3 ❌ | 2/3（漏 points_mall 里的嵌套调用） | 崩溃 ❌ |
| `callers getUserInfo`（真实 34 文件/44 处） | 2/34 ❌ | 9/34 | 崩溃 ❌ |
| `callers orderPay`（真实 2 个文件） | **2/2 ✅** | — | 崩溃 ❌ |

**根因**：CodeGraph 漏的是嵌套在对象字面量回调里的调用（`success: (res) => { orderTake(...) }`）；直接写在 methods 方法体里的调用（orderPay）它能抓到。ArchNav 的 `callers`/`impact` 在 uni-app 仓库报 `navigation.js:234 TypeError: imp.replace is not a function`。

**结论**：召回率 GitNexus > CodeGraph >> ArchNav（PHP）；速度与体积 CodeGraph > ArchNav > GitNexus。ArchNav 要参与对比，须先修 4 条已知限制（见 SKILL.md）。

---

## 2026-10-14 融合改造后复测（commit 8841cfe）

改动：新增 `src/resolver/*`（Blade 模板调用 / Vue 嵌套回调调用 / `@/` 别名导入）+ `src/resolver/integrate.js`（把 resolver 边并入图谱，id 约定与 analyzer 一致：`sym:<file>::<name>`，**symbol 的 file 原样透传，切勿 toPosix**——PHP 走 WASM 解析器是正斜杠、TS 解析器是反斜杠，归一化后会与 `callers()` 拼出的 id 不匹配）+ `src/engines/*`、`src/fusion.js`（多引擎合并）。

## 2026-10-14 ground truth 修正（commit fecc90f）

`bench/gen_ground_truth.mjs` 此前把「对象/类方法简写定义」（`getUserInfo() {`）当成调用点——这种写法声明的是**本地同名符号**，不调用外部函数。修正：

1. 新增 `JS_DEF_METHOD_RE = /(?<!\w)([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{/` 识别 `name(...) {` 写法。
2. `groundTruth()` 返回值多了 `methodDefs: []`，并把方法简写行跳过（与 definition 行同等对待）。
3. 测试断言跟着改：`getUserInfo` 调用点 **44 → 36**（少了 8 处方法简写），callerFiles **34 → 32**。被排除的 8 处全部手动核实过（Authorize.vue:99、libs/routine.js:80、scan_login:79、user_invoice_list:152、binding_phone:252、wechat_login:458、admin/orderDetail:956、admin/refund_order_detail:584），确认为同一符号的本地声明，非调用。

> 验证模式：跑分前先 `node bench/gen_ground_truth.mjs vue-app getUserInfo --show-method-defs` 看一眼被排除的行，确认它们真的是定义而非调用。未来改正则必须先把 ground truth 过一遍，再更新测试断言数字——否则会静默接受错误期望。

基准：`bench/php-app`（286 PHP / 76 Blade）、`bench/vue-app`（269 Vue / 64 JS），ground truth 由 `bench/gen_ground_truth.mjs` 现算。

| 指标 | 改造前最好 | 改造后（ArchNav） |
|---|---|---|
| `callers departments()` | 0/6（PHP 无 CALLS 边） | **6/6**，带 file:line |
| Blade `showSelectOptions` 调用点 | 0/40 | **40 处 / 19 个 blade 文件**（source_kind=template，conf 0.75） |
| `callers orderTake` | 崩溃 / 2 个文件 | **3/3 个 .vue**（注意两个同名 orderTake 分属 api/order.js 与 api/activity.js，要分别用 `--file` 查） |
| `callers getUserInfo` | 崩溃 / 9 文件 | **31/34 个文件**（harness 数的 34 里含 2 个只是本地同名方法，真实召回约 31/32） |
| 全量索引 | 17.9s php / 4.5s vue | **3.4s php**（WASM 运行时/语法/Query 按语言缓存后，5×）/ 11.9s vue（resolver 扫描占 ~10s，`ARCHNAV_NO_RESOLVER=1` 可关） |
| 内容改动后的 status | 永远 fresh | **stale + 置信度下降**（100% → 50%，看 fileHashes） |
| 同名符号 | 静默取第一个 | **ambiguous + candidates**，`--file/--kind` 消歧 |
| 测试 | 无 | `node --test` → 101 run / 99 pass / 0 fail / 2 skipped |

### 2026-10-14 第二轮修复（commit 2c38602）

| 修复 | 结果 |
|---|---|
| WASM 解析器每文件重建运行时/语法/Query | php-app 17.4s → **3.4s**，结果逐字节一致（682 符号/3595 调用，哈希写进测试） |
| Laravel 路由未解析（`routes/` 曾 0 符号） | 新增 `src/parsers/laravelRoutes.js`：158 条路由 / **155 条 `route:` 边**（source_kind:`route`），支持 `'C@m'`、`[C::class,'m']`、match/any/resource/apiResource（含 only/except）、嵌套 group+prefix；解析不到的进 `unresolvedRoutes`（实测 3 条，都是控制器真没 `create()`） |
| `impact()` 用文件名猜间接影响 | 改成图谱反向两跳：`departments` 的 depth2 从 2 → **7** 条，其中 5 条是 HTTP 入口（`GET /analysis/member → routes/web.php:98`）；结果带 depth/via/source_kind/confidence |
| ground truth 把方法简写定义当调用点 | `JS_DEF_METHOD_RE` 识别 `getUserInfo() {`；getUserInfo 44/34 → **36/32**，被排除的行以 `methodDefs` 暴露可审计 |
| Node 26 不展开裸目录 | `package.json` 加 `test`/`bench`/`analyze` scripts |
| 后台跑跑分 exit 1 且表格为空 | `spawnSync` 不再继承 stdin（`stdio:['ignore','pipe','pipe']`） |

新的坑：
- `refNodeParts()` 需单独处理 `route:` 前缀（否则符号列变成 URI 最后一段、file 列变成整个 id）；route 节点的 `file`/`line` 要去 `knowledgeGraph.nodes` 里取（已提供 `enrichRouteRelation()`）。
- Vue 侧 `file:` 节点**入边恒为 0** → depth2 结构性为空（页面/组件没有“被谁引用”的上层）。要做跨文件影响必须另外补“页面/路由 → 组件”这层。
- 实测终局：departments 4/4 三家平；Blade showSelectOptions **19/20 vs CodeGraph 0/20 vs GitNexus 0/20**；orderTake 3/3 vs 0/3 vs 3/3；getUserInfo **29/32 vs 1/32 vs 9/32**。

### 2026-10-15 第三轮：Vue 侧页面/组件层 + .vue 符号（commit 29714f5）

两个“既有缺口”的实测与修复：

1. **`.vue` 文件从未进过索引** —— `src/analyzer.js` 的文件发现正则里根本没有 `vue`，所以 269 个 .vue 从未被解析（symbols 1015 个**全部来自 .js**，`goPay` 这种组件方法根本查不到）。修：正则加 `vue` + 新增 `src/parsers/vueSymbols.js`（SFC 感知：options API 的 methods/data/computed/watch/props/生命周期 + `script setup` 顶层声明，行号按 block 偏移；4 个 strict TS parser 解析不了的 SFC 用 acorn-loose 兼容）。
   - 坑：**不要用 acorn 直接嗂 .vue** —— 它给回 `✖:3, default:36, data:66...` 这种垃圾且漏掉真实方法；必须走 SFC 脚本块。
   - 修后 vue-app symbols **1015 → 4625**（其中 3610 来自 .vue）。
2. **`file:` 节点入边恒为 0，Vue 侧 depth2 结构性为空** —— 新增 `src/parsers/uniPages.js`：`pages.json`（含 subPackages 拼 root、tabBar）→ `page:` 节点 + `page: → file:` 边；`uni.navigateTo/redirectTo/switchTab/reLaunch` 与 navigator → `file: → page:`；组件 `import '@/…'` → `file: → file:`。vue-app 实测：126 页面 / 313 跳转边 / 451 组件边 / 142 条 unresolved。`navigation.js` 加 `page:` 前缀渲染（`PAGE /pages/…`）与**所属文件上跳**后：
   ```
   impact goPay --file components/payment/index.vue
     🔴 Direct: 5 个引用组件的页面
     🟡 Indirect: PAGE /pages/annex/vip_paid/index → pages.json:1467 …（5 条）
   ```

同时修掉两个**新引入的噪声回归**（教训：新文件类型进索引后，旧的正则/启发式会失控）：
- analyzer 第 11 步的 Express 路由检测是个裸正则 `\.(get|post|…)('…')`，在 uni-app 仓上嗂出 **315 个假 route 节点**，且 node id 里嵌了绝对路径。现在限死“服务端文件名 + 服务端接收者（app/router/server/api/…）”，实测 **315 → 0**。
- `callers()` 的 import-basename 启发式从“无条件追加”改为“图谱无结果时才用、最多 5 条”：`callers orderPay` **40 → 5 行**，`callers orderTake` 也不再包含 2 条 import 假阳。

代价：vue-app 全量索引 **11.9s → 18.5s**（.vue 脚本被解析两遍：符号一遍、`scanModuleGraph` 调用边一遍）。下一步优化就从这里下手。

`node --test`：**117 run / 115 pass / 0 fail / 2 skipped**。

### 2026-10-16 多维度对比（bench/multi_dim.mjs，commit fd28240）

全量跑分（两个 fixture 索引都重建）：

| | ArchNav | CodeGraph | GitNexus |
|---|---|---|---|
| 索引 php-app / vue-app | **3.3s / 13.0s** | 7.7s / 16.6s | 23.0s / 45.4s |
| locate | 4/4（同名 8 定义回 `ambiguous`） | 4/4 | 4/4 但需 `-f` 消歧，行号差 1 |
| callers | **5/5** | 2/5 | 0/5（需 `-f`；3 条近似） |
| impact | 6 direct + 7 indirect | 11 affected | 12 impacted `risk=HIGH` |
| read | 345 / 8216 字符 | 836 / 12061 | 314 / 5016（`context --content`） |
| trace | **2/2（独有真实 trace）** | 无（拿 explore 凑） | 无（拿 query 凑） |
| arch | **7 / 3 层（唯一有层模型）** | 仅节点数 | 仅聚类 |
| status | 1.7s | 3.3s | **0.95s** |

结论定位：**召回（callers/trace/arch）ArchNav 赢；单次查询延迟 CodeGraph 最快；GitNexus 单查最慢（3.5s vs 1.3s）但只有它给变更风险分级。**

命令形状坑（每个都真实踩过，已写进 `bench/README.md`）：
- `codegraph status -p` 报 `unknown option '-p'`——路径传位置参数；`query -j` 返回**裸 JSON 数组**；`callers -j` 结果在 `definitions[].callers[]`。
- `gitnexus` 用 `-r <alias>`，**没有 `-p`**（`impact -p` 直接报错）；`context` 按关系分组，调用者在 `incoming.calls[]`（`j.callers` 是 undefined）；`impact -j` 字段是 `impactedCount`/`summary.direct`/`risk`；无 `.git` 的目录必须 `analyze --skip-git`。
- `archnav callers --file` 要**仓内相对路径**：传绝对路径不报错但过滤成 0 条（实测 6 → 0）；`archnav arch` 不接受 `--dir`（要位置参数）；`archnav impact` 对同名符号必须带 `--file`，否则可能回 `0 direct + 0 indirect`。
- **Windows 上绝不要用 `spawnSync(shell:true)` 跑 `grep`**：那是 `cmd.exe`，没有 grep；配 `|| true` 后失败完全静默 → 所有 ground truth 恒为 0。改成 Node 递归遍历。
- 非 TTY 下跑：`node bench/multi_dim.mjs < /dev/null`。
- `.gitignore` 原来把整个 `bench/` 忽略了，导致跑分脚本从没进仓库；现在只忽略 fixture / tools / 生成的报告。

召回表的口径注意：`callers` 召回对比的“mentions”是**包含该字符串的全部文件**（含路由名/注释/模板），是**上界**，不是精确分母；权威数字仍看 `run_bench.mjs` 的调用点 ground truth。

### 2026-10-16 深度（2 跳）召回 —— bench/deep_recall.mjs，commit dda3996

之前**从没验证过间接层的内容**：`impact` 只比过行数（6 direct+7 indirect / 11 affected / 12 impacted）。补上独立 2 跳真值后的结果：

| 用例 | 真值（独立于引擎） | ArchNav | CodeGraph | GitNexus |
|---|---|---|---|---|
| php `departments` | `routes/web.php`（两条路由分别 via member / transfer） | 2 行，含 web.php:98 → **1/1** | 1/1 但**无深度标注**，且把定义文件自身当受影响（假阳） | 1/1 |
| vue `orderPay` | 5 个 import 了 payment 组件的页面 | 6 行，真值 5 个全中 → **5/5 (100%)** | **0/5**（反而回了定义文件 api/order.js） | 深度 2 **0 行** |

真值构造（纯正则、不走引擎）：`深度1 = groundTruth(sym).callSites` → 每个调用点向上找最近定义行得到**中层符号** → `深度2` = ① 路由跳（`routes/*.php` 里 controller+action 能解到“深度1 文件里的方法”）② 组件跳（import 了中层符号所在文件；注意 uni-app 写 `@/components/payment` 会**省略 `/index.vue`**，两种名字都要发）。

真值构造自身的两个坑：
- **向上找定义行必须屏蔽控制流关键字**——`if (...) {` 会匹配方法简写分支，于是 `enclosing = if`，深度真值退化成“谁调用 if”（实测 272 个噪声文件）。
- **路由跳的文件名要写路由文件**（`routes/web.php`），不是控制器文件；写错时三家都会变成 0/2，看起来像“引擎全挂”，实际是断言错了。

结论：**深度召回上 ArchNav 是唯一在两层结构化跳（路由层 + 组件/页面层）都能拿全的**；GitNexus 在 vue 侧深度 2 完全为空；CodeGraph 能吃到路由但无法区分深度，且会把定义文件自己当受影响项。

### 2026-10-16 变更影响（diff 驱动）—— commit 95b55ab

三家能力对照：

| | 入口 | 输出 |
|---|---|---|
| GitNexus `detect-changes` | `git diff` hunk（scope: unstaged/staged/all/compare + `--base-ref`） | 已改符号 + **受影响执行流程** + 风险等级 |
| CodeGraph `affected` | 变动的文件名列表（可 `--stdin`） | **只算受影响的测试文件**（深度 5） |
| ArchNav `changes`（本节新增） | `git diff --unified=0` 同口径 | 已改符号 + 直接/间接影响 + **路由/页面层** + unmapped 文件 |
| CodeGraph `sync` | — | 增量重建索引（不是分析） |

同一 diff 实测（Laravel fixture 的 git 副本，改 `departments()` 内一行）：两家符号集合一致（`departments`、`Controller`）；ArchNav 给出 6 直接 + 7 间接（5 条路由），GitNexus 给 2 条流程 + `风险 medium`。**各有不可替代项：流程/风险只有 GitNexus 有，路由/页面跳与逐行证据只有 ArchNav 有。**

### 融合后同台跑分（`node bench/run_bench.mjs`，同一套 ground truth，三个引擎）

| repo | query | ArchNav | CodeGraph | GitNexus |
|---|---|---|---|---|
| php-app | callers departments | 4/4 (100%) | 4/4 (100%) | 4/4 (100%) |
| php-app | callers showSelectOptions（8 个 presenter 并集） | **19/20 (95%)** | 0/20 (0%) | 0/20 (0%) |
| vue-app | callers orderTake（api/order.js + api/activity.js） | 5/3 (100%，含 2 条 import-heuristic 噪声) | 0/3 (0%) | 3/3 (100%) |
| vue-app | callers getUserInfo | **29/34 (82%)** | 1/34 (3%) | 9/34 (27%) |

唯一漏的 Blade 文件是 `views/patients/create.blade.20230516.php`——过期备份视图，不算真漏。

注意 `callers()` 同时输出两路结果：图谱边（`source: call-graph:*`，带置信度）与旧的 import-basename 启发式（现标为 `source: import-heuristic`，置信度封顶 0.4）。实测 `orderTake --file api/order.js` 返回 3 条中 1 条是启发式假阳（mixins/skuSelect.js）——**消费结果时只看 `call-graph:*` 才能得到高精度**。

坑（都踩过）：
1. Node 26 **不展开裸目录参数** —— `node --test tests/engines/` 会当模块解析失败；用 `node --test`（根目录）或 `node --test "tests/x/*.test.mjs"`。**根目录**的 `package.json` 必须有 `"scripts.test": "node --test"` 才会被 Node 识别为测试目录。`run_bench.mjs` 已加 `stdio: ['ignore','pipe','pipe']`，spawn 的子进程不再继承 stdin，不再出现 `stdin is not a tty` 退出码 1。
2. `scanCallbackCalls()` 默认只返回 `kind==='callback'`，会把直接写在 methods 方法体里的调用（如 `getUserInfo()`）漏掉；需要时传 `{ allKinds: true }`（整合层用的是 `scanModuleGraph()` 一次解析同时拿 calls+imports，避免重复解析把 vue 仓索引从 12.7s 拉到 20.9s）。
3. 融合边只对「能被 import 解析到定义文件」的 callee 建边，否则 `uni.getUserInfo(...)`、本地同名方法这类会造出大量假调用方。
4. Blade 侧 343 个 `$var->method(` 里只有 48 个能解析到具体类+方法（variable 名推断 `$departmentPresenter` → `DepartmentPresenter`），其余 295 个是模型实例调用（`$data->sum(`）——**必须标 source_kind/confidence**，不能当成同等级证据。
