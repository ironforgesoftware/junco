/**
 * git/gh subprocess layer — faithful port of worker.py lines 1639-1762.
 *
 * Provides:
 *   - GitOpError           — typed error carrying stderr + returncode
 *   - runCmd               — thin spawn wrapper (check, timeout, capture)
 *   - NETWORK_ERROR_PATTERNS / isNetworkError — network-failure detection
 *   - runWithRetry         — exponential-backoff retry on network GitOpError
 *   - git / gh             — high-level wrappers that accept a Config-like cfg
 */

import { spawn } from "node:child_process";
import { log } from "./logging.js";

// ---------------------------------------------------------------------------
// GitOpError
// ---------------------------------------------------------------------------

export class GitOpError extends Error {
  constructor(
    message: string,
    public readonly stderr = "",
    public readonly returncode = 1,
  ) {
    super(message);
    this.name = "GitOpError";
  }
}

// ---------------------------------------------------------------------------
// runCmd
// ---------------------------------------------------------------------------

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  cwd?: string;
  timeoutMs?: number;
  /** When true (default), a non-zero exit code throws GitOpError. */
  check?: boolean;
}

/**
 * Spawn `argv[0]` with `argv.slice(1)`, capturing stdout+stderr as UTF-8.
 *
 * Mirrors Python `_run_cmd(capture_output=True, text=True, check=…, timeout=…)`.
 */
export async function runCmd(argv: string[], opts: RunOpts = {}): Promise<CmdResult> {
  const { cwd, timeoutMs = 120_000, check = true } = opts;
  const [bin, ...args] = argv;

  log.debug(`exec: ${argv.join(" ")}${cwd ? ` (cwd=${cwd})` : ""}`);

  return new Promise<CmdResult>((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // FileNotFoundError equivalent
      reject(new GitOpError(`command not found: ${bin} (${e})`));
      return;
    }

    let stdout = "";
    let stderr = "";

    // stdio is ["ignore", "pipe", "pipe"] so stdout/stderr are always Readable.
    // The type is Readable|null because spawn() types can't encode our opts statically.
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });

    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new GitOpError(`command not found: ${bin} (${err.message})`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? 1;

      if (timedOut) {
        reject(new GitOpError(`${bin} timed out after ${timeoutMs}ms`, stderr, exitCode));
        return;
      }

      if (check && exitCode !== 0) {
        reject(
          new GitOpError(`${bin} ${args[0] ?? ""} failed (exit ${exitCode})`, stderr, exitCode),
        );
        return;
      }

      resolve({ code: exitCode, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Network-error detection
// ---------------------------------------------------------------------------

/**
 * The exact 10 lowercased substrings from worker.py `_NETWORK_ERROR_PATTERNS`.
 * Patterns are intentionally lower-cased and matched via substring search.
 */
export const NETWORK_ERROR_PATTERNS: readonly string[] = [
  "i/o timeout",
  "dial tcp",
  "could not resolve host",
  "connection refused",
  "couldn't connect to server",
  "error connecting to api.github.com",
  "network is unreachable",
  "tls handshake timeout",
  "failed to connect",
  "operation timed out",
] as const;

/** Case-insensitive substring match against NETWORK_ERROR_PATTERNS. */
export function isNetworkError(stderr: string): boolean {
  const s = (stderr ?? "").toLowerCase();
  return NETWORK_ERROR_PATTERNS.some((p) => s.includes(p));
}

// ---------------------------------------------------------------------------
// runWithRetry
// ---------------------------------------------------------------------------

export interface RetryOpts {
  /** Total number of attempts (default: 4). */
  attempts?: number;
  /** Base delay in ms; doubles each retry: 1×, 2×, 4× (default: 1000). */
  baseDelayMs?: number;
}

/**
 * Run `fn`. On `GitOpError` whose stderr matches a network-failure pattern,
 * retry with exponential backoff (`baseDelayMs * 2**(i-1)` for attempt i).
 * Non-network errors (or non-GitOpError exceptions) propagate immediately.
 *
 * Mirrors Python `_run_with_retry`.
 */
export async function runWithRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: RetryOpts,
): Promise<T> {
  const { attempts = 4, baseDelayMs = 1000 } = opts ?? {};
  let lastErr: GitOpError | undefined;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof GitOpError)) {
        // Non-GitOpError: propagate immediately (mirrors Python raise on non-GitOpError)
        throw e;
      }
      const stderr = e.stderr || e.message;
      if (!isNetworkError(stderr)) {
        // Non-network GitOpError: propagate immediately
        throw e;
      }
      lastErr = e;
      if (i === attempts) {
        break; // exhausted; fall through to throw below
      }
      const delay = baseDelayMs * 2 ** (i - 1);
      log.warn(
        `network op '${label}' failed (attempt ${i}/${attempts}); retrying in ${(delay / 1000).toFixed(1)}s: ${String(e).split("\n")[0].slice(0, 160)}`,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }

  // lastErr is always set here because we only break/fall-through on a GitOpError
  throw lastErr!;
}

// ---------------------------------------------------------------------------
// git / gh wrappers
// ---------------------------------------------------------------------------

/**
 * Run a git command via `cfg.gitBin`.
 * If `retryNetwork` is true, wraps in `runWithRetry` with label `git <subcommand>`.
 */
export async function git(
  cfg: { gitBin: string },
  args: string[],
  opts?: RunOpts & { retryNetwork?: boolean },
): Promise<CmdResult> {
  const { retryNetwork, ...runOpts } = opts ?? {};
  const argv = [cfg.gitBin, ...args];
  const label = `git ${args[0] ?? ""}`;

  if (retryNetwork) {
    return runWithRetry(label, () => runCmd(argv, runOpts));
  }
  return runCmd(argv, runOpts);
}

/**
 * Run a gh command via `cfg.ghBin`.
 * If `retryNetwork` is true, wraps in `runWithRetry` with label `gh <sub> <sub2>`.
 */
export async function gh(
  cfg: { ghBin: string },
  args: string[],
  opts?: RunOpts & { retryNetwork?: boolean },
): Promise<CmdResult> {
  const { retryNetwork, ...runOpts } = opts ?? {};
  const argv = [cfg.ghBin, ...args];
  const label = `gh ${args.slice(0, 2).join(" ")}`;

  if (retryNetwork) {
    return runWithRetry(label, () => runCmd(argv, runOpts));
  }
  return runCmd(argv, runOpts);
}
