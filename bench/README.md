# bench/ — reproducible benchmark & ground truth

Zero-dependency Node/ESM harness that replaces the throwaway Python scripts that
previously lived outside the repo. It measures how well three code-navigation
engines answer the same `callers` / `status` queries over two real-world
fixtures.

Everything here is plain Node (built-in `node --test`, built-in `child_process`)
— **no `npm install` is ever required or allowed.**

## Files

| file | role |
| --- | --- |
| `gen_ground_truth.mjs` | exports `groundTruth(repoDir, symbol)` and `scanRepo(repoDir)` |
| `gen_ground_truth.test.mjs` | 4 assertions (`node --test`) pinning the ground-truth numbers |
| `run_bench.mjs` | runs all three engines, prints a Markdown table, writes `report.json` |
| `report.json` | last benchmark run, JSON details (generated, gitignored) |
| `php-app/`, `vue-app/` | the fixtures (see provenance below) |
| `tools/` | the original Python scripts, kept read-only for reference |

## How to run

```bash
cd C:/Users/z/projects/archnav

# 1) ground-truth unit tests  -> expect "4 passed"
node --test bench/gen_ground_truth.test.mjs

# 2) the benchmark (indexes fixtures on first run, then queries all engines)
node bench/run_bench.mjs
node bench/run_bench.mjs | head -40      # just the table
```

> stdin is not inherited by the engine subprocesses (`stdio: ['ignore','pipe','pipe']`),
> so the script is safe to run from cron / a background job / a piped shell.
> Historically that combination made it exit 1 with `stdin is not a tty` while
> printing nothing, because a child probed for a TTY.

### `run_bench.mjs` flags

* `--fresh` — force re-index even when an index already exists.
* `--no-prepare` — skip all indexing; only useful for a quick smoke test.
* `--engines=archnav,codegraph` — restrict to a subset of engines.

The script **never throws**: a missing engine, a non-zero exit, or a query that
exceeds the 180 s per-query timeout produces an `n/a (reason)` cell and a record
whose `error` field says why. `bench/report.json` is written before the table is
printed, so piping through `head` can never lose it.

## What the engines are

| id | command |
| --- | --- |
| `archnav` | this repo: `node src/index.js …` |
| `codegraph` | external CLI `codegraph` (must be on `PATH`) |
| `gitnexus` | external CLI `gitnexus` (must be on `PATH`) |

### Query → command mapping

Each symbol is benchmarked on the fixture it actually lives in (a symbol only
exists in one of the two fixtures):

| fixture | queries |
| --- | --- |
| `php-app` | `callers departments`, `callers showSelectOptions`, `status` |
| `vue-app` | `callers orderTake`, `callers getUserInfo`, `status` |

Every engine receives the identical command for a given
(repo, query) pair:

| query | archnav | codegraph | gitnexus |
| --- | --- | --- | --- |
| `callers <sym>` | `callers <sym> --dir <dir> --json` | `callers <sym> -p <dir> -j -l 1000` | `context <sym> -r <alias> -f <deffile>` |
| `status` | `status <dir> --json` | `status <dir> -j` | `status` (run with cwd = repo dir) |

Notes on the exact invocation:

* **`codegraph`** is limited to 20 results per definition by default, which would
  truncate broad symbols — the harness passes `-l 1000`. It is used as
  `codegraph init <dir>`, which is idempotent (exit 0 whether or not already
  initialized).
* **`gitnexus`** registers repositories in a **global** registry that already
  contains several unrelated repos, so `-r <alias>` is mandatory. The alias is
  `archnav-bench-php-app` / `archnav-bench-vue-app`. Because the fixtures have
  **no `.git` directory**, indexing must pass **`--skip-git`** (and
  `--index-only`, to avoid writing `AGENTS.md`/skills into the fixture).
* **`gitnexus context`** is ambiguous for common names, so the harness passes
  `-f` with the first ground-truth definition file. This is a disambiguation
  *query parameter*, not a peek at the answer.
* **`gitnexus status`** accepts no repository flag — it reports the repo of the
  current directory, so it is the one command run with `cwd = <repo>`.

### Prepare (index) step

Each engine needs an index before it can answer:

* `archnav`  → `node src/index.js analyze <dir>` (writes `<dir>/.archnav/index.json`)
* `codegraph` → `codegraph init <dir>` (writes `<dir>/.codegraph/`)
* `gitnexus` → `gitnexus analyze <dir> --skip-git --index-only --name <alias>`

The step is skipped when the index/alias already exists (unless `--fresh`).
These writes land **inside the fixtures** (`.archnav/`, `.codegraph/`,
`.gitnexus/`) — all covered by `bench/` being gitignored. `gitnexus analyze`
additionally touches the machine-global registry, which is unavoidable.

## Metrics

For a `callers <sym>` query the benchmark compares **caller-file sets** (not call
sites), because the three engines report different granularities — archnav
returns call sites, codegraph returns the enclosing *caller definitions*,
gitnexus returns incoming call edges. File-level overlap is the fair comparison
and matches the `callerFiles` field `groundTruth()` produces.

* `ground_truth` — `|groundTruth(dir, sym).callerFiles|`
* `returned` — number of distinct repo-relative source files parsed from the
  engine's output (JSON when available, else a path regex fallback)
* `recall` — `|returned ∩ ground_truth| / |ground_truth|`
* `wall_ms` — wall-clock time of the query command
* `error` — `null` on success, else the reason (`timeout 180s`, `exit 1`,
  `not installed (…)`, `ambiguous symbol`, …)

`status` queries have no ground truth: they record `returned = 1`,
`ground_truth = null`, `recall = null`, and the engine's status summary in
`detail`. The extra `detail` field (beyond the required seven) is a debugging
aid; the required fields are `tool, query, returned, ground_truth, recall,
wall_ms, error`.

## Ground-truth detection rules (`gen_ground_truth.mjs`)

Line-oriented and deliberately simple so every number is reproducible with plain
grep.

* **Scanned extensions:** `.php`, `.js`, `.mjs`, `.ts`, `.vue`
  (`.blade.php` ends in `.php` and is therefore covered by the `.php` rule).
* **Skipped directories** (by basename, anywhere): `node_modules`, `.git`,
  `.codegraph`, `.gitnexus`, `.archnav`.
* **Comment line:** trimmed text starts with `//` or `*` → never a call site.
* **Definition line:**
  * PHP: `^\s*(?:(?:public|private|protected|static|final|abstract|readonly)\s+)*function\s+NAME\s*\(`
  * JS/TS/Vue: `^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*NAME\s*\(`
    or `^\s*(?:export\s+)?(?:const|let|var)\s+NAME\s*=\s*(?:async\s+)?(?:function\b|\()`
* **Call-site candidate:**
  * PHP: `(?:->|::)\s*NAME\s*\(`
  * JS/TS/Vue: `(?<![\w.$])NAME\s*\(` (bare call, not preceded by `.`/word char/`$`)
* `groundTruth()` then drops any line that defines the symbol and any comment
  line. A JS `import { orderTake } …` line has no `(` after the name, so it is
  never mistaken for a call.
* `callerFiles` = the unique, sorted, call-site-bearing files.

### The exact numbers the tests pin

| fixture | symbol | defs | call sites | caller files |
| --- | --- | --- | --- | --- |
| php-app | `departments` | 1 | 6 | 4 |
| php-app | `showSelectOptions` | 8 | **40** (`*.blade.php`) | **19** (`*.blade.php`) |
| vue-app | `orderTake` | 2 | 3 | 3 |
| vue-app | `getUserInfo` | 2 | 44 | 34 |

### Two measurement nuances (why some numbers look "off" by one)

1. **`showSelectOptions` — 40/19 vs 44/20.** The scope of "40 calls, 19 files" is
   `*.blade.php`. A full-repo `.php` scan also matches 4 calls in the stale dated
   backup view `views/patients/create.blade.20230516.php` (and that file is not
   `*.blade.php`), giving 44 call sites across 20 files. The test asserts the
   blade-scoped **40/19** *and* the full-repo **44/20**, so neither figure is
   smuggled. `run_bench.mjs` uses the full-repo figure (20) as ground truth.
2. **`getUserInfo` — 44 call sites, 34 caller files, 36 "files".** 44 is the
   call-site count after excluding the 2 definition lines (`api/user.js:17`,
   `api/admin.js:360`). Those two files contain no *other* bare mention, so the
   number of call-site-bearing files is **34** (= `callerFiles`). A
   `grep -rl`-style count of files containing *any* bare mention, definitions
   included, is **36**. The test asserts 44 / 34 / 36 and that `api/user.js:17`
   is a definition, not a call site.

## Fixture provenance — DO NOT COMMIT

* `php-app/` — a copy of a Laravel backend (application + routes + config +
  blade views): 286 `*.php` (incl. 76 `*.blade.php` under `views/`), 305 files
  total.
* `vue-app/` — a copy of a uni-app frontend (source subset):
  269 `*.vue`, 64 `*.js`.

Both contain **customer project source code** and must never be `git add`ed.
`bench/` is already listed in the repo-root `.gitignore`; keep it that way.
`tools/` (the original Python scripts) is likewise reference-only and must not be
modified.

---

## `multi_dim.mjs` — the wider comparison

`run_bench.mjs` only compares `callers` and `status`. `multi_dim.mjs` tests the
seven dimensions an agent actually uses, per engine, and writes
`multi_dim_report.md` / `multi_dim_report.json`:

```bash
node bench/multi_dim.mjs               # rebuild every index, then query
node bench/multi_dim.mjs --no-index    # reuse existing indexes (fast)
node bench/multi_dim.mjs --engines=archnav,codegraph
```

| dimension | ArchNav | CodeGraph | GitNexus |
| --- | --- | --- | --- |
| locate | `locate <sym> --dir <d> --json` | `query <sym> -p <d> -j` | `context <sym> -r <alias> -f <file>` |
| callers | `callers <sym> --dir <d> [--file f] --json` | `callers <sym> -p <d> -j -l 1000 [-f f]` | `context …` (reads `incoming.calls[]`) |
| impact | `impact <sym> --dir <d> [--file f] --json` | `impact <sym> -p <d> -j` | `impact <sym> -r <alias> [-f f]` |
| read | `read <sym> --dir <d>` | `node <sym> -p <d>` | `context … --content` |
| trace | `trace <a> <b> --dir <d>` | `explore <a> <b> -p <d>` (~) | `query "<a> <b>" -r <alias>` (~) |
| arch | `arch <d>` (positional!) | `status <d> -j` (~) | `status` (~) |
| status | `status <d> --json` | `status <d> -j` | `status` (cwd = repo) |
| index | `analyze <d>` | `index <d>` (not `init` — no-op) | `analyze <d> --skip-git` |

`~` = the engine has no equivalent command; the closest one is used and the
column is marked approximate, so the summary never claims an exact match for it.
Engines are not penalized for a missing flag: e.g. GitNexus has no `read`, so
`context --content` is used and counted as `~`.

### Command-shape traps (each one cost a debugging cycle)

* **`codegraph status` takes the path positionally** — `-p` is rejected with
  `error: unknown option '-p'`. `query`/`callers`/`impact`/`node` do accept `-p`.
* **`codegraph query -j` returns a bare JSON array** of `{node, score}` — not an
  object. A `{…}`-only JSON extractor reports "no json" for every query.
* **`codegraph callers -j` nests results**: `definitions[].callers[].filePath`.
  There is no top-level `callers` array.
* **`gitnexus` uses `-r <alias>`, never `-p`** — the repo must already be in its
  machine-global registry. `gitnexus impact -p …` fails with
  `unknown option '-p'`.
* **`gitnexus context` groups edges by relation**: callers live in
  `incoming.calls[]`, callees in `outgoing.*`. `j.callers` is `undefined`.
* **`gitnexus impact -j` reports `impactedCount` / `summary.direct` / `risk`** —
  not `affected`/`nodes`.
* **`gitnexus analyze` needs `--skip-git`** for fixtures without `.git`
  (otherwise: `Not a git repository`).
* **`archnav callers --file` wants a repo-relative path or suffix.** An absolute
  path is accepted but filters everything out (measured `6 relations → 0`).
* **`archnav arch` rejects `--dir`** (`unknown option`); pass the directory
  positionally.
* **`archnav impact` needs `--file` for same-named symbols** — without it a
  component method can report `0 direct + 0 indirect`.
* **Never use `grep` through `spawnSync(..., {shell: true})` on Windows.** That
  spawns `cmd.exe`, where `grep` does not exist; with `|| true` the failure is
  silent and every ground-truth count silently becomes 0. The harness walks the
  tree in Node instead.
* **Run it as `node bench/multi_dim.mjs < /dev/null`** when stdout is not a TTY —
  one of the CLIs probes for a terminal and the shell aborts with
  `stdin is not a tty`.

### Recall caveat

The `callers` recall table compares returned files against *every file that
literally contains the symbol string* (route names, comments and templates
included), so `mentions` is an **upper bound** and the recall percentage is
conservative. It is a smoke metric, not a precision measure; `run_bench.mjs`'s
ground truth (call-site detection) remains the authoritative number.
