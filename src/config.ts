import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { Config, Paths } from "./types.js";

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return p;
}

/** The user-level default config location (XDG_CONFIG_HOME or ~/.config). */
export function defaultUserConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "junco", "config.toml");
}

export interface ResolveConfigDeps {
  existsFn?: (p: string) => boolean;
  env?: Record<string, string | undefined>;
  cwd?: () => string;
}

/**
 * Where the config lives. Order: explicit --config → ./config.toml when present
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
  const local = resolve(cwd(), "config.toml");
  if (existsFn(local)) return local;
  return defaultUserConfigPath(deps.env ?? process.env);
}

// The tool allowlist is configured (parity with the Python worker) as a
// `--tools <csv>` pair inside `[pi].extra_args`, e.g.
//   extra_args = ["--tools", "bash,read,write,edit,grep,find,todo_write"]
// Extract that CSV; fall back to DEFAULT_TOOLS when no --tools is present.
function toolsFromExtraArgs(extraArgs: string[] | undefined): string[] {
  if (extraArgs) {
    const i = extraArgs.indexOf("--tools");
    if (i >= 0 && i + 1 < extraArgs.length) {
      const tools = extraArgs[i + 1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (tools.length > 0) return tools;
    }
  }
  return DEFAULT_TOOLS;
}

// junco's previously-hardcoded compat block (src/agent/session.ts), now the
// default. The SDK uses camelCase; TOML uses snake_case (camelized on load).
const DEFAULT_COMPAT: Record<string, unknown> = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  supportsUsageInStreaming: true,
  thinkingFormat: "qwen-chat-template",
};

function camelizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

const TomlSchema = z.object({
  vault_root: z.string({ required_error: "config: vault_root is required" }),
  junco_subdir: z.string().default("Junco"),
  pi: z
    .object({
      model_id: z.string().default("local/my-model"),
      extra_args: z.array(z.string()).optional(),
      commit_leftovers: z.boolean().default(false),
    })
    .default({}),
  oMLX: z
    .object({
      url: z.string().default("http://127.0.0.1:1234/v1"),
      api_key: z.string().default("1234"),
    })
    .default({}),
  // The model + inference provider. Every field is optional: omitted fields
  // fall back to the legacy [pi].model_id / [oMLX] keys (id/base_url/api_key) or
  // to the tuned defaults below (which reproduce junco's previously-hardcoded
  // values). Set `models_json` to load the provider+model from a Pi models.json
  // instead of the inline fields.
  model: z
    .object({
      id: z.string().optional(),
      models_json: z.string().optional(),
      api: z.string().optional(),
      base_url: z.string().optional(),
      api_key: z.string().optional(),
      reasoning: z.boolean().optional(),
      input: z.array(z.string()).optional(),
      context_window: z.number().optional(),
      max_tokens: z.number().optional(),
      cost: z
        .object({
          input: z.number(),
          output: z.number(),
          cache_read: z.number(),
          cache_write: z.number(),
        })
        .partial()
        .optional(),
      thinking_level: z.string().optional(),
      // Open record so any present/future Pi compat key passes through. Keys are
      // snake_case in TOML and camelCased before reaching the SDK.
      compat: z.record(z.unknown()).optional(),
    })
    .default({}),
  worker: z
    .object({
      default_timeout_minutes: z.number().default(30),
      poll_interval_seconds: z.number().default(15),
      startup_poll_seconds: z.number().default(30),
      startup_wait: z.boolean().default(true),
      // Resilience: transient failures (endpoint errors with no commits) are
      // requeued with a not_before backoff up to this many times.
      max_transient_retries: z.number().int().min(0).default(2),
      retry_backoff_seconds: z.number().min(0).default(60),
      // Parallel ticket slots. Tickets targeting the SAME repo always serialize.
      max_concurrent: z.number().int().min(1).default(1),
    })
    .default({}),
  // Loop-guard supervisor knobs. Python defaults: enabled false; here we
  // default enabled TRUE for the in-process agent run (M2). The numeric
  // defaults match the Python worker (budget_per_kind 1, escalation_window 3,
  // output_budget_per_turn 12000, output_budget_post_commit 24000).
  supervisor: z
    .object({
      enabled: z.boolean().default(true),
      budget_per_kind: z.number().default(1),
      escalation_window_turns: z.number().default(3),
      output_budget_per_turn: z.number().default(12000),
      output_budget_post_commit: z.number().default(24000),
    })
    .default({}),
  git: z
    .object({
      git_bin: z.string().default("git"),
      gh_bin: z.string().default("gh"),
      default_base_branch: z.string().default("main"),
      branch_prefix: z.string().default("junco/"),
      worktree_root: z.string().default("~/junco/worktrees"),
      remove_worktree_on_success: z.boolean().default(true),
      // Containment rail: when non-empty, PR-flow tickets may only target
      // repos under these roots ([] = anywhere).
      allowed_repo_roots: z.array(z.string()).default([]),
    })
    .default({}),
  pr: z
    .object({
      draft_by_default: z.boolean().default(true),
      default_labels: z.array(z.string()).default([]),
    })
    .default({}),
  verify: z
    .object({
      enabled: z.boolean().default(true),
      command_timeout: z.number().default(60),
      block_on_fail: z.boolean().default(false),
    })
    .default({}),
  critic: z
    .object({
      enabled: z.boolean().default(true),
      max_retries: z.number().default(1),
      thinking: z.string().default("minimal"),
    })
    .default({}),
  plan_lint: z
    .object({
      enabled: z.boolean().default(true),
      block_on_error: z.boolean().default(true),
      check_labels: z.boolean().default(true),
    })
    .default({}),
  observability: z
    .object({
      health_enabled: z.boolean().default(true),
      health_host: z.string().default("127.0.0.1"),
      health_port: z.number().default(8787),
      log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
      // Daemon-owned state (worker.log, per-ticket transcripts) lives here.
      state_dir: z.string().default("~/.local/state/junco"),
      log_to_file: z.boolean().default(true),
      transcripts: z.boolean().default(true),
    })
    .default({}),
  github: z
    .object({
      enabled: z.boolean().default(false),
      trigger_label: z.string().min(1).default("junco"),
      ask_label: z.string().min(1).optional(),
      poll_interval_seconds: z.number().min(5).default(60),
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
});

export function loadConfig(path: string): Config {
  const raw = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  // Accept both [oMLX] and [omlx] section casings (parity with the Python
  // load_config, which read data.get("oMLX", data.get("omlx", {}))).
  if (raw.oMLX === undefined && raw.omlx !== undefined) raw.oMLX = raw.omlx;
  const d = TomlSchema.parse(raw);
  return {
    vaultRoot: expandHome(d.vault_root),
    juncoSubdir: d.junco_subdir,
    model: {
      // id/base_url/api_key fall back to the legacy [pi].model_id / [oMLX] keys.
      id: d.model.id ?? d.pi.model_id,
      modelsJson: d.model.models_json ? expandHome(d.model.models_json) : null,
      api: d.model.api ?? "openai-completions",
      // Stored raw; apiBaseUrl() normalizes (strips trailing /models) at use.
      baseUrl: d.model.base_url ?? d.oMLX.url,
      apiKey: d.model.api_key ?? d.oMLX.api_key,
      reasoning: d.model.reasoning ?? true,
      input: d.model.input ?? ["text", "image"],
      contextWindow: d.model.context_window ?? 131072,
      maxTokens: d.model.max_tokens ?? 49152,
      cost: {
        input: d.model.cost?.input ?? 0,
        output: d.model.cost?.output ?? 0,
        cacheRead: d.model.cost?.cache_read ?? 0,
        cacheWrite: d.model.cost?.cache_write ?? 0,
      },
      thinkingLevel: d.model.thinking_level ?? "medium",
      compat: { ...DEFAULT_COMPAT, ...camelizeKeys(d.model.compat ?? {}) },
    },
    tools: toolsFromExtraArgs(d.pi.extra_args),
    defaultTimeoutMinutes: d.worker.default_timeout_minutes,
    pollIntervalSeconds: d.worker.poll_interval_seconds,
    startupPollSeconds: d.worker.startup_poll_seconds,
    startupWait: d.worker.startup_wait,
    maxTransientRetries: d.worker.max_transient_retries,
    retryBackoffSeconds: d.worker.retry_backoff_seconds,
    maxConcurrent: d.worker.max_concurrent,
    supervisorEnabled: d.supervisor.enabled,
    supervisorBudgetPerKind: d.supervisor.budget_per_kind,
    supervisorEscalationWindow: d.supervisor.escalation_window_turns,
    supervisorOutputBudgetPerTurn: d.supervisor.output_budget_per_turn,
    supervisorOutputBudgetPostCommit: d.supervisor.output_budget_post_commit,
    gitBin: d.git.git_bin,
    ghBin: d.git.gh_bin,
    defaultBaseBranch: d.git.default_base_branch,
    branchPrefix: d.git.branch_prefix,
    worktreeRoot: expandHome(d.git.worktree_root),
    removeWorktreeOnSuccess: d.git.remove_worktree_on_success,
    allowedRepoRoots: d.git.allowed_repo_roots.map(expandHome),
    draftByDefault: d.pr.draft_by_default,
    defaultLabels: d.pr.default_labels,
    verifyEnabled: d.verify.enabled,
    verifyCommandTimeout: d.verify.command_timeout,
    verifyBlockOnFail: d.verify.block_on_fail,
    criticEnabled: d.critic.enabled,
    criticMaxRetries: d.critic.max_retries,
    criticThinking: d.critic.thinking,
    planLintEnabled: d.plan_lint.enabled,
    planLintBlockOnError: d.plan_lint.block_on_error,
    planLintCheckLabels: d.plan_lint.check_labels,
    commitLeftoversEnabled: d.pi.commit_leftovers,
    healthEnabled: d.observability.health_enabled,
    healthHost: d.observability.health_host,
    healthPort: d.observability.health_port,
    logLevel: d.observability.log_level,
    stateDir: expandHome(d.observability.state_dir),
    logToFile: d.observability.log_to_file,
    transcriptsEnabled: d.observability.transcripts,
    github: {
      enabled: d.github.enabled,
      triggerLabel: d.github.trigger_label,
      askLabel: d.github.ask_label ?? `${d.github.trigger_label}:ask`,
      pollIntervalSeconds: d.github.poll_interval_seconds,
      repos: d.github.repos.map((r) => ({ nwo: r.nwo, path: expandHome(r.path) })),
    },
  };
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
