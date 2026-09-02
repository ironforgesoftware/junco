/**
 * transcriptSchema — v2 junco record types + the line parser that reads
 * back per-ticket JSONL transcripts (`<dataDir>/data/transcripts/<id>.jsonl`).
 *
 * Pure by design: no fs, no Pi SDK — only type-only imports (`Usage` from
 * `../types.js`, `GuardManagerOptions` from `./guardManager.js`) so this
 * module stays trivially unit-testable and safe to import from anywhere,
 * including replay tooling that never touches a live agent session.
 */
import type { Usage } from "../types.js";
import type { GuardManagerOptions } from "./guardManager.js";
import type { ProviderFailureClass } from "../providerFailure.js";

export const TRANSCRIPT_VERSION = 2;

export type FlowKind =
  | "qa"
  | "plan"
  | "pr"
  | "pr_corrective"
  | "pr_apply_fallback"
  | "apply"
  | "assess"
  | "analyze"
  | "chat";

export interface MetaRecord {
  type: "junco_meta";
  version: number;
  ticketId: string;
  createdAt: string;
}

export interface RunStartRecord {
  type: "junco_run_start";
  flow: FlowKind;
  body: string;
  cwd: string;
  modelId: string;
  tools: string[];
  timeoutMs: number;
  guard: { enabled: boolean } & GuardManagerOptions;
  ts: string;
}

export interface RunEndRecord {
  type: "junco_run_end";
  errorMessage: string | null;
  stopReason: string | null;
  timedOut: boolean;
  abortedByGuard: boolean;
  usage: Usage;
  durationMs: number;
  ts: string;
}

export interface GuardDecisionRecord {
  type: "junco_guard_decision";
  kind: string;
  action: "nudge" | "kill";
  detail: string;
  turnIndex: number;
  nudgeMessage?: string;
  reason?: string;
  ts: string;
}

// ---------------------------------------------------------------------------
// Chat records (spec 2026-09-01 §1.3). A chat transcript opens with the same
// junco_meta (ticketId = the session slug); turns are framed by
// junco_chat_turn_start/_end/_aborted the way runs are by junco_run_start/_end.
// ---------------------------------------------------------------------------

export type DraftKind =
  | "ticket"
  | "amend"
  | "apply"
  | "audit"
  | "investigate"
  | "ticketSet"
  | "planSet";

export interface ChatPromptRecord {
  type: "junco_chat_prompt";
  text: string;
  /** steer = arrived while a turn was streaming (SDK steer()). */
  mode: "prompt" | "steer";
  /** auto_lint = the one automatic lint follow-up (spec §6.3). */
  source: "operator" | "auto_lint";
  ts: string;
}
export interface ChatTurnStartRecord {
  type: "junco_chat_turn_start";
  modelId: string;
  tools: string[];
  timeoutMs: number;
  ts: string;
}
export interface ChatTurnEndRecord {
  type: "junco_chat_turn_end";
  status: "ok" | "error";
  errorClass: ProviderFailureClass | null;
  errorMessage: string | null;
  usage: Usage;
  durationMs: number;
  ts: string;
}
export interface ChatTurnAbortedRecord {
  type: "junco_chat_turn_aborted";
  reason: "timeout" | "operator" | "daemon_stopped" | "crash";
  ts: string;
}
export interface ChatTurnRejectedRecord {
  type: "junco_chat_turn_rejected";
  /** gate.status().reason or the budget line. */
  reason: string;
  /** ISO, from GateStatus.until; null for latches. */
  until: string | null;
  ts: string;
}
export interface ChatDraftRecord {
  type: "junco_chat_draft";
  draftId: string;
  kind: DraftKind;
  status: "parked" | "lint_failed" | "submitted" | "discarded";
  /** Ticket ids / audit-investigate ids once known. */
  ids: string[];
  /** null until submitted; "command" for audit/investigate. */
  destination: "inbox" | "issue" | "command" | null;
  ts: string;
}
export interface ChatSessionResetRecord {
  type: "junco_chat_session_reset";
  reason: "corrupt" | "missing" | "operator_new";
  ts: string;
}
export interface ChatTranscriptDegradedRecord {
  type: "junco_chat_transcript_degraded";
  ts: string;
}
export type ChatRecord =
  | ChatPromptRecord
  | ChatTurnStartRecord
  | ChatTurnEndRecord
  | ChatTurnAbortedRecord
  | ChatTurnRejectedRecord
  | ChatDraftRecord
  | ChatSessionResetRecord
  | ChatTranscriptDegradedRecord;

export type JuncoRecord =
  | MetaRecord
  | RunStartRecord
  | RunEndRecord
  | GuardDecisionRecord
  | ChatRecord;

export type ParsedLine =
  | { kind: "junco"; record: JuncoRecord }
  | { kind: "sdk"; event: Record<string, unknown> }
  | { kind: "invalid"; raw: string };

/**
 * Classifies one JSONL transcript line without throwing.
 *
 * - Malformed JSON or a non-object top level → `invalid` (a truncated line
 *   from a crash mid-write, per the replay harness's tolerance requirement).
 * - `type` starts with `junco_` → `junco`, cast to `JuncoRecord` regardless
 *   of whether `type` matches a known variant: consumers switch on
 *   `.type` and default-ignore unknowns, so an older junco reading a
 *   newer transcript (a `junco_*` type it doesn't recognize yet) never
 *   throws — forward compat over exhaustiveness.
 * - Anything else → `sdk`, the passthrough for Pi SDK events.
 */
export function parseTranscriptLine(line: string): ParsedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "invalid", raw: line };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", raw: line };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type === "string" && obj.type.startsWith("junco_")) {
    return { kind: "junco", record: obj as unknown as JuncoRecord };
  }
  return { kind: "sdk", event: obj };
}
