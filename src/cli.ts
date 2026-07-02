#!/usr/bin/env node
/**
 * Junco CLI — M4 restructure.
 *
 * Subcommands:
 *   junco init [--config <path>] [--yes]     — setup wizard (writes config + queue)
 *   junco start [--config <path>] [--once]   — daemon (acquire lock, run mainLoop)
 *   junco run-once [--config <path>]         — dev/cron one-shot (no lock)
 *   junco                                    — bare → wizard on first run (no
 *                                              config yet), else start
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
import { readFileSync, mkdirSync, existsSync, realpathSync, createWriteStream } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./types.js";
import type { SingletonLock } from "./lock.js";
import { acquireSingletonLock } from "./lock.js";
import { loadConfig, queuePaths, resolveConfigPath } from "./config.js";
import { StopFlag, installSignalHandlers, mainLoop } from "./daemon.js";
import { runOnce } from "./runOnce.js";
import { makeGithubReporter } from "./githubReport.js";
import { log, setLogLevel, setLogFormat, setLogSink, rotateLogIfLarge } from "./logging.js";
import { renderService } from "./service.js";
import { inboxPath, submitTicket } from "./dispatch.js";
import { describeTicketSchema } from "./ticketSchema.js";
import { runInitWizard } from "./wizard.js";
import { runStatusCommand } from "./statusCmd.js";
import { runListCommand } from "./listCmd.js";
import { runRetryCommand } from "./retryCmd.js";
import { runDoctor } from "./doctor.js";
import { runLogsCommand } from "./logsCmd.js";

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
  /** Existence check for first-run detection (tests control routing). Default: fs.existsSync. */
  existsFn?: (path: string) => boolean;
  /** The init wizard (tests inject a spy to assert routing without touching the fs). */
  runInitWizardFn?: (configPath: string, opts: { yes?: boolean }) => Promise<number>;
}

// ---------------------------------------------------------------------------
// Usage string
// ---------------------------------------------------------------------------

const USAGE = `\
Usage: junco <subcommand> [options]

Subcommands:
  init         Interactive setup wizard — writes config.toml + creates the queue
  start        Start the daemon
  run-once     Process one task and exit (dev/cron convenience; no lock)
  service      Render a service file to stdout (launchd plist or systemd unit)
  inbox-path   Print the inbox directory path and exit
  status       Show daemon / endpoint / queue health at a glance
  list [box]   List tickets per queue box (inbox|processing|done|failed)
  retry <name…|--all>  Move failed tickets back to the inbox for a fresh run
  doctor       Preflight: config, node, git, gh auth, endpoint, model, dirs
  logs [-f] [-n N] [--json]  Show (or follow) the worker log
  submit <file|-> Submit a ticket to the inbox (use - to read from stdin)
  schema       Print the ticket frontmatter JSON Schema and exit

  (no subcommand) → runs the setup wizard on first run (no config yet),
                    otherwise starts the daemon.

Options:
  --config <path>       Path to config.toml
                        [default: ./config.toml if present, else ~/.config/junco/config.toml]
  --yes, -y             (init) Scaffold a default config without prompting
  --once                (start) Process one task then exit
  --platform <name>     (service) Target platform: launchd | systemd
                        [default: launchd on macOS, systemd elsewhere]
  --help, -h            Show this help message
`;

// ---------------------------------------------------------------------------
// Daemon-mode log plumbing
// ---------------------------------------------------------------------------

/**
 * Human format on a TTY (JUNCO_LOG_JSON=1 forces JSON), plus a JSON tee to the
 * state-dir worker.log (10MB single-generation rotation). Returns a cleanup
 * that detaches the sink and closes the stream.
 */
function setupLogOutputs(cfg: Config): () => void {
  if (process.stdout.isTTY && process.env.JUNCO_LOG_JSON !== "1") setLogFormat("human");
  if (!cfg.logToFile) return () => {};
  try {
    const logPath = join(cfg.stateDir, "worker.log");
    mkdirSync(cfg.stateDir, { recursive: true });
    rotateLogIfLarge(logPath);
    const stream = createWriteStream(logPath, { flags: "a" });
    setLogSink((l) => stream.write(l + "\n"));
    return () => {
      setLogSink(null);
      stream.end();
    };
  } catch (e) {
    log.warn("file logging disabled (state dir not writable)", {
      error: e instanceof Error ? e.message : String(e),
    });
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// run — pure-ish; returns exit code, never calls process.exit
// ---------------------------------------------------------------------------

export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  // Resolve injected collaborators (defaults wire to the real implementations)
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const acquireLockFn = deps.acquireLockFn ?? acquireSingletonLock;
  const installSignalHandlersFn = deps.installSignalHandlersFn ?? installSignalHandlers;
  const mainLoopFn = deps.mainLoopFn ?? mainLoop;
  // The manual run-once poke reports back to GitHub too when the bridge is on
  // (a daemon-claimed bridged ticket would otherwise leave its issue stale).
  const runOnceFn =
    deps.runOnceFn ??
    ((c: Config) => runOnce(c, { reporter: c.github.enabled ? makeGithubReporter(c) : undefined }));

  // Parse argv
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      once: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      platform: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      all: { type: "boolean", default: false },
      follow: { type: "boolean", short: "f", default: false },
      lines: { type: "string", short: "n" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  // --help / -h
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const existsFn = deps.existsFn ?? ((p: string) => existsSync(p));
  // Resolve the config path ONCE: explicit --config → ./config.toml when
  // present → the user-level default (~/.config/junco/config.toml).
  const configPath = resolveConfigPath(values.config as string | undefined, { existsFn });
  // First-run aware: a bare invocation runs the setup wizard when there's no
  // config yet, and starts the daemon once one exists.
  const subcommand = positionals[0] ?? (existsFn(configPath) ? "start" : "init");

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

    // Resolve cliEntry: use the script that was invoked (process.argv[1]),
    // falling back to the binary field in package.json if unavailable.
    const cliEntry = resolve(process.argv[1] ?? "dist/cli.js");

    // Best-effort config read: size the stop timeout to the ticket timeout
    // (+10 min drain margin) and put launchd logs under the state dir. No
    // config yet → renderService falls back to its own defaults.
    let stopTimeoutSeconds: number | undefined;
    let logDir: string | undefined;
    try {
      const cfg = loadConfigFn(configPath);
      stopTimeoutSeconds = (cfg.defaultTimeoutMinutes + 10) * 60;
      logDir = cfg.stateDir;
    } catch {
      /* fall back to renderer defaults */
    }

    const rendered = renderService(platform, { cliEntry, configPath, stopTimeoutSeconds, logDir });
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
    const cfg = loadConfigFn(configPath);
    setLogLevel(cfg.logLevel);
    const teardownLogs = setupLogOutputs(cfg);
    try {
      const handled = await runOnceFn(cfg);
      log.info("run-once complete", { handled });
      return 0;
    } finally {
      teardownLogs();
    }
  }

  // ------------------------------------------------------------
  // start (or bare / default)
  // ------------------------------------------------------------
  if (subcommand === "start") {
    const cfg = loadConfigFn(configPath);
    setLogLevel(cfg.logLevel);
    const teardownLogs = setupLogOutputs(cfg);

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
      teardownLogs();
    }
  }

  // ------------------------------------------------------------
  // inbox-path: print the inbox directory and exit
  // ------------------------------------------------------------
  if (subcommand === "inbox-path") {
    const cfg = loadConfigFn(configPath);
    printFn(inboxPath(cfg) + "\n");
    return 0;
  }

  // ------------------------------------------------------------
  // status: daemon /health + queue counts at a glance
  // ------------------------------------------------------------
  if (subcommand === "status") {
    const cfg = loadConfigFn(configPath);
    return runStatusCommand(cfg, {
      printFn,
      lockPath: join(dirname(resolve(configPath)), "worker.lock"),
    });
  }

  // ------------------------------------------------------------
  // list: newest-first ticket listing per queue box
  // ------------------------------------------------------------
  if (subcommand === "list") {
    const cfg = loadConfigFn(configPath);
    return runListCommand(cfg, positionals[1], { printFn });
  }

  // ------------------------------------------------------------
  // retry: clean failed tickets and resubmit them to the inbox
  // ------------------------------------------------------------
  if (subcommand === "retry") {
    const cfg = loadConfigFn(configPath);
    return runRetryCommand(cfg, positionals.slice(1), { all: values.all as boolean }, { printFn });
  }

  // ------------------------------------------------------------
  // doctor: preflight external dependencies (loads config itself so a broken
  // one is reported as a finding instead of crashing the command)
  // ------------------------------------------------------------
  if (subcommand === "doctor") {
    return runDoctor(configPath, { loadConfigFn, printFn });
  }

  // ------------------------------------------------------------
  // logs: tail/follow the state-dir worker.log
  // ------------------------------------------------------------
  if (subcommand === "logs") {
    const cfg = loadConfigFn(configPath);
    const n = values.lines !== undefined ? parseInt(values.lines as string, 10) : undefined;
    return runLogsCommand(cfg, {
      follow: values.follow as boolean,
      lines: Number.isInteger(n) && (n as number) > 0 ? n : undefined,
      json: (values.json as boolean) || undefined,
    });
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
        const readStdinFn =
          deps.readStdinFn ??
          (() =>
            new Promise<string>((resolve, reject) => {
              let buf = "";
              process.stdin.setEncoding("utf8");
              process.stdin.on("data", (chunk) => {
                buf += chunk;
              });
              process.stdin.on("end", () => resolve(buf));
              process.stdin.on("error", reject);
            }));
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

    const cfg = loadConfigFn(configPath);
    const idHint = fileArg !== "-" ? basename(fileArg).replace(/\.md$/, "") : undefined;

    let dst: string;
    try {
      dst = submitTicket(cfg, content, { idHint });
    } catch (e) {
      process.stderr.write(`junco submit: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }

    printFn(`submitted: ${dst}\n`);
    return 0;
  }

  // ------------------------------------------------------------
  // init: interactive setup wizard (writes config + creates the queue) when no
  // config exists; ensures the queue dirs (no overwrite) when one already does.
  // ------------------------------------------------------------
  if (subcommand === "init") {
    if (!existsFn(resolve(configPath))) {
      const wantYes = values.yes as boolean;
      // Non-TTY guard: never hang on a prompt in pipes/CI. An injected
      // runInitWizardFn counts as "interactive"; --yes scaffolds without prompting.
      if (!wantYes && !deps.runInitWizardFn && !process.stdin.isTTY) {
        process.stderr.write(
          `junco init: no config at ${resolve(configPath)} and not an interactive terminal.\n` +
            `  Run \`junco init\` in a terminal, pass --yes to scaffold defaults, or create config.toml.\n`,
        );
        return 1;
      }
      const runWizard =
        deps.runInitWizardFn ??
        ((cp: string, o: { yes?: boolean }) => runInitWizard(cp, { yes: o.yes, printFn }));
      return runWizard(configPath, { yes: wantYes });
    }

    // Config already present — ensure the queue dirs, never overwrite the config.
    const cfg = loadConfigFn(configPath);
    const paths = queuePaths(cfg);
    for (const d of [paths.inbox, paths.processing, paths.done, paths.failed, cfg.worktreeRoot]) {
      mkdirSync(d, { recursive: true });
    }
    printFn(
      `Config already exists at ${resolve(configPath)}; ensured queue directories:\n` +
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
// Top-level entry point (thin wrapper — keeps process.exit out of run()).
//
// Only self-invoke when this module is the actual entry point — NOT when it is
// imported (e.g. by the test suite), which would otherwise run the CLI + call
// process.exit on import. realpathSync resolves the bin symlink npm creates so
// the check holds for global installs and npx.
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      log.error("fatal", { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
      process.exit(1);
    });
}
