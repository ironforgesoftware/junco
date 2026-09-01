import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { z } from "zod";
import type { Config, Paths } from "./types.js";
import { catalogEligible } from "./agent/modelSetup.js";

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** AbortController timeout (ms) for a single GET to the daemon's `/health`
 * endpoint — shared by the dashboard snapshots (queueSnapshot + localSnapshot)
 * and `junco worktree prune`'s currentTickets probe so the three agree. */
export const HEALTH_TIMEOUT_MS = 1500;

export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return p;
}

/**
 * True when `host` is a loopback bind address — 127.0.0.0/8, ::1 (optionally
 * bracketed), or the literal "localhost". A non-loopback healthHost (e.g.
 * "0.0.0.0" or a LAN IP) exposes the unauthenticated /health metrics to the
 * network, so daemon startup and `junco doctor` warn on it (#44). Empty/unknown
 * strings are treated as non-loopback (fail safe → warn).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost") return true;
  // Strip IPv6 brackets: [::1] → ::1
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (bare === "::1") return true;
  // IPv4 127.0.0.0/8 — any address whose first octet is 127.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (m) {
    const octets = m.slice(1, 5).map(Number);
    if (octets.every((o) => o <= 255) && octets[0] === 127) return true;
  }
  return false;
}

/** env.HOME (tests/sandboxes) wins over os.homedir(). */
export function homeOf(env: Record<string, string | undefined> = process.env): string {
  return env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
}

/** Junco's single home directory: ~/.junco. env.HOME wins over os.homedir()
 * so tests and sandboxes can relocate it. Config lives here today; the data
 * tree follows suit by default in the single-root consolidation (probe-based
 * fallback keeps a pre-existing legacy root working — see assembleConfig). */
export function juncoHome(env: Record<string, string | undefined> = process.env): string {
  return join(homeOf(env), ".junco");
}

/** Schema default for `botAccount.configDir` — the one spelling every other
 * reference (the zod default below, `resolveBotGhConfigDir`'s own default)
 * derives from, so they can't drift apart. */
export const DEFAULT_BOT_GH_CONFIG_DIR = "~/.junco/gh";

/**
 * Resolve the bot account's isolated gh config dir from the raw (possibly
 * unset) `botAccount.configDir` config value. The SINGLE source of truth for
 * this resolution — `assembleConfig`, `junco auth login` (authCmd.ts), and
 * the setup wizard (wizard.ts) all call this instead of re-deriving the
 * default themselves, so the three entrypoints can never disagree about
 * where a live legacy login lives and plant a second `hosts.yml` at
 * `~/.junco/gh` while the daemon keeps reading `~/.config/junco/gh` (or vice
 * versa) — the split-brain this resolution exists to prevent.
 *
 * An explicit non-default `raw` passes through (tilde-expanded) verbatim —
 * NEVER probed. A defaulted/unset value resolves to `~/.junco/gh`, EXCEPT
 * when `~/.junco/gh/hosts.yml` is absent and the legacy
 * `~/.config/junco/gh/hosts.yml` exists — then the legacy dir is used and
 * `legacy: true` is returned (an upgrade must never orphan a working bot
 * login until `junco data migrate` moves it).
 */
export function resolveBotGhConfigDir(
  raw: string | undefined,
  env: Record<string, string | undefined> = process.env,
  existsFn: (p: string) => boolean = existsSync,
): { dir: string; legacy: boolean } {
  const ghDefault = join(juncoHome(env), "gh");
  const ghLegacy = join(homeOf(env), ".config", "junco", "gh");
  const ghConfigured = expandHome(raw ?? DEFAULT_BOT_GH_CONFIG_DIR);
  // NOTE: expandHome is homedir()-based while ghDefault is env-based
  // (homeOf(env)). Under an injected test env (env.HOME !== os.homedir())
  // these can disagree, making an explicitly-set "~/.junco/gh" indistinguishable
  // from the default here — acceptable, they resolve to the same place in
  // real use (see Task 3 brief).
  let dir = ghConfigured === expandHome(DEFAULT_BOT_GH_CONFIG_DIR) ? ghDefault : ghConfigured;
  let legacy = false;
  if (
    dir === ghDefault &&
    !existsFn(join(ghDefault, "hosts.yml")) &&
    existsFn(join(ghLegacy, "hosts.yml"))
  ) {
    dir = ghLegacy;
    legacy = true;
  }
  return { dir, legacy };
}

/** True when `root` holds a junco data tree (either layout). config.json/gh
 * alone do NOT count — the config plan puts those at ~/.junco before any
 * data lives there. */
export function dataRootHasTree(
  root: string,
  existsFn: (p: string) => boolean = existsSync,
): boolean {
  return ["queue", "data", "cache", "transcripts", "history"].some((m) => existsFn(join(root, m)));
}

/** Which internal shape an existing tree uses. Fresh (marker-less) roots get
 * the final shape. queue/review/watchlist sit at the root in BOTH layouts and
 * are deliberately not markers. */
export function layoutOf(
  root: string,
  existsFn: (p: string) => boolean = existsSync,
): "flat" | "v2" {
  if (existsFn(join(root, "data")) || existsFn(join(root, "cache"))) return "v2";
  const flatMarkers = [
    "transcripts",
    "history",
    "clones",
    "worktrees",
    "assess-history",
    "github-cache",
  ];
  if (flatMarkers.some((m) => existsFn(join(root, m)))) return "flat";
  return "v2";
}

/** The canonical config location: ~/.junco/config.json. */
export function defaultUserConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(juncoHome(env), "config.json");
}

/** Pre-0.10 config location (XDG_CONFIG_HOME or ~/.config). Read-only
 * fallback: an existing install keeps loading its config instead of being
 * routed to the setup walkthrough — which would write a competing config,
 * the exact failure mode this module was rewritten to prevent. */
export function legacyConfigPath(env: Record<string, string | undefined> = process.env): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : join(env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir(), ".config");
  return join(base, "junco", "config.json");
}

export interface ResolveConfigDeps {
  existsFn?: (p: string) => boolean;
  env?: Record<string, string | undefined>;
}

/**
 * The explicitly-named config path from `JUNCO_CONFIG` (#275) — tilde-expanded
 * and required to be absolute, then `resolve()`d to a normalized absolute
 * path — or `undefined` when the variable is unset, empty, or whitespace-only
 * (same "empty is unset" rule as `homeOf`/`legacyConfigPath`). A relative
 * value throws (see below) rather than being silently accepted.
 *
 * THE single spelling of "how the override resolves". `resolveConfigPath`
 * (which path do we load) and `sandboxDenyPaths` (which path must the agent
 * not read) both call this rather than re-deriving it — two independent
 * spellings would drift, and a drift here means the ACTIVE config, with its
 * possible `model.apiKey`, is silently readable inside the agent sandbox
 * (dataTree.ts's I-3 gap, reopened at a third location).
 *
 * A RELATIVE value (`JUNCO_CONFIG=junco.json`, easily exported from a shell
 * profile) is REJECTED, not resolved: `resolve()` cannot remove a relative
 * value's launch-directory dependence, it can only freeze it to whichever cwd
 * happens to be current when this function runs. A launchd daemon (cwd `/`)
 * and an operator shell would still land on two different absolute paths —
 * and two different `worker.lock`s — from the same `JUNCO_CONFIG=junco.json`,
 * so `status`/`doctor` could silently report "not running" against a live
 * daemon. cwd-dependence is exactly what this module was rewritten to
 * eliminate (split-queue incident, 2026-08-01), and `JUNCO_CONFIG` is new
 * enough on this branch that nothing depends on the old resolve-anyway
 * behaviour — so a relative value is a hard, actionable error instead.
 *
 * An ABSOLUTE value is still `resolve()`d, purely to normalize `..` segments
 * (`/w/sub/../cfg.json` → `/w/cfg.json`) into one canonical spelling — that's
 * what lets `resolveConfigPath`, `sandboxDenyPaths`, and the migrate guard's
 * equality check agree without each re-deriving it.
 */
export function configPathOverride(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const override = env.JUNCO_CONFIG;
  if (!(override && override.trim() !== "")) return undefined;
  const trimmed = override.trim();
  const expanded = expandHome(trimmed);
  if (!isAbsolute(expanded)) {
    throw new Error(
      `JUNCO_CONFIG must be an absolute path (a leading "~" is fine) — got ${JSON.stringify(trimmed)}`,
    );
  }
  return resolve(expanded);
}

/**
 * Where the config lives — a pure function of the environment, never of the
 * working directory or argv (split-queue incident, 2026-08-01): the canonical
 * ~/.junco/config.json, falling back to the legacy XDG path only while the
 * canonical file does not exist. The returned path may not exist — first-run
 * detection checks that separately.
 *
 * JUNCO_CONFIG (#275), when set to a non-empty value, wins outright — checked
 * before the canonical path, and normalized to an absolute path by
 * `configPathOverride`, which rejects a relative value outright rather than
 * resolving it (see there for why). `junco start` derives the daemon-singleton
 * worker.lock as `dirname(resolve(configPath))/worker.lock`, and every other
 * reader of it (ensureDaemon, cli, restartCmd, dataMigrateCmd, updateCmd,
 * doctor) gets it from the ONE helper that spells it — `workerLockPath`
 * (lock.ts, #310); they used to re-derive it by hand and had already drifted
 * (doctor's copy omitted the `resolve()`, so it went cwd-relative whenever
 * the config path was). So an override relocates the lock
 * right along with the config everywhere. Two named configs are therefore two
 * daemon instances — genuinely independent only when they also resolve to
 * DIFFERENT `dataDir`s and queue roots. Two configs over ONE data root are no
 * longer allowed to run as two daemons: `worker.lock` alone still cannot see
 * the collision (it sits beside each config), but `junco start` also claims
 * `<dataDir>/daemon-tree.lock` and `<queueRoot>/daemon-queue.lock`, and the
 * second daemon refuses to start rather than doubling up on one queue (#310 —
 * docs/configuration.md).
 */
export function resolveConfigPath(deps: ResolveConfigDeps = {}): string {
  const existsFn = deps.existsFn ?? existsSync;
  const env = deps.env ?? process.env;
  // An explicit JUNCO_CONFIG wins outright — above the canonical path, not
  // below it. Below, the variable would be useless on exactly the machines it
  // exists for (any machine with a real ~/.junco/config.json would ignore
  // it). A non-existent value still wins: the contract already allows the
  // returned path not to exist, and an explicit instruction should not be
  // silently overridden — this also lets a script name the config it is about
  // to create. Empty/whitespace is treated as unset, matching homeOf and
  // legacyConfigPath. configPathOverride rejects a relative value outright
  // (throws) rather than resolving it, so a launch-directory dependence can't
  // sneak back in here (#275, and the split-queue incident this module was
  // rewritten for).
  const override = configPathOverride(env);
  if (override !== undefined) return override;
  const canonical = defaultUserConfigPath(env);
  if (existsFn(canonical)) return canonical;
  const legacy = legacyConfigPath(env);
  if (existsFn(legacy)) return legacy;
  return canonical;
}

// junco's previously-hardcoded compat block (src/agent/session.ts), now the
// default. The SDK and the config file both use camelCase — no camelization.
//
// thinkingFormat is the GENERIC "chat-template" (kwargs declared below), not
// the SDK's fixed "qwen-chat-template" branch: that branch emits only
// enable_thinking/preserve_thinking and never forwards reasoning_effort, so on
// templates that steer thinking depth through a reasoning_effort kwarg
// (Qwen 3.8+) every configured thinkingLevel silently ran at the template
// default. SDK reference: @earendil-works/pi-ai dist/api/openai-completions.js,
// buildChatTemplateKwargs/resolveChatTemplateKwargValue.
const DEFAULT_COMPAT: Record<string, unknown> = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  supportsUsageInStreaming: true,
  thinkingFormat: "chat-template",
  chatTemplateKwargs: {
    enable_thinking: { $var: "thinking.enabled" },
    preserve_thinking: true,
    // Resolved through model.thinkingLevelMap; dropped when thinking is off.
    reasoning_effort: { omitWhenOff: true },
  },
};

// Collapse junco's six thinking levels onto the three-value effort vocabulary
// Qwen 3.8+ chat templates accept (low/medium/xhigh; template default xhigh —
// which is why an unforwarded effort ran everything at xhigh). "off" needs no
// entry: enable_thinking carries it and omitWhenOff drops the effort kwarg.
// Override via model.thinkingLevelMap for templates with a different
// vocabulary (a config override replaces this map wholesale).
const DEFAULT_THINKING_LEVEL_MAP: Record<string, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "xhigh",
  xhigh: "xhigh",
};

const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:1234/v1";

const ENV_REF = /^\$([A-Z_][A-Z0-9_]*)$/;

/**
 * Resolve the configured model.apiKey: a literal passes through; an exact
 * "$ENV_VAR" reference (uppercase env style only — anything else is a literal)
 * is read from the daemon environment; absent stays null so the SDK's
 * request-time provider env-var fallback (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * …) applies. "!command" values are rejected: the Pi SDK shell-executes them
 * in its own auth files, and junco will not forward that surface from
 * config.json.
 */
export function resolveApiKey(
  raw: string | undefined,
  env: Record<string, string | undefined>,
): string | null {
  if (raw === undefined) return null;
  if (raw.startsWith("!")) {
    throw new Error(
      'config: model.apiKey must not be a "!command" value — junco does not execute shell ' +
        'commands from config.json. Use a literal key or an "$ENV_VAR" reference.',
    );
  }
  const m = ENV_REF.exec(raw);
  if (m) {
    const val = env[m[1]];
    if (val === undefined || val === "") {
      throw new Error(
        `config: model.apiKey references $${m[1]}, but ${m[1]} is not set in the daemon environment.`,
      );
    }
    return val;
  }
  return raw;
}

export const ConfigSchema = z.object({
  dataDir: z.string().optional(), // unified data root; default applied at assembly
  // npm update-check opt-out (spec 2026-07-16): CLI/TUI-side only, the daemon
  // never phones home either way.
  updateCheck: z.boolean().default(true),
  vaultRoot: z.string().optional(), // DEPRECATED: legacy queue-root override
  juncoSubdir: z.string().default("Junco"),
  tools: z.array(z.string()).default(DEFAULT_TOOLS),
  model: z
    .object({
      id: z.string().default("local/my-model"),
      source: z.enum(["auto", "catalog", "inline"]).default("auto"),
      modelsJson: z.string().optional(),
      api: z.string().default("openai-completions"),
      baseUrl: z.string().optional(),
      // Env-independent mirror of resolveApiKey's own "!command" rejection
      // (defense in depth): reject the shape at WRITE time — `config set` /
      // the TUI editor / validateConfigObject — rather than only discovering
      // it at daemon-env-dependent assembly time. $VAR interpolation stays a
      // resolveApiKey concern (it needs the daemon environment, unavailable
      // here).
      apiKey: z
        .string()
        .optional()
        .refine((v) => v === undefined || !v.startsWith("!"), {
          message:
            'config: model.apiKey must not be a "!command" value — junco does not execute ' +
            "shell commands from config.json.",
        }),
      retry: z
        .object({
          maxRetries: z.number().int().min(0).optional(),
          baseDelayMs: z.number().min(0).optional(),
        })
        .default({}),
      reasoning: z.boolean().default(true),
      input: z.array(z.string()).default(["text", "image"]),
      contextWindow: z.number().default(131072),
      maxTokens: z.number().default(49152),
      cost: z
        .object({
          input: z.number().default(0),
          output: z.number().default(0),
          cacheRead: z.number().default(0),
          cacheWrite: z.number().default(0),
        })
        .default({}),
      thinkingLevel: z.string().default("medium"),
      thinkingLevelMap: z.record(z.string()).default(DEFAULT_THINKING_LEVEL_MAP),
      compat: z.record(z.unknown()).default({}),
    })
    .default({}),
  worker: z
    .object({
      defaultTimeoutMinutes: z.number().min(1).default(30),
      pollIntervalSeconds: z.number().min(1).default(15),
      startupPollSeconds: z.number().min(1).default(30),
      startupWait: z.boolean().default(true),
      // auto: probe local/inline endpoints, skip hosted-catalog ones
      // (shouldProbeEndpoint's existing rule). always/never override that
      // rule outright — see probePolicy() in health.ts.
      endpointProbe: z.enum(["auto", "always", "never"]).default("auto"),
      maxTransientRetries: z.number().int().min(0).default(2),
      retryBackoffSeconds: z.number().min(0).default(60),
      maxConcurrent: z.number().int().min(1).default(1),
      commitLeftovers: z.boolean().default(false),
      // Escalation ladder Stage 2a (apply-tickets-design.md): a failed
      // junco-patch apply falls back to the agent (patch-as-spec) rather than
      // failing the ticket terminally. On by default.
      applyFallbackToAgent: z.boolean().default(true),
      // Daily USD spend cap (Phase-3 Task 5): 0 = off (spend ledger never
      // consulted). Once today's spend reaches this, the provider gate enters
      // budget_exhausted until local midnight — see providerGate.ts.
      dailyBudgetUsd: z.number().min(0).default(0),
    })
    .default({}),
  supervisor: z
    .object({
      enabled: z.boolean().default(true),
      budgetPerKind: z.number().default(1),
      escalationWindowTurns: z.number().default(3),
      outputBudgetPerTurn: z.number().default(12000),
      outputBudgetPostCommit: z.number().default(24000),
    })
    .default({}),
  git: z
    .object({
      gitBin: z.string().default("git"),
      ghBin: z.string().default("gh"),
      defaultBaseBranch: z.string().default("main"),
      branchPrefix: z.string().default("junco/"),
      worktreeRoot: z.string().optional(), // DEPRECATED: legacy override; default <dataDir>/worktrees
      removeWorktreeOnSuccess: z.boolean().default(true),
      allowedRepoRoots: z.array(z.string()).default([]),
    })
    .default({}),
  pr: z
    .object({
      draftByDefault: z.boolean().default(true),
      defaultLabels: z.array(z.string()).default([]),
    })
    .default({}),
  verify: z
    .object({
      enabled: z.boolean().default(true),
      commandTimeout: z.number().min(1).default(60),
      blockOnFail: z.boolean().default(false),
      // #335: verification bash runs the agent's own artifacts, so it is
      // confined like the agent's bash. Opt out only for a suite that must
      // leave the sandbox (verification then runs the repo's code unconfined).
      sandboxed: z.boolean().default(true),
    })
    .default({}),
  sandbox: z
    .object({
      // On by default: agent tool execution is confined unless explicitly
      // disabled. Fails closed if the OS backend is unavailable (junco doctor
      // preflights it) — set enabled:false or backend:"none" to opt out.
      enabled: z.boolean().default(true),
      backend: z.enum(["auto", "seatbelt", "bwrap", "none"]).default("auto"),
      network: z.enum(["deny", "allow"]).default("deny"),
      extraDenyRead: z.array(z.string()).default([]),
      extraAllowWrite: z.array(z.string()).default([]),
      // Ceiling on ONE sandboxed bash call when the agent passes no `timeout`
      // (seconds; 0 = none). The agent's explicit timeout always wins. A
      // runaway `grep -r` once pinned a worker until the ticket timeout (#320).
      // max = 2^31-1 ms in seconds — Node's setTimeout ceiling
      bashTimeoutSeconds: z.number().int().min(0).max(2_147_483).default(600),
    })
    .default({}),
  critic: z
    .object({
      enabled: z.boolean().default(true),
      maxRetries: z.number().default(1),
      thinking: z.string().default("minimal"),
    })
    .default({}),
  planLint: z
    .object({
      enabled: z.boolean().default(true),
      blockOnError: z.boolean().default(true),
      checkLabels: z.boolean().default(true),
    })
    .default({}),
  observability: z
    .object({
      healthEnabled: z.boolean().default(true),
      // An empty (or whitespace-only) healthHost passes z.string() but makes
      // `server.listen(port, "")` bind ALL interfaces — exposing the
      // unauthenticated /health metrics network-wide (#71). Normalize it back
      // to loopback so the most-exposed value can never be the silent default.
      healthHost: z
        .string()
        .default("127.0.0.1")
        .transform((h) => (h.trim() === "" ? "127.0.0.1" : h)),
      healthPort: z.number().int().min(1).max(65535).default(8787),
      logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
      // Daemon-owned state (worker.log, per-ticket transcripts) lives here.
      stateDir: z.string().optional(), // DEPRECATED: legacy alias for dataDir
      logToFile: z.boolean().default(true),
      transcripts: z.boolean().default(true),
    })
    .default({}),
  github: z
    .object({
      enabled: z.boolean().default(false),
      triggerLabel: z.string().min(1).default("junco"),
      askLabel: z.string().min(1).optional(),
      pollIntervalSeconds: z.number().min(5).default(60),
      requireApproval: z.boolean().default(true),
      plannerModelId: z.string().min(1).optional(),
      externalReposRoot: z.string().min(1).optional(),
      repos: z
        .array(
          z.object({
            nwo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "github.repos[].nwo must be owner/repo"),
            path: z.string().min(1),
          }),
        )
        .default([]),
    })
    .default({}),
  assess: z
    .object({
      maxIssuesPerRun: z.number().int().min(1).default(20),
      minSeverity: z.enum(["critical", "high", "medium", "low"]).default("low"),
      npmBin: z.string().min(1).default("npm"),
      fileAs: z.enum(["me", "bot"]).default("me"),
    })
    .default({}),
  skills: z
    .object({
      harnessDirs: z.array(z.string().min(1)).default([]),
    })
    .default({}),
  botAccount: z
    .object({
      enabled: z.boolean().default(false),
      configDir: z.string().min(1).default(DEFAULT_BOT_GH_CONFIG_DIR),
    })
    .default({}),
  planSets: z
    .object({
      enabled: z.boolean().default(false),
      mergePollSeconds: z.number().min(5).default(60),
      maxTasks: z.number().int().min(1).default(10),
    })
    .default({}),
});

export type ConfigParsed = z.infer<typeof ConfigSchema>;

/** Parse + validate `path` against the JSON config schema, filling defaults.
 * Throws a friendly error on malformed JSON, and — when a leftover
 * `config.toml` sits next to a missing `config.json` — a guard error pointing
 * at the migration instead of a generic ENOENT. */
export function parseConfigFile(path: string): ConfigParsed {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (path.endsWith(".json")) {
      const tomlPath = path.slice(0, -".json".length) + ".toml";
      if (existsSync(tomlPath)) {
        throw new Error(
          `config: found ${tomlPath} but TOML config was removed — convert it to ${path} ` +
            `(see docs/configuration.md). Your config.toml is untouched.`,
        );
      }
    }
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `config: ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return ConfigSchema.parse(raw);
}

/** Result of the single-root ~/.junco probe (see `resolveDataRoot`). */
export interface DataRootResolution {
  dataDir: string;
  dataLayout: "flat" | "v2";
  legacyDataRoot: boolean;
}

/**
 * The single-root ~/.junco probe (spec 2026-07-16 / 2026-08-03): given an
 * already-normalized explicit override (or `undefined` when the config sets
 * neither `dataDir` nor `observability.stateDir`), resolve the EFFECTIVE data
 * root exactly as `assembleConfig` does. Extracted so callers that need to
 * PREVIEW the resolution without a full `ConfigParsed` — the setup wizard
 * must display the root the daemon will actually use even before it has
 * written a config — reuse this probe instead of re-deriving it (the trap
 * that would otherwise repeat resolveBotGhConfigDir's own split-brain
 * warning: two entry points quietly disagreeing about where something
 * lives).
 *
 * `explicitRoot === undefined`: a defaulted root prefers the canonical
 * `~/.junco`, but while `~/.junco` holds no data tree and the pre-0.10
 * `~/.local/state/junco` root exists, keep resolving to the legacy root
 * UNTOUCHED — `junco data migrate` is the only thing that relocates live
 * data. A root adopted via that fallback is BY DEFINITION a pre-0.10 tree
 * (the fallback only fires while `~/.junco` holds no tree AND the legacy
 * root exists — a v2 tree can't live at the legacy path before `junco data
 * migrate` ships in P2.T5), so its layout is forced "flat" rather than
 * trusting `layoutOf`'s marker probe: a legacy root that predates #194
 * (transcripts disabled, TUI never run, no worktrees/clones under dataDir)
 * or that exists but was never populated can hold none of `layoutOf`'s six
 * markers, and `layoutOf`'s marker-less default is "v2" — which would then
 * have startup's migrateStateTree (daemon.ts) relocate this root's
 * pre-unification dirs into data/-shaped destinations before any operator
 * ever ran `junco data migrate`, violating this branch's safety property
 * that nothing else relocates live data. Explicit-dataDir and canonical
 * (~/.junco) resolutions are unaffected — they still probe.
 */
export function resolveDataRoot(
  explicitRoot: string | undefined,
  env: Record<string, string | undefined> = process.env,
  existsFn: (p: string) => boolean = existsSync,
): DataRootResolution {
  let dataDir: string;
  let legacyDataRoot = false;
  if (explicitRoot !== undefined) {
    dataDir = expandHome(explicitRoot);
  } else {
    const canonical = juncoHome(env);
    const legacyRoot = join(homeOf(env), ".local", "state", "junco");
    if (!dataRootHasTree(canonical, existsFn) && existsFn(legacyRoot)) {
      dataDir = legacyRoot;
      legacyDataRoot = true;
    } else {
      dataDir = canonical;
    }
  }
  const dataLayout = legacyDataRoot ? "flat" : layoutOf(dataDir, existsFn);
  return { dataDir, dataLayout, legacyDataRoot };
}

/** Assemble the flat runtime `Config` from the parsed (nested, camelCase,
 * defaulted) schema output — expanding `~` in path fields and deriving the
 * github cross-field defaults (askLabel, externalReposRoot). */
export function assembleConfig(
  d: ConfigParsed,
  env: Record<string, string | undefined> = process.env,
  deps: { existsFn?: (p: string) => boolean } = {},
): Config {
  const baseUrlExplicit = d.model.baseUrl !== undefined;
  const eligible = catalogEligible({ source: d.model.source, id: d.model.id, baseUrlExplicit });
  const resolvedKey = resolveApiKey(d.model.apiKey, env);
  // Unified data root (spec 2026-07-16): legacy observability.stateDir wins
  // over dataDir for the whole root; legacy vaultRoot/juncoSubdir wins the
  // queue root only. See LegacyPathFlags for which override each key drives.
  //
  // #198: normalize the four legacy path keys once — an explicitly-set-but-empty
  // (or whitespace-only) value is treated as unset, so the legacy FLAG and the
  // RESOLUTION can never disagree (an empty "vaultRoot": "" previously set the
  // flag true — deprecation warning, provenance suffix, overlay pinning — while
  // the resolution fell through to the dataDir default).
  const norm = (v: string | undefined): string | undefined =>
    v !== undefined && v.trim() !== "" ? v : undefined;
  const nStateDir = norm(d.observability.stateDir);
  const nVault = norm(d.vaultRoot);
  const nWorktree = norm(d.git.worktreeRoot);
  const nExternal = norm(d.github.externalReposRoot);
  const existsFn = deps.existsFn ?? existsSync;
  // Single-root ~/.junco: see resolveDataRoot's doc comment for the full
  // fallback rationale.
  const explicitRoot = nStateDir ?? d.dataDir;
  const { dataDir, dataLayout, legacyDataRoot } = resolveDataRoot(explicitRoot, env, existsFn);
  const queueRoot = nVault ? join(expandHome(nVault), d.juncoSubdir) : join(dataDir, "queue");
  // Bot gh config dir: same single-root move as dataDir above, but resolved
  // through the shared resolveBotGhConfigDir (authCmd.ts/wizard.ts call the
  // same function so all three entrypoints agree — see its doc comment).
  const { dir: ghConfigDir, legacy: legacyGhDir } = resolveBotGhConfigDir(
    d.botAccount.configDir,
    env,
    existsFn,
  );
  const legacy = {
    vaultRoot: nVault !== undefined,
    stateDir: nStateDir !== undefined,
    worktreeRoot: nWorktree !== undefined,
    externalReposRoot: nExternal !== undefined,
    dataRoot: legacyDataRoot,
    ghConfigDir: legacyGhDir,
  };
  return {
    dataDir,
    dataLayout,
    queueRoot,
    legacy,
    updateCheck: d.updateCheck,
    tools: d.tools,
    model: {
      id: d.model.id,
      source: d.model.source,
      modelsJson: d.model.modelsJson ? expandHome(d.model.modelsJson) : null,
      api: d.model.api,
      // Stored raw; apiBaseUrl() normalizes (strips trailing /models) at use.
      baseUrl: d.model.baseUrl ?? DEFAULT_LOCAL_BASE_URL,
      baseUrlExplicit,
      // Catalog-eligible configs may omit the key: the SDK falls back to the
      // provider's env var (ANTHROPIC_API_KEY, …) at request time. The "1234"
      // placeholder applies only to inline/local endpoints.
      apiKey: resolvedKey ?? (eligible ? null : "1234"),
      retry: {
        maxRetries: d.model.retry.maxRetries ?? null,
        baseDelayMs: d.model.retry.baseDelayMs ?? null,
      },
      reasoning: d.model.reasoning,
      input: d.model.input,
      contextWindow: d.model.contextWindow,
      maxTokens: d.model.maxTokens,
      cost: {
        input: d.model.cost.input,
        output: d.model.cost.output,
        cacheRead: d.model.cost.cacheRead,
        cacheWrite: d.model.cost.cacheWrite,
      },
      thinkingLevel: d.model.thinkingLevel,
      thinkingLevelMap: d.model.thinkingLevelMap,
      compat: { ...DEFAULT_COMPAT, ...d.model.compat },
    },
    defaultTimeoutMinutes: d.worker.defaultTimeoutMinutes,
    pollIntervalSeconds: d.worker.pollIntervalSeconds,
    startupPollSeconds: d.worker.startupPollSeconds,
    startupWait: d.worker.startupWait,
    endpointProbe: d.worker.endpointProbe,
    maxTransientRetries: d.worker.maxTransientRetries,
    retryBackoffSeconds: d.worker.retryBackoffSeconds,
    maxConcurrent: d.worker.maxConcurrent,
    commitLeftoversEnabled: d.worker.commitLeftovers,
    applyFallbackToAgent: d.worker.applyFallbackToAgent,
    dailyBudgetUsd: d.worker.dailyBudgetUsd,
    supervisorEnabled: d.supervisor.enabled,
    supervisorBudgetPerKind: d.supervisor.budgetPerKind,
    supervisorEscalationWindow: d.supervisor.escalationWindowTurns,
    supervisorOutputBudgetPerTurn: d.supervisor.outputBudgetPerTurn,
    supervisorOutputBudgetPostCommit: d.supervisor.outputBudgetPostCommit,
    gitBin: d.git.gitBin,
    ghBin: d.git.ghBin,
    defaultBaseBranch: d.git.defaultBaseBranch,
    branchPrefix: d.git.branchPrefix,
    worktreeRoot: nWorktree
      ? expandHome(nWorktree)
      : join(dataDir, dataLayout === "v2" ? "cache/worktrees" : "worktrees"),
    removeWorktreeOnSuccess: d.git.removeWorktreeOnSuccess,
    allowedRepoRoots: d.git.allowedRepoRoots.map(expandHome),
    draftByDefault: d.pr.draftByDefault,
    defaultLabels: d.pr.defaultLabels,
    verifyEnabled: d.verify.enabled,
    verifyCommandTimeout: d.verify.commandTimeout,
    verifyBlockOnFail: d.verify.blockOnFail,
    verifySandboxed: d.verify.sandboxed,
    criticEnabled: d.critic.enabled,
    criticMaxRetries: d.critic.maxRetries,
    criticThinking: d.critic.thinking,
    planLintEnabled: d.planLint.enabled,
    planLintBlockOnError: d.planLint.blockOnError,
    planLintCheckLabels: d.planLint.checkLabels,
    healthEnabled: d.observability.healthEnabled,
    healthHost: d.observability.healthHost,
    healthPort: d.observability.healthPort,
    logLevel: d.observability.logLevel,
    logToFile: d.observability.logToFile,
    transcriptsEnabled: d.observability.transcripts,
    github: {
      enabled: d.github.enabled,
      triggerLabel: d.github.triggerLabel,
      askLabel: d.github.askLabel ?? `${d.github.triggerLabel}:ask`,
      pollIntervalSeconds: d.github.pollIntervalSeconds,
      requireApproval: d.github.requireApproval,
      plannerModelId: d.github.plannerModelId ?? null,
      externalReposRoot: nExternal
        ? expandHome(nExternal)
        : join(dataDir, dataLayout === "v2" ? "cache/clones/external" : "clones/external"),
      repos: d.github.repos.map((r) => ({ nwo: r.nwo, path: expandHome(r.path) })),
    },
    assess: {
      maxIssuesPerRun: d.assess.maxIssuesPerRun,
      minSeverity: d.assess.minSeverity,
      npmBin: d.assess.npmBin,
      fileAs: d.assess.fileAs,
    },
    skills: {
      harnessDirs: d.skills.harnessDirs.map(expandHome),
    },
    sandbox: {
      enabled: d.sandbox.enabled,
      backend: d.sandbox.backend,
      network: d.sandbox.network,
      extraDenyRead: d.sandbox.extraDenyRead.map(expandHome),
      extraAllowWrite: d.sandbox.extraAllowWrite.map(expandHome),
      bashTimeoutSeconds: d.sandbox.bashTimeoutSeconds,
    },
    botAccount: {
      enabled: d.botAccount.enabled,
      configDir: ghConfigDir,
    },
    planSets: {
      enabled: d.planSets.enabled,
      mergePollSeconds: d.planSets.mergePollSeconds,
      maxTasks: d.planSets.maxTasks,
    },
  };
}

export function loadConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Config {
  return assembleConfig(parseConfigFile(path), env);
}

/** Validate a raw (parsed-JSON) config object against `ConfigSchema`, throwing
 * a zod error on failure. Used by `junco config set` (src/configCmd.ts) to
 * confirm a sparse mutation still produces a valid, defaultable config before
 * it's written to disk. */
export function validateConfigObject(obj: unknown): void {
  ConfigSchema.parse(obj);
}

export interface KnownQueueRoot {
  /** Absolute path to the queue root (the dir holding inbox/processing/...). */
  root: string;
  /** Operator-facing label, e.g. "canonical", "legacy data root", "vault". */
  label: string;
  /** True for the root the running config actually resolves to. */
  resolved: boolean;
}

/**
 * Every queue root this installation could plausibly own, deduped by
 * resolved path, with the one the running config actually resolves to
 * flagged `resolved: true`. Pure: no I/O, no cwd, no argv — the split-queue
 * incident (2026-08-01) that motivates this function came from a resolution
 * path that quietly depended on more than the environment, so this one
 * deliberately doesn't.
 *
 * Reuses `juncoHome`/`homeOf` — the exact helpers `resolveDataRoot` (this
 * file, `:516`) uses to derive the canonical and legacy-data-root shapes —
 * rather than re-deriving those path shapes here. A second spelling of
 * "where the legacy root is" is exactly the drift this codebase keeps
 * getting bitten by (see `resolveBotGhConfigDir`'s doc comment above for
 * the prior incident of that same shape).
 *
 * Only two of the four conceptual roots the split-queue plan names —
 * canonical `~/.junco/queue` and legacy data root
 * `~/.local/state/junco/queue` — are independently derivable from `env`
 * alone. The other two (a legacy `vaultRoot`/`juncoSubdir` queue and an
 * explicit `dataDir`/`stateDir` override) are arbitrary, operator-chosen
 * strings that `assembleConfig` folds into `queueRoot` and does not retain
 * separately on `Config` — and this function is intentionally given only
 * `cfg.queueRoot`, not the raw schema, so it can't re-derive them from a
 * second copy of that logic either. When `cfg.queueRoot` doesn't match
 * either derivable shape, it is still always included (labeled
 * "configured") rather than guessed at — the resolved root is authoritative
 * for whatever it is on THIS run; only unresolved history is unrecoverable.
 */
export function knownQueueRoots(
  cfg: Pick<Config, "queueRoot">,
  env: Record<string, string | undefined> = process.env,
): KnownQueueRoot[] {
  const knownShapes: Array<{ root: string; label: string }> = [
    { root: join(juncoHome(env), "queue"), label: "canonical" },
    { root: join(homeOf(env), ".local", "state", "junco", "queue"), label: "legacy data root" },
  ];
  const byRoot = new Map<string, KnownQueueRoot>();
  for (const shape of knownShapes) {
    byRoot.set(shape.root, { root: shape.root, label: shape.label, resolved: false });
  }
  const resolvedMatch = byRoot.get(cfg.queueRoot);
  if (resolvedMatch) {
    resolvedMatch.resolved = true;
  } else {
    byRoot.set(cfg.queueRoot, { root: cfg.queueRoot, label: "configured", resolved: true });
  }
  return [...byRoot.values()];
}

export function queuePaths(cfg: Config): Paths {
  const root = cfg.queueRoot;
  return {
    inbox: join(root, "inbox"),
    processing: join(root, "processing"),
    done: join(root, "done"),
    failed: join(root, "failed"),
  };
}

/** One human-readable deprecation per legacy path key set in config.json.
 * Surfaced by daemon startup, `junco doctor`, and `junco data` (spec §5).
 * The migrate hint is reserved for the keys `junco data migrate` actually
 * unifies (vaultRoot/juncoSubdir, observability.stateDir); worktreeRoot and
 * externalReposRoot are NOT moved by it, so their hints are key-specific
 * removal instructions — pointing those at the migrate would loop the
 * operator (the warning would survive every run). */
export function configDeprecations(cfg: Config): string[] {
  const out: string[] = [];
  const hint = "run 'junco data migrate' to unify (docs/configuration.md)";
  if (cfg.legacy.vaultRoot)
    out.push(
      `config: vaultRoot/juncoSubdir are deprecated — the queue lives at <dataDir>/queue; ${hint}`,
    );
  if (cfg.legacy.stateDir)
    out.push(`config: observability.stateDir is deprecated — use top-level dataDir; ${hint}`);
  if (cfg.legacy.worktreeRoot)
    out.push(
      "config: git.worktreeRoot is deprecated — remove the key (with the daemon idle); " +
        "worktrees are disposable and will be recreated under <dataDir>/worktrees " +
        "(docs/configuration.md)",
    );
  if (cfg.legacy.externalReposRoot)
    out.push(
      "config: github.externalReposRoot is deprecated — remove the key; external clones " +
        "re-clone under <dataDir>/clones/external on next use (or move them there first) " +
        "(docs/configuration.md)",
    );
  if (cfg.legacy.dataRoot)
    out.push(
      "config: data lives at the legacy ~/.local/state/junco root — " +
        "run 'junco data migrate' to move it under ~/.junco (docs/configuration.md)",
    );
  if (cfg.legacy.ghConfigDir)
    out.push(
      "config: bot gh credentials live at the legacy ~/.config/junco/gh — " +
        "run 'junco data migrate' to move them to ~/.junco/gh",
    );
  return out;
}
