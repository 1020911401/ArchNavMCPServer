/**
 * MCP playbook: prompts (workflows) and resources (long references) served from
 * `skill/archnav/` — the single source of truth for the ArchNav playbook.
 *
 * Why here and not in tool descriptions: the workflow text is 30-40 lines each, and
 * tool descriptions must stay ≤40 words (asserted by tests/engines/mcp-tools.test.mjs).
 * Clients that do not implement prompts/resources simply never ask for them; the CLI
 * is unchanged, so nothing depends on this layer being consumed.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL_DIR = path.join(ROOT, 'skill', 'archnav');

const PROMPT_FILES = [
  { name: 'archnav_review_diff', file: 'review-diff.md', title: 'Review the current diff', description: 'diff-scoped review: checklist, impact, test selection, gate' },
  { name: 'archnav_self_review', file: 'self-review.md', title: 'Self-review an uncommitted change', description: 'dogfood the review layer on ArchNav itself (add -N, analyze first, triage)' },
  { name: 'archnav_test_select', file: 'test-select.md', title: 'Run only the tests this change touches', description: 'graph-based test selection plus the uncovered-symbol gate' },
  { name: 'archnav_deep', file: 'deep.md', title: 'Repo-level deep analysis', description: 'flows / clusters / risk / cross-repo HTTP edges, with the deliberate gaps' },
];

const RESOURCE_FILES = [
  { uri: 'archnav://skill', file: 'SKILL.md', name: 'skill', title: 'ArchNav playbook (thin)' },
  { uri: 'archnav://skill/code-review', file: 'references/code-review.md', name: 'code-review', title: 'Rule catalogue and measured ground truth' },
  { uri: 'archnav://skill/self-review', file: 'references/self-review.md', name: 'self-review', title: 'False-positive classes and noise control' },
  { uri: 'archnav://skill/comparison', file: 'references/comparison.md', name: 'comparison', title: 'Three-engine benchmark (evidence, not a dependency)' },
  { uri: 'archnav://skill/kanban-review', file: 'references/kanban-review.md', name: 'kanban-review', title: 'Per-item confirmation and waiver flow' },
  { uri: 'archnav://skill/anchor-review', file: 'references/anchor-review.md', name: 'anchor-review', title: 'ANCHOR review layer (levels A/B/C, constraints, ACR/CCR/FCCR, trajectory)' },
  { uri: 'archnav://skill/playbook-full', file: 'references/playbook-full.md', name: 'playbook-full', title: 'Full playbook (CLI, changes pipeline, harness probe, history)' },
];

const readFileOrNull = (rel) => {
  try {
    return fs.readFileSync(path.join(SKILL_DIR, rel), 'utf8');
  } catch {
    return null;                                   // missing playbook must not kill the server
  }
};

export function listResources() {
  return RESOURCE_FILES.map((r) => ({
    uri: r.uri,
    name: r.name,
    title: r.title,
    mimeType: 'text/markdown',
    description: `${r.title} (skill/archnav/${r.file})`,
  }));
}

/** @returns {{contents: Array}|{error: string}} */
export function readResource(uri) {
  const entry = RESOURCE_FILES.find((r) => r.uri === uri);
  if (!entry) return { error: `unknown resource: ${uri}` };
  const text = readFileOrNull(entry.file);
  if (text == null) return { error: `resource file is missing: skill/archnav/${entry.file}` };
  return { contents: [{ uri: entry.uri, mimeType: 'text/markdown', text }] };
}

export function listPrompts() {
  return PROMPT_FILES.map((p) => ({
    name: p.name,
    title: p.title,
    description: p.description,
    arguments: [{ name: 'dir', description: 'target repository (default: current working directory)', required: false }],
  }));
}

/**
 * @param {string} name prompt name
 * @param {Record<string,string>} args optional `dir`
 * @returns {{description,messages}|{error}}
 */
export function getPrompt(name, args = {}) {
  const entry = PROMPT_FILES.find((p) => p.name === name);
  if (!entry) return { error: `unknown prompt: ${name}` };
  const body = readFileOrNull(path.join('prompts', entry.file));
  if (body == null) return { error: `prompt file is missing: skill/archnav/prompts/${entry.file}` };
  const dir = typeof args.dir === 'string' && args.dir.trim() ? args.dir.trim() : null;
  const text = dir ? `${body.trim()}\n\n目标仓：\`${dir}\`（以下命令都在该目录下执行）\n` : body;
  return { description: entry.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}
