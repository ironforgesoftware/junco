import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

/** The user-level default config location (XDG_CONFIG_HOME or ~/.config). */
export function defaultUserConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "junco", "config.json");
}

export interface ResolveConfigDeps {
  existsFn?: (p: string) => boolean;
  env?: Record<string, string | undefined>;
  cwd?: () => string;
}

/**
 * Where the config lives. Order: explicit --config → ./config.json when present
 * (repo-local setups keep working) → the user-level default. The returned path
 * may not exist yet — first-run detection checks that separately.
 */
export function resolveConfigPath(
  explicit: string | undefined,
  deps: ResolveConfigDeps = {},
): string {
  const existsFn = deps.existsFn ?? existsSync;
  const cwd = deps.cwd ?? ((): string => process.cwd());
  if (explicit) return resolve(cwd(), explicit);
  const local = resolve(cwd(), "config.json");
  if (existsFn(local)) return local;
  return defaultUserConfigPath(deps.env ?? process.env);
}

// junco's previously-hardcoded compat block (src/agent/session.ts), now the
// default. The SDK and the config file both use camelCase — no camelization.
const DEFAULT_COMPAT: Record<string, unknown> = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  supportsUsageInStreaming: true,
  thinkingFormat: "qwen-chat-template",
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
  botAccount: z
    .object({
      enabled: z.boolean().default(false),
      configDir: z.string().min(1).default("~/.config/junco/gh"),
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

/** Assemble the flat runtime `Config` from the parsed (nested, camelCase,
 * defaulted) schema output — expanding `~` in path fields and deriving the
 * github cross-field defaults (askLabel, externalReposRoot). */
export function assembleConfig(
  d: ConfigParsed,
  env: Record<string, string | undefined> = process.env,
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
  const dataDir = expandHome(nStateDir ?? d.dataDir ?? "~/.local/state/junco");
  const queueRoot = nVault ? join(expandHome(nVault), d.juncoSubdir) : join(dataDir, "queue");
  const legacy = {
    vaultRoot: nVault !== undefined,
    stateDir: nStateDir !== undefined,
    worktreeRoot: nWorktree !== undefined,
    externalReposRoot: nExternal !== undefined,
  };
  return {
    dataDir,
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
    worktreeRoot: nWorktree ? expandHome(nWorktree) : join(dataDir, "worktrees"),
    removeWorktreeOnSuccess: d.git.removeWorktreeOnSuccess,
    allowedRepoRoots: d.git.allowedRepoRoots.map(expandHome),
    draftByDefault: d.pr.draftByDefault,
    defaultLabels: d.pr.defaultLabels,
    verifyEnabled: d.verify.enabled,
    verifyCommandTimeout: d.verify.commandTimeout,
    verifyBlockOnFail: d.verify.blockOnFail,
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
      externalReposRoot: nExternal ? expandHome(nExternal) : join(dataDir, "clones", "external"),
      repos: d.github.repos.map((r) => ({ nwo: r.nwo, path: expandHome(r.path) })),
    },
    assess: {
      maxIssuesPerRun: d.assess.maxIssuesPerRun,
      minSeverity: d.assess.minSeverity,
      npmBin: d.assess.npmBin,
      fileAs: d.assess.fileAs,
    },
    sandbox: {
      enabled: d.sandbox.enabled,
      backend: d.sandbox.backend,
      network: d.sandbox.network,
      extraDenyRead: d.sandbox.extraDenyRead.map(expandHome),
      extraAllowWrite: d.sandbox.extraAllowWrite.map(expandHome),
    },
    botAccount: {
      enabled: d.botAccount.enabled,
      configDir: expandHome(d.botAccount.configDir),
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
  return out;
}
