/**
 * Command-palette roster + subprocess runner.
 *
 * The dashboard runs CLI subcommands via `spawnCli` (../cliSpawn.js) — argv
 * arrays only (no shell, no injection surface), merged stdout+stderr for the
 * output view, no --config flag threaded through. Thin shell: a future
 * subcommand needs only a roster row here.
 */

import {
  spawnCli,
  DEFAULT_TIMEOUT_MS,
  type CliRunResult,
  type CliRunnerDeps,
} from "../cliSpawn.js";
export { DEFAULT_TIMEOUT_MS, type CliRunResult, type CliRunnerDeps };

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
   * audit may fork+clone an unwatched repo, run-once executes a full ticket. */
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
  cmd("unwatch", "<owner/repo> [--plan]", "Stop watching a repo and delete its junco-owned state"),
  cmd("outbox", "[flush]", "List or push the offline GitHub backlog"),
  cmd("prs", null, "List junco-authored pull requests"),
  cmd(
    "audit",
    "<path|owner/repo> [--auto-plan]",
    "Audit a repo for vulnerabilities and file GitHub issues",
    [],
    null,
    600_000, // issue-ref targets may fork + full-clone an unwatched repo
  ),
  cmd("transcript", "<ticket-id> [--thinking] [--tools]", "Print a ticket's event transcript"),
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

/** Palette subprocess budget: the roster override or the 120 s default. */
export function timeoutFor(name: string): number {
  return PALETTE_COMMANDS.find((c) => c.name === name)?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

/** Run one palette subcommand with the roster's time budget; resolves ALWAYS. */
export function runCliCommand(
  name: string,
  extraArgs: string[],
  deps: CliRunnerDeps = {},
): Promise<CliRunResult> {
  return spawnCli([name, ...extraArgs], { ...deps, timeoutMs: deps.timeoutMs ?? timeoutFor(name) });
}
