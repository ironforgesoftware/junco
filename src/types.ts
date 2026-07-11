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
 * `loadConfig` from the `model` section of config.json. When `modelsJson`
 * points at an existing Pi-style models.json the provider+model are loaded
 * from THAT file and the inline capability fields are ignored. */
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
/** One watched GitHub repo: name-with-owner and its local clone. */
export interface GithubRepoMapping {
  nwo: string; // "owner/repo"
  path: string; // local clone path (expanded)
}
/** `[github]` — the issues→inbox bridge. Disabled by default (zero gh calls). */
export interface GithubConfig {
  enabled: boolean;
  triggerLabel: string; // approval label; lifecycle labels derive from it
  askLabel: string; // routes an issue to the read-only Q&A path
  pollIntervalSeconds: number; // bridge sweep cadence (independent of worker poll)
  repos: GithubRepoMapping[];
  requireApproval: boolean; // false ⇒ plan-ready auto-executes next sweep
  plannerModelId: string | null; // planning-session model id override (same endpoint)
  externalReposRoot: string; // managed clones of unowned repos (fork-PR flow)
}
/** [assess] — knobs for `junco assess` runs (vulnerability audit → GitHub issues). */
export interface AssessConfig {
  maxIssuesPerRun: number; // cap on issues filed per assessment run
  minSeverity: "critical" | "high" | "medium" | "low"; // findings below this are dropped
  npmBin: string; // binary for the dependency scan (`npm audit --json`)
}
export interface SandboxConfig {
  // Master switch. false = current behavior (no sandbox, full env, no jail).
  enabled: boolean;
  // auto → seatbelt on darwin, bwrap on linux. none = no OS wrapping (env
  // scrub + JS path-jail still apply; bash keeps network + can read anywhere).
  backend: "auto" | "seatbelt" | "bwrap" | "none";
  // Default egress for agent tool subprocesses. Per-ticket `network: true`
  // frontmatter overrides to allow for one ticket.
  network: "deny" | "allow";
  // Extra absolute paths whose reads are denied (added to the built-in secret
  // deny-list). Expanded at load.
  extraDenyRead: string[];
  // Extra absolute paths where writes are permitted (added to worktree+scratch).
  extraAllowWrite: string[];
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
  // Whether to sweep uncommitted leftovers into a final commit
  // (`worker.commitLeftovers`). Pi-strict default is false (fail-loud).
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
  // GitHub-integrated inbox mode (issues → tickets bridge). See githubInbox.ts.
  github: GithubConfig;
  // Vulnerability assessment knobs (junco assess flow).
  assess: AssessConfig;
  // Agent execution sandbox (native OS isolation of tool subprocesses).
  sandbox: SandboxConfig;
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
  "timeout_partial",
]);

/** Worker-managed GitHub provenance for a bridged ticket (do not set by hand). */
export interface TicketGithub {
  nwo: string;
  issue: number;
  kind: "pr" | "ask" | "plan";
  /** Repo the operator does not control: reporter is a no-op for this ticket. */
  external: boolean;
}

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
  /** GitHub issue this ticket was bridged from (null = local dispatch). */
  github: TicketGithub | null;
  /** Assessment flavor options (null = regular PR/Q&A flow). `issue` scopes the
   * audit to a single GitHub issue when set by `junco assess owner/repo#N`.
   * The frontmatter also carries `issue_title` (self-documentation for anyone
   * reading the ticket file), but it is intentionally NOT parsed through here:
   * nothing renders it, so there is nothing to keep sanitized (#104). */
  assess: { autoPlan: boolean; issue?: number } | null;
  /** Analysis flavor options (null = regular PR/Q&A flow). */
  analyze: { issue: number; title: string } | null;
  /** Q&A only: directory the session runs in (read-only tools). Null = default. */
  workdir: string | null;
  /** Per-ticket sandbox egress opt-in (frontmatter `network: true`). Null = use
   * the configured [sandbox].network default. Only ever widens this ticket. */
  network: boolean | null;
}

/** Claim-order priority ranking (higher claims first). Shared by runOnce.ts
 * (scheduling) and tui/queueSnapshot.ts (display) — keep this the ONLY definition. */
export const PRIORITY_RANK: Record<Ticket["priority"], number> = { high: 2, normal: 1, low: 0 };

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
  // The whole run's assistant text, all messages concatenated (newline-joined),
  // vs finalText's LAST-message-only (#36). Optional and additive: consumers
  // that only want the summary keep reading finalText; a fenced block emitted
  // BEFORE the closing message (findings/critic-verdict/plan) is recoverable
  // only from here (#67). Undefined when the run produced no assistant text.
  allText?: string;
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
