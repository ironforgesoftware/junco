import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Config, Paths } from "./types.js";

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

export const ConfigSchema = z.object({
  vaultRoot: z.string({ required_error: "config: vaultRoot is required" }),
  juncoSubdir: z.string().default("Junco"),
  tools: z.array(z.string()).default(DEFAULT_TOOLS),
  model: z
    .object({
      id: z.string().default("local/my-model"),
      modelsJson: z.string().optional(),
      api: z.string().default("openai-completions"),
      baseUrl: z.string().default("http://127.0.0.1:1234/v1"),
      apiKey: z.string().default("1234"),
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
      maxTransientRetries: z.number().int().min(0).default(2),
      retryBackoffSeconds: z.number().min(0).default(60),
      maxConcurrent: z.number().int().min(1).default(1),
      commitLeftovers: z.boolean().default(false),
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
      worktreeRoot: z.string().default("~/junco/worktrees"),
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
      stateDir: z.string().default("~/.local/state/junco"),
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
export function assembleConfig(d: ConfigParsed): Config {
  return {
    vaultRoot: expandHome(d.vaultRoot),
    juncoSubdir: d.juncoSubdir,
    tools: d.tools,
    model: {
      id: d.model.id,
      modelsJson: d.model.modelsJson ? expandHome(d.model.modelsJson) : null,
      api: d.model.api,
      // Stored raw; apiBaseUrl() normalizes (strips trailing /models) at use.
      baseUrl: d.model.baseUrl,
      apiKey: d.model.apiKey,
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
    maxTransientRetries: d.worker.maxTransientRetries,
    retryBackoffSeconds: d.worker.retryBackoffSeconds,
    maxConcurrent: d.worker.maxConcurrent,
    commitLeftoversEnabled: d.worker.commitLeftovers,
    supervisorEnabled: d.supervisor.enabled,
    supervisorBudgetPerKind: d.supervisor.budgetPerKind,
    supervisorEscalationWindow: d.supervisor.escalationWindowTurns,
    supervisorOutputBudgetPerTurn: d.supervisor.outputBudgetPerTurn,
    supervisorOutputBudgetPostCommit: d.supervisor.outputBudgetPostCommit,
    gitBin: d.git.gitBin,
    ghBin: d.git.ghBin,
    defaultBaseBranch: d.git.defaultBaseBranch,
    branchPrefix: d.git.branchPrefix,
    worktreeRoot: expandHome(d.git.worktreeRoot),
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
    stateDir: expandHome(d.observability.stateDir),
    logToFile: d.observability.logToFile,
    transcriptsEnabled: d.observability.transcripts,
    github: {
      enabled: d.github.enabled,
      triggerLabel: d.github.triggerLabel,
      askLabel: d.github.askLabel ?? `${d.github.triggerLabel}:ask`,
      pollIntervalSeconds: d.github.pollIntervalSeconds,
      requireApproval: d.github.requireApproval,
      plannerModelId: d.github.plannerModelId ?? null,
      externalReposRoot: expandHome(
        d.github.externalReposRoot ?? join(d.observability.stateDir, "external"),
      ),
      repos: d.github.repos.map((r) => ({ nwo: r.nwo, path: expandHome(r.path) })),
    },
    assess: {
      maxIssuesPerRun: d.assess.maxIssuesPerRun,
      minSeverity: d.assess.minSeverity,
      npmBin: d.assess.npmBin,
    },
  };
}

export function loadConfig(path: string): Config {
  return assembleConfig(parseConfigFile(path));
}

export function queuePaths(cfg: Config): Paths {
  const root = join(cfg.vaultRoot, cfg.juncoSubdir);
  return {
    inbox: join(root, "inbox"),
    processing: join(root, "processing"),
    done: join(root, "done"),
    failed: join(root, "failed"),
  };
}
