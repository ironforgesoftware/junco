import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { DEFAULT_BOT_GH_CONFIG_DIR } from "./configPaths.js";

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

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
      // #337: scan the diff junco is about to push for high-confidence secret
      // shapes. The sandbox's network rule governs the AGENT's tool calls, not
      // junco's own push — this is the choke point that sees it. On by default.
      secretScan: z.boolean().default(true),
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
      // disabled. An explicit backend fails closed if unavailable (junco doctor
      // preflights it); "auto" degrades to none unless requireBackend is set.
      // Set enabled:false or backend:"none" to opt out.
      enabled: z.boolean().default(true),
      backend: z.enum(["auto", "seatbelt", "bwrap", "none"]).default("auto"),
      // #344: demand the OS guarantee under "auto" — a failed probe fails the
      // ticket closed (and doctor ✗) instead of degrading to none.
      requireBackend: z.boolean().default(false),
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

/** Validate a raw (parsed-JSON) config object against `ConfigSchema`, throwing
 * a zod error on failure. Used by every config.json writer via
 * `writeConfigFile`/`updateConfigFile` (src/configWrite.ts) to confirm a
 * sparse mutation still produces a valid, defaultable config before it's
 * written to disk. */
export function validateConfigObject(obj: unknown): void {
  ConfigSchema.parse(obj);
}
