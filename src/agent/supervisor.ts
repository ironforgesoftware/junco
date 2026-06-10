/**
 * Supervisor — junco's runtime decision engine for guard trips.
 *
 * Ported from supervisor.py. Decision policy is EXACT — do not reorder steps.
 *
 * Pure logic: no I/O, no SDK imports.
 */

import { buildNudgeForGuardEvent } from "./nudges.js";

export type GuardKind =
  | "tool_call_loop"
  | "tool_error_loop"
  | "text_rep"
  | "thinking_rep"
  | "output_budget";

export type ActionKind = "continue" | "nudge" | "kill";

/** The tripped guard exposes these for the nudge builder. */
export interface TrippedGuardInfo {
  lastName: string | null;
  lastCount: number;
}

export interface GuardEvent {
  kind: GuardKind;
  detail: string;
  trippedGuard: TrippedGuardInfo;
  /** The agent turn during which this trip happened (junco-side counter). */
  turnIndex: number;
}

export interface Action {
  kind: ActionKind;
  nudgeMessage?: string;
  reason: string;
}

export interface SupervisorConfig {
  /** Per guard-kind, how many nudges before escalating to kill. Default 1. */
  budgetPerKind: number;
  /**
   * If the SAME guard kind re-trips within this many turns of a nudge,
   * kill immediately (the nudge was ignored — escalate). Default 3.
   */
  escalationWindowTurns: number;
}

interface NudgeRecord {
  kind: GuardKind;
  turnIndex: number;
}

const DEFAULT_CONFIG: SupervisorConfig = {
  budgetPerKind: 1,
  escalationWindowTurns: 3,
};

/**
 * Stateful decision engine. Construct one per agent session.
 *
 * State tracked:
 *   - nudgesUsed[kind] — how many nudges issued for this kind.
 *   - _recentNudges — list of {kind, turnIndex} for escalation window check.
 */
export class Supervisor {
  private readonly cfg: SupervisorConfig;
  readonly nudgesUsed: Map<string, number>;
  private readonly _recentNudges: NudgeRecord[];

  constructor(cfg?: Partial<SupervisorConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.nudgesUsed = new Map();
    this._recentNudges = [];
  }

  /**
   * Decide what to do about a guard trip.
   *
   * Policy (mirrors supervisor.py exactly):
   *   1. Drop recent-nudge records with turnIndex <= evt.turnIndex - escalationWindowTurns.
   *   2. If any remaining recentNudge has kind === evt.kind → KILL (nudge ignored).
   *   3. Else if nudgesUsed[kind] >= budgetPerKind → KILL (budget exhausted).
   *   4. Else → NUDGE (record it, build message, return).
   */
  decide(evt: GuardEvent): Action {
    const { budgetPerKind, escalationWindowTurns } = this.cfg;

    // Step 1: Clean up records outside the escalation window.
    const cutoff = evt.turnIndex - escalationWindowTurns;
    // Keep only records with turnIndex > cutoff (mirrors Python: r.turn_index > cutoff)
    let i = this._recentNudges.length;
    while (i--) {
      if (this._recentNudges[i].turnIndex <= cutoff) {
        this._recentNudges.splice(i, 1);
      }
    }

    // Step 2: same-kind re-trip after recent nudge → escalate.
    for (const record of this._recentNudges) {
      if (record.kind === evt.kind) {
        return {
          kind: "kill",
          reason:
            `nudge ignored — ${evt.kind} re-tripped within ` +
            `${escalationWindowTurns} turns of prior nudge ` +
            `(at turn ${record.turnIndex}, now turn ${evt.turnIndex})`,
        };
      }
    }

    // Step 3: budget exhausted for this kind → kill.
    const priorNudges = this.nudgesUsed.get(evt.kind) ?? 0;
    if (priorNudges >= budgetPerKind) {
      return {
        kind: "kill",
        reason: `nudge budget exhausted for ${evt.kind} (${priorNudges}/${budgetPerKind})`,
      };
    }

    // Step 4: nudge.
    const msg = buildNudgeForGuardEvent(evt);
    this.nudgesUsed.set(evt.kind, priorNudges + 1);
    this._recentNudges.push({ kind: evt.kind, turnIndex: evt.turnIndex });
    return {
      kind: "nudge",
      nudgeMessage: msg,
      reason: `recovery attempt ${priorNudges + 1}/${budgetPerKind} for ${evt.kind}`,
    };
  }

  /** Total nudges issued across all kinds. */
  get totalNudges(): number {
    let total = 0;
    for (const v of this.nudgesUsed.values()) total += v;
    return total;
  }

  /** Human-readable summary of nudges issued. */
  get summary(): string {
    if (this.nudgesUsed.size === 0) return "no nudges issued";
    const parts: string[] = [];
    for (const [k, v] of this.nudgesUsed.entries()) {
      parts.push(`${k}=${v}`);
    }
    return "nudges: " + parts.join(", ");
  }
}
