# 审核层手册（规则 / 覆盖度 / 边界 / 设计取舍）

> 这份文件取代了原来的 `code-review-rules.md` + `pitfall-coverage.md` + `review-rules-guide.md`（三份都在讲同一件事，且开始相互矛盾）。引擎对比跑分单独留在 `references/comparison.md`——那是**证据**，不是运行依赖。

## 0. 运行方式

```bash
node scripts/review-rules.mjs . --scope staged                        # brief（默认，≈0.5K tokens）
node scripts/review-rules.mjs . --scope compare --base main \
  --mode standard --markdown review.md --sarif review.sarif --gate    # PR 前（≈3.4K）
node scripts/review-rules.mjs . --mode deep --deep-cluster-level symbols  # 仓库级（≈3.9K）
node scripts/review-rules.mjs <前端仓> --backend <后端仓> --scope staged   # 接口边界
node scripts/test-select.mjs . --scope staged                         # 该跑哪些测试
node src/index.js analyze . --ignore "bench/**,**/vendor/**"          # 建索引时排除（索引会记住，status 也遵守）
```

- **模式**：`brief`（只跑高信号规则、只列命中、JSON 紧凑，3 文件 diff 实测 1.5KB）/ `standard`（完整任务书 + 影响面 + 重复代码，10.2KB）/ `deep`（+ 流程/聚类/循环/模块风险，11.6KB）。显式 `--impact/--deep/--duplication` 会自动升级到至少 standard；`--all-rules` 重开被降级的上下文规则；`--compact/--no-compact` 控 JSON。
- **门禁**：`--gate`（**只看 error 级**）、`--dup-max-new-clones N`（只算本次新引入的克隆，jscpd 基线）、`--impact-max-risk` / `--module-max-risk`（opt-in）。
- **产物**：SARIF 2.1.0（每条 result 必须有 location，否则 code scanning 拒收）、`::error file=…,line=…` 注解、markdown 任务书（PR 评论 / Step Summary）。
- **CI**：`.github/workflows/review.yml`，PR 用 `--scope compare --base origin/<base>`，push 用 `--base HEAD~1`（否则干净检出会报“改动 0 文件”）；流程：fixture-independent 单测 → analyze（`--ignore` 见下）→ selftest → 任务书（`--mode deep`）→ summary → SARIF 上传 → PR 评论 → 产物。
- **不依赖外部引擎**：默认 engine 是 archnav；CodeGraph/GitNexus 要显式 `engine` 或 `auto` 才启动。

## 1. 任务书与栈检测

每条规则一行：`✅ 通过`（跑了没命中）/ `⚠️ 命中(N)` / `➖ 不适用(+原因)`；不适用必须给理由（本次无 PHP/Python 改动、未给 `--backend`、无 package.json/composer.json、仓库无测试、索引不可用、本次无改动）。

**栈检测**（有证据才启用）：`package.json`→node；`composer.json`/route 节点→laravel；`pages.json`/page 节点→uni-app；`requirements.txt`/`pyproject.toml`/改到 .py→python。前端仓没给后端索引会提示加 `--backend`。

## 2. 规则目录（级别 / 实测命中率 / 设计取舍）

**结构（core）**：`unmapped-change`（改了但无符号→行级证据不可用）、`backup-file-changed`（副本/.bak/日期后缀；实测抓到 `HomeController - 副本.php`）、`layer-model-missing`（有符号但 `layerMap` 空→分层规则无法判本仓）、`no-test-coverage` / `repo-has-no-tests`（仓库 0 测试文件时只报一条 info，不逐符号刷）、同名方法（PHP/JS，**要求 ≥2 个“导出”定义**才算歧义：每个脚本自己的 `parseArgs`/`main` 不再刷屏，11→1）。

**PHP/Laravel**：`php-route-unknown-action`(E，路由指向不存在的方法=404)、`php-blade-unescaped-output`(W，`{!! !!}` 原样输出=XSS；**每文件一条带计数**，Laravel fixture 实测 76 个 blade 里 40 个有、共 119 处)、`php-mass-assignment`(W)、`php-raw-sql-interpolation`(E，**只认双引号插值/拼接**，单引号 `'x = $q'` 是字面量不报)、`php-dangerous-function`(E)、`php-hardcoded-secret`(E，排除校验串/占位符)、`php-unvalidated-mass-input`(W，`$request->all()` 且无 validate/FormRequest/`XxxRequest $`；19→2)、`php-unknown-class-import`(W，PSR-4)、`php-debug-left-on`(W，`$q->dump()` 不算)、`php-blade-unverified-calls`(I)、`php-n-plus-one`(W/I，启发式，请求路径 warn)、`php-unbounded-query`(I)、`php-loose-comparison`(W，extended；34 文件)、`php-read-modify-write`(W，读-改-写同一字段→并发丢更新；fixture 2 文件)、`php-idor-missing-authorization`(I，带 `{id}` 的路由且控制器里看不到 authorize/Gate/policy/abort_unless/owner-check——**复核提示而非结论**，锟权可能在中层件里)。

**JS/Vue/uni-app**：`vue-page-not-registered`(E，178 里 52 未注册)、`vue-nav-unknown-page`(E，15)、`vue-nav-dynamic-url`(I，extended，124)、`vue-component-orphan`(W，50 里 4)、`vue-unresolved-import`(W)、`vue-v-html`/`js-innerhtml`/`js-dangerous-function`(19/2/2)、`js-debug-left-on`(W，extended；**有 shebang 的 CLI 豁免**，console.log 是它的界面)、`js-loose-equality`(I，extended；160/333 文件→默认关)、`vue-vfor-missing-key`(W，属性窗口判定：整行判定给 157，实际 11)、`vue-global-blast`(I，extended)、`js-unresolved-local-import`(W，**锚定行首** + 先抹掉模板字符串)、`hallucinated-dependency`(W)、`vue-mutating-props`(W，`this.<声明的 prop> =`；fixture 1 文件)、`vue-v-if-with-v-for`(W，14 文件——Vue2 里 v-for 优先于 v-if)、`vue-timer-leak`(W，setInterval 而全文件无 clearInterval；2 文件)、`js-unused-binding`(W=import 未使用 / I=声明后从未读取；遗留仓 108/329 文件→因为只扫改动文件，单次 PR 只有几处)。

**Python**：`py-dangerous-function`(E)、`py-raw-sql`(E)、`py-hardcoded-secret`(E)、`py-bare-except`(W)、`empty-catch`(W，复用同一个 id 匹配 `except: pass`)、`py-mutable-default-arg`(W)、`py-debug-left-on`(W)、`py-requests-no-timeout`(W)、`py-unresolved-local-import`(W，相对导入层数/模块名解析)、`py-import-star`(I，extended)；`hallucinated-dependency` 在 Python 侧读 requirements/pyproject（**名字容差**：`python-dotenv` → `import dotenv`；**没有清单文件时保持沉默**）。

**AI 代码气味**：`empty-catch`（JS/PHP `catch {}` 与 Python `except: pass`；括号内有注释说明原因不算空；只跑代码扩展名）、`ai-todo-left`（I，**只认注释上下文**，且注释前缀不能紧跟在引号后面——`'// TODO: …'` 是字符串不是注释，否则规则自己的正则文本会被自己命中）、`arity-mismatch`（W=少传必填参数 / I=多传；调用点参数量 vs **唯一定义**的签名：跳过方法调用/关键字/两字母以下标识符/vendored 树，**.php 不在范围**——WASM 解析器把默认值拉平进参数表，required 无法判定；**非导出函数的签名不会跨文件当作被调方的定义**；默认值用 `= …` 占位保留，避免把有默认值的形参当必填）。\n

**Go**：`go-ignored-error`(W，丢弃返回值——通常是 error；**每文件一条 + 出现次数**，避免一条报告把 11 处吞掉)、`go-panic-in-library`(W，非 main 包 panic；**每文件一条 + 出现次数**)、`go-sql-injection`(E，拼接/Sprintf 构造 SQL；**大小写不敏感**，覆盖 `db.query`/`db.Query`/`tx.exec` 等写法)。**已用 cobra（36 .go）+ sqlx（16 .go）两个真实仓对过 grep 独立真值**：ignored-error 在两个仓的非测试/测试文件数均一致；panic-in-library 非 main 包文件数 3/5 一致；sql-injection 零误报。**自测锁定**（`scripts/selftest.mjs` 造 `internal/store/store.go` 含三种缺陷，断言三条 rule + 任务书 Go 行 status=hit）；CI 全绿。

**前后端边界（需 `--backend`）****：`fe-be-pairing-suspect`(W，匹配率<20% 时只报这一条，不吐几百条假 404)、`fe-be-path-not-found`(E，前端在调后端没这条路由)、`fe-be-method-mismatch`(E)、`fe-be-route-unused`(I)、`fe-dynamic-request-path`(I)。

**仓库级**：`impact.blast/routes/pages`（depth/via/source_kind/confidence）、`impact-risk`(W)、`deep.flows/clusters/module-risk/cycles`、`deep-module-risk`(W)、`duplication-clone`(W，exact/renamed/similar/gap + 基线只算新增)、`dup.provenance`（`duplication.mjs --provenance`：**GitClear 口径的本地版**——新增行里有多少与仓库既有行逐字相同（复制），以及 git 的 rename/copy summary（搬移）。与 jscpd 是**两个不同问题**：jscpd 问“这两块长得像吗”，provenance 问“这些新行原来就存在吗”，搬移的块 jscpd 看得见而 provenance 不算复制）。

**污点**：`taint-source-to-sink`（W/exec 类为 E）：文件内追踪——外部输入（PHP `$request->input/get/all`、`$_GET/$_POST`；JS `req.query/body/params`、`location.search`；Python `request.args/form/json`、`input()`）赋给变量后直达 sink（echo/print、`whereRaw/DB::raw`、`exec/eval`；`innerHTML/document.write/v-html`；`.execute()`、`os.system/shell=True`）；同一行出现 `htmlspecialchars/e()/intval/(int)/strip_tags/validate` 或 `encodeURIComponent/Number/parseInt/textContent=` 或 `html.escape/int()` 则不报。**边界写在 finding 的 why 里**：只按变量名、只在同一文件、不跨函数、不认自定义转义函数——跨函数数据流用 `--semgrep`（Semgrep taint，`--config auto`）；**Semgrep 解析顺序实测（2026-10-17 修好）**：`$SEMGREP_BIN` → PATH 上的 `semgrep` → **由 python 报出的 console scripts 目录**（默认 scheme + user scheme 两个都试；`pip --user` 装到 `%APPDATA%\Python\Python314\Scripts`，不在 PATH，解释器自己的 Scripts 目录里根本没有）→ `python -m semgrep`（≥1.38 直接拒绝运行：退出码 2 + 弃用提示，只能兜老版本）。Windows 上 `semgrep.exe` 是启动器，它会按名字拉起 `pysemgrep`，所以要把该目录**前置进子进程 PATH**；同目录的 `pysemgrep.exe` 不需要。装不到或跑不起来时任务书写 `➖ taint.semgrep` 并带**真实原因**（退出码 + stderr 首行）——旧版在这里会写 `status: pass`，读起来像"没发现污点"，等于撒谎。

**依赖漏洞**：`scripts/audit-deps.mjs`（`--audit`）：直问 **OSV**（不是 `npm audit`）——实测本机 registry 是 npmmirror，`/-/npm/v1/security/advisories/bulk` 直接 `404 NOT_IMPLEMENTED`，也就是说 `npm audit` 在这台机器上不论如何都是"0 漏洞"的假结论；composer/govulncheck/pip-audit 则都没装。OSV 走普通 HTTP，npm/Packagist/Go/PyPI 四个生态共用，与 govulncheck 同源。实测：本仓（90 个已固定依赖）→ 5 条公告（brace-expansion）；lodash@4.17.4 + minimist@0.0.8 → 12 条（含 Command Injection / Prototype Pollution）。没 lockfile / 未固定版本 / OSV 查询失败各自一行 `➖ 不适用` 并带原因与修法提示；存量依赖风险默认 warn/info（不是本次 diff 引入），要门禁用 `--fail-on-cve high|critical`。

**误报防护（都实测过，别再退回朴素写法）****：文档里描述 `catch {}` 被当代码扫 → 代码气味规则只跑代码扩展名；测试样例里的 `"import … from './x'"` 被当真实 import → 行首锚定 + 模板字符串先抹；规则自身的正则文本被自己匹配 → TODO 只认注释 / debugger 要求语句形态；`where('x','!=',1)` 这类字符串里的操作符 → 先 blank 字符串与注释；PHP 规则不得扫前端（`isPhp` 门）、前端规则不得扫 PHP。

## 3. 本地深查的边界（五条，代码强制）

1. **默认关**（仅 `--mode deep` 或显式旗标；brief 不构建）。2. **无证据不报**（每条带 depth/via/source_kind/confidence；heuristic 边与无行号占位符的流程步丢弃——否则 Laravel 首跑 40 步大半是 `find/all/update` 噪声）。3. **仓库级既有状态永不单独拦构建**（模块风险/循环只作 warn；要拦显式 `--module-max-risk`）。4. **门禁阈值必须实测标定**（新克隆门禁=6：合法规则表新增产生 4 个 renamed 克隆，而真实事故是 1 个 exact 克隆）。5. **可单独删除**（lazy import；自测断言默认输出不含深查分组）。

**明令不做**：Cypher 查询（产品面：语法/文档/注入面）、PDG/污点数据流（需真 SSA 前端，编出来的边污染全部下游数字→用 Semgrep taint）。

## 4. 坑位覆盖度（语言级 + AI 特有）

| 类别 | 状态 |
|---|---|
| PHP/Laravel 16/16 | 已覆盖：注入、危险函数、批量赋值、未校验 all、硬编码凭据、松散比较、路由 404、调试残留、副本文件、N+1、无分页、同名方法、Blade 证据边界、`{!! !!}` 未转义输出（40/76 文件）、**IDOR 复核提示**、**读-改-写并发**。唯一保留的说明：IDOR 只到“看不见锟权调用”的提示级（锟权链可能在中间件/策略，必须人确认） |
| Vue/uni-app 14/14 | 已覆盖：v-for 缺 key、v-html/innerHTML/eval、页面未注册、跳转 404、动态 URL、孤儿组件、别名 import、console 残留、空 catch、松散相等、**props 直改**、**v-if+v-for 同元素**、**定时器泄漏**、**未使用绑定**。说明：props/模板类规则是文本级（非模板语义分析），极复杂的 SFC 写法可能漏 |
| AI 特有 11/11 | 已覆盖：幻觉依赖（JS/Python）、幻觉本地/别名 import、幻觉 PHP 类（PSR-4）、占位实现、吞异常、调试残留、安全缺陷、无测试/测试选择、参数级 API 误用（arity）、**新增重复（两条轴：jscpd 克隆分类 + provenance 复制/搬移）**。残留说明：provenance 是**行级**（不是块级相似度），块级相似仍由 jscpd 的 similar 模式回答 |
| 外部工具（2026-10-17 接入） | **依赖漏洞审计**：`--audit`（OSV，四生态）✓ 真实跑过；**跨函数污点**：`--semgrep` 透传（本机未装 semgrep→实测优雅降级为 `➖ 不适用`）；文件内污点追踪已是内置规则 `taint-source-to-sink` |
| 其他语言 | **Go 3/3 已覆盖**：值丢弃（含出现次数）、非 main 包 panic（含出现次数）、拼接 SQL（大小写不敏感）；已用 cobra + sqlx 两个真实仓对过 grep 真值、自测锁定到 CI。Rust/Java/C#/Ruby/Shell 等仍只有图谱能力，无语言级规则。 |

## 5. 外部判定源：GitClear 能不能“调”

能——有 Public REST API（`https://www.gitclear.com/api/v1/…`，`Authorization: Bearer <token>`，token 在 Settings→API Dashboard；已验证探针 `GET /api/v1/api_tokens`；端点组含 Reports / Segment Introspection / Data Audit / Code Introspection / Import repo 等）。**但**：要付费订阅、仓库必须先导入、指标在服务端算 → 只能当“报告拉取/事件回写”的上游，不能进本地/离线管道；且没有 token 时其 Reports schema 无法端到端验证（不要凭猜写端点）。

**本地等价物**：jscpd（`scripts/duplication.mjs` 包装）。**克隆谱系实测（bench/php-app, min-lines 10）**：exact 24.79% / gap 26.96% / similar(AST) 30.28% / **renamed 59.87%（769 个）**——只跑 exact 会低估约 2/3；`--semantic`(Type-4) 需本地模型(约 548MB)或 embeddings API。基线轴比阈值更重要：`--baseline-from-ref`/`--changed` + `isNew` 才是“本次引入”，`--changed-only` 只拿改动文件互比（单个新文件什么都找不到，别用）。

## 6. 能力边界（图谱给不出答案的地方）

- **动态拼接路径**：`request.get('x/' + id)`、`uni.navigateTo('/pages/a/' + t)`（前端 124 处）→ 影响面无法静态确定。
- **Blade 模板调用**：343 处里只绑定上 48 处（靠变量名猜类名），所以“模板里没人调用我”不能当删方法的安全证据。
- **PHP 动态调用 / JS 回调里的间接调用**：会漏。
- **`:key` 表达式**（uni-app 非 H5 不支持）只查到“有没有 key”。
- **测试覆盖图**依赖测试文件 import 被解析到；测试靠 CLI spawn 的覆盖路径看不到。

## 7. 凭什么信它

- 单测：**220 run / 218 pass / 0 fail / 2 skipped**（跳过的 2 个需要 bench fixture，fixture 不进 git）；注册规则 **80+ 条**（含 taint；deep+audit+semgrep 模式下任务书 81 行）。
- **外部工具接入**：`--audit`（OSV 依赖漏洞）与 `--semgrep`（跨函数污点）都不在默认模式里，要显式加旗标；两者不依赖本地安装（OSV 是 HTTP；semgrep 不在就明说）。
- 自测：`scripts/selftest.mjs` 造一个含全部栈的临时仓、注入真实缺陷、逐项验证并打印 ✅/❌ 与证据（含“brief 输出不含深查分组”这条边界断言）。
- CI：PR 与 push 两类事件都跑（push 用 `--base HEAD~1`），PR 评论贴任务书、SARIF 进 code scanning。
- 每条 finding 都带 **why**（坑是什么）与 **evidence**（计数/匹配文本/file:line），所以评审人可以不同意工具。
- **`analyze --ignore`**：`bench/` 这种仓内 fixture 目录必须排除，否则自审会把 fixture 目录算成自己的（5846 符号/5069 findings vs 458/21）；索引会记住 ignore 且 `status` 同步遵守。
