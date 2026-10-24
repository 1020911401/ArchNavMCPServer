/**
 * ANCHOR constraint taxonomy — 10 categories / 34 subcategories / 78 leaves.
 *
 * Source: "ANCHOR: Assessing Naturalistic Constraint Hierarchies and Ordering in
 * Repository-Grounded Agentic Coding" (arXiv:2610.16859v2), Table 2 + Table 9.
 * `atoms` are the instantiated atomic-constraint counts in the paper's release, kept
 * here so a report can say how much of the taxonomy is *weight-bearing* rather than
 * counting all 78 leaves as equally important.
 *
 * Design of THIS file (why it is data and not code):
 *   - `evidence` says where a leaf can be judged: `diff` (git patch / files on disk),
 *     `trajectory` (tool calls, order, failures), `commit` (commit messages),
 *     `report` (final assistant message). This is the ANCHOR insight: 41% of atoms
 *     are invisible to a diff-only reviewer, so the reviewer must declare which
 *     evidence it had instead of silently reporting "pass".
 *   - `native` names the archNav rule id that already covers the leaf (if any), so
 *     ANCHOR never double-reports a defect the 61-rule layer already owns.
 *   - `level` says which tier can judge it:
 *       'A' diff rule shipped in scripts/anchor-rules.mjs
 *       'B' symbolically checkable once a task constraint instantiates it
 *       'C' trajectory rule shipped in scripts/anchor-trajectory.mjs
 *       'L' needs an LLM judge (opt-in, never on by default)
 *       null not implemented — reported as `na` with the reason, never as `pass`
 */

/** @typedef {'diff'|'trajectory'|'commit'|'report'} EvidenceKind */

export const ANCHOR_CATEGORIES = [
  {
    id: 1,
    code: 'C1',
    name: 'Tool Execution Protocol',
    nameZh: '工具执行协议',
    intent: '工具怎么被调用：选择、参数、失败处理、结果复检',
    evidence: ['trajectory'],
    atoms: 371,
    subcategories: [
      {
        id: '1.1',
        name: 'Tool selection',
        nameZh: '工具选择',
        leaves: [
          { id: '1.1.1', name: 'Tool Preference & Substitution', nameZh: '工具偏好与替代', atoms: 44, evidence: ['trajectory'], level: 'C', check: 'tool_preference' },
          { id: '1.1.2', name: 'Tool prohibition', nameZh: '禁止使用的工具', atoms: 1, evidence: ['trajectory'], level: 'C', check: 'tool_prohibition' },
          { id: '1.1.3', name: 'Tool Composition & Pipeline', nameZh: '工具组合顺序', atoms: 1, evidence: ['trajectory'], level: 'C', check: 'tool_pipeline' },
        ],
      },
      {
        id: '1.2',
        name: 'Invocation parameters',
        nameZh: '调用参数',
        leaves: [
          { id: '1.2.1', name: 'Required parameters', nameZh: '必需参数', atoms: 74, evidence: ['trajectory'], level: 'B', check: 'required_params' },
          { id: '1.2.2', name: 'Forbidden parameters', nameZh: '禁止参数', atoms: 36, evidence: ['trajectory'], level: 'C', check: 'forbidden_params' },
        ],
      },
      {
        id: '1.3',
        name: 'Execution results',
        nameZh: '执行结果',
        leaves: [
          { id: '1.3.1', name: 'Truthfulness & Completeness', nameZh: '如实汇报执行', atoms: 24, evidence: ['trajectory', 'report'], level: 'C', check: 'claim_truthfulness' },
          { id: '1.3.2', name: 'Failure Handling & Retry', nameZh: '失败处理与重试', atoms: 32, evidence: ['trajectory'], level: 'C', check: 'failure_handling' },
          { id: '1.3.3', name: 'Result verification', nameZh: '改后复检', atoms: 159, evidence: ['trajectory'], level: 'C', check: 'result_verification' },
        ],
      },
    ],
  },
  {
    id: 2,
    code: 'C2',
    name: 'Workflow & Behaviour',
    nameZh: '工作流与行为',
    intent: '任务在时间上怎么被推进：顺序、确认、信息透明、提交纪律',
    evidence: ['trajectory'],
    atoms: 512,
    subcategories: [
      {
        id: '2.1',
        name: 'Execution order',
        nameZh: '执行顺序',
        leaves: [
          { id: '2.1.1', name: 'Task-level order', nameZh: '任务级顺序', atoms: 200, evidence: ['trajectory'], level: 'C', check: 'task_order' },
          { id: '2.1.2', name: 'Operation-level order', nameZh: '操作级顺序（先读后改）', atoms: 9, evidence: ['trajectory'], level: 'C', check: 'read_before_edit' },
        ],
      },
      {
        id: '2.2',
        name: 'User confirmation',
        nameZh: '用户确认',
        leaves: [
          { id: '2.2.1', name: 'Pre-action confirmation', nameZh: '动作前确认', atoms: 1, evidence: ['trajectory'], level: 'C', check: 'pre_action_confirmation' },
          { id: '2.2.2', name: 'Escalation triggers', nameZh: '升级触发点', atoms: 4, evidence: ['trajectory'], level: 'C', check: 'escalation' },
        ],
      },
      {
        id: '2.3',
        name: 'Information disclosure',
        nameZh: '信息透明',
        leaves: [
          { id: '2.3.2', name: 'Decision explanation', nameZh: '解释选择理由', atoms: 87, evidence: ['report'], level: 'L', check: 'decision_explanation' },
          { id: '2.3.3', name: 'Capability Boundary Declaration', nameZh: '能力边界声明', atoms: 9, evidence: ['report'], level: 'L', check: 'capability_boundary' },
        ],
      },
      {
        id: '2.4',
        name: 'Commit conventions',
        nameZh: '提交规范',
        leaves: [
          { id: '2.4.1', name: 'Commit message format', nameZh: '提交信息格式', atoms: 21, evidence: ['commit'], level: 'C', check: 'commit_format' },
          { id: '2.4.2', name: 'Commit Granularity & Strategy', nameZh: '提交粒度', atoms: 54, evidence: ['commit'], level: 'C', check: 'commit_granularity' },
          { id: '2.4.3', name: 'Pre-commit checks', nameZh: '提交前检查', atoms: 127, evidence: ['trajectory', 'commit'], level: 'C', check: 'pre_commit_checks' },
        ],
      },
    ],
  },
  {
    id: 3,
    code: 'C3',
    name: 'Modification Scope & Change Budget',
    nameZh: '改动范围与变更预算',
    intent: '改动的空间、数量、语义边界',
    evidence: ['diff'],
    atoms: 518,
    subcategories: [
      {
        id: '3.1',
        name: 'Spatial scope',
        nameZh: '空间范围',
        leaves: [
          { id: '3.1.1', name: 'Directory-level constraints', nameZh: '目录级约束', atoms: 77, evidence: ['diff'], level: 'B', check: 'path_scope' },
          { id: '3.1.2', name: 'File-level constraints', nameZh: '文件级约束', atoms: 28, evidence: ['diff'], level: 'B', check: 'file_scope' },
          { id: '3.1.3', name: 'Code-level constraints', nameZh: '代码级约束（只改函数体）', atoms: 2, evidence: ['diff'], level: 'L', check: 'code_level_scope' },
        ],
      },
      {
        id: '3.2',
        name: 'Quantity budget',
        nameZh: '数量预算',
        leaves: [
          { id: '3.2.1', name: 'File-count limits', nameZh: '文件数上限', atoms: 42, evidence: ['diff'], level: 'A', check: 'max_files' },
          { id: '3.2.2', name: 'Line-count limits', nameZh: '行数上限', atoms: 84, evidence: ['diff'], level: 'A', check: 'max_lines' },
        ],
      },
      {
        id: '3.3',
        name: 'Semantic scope',
        nameZh: '语义范围',
        leaves: [
          { id: '3.3.1', name: 'Task Boundary', nameZh: '任务边界（不顺手重构/加功能）', atoms: 158, evidence: ['diff', 'report'], level: 'L', check: 'task_boundary' },
          { id: '3.3.2', name: 'Interface compatibility', nameZh: '接口兼容（保持 API 路径/响应）', atoms: 127, evidence: ['diff'], level: 'B', check: 'interface_stability' },
        ],
      },
    ],
  },
  {
    id: 4,
    code: 'C4',
    name: 'Code Style & Engineering Standards',
    nameZh: '代码风格与工程规范',
    intent: '格式、命名、类型、注释、结构',
    evidence: ['diff'],
    atoms: 223,
    subcategories: [
      {
        id: '4.1',
        name: 'Formatting',
        nameZh: '格式',
        leaves: [
          { id: '4.1.1', name: 'Lint & Formatter Tools', nameZh: 'lint/formatter 通过', atoms: 30, evidence: ['diff', 'trajectory'], level: 'C', check: 'lint_run' },
          { id: '4.1.2', name: 'Whitespace & Layout Rules', nameZh: '缩进与空白', atoms: 3, evidence: ['diff'], level: 'B', check: 'whitespace' },
          { id: '4.1.3', name: 'Syntax Format Preferences', nameZh: '引号/风格偏好', atoms: 3, evidence: ['diff'], level: 'B', check: 'syntax_preference' },
        ],
      },
      {
        id: '4.2',
        name: 'Naming',
        nameZh: '命名',
        leaves: [
          { id: '4.2.1', name: 'Naming style', nameZh: '命名风格（snake/camel）', atoms: 10, evidence: ['diff'], level: 'B', check: 'naming_style' },
          { id: '4.2.2', name: 'Naming quality', nameZh: '命名质量（tmp/data 这类）', atoms: 12, evidence: ['diff'], level: 'A', check: 'naming_quality' },
        ],
      },
      {
        id: '4.3',
        name: 'Type system',
        nameZh: '类型系统',
        leaves: [
          { id: '4.3.1', name: 'Type annotation requirements', nameZh: '必须写类型标注', atoms: 9, evidence: ['diff'], level: 'B', check: 'type_annotation' },
          { id: '4.3.2', name: 'Type-safety restrictions', nameZh: '禁止 any 之类', atoms: 27, evidence: ['diff'], level: 'A', check: 'no_any' },
        ],
      },
      {
        id: '4.4',
        name: 'Comments & documentation',
        nameZh: '注释与文档',
        leaves: [
          { id: '4.4.1', name: 'Inline comments', nameZh: '行内注释（写为什么）', atoms: 13, evidence: ['diff'], level: 'L', check: 'inline_comments' },
          { id: '4.4.2', name: 'Docstrings', nameZh: 'docstring', atoms: 8, evidence: ['diff'], level: 'L', check: 'docstrings' },
          { id: '4.4.3', name: 'Project documentation', nameZh: '项目文档同步（README）', atoms: 26, evidence: ['diff'], level: 'A', check: 'docs_sync' },
        ],
      },
      {
        id: '4.5',
        name: 'Code structure',
        nameZh: '代码结构',
        leaves: [
          { id: '4.5.1', name: 'Modularity', nameZh: '抽出重复逻辑', atoms: 73, evidence: ['diff'], level: 'B', check: 'modularity', native: 'duplication' },
          { id: '4.5.2', name: 'Complexity limits', nameZh: '嵌套深度上限', atoms: 1, evidence: ['diff'], level: 'B', check: 'complexity' },
          { id: '4.5.3', name: 'Design patterns', nameZh: '设计模式偏好', atoms: 8, evidence: ['diff'], level: 'L', check: 'design_patterns' },
        ],
      },
    ],
  },
  {
    id: 5,
    code: 'C5',
    name: 'Code Implementation',
    nameZh: '实现约束',
    intent: '算法、错误处理、副作用、性能、技术选型',
    evidence: ['diff'],
    atoms: 283,
    subcategories: [
      {
        id: '5.1',
        name: 'Algorithm & strategy',
        nameZh: '算法与策略',
        leaves: [
          { id: '5.1.1', name: 'Algorithm Selection', nameZh: '算法选择', atoms: 37, evidence: ['diff'], level: 'L', check: 'algorithm_choice' },
          { id: '5.1.2', name: 'Concurrency & Synchronization Strategy', nameZh: '并发模型', atoms: 2, evidence: ['diff'], level: 'L', check: 'concurrency' },
          { id: '5.1.3', name: 'Retry & Fault Tolerance Strategy', nameZh: '重试/退避', atoms: 2, evidence: ['diff'], level: 'L', check: 'retry_strategy' },
          { id: '5.1.4', name: 'Error handling', nameZh: '错误处理', atoms: 115, evidence: ['diff'], level: 'A', check: 'error_handling', native: 'empty-catch|py-bare-except' },
          { id: '5.1.5', name: 'Side-effect control', nameZh: '副作用控制', atoms: 32, evidence: ['diff'], level: 'B', check: 'side_effects' },
        ],
      },
      {
        id: '5.2',
        name: 'Coding style',
        nameZh: '写法',
        leaves: [
          { id: '5.2.1', name: 'Syntax restrictions', nameZh: '语法禁用', atoms: 3, evidence: ['diff'], level: 'B', check: 'syntax_ban' },
          { id: '5.2.2', name: 'Paradigm requirements', nameZh: '范式要求（async/await）', atoms: 1, evidence: ['diff'], level: 'L', check: 'paradigm' },
          { id: '5.2.3', name: 'Language features', nameZh: '语言特性偏好', atoms: 41, evidence: ['diff'], level: 'L', check: 'language_features' },
        ],
      },
      {
        id: '5.3',
        name: 'Performance requirements',
        nameZh: '性能要求',
        leaves: [
          { id: '5.3.1', name: 'Complexity constraints', nameZh: '复杂度上限', atoms: 5, evidence: ['diff'], level: 'L', check: 'perf_complexity' },
          { id: '5.3.2', name: 'Resource constraints', nameZh: '资源上限', atoms: 10, evidence: ['diff'], level: 'L', check: 'perf_resource' },
          { id: '5.3.3', name: 'Data processing strategy', nameZh: '数据处理策略（流式）', atoms: 12, evidence: ['diff'], level: 'L', check: 'perf_data' },
        ],
      },
      {
        id: '5.4',
        name: 'Technology choice',
        nameZh: '技术选型',
        leaves: [
          { id: '5.4.1', name: 'Required libraries', nameZh: '必须用某库', atoms: 12, evidence: ['diff'], level: 'B', check: 'required_libs' },
          { id: '5.4.2', name: 'Forbidden libraries', nameZh: '禁用某库', atoms: 11, evidence: ['diff'], level: 'B', check: 'forbidden_libs', native: 'hallucinated-dependency' },
        ],
      },
    ],
  },
  {
    id: 6,
    code: 'C6',
    name: 'Environment',
    nameZh: '运行环境',
    intent: '版本、平台兼容、隔离',
    evidence: ['diff'],
    atoms: 70,
    subcategories: [
      {
        id: '6.1',
        name: 'Runtime versions',
        nameZh: '运行时版本',
        leaves: [
          { id: '6.1.1', name: 'Language Version', nameZh: '语言版本兼容', atoms: 18, evidence: ['diff'], level: 'B', check: 'lang_version' },
          { id: '6.1.2', name: 'Framework & Platform Version', nameZh: '框架/平台版本', atoms: 4, evidence: ['diff'], level: 'B', check: 'framework_version' },
        ],
      },
      {
        id: '6.2',
        name: 'Platform compatibility',
        nameZh: '平台兼容',
        leaves: [
          { id: '6.2.1', name: 'Path & Filesystem', nameZh: '路径可移植（不写死 /tmp）', atoms: 3, evidence: ['diff'], level: 'A', check: 'portable_path' },
          { id: '6.2.2', name: 'Encoding & Runtime Environment', nameZh: '编码显式声明', atoms: 5, evidence: ['diff'], level: 'A', check: 'explicit_encoding' },
        ],
      },
      {
        id: '6.3',
        name: 'Isolation',
        nameZh: '隔离',
        leaves: [
          { id: '6.3.1', name: 'Filesystem isolation', nameZh: '不写到仓库外', atoms: 28, evidence: ['diff'], level: 'A', check: 'fs_isolation' },
          { id: '6.3.2', name: 'System environment isolation', nameZh: '不改全局配置', atoms: 12, evidence: ['diff'], level: 'A', check: 'sys_isolation' },
        ],
      },
    ],
  },
  {
    id: 7,
    code: 'C7',
    name: 'Dependency & Build Strategy',
    nameZh: '依赖与构建',
    intent: '能不能加依赖、lock/CI/构建产物',
    evidence: ['diff'],
    atoms: 49,
    subcategories: [
      {
        id: '7.1',
        name: 'Dependency changes',
        nameZh: '依赖变更',
        leaves: [
          { id: '7.1.1', name: 'Addition Restrictions', nameZh: '禁止新增依赖', atoms: 41, evidence: ['diff'], level: 'A', check: 'no_new_dependency' },
        ],
      },
      {
        id: '7.2',
        name: 'Version management',
        nameZh: '版本管理',
        leaves: [
          { id: '7.2.1', name: 'Lock File Policy', nameZh: 'lock 文件策略', atoms: 4, evidence: ['diff'], level: 'A', check: 'lock_untouched' },
          { id: '7.2.2', name: 'Version Range Policy', nameZh: '版本范围策略', atoms: 1, evidence: ['diff'], level: 'B', check: 'version_range' },
        ],
      },
      {
        id: '7.3',
        name: 'Build pipeline',
        nameZh: '构建管线',
        leaves: [
          { id: '7.3.1', name: 'CI/CD configuration', nameZh: 'CI 配置禁改', atoms: 1, evidence: ['diff'], level: 'A', check: 'ci_untouched' },
          { id: '7.3.2', name: 'Build Scripts & Output', nameZh: '构建脚本/产物路径', atoms: 2, evidence: ['diff'], level: 'A', check: 'build_output_untouched' },
        ],
      },
    ],
  },
  {
    id: 8,
    code: 'C8',
    name: 'Security & Dangerous Operations',
    nameZh: '安全与危险操作',
    intent: '破坏性命令、权限、泄露、注入',
    evidence: ['diff', 'trajectory'],
    atoms: 49,
    subcategories: [
      {
        id: '8.1',
        name: 'Dangerous commands & privileges',
        nameZh: '危险命令与权限',
        leaves: [
          { id: '8.1.1', name: 'Destructive commands', nameZh: '破坏性命令', atoms: 24, evidence: ['diff', 'trajectory'], level: 'A', check: 'destructive_command' },
          { id: '8.1.2', name: 'Privilege & System Operations', nameZh: '提权与系统操作', atoms: 14, evidence: ['diff', 'trajectory'], level: 'A', check: 'privilege_ops' },
        ],
      },
      {
        id: '8.2',
        name: 'Information leakage',
        nameZh: '信息泄露',
        leaves: [
          { id: '8.2.1', name: 'Secret & Credential Protection', nameZh: '密钥/凭据不外泄', atoms: 3, evidence: ['diff', 'trajectory'], level: 'A', check: 'secret_leak' },
          { id: '8.2.3', name: 'System Information Protection', nameZh: '内部路径不外泄', atoms: 2, evidence: ['diff'], level: 'A', check: 'internal_path_leak' },
        ],
      },
      {
        id: '8.3',
        name: 'Code security',
        nameZh: '代码安全',
        leaves: [
          { id: '8.3.1', name: 'Injection protection', nameZh: '防注入', atoms: 5, evidence: ['diff'], level: 'A', check: 'injection', native: 'taint-source-to-sink|php-raw-sql-interpolation|py-raw-sql|go-sql-injection' },
          { id: '8.3.3', name: 'Encryption & Secure Coding', nameZh: '加密与安全编码', atoms: 1, evidence: ['diff'], level: 'A', check: 'weak_crypto' },
        ],
      },
    ],
  },
  {
    id: 9,
    code: 'C9',
    name: 'Testing',
    nameZh: '测试',
    intent: '写测试、跑测试、静态检查、报告结果',
    evidence: ['diff', 'trajectory'],
    atoms: 530,
    subcategories: [
      {
        id: '9.1',
        name: 'Test writing',
        nameZh: '测试编写',
        leaves: [
          { id: '9.1.1', name: 'Test Coverage Requirements', nameZh: '回归测试覆盖', atoms: 156, evidence: ['diff'], level: 'A', check: 'test_added', native: 'no-test-coverage' },
          { id: '9.1.2', name: 'Test quality standards', nameZh: '测试独立性', atoms: 104, evidence: ['diff'], level: 'B', check: 'test_quality' },
        ],
      },
      {
        id: '9.2',
        name: 'Test execution',
        nameZh: '测试执行',
        leaves: [
          { id: '9.2.1', name: 'Test Suite Selection', nameZh: '先跑受影响用例', atoms: 155, evidence: ['trajectory'], level: 'C', check: 'test_selection' },
          { id: '9.2.2', name: 'Static Analysis & Checks', nameZh: '静态检查跑过', atoms: 45, evidence: ['trajectory'], level: 'C', check: 'static_checks' },
        ],
      },
      {
        id: '9.3',
        name: 'Test reporting',
        nameZh: '测试汇报',
        leaves: [
          { id: '9.3.1', name: 'Result summary', nameZh: '逐项测试结果', atoms: 4, evidence: ['report'], level: 'C', check: 'test_report' },
          { id: '9.3.2', name: 'Reproduction & Comparison', nameZh: '修复前后对比', atoms: 66, evidence: ['diff', 'report'], level: 'C', check: 'before_after' },
        ],
      },
    ],
  },
  {
    id: 10,
    code: 'C10',
    name: 'Output Format & Reporting',
    nameZh: '输出与汇报',
    intent: '报告怎么写：语言、模板、引用、证据',
    evidence: ['report'],
    atoms: 231,
    subcategories: [
      {
        id: '10.1',
        name: 'Language & tone',
        nameZh: '语言与语气',
        leaves: [
          { id: '10.1.1', name: 'Language Choice', nameZh: '语言选择', atoms: 62, evidence: ['report'], level: 'L', check: 'report_language' },
          { id: '10.1.2', name: 'Tone & Style', nameZh: '语气与风格', atoms: 66, evidence: ['report'], level: 'L', check: 'report_tone' },
        ],
      },
      {
        id: '10.2',
        name: 'Structure & templates',
        nameZh: '结构与模板',
        leaves: [
          { id: '10.2.1', name: 'Report Template', nameZh: '报告模板', atoms: 5, evidence: ['report'], level: 'C', check: 'report_template' },
        ],
      },
      {
        id: '10.3',
        name: 'Citation & evidence',
        nameZh: '引用与证据',
        leaves: [
          { id: '10.3.1', name: 'Code References', nameZh: '引用文件:行号', atoms: 45, evidence: ['report'], level: 'C', check: 'code_references' },
          { id: '10.3.2', name: 'Execution Evidence', nameZh: '命令输出当证据', atoms: 53, evidence: ['report'], level: 'C', check: 'execution_evidence' },
        ],
      },
    ],
  },
];

/** Flat leaf list (78) — the operational unit; every leaf carries its own evidence + level. */
export const ANCHOR_LEAVES = ANCHOR_CATEGORIES.flatMap((cat) => cat.subcategories.flatMap((sub) => sub.leaves.map((leaf) => ({
  ...leaf,
  category: cat.code,
  categoryName: cat.name,
  subcategory: `${sub.id} ${sub.name}`,
}))));

export const ANCHOR_LEAF_BY_ID = new Map(ANCHOR_LEAVES.map((l) => [l.id, l]));

/** Which tiers are enabled for a given review level. `off` keeps the layer dormant. */
export const LEVELS = {
  off: { A: false, B: false, C: false, L: false },
  A: { A: true, B: false, C: false, L: false },
  B: { A: true, B: true, C: false, L: false },
  C: { A: true, B: true, C: true, L: false },
  // `full` = everything implemented, still without an LLM judge unless one is configured
  full: { A: true, B: true, C: true, L: true },
};

export function normalizeLevel(level) {
  if (level === null || level === undefined || level === '') return null;
  const key = String(level).trim().toLowerCase();
  if (key === 'off' || key === 'none' || key === '0' || key === 'false') return 'off';
  if (key === 'a' || key === '1') return 'A';
  if (key === 'b' || key === '2') return 'B';
  if (key === 'c' || key === '3') return 'C';
  if (key === 'full' || key === 'all') return 'full';
  return null;
}

/** Leaf ids whose judged level is enabled at this review level. */
export function leavesForLevel(level) {
  const mask = LEVELS[level];
  if (!mask) return [];
  return ANCHOR_LEAVES.filter((l) => l.level && mask[l.level]);
}

/**
 * Taxonomy coverage summary — how much of the *instantiated* constraint mass a level
 * can even attempt. Reported next to the metrics so a 100% ACR on tier A is never
 * mistaken for "ANCHOR-compliant": the atoms the tier cannot see are counted as
 * out of scope, not as passes.
 */
export function coverage(level) {
  const mask = LEVELS[level] || LEVELS.off;
  const total = 2836;
  const leaves = ANCHOR_LEAVES;
  const reachable = leaves.filter((l) => l.level && mask[l.level]);
  const atoms = reachable.reduce((n, l) => n + l.atoms, 0);
  const perCat = {};
  for (const cat of ANCHOR_CATEGORIES) {
    const cs = cat.subcategories.flatMap((s) => s.leaves);
    const r = cs.filter((l) => l.level && mask[l.level]).reduce((n, l) => n + l.atoms, 0);
    perCat[cat.code] = { atoms: cat.atoms, reachable: r, pct: cat.atoms ? Math.round((r / cat.atoms) * 1000) / 10 : 0 };
  }
  return {
    level,
    leaves: { total: leaves.length, reachable: reachable.length },
    atoms: { total, reachable: atoms, pct: Math.round((atoms / total) * 1000) / 10 },
    perCategory: perCat,
  };
}
