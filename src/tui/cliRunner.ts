/**
 * Command-palette roster + subprocess runner.
 *
 * The dashboard runs CLI subcommands by SPAWNING the real junco CLI (argv
 * arrays only — no shell, no injection surface) with the dashboard's own
 * --config, capturing merged stdout+stderr for the output view. Thin shell:
 * a future subcommand needs only a roster row here.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface PaletteCommand {
  name: string;
  /** Placeholder hint for the args field; null = takes no args. */
  argsHint: string | null;
  description: string;
  /** Args always prepended when none are typed (e.g. bounded logs). */
  defaultArgs: string[];
  /** Non-null = not runnable from the palette; the string is the reason. */
  excluded: string | null;
  /** Subprocess time budget; null = DEFAULT_TIMEOUT_MS. Long-runners only:
   * assess may fork+clone an unwatched repo, run-once executes a full ticket. */
  timeoutMs: number | null;
}

const cmd = (
  name: string,
  argsHint: string | null,
  description: string,
  defaultArgs: string[] = [],
  excluded: string | null = null,
  timeoutMs: number | null = null,
): PaletteCommand => ({ name, argsHint, description, defaultArgs, excluded, timeoutMs });

/** Mirrors cli.ts USAGE — a consistency test pins runnable names to it. The
 * one exception is "setup": App intercepts it in-process (the Root host swaps
 * to the setup walkthrough) instead of spawning a subprocess, so it has no
 * cli.ts USAGE row by design. */
export const PALETTE_COMMANDS: PaletteCommand[] = [
  cmd("status", null, "Daemon / endpoint / queue health at a glance"),
  cmd("list", "[box]", "List tickets per queue box (inbox|processing|done|failed)"),
  cmd("retry", "<name…|--all>", "Move failed tickets back to the inbox"),
  cmd("rm", "<name>", "Delete a queued ticket from the inbox"),
  cmd("outbox", "[flush]", "List or push the offline GitHub backlog"),
  cmd("prs", null, "List junco-authored pull requests"),
  cmd(
    "assess",
    "<path|owner/repo> [--auto-plan]",
    "Audit a repo for vulnerabilities and file GitHub issues",
    [],
    null,
    600_000, // issue-ref targets may fork + full-clone an unwatched repo
  ),
  cmd("doctor", null, "Preflight: config, git, gh auth, endpoint, model, dirs"),
  cmd("logs", "[-n N]", "Show the worker log (bounded)", ["-n", "200", "--human"]),
  cmd("run-once", null, "Process one task and exit (no lock)", [], null, 3_600_000),
  cmd("restart", null, "Restart the supervised daemon"),
  cmd("worktree", "prune <path>", "Prune a stale/backup worktree (lock-guarded)"),
  cmd("service", "[--platform launchd|systemd]", "Render a service file"),
  cmd("inbox-path", null, "Print the inbox directory path"),
  cmd("schema", null, "Print the ticket frontmatter JSON Schema"),
  cmd("submit", "<file|->", "Submit a ticket to the inbox"),
  cmd("setup", null, "Guided setup walkthrough (runs inside the dashboard)"),
  cmd("dashboard", null, "This dashboard", [], "already running"),
  cmd("start", null, "Start the daemon", [], "foreground daemon would block — use restart"),
];

export const DEFAULT_TIMEOUT_MS = 120_000;

/** Palette subprocess budget: the roster override or the 120 s default. */
export function timeoutFor(name: string): number {
  return PALETTE_COMMANDS.find((c) => c.name === name)?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

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

// From dist/tui/cliRunner.js, ../cli.js is dist/cli.js — the shipped entry.
// (Tests always inject cliPath; the default only runs in a built tree.)
const DEFAULT_CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));

/** Run one subcommand; resolves ALWAYS (errors land in `output`). */
export function runCliCommand(
  configPath: string,
  name: string,
  extraArgs: string[],
  deps: CliRunnerDeps = {},
): Promise<CliRunResult> {
  const spawnFn = deps.spawnFn ?? spawn;
  const cliPath = deps.cliPath ?? DEFAULT_CLI_PATH;
  const timeoutMs = deps.timeoutMs ?? timeoutFor(name);

  return new Promise((resolvePromise) => {
    const chunks: string[] = [];
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(process.execPath, [cliPath, name, ...extraArgs, "--config", configPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // "Always resolves" holds even for a synchronous spawn throw.
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
