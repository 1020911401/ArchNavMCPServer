# Review rules — handbook

What `scripts/review-rules.mjs` checks, how it reports, and what it deliberately does
not do. Every number here was measured; the harness that produced it and the raw
comparison live in [`bench/README.md`](../bench/README.md) and
[`bench/`](../bench) (Laravel fixture: 286 PHP / 682 symbols / 158 routes; uni-app
fixture: 333 JS+Vue / 4 625 symbols / 126 pages).

## Running it

```bash
# cheap path — the default: high-signal rules, findings only, compact JSON
node scripts/review-rules.mjs . --scope staged

# full task sheet before a PR (+ SARIF + PR comment + gate)
node scripts/review-rules.mjs . --scope compare --base main \
  --mode standard --markdown review.md --sarif review.sarif --gate

# repo-level depth (flows, clusters, cycles, module risk)
node scripts/review-rules.mjs . --mode deep --deep-cluster-level symbols

# front-end ↔ back-end API boundary (needs both indexes)
node scripts/review-rules.mjs <front-repo> --backend <backend-repo> --scope staged

# which tests does this change reach?
node scripts/test-select.mjs . --scope staged
```

| mode | tier | sections | measured cost (3-file diff) |
|---|---|---|---|
| `brief` (default) | core rules only | findings | 1.5 KB ≈ 0.5 K tokens |
| `standard` | all rules | task sheet + 影响面 + 重复代码 | 10.2 KB ≈ 3.4 K |
| `deep` | all rules | + 代码库深查 (flows/clusters/cycles/module risk) | 11.6 KB ≈ 3.9 K |

Flags that matter: `--all-rules` (re-enable the context rules), `--compact` /
`--no-compact` (JSON payload), `--no-checklist` (findings only), `--gate` (exit 1 on
error-severity findings), `--dup-max-new-clones N`, `--impact-max-risk`,
`--module-max-risk`, `--json`, `--markdown`, `--sarif`, `--github`.

Scopes: `unstaged` (default) · `staged` · `all` · `compare --base <ref>`. Untracked
files always count as changed; without git the run falls back to content drift and says
so in a `note`.

## The task sheet

Every rule gets one row — `✅ 通过` (ran, nothing found) / `⚠️ 命中(N)` / `➖ 不适用(+原因)`.
Skipped rules must explain themselves: no PHP in this change, no `--backend` given, no
`package.json`, no test files in the repo, index unavailable, nothing changed.

```
📋 审核任务书 — <repo>
   改动文件 9（PHP 0 / 前端 8 / 其他 1）　索引 5783 符号　后端索引 未提供
   规则 54 条：✅ 通过 20　⚠️ 命中 12　➖ 不适用 22
   栈 node（依据 package.json）　改动 .mjs×5 .yml×1 .md×1
   ── 结构 ──   ── 测试 ──   ── PHP·安全 ──   ── 前端 ──   ── AI·幻觉 ──
   ── 边界 ──   ── 影响面 ──   ── 重复代码 ──   ── 代码库深查 ──
```

**Stack detection** (evidence-based) picks what is worth running: `package.json` → node,
`composer.json` + route nodes → laravel, `pages.json` + page nodes → uni-app,
`requirements.txt` / `pyproject.toml` → python. A front-end repo without a backend index
gets the hint to add `--backend <backend-repo>`.

## Rules

Severity: **E** = error (gates), **W** = warn, **I** = info. `core` rules run in every
mode; `extended` rules are opt-in via `--all-rules` because they fire on a large share
of a legacy repo (the measured rate is in the last column).

### Structure / cross-cutting (core)

| rule | sev | fires when | measured |
|---|---|---|---|
| `unmapped-change` | W | a changed file has no indexed symbol (templates, config, assets) — line-level evidence is unavailable | Laravel fixture: Blade files |
| `backup-file-changed` | W | the changed filename looks like a backup/copy (`副本`, `.bak`, `.20211102.php`, …) | caught `HomeController - 副本.php` + `index.blade.20211102.php` |
| `layer-model-missing` | I | the index has symbols but no `layerMap` — architecture rules cannot judge this repo | fired on Laravel before the `/i` fix |
| `no-test-coverage` / `repo-has-no-tests` | W / I | changed symbols no test reaches / the repo has no tests at all (reported once, not per symbol) | demo repo: 2 uncovered symbols |
| `php-same-name-method` / `js-same-name-method` | W | a changed symbol name has ≥2 definitions (locate/callers need `--file`) | PHP `store` ×15, `index` ×19; JS `orderTake` in `api/order.js` + `api/activity.js` |

### PHP / Laravel

| rule | sev | fires when | measured on the fixture |
|---|---|---|---|
| `php-route-unknown-action` | **E** | a changed controller (or `routes/*.php`) is in `unresolvedRoutes` — the route points at a method that does not exist | 3 real cases (`VisitsController::create`, …) |
| `php-mass-assignment` | W | a changed model `extends Model` without `$fillable`/`$guarded` | read from disk |
| `php-raw-sql-interpolation` | **E** | `whereRaw`/`DB::raw`/… with double-quoted interpolation or concatenation (single-quoted `'x = $q'` is a literal in PHP, not flagged) | 0 |
| `php-dangerous-function` | **E** | `eval`/`exec`/`shell_exec`/`system`/`passthru`/`proc_open`/`unserialize`/`extract` | 0 |
| `php-hardcoded-secret` | **E** | password/secret/api_key/token assigned a literal (validation strings and placeholders excluded) | 0 after guards (was 5 false positives) |
| `php-unvalidated-mass-input` | W | controller uses `$request->all()` with no `validate()`/FormRequest/`XxxRequest $request` in the file | 2 (was 19 before the type-hint guard) |
| `php-unknown-class-import` | W | `use App\…` with no matching file under the composer PSR-4 map | needs `composer.json` |
| `php-debug-left-on` | W | `dd()`/`dump()`/`die()` (not `$q->dump()`) | 0 |
| `php-blade-unverified-calls` | I | a changed Blade has more `$x->y()` calls than the graph can bind | 18 calls / 0 bound on `hospitals/edit.blade.php` |
| `php-n-plus-one` | W / I | a query call inside a `foreach` body (warn on request paths, info elsewhere) | 11 files |
| `php-unbounded-query` | I | a controller has `->get()`/`::all()` and no `paginate()` anywhere | 4 files |
| `php-loose-comparison` *(extended)* | W | `==` / `!=` outside string literals and comments (PHP type juggling) | 34 files |

### JS / Vue / uni-app

| rule | sev | fires when | measured on the fixture |
|---|---|---|---|
| `vue-page-not-registered` | **E** | a changed `pages/**/*.vue` (not under `*/components/`) is absent from the pages.json page set | 52 of 178 page files unregistered |
| `vue-nav-unknown-page` | **E** | the changed file has `unknown-page` navigations — the target does not exist | 15 |
| `vue-nav-dynamic-url` *(extended)* | I | dynamic concatenated navigation URLs — impact cannot be determined statically | 124 |
| `vue-component-orphan` | W | a changed `components/**/*.vue` nothing imports | 4 of 50 |
| `vue-unresolved-import` | W | an alias/omitted-`index.vue` import that does not resolve | 3 |
| `vue-v-html` / `js-innerhtml` / `js-dangerous-function` | W / W / **E** | `v-html=`, `.innerHTML =`, `eval(` / `new Function(` | 19 / 2 / 2 |
| `js-debug-left-on` *(extended)* | W | `console.log` / `debugger` left in | 23 files |
| `js-loose-equality` *(extended)* | I | `==` / `!=` in a condition/return/ternary (string literals and strict equality are ignored) | 160 of 333 files — why it is opt-in |
| `vue-vfor-missing-key` | W | a `v-for` opening tag (attribute window, multi-line aware) without `:key` | 11 files (naive per-line matching gave 157) |
| `vue-global-blast` *(extended)* | I | the change touches `store/` or `mixins/` | 13 impacted symbols for `mixins/skuSelect.js` |
| `js-unresolved-local-import` | W | a relative/alias import that resolves to nothing | 6 (e.g. `./u-charts.js` while the repo has `ucharts.js`) |
| `hallucinated-dependency` | W | a bare import not in `package.json` (or `requirements.txt` for Python) | needs the manifest |

### AI-code smells

| rule | sev | fires when |
|---|---|---|
| `empty-catch` | W | an empty JS/PHP `catch {}`, or Python `except: pass` — errors swallowed with no log |
| `ai-todo-left` | I | `TODO`/`FIXME`/`未实现`/`not implemented` left in the changed file |
| `py-*` (9 rules) | E/W/I | Python: `eval`/`exec`/`pickle`/`os.system`/`shell=True` (E), SQL f-string/`%`/concat (E), hardcoded secret (E), bare `except:` (W), `def f(x=[])` (W), `breakpoint()`/`pdb.set_trace()` (W), `requests.*` without `timeout=` (W), unresolved local import (W), `from x import *` (I, extended) |
| `py-unresolved-local-import` | W | `from .mod import x` / `from app.mod import x` where no file matches |

### Front-end ↔ back-end boundary (needs `--backend`)

| rule | sev | fires when |
|---|---|---|
| `fe-be-pairing-suspect` | W | match rate < 20% — the two indexes are probably not a front/backend pair; individual findings are suppressed |
| `fe-be-path-not-found` | **E** | the front-end calls a path the backend has no route for (runtime 404 that compiles fine) |
| `fe-be-method-mismatch` | **E** | path matches, HTTP method does not |
| `fe-be-route-unused` | I | a backend route nothing in this change calls (another client may) |
| `fe-dynamic-request-path` | I | `request.get('x/' + id)` — the boundary cannot be checked statically |

### Repo-level (impact / deep / duplication)

| rule / row | sev | fires when |
|---|---|---|
| `impact.blast` / `impact.routes` / `impact.pages` | — | entry points and blast radius for the change, depth-labelled (`depth` / `via` / `source_kind` / `confidence`) |
| `impact-risk` | W | the change grades MEDIUM/HIGH, with every factor listed |
| `deep.flows` / `deep.clusters` / `deep.module-risk` / `deep.cycles` | — / W | entry-driven call chains; Louvain modules (file or symbol level); per-module risk; Tarjan cycles |
| `deep-module-risk` | W | the repo's highest-risk module (standing condition — never gates by default) |
| `duplication-clone` | W | clone kinds `exact` / `renamed` / `similar` / `gap`, with a baseline so only *new* clones matter |

## Boundary: what the deep half must respect

1. Off by default (`--mode deep` or explicit flags).
2. Evidence or nothing (rows carry depth/via/source_kind/confidence; heuristics dropped).
3. Repo-level standing conditions never fail a build (risk/cycles are `warn`; opt-in gates).
4. Gate thresholds are calibrated on measured cases.
5. Deletable in isolation (lazy imports; the self-test asserts the default output has no
   deep group).

Not done, on purpose: `Cypher queries` (product surface) and `PDG / taint data-flow`
(needs a real SSA front end — use Semgrep taint).

## How any of this is trusted

- `tests/*.test.mjs` — 205 tests, 203 pass, 2 skipped (the 2 need the fixtures, which
  hold customer code and stay out of git).
- `scripts/selftest.mjs` — builds a throwaway repo containing every stack, injects real
  defects, and verifies the designed behaviours end to end, printing ✅/❌ with evidence.
- CI ([`.github/workflows/review.yml`](../.github/workflows/review.yml)) — fixture-independent
  tests → analyze → self-test → task sheet (`--mode deep`) → step summary → SARIF upload →
  PR comment → artifacts, on both `pull_request` and `push`.
- Every finding in every mode carries **why** (the trap) and **evidence** (the counts,
  the matched text, the file:line) so a reviewer can disagree with the tool.
