export interface OmlxConfig { url: string; apiKey: string; }
export interface Config {
  vaultRoot: string;
  juncoSubdir: string;
  omlx: OmlxConfig;
  modelId: string;
  tools: string[];
  defaultTimeoutMinutes: number;
  pollIntervalSeconds: number;
  startupPollSeconds: number;
  startupWait: boolean;
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
}
export interface Paths { inbox: string; processing: string; done: string; failed: string; }

export interface Ticket {
  path: string;
  id: string;
  priority: "low" | "normal" | "high";
  timeoutSeconds: number;
  body: string;
  frontmatter: Record<string, unknown>;
  hasRepo: boolean;
}

export interface ToolCall { name: string; args: unknown; }
export interface Usage { input: number; output: number; cacheRead: number; total: number; }
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
