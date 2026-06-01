#!/usr/bin/env node
/**
 * Junco CLI — M4 restructure.
 *
 * Subcommands:
 *   junco start [--config <path>] [--once]   — daemon (acquire lock, run mainLoop)
 *   junco run-once [--config <path>]         — dev/cron one-shot (no lock)
 *   junco                                    — bare → defaults to start
 *   junco --help | -h                        — usage
 *
 * `run(argv, deps)` is a pure-ish function that returns an exit code without
 * calling process.exit — testable without real daemon/lock/signals/fs.
 * The thin top-level calls run(process.argv.slice(2)) and process.exit(code).
 *
 * Port of worker.py main() + parse_argv() (lines 3411-3440).
 */

import { parseArgs } from "node:util";
import { resolve, dirname, join } from "node:path";
import { readFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import type { Config } from "./types.js";
import type { SingletonLock } from "./lock.js";
import { acquireSingletonLock } from "./lock.js";
import { loadConfig, queuePaths } from "./config.js";
import { StopFlag, installSignalHandlers, mainLoop } from "./daemon.js";
import { runOnce } from "./runOnce.js";
import { log, setLogLevel } from "./logging.js";
import { renderService } from "./service.js";
import { inboxPath, submitTicket } from "./dispatch.js";
import { describeTicketSchema } from "./ticketSchema.js";

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface CliDeps {
  loadConfigFn?: (path: string) => Config;
  acquireLockFn?: (lockPath: string) => SingletonLock | null;
  installSignalHandlersFn?: (stopFlag: StopFlag) => () => void;
  mainLoopFn?: (cfg: Config, stopFlag: StopFlag, opts: { once?: boolean }) => Promise<void>;
  runOnceFn?: (cfg: Config) => Promise<boolean>;
  /** Output function for the `service`, `inbox-path`, `schema`, `submit`, `init` subcommands. Default: process.stdout.write. */
  printFn?: (s: string) => void;
  /** Read stdin as a UTF-8 string. Injected so tests can supply content without a real stdin. */
  readStdinFn?: () => Promise<string>;
}

// ---------------------------------------------------------------------------
// Usage string
// ---------------------------------------------------------------------------

const USAGE = `\
Usage: junco <subcommand> [options]

Subcommands:
  start        Start the daemon (default when no subcommand is given)
  run-once     Process one task and exit (dev/cron convenience; no lock)
  service      Render a service file to stdout (launchd plist or systemd unit)
  inbox-path   Print the inbox directory path and exit
  submit <file|-> Submit a ticket to the inbox (use - to read from stdin)
  schema       Print the ticket frontmatter JSON Schema and exit
  init         Create queue directories for a new vault

Options:
  --config <path>       Path to config.toml  [default: config.toml]
  --once                (start) Process one task then exit
  --platform <name>     (service) Target platform: launchd | systemd
                        [default: launchd on macOS, systemd elsewhere]
  --help, -h            Show this help message
`;

// ---------------------------------------------------------------------------
// run — pure-ish; returns exit code, never calls process.exit
// ---------------------------------------------------------------------------

export async function run(
  argv: string[],
  deps: CliDeps = {},
): Promise<number> {
  // Resolve injected collaborators (defaults wire to the real implementations)
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const acquireLockFn = deps.acquireLockFn ?? acquireSingletonLock;
  const installSignalHandlersFn = deps.installSignalHandlersFn ?? installSignalHandlers;
  const mainLoopFn = deps.mainLoopFn ?? mainLoop;
  const runOnceFn = deps.runOnceFn ?? runOnce;

  // Parse argv
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", default: "config.toml" },
      once: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      platform: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  // --help / -h
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const subcommand = positionals[0] ?? "start";

  // Resolve injected print function (defaults to process.stdout.write)
  const printFn = deps.printFn ?? ((s: string) => process.stdout.write(s));

  // ------------------------------------------------------------
  // service: render launchd plist or systemd unit to stdout
  // ------------------------------------------------------------
  if (subcommand === "service") {
    const rawPlatform = values.platform as string | undefined;
    const platform: "launchd" | "systemd" =
      rawPlatform === "launchd" || rawPlatform === "systemd"
        ? rawPlatform
        : process.platform === "darwin"
        ? "launchd"
        : "systemd";

    const configPath = resolve(values.config as string);
    // Resolve cliEntry: use the script that was invoked (process.argv[1]),
    // falling back to the binary field in package.json if unavailable.
    const cliEntry = resolve(process.argv[1] ?? "dist/cli.js");

    const rendered = renderService(platform, { cliEntry, configPath });
    printFn(rendered + "\n");

    // Print install hint to stderr
    if (platform === "launchd") {
      process.stderr.write(
        "# Install: cp <file> ~/Library/LaunchAgents/ && launchctl bootstrap gui/$UID ~/Library/LaunchAgents/<label>.plist\n",
      );
    } else {
      process.stderr.write(
        "# Install: cp <file> ~/.config/systemd/user/junco.service && systemctl --user enable --now junco\n",
      );
    }

    return 0;
  }

  // ------------------------------------------------------------
  // run-once: single runOnce() attempt — intentionally NO singleton lock.
  //
  // Python's main() locks even for --once because its startup recover_orphans
  // sweep would otherwise steal the live daemon's in-flight task into failed/
  // (worker.py:569-572). That risk is STRUCTURALLY ABSENT here: run-once calls
  // runOnce() directly and never runs recoverOrphans (only mainLoop does). The
  // claim is an atomic rename, so a manual run-once and a live daemon can never
  // win the same ticket. Keeping it lock-free makes it a clean cron/dev poke.
  //
  // ⚠️ If you ever add an orphan sweep (or any processing/ mutation) to this
  // path, you MUST acquire the lock first — otherwise you reintroduce exactly
  // the daemon-collision bug the lock exists to prevent.
  // ------------------------------------------------------------
  if (subcommand === "run-once") {
    const cfg = loadConfigFn(values.config as string);
    setLogLevel(cfg.logLevel);
    const handled = await runOnceFn(cfg);
    log.info("run-once complete", { handled });
    return 0;
  }

  // ------------------------------------------------------------
  // start (or bare / default)
  // ------------------------------------------------------------
  if (subcommand === "start") {
    const configPath = values.config as string;
    const cfg = loadConfigFn(configPath);
    setLogLevel(cfg.logLevel);

    // Derive lock path: mirror Python args.config.resolve().parent / "worker.lock"
    const lockPath = join(dirname(resolve(configPath)), "worker.lock");

    const lock = acquireLockFn(lockPath);
    if (lock === null) {
      log.warn("another instance holds the lock; exiting", { lockPath });
      // Exit 0 — process supervisor must NOT respawn-loop on a "lock held" situation
      return 0;
    }

    const stopFlag = new StopFlag();
    const uninstall = installSignalHandlersFn(stopFlag);

    try {
      await mainLoopFn(cfg, stopFlag, { once: values.once as boolean });
      return 0;
    } catch (e) {
      log.error("fatal error in main loop", {
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
      return 1;
    } finally {
      uninstall();
      lock.release();
    }
  }

  // ------------------------------------------------------------
  // inbox-path: print the inbox directory and exit
  // ------------------------------------------------------------
  if (subcommand === "inbox-path") {
    const cfg = loadConfigFn(values.config as string);
    printFn(inboxPath(cfg) + "\n");
    return 0;
  }

  // ------------------------------------------------------------
  // schema: print the ticket frontmatter JSON Schema (no config needed)
  // ------------------------------------------------------------
  if (subcommand === "schema") {
    printFn(describeTicketSchema() + "\n");
    return 0;
  }

  // ------------------------------------------------------------
  // submit <file|-|--config ...>: place a ticket into the inbox
  // ------------------------------------------------------------
  if (subcommand === "submit") {
    const fileArg = positionals[1];
    if (!fileArg) {
      process.stderr.write(`Usage: junco submit <file|-> [--config <path>]\n`);
      return 2;
    }

    let content: string;
    try {
      if (fileArg === "-") {
        const readStdinFn = deps.readStdinFn ?? (() =>
          new Promise<string>((resolve, reject) => {
            let buf = "";
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", (chunk) => { buf += chunk; });
            process.stdin.on("end", () => resolve(buf));
            process.stdin.on("error", reject);
          })
        );
        content = await readStdinFn();
      } else {
        content = readFileSync(fileArg, "utf8");
      }
    } catch (e) {
      process.stderr.write(
        `junco submit: cannot read '${fileArg}': ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 1;
    }

    const cfg = loadConfigFn(values.config as string);
    const idHint = fileArg !== "-" ? basename(fileArg).replace(/\.md$/, "") : undefined;

    let dst: string;
    try {
      dst = submitTicket(cfg, content, { idHint });
    } catch (e) {
      process.stderr.write(
        `junco submit: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 1;
    }

    printFn(`submitted: ${dst}\n`);
    return 0;
  }

  // ------------------------------------------------------------
  // init: scaffold queue directories for a new vault
  // ------------------------------------------------------------
  if (subcommand === "init") {
    let cfg: Config;
    try {
      cfg = loadConfigFn(values.config as string);
    } catch (e) {
      process.stderr.write(
        `junco init: could not load config — ${e instanceof Error ? e.message : String(e)}\n` +
        `  Create a config.toml with at least vault_root = "<path>" and retry.\n`,
      );
      return 1;
    }

    const paths = queuePaths(cfg);
    const dirs = [paths.inbox, paths.processing, paths.done, paths.failed, cfg.worktreeRoot];
    for (const d of dirs) {
      mkdirSync(d, { recursive: true });
    }

    printFn(
      `Initialized Junco queue directories:\n` +
      `  inbox:      ${paths.inbox}\n` +
      `  processing: ${paths.processing}\n` +
      `  done:       ${paths.done}\n` +
      `  failed:     ${paths.failed}\n` +
      `  worktrees:  ${cfg.worktreeRoot}\n`,
    );
    return 0;
  }

  // ------------------------------------------------------------
  // unknown subcommand
  // ------------------------------------------------------------
  process.stderr.write(`Unknown subcommand: ${subcommand}\n\n${USAGE}`);
  return 2;
}

// ---------------------------------------------------------------------------
// Top-level entry point (thin wrapper — keeps process.exit out of run())
// ---------------------------------------------------------------------------

run(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
  log.error("fatal", { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  process.exit(1);
});
