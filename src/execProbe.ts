/**
 * Shared probe seam for `junco doctor` and the wizard detect layer
 * (src/wizard/detect.ts): a bare-metal `execFile` wrapper and a
 * mkdir+W_OK writability check, both injectable via each caller's own
 * `execFn`/`accessOkFn` deps so tests never touch a real process or disk.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";

export function defaultExec(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function defaultAccessOk(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
