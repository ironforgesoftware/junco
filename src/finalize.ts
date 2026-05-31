import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { RunResult } from "./types.js";

export interface TerminalDirs { done: string; failed: string; }

function statusFor(r: RunResult): string {
  if (r.timedOut) return "timeout";
  if (r.errorMessage) return "failed";
  return "completed";
}

function renderResult(original: string, status: string, r: RunResult): string {
  const reply = r.finalText || "_(no assistant text)_";
  const stats = `**Elapsed:** ${Math.round(r.durationMs / 1000)}s · **Tokens:** in=${r.usage.input} out=${r.usage.output}`;
  const meta = `status: ${status}\nstop_reason: ${r.stopReason ?? "null"}\nduration_seconds: ${Math.round(r.durationMs / 1000)}`;
  return `${original.trimEnd()}\n\n---\n<!-- junco-result\n${meta}\n-->\n\n## Result\n\n${stats}\n\n${reply}\n`;
}

export function finalize(ticketPath: string, result: RunResult, dirs: TerminalDirs): string {
  const status = statusFor(result);
  const body = renderResult(readFileSync(ticketPath, "utf8"), status, result);

  // Atomic content update: write a sibling temp then rename into place (so a
  // crash mid-write can't leave a truncated ticket) — the PR #1 pattern.
  const tmp = ticketPath + ".tmp";
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, ticketPath);

  const dstDir = status === "completed" ? dirs.done : dirs.failed;
  mkdirSync(dstDir, { recursive: true });
  const dst = join(dstDir, basename(ticketPath));
  renameSync(ticketPath, dst); // atomic move, same filesystem
  return dst;
}
