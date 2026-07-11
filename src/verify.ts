import { spawn } from "node:child_process";
import type { Config, Ticket } from "./types.js";
import { scrubEnv } from "./scrubEnv.js";

// ---------------------------------------------------------------------------
// Spec verification — port of worker.py `run_spec_verification` (line 2850)
//
// Runs the ticket's `## Verification` fenced bash blocks inside the worktree
// after the agent session completes. Result is informational only.
//
// Hardening rails (#35) — verification bash is ticket-authored and runs
// OUTSIDE the ticket's timeoutSeconds (which bounds only the agent session):
//  - at most MAX_VERIFICATION_BLOCKS blocks execute; the rest are reported
//    as skipped failures,
//  - the whole run is bounded by an aggregate wall-clock deadline
//    (command_timeout × executed blocks, capped at VERIFICATION_MAX_TOTAL_MS),
//  - blocks receive a minimal env allowlist, never the worker's full
//    process.env (which holds GH_TOKEN / inference-endpoint API keys).
// ---------------------------------------------------------------------------

export interface VerificationResult {
  blocksRun: number;
  blocksPassed: number;
  failedOutputs: Array<{ preview: string; exitCode: number; output: string }>;
  skippedReason: string | null;
}

/** Injectable seams for runSpecVerification (tests fake the block runner + clock). */
export interface VerifyDeps {
  runBlockFn?: (
    block: string,
    wtPath: string,
    timeoutMs: number,
  ) => Promise<{ exitCode: number; output: string }>;
  nowFn?: () => number;
}

/** Cap on executed verification blocks per ticket; blocks beyond it are
 * reported as skipped failures (exitCode -3), never spawned. */
export const MAX_VERIFICATION_BLOCKS = 10;

/** Hard cap on the aggregate verification wall clock. The effective deadline
 * is min(command_timeout × executed blocks, this cap) — with the default 60s
 * command_timeout and the 10-block cap they coincide at 10 minutes. */
export const VERIFICATION_MAX_TOTAL_MS = 10 * 60_000;

/** Build the scrubbed child env for verification blocks: never the worker's
 * full process.env (which holds GH_TOKEN / inference-endpoint API keys). See
 * scrubEnv (#35) — the same allowlist now also guards the sandboxed agent bash. */
export function verificationEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return scrubEnv(source);
}

// Mirrors Python's:
//   _VERIFY_HEADING_RE = re.compile(r"(?ms)^##\s+Verification\b.*?(?=^##\s|\Z)")
// JS does not have \Z (match end-of-string). We use two passes:
//   1. Match up to the next ## heading (lazy, with dotAll+multiline).
//   2. If no next heading, match from the ## Verification heading to end.
const VERIFY_HEADING_UNTIL_NEXT_RE = /^##\s+Verification\b.*?(?=^##\s)/ms;
const VERIFY_HEADING_TO_END_RE = /^##\s+Verification\b[\s\S]*/m;

// _BASH_FENCE_RE = re.compile(r"```bash\s*\n(.*?)```", re.DOTALL)
const BASH_FENCE_RE = /```bash\s*\n([\s\S]*?)```/g;

/**
 * Find the `## Verification` section within the ticket body (matching Python's
 * `_VERIFY_HEADING_RE`), then extract each ```bash fenced block from it.
 * Returns the block contents stripped of their fence markers.
 */
export function extractVerificationBlocks(body: string): string[] {
  // Try to match up to the next `## ` heading first; fall back to end-of-string.
  const sectionMatch =
    VERIFY_HEADING_UNTIL_NEXT_RE.exec(body) ?? VERIFY_HEADING_TO_END_RE.exec(body);
  if (!sectionMatch) return [];
  const section = sectionMatch[0];
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  BASH_FENCE_RE.lastIndex = 0;
  while ((m = BASH_FENCE_RE.exec(section)) !== null) {
    const content = m[1].trim();
    if (content) blocks.push(content);
  }
  return blocks;
}

/**
 * Run a single bash block in wtPath, capturing combined stdout+stderr.
 * Returns `{ exitCode, output }`. On timeout exitCode = -1.
 */
function runBlock(
  block: string,
  wtPath: string,
  timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn("/bin/bash", ["-c", block], {
      cwd: wtPath,
      stdio: ["ignore", "pipe", "pipe"],
      // Never the worker's full process.env — see verificationEnv (#35).
      env: verificationEnv(),
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ exitCode: -1, output: `timed out after ${timeoutMs / 1000}s` });
      } else {
        resolve({
          exitCode: code ?? -2,
          output: (stdout + stderr).slice(0, 1500),
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -2, output: `verification harness error: ${err}` });
    });
  });
}

/**
 * Port of Python's `run_spec_verification`. Runs each ```bash block in the
 * ticket's `## Verification` section in the given worktree directory.
 *
 * `blocksRun` counts every block found in the section; blocks skipped by the
 * block cap or the aggregate deadline land in `failedOutputs` with
 * exitCode -3 so the PR comment / verify gate treat them as failures.
 */
export async function runSpecVerification(
  cfg: Config,
  task: Ticket,
  wtPath: string,
  deps: VerifyDeps = {},
): Promise<VerificationResult> {
  if (!cfg.verifyEnabled) {
    return {
      blocksRun: 0,
      blocksPassed: 0,
      failedOutputs: [],
      skippedReason: "cfg.verify_enabled=false",
    };
  }

  const blocks = extractVerificationBlocks(task.body);
  if (blocks.length === 0) {
    return {
      blocksRun: 0,
      blocksPassed: 0,
      failedOutputs: [],
      skippedReason: "no `## Verification` block in ticket",
    };
  }

  const runBlockFn = deps.runBlockFn ?? runBlock;
  const now = deps.nowFn ?? Date.now;

  let passed = 0;
  const failedOutputs: VerificationResult["failedOutputs"] = [];
  const perBlockMs = cfg.verifyCommandTimeout * 1000;

  const toRun = blocks.slice(0, MAX_VERIFICATION_BLOCKS);
  const overCap = blocks.slice(MAX_VERIFICATION_BLOCKS);
  const totalMs = Math.min(perBlockMs * toRun.length, VERIFICATION_MAX_TOTAL_MS);
  const deadline = now() + totalMs;

  const previewOf = (block: string): string =>
    block ? block.split("\n")[0].slice(0, 80) : "(empty)";

  for (const block of toRun) {
    const preview = previewOf(block);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      failedOutputs.push({
        preview,
        exitCode: -3,
        output: `skipped: aggregate verification deadline (${totalMs / 1000}s) exceeded`,
      });
      continue;
    }
    try {
      const { exitCode, output } = await runBlockFn(
        block,
        wtPath,
        Math.min(perBlockMs, remainingMs),
      );
      if (exitCode === 0) {
        passed++;
      } else {
        failedOutputs.push({ preview, exitCode, output });
      }
    } catch (e) {
      failedOutputs.push({
        preview,
        exitCode: -2,
        output: `verification harness error: ${e}`,
      });
    }
  }

  for (const block of overCap) {
    failedOutputs.push({
      preview: previewOf(block),
      exitCode: -3,
      output: `skipped: verification block cap (${MAX_VERIFICATION_BLOCKS}) reached`,
    });
  }

  return {
    blocksRun: blocks.length,
    blocksPassed: passed,
    failedOutputs,
    skippedReason: null,
  };
}
