import { spawn } from "node:child_process";
import type { Config, Ticket } from "./types.js";

// ---------------------------------------------------------------------------
// Spec verification — port of worker.py `run_spec_verification` (line 2850)
//
// Runs the ticket's `## Verification` fenced bash blocks inside the worktree
// after the agent session completes. Result is informational only.
// ---------------------------------------------------------------------------

export interface VerificationResult {
  blocksRun: number;
  blocksPassed: number;
  failedOutputs: Array<{ preview: string; exitCode: number; output: string }>;
  skippedReason: string | null;
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
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

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
 */
export async function runSpecVerification(
  cfg: Config,
  task: Ticket,
  wtPath: string,
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

  let passed = 0;
  const failedOutputs: VerificationResult["failedOutputs"] = [];
  const timeoutMs = cfg.verifyCommandTimeout * 1000;

  for (const block of blocks) {
    const preview = block ? block.split("\n")[0].slice(0, 80) : "(empty)";
    try {
      const { exitCode, output } = await runBlock(block, wtPath, timeoutMs);
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

  return {
    blocksRun: blocks.length,
    blocksPassed: passed,
    failedOutputs,
    skippedReason: null,
  };
}
