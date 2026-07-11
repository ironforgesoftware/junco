const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** One editable (or structured/read-only) knob in the config schema, keyed by
 * its dotted path into the parsed (nested, camelCase) `ConfigParsed` shape.
 * `LEVERS` is kept in exact bijection with `ConfigSchema`'s leaves by
 * `tests/configLevers.test.ts` — every schema leaf has exactly one entry
 * here, and every entry's `default` matches the schema's default verbatim. */
export interface Lever {
  path: string;
  type: "boolean" | "number" | "enum" | "string" | "secret" | "structured";
  default: unknown;
  editable: boolean;
  reload: "live" | "restart";
  description: string;
  enumValues?: string[];
  min?: number;
  max?: number;
}

/** Read a dotted path (`"worker.maxConcurrent"`) out of a nested object.
 * Returns `undefined` if any intermediate segment is missing/non-object. */
export function getAtPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]),
      obj,
    );
}

/** Write a dotted path into a nested object, mutating `obj` and creating any
 * missing intermediate objects along the way (overwriting non-object
 * intermediates). */
export function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

/** The full registry of config knobs: one entry per `ConfigSchema` leaf.
 * Kept in bijection with the schema by `tests/configLevers.test.ts` — see
 * that file's `schemaLeaves`/`schemaLeavesWithDefault` walkers for the
 * traversal rules (ZodObject recurses; ZodArray/ZodRecord is a leaf). */
export const LEVERS: Lever[] = [
  {
    path: "vaultRoot",
    type: "string",
    default: undefined,
    editable: true,
    reload: "restart",
    description: "Root directory Junco keeps its ticket queue under.",
  },
  {
    path: "juncoSubdir",
    type: "string",
    default: "Junco",
    editable: true,
    reload: "restart",
    description: "Subdirectory under vaultRoot holding inbox/processing/done/failed.",
  },
  {
    path: "tools",
    type: "structured",
    default: DEFAULT_TOOLS,
    editable: false,
    reload: "live",
    description: "Tool allowlist granted to the coding agent.",
  },

  // --- model.* ---
  {
    path: "model.id",
    type: "string",
    default: "local/my-model",
    editable: true,
    reload: "live",
    description: "Provider-prefixed model id, e.g. openai/gpt-4o-mini.",
  },
  {
    path: "model.modelsJson",
    type: "string",
    default: undefined,
    editable: true,
    reload: "live",
    description:
      "Path to a Pi-style models.json; when set, provider+model load from that file and the inline capability fields are ignored.",
  },
  {
    path: "model.api",
    type: "string",
    default: "openai-completions",
    editable: true,
    reload: "live",
    description: "Pi API style, e.g. openai-completions.",
  },
  {
    path: "model.baseUrl",
    type: "string",
    default: "http://127.0.0.1:1234/v1",
    editable: true,
    reload: "live",
    description: "OpenAI-compatible /v1 endpoint base URL.",
  },
  {
    path: "model.apiKey",
    type: "secret",
    default: "1234",
    editable: true,
    reload: "live",
    description: "API key for the inference endpoint.",
  },
  {
    path: "model.reasoning",
    type: "boolean",
    default: true,
    editable: true,
    reload: "live",
    description: "Whether the model supports reasoning/thinking tokens.",
  },
  {
    path: "model.input",
    type: "structured",
    default: ["text", "image"],
    editable: false,
    reload: "live",
    description: "Accepted input modalities for the model.",
  },
  {
    path: "model.contextWindow",
    type: "number",
    default: 131072,
    editable: true,
    reload: "live",
    description: "Model context window size in tokens.",
  },
  {
    path: "model.maxTokens",
    type: "number",
    default: 49152,
    editable: true,
    reload: "live",
    description: "Max output tokens per model call.",
  },
  {
    path: "model.cost.input",
    type: "number",
    default: 0,
    editable: true,
    reload: "live",
    description: "Cost per input token, for cost tracking/reporting.",
  },
  {
    path: "model.cost.output",
    type: "number",
    default: 0,
    editable: true,
    reload: "live",
    description: "Cost per output token, for cost tracking/reporting.",
  },
  {
    path: "model.cost.cacheRead",
    type: "number",
    default: 0,
    editable: true,
    reload: "live",
    description: "Cost per cache-read token, for cost tracking/reporting.",
  },
  {
    path: "model.cost.cacheWrite",
    type: "number",
    default: 0,
    editable: true,
    reload: "live",
    description: "Cost per cache-write token, for cost tracking/reporting.",
  },
  {
    path: "model.thinkingLevel",
    type: "string",
    default: "medium",
    editable: true,
    reload: "live",
    description: "Worker default reasoning/thinking level.",
  },
  {
    path: "model.compat",
    type: "structured",
    default: {},
    editable: false,
    reload: "live",
    description:
      "Provider compatibility overrides (developer role, reasoning effort, thinking format, etc.), merged over junco's defaults.",
  },

  // --- worker.* ---
  {
    path: "worker.defaultTimeoutMinutes",
    type: "number",
    default: 30,
    min: 1,
    editable: true,
    reload: "live",
    description: "Default per-ticket execution timeout in minutes.",
  },
  {
    path: "worker.pollIntervalSeconds",
    type: "number",
    default: 15,
    min: 1,
    editable: true,
    reload: "live",
    description: "Seconds between inbox polls when idle.",
  },
  {
    path: "worker.startupPollSeconds",
    type: "number",
    default: 30,
    min: 1,
    editable: true,
    reload: "live",
    description: "Seconds the daemon waits/polls at startup before normal polling begins.",
  },
  {
    path: "worker.startupWait",
    type: "boolean",
    default: true,
    editable: true,
    reload: "live",
    description: "Whether the daemon waits at startup for crash-recovery grace before claiming.",
  },
  {
    path: "worker.maxTransientRetries",
    type: "number",
    default: 2,
    min: 0,
    editable: true,
    reload: "live",
    description: "Max retries for transient failures before a ticket is marked failed.",
  },
  {
    path: "worker.retryBackoffSeconds",
    type: "number",
    default: 60,
    min: 0,
    editable: true,
    reload: "live",
    description: "Backoff seconds before a requeued ticket becomes eligible again.",
  },
  {
    path: "worker.maxConcurrent",
    type: "number",
    default: 1,
    min: 1,
    editable: true,
    reload: "restart",
    description:
      "Parallel ticket slots; same-repo tickets always serialize (restart to apply — the serial-vs-scheduler mode fork is chosen once at startup).",
  },
  {
    path: "worker.commitLeftovers",
    type: "boolean",
    default: false,
    editable: true,
    reload: "live",
    description: "Sweep uncommitted leftovers into a final commit at run end.",
  },

  // --- supervisor.* ---
  {
    path: "supervisor.enabled",
    type: "boolean",
    default: true,
    editable: true,
    reload: "live",
    description: "Enable the supervisor (nudge/escalate/kill loop-guard).",
  },
  {
    path: "supervisor.budgetPerKind",
    type: "number",
    default: 1,
    editable: true,
    reload: "live",
    description: "Budget of guard interventions allowed per kind before escalation.",
  },
  {
    path: "supervisor.escalationWindowTurns",
    type: "number",
    default: 3,
    editable: true,
    reload: "live",
    description: "Turn window over which supervisor escalation is evaluated.",
  },
  {
    path: "supervisor.outputBudgetPerTurn",
    type: "number",
    default: 12000,
    editable: true,
    reload: "live",
    description: "Max output budget per turn before the supervisor nudges.",
  },
  {
    path: "supervisor.outputBudgetPostCommit",
    type: "number",
    default: 24000,
    editable: true,
    reload: "live",
    description: "Max output budget per turn once a commit has landed.",
  },

  // --- git.* ---
  {
    path: "git.gitBin",
    type: "string",
    default: "git",
    editable: true,
    reload: "live",
    description: "Path/name of the git binary to invoke.",
  },
  {
    path: "git.ghBin",
    type: "string",
    default: "gh",
    editable: true,
    reload: "live",
    description: "Path/name of the GitHub CLI (gh) binary to invoke.",
  },
  {
    path: "git.defaultBaseBranch",
    type: "string",
    default: "main",
    editable: true,
    reload: "live",
    description: "Default base branch PRs are opened against.",
  },
  {
    path: "git.branchPrefix",
    type: "string",
    default: "junco/",
    editable: true,
    reload: "live",
    description: "Prefix applied to branches Junco creates.",
  },
  {
    path: "git.worktreeRoot",
    type: "string",
    default: "~/junco/worktrees",
    editable: true,
    reload: "live",
    description: "Root directory under which per-ticket git worktrees are created.",
  },
  {
    path: "git.removeWorktreeOnSuccess",
    type: "boolean",
    default: true,
    editable: true,
    reload: "live",
    description: "Remove the git worktree after a successful run.",
  },
  {
    path: "git.allowedRepoRoots",
    type: "structured",
    default: [],
    editable: false,
    reload: "live",
    description:
      "Containment rail: when non-empty, PR-flow tickets may only target repos under these roots ([] = anywhere).",
  },

  // --- pr.* ---
  {
    path: "pr.draftByDefault",
    type: "boolean",
    default: true,
    editable: true,
    reload: "live",
    description: "Open PRs as drafts by default.",
  },
  {
    path: "pr.defaultLabels",
    type: "structured",
    default: [],
    editable: false,
    reload: "live",
    description: "Labels applied to every PR Junco opens.",
  },

  // --- verify.* ---
  {
    path: "verify.enabled",
    type: "boolean",
    default: true,
    editable: true,
    reload: "live",
    description: "Run the verify (build/test) phase before opening a PR.",
  },
  {
    path: "verify.commandTimeout",
    type: "number",
    default: 60,
    min: 1,
    editable: true,
    reload: "live",
    description: "Timeout in seconds for the verify command.",
  },
  {
    path: "verify.blockOnFail",
    type: "boolean",
    default: false,
    editable: true,
    reload: "live",
    description: "Block PR creation when verify fails (vs. warn and continue).",
  },

  // --- sandbox.* ---
  {
    path: "sandbox.enabled",
    type: "boolean",
    default: false,
    editable: true,
    reload: "live",
    description: "Wrap agent tool subprocesses in an OS sandbox (env scrub + path jail).",
  },
  {
    path: "sandbox.backend",
    type: "enum",
    enumValues: ["auto", "seatbelt", "bwrap", "none"],
    default: "auto",
    editable: true,
    reload: "live",
    description:
      "Sandbox backend: auto (seatbelt on macOS, bwrap on Linux), a forced one, or none.",
  },
  {
    path: "sandbox.network",
    type: "enum",
    enumValues: ["deny", "allow"],
    default: "deny",
    editable: true,
    reload: "live",
    description:
      "Default network egress for agent tool subprocesses (per-ticket network:true widens it).",
  },
  {
    path: "sandbox.extraDenyRead",
    type: "structured",
    default: [],
    editable: false,
    reload: "live",
    description:
      "Extra absolute paths whose reads are denied (added to the built-in secret deny-list).",
  },
  {
    path: "sandbox.extraAllowWrite",
    type: "structured",
    default: [],
    editable: false,
    reload: "live",
    description: "Extra absolute paths where writes are permitted (added to worktree + scratch).",
  },

  // --- critic.* ---
  {
    path: "critic.enabled",
    type: "boolean",
    default: true,
    editable: true,
    reload: "live",
    description: "Run the post-session critic review pass before finalizing a PR.",
  },
  {
    path: "critic.maxRetries",
    type: "number",
    default: 1,
    editable: true,
    reload: "live",
    description: "Max critic-requested revision retries.",
  },
  {
    path: "critic.thinking",
    type: "string",
    default: "minimal",
    editable: true,
    reload: "live",
    description: "Thinking level used for critic review calls.",
  },

  // --- planLint.* ---
  {
    path: "planLint.enabled",
    type: "boolean",
    default: true,
    editable: true,
    reload: "live",
    description: "Run plan-lint checks on ticket plans before execution.",
  },
  {
    path: "planLint.blockOnError",
    type: "boolean",
    default: true,
    editable: true,
    reload: "live",
    description: "Block execution when plan-lint finds errors (vs. warn).",
  },
  {
    path: "planLint.checkLabels",
    type: "boolean",
    default: true,
    editable: true,
    reload: "live",
    description: "Include label checks in plan-lint.",
  },

  // --- observability.* ---
  {
    path: "observability.healthEnabled",
    type: "boolean",
    default: true,
    editable: true,
    reload: "restart",
    description: "Enable the /health metrics HTTP server.",
  },
  {
    path: "observability.healthHost",
    type: "string",
    default: "127.0.0.1",
    editable: true,
    reload: "restart",
    description: "Bind address for /health; non-loopback exposes metrics (restart to rebind).",
  },
  {
    path: "observability.healthPort",
    type: "number",
    default: 8787,
    min: 1,
    max: 65535,
    editable: true,
    reload: "restart",
    description: "Port the /health metrics server binds (restart to rebind).",
  },
  {
    path: "observability.logLevel",
    type: "enum",
    enumValues: ["debug", "info", "warn", "error"],
    default: "info",
    editable: true,
    reload: "live",
    description: "Daemon-wide log threshold (applied live).",
  },
  {
    path: "observability.stateDir",
    type: "string",
    default: "~/.local/state/junco",
    editable: true,
    reload: "restart",
    description: "Directory for daemon-owned state (worker.log, per-ticket transcripts).",
  },
  {
    path: "observability.logToFile",
    type: "boolean",
    default: true,
    editable: true,
    reload: "restart",
    description: "Write daemon logs to a file under stateDir.",
  },
  {
    path: "observability.transcripts",
    type: "boolean",
    default: true,
    editable: true,
    reload: "restart",
    description: "Write per-ticket event transcripts under stateDir.",
  },

  // --- github.* ---
  {
    path: "github.enabled",
    type: "boolean",
    default: false,
    editable: true,
    reload: "restart",
    description: "Enable the GitHub issues→inbox bridge (disabled by default: zero gh calls).",
  },
  {
    path: "github.triggerLabel",
    type: "string",
    default: "junco",
    editable: true,
    reload: "restart",
    description:
      "Approval label that triggers the PR flow; lifecycle labels derive from it. Restart to apply — the reporter bakes in the label prefix at startup.",
  },
  {
    path: "github.askLabel",
    type: "string",
    default: undefined,
    editable: true,
    reload: "restart",
    description:
      "Issue label that routes to the read-only Q&A path (defaults to `<triggerLabel>:ask`). Restart to apply (see triggerLabel).",
  },
  {
    path: "github.pollIntervalSeconds",
    type: "number",
    default: 60,
    min: 5,
    editable: true,
    reload: "live",
    description: "GitHub bridge sweep cadence, independent of the worker poll interval.",
  },
  {
    path: "github.requireApproval",
    type: "boolean",
    default: true,
    editable: true,
    reload: "live",
    description: "When false, a plan-ready GitHub ticket auto-executes on the next sweep.",
  },
  {
    path: "github.plannerModelId",
    type: "string",
    default: undefined,
    editable: true,
    reload: "live",
    description: "Planning-session model id override for GitHub tickets (same endpoint).",
  },
  {
    path: "github.externalReposRoot",
    type: "string",
    default: undefined,
    editable: true,
    reload: "live",
    description: "Root directory for managed clones of unowned repos (fork-PR flow).",
  },
  {
    path: "github.repos",
    type: "structured",
    default: [],
    editable: false,
    reload: "live",
    description: "Explicit list of watched GitHub repos (owner/repo name-with-owner + local path).",
  },

  // --- assess.* ---
  {
    path: "assess.maxIssuesPerRun",
    type: "number",
    default: 20,
    min: 1,
    editable: true,
    reload: "live",
    description: "Cap on issues filed per `junco assess` run.",
  },
  {
    path: "assess.minSeverity",
    type: "enum",
    enumValues: ["critical", "high", "medium", "low"],
    default: "low",
    editable: true,
    reload: "live",
    description: "Drop assessment findings below this severity.",
  },
  {
    path: "assess.npmBin",
    type: "string",
    default: "npm",
    editable: true,
    reload: "live",
    description: "Binary for the dependency scan (npm audit --json).",
  },
];

/** Look up a single lever by its dotted path. */
export function leverAtPath(path: string): Lever | undefined {
  return LEVERS.find((l) => l.path === path);
}

/** Coerce a raw CLI/TUI string into the value a lever's type expects,
 * validating booleans/numbers/enums along the way. Shared by the `junco
 * config set` CLI (src/configCmd.ts) and the TUI editor view. Structured
 * levers always fail here — callers must reject them via `lever.editable`
 * before ever reaching `coerceLever` (this is the fallback message). */
export function coerceLever(lever: Lever, raw: string): { value: unknown } | { error: string } {
  switch (lever.type) {
    case "boolean":
      if (raw === "true") return { value: true };
      if (raw === "false") return { value: false };
      return { error: "expected true|false" };
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: "expected a number" };
      if (lever.min !== undefined && n < lever.min) return { error: `must be >= ${lever.min}` };
      if (lever.max !== undefined && n > lever.max) return { error: `must be <= ${lever.max}` };
      return { value: n };
    }
    case "enum":
      if (!lever.enumValues?.includes(raw))
        return { error: `expected one of ${lever.enumValues?.join("|")}` };
      return { value: raw };
    case "string":
    case "secret":
      return { value: raw };
    default:
      return { error: "structured — edit config.json directly" };
  }
}
