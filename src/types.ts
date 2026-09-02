/**
 * The repo's one "worked, or here's why it didn't" shape (#359). `T` is the
 * success payload; a failure is always a single human-readable `error`
 * string, so callers never have to remember whether this module spells it
 * `reason` or `error`. `F` adds machine-readable context alongside that
 * message (applyPatch's `refused`). A failure whose payload is itself
 * structured — planCompiler's `errors[]`, unwatchCmd's refusal enum — stays a
 * distinct type on purpose and must not be squeezed in here.
 */
export type Result<T, F = unknown> = { ok: true; value: T } | ({ ok: false; error: string } & F);

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
/** SDK auto-retry knobs passed to SettingsManager.inMemory; null = SDK default. */
export interface ModelRetryConfig {
  maxRetries: number | null;
  baseDelayMs: number | null;
}
/** The model + inference provider junco drives Pi against. Resolved by
 * `loadConfig` from the `model` section of config.json. When `modelsJson`
 * points at an existing Pi-style models.json the provider+model are loaded
 * from THAT file and the inline capability fields are ignored. */
export interface ModelConfig {
  id: string; // provider-prefixed, e.g. "openai/gpt-4o-mini"
  source: "auto" | "catalog" | "inline"; // resolution mode; auto = catalog for non-local providers without an explicit baseUrl
  modelsJson: string | null; // path to a Pi models.json, or null for inline
  api: string; // Pi Api style, e.g. "openai-completions"
  baseUrl: string; // OpenAI-compatible endpoint (inline path; local default when unset)
  baseUrlExplicit: boolean; // true iff base_url was present in the config file
  apiKey: string | null; // null = defer to the provider's env var at request time
  retry: ModelRetryConfig;
  reasoning: boolean;
  input: string[]; // e.g. ["text", "image"]
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
  thinkingLevel: string; // worker default thinking level
  // Effort-name translation the SDK applies per request (model-spec field, not
  // compat): junco level → the chat template's effort vocabulary. Replaced
  // wholesale by a config override, never merged.
  thinkingLevelMap: Record<string, string>;
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
/** [assess] — knobs for `junco audit` runs (vulnerability audit → GitHub issues). */
export interface AssessConfig {
  maxIssuesPerRun: number; // cap on issues filed per assessment run
  minSeverity: "critical" | "high" | "medium" | "low"; // findings below this are dropped
  npmBin: string; // binary for the dependency scan (`npm audit --json`)
  fileAs: "me" | "bot"; // identity `junco audit file` posts under ("bot" = the dedicated bot account; fails loud when its login is missing)
}
/** Skill-link distribution (spec 2026-08-19): harness skills dirs that get a
 * junco-dispatch symlink via <dataDir>/skills. Presence in this list is the
 * operator's standing consent — junco never writes to a dir not listed. */
export interface SkillsConfig {
  harnessDirs: string[];
}
/** [botAccount] — dedicated machine-account identity for daemon GitHub traffic. */
export interface BotAccountConfig {
  enabled: boolean; // false = today's ambient-gh-auth behavior
  configDir: string; // isolated GH_CONFIG_DIR holding the bot login (expanded)
}
/** [planSets] — plan-driven ticket sets (spec 2026-08-20). `enabled` gates plan
 * COMPILATION: whether a `junco-plan` fence is compiled into a dependency-
 * ordered ticket set — the doors are the bridge (dispatchPlanSet, an approved
 * plan comment) and the local CLI (`junco submit --plan`). The Layer-1
 * dependency machinery (depends_on claim gating, merge sweep, cascade) is
 * always on and activates lazily per edge, independent of this flag.
 * `maxTasks` is the compiler's per-plan task cap. */
export interface PlanSetsConfig {
  enabled: boolean;
  mergePollSeconds: number;
  maxTasks: number;
}
/** Runtime-resolved bot auth context (src/ghAuth.ts) — attached to Config by
 * entrypoints, never parsed from config.json. Carried by cfg into git()/gh()
 * so child processes authenticate as the bot. */
export interface GhAuthContext {
  configDir: string; // GH_CONFIG_DIR for child gh/git processes
  login: string; // bot account login
  email: string; // <id>+<login>@users.noreply.github.com
  credentialHelper: string; // "!<ghBin> auth git-credential" (inherits child env)
}
/** Which deprecated (legacy) path keys are explicitly set in config.json —
 * drives `configDeprecations` warnings and per-subtree override provenance
 * (spec 2026-07-16). */
export interface LegacyPathFlags {
  vaultRoot: boolean;
  stateDir: boolean;
  worktreeRoot: boolean;
  externalReposRoot: boolean;
  /** True when dataDir resolved to the pre-0.10 `~/.local/state/junco` root
   * via probe-based fallback (not an explicit dataDir/stateDir override) —
   * drives the `junco data migrate` deprecation hint. */
  dataRoot: boolean;
  /** True when botAccount.configDir resolved to the pre-0.10
   * `~/.config/junco/gh` root via hosts.yml liveness fallback (not an
   * explicit override) — drives the `junco data migrate` deprecation hint. */
  ghConfigDir: boolean;
}
export interface SandboxConfig {
  // Master switch. false = current behavior (no sandbox, full env, no jail).
  enabled: boolean;
  // auto → seatbelt on darwin, bwrap on linux. none = no OS wrapping (env
  // scrub + JS path-jail still apply; bash keeps network + can read anywhere).
  backend: "auto" | "seatbelt" | "bwrap" | "none";
  // Under "auto", fail closed when the OS backend probe fails instead of
  // degrading to none (#344). Inert for an explicit backend (already
  // fail-closed) and for none.
  requireBackend: boolean;
  // Default egress for agent tool subprocesses. Per-ticket `network: true`
  // frontmatter overrides to allow for one ticket.
  network: "deny" | "allow";
  // Extra absolute paths whose reads are denied (added to the built-in secret
  // deny-list). Expanded at load.
  extraDenyRead: string[];
  // Extra absolute paths where writes are permitted (added to worktree+scratch).
  extraAllowWrite: string[];
  // Ceiling in seconds on one sandboxed bash call when the agent passes no
  // timeout; 0 = no ceiling. The agent's explicit timeout always wins.
  // Max 2147483 (Node's setTimeout ceiling in seconds).
  bashTimeoutSeconds: number;
}
export interface Config {
  /** Unified data root (spec 2026-07-16). Every junco path resolves under here
   * unless a legacy key overrides its subtree. */
  dataDir: string;
  /** Which internal shape `dataDir` uses (single-root ~/.junco consolidation).
   * "v2": data/, cache/, logs/ substructure (queue/review/watchlist stay at
   * the root). "flat": the pre-0.10 shape, byte-identical forever — a
   * pre-existing tree keeps it until `junco data migrate` relocates it. See
   * `layoutOf`/`LAYOUTS` (dataTree.ts). */
  dataLayout: "flat" | "v2";
  /** Resolved queue root: <vaultRoot>/<juncoSubdir> when legacy, else <dataDir>/queue. */
  queueRoot: string;
  /** npm update-check opt-out (default true). Optional so test fixtures that
   * build full Config literals keep compiling; loaders always set it. */
  updateCheck?: boolean;
  /** Which deprecated path keys are explicitly set (drives warnings + provenance). */
  legacy: LegacyPathFlags;
  model: ModelConfig;
  tools: string[];
  defaultTimeoutMinutes: number;
  pollIntervalSeconds: number;
  startupPollSeconds: number;
  startupWait: boolean;
  // Endpoint reachability probe policy (worker.endpointProbe): auto defers to
  // shouldProbeEndpoint (probe local/inline, skip hosted catalog); always/never
  // override that rule outright. See probePolicy() in health.ts.
  endpointProbe: "auto" | "always" | "never";
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
  // #335: run `## Verification` blocks under the ticket's sandbox backend +
  // policy (the blocks execute whatever the agent left in the worktree).
  // false = the direct, unconfined spawn.
  verifySandboxed: boolean;
  // Plan-lint gate (parity with the Python [plan_lint] section).
  planLintEnabled: boolean;
  planLintBlockOnError: boolean;
  planLintCheckLabels: boolean;
  // Whether to sweep uncommitted leftovers into a final commit
  // (`worker.commitLeftovers`). Pi-strict default is false (fail-loud).
  commitLeftoversEnabled: boolean;
  // Escalation ladder Stage 2a (apply-tickets-design.md, `worker.applyFallbackToAgent`):
  // when a patch-ticket's junco-patch series fails to apply, fall back to the
  // agent — using the patch as spec — instead of failing the ticket
  // terminally. Default true; buildPrBody's disclosure banner covers the
  // approval-semantics gap this creates (the PR is no longer byte-identical
  // to what a human approved on the GitHub route).
  applyFallbackToAgent: boolean;
  // Daily USD spend cap (`worker.dailyBudgetUsd`); 0 = off, spend ledger never
  // consulted. See providerGate.ts's budget_exhausted state.
  dailyBudgetUsd: number;
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
  logToFile: boolean;
  transcriptsEnabled: boolean;
  // GitHub-integrated inbox mode (issues → tickets bridge). See githubInbox.ts.
  github: GithubConfig;
  // Vulnerability assessment knobs (junco assess flow).
  assess: AssessConfig;
  // Skill-link distribution (junco skill install / ensureSkillLinks).
  skills: SkillsConfig;
  // Agent execution sandbox (native OS isolation of tool subprocesses).
  sandbox: SandboxConfig;
  // Dedicated bot identity for daemon GitHub traffic (spec 2026-07-15).
  botAccount: BotAccountConfig;
  // Plan-driven ticket sets (spec 2026-08-20).
  planSets: PlanSetsConfig;
  // Resolved at entrypoints when botAccount.enabled — NOT part of config.json.
  ghAuth?: GhAuthContext;
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
  /** Dispatcher-authored request block (`github_request:`). Trusted local
   * dispatchers may ask the worker to create a tracking issue at claim time;
   * the worker fulfills it and stamps `github:` provenance itself, keeping
   * that block worker-managed (githubIssueRequest.ts). Null = no request. */
  githubRequest: { createIssue: boolean } | null;
  /** Assessment flavor options (null = regular PR/Q&A flow), normalized from
   * either the canonical `audit:` frontmatter key or the permanently accepted
   * legacy `assess:` key (parseTicket picks `audit:` when both are present).
   * `issue` scopes the audit to a single GitHub issue when set by
   * `junco audit owner/repo#N` (or the legacy `junco assess owner/repo#N`).
   * The frontmatter also carries `issue_title` (self-documentation for anyone
   * reading the ticket file), but it is intentionally NOT parsed through here:
   * nothing renders it, so there is nothing to keep sanitized (#104). */
  assess: { autoPlan: boolean; issue?: number } | null;
  /** Analysis flavor options (null = regular PR/Q&A flow), normalized from
   * either the canonical `investigate:` frontmatter key or the permanently
   * accepted legacy `analyze:` key (parseTicket picks `investigate:` when
   * both are present). */
  analyze: { issue: number; title: string } | null;
  /** Q&A only: directory the session runs in (read-only tools). Null = default. */
  workdir: string | null;
  /** Per-ticket sandbox egress opt-in (frontmatter `network: true`). Null = use
   * the configured `sandbox.network` default. Only ever widens this ticket. */
  network: boolean | null;
  /** Ticket ids that must be satisfied before claim (spec 2026-08-20): the dep
   * ticket done AND (when it opened a PR) that PR merged. Dispatcher-settable. */
  dependsOn: string[];
  /** Worker-managed: edges the dependency sweep (ticketDeps.ts) has confirmed
   * satisfied. Claim gates on depends_on ⊆ deps_satisfied — a pure subset check. */
  depsSatisfied: string[];
  /** Plan-set membership/provenance (spec 2026-08-20). Null = not part of a set. */
  plan: { id: string; task: string | null; hash: string | null } | null;
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
  /** Summed USD across every turn (pi-ai `Usage.cost.total`, computed by
   * `calculateCost` in models.js from the model's rate card — pi-ai
   * `types.d.ts:248-269`). 0 when the provider/fake reports no cost. */
  costUsd: number;
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
