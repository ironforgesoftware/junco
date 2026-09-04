/**
 * The one way junco runs its own CLI from inside a process: argv arrays only
 * (no shell, no injection surface), merged stdout+stderr, a hard timeout,
 * and a promise that ALWAYS resolves. Shared by the dashboard's command
 * palette (src/tui/cliRunner.ts) and the daemon's chat submit tool
 * (src/chat/submitExec.ts) — the daemon never imports from src/tui.
 * No --config is threaded through: the child inherits the environment and
 * resolves the same canonical ~/.junco/config.json itself.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface CliRunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export interface CliRunnerDeps {
  spawnFn?: typeof spawn;
  cliPath?: string;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

// From dist/cliSpawn.js, ./cli.js is dist/cli.js — the shipped entry. (Tests
// always inject cliPath; the default only runs in a built tree.)
const DEFAULT_CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

/** Run `junco <argv>`; resolves ALWAYS (errors land in `output`). */
export function spawnCli(argv: string[], deps: CliRunnerDeps = {}): Promise<CliRunResult> {
  const spawnFn = deps.spawnFn ?? spawn;
  const cliPath = deps.cliPath ?? DEFAULT_CLI_PATH;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise) => {
    const chunks: string[] = [];
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(process.execPath, [cliPath, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolvePromise({ code: null, output: String((e as Error).message ?? e), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: timedOut ? null : code, output: chunks.join(""), timedOut });
    };
    child.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.stderr?.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.on("close", (code: number | null) => settle(code));
    child.on("error", (e: Error) => {
      chunks.push(String(e.message ?? e));
      settle(null);
    });
  });
}
