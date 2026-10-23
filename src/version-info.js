/**
 * Version information for the *target* repository (not for ArchNav itself).
 *
 * Everything here answers "which version of this code am I looking at?":
 *   - git: HEAD (full + short), branch, nearest tag / exact tag, dirty worktree,
 *     last commit date/author/subject, commit count
 *   - manifests: package.json / composer.json / pyproject.toml / go.mod
 *   - index: the commit ArchNav indexed, its age, and whether the index drifted
 *
 * Read-only: every git call is `execFileSync` with a timeout, and a missing git,
 * missing binary or non-repo directory degrades to null fields instead of throwing
 * (this must work on the customer repos where git is absent or broken).
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { checkStaleness } from './confidence.js';

function git(dir, args) {
  try {
    const out = execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out).trim() || null;
  } catch {
    return null;
  }
}

/** Git identity of the working tree, or null when the directory is not a repo. */
export function readGitInfo(dir) {
  const inside = git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return null;
  const head = git(dir, ['rev-parse', 'HEAD']);
  if (!head) return null;                                    // repo with no commits yet
  const dirtyOut = git(dir, ['status', '--porcelain']);
  const commits = git(dir, ['rev-list', '--count', 'HEAD']);
  return {
    head,
    short: git(dir, ['rev-parse', '--short', 'HEAD']),
    branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    tag: git(dir, ['describe', '--tags', '--abbrev=0']),      // nearest reachable tag
    exact_tag: git(dir, ['describe', '--tags', '--exact-match']), // HEAD *is* this tag
    dirty: Boolean(dirtyOut),
    dirty_files: dirtyOut ? dirtyOut.split(String.fromCharCode(10)).filter(Boolean).length : 0,
    date: git(dir, ['log', '-1', '--format=%cI']),
    author: git(dir, ['log', '-1', '--format=%an']),
    subject: git(dir, ['log', '-1', '--format=%s']),
    commits: commits ? Number(commits) : null,
    describe: git(dir, ['describe', '--tags', '--always']),   // tag-N-gsha / gsha
  };
}

const readJson = (dir, file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch {
    return null;
  }
};

const readText = (dir, file) => {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8');
  } catch {
    return null;
  }
};

/** Declared versions of the manifests that exist at the repo root. */
export function readManifests(dir) {
  const out = {};
  const pkg = readJson(dir, 'package.json');
  if (pkg) out.package_json = { name: pkg.name || null, version: pkg.version || null };
  const composer = readJson(dir, 'composer.json');
  if (composer) out.composer_json = { name: composer.name || null, version: composer.version || null };
  const pyproject = readText(dir, 'pyproject.toml');
  if (pyproject) {
    const name = /^name\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] || null;
    const version = /^version\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] || null;
    out.pyproject = { name, version };
  }
  const gomod = readText(dir, 'go.mod');
  if (gomod) {
    const module = /^module\s+(\S+)/m.exec(gomod)?.[1] || null;
    const go = /^go\s+(\S+)/m.exec(gomod)?.[1] || null;
    out.go_mod = { name: module, version: null, go };
  }
  return out;
}

/**
 * @param {string} dir target repository
 * @param {{toolVersion?: string}} opts
 */
export async function collectVersionInfo(dir, { toolVersion = null } = {}) {
  const abs = path.resolve(dir);
  const gitInfo = readGitInfo(abs);
  // `checkStaleness` happily reports "fresh, confidence 1" for a directory that was
  // never indexed, which would read as "the index matches HEAD". Only claim an index
  // when one is actually on disk.
  const hasIndex = fs.existsSync(path.join(abs, '.archnav', 'index.json'));
  let index = null;
  try {
    const s = hasIndex ? await checkStaleness(abs) : null;
    if (!s) throw new Error('no index');

    index = {
      indexed_commit: s.indexedCommit || null,
      head: s.currentHead || null,
      age: s.indexAge || null,
      stale: Boolean(s.stale),
      changed_files: s.changedFiles ?? null,
      confidence: typeof s.overallConfidence === 'number' ? s.overallConfidence : null,
    };
  } catch {
    index = null;                                            // no index yet
  }
  // "Indexed at" versus "now": the two things a reviewer must not confuse.
  const matchesHead = Boolean(index?.indexed_commit && gitInfo?.head && index.indexed_commit.startsWith(gitInfo.head.substring(0, 7)));
  return {
    tool: { name: 'archnav', version: toolVersion, node: process.version },
    repo: { dir: abs, is_git: Boolean(gitInfo), ...(gitInfo || {}) },
    manifests: readManifests(abs),
    index: index ? { ...index, matches_head: matchesHead } : null,
  };
}
