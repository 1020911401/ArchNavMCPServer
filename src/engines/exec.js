/**
 * Shared CLI execution helper for external engine adapters.
 *
 * Contract for a *runner* (used by adapters and by fixture-replay tests):
 *   runner(bin, args, { cwd, timeoutMs }) -> Promise<{
 *     stdout: string,
 *     stderr: string,
 *     code: number|null,      // exit status (null when killed / spawn failed)
 *     signal: string|null,    // termination signal, if any
 *     error: string|null      // null | 'engine_unavailable' | 'timeout' | 'cli_error'
 *   }>
 *
 * Every adapter accepts `options.runner` so tests can replay captured CLI output
 * without spawning a process. `runCli` is the real, child_process-backed default.
 */
import { spawn, spawnSync } from 'child_process';

export const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Locale-independent existence check for a CLI on PATH.
 * Windows cmd.exe localises its "not recognized" text, so we never string-match
 * error output to decide whether a binary is missing — we ask the shell instead.
 */
export function binaryAvailable(bin, platform = process.platform) {
  try {
    const probe = platform === 'win32' ? `where ${quoteArg(bin)}` : `command -v ${quoteArg(bin)}`;
    const r = spawnSync(probe, { shell: true, windowsHide: true, encoding: 'utf-8', timeout: 10000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Windows needs a shell to reach npm-style `.cmd` shims; POSIX does not. */
export function needsShell(platform = process.platform) {
  return platform === 'win32';
}

/** Quote a single argument so it survives a `shell: true` invocation. */
export function quoteArg(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(s)) return s;
  return `"${s.replace(/(["\\])/g, '\\$1')}"`;
}

/** Build a single command string for `spawn(cmd, { shell: true })`. */
export function buildCommand(bin, args) {
  return [bin, ...args].map(quoteArg).join(' ');
}

/** Tolerant JSON parse: returns the parsed value or null. */
export function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  // Some CLIs prefix a human banner before the JSON body.
  const firstBrace = t.indexOf('{');
  const firstBracket = t.indexOf('[');
  let start = -1;
  if (firstBrace >= 0 && firstBracket >= 0) start = Math.min(firstBrace, firstBracket);
  else start = firstBrace >= 0 ? firstBrace : firstBracket;
  if (start < 0) return null;
  try {
    return JSON.parse(t.slice(start));
  } catch {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
}

/**
 * Normalise any runner invocation so that a throwing or rejecting runner can
 * never propagate an exception out of an adapter.
 */
export async function safeRun(runner, bin, args, options) {
  try {
    const r = await runner(bin, args, options);
    if (!r || typeof r !== 'object') {
      return { stdout: '', stderr: 'runner returned a non-object', code: null, signal: null, error: 'cli_error' };
    }
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      code: r.code ?? null,
      signal: r.signal ?? null,
      error: r.error ?? null,
    };
  } catch (e) {
    return { stdout: '', stderr: (e && e.message) || String(e), code: null, signal: null, error: 'cli_error' };
  }
}

/**
 * Spawn a CLI process and capture its output. Never rejects and never throws:
 * every failure mode is surfaced through the `error` field of the result.
 */
export function runCli(bin, args, options = {}) {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, platform = process.platform } = options;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let child = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code: null,
        signal: null,
        error: null,
        ...result,
      });
    };

    try {
      if (needsShell(platform)) {
        child = spawn(buildCommand(bin, args), { cwd, shell: true, windowsHide: true });
      } else {
        child = spawn(bin, args, { cwd, shell: false, windowsHide: true });
      }
    } catch (e) {
      finish({ error: 'engine_unavailable', stderr: e.message });
      return;
    }

    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (e) => {
      finish({
        error: e && e.code === 'ENOENT' ? 'engine_unavailable' : 'cli_error',
        stderr: stderr || (e && e.message) || '',
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const blob = `${stdout}\n${stderr}`;
        const regexMissing = /not recognized|command not found|no such file or directory|is not installed/i.test(blob);
        // Fallback for localised shells (e.g. Chinese Windows): only when
        // nothing was produced do we ask the shell whether the binary exists.
        const missing = regexMissing || (!String(stdout).trim() && !binaryAvailable(bin, platform));
        finish({ code, signal, error: missing ? 'engine_unavailable' : 'cli_error' });
        return;
      }
      finish({ code, signal, error: null });
    });

    timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ signal: 'SIGTERM', error: 'timeout' });
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
}
