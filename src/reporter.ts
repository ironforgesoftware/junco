/**
 * TicketReporter — lifecycle feedback seam for dispatch surfaces (GitHub
 * bridge, future forges). executeClaimed is the ONLY call site; the default
 * is a no-op so local mode carries zero overhead. Implementations must be
 * best-effort: never throw, never fail a ticket (executeClaimed guards with
 * .catch anyway, belt-and-suspenders).
 */

import type { Ticket, RunResult } from "./types.js";
import type { PrFlowResult } from "./prFlow.js";

export interface TicketOutcome {
  kind: "pr" | "qa";
  status: string;
  prUrl: string | null;
  finalText: string;
  failureReason: string | null;
  /** PR endgame parked in the outbox; the composite op owns the finalize
   * comment + label flip. */
  prQueued?: boolean;
}

export interface TicketReporter {
  /** Ticket entered execution (claimed → running). */
  onStart(ticket: Ticket): Promise<void>;
  /** Ticket went back to the inbox (transient-failure requeue). */
  onRequeue(ticket: Ticket): Promise<void>;
  /** Ticket reached a terminal state (done/ or failed/). */
  onFinal(ticket: Ticket, outcome: TicketOutcome): Promise<void>;
}

export const NOOP_REPORTER: TicketReporter = {
  onStart: () => Promise.resolve(),
  onRequeue: () => Promise.resolve(),
  onFinal: () => Promise.resolve(),
};

export function outcomeFromPrFlow(flow: PrFlowResult): TicketOutcome {
  return {
    kind: "pr",
    status: flow.status,
    prUrl: flow.prUrl,
    finalText: flow.finalText,
    failureReason: flow.phaseError,
    prQueued: flow.prQueued ?? false,
  };
}

export function outcomeFromQa(status: string, result: RunResult): TicketOutcome {
  return {
    kind: "qa",
    status,
    prUrl: null,
    finalText: result.finalText,
    failureReason: result.errorMessage,
  };
}
