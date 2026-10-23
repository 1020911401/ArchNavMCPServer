# 语言自动识别（detectStacks）

`review-rules.mjs` 自动调用 `detectStacks({dir, index, changedFiles})`，从标志文件 + 索引节点种类 + 改动扩展名分布判定仓库语言画像，写入表头 `栈 <profiles>（依据 <evidence>）　改动 <langs>`。

## 信号

| 信号 | 判定 | 证据示例 |
|---|---|---|
| 根目录有 `composer.json` 或 `routes/web.php` 含 `route:` 节点 | php/laravel | `evidence: ['routes/web.php: route: GET /api/home']` |
| 根目录有 `package.json` 含 `@uni-app` / `.vue` 扩展名分布 >50% | vue/uni-app | `evidence: ['src/pages/index.vue']` |
| 前端仓无后端索引，且有 `request.get/post/...('path')` | 建议前后端配对 | `suggestsBackend: true` |

## 影响

规则门控（`family: php/front`）、分析器启动（`route:`/`page:` 节点是否存在）、不存在的入口类型报告 `➖ 不适用 + 原因`。

## 单测

`tests/review-rules.test.mjs` 里的 "stack detection switches features by language" 用例验证：Laravel 仓 evidence 含 route 节点、前端仓 `suggestsBackend=true`、表头渲染包含 `栈 uni-app` 字样。
