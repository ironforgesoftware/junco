#!/usr/bin/env node
/**
 * Junco CLI — M4 restructure.
 *
 * Subcommands:
 *   junco start [--once]                     — daemon (acquire lock, run mainLoop)
 *   junco run-once                           — dev/cron one-shot (no lock)
 *   junco                                    — bare → ensure the supervised daemon
 *                                              is up (interactive TTY), then open
 *                                              the dashboard; first run (no config)
 *                                              opens the setup walkthrough
 *   junco dashboard                          — interactive dashboard; first run
 *                                              opens the guided setup walkthrough
 *   junco config init                        — headless: scaffold a default
 *                                              config.json + queue dirs, no prompts
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
import { readFileSync, readdirSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./types.js";
import type { SingletonLock } from "./lock.js";
import { acquireSingletonLock, readLockHolder } from "./lock.js";
import {
  loadConfig,
  queuePaths,
  resolveConfigPath,
  isLoopbackHost,
  assembleConfig,
  configDeprecations,
  expandHome,
  ConfigSchema,
  resolveDataRoot,
  dataRootHasTree,
} from "./config.js";
import type { ConfigParsed } from "./config.js";
import { parseTicket } from "./ticket.js";
import { ticketState } from "./ticketDeps.js";
import { withBotAuth } from "./ghAuth.js";
import {
  StopFlag,
  installSignalHandlers,
  mainLoop,
  makeProviderGate,
  type MainLoopDeps,
} from "./daemon.js";
import { makeConfigHolder, watchConfig, type ConfigHolder } from "./configWatcher.js";
import { runOnce } from "./runOnce.js";
import { makeGithubReporter } from "./githubReport.js";
import {
  log,
  setLogLevel,
  setLogFormat,
  setLogSink,
  openRotatingLogSink,
  openAppendLogSink,
} from "./logging.js";
import { renderService } from "./service.js";
import { inboxPath, submitTicket } from "./dispatch.js";
import { extractPlanSetBody } from "./githubInbox.js";
import { submitAsIssue } from "./submitAsIssue.js";
import { parsePlanSet, compilePlan, hashPlan } from "./planCompiler.js";
import {
  materializePlanSet,
  submitPlanSet,
  readPlanSetRecord,
  supersedeUnclaimed,
  resolveSetState,
  type PlanSetRecord,
} from "./planSets.js";
import { slugifyId } from "./slug.js";
import { describeTicketSchema } from "./ticketSchema.js";
import { runStatusCommand, fmtUptime } from "./statusCmd.js";
import { runListCommand } from "./listCmd.js";
import { runRetryCommand } from "./retryCmd.js";
import { runRmCommand } from "./rmCmd.js";
import { runDoctor } from "./doctor.js";
import { runLogsCommand } from "./logsCmd.js";
import { dataTreePaths } from "./dataTree.js";

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

/** The only part of a /health body the FTUE gate reads. A structural SUBSET of
 *  tui/healthBody.ts's `HealthBody`, so the real `fetchHealthBody` satisfies it
 *  without this module importing (or a test having to fabricate) the full
 *  MetricsSnapshot. */
export interface FtueHealthProbe {
  metrics: { pid: number; uptimeSeconds: number };
}

export interface CliDeps {
  loadConfigFn?: (path: string) => Config;
  acquireLockFn?: (lockPath: string) => SingletonLock | null;
  installSignalHandlersFn?: (stopFlag: StopFlag) => () => void;
  mainLoopFn?: (
    cfg: Config,
    stopFlag: StopFlag,
    opts: { once?: boolean },
    deps?: MainLoopDeps,
  ) => Promise<void>;
  runOnceFn?: (cfg: Config) => Promise<boolean>;
  /** Resolve (and attach) the daemon's bot-account GitHub auth context onto
   * Config before `start`/`run-once` proceed (Task 6, gh-bot-account spec).
   * A disabled botAccount returns cfg unchanged; enabled-but-unauthed throws
   * — the caller must refuse to start BEFORE the lock is taken or logs are
   * set up. Default: the real withBotAuth. (Typed monomorphically over
   * Config rather than `typeof withBotAuth` — that signature is generic over
   * `C extends Pick<Config, "botAccount" | "ghBin">`, which a plain test fake
   * typed at `Config` can't satisfy; the real generic withBotAuth still
   * satisfies this narrower shape.) */
  withBotAuthFn?: (cfg: Config) => Promise<Config>;
  /** Config hot-reload watcher for `start` (Task 6). Injected so tests never
   * touch a real fs.watch on a config path that may not exist on disk.
   * Default: the real watchConfig. The optional third param carries
   * `onApplied` (Task 10) — the daemon wires it to the shared provider
   * gate's `clearLatched()` so a successful reload (bad key fixed, quota
   * lifted) drops a stale latch without a restart — and `assembleFn`
   * (Task 6), which the daemon wires to re-attach the startup-resolved bot
   * auth context in lockstep with each reload's botAccount.enabled. */
  watchConfigFn?: (
    configPath: string,
    holder: ConfigHolder,
    deps?: { onApplied?: () => void; assembleFn?: (d: ConfigParsed) => Config },
  ) => { close(): void };
  /** Output function for the `service`, `inbox-path`, `schema`, `submit` subcommands. Default: process.stdout.write. */
  printFn?: (s: string) => void;
  /** Read stdin as a UTF-8 string. Injected so tests can supply content without a real stdin. */
  readStdinFn?: () => Promise<string>;
  /** Existence check for first-run detection (tests control routing). Default: fs.existsSync. */
  existsFn?: (path: string) => boolean;
  /** Process environment for config-path resolution (tests inject HOME /
   * XDG_CONFIG_HOME to relocate ~/.junco). Default: process.env. */
  env?: Record<string, string | undefined>;
  /** The dashboard command (tests inject a spy; default lazily imports
   * dashboardCmd.js). `cfg` is null on the FTUE path (no config on disk yet —
   * the dashboard hosts the setup walkthrough). */
  runDashboardFn?: (cfg: Config | null, configPath: string) => Promise<number>;
  /** The restart command (takes the RESOLVED config path — it matches service
   * units and the worker.lock by path, not by parsed config). */
  runRestartFn?: (configPath: string) => Promise<number>;
  /** Injected by tests: the dispatch core (default lazily used from externalDispatch.js). */
  dispatchIssueFn?: typeof import("./externalDispatch.js").dispatchIssue;
  /** Injected by tests: the outbox list/flush core (default lazily from outboxCmd.js).
   *  A seam so the flush path's bot-auth attach is observable without real state. */
  runOutboxCommandFn?: typeof import("./outboxCmd.js").runOutboxCommand;
  /** Injected by tests: the skill-install core (default lazily from skillCmd.js).
   *  A seam so `--harness <registry name>` is testable without ever calling the
   *  real ensureSkillLinks — its dirs expand against the REAL os.homedir(), not
   *  this run()'s injected `env.HOME` (see resolveHarnessArg/expandHome). */
  runSkillInstallCommandFn?: typeof import("./skillCmd.js").runSkillInstallCommand;
  /** Injected by tests: the unwatch plan/execute core (default lazily from unwatchCmd.js). */
  runUnwatchCommandFn?: typeof import("./unwatchCmd.js").runUnwatchCommand;
  /** Largest ticket timeout (seconds) currently reachable in the queue, used to
   *  size the `service` stop-timeout so a long ticket isn't SIGKILLed mid-drain
   *  (#118). Default: a best-effort scan of inbox/ + processing/. */
  maxQueuedTimeoutSecondsFn?: (cfg: Config) => number;
  /** Bare-invocation daemon pre-flight (bare `junco` on an interactive TTY only).
   *  Default: lazily imports ensureDaemon.js so every other subcommand stays off
   *  its (restartCmd → launchctl/systemd) require graph. */
  ensureDaemonFn?: (configPath: string) => Promise<import("./ensureDaemon.js").EnsureResult>;
  /** Interactivity probe gating the bare pre-flight. Default: stdout+stdin both TTY. */
  isTTYFn?: () => boolean;
  /** FTUE gate (#273): who holds the single-instance pidfile beside the
   *  config. Default: the real readLockHolder. Injected so a unit test never
   *  reads the developer's own live `~/.junco/worker.lock`. */
  readLockHolderFn?: (lockPath: string) => number | null;
  /** FTUE gate (#273): the /health probe used when no pidfile sits beside the
   *  resolved config path (exactly what a moved HOME looks like). Default:
   *  lazily imports tui/healthBody.js. Injected so a unit test never fetches
   *  the developer's own live health port. */
  fetchHealthFn?: (cfg: Config) => Promise<FtueHealthProbe | null>;
  /** submitTicket injection for `submit --plan`'s fan-out only (tests only —
   * production callers omit this; default the real submitTicket via
   * submitPlanSet's own default). Scoped to the plan-set door; the
   * single-ticket `submit` path is unaffected. */
  submitPlanFn?: typeof submitTicket;
}

/**
 * Largest per-ticket timeout (seconds) among tickets currently queued in
 * inbox/ + processing/. Used to size the service stop-timeout to the maximum
 * REACHABLE ticket timeout rather than just the default (#118): a per-ticket
 * `timeout_minutes` override is uncapped, so sizing to `default+margin` alone
 * would let the supervisor SIGKILL a longer-running ticket mid-drain. Returns
 * 0 when the queue is empty/unreadable. Best-effort and defensive — a single
 * bad ticket or a missing dir must never derail service rendering.
 */
function scanMaxQueuedTimeoutSeconds(cfg: Config): number {
  const paths = queuePaths(cfg);
  let max = 0;
  for (const dir of [paths.inbox, paths.processing]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // dir absent/unreadable — nothing to protect here
    }
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const p = join(dir, name);
      try {
        const t = parseTicket(p, readFileSync(p, "utf8"), cfg.defaultTimeoutMinutes);
        if (t.timeoutSeconds > max) max = t.timeoutSeconds;
      } catch {
        continue; // unreadable/vanished ticket — skip, keep scanning
      }
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// Usage string
// ---------------------------------------------------------------------------

const USAGE = `\
Usage: junco <subcommand> [options]

Subcommands:
  start        Start the daemon
  run-once     Process one task and exit (dev/cron convenience; no lock)
  service      Render a service file to stdout (launchd plist or systemd unit)
  inbox-path   Print the inbox directory path and exit
  status       Show daemon / endpoint / queue health at a glance
  list [box]   List tickets per queue box (inbox|processing|done|failed)
  retry <name…|--all>  Move failed tickets back to the inbox for a fresh run
  rm <name>            Delete a queued ticket from the inbox (best-effort)
  replay <ticket-id|path.jsonl> [--budget-per-kind N] [--escalation-window N]
         [--output-budget-per-turn N] [--output-budget-post-commit N] [--json]
                        Re-run a recorded event transcript through the guards
                        under a chosen (or default) policy — a what-if report
  unwatch <owner/repo> [--plan]  Stop watching a repo and delete its junco-owned state (--plan previews as JSON)
  outbox [flush]      List or push the offline GitHub backlog
  prs                 List junco-authored pull requests across watched repos
  data [--json]  Print the data tree (paths, counts, provenance); 'data migrate' unifies legacy roots
  config path|list|get <path>|set <path> <value>|init  Inspect/edit config.json knobs; init scaffolds defaults
  assess <path|owner/repo|owner/repo#N> [--auto-plan]  audit a repo — or scoped to one issue; findings await review
  assess review [<id>]                    list pending assess reviews, or show one
  assess file <id> --all | --only <fp,...>  file reviewed findings as issues
  assess discard <id>                     discard a pending batch without filing
  analyze <owner/repo#N|url>          investigate an issue and park a comment draft for review
  analyze review [<id>]                   list pending comment drafts, or preview one
  analyze edit <id>                       edit a pending draft in $EDITOR
  analyze post <id> [--no-footer]        post an approved draft as a comment on its issue
  doctor       Preflight: config, node, git, gh auth, endpoint, model, dirs
  auth login | auth grant <owner/repo>   Bot-account login / grant the bot write access to a repo
  logs [-f] [-n N] [--json|--human]  Show (or follow) the worker log
  dashboard    Interactive dashboard — first run opens the guided setup walkthrough
  restart      Restart the supervised daemon (picks up config + code changes)
  update       Update junco to the latest npm release (drains, then restarts the daemon)
  worktree prune <path>  Prune a stale/backup worktree (lock-guarded; refuses live)
  submit <file|-> Submit a ticket to the inbox (use - to read from stdin)
  submit --plan <file> --repo <path>  Compile an approved junco-plan fence
                  into its child tickets and submit them all
  submit --as-issue <file>  File the ticket as a parked, unlabeled GitHub issue
                  via the bot account — a human applies the trigger label to launch it
  submit --as-issue --plan <file> --repo <path>  Same, but parks a junco-plan
                  fence issue instead of a single ticket — labeling compiles the set
  dispatch <ref>  Fetch a GitHub issue (owner/repo#N or URL) and queue a ticket
                  for it — forks & clones unowned repos automatically
  skill install [--harness <name|path>]...  Link the junco-dispatch skill into
                  harness skills dirs via <dataDir>/skills (names: claude,
                  codex, pi, omp, opencode); no args re-ensures configured links
  schema       Print the ticket frontmatter JSON Schema and exit

  (no subcommand) → ensures the supervised daemon is running (interactive
                    terminal), then opens the dashboard; first run (no config)
                    opens the setup walkthrough. Use 'junco start' for an
                    explicit foreground daemon, 'junco dashboard' to observe
                    without starting anything.

Options:
  --once                (start) Process one task then exit
  --platform <name>     (service) Target platform: launchd | systemd
                        [default: launchd on macOS, systemd elsewhere]
  --plan                (unwatch) Print what would be deleted as JSON; delete nothing;
                        (submit) Compile a junco-plan fence into child tickets
  --repo <path>        (submit --plan) Repo path stamped into the compiled tickets
  --as-issue            (submit) File as a parked, unlabeled GitHub issue via the
                        bot account instead of the local inbox
  --help, -h            Show this help message
  --version             Print junco's version and exit
`;

// ---------------------------------------------------------------------------
// Argv parsing (strict) — extracted so run() can wrap it in try/catch. With
// strict:true parseArgs throws ERR_PARSE_ARGS_UNKNOWN_OPTION on any unrecognized
// flag; run() turns that into a graceful usage error (exit 2) instead of letting
// it escape to the top-level fatal catch (exit 1 + structured error log).
// ---------------------------------------------------------------------------

function parseCli(argv: string[]): ReturnType<typeof parseArgs> {
  return parseArgs({
    args: argv,
    options: {
      // Deprecated + inert: kept PARSED so installed service units that still pass
      // `--config <path>` don't crash-loop under strict:true (see run()'s notice).
      // Actual removal is a separate breaking change once rendered units are flagless.
      config: { type: "string" },
      once: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", default: false },
      platform: { type: "string" },
      all: { type: "boolean", default: false },
      only: { type: "string" },
      follow: { type: "boolean", short: "f", default: false },
      lines: { type: "string", short: "n" },
      json: { type: "boolean", default: false },
      human: { type: "boolean", default: false },
      "auto-plan": { type: "boolean", default: false },
      "no-footer": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      // replay-only (src/replayCmd.ts parses its own sub-argv slice, but
      // these must still be declared here so the top-level strict parse of
      // the FULL argv doesn't throw on them).
      "budget-per-kind": { type: "string" },
      "escalation-window": { type: "string" },
      "output-budget-per-turn": { type: "string" },
      "output-budget-post-commit": { type: "string" },
      harness: { type: "string", multiple: true },
      plan: { type: "boolean", default: false },
      repo: { type: "string" },
      "as-issue": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
}

// ---------------------------------------------------------------------------
// Daemon-mode log plumbing
// ---------------------------------------------------------------------------

/**
 * Human format on a TTY (JUNCO_LOG_JSON=1 forces JSON), plus a JSON tee to the
 * state-dir worker.log. Returns a cleanup that detaches the sink and closes the
 * stream.
 *
 * `rotate` gates worker.log rotation, which is a SINGLE-WRITER concern (#76):
 * only the lock-holding daemon (`start`) rotates (10MB single-generation, at
 * open AND mid-run — see openRotatingLogSink). Non-daemon commands (`run-once`)
 * take no lock and may run against a live daemon's worker.log, so they append
 * WITHOUT rotating — a second rotating sink would rename the daemon's file aside
 * and lose lines.
 */
function setupLogOutputs(cfg: Config, opts: { rotate: boolean }): () => void {
  if (process.stdout.isTTY && process.env.JUNCO_LOG_JSON !== "1") setLogFormat("human");
  if (!cfg.logToFile) return () => {};
  try {
    const logPath = dataTreePaths(cfg).logFile;
    mkdirSync(dirname(logPath), { recursive: true });
    const sink = opts.rotate ? openRotatingLogSink(logPath) : openAppendLogSink(logPath);
    setLogSink((l) => sink.write(l));
    return () => {
      setLogSink(null);
      sink.close();
    };
  } catch (e) {
    log.warn("file logging disabled (state dir not writable)", {
      error: e instanceof Error ? e.message : String(e),
    });
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// FTUE gate (#273)
// ---------------------------------------------------------------------------

/** Collaborators for `ftueRefusal` — every one of them a side effect. */
interface FtueGateDeps {
  existsFn: (p: string) => boolean;
  env: Record<string, string | undefined>;
  readLockHolderFn: (lockPath: string) => number | null;
  fetchHealthFn: (cfg: Config) => Promise<FtueHealthProbe | null>;
}

/**
 * Should the FRESH setup walkthrough refuse to run? Returns the operator-facing
 * refusal text, or null to proceed.
 *
 * Why this exists: on 2026-08-01 the walkthrough ran against a daemon with four
 * days of uptime and scaffolded a COMPETING config — the dashboard then wrote
 * tickets to one queue root while the worker polled another, and both sides
 * reported healthy (#273, #274). Two cheap, authoritative "this machine already
 * has a junco" signals were available at that moment and neither was consulted:
 * the health endpoint answered, and the resolved data tree was already populated.
 *
 * Scope — FRESH ONLY. The caller must apply this to the `cfg === null` door and
 * nowhere else. Re-run mode reads and writes back the SAME file (wizard.ts
 * buildWizardIO's `mode === "rerun"` branch), so it is structurally incapable of
 * creating a competing config; and with no `junco setup` subcommand the
 * walkthrough is the ONLY door an operator has for repairing a broken config.
 * Gating the re-run path would lock them out of the one tool that fixes their
 * problem. tests/cli.test.ts case (d) pins this.
 */
async function ftueRefusal(configPath: string, deps: FtueGateDeps): Promise<string | null> {
  const resolved = resolve(configPath);
  // Every refusal ends here — a guard that only says "no" moves the confusion
  // instead of resolving it, so both messages name the path they expected and
  // a command that actually runs in this state.
  const where = `  expected config: ${resolved}  (no file there)\n`;
  // `junco doctor` and NOTHING that loads the config. Both refusals only ever
  // print when there is no file at the resolved path, and every other
  // diagnostic (`status`, `list`, `inbox-path`, …) calls loadConfig
  // unconditionally — parseConfigFile rethrows the ENOENT, so the advised
  // command would be guaranteed to die with a fatal stack and exit 1, leaving
  // the operator with two errors instead of one. `doctor` is config-free by
  // construction: it catches the load failure and reports it as a finding
  // (doctor.ts, "config" check). Verified by execution against a HOME with no
  // config before this line was written: `doctor` prints
  // `✗ config — <resolved path>: ENOENT …` and a NOT-ready verdict (exit 1 is
  // its finding, not a crash), while `status` dies with a fatal stack and
  // prints nothing an operator can use. The wording below matches what doctor
  // actually shows in THIS state — it stops at the config check, so promising
  // "data and queue paths" here would be its own small over-claim.
  const steps =
    `\nWhat to do:\n` +
    `  junco doctor   — names the config path it resolved and what is wrong with it\n`;

  // Signal 1 — a live daemon. Cheapest, config-free probe first: the
  // single-instance pidfile beside the config (same derivation as `start`), no
  // network and no 1500 ms timeout. `readLockHolder` is liveness-checked — a
  // stale pidfile from a dead daemon reads as null, not as a refusal.
  const lockPath = join(dirname(resolved), "worker.lock");
  const holder = deps.readLockHolderFn(lockPath);
  let daemon: string | null = holder !== null ? `pid ${holder} holds ${lockPath}` : null;
  if (daemon === null) {
    // No pidfile beside THIS config path — which is exactly what a moved HOME
    // looks like, so ask the endpoint directly. There is no config to read
    // here, so assemble one from schema defaults (127.0.0.1:8787).
    const defaults = assembleConfig(ConfigSchema.parse({}), deps.env, { existsFn: deps.existsFn });
    const body = await deps.fetchHealthFn(defaults);
    if (body !== null) {
      daemon =
        `pid ${body.metrics.pid}, up ${fmtUptime(body.metrics.uptimeSeconds)} ` +
        `(http://${defaults.healthHost}:${defaults.healthPort}/health answered)`;
    }
  }
  if (daemon !== null) {
    // Deliberately does NOT offer `junco config init` (the populated-tree
    // refusal below does). `config init` is ungated — no daemon check, no tree
    // check (configCmd.ts) — and writes a default config resolving under THIS
    // process's HOME. In the moved-HOME shape this branch exists to catch,
    // that is precisely the competing config of the 2026-08-01 incident,
    // recreated by the remediation advice of the guard built to prevent it.
    // Do not "reconcile" this with the other message.
    return (
      `junco: refusing to open the setup walkthrough — a junco daemon is already running.\n\n` +
      `  daemon:          ${daemon}\n` +
      where +
      `\nA daemon is live, so this machine is already configured — but no config exists\n` +
      `at the path above, so the walkthrough would scaffold a SECOND one. That is the\n` +
      `2026-08-01 split-queue incident: the dashboard wrote tickets to one queue root\n` +
      `while the worker polled another, and both sides reported healthy.\n` +
      `Most likely HOME or XDG_CONFIG_HOME differs from the daemon's, or the config\n` +
      `was moved or deleted. Put it back at the path above (or run from the daemon's\n` +
      `HOME) and \`junco\` reopens the walkthrough in edit mode on that same file.\n` +
      steps
    );
  }

  // Signal 2 — a populated data tree with no config at the resolved path. Also
  // the shape a mis-set HOME/XDG_CONFIG_HOME takes: bare `junco` silently
  // routes into the FTUE because no file exists at the (wrong) path. Refusing
  // turns a silent competing-config into a readable error.
  const { dataDir } = resolveDataRoot(undefined, deps.env, deps.existsFn);
  if (dataRootHasTree(dataDir, deps.existsFn)) {
    return (
      `junco: refusing to open the setup walkthrough — this machine already has junco data.\n\n` +
      `  data root:       ${dataDir}  (populated)\n` +
      where +
      `\nA populated data tree with no config beside it means the config moved or was\n` +
      `deleted, or this process resolved a different HOME/XDG_CONFIG_HOME than the one\n` +
      `that created the tree. Scaffolding a fresh config over live data is how a queue\n` +
      `gets split (2026-08-01). Restore the config at the path above — or run\n` +
      `\`junco config init\` to scaffold one there deliberately — then \`junco\` reopens\n` +
      `the walkthrough in edit mode.\n` +
      steps
    );
  }

  return null; // a genuinely fresh machine
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
  const watchConfigFn = deps.watchConfigFn ?? watchConfig;
  // The manual run-once poke reports back to GitHub too when the bridge is on
  // (a daemon-claimed bridged ticket would otherwise leave its issue stale).
  const runOnceFn =
    deps.runOnceFn ??
    ((c: Config) => runOnce(c, { reporter: c.github.enabled ? makeGithubReporter(c) : undefined }));
  // Wrapped (rather than `deps.withBotAuthFn ?? withBotAuth` inline) because
  // withBotAuth is generic over `C extends Pick<Config, ...>` — calling a
  // union of that generic signature and CliDeps' monomorphic-over-Config
  // fake infers C from the constraint, not from the Config argument, and
  // fails to typecheck. A monomorphic wrapper sidesteps it.
  const withBotAuthFn = deps.withBotAuthFn ?? ((c: Config) => withBotAuth(c));
  // Bare-invocation daemon pre-flight collaborators (used only on the bare
  // interactive dashboard path below). Lazy-imported by default so restartCmd's
  // launchctl/systemd graph stays off every other subcommand.
  const isTTYFn = deps.isTTYFn ?? (() => Boolean(process.stdout.isTTY && process.stdin.isTTY));
  const ensureDaemonFn =
    deps.ensureDaemonFn ??
    (async (p: string) => (await import("./ensureDaemon.js")).ensureDaemon(p));

  // Parse argv (strict). An unknown flag throws ERR_PARSE_ARGS_UNKNOWN_OPTION;
  // report it gracefully (message + usage, exit 2) rather than letting it reach
  // the top-level fatal catch. Covers the removed `junco init --yes` scripted
  // form and every other unrecognized flag.
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;

  // --help / -h
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // --version (bare version only — junco update's post-install verify parses it)
  if (values.version) {
    const { getSelfPackage } = await import("./updateCheck.js");
    (deps.printFn ?? ((s: string) => process.stdout.write(s)))(`${getSelfPackage().version}\n`);
    return 0;
  }

  const existsFn = deps.existsFn ?? ((p: string) => existsSync(p));
  const env = deps.env ?? process.env;
  // Resolve the config path ONCE — a pure function of the environment (HOME /
  // XDG_CONFIG_HOME), never of cwd or argv (split-queue incident, 2026-08-01).
  // A relative JUNCO_CONFIG makes configPathOverride throw (config.ts) —
  // caught here so a bad value is a one-line CLI error, not an unhandled
  // stack trace out of the top-level catch at the bottom of this file.
  let configPath: string;
  try {
    configPath = resolveConfigPath({ existsFn, env });
  } catch (e) {
    process.stderr.write(`junco: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  if (values.config !== undefined) {
    process.stderr.write(
      "junco: --config is deprecated and ignored — the config location is resolved " +
        `automatically (resolved: ${configPath}). See docs/configuration.md.\n`,
    );
  }

  // Bare `junco` (no explicit subcommand) always heads to the dashboard; the
  // dashboard branch adds a daemon pre-flight on the interactive bare path (no
  // config yet → the dashboard hosts the setup walkthrough instead).
  const bare = positionals[0] === undefined;
  const subcommand = positionals[0] ?? "dashboard";

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

    // Best-effort config read: size the stop timeout to the MAXIMUM reachable
    // ticket timeout (+10 min drain margin) and put launchd logs under the state
    // dir. A per-ticket `timeout_minutes` override is uncapped, so sizing to the
    // default alone would let the supervisor SIGKILL a longer ticket mid-drain
    // (#118); we take the max of the default and the largest currently-queued
    // ticket. (Tickets that arrive AFTER this render and exceed the sized window
    // remain at risk — re-render the unit, or cap timeout_minutes at the source.)
    // No config yet → renderService falls back to its own defaults.
    const maxQueuedTimeoutSecondsFn = deps.maxQueuedTimeoutSecondsFn ?? scanMaxQueuedTimeoutSeconds;
    let stopTimeoutSeconds: number | undefined;
    let logDir: string | undefined;
    try {
      const cfg = loadConfigFn(configPath);
      const timeoutSeconds = Math.max(
        cfg.defaultTimeoutMinutes * 60,
        maxQueuedTimeoutSecondsFn(cfg),
      );
      stopTimeoutSeconds = timeoutSeconds + 10 * 60;
      logDir = dataTreePaths(cfg).logsDir;
    } catch {
      /* fall back to renderer defaults */
    }

    const rendered = renderService(platform, { cliEntry, stopTimeoutSeconds, logDir });
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

    // Refuse-to-run guard (Task 6): resolve the bot-account auth context
    // before anything else — an enabled-but-unauthed botAccount fails loud
    // rather than silently falling back to the operator's own identity.
    let cfgAuthed: Config;
    try {
      cfgAuthed = await withBotAuthFn(cfg);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }

    setLogLevel(cfgAuthed.logLevel);
    // No singleton lock here (see the banner above), so never rotate worker.log
    // — a live daemon may own it; append only (#76).
    const teardownLogs = setupLogOutputs(cfgAuthed, { rotate: false });
    try {
      const handled = await runOnceFn(cfgAuthed);
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

    // Refuse-to-start guard (Task 6): resolve the bot-account auth context
    // BEFORE the singleton lock is taken or worker.log is rotated — a bad or
    // expired bot login must not silently fall back to the operator's own
    // identity, and its failure must leave no trace of a started daemon.
    let cfgAuthed: Config;
    try {
      cfgAuthed = await withBotAuthFn(cfg);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }

    setLogLevel(cfgAuthed.logLevel);

    // Derive lock path: mirror Python args.config.resolve().parent / "worker.lock"
    const lockPath = join(dirname(resolve(configPath)), "worker.lock");

    const lock = acquireLockFn(lockPath);
    if (lock === null) {
      log.warn("another instance holds the lock; exiting", { lockPath });
      // Exit 0 — process supervisor must NOT respawn-loop on a "lock held" situation.
      // We never touched worker.log (the rotating sink is set up below, only once
      // we hold the lock), so a lock-losing start can't rotate a live daemon's log.
      return 0;
    }

    // Set up the rotating worker.log sink now that we own the daemon slot —
    // rotation is the lock holder's exclusive job (#76).
    const teardownLogs = setupLogOutputs(cfgAuthed, { rotate: true });

    // Loud warning when /health binds a non-loopback address (#44): the metrics
    // body is unauthenticated and leaks in-flight ticket ids + operational
    // metadata to the whole network. `junco doctor` mirrors this warning.
    // No truthy `&& cfg.healthHost` guard: an empty/unparseable host is
    // non-loopback (isLoopbackHost("") → false), so a value that bypassed the
    // config normalization still triggers the warning instead of evading it (#71).
    if (cfgAuthed.healthEnabled && !isLoopbackHost(cfgAuthed.healthHost)) {
      log.warn("health bind is not loopback — /health is UNAUTHENTICATED and exposed", {
        healthHost: cfgAuthed.healthHost,
        healthPort: cfgAuthed.healthPort,
        advice: "bind healthHost to 127.0.0.1 unless it is firewalled",
      });
    }

    // Deprecated legacy config keys (Unified Data Root spec §5): one log.warn
    // per set key, logged once at startup — `junco doctor` mirrors the same
    // list as a "deprecated config keys" finding.
    for (const line of configDeprecations(cfgAuthed)) {
      log.warn(line);
    }

    const stopFlag = new StopFlag();
    const uninstall = installSignalHandlersFn(stopFlag);

    // Live-reload (Task 6): the holder starts seeded with the config we just
    // loaded; the watcher re-parses config.json on change and swaps in a new
    // Config, which mainLoop's per-iteration reads pick up without a restart.
    // Hot-reload is optional — a watch-start failure (EMFILE/ENOSPC/EACCES/
    // unsupported FS) must NOT crash the daemon, matching the health server's
    // graceful-degrade pattern below: log a warning and continue with the
    // holder seeded but never updated (hot-reload disabled until restart).
    // Built BEFORE the gate so the gate can read retryBackoffSeconds live off
    // holder.current (a reload:"live" lever — #180).
    const holder = makeConfigHolder(cfgAuthed);

    // Provider gate (Task 10): one instance shared between mainLoop's claim/
    // health wiring and the hot-reload watcher below, so a successful config
    // edit (bad key fixed, quota lifted, model id corrected) clears a stale
    // latch without requiring a restart. The backoff getter re-reads the live
    // retryBackoffSeconds so gate backoff windows honor a hot-reload too (#180).
    const gate = makeProviderGate(cfgAuthed, () => holder.current.retryBackoffSeconds);

    let watcher: { close(): void } | null = null;
    try {
      watcher = watchConfigFn(configPath, holder, {
        onApplied: () => gate.clearLatched(),
        // Hot reload must not silently drop (or fabricate) the bot identity:
        // re-attach the STARTUP-resolved context while the file still enables
        // it; a flip either way is a restart-kind lever (configLevers).
        assembleFn: (d) => {
          const next = assembleConfig(d);
          return next.botAccount.enabled && cfgAuthed.ghAuth
            ? { ...next, ghAuth: cfgAuthed.ghAuth }
            : next;
        },
      });
    } catch (e) {
      log.warn("config watcher failed to start; hot-reload disabled until restart", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    try {
      await mainLoopFn(
        cfgAuthed,
        stopFlag,
        { once: values.once as boolean },
        { configHolder: holder, gate },
      );
      return 0;
    } catch (e) {
      log.error("fatal error in main loop", {
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
      return 1;
    } finally {
      if (watcher) watcher.close();
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
  // rm: best-effort delete of a queued ticket from inbox/ (src/rmCmd.ts).
  // Never touches processing/ — the daemon owns it.
  // ------------------------------------------------------------
  if (subcommand === "rm") {
    const cfg = loadConfigFn(configPath);
    return runRmCommand(cfg, positionals.slice(1), { printFn });
  }

  // ------------------------------------------------------------
  // replay: guard-policy what-if over a recorded event transcript
  // (src/replayCmd.ts). It owns its own argv parsing (flag > recorded
  // run_start > config > GuardManager defaults precedence), so it gets the
  // raw sub-argv slice rather than the pre-parsed `values`/`positionals` —
  // find "replay" in the ORIGINAL argv (not positionals[0]'s index, which
  // drops any global flags parsed ahead of it) and hand it everything after.
  // Lazy import keeps agent/replay.ts's guard graph off every other subcommand.
  // ------------------------------------------------------------
  if (subcommand === "replay") {
    const { runReplayCmd } = await import("./replayCmd.js");
    const idx = argv.indexOf("replay");
    const subArgv = idx === -1 ? positionals.slice(1) : argv.slice(idx + 1);
    return runReplayCmd(subArgv, {
      loadCfg: () => loadConfigFn(configPath),
      readFile: (p: string) => readFileSync(p, "utf8"),
      stdout: (l: string) => printFn(l + "\n"),
    });
  }

  // ------------------------------------------------------------
  // unwatch: plan/execute deletion of a repo's junco-owned operational state
  // (src/unwatchCmd.ts). Lazy import keeps its watchlist/outbox/review-store
  // graph off every other subcommand.
  // ------------------------------------------------------------
  if (subcommand === "unwatch") {
    const cfg = loadConfigFn(configPath);
    const runUnwatchCommandFn =
      deps.runUnwatchCommandFn ?? (await import("./unwatchCmd.js")).runUnwatchCommand;
    return runUnwatchCommandFn(
      cfg,
      positionals.slice(1),
      { plan: values.plan as boolean },
      { printFn },
    );
  }

  // ------------------------------------------------------------
  // outbox: list or flush the offline GitHub backlog (src/githubOutbox.ts)
  // ------------------------------------------------------------
  if (subcommand === "outbox") {
    const cfg = loadConfigFn(configPath);
    // `flush` REPLAYS daemon-enqueued ops (comments, label flips, branch pushes,
    // PR creates) and runs its own `gh api user` dedup — it is daemon traffic, so
    // it must speak as the bot, not the operator running the manual flush. Attach
    // (and refuse loud, mirroring start/run-once) only for `flush`; bare
    // `junco outbox` is a local-only listing that needs no identity.
    let cfgForOutbox = cfg;
    if (positionals[1] === "flush") {
      try {
        cfgForOutbox = await withBotAuthFn(cfg);
      } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
      }
    }
    const runOutboxCommandFn =
      deps.runOutboxCommandFn ?? (await import("./outboxCmd.js")).runOutboxCommand;
    return runOutboxCommandFn(cfgForOutbox, positionals.slice(1), { printFn });
  }

  // ------------------------------------------------------------
  // prs: list junco-authored PRs across watched repos (shares the fetch/sort
  // core with the dashboard's PRs view — src/githubPrs.ts, src/tui/prState.ts).
  // Lazy import keeps this off every other subcommand's require graph.
  // ------------------------------------------------------------
  if (subcommand === "prs") {
    const cfg = loadConfigFn(configPath);
    const { runPrsCommand } = await import("./prsCmd.js");
    return runPrsCommand(cfg, { printFn });
  }

  // ------------------------------------------------------------
  // assess: compose + submit a machine-owned vulnerability-assessment ticket
  // (src/assessCmd.ts) — the daemon's assessFlow.ts runs the actual audit.
  // ------------------------------------------------------------
  if (subcommand === "assess") {
    const cfg = loadConfigFn(configPath);
    const sub = positionals[1];
    if (sub === "review") {
      const { runAssessReviewCommand } = await import("./assessCmd.js");
      return runAssessReviewCommand(cfg, positionals[2], { printFn });
    }
    if (sub === "file") {
      const { runAssessFileCommand } = await import("./assessCmd.js");
      return runAssessFileCommand(
        cfg,
        positionals[2],
        { all: values.all === true, only: values.only as string | undefined },
        { printFn },
      );
    }
    if (sub === "discard") {
      const { runAssessDiscardCommand } = await import("./assessCmd.js");
      return runAssessDiscardCommand(cfg, positionals[2], { printFn });
    }
    const { runAssessCommand } = await import("./assessCmd.js");
    return runAssessCommand(
      cfg,
      positionals[1],
      { autoPlan: values["auto-plan"] === true },
      { printFn },
    );
  }

  // ------------------------------------------------------------
  // analyze: compose + submit a machine-owned issue-investigation ticket
  // (src/analyzeCmd.ts) — the daemon's analyzeFlow.ts investigates and parks
  // a comment draft. review/edit read and refine a parked draft; post is the
  // human-confirmed outward write, through the same outbox seam as assess.
  // ------------------------------------------------------------
  if (subcommand === "analyze") {
    const cfg = loadConfigFn(configPath);
    const sub = positionals[1];
    if (sub === "review") {
      const { runAnalyzeReviewCommand } = await import("./analyzeCmd.js");
      return runAnalyzeReviewCommand(cfg, positionals[2], { printFn });
    }
    if (sub === "edit") {
      if (positionals[2] === undefined) {
        printFn(`Usage: junco analyze edit <id>\n`);
        return 2;
      }
      const { runAnalyzeEditCommand } = await import("./analyzeCmd.js");
      return runAnalyzeEditCommand(cfg, positionals[2], { printFn });
    }
    if (sub === "post") {
      const { runAnalyzePostCommand } = await import("./analyzeCmd.js");
      return runAnalyzePostCommand(
        cfg,
        positionals[2],
        { noFooter: values["no-footer"] === true },
        { printFn },
      );
    }
    const { runAnalyzeCommand } = await import("./analyzeCmd.js");
    return runAnalyzeCommand(cfg, positionals[1], { printFn });
  }

  // ------------------------------------------------------------
  // skill: skill-link management (src/skillCmd.ts) — install creates the
  // <dataDir>/skills mount + consented harness links; the daemon re-ensures
  // the same set at every startup.
  // ------------------------------------------------------------
  if (subcommand === "skill") {
    if (positionals[1] === "install") {
      const runSkillInstallCommandFn =
        deps.runSkillInstallCommandFn ?? (await import("./skillCmd.js")).runSkillInstallCommand;
      const harness = (values.harness as string[] | undefined) ?? [];
      return runSkillInstallCommandFn(configPath, { harness }, { printFn });
    }
    process.stderr.write(`Usage: junco skill install [--harness <name|path>]...\n`);
    return 2;
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
      // --human forces the readable format even when stdout is a pipe (the
      // dashboard palette runs logs through a captured subprocess).
      json: (values.human as boolean) ? false : (values.json as boolean) || undefined,
    });
  }

  // ------------------------------------------------------------
  // dashboard: interactive GitHub-mode TUI (Ink is loaded lazily — only paid
  // for when this subcommand actually runs; every other subcommand stays
  // React-free).
  // ------------------------------------------------------------
  if (subcommand === "dashboard") {
    const runDashboardFn =
      deps.runDashboardFn ??
      (async (c: Config | null, p: string) => {
        const { runDashboard } = await import("./dashboardCmd.js");
        return runDashboard(c, p);
      });
    if (!existsFn(resolve(configPath))) {
      // FTUE: the dashboard hosts the setup walkthrough (spec §4) — no config
      // to load yet, so pass null and let the Ink Root open the wizard first.
      //
      // ...unless this machine already has a junco (#273). The gate lives HERE,
      // on the fresh door only — never on the re-run path below, which rewrites
      // the config it read and is the only tool for repairing a broken one.
      const refusal = await ftueRefusal(configPath, {
        existsFn,
        env,
        readLockHolderFn: deps.readLockHolderFn ?? readLockHolder,
        fetchHealthFn:
          deps.fetchHealthFn ??
          (async (c: Config) => (await import("./tui/healthBody.js")).fetchHealthBody(c)),
      });
      if (refusal !== null) {
        process.stderr.write(refusal);
        // 1, not 130: 130 is "the user cancelled" (dashboardCmd.ts). A refusal
        // is not a cancellation.
        return 1;
      }
      return runDashboardFn(null, configPath);
    }
    const cfg = loadConfigFn(configPath);
    setLogLevel(cfg.logLevel);
    // Bare `junco` on an interactive TTY ensures the supervised daemon is up
    // before the panel opens. Explicit `junco dashboard` stays a pure observer.
    if (bare && isTTYFn()) {
      await ensureDaemonFn(configPath);
    }
    return runDashboardFn(cfg, configPath);
  }

  // ------------------------------------------------------------
  // restart: kick the service unit supervising this config's daemon so it
  // picks up config + dist changes. The config is loaded first purely as
  // fail-fast validation — never bounce the daemon onto a config it can't
  // parse (the restarted process would crash-loop under its supervisor).
  // ------------------------------------------------------------
  if (subcommand === "restart") {
    try {
      loadConfigFn(configPath);
    } catch (e) {
      process.stderr.write(
        `config invalid — not restarting: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 1;
    }
    const runRestartFn =
      deps.runRestartFn ??
      (async (p: string) => (await import("./restartCmd.js")).runRestartCommand(p));
    return runRestartFn(configPath);
  }

  // ------------------------------------------------------------
  // update: npm-install the latest release, drain-restart the daemon. Lazy
  // import keeps npm/child_process plumbing off every other subcommand.
  // ------------------------------------------------------------
  if (subcommand === "update") {
    const { runUpdateCommand } = await import("./updateCmd.js");
    return runUpdateCommand(configPath, {});
  }

  // ------------------------------------------------------------
  // worktree prune <path>: lock-guarded, liveness-gated removal of a per-ticket
  // worktree (src/worktreePruneCmd.ts) — the shared CLI/TUI safety chokepoint.
  // ------------------------------------------------------------
  if (subcommand === "worktree") {
    const cfg = loadConfigFn(configPath);
    if (positionals[1] === "prune") {
      const { runWorktreePruneCommand } = await import("./worktreePruneCmd.js");
      return runWorktreePruneCommand(cfg, positionals.slice(2), { printFn });
    }
    process.stderr.write(`Usage: junco worktree prune <path>\n`);
    return 2;
  }

  // ------------------------------------------------------------
  // data: unified-data-root inspection/migration. `data migrate`
  // (src/dataMigrateCmd.ts) is the explicit, opt-in full unification (queue
  // move + state tree + config rewrite); the bare `data` view
  // (src/dataCmd.ts) is a pure read — resolved paths, live counts,
  // legacy-override provenance, pending migrations — and never mutates.
  // ------------------------------------------------------------
  if (subcommand === "data") {
    const verb = positionals[1];
    if (verb !== undefined && verb !== "migrate") {
      // Unknown verb: usage + exit 2 BEFORE any config load — never silently
      // fall through to the view (`junco data foo` is a typo, not a request).
      printFn(`Usage: junco data [--json] | junco data migrate [--dry-run] [--force]\n`);
      return 2;
    }
    const cfg = loadConfigFn(configPath);
    if (verb === "migrate") {
      const { runDataMigrate } = await import("./dataMigrateCmd.js");
      return runDataMigrate(
        cfg,
        configPath,
        { dryRun: values["dry-run"] as boolean, force: values.force as boolean },
        { printFn },
      );
    }
    const { runData } = await import("./dataCmd.js");
    return runData(cfg, { json: values.json as boolean }, { printFn });
  }

  // ------------------------------------------------------------
  // config: inspect/edit config.json knobs via the lever registry
  // (src/configLevers.ts) — path/list/get/set (src/configCmd.ts). Lazy
  // import keeps it off every other subcommand's require graph, matching
  // `prs`/`assess`. daemonRunningFn reuses the same lock-holder liveness
  // check as `status`/`restart` so `set` on a restart-kind lever only warns
  // when a daemon is actually up to restart.
  // ------------------------------------------------------------
  if (subcommand === "config") {
    const { runConfigCommand } = await import("./configCmd.js");
    const lockPath = join(dirname(resolve(configPath)), "worker.lock");
    return runConfigCommand(positionals.slice(1), configPath, {
      printFn,
      daemonRunningFn: () => readLockHolder(lockPath) !== null,
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
  // submit: place a ticket into the inbox
  // ------------------------------------------------------------
  if (subcommand === "submit") {
    const fileArg = positionals[1];
    if (!fileArg) {
      process.stderr.write(`Usage: junco submit <file|->\n`);
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

    // submit --as-issue <file> [--plan --repo <path>]: file as a parked,
    // unlabeled GitHub issue via the bot account (src/submitAsIssue.ts)
    // instead of the local inbox/compiler — a human applying the trigger
    // label is what launches it. Both forms route here, BEFORE the local
    // --plan branch below, so `--as-issue --plan` never reaches the local
    // compiler: a bare `--as-issue` parks a single ticket, and `--as-issue
    // --plan` parks a plan-set fence (submitAsIssue.ts's opts.plan path
    // mirrors this file's own extractPlanSetBody → parsePlanSet validation).
    if (values["as-issue"] === true) {
      if (fileArg === "-") {
        process.stderr.write("Usage: junco submit --as-issue <file> (stdin not supported)\n");
        return 2;
      }
      return await submitAsIssue(cfg, fileArg, content, {
        plan: values.plan === true,
        repoFlag: values.repo as string | undefined,
      });
    }

    // submit --plan <file> --repo <path>: compile an approved junco-plan
    // fence into its child tickets and fan them out. Local trust model — no
    // approval machinery here; the dispatcher is trusted exactly like every
    // locally-authored ticket today (the junco-dispatch preview gate is the
    // approval). Kept as its own branch (rather than folding into the
    // single-ticket path below) because a plan set has no single `dst` to
    // report — it prints one line per child plus a set-level summary line.
    if (values.plan === true) {
      if (fileArg === "-") {
        process.stderr.write(
          "Usage: junco submit --plan <file> --repo <path> (stdin not supported)\n",
        );
        return 2;
      }
      if (!cfg.planSets.enabled) {
        process.stderr.write(
          "junco submit: plan sets are disabled — set planSets.enabled in config.json\n",
        );
        return 1;
      }
      const repoFlag = values.repo as string | undefined;
      if (!repoFlag) {
        process.stderr.write("Usage: junco submit --plan <file> --repo <path>\n");
        return 2;
      }
      const fence = extractPlanSetBody(content);
      if (fence === null) {
        process.stderr.write(`junco submit: no junco-plan fence found in '${fileArg}'\n`);
        return 1;
      }
      const parsed = parsePlanSet(fence, { maxTasks: cfg.planSets.maxTasks });
      if (!parsed.ok) {
        for (const e of parsed.errors) process.stderr.write(`junco submit: plan error: ${e}\n`);
        return 1;
      }
      const planId = "plan-" + slugifyId(basename(fileArg).replace(/\.md$/, ""));
      const hash = hashPlan(fence);
      const repoPath = resolve(expandHome(repoFlag));
      const children = compilePlan(parsed.plan, { planId, repoPath, hash, github: null });
      // A re-run with an edited plan reuses the SAME planId (it is derived
      // from the filename), so without this the old children stay queued
      // under identical ids and submitPlanSet skips every one — the record's
      // rev would advertise a revision the queue does not contain (#298).
      // Mirrors the bridge's supersede: dispose only the UNCLAIMED ones, then
      // fan out with the SAME loose (absent | failed) policy trySupersede
      // uses — a sibling that genuinely failed on the PRIOR revision must
      // resubmit too, not just the ids this call happened to dispose (#298
      // review round 1).
      const prior = readPlanSetRecord(cfg, planId);
      let supersede = false;
      if (prior !== null && prior.hash !== hash) {
        supersede = true;
        const { disposed } = supersedeUnclaimed(cfg, prior, hash);
        if (disposed.length > 0) {
          printFn(`plan set ${planId}: superseded ${disposed.length} unclaimed ticket(s)\n`);
        }
      }
      // Fan out BEFORE materializing the fresh record — mirrors the bridge's
      // #293-critical-4 crash-idempotence ordering: a crash in this window
      // leaves the OLD record on disk, so a later run re-derives from queue
      // reality instead of wedging on a record that advertises a revision
      // the queue never actually received.
      const r = submitPlanSet(cfg, children, {
        resubmitFailed: supersede,
        submitFn: deps.submitPlanFn,
      });
      const record: PlanSetRecord = {
        v: 1,
        planId,
        hash,
        repoPath,
        github: null,
        tasks: children.map((c) => ({
          id: c.taskId,
          ticketId: c.ticketId,
          dependsOn: c.dependsOn,
        })),
        createdAt: new Date().toISOString(),
        statusCommentId: null,
        degradedPosted: false,
        lastLabel: null,
        closed: false,
      };
      materializePlanSet(cfg, record, fence);
      printFn(`plan set ${planId} (${children.length} tasks, rev ${hash})\n`);
      if (r.submitted.length === 0 && r.stranded.length === 0) {
        // Fix wave C, item 2: `submitted`/`stranded` both empty does not by
        // itself mean every child is healthy. Under the STRICT policy (this
        // run made no edit, so `supersede` is false), a child a PRIOR run's
        // supersede disposed into `failed/` (a `superseded:` marker) and then
        // failed to resubmit (see the `r.stranded.length > 0` branch below)
        // stays stuck there forever: strict-policy `submitPlanSet` only ever
        // submits an `absent` child (see its `resubmitFailed` doc comment),
        // and `junco retry --all` deliberately skips a superseded-marked
        // file too. Detect it with the SAME state resolution the
        // dashboard/reporter use — `resolveSetState`'s `superseded` task
        // state already disambiguates a disposed-and-never-resubmitted copy
        // from a genuine execution failure (see `pickFailedTicketFile`) — and
        // surface it here rather than reporting a clean no-op. Deliberately
        // NOT switching this unchanged re-run to the loose policy instead:
        // that would also resurrect any sibling that failed on its own
        // merits, which is exactly what the strict policy exists to prevent.
        const state = resolveSetState(cfg, record);
        const stranded = state.tasks.filter((t) => t.state === "superseded");
        if (stranded.length > 0) {
          for (const t of stranded) {
            process.stderr.write(
              `junco submit: plan set ${planId}: ${t.ticketId} is stranded (disposed by a prior supersede, never resubmitted) — edit '${fileArg}' and re-run to recover it\n`,
            );
          }
          return 1;
        }
        printFn(`plan set ${planId}: all ${children.length} tickets already in the queue\n`);
        return 0;
      }
      for (const s of r.submitted) printFn(`submitted: ${s.dst}\n`);
      // I3 (#298 review round 2): a per-child submit throw is CONTAINED
      // inside submitPlanSet, not propagated — before this branch it threw
      // and this command exited 1 with a fatal message. Surface the same
      // signal here instead of silently returning 0, or the operator has no
      // way to notice a stranded child short of re-reading the daemon log.
      // The record above was still materialized. Fix wave C, item 2: that
      // does NOT by itself mean a later unchanged re-run retries this child —
      // only true when nothing was disposed this run (no prior record, or
      // `supersede` false: the child really does stay `absent`, and a
      // strict-policy re-run resubmits it fine). When THIS stranding happened
      // during a supersede (`supersede` true — `supersedeUnclaimed` already
      // disposed the prior copy into `failed/` with a `superseded:` marker
      // before the fresh copy's submit threw here), the child sits in
      // `failed/`, not `absent`, and an unchanged re-run's STRICT policy will
      // never pick a `failed` child back up on its own — see the
      // `superseded`-state check above (the "already in the queue" branch)
      // for how that case is actually surfaced on a later re-run.
      if (r.stranded.length > 0) {
        for (const id of r.stranded) {
          process.stderr.write(`junco submit: plan set ${planId}: failed to submit ${id}\n`);
        }
        return 1;
      }
      return 0;
    }

    let dst: string;
    try {
      dst = submitTicket(cfg, content, { idHint });
    } catch (e) {
      process.stderr.write(`junco submit: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }

    printFn(`submitted: ${dst}\n`);

    // Dangling-edge warning (spec 2026-08-20): submit never refuses — sets may
    // arrive out of order — but a dep that exists nowhere is probably a typo.
    // Best-effort only: this must never fail an already-successful submit, so
    // any error (e.g. an unreadable queue dir) is swallowed silently — it will
    // surface loudly elsewhere (list/status/the sweep itself).
    try {
      const submitted = parseTicket(basename(dst), content);
      const missing = submitted.dependsOn.filter(
        (d) => !submitted.depsSatisfied.includes(d) && ticketState(queuePaths(cfg), d) === "absent",
      );
      if (missing.length > 0) {
        process.stderr.write(
          `junco submit: warning — depends_on references no queued or finished ticket: ${missing.join(", ")} (the ticket will wait until they exist)\n`,
        );
      }
    } catch {
      /* best-effort warning; the submit already succeeded */
    }

    return 0;
  }

  // ------------------------------------------------------------
  // dispatch <owner/repo#N | issue-url>: fetch a GitHub issue and queue a
  // ticket for it, forking + cloning unowned repos automatically. Lazy import
  // keeps this (and its gh/git dependency graph) off every other subcommand.
  // ------------------------------------------------------------
  if (subcommand === "dispatch") {
    const ref = positionals[1];
    if (!ref) {
      process.stderr.write(`Usage: junco dispatch <owner/repo#N | issue-url>\n`);
      return 2;
    }
    const cfg = loadConfigFn(configPath);
    const dispatchFn =
      deps.dispatchIssueFn ?? (await import("./externalDispatch.js")).dispatchIssue;
    try {
      const r = await dispatchFn(cfg, ref);
      printFn(`dispatched: ${r.destPath}\n`);
      if (r.external) {
        printFn(`external repo — fork: ${r.forkNwo} · clone: ${r.clonePath}\n`);
      }
      return 0;
    } catch (e) {
      process.stderr.write(`junco dispatch: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  // ------------------------------------------------------------
  // auth login: log the bot account in (isolated GH_CONFIG_DIR). Lazy import
  // keeps it off every other subcommand's require graph.
  // ------------------------------------------------------------
  if (subcommand === "auth") {
    const { runAuthCommand } = await import("./authCmd.js");
    return runAuthCommand(positionals.slice(1), configPath, {});
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
