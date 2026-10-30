# 自审（dogfood）ArchNav 自己

对 archnav 自身跑审核层，是用真实代码验证规则层的方式，也是本仓库 finding 的主要来源。
本文件保存完整流程、假阳性分类与降噪结论；SKILL.md 只留索引。

## 1. 审一条未提交的改动（2026-10-23，54 → 25 → brief 模式 1 条）

工作区里未跟踪的新文件**已经算进 `changes`**（`--scope unstaged`/`all` 都会列），不需要 `git add -N`；
只有你绕过 ArchNav 直接跑裸 `git diff` 时，才要 `git add -N`（只记意图，不真正 add）。
注意 `--scope staged` 只含「已暂存 + 未跟踪」，审工作区改动时用它会是空 diff。

顺序很重要：**先 `analyze` 再审**。索引 6 天没重建时 `js-unresolved-local-import` 会把新建的文件全部报成
「解析不到」（candidates tried=7），拿那份结果当证据等于审了个旧仓。

`--json` 默认是压缩摘要（没有 message/evidence），逐条 triage 必须 `--json --no-compact`；
`--out` 旗标不存在，用重定向。

### 本轮抓到的六类假阳性（同一根因家族：拿原始文本当代码）

| 缺陷 | 真因 | 修法 |
|---|---|---|
| `js-unused-binding` 把已用绑定报成 occurrences=0 | 旧的「两段正则填空白」（先字符串再注释）被正则字面量 `/['"]/` 骗：引号开启幽灵字符串，吞掉后面整片代码 | `blankNonCode()` 单趟状态机（字符串/注释/**正则字面量**，长度不变→偏移不变）；绑定计数改用它 |
| `empty-catch` / `js-debug-left-on` 命中注释与字符串 fixture | 扫的是 `src` | 扫 `blanked`；且空 catch 要回读原文：括号内只有注释（`catch { /* 说明 */ }`）不算空 |
| `arity-mismatch` 有默认值的形参被当必填 | `treewalker` 生成箭头函数签名时丢了 `= 1` | `renderParam()` 保留 `= …`（`params[]` 仍是裸名） |
| `arity` 跨文件错认被调方 | 本地非导出 helper（`spawnImpl`/`key`）被当成别处定义 | `def.exported === false && def.file !== 当前文件` → skip（`exported` 缺失时保持旧行为） |
| `arity` 把字符串里的逗号当参数分隔 | `countArgs(src)` 数原始文本 | 在 `blankLiterals` 后的副本上数 |
| `joinPosix(base, target, '__init__.py')` 第三段被静默丢弃 | 只声明 2 个形参 | 改可变参数（Python 包式相对 import 才能解析到 `__init__.py`） |

`ai-todo-left`：注释标记紧跟在引号后 = 测试里写的字符串（`'// TODO: …'`），加负向前瞻即可；
顺手删掉「先这样」这类模糊中文词（普通 prose 会命中，docs 里本来也只承诺 TODO/FIXME/未实现/not implemented）。

判定为可接受噪声，不要为此改规则：`unmapped-change`（docs/*.md、package.json 无符号）、`no-test-coverage`、
`layer-model-missing`（scripts 仓无分层）、`js-same-name-method`（`parseArgs` 9 处、`renderMarkdown` 3 处，陈述属实）、
`ai-todo-left` 命中规则自己的描述性注释。

`git commit -m` 里的反引号会被 shell 当命令替换吞掉内容：message 写文件再 `git commit -F`。

降到可接受噪声，靠的是把规则的**粒度**改对，不是关规则（实测 25 → brief 模式 1 条）：

- `unmapped-change`：代码文件没符号仍是 warn（解析失败/没进索引/被 ignore）；文档·配置·资源合并成**一条 info**。
- `no-test-coverage`：只判可及面——非导出内部 helper 由父函数覆盖（图谱里它本来就没有入边）、`main` 是 CLI 入口，都跳过并在 evidence 写 `internals skipped=N`。
- `js-same-name-method`：额外要求**有文件真的 import 这个名字**（`parseArgs` 9 处 importer=0、`renderMarkdown` 3 处 importer=0，无人解析就不会选错文件）；PHP 侧照旧（控制器走路由不走 import）。
- `ai-todo-left`：标记必须**在真注释的行首**；注释区间由 blankNonCode 的 `onComment` 回调给出（字符串里的 `'// TODO: …'` 与句中提及都不算）。
- 两张副本别搞反：检测类规则读 `scannable`（**模板字面量也屏蔽**，否则测试里写的 Go fixture `if rows == nil` 会被当 JS 松散比较），绑定计数读 `blanked`（模板 `${…}` 里的使用是真使用，屏蔽了就会把 11 个在用的绑定报成 unused）。

剩下的 `layer-model-missing`（scripts 仓无分层）、`impact-risk`/`deep-module-risk`（standard/deep 模式自带）、`duplication-clone`（规则注册表与文档表格的结构性克隆，jscpd 报 renamed）是模式与仓库形状的事实，删掉等于撒谎。

## 2. 更早一轮的自审经验（2026-10-17，43 → 21 findings）

- **规则会命中自身的文档**：`docs/review-rules.md` 表格里写了 `catch {}` 示例被 `empty-catch` 命中。修法：文档类规则只跑代码扩展名（`.js/.mjs/.vue/.php` 等），不扫 `.md`。
- **测试样例字符串被当成真实 import**：`tests/review-rules.test.mjs` 里有 `'import request from \"./request\"'` 这样的字符串字面量，被 `js-unresolved-local-import` 解析为真实 import。修法：JS import 扫描锚定行首，并把模板字符串先抹掉内容再匹配。
- **CLI 脚本的 `console.log` 不算调试残留**：shebang 文件（`#!/usr/bin/env node`）用 `console.log` 作为界面输出是正常的，不该被 `js-debug-left-on` 命中。修法：shebang 文件豁免该规则。
- **TODO/FIXME 只在注释里算**：规则描述里写了 `TODO/FIXME` 字样，会被 `ai-todo-left` 误命中。修法：要求正则里有 `//|#/\\*|<!--|\\*` 注释前缀；但**引号后面的 `//` 不算注释开头**——`'// TODO: …'` 是字符串字面量，规则必须用负向前瞻排除它，否则字符串里的描述会被当成待补的代码。
- **同名方法判断要分"导出"还是"本地"**：每个脚本都有自己的 `parseArgs`/`main`/`norm` 本地 helper，如果只看"≥2 个同名定义"就全部炸开（本仓 11 条，真歧义只有 1 条 `callers`）。修法：同时要求 ≥2 个**导出**定义才算歧义（用 `exported` 字段统计）。
- **`empty-catch` 只抓真空**：`// prose: catch (e) {}` 和 `"catch (e) {}"` 都不能算；括号内有注释说明原因（`catch { /* malformed json: skip */ }`）也不算空。修法：先对源码做 `blankNonCode()` 再做 `catch {}` 匹配，然后回读原文确认大括号内只有注释时跳过。
- **`blankNonCode()` 是绑定计数的底层基础设施**：旧版用两段正则分别抹字符串/注释/正则，遇到 `/['"]/` 这种内含引号的正则字面量时，正则结束符被当成字符串开头，后续整片代码被替换成空白 → `js-unused-binding` 对 `keepName`/`isPageDir`/`pkgSrc`/`unimp` 全报 occurrences=0。修法：改成字符级状态机（正常/字符串/注释/正则三种状态、偏移量严格一一对应），所有计数规则改用 blanked 副本。
- **`arity-mismatch` 的假阳性来自三处**：① 签名里的默认值被分析器抹掉 → `finding = (rule, severity, file, line = …) =>` 变成四参，`finding(4)` 被报 arity 超标；修法：新增 `renderParam()` 保留 `= …`。② 调用点在别的文件，定义却是同仓另一文件的非导出函数 → 跳过（非导出 + 非同文件 = 不是它的定义）。③ 实参里的字符串包含逗号 → `countArgs` 原来数原始文本，现在数 blanked 副本，字符串内的逗号被屏蔽。
- **`joinPosix` 必须支持三段以上**：Python 相对导入 `from .sub import thing` 需要拼 `base/sub/__init__.py`，原来只接两个形参会丢掉 `__init__.py`。修法：改成可变参数 `(...segments) => joinPosix(dir, ...specs.join('/'))`，两参调用完全兼容。
