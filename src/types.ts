/** OpenAI-completions-style compat flags (open record — any future Pi compat
 * key passes through). The named fields are the ones junco has tuned defaults
 * for; `[k: string]` keeps the schema forward-compatible. */
export interface ModelCompat {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: string;
  supportsUsageInStreaming?: boolean;
  thinkingFormat?: string;
  [k: string]: unknown;
}
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
/** The model + inference provider junco drives Pi against. Resolved by
 * `loadConfig` from the `[model]` section (with fallbacks to the legacy
 * `[pi].model_id` / `[oMLX]` keys). When `modelsJson` points at an existing
 * Pi-style models.json the provider+model are loaded from THAT file and the
 * inline capability fields are ignored. */
export interface ModelConfig {
  id: string; // provider-prefixed, e.g. "openai/gpt-4o-mini"
  modelsJson: string | null; // path to a Pi models.json, or null for inline
  api: string; // Pi Api style, e.g. "openai-completions"
  baseUrl: string; // OpenAI-compatible endpoint
  apiKey: string;
  reasoning: boolean;
  input: string[]; // e.g. ["text", "image"]
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
  thinkingLevel: string; // worker default thinking level
  compat: ModelCompat;
}
export interface Config {
  vaultRoot: string;
  juncoSubdir: string;
  model: ModelConfig;
  tools: string[];
  defaultTimeoutMinutes: number;
  pollIntervalSeconds: number;
  startupPollSeconds: number;
  startupWait: boolean;
  // Resilience: transient-failure requeue budget + backoff (worker section).
  maxTransientRetries: number;
  retryBackoffSeconds: number;
  // Parallel ticket slots; same-repo tickets always serialize.
  maxConcurrent: number;
  // Loop-guard supervisor knobs (parity with the Python [supervisor] section).
  supervisorEnabled: boolean;
  supervisorBudgetPerKind: number;
  supervisorEscalationWindow: number;
  supervisorOutputBudgetPerTurn: number;
  supervisorOutputBudgetPostCommit: number;
  gitBin: string;
  ghBin: string;
  // Repo-flow / PR config (parity with Python [git] and [pr] sections).
  defaultBaseBranch: string;
  branchPrefix: string;
  worktreeRoot: string;
  removeWorktreeOnSuccess: boolean;
  // Containment rail: when non-empty, PR-flow tickets may only target repos
  // under these roots ([] = anywhere).
  allowedRepoRoots: string[];
  draftByDefault: boolean;
  defaultLabels: string[];
  verifyEnabled: boolean;
  verifyCommandTimeout: number;
  verifyBlockOnFail: boolean;
  // Plan-lint gate (parity with the Python [plan_lint] section).
  planLintEnabled: boolean;
  planLintBlockOnError: boolean;
  planLintCheckLabels: boolean;
  // Whether to sweep uncommitted leftovers into a final commit (parity with
  // [pi].commit_leftovers). Pi-strict default is false (fail-loud).
  commitLeftoversEnabled: boolean;
  // Post-session critic (parity with the Python [critic] section).
  criticEnabled: boolean;
  criticMaxRetries: number;
  criticThinking: string;
  // Observability (parity with the Python [observability] section): the health
  // HTTP server's bind address + the daemon-wide log threshold.
  healthEnabled: boolean;
  healthHost: string;
  healthPort: number;
  logLevel: "debug" | "info" | "warn" | "error";
  // Daemon-owned state (worker.log + transcripts/) lives under stateDir.
  stateDir: string;
  logToFile: boolean;
  transcriptsEnabled: boolean;
}
export interface Paths {
  inbox: string;
  processing: string;
  done: string;
  failed: string;
}

/**
 * Terminal statuses that route a ticket to done/ (everything else → failed/).
 * Shared by finalize.ts (routing) and metrics.ts (success/failure bucketing) —
 * keep this the ONLY definition.
 */
export const TERMINAL_DONE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "completed_no_changes",
  "aborted_partial",
]);

export interface Ticket {
  path: string;
  id: string;
  priority: "low" | "normal" | "high";
  timeoutSeconds: number;
  body: string;
  frontmatter: Record<string, unknown>;
  hasRepo: boolean;
  /** ISO instant before which the worker must not claim this ticket (null = no gate). */
  notBefore: string | null;
  /** Worker-managed transparent-retry counter (0 on first attempt). */
  retryCount: number;
  /** Per-ticket tool allowlist override (null = use the mode default). */
  tools: string[] | null;
}

export interface ToolCall {
  name: string;
  args: unknown;
}
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  total: number;
}
export interface RunResult {
  finalText: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: string | null;
  errorMessage: string | null;
  timedOut: boolean;
  durationMs: number;
  // True when a guard KILL aborted the session (a SOFT abort — the agent may
  // have made real commits before the guard fired). The PR-flow treats this
  // differently from a hard exit (timeout / non-guard error). Python parity:
  // `RunResult.aborted_by_repetition`.
  abortedByGuard: boolean;
}
