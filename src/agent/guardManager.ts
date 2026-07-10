/**
 * GuardManager — the testable core that reduces an agent event stream to
 * supervisor decisions (nudge or kill).
 *
 * Ported from worker.py `_run_task_supervised` (the event→guard wiring) and
 * kept SDK-free: it owns the pure guard/supervisor classes and per-turn state,
 * and exposes a single `observe(event)` reducer. The thin SDK glue that injects
 * nudges / aborts lives in session.ts.
 *
 * Event shapes are the Pi `AgentSessionEvent` surface (verified against the
 * installed SDK type defs — see session.ts for citations):
 *   - message_update { assistantMessageEvent: { type:"text_delta"|"thinking_delta", delta } }
 *   - tool_execution_start { toolName, args }
 *   - tool_execution_end   { toolName, isError }
 *   - turn_end { message: { usage: { output } } }
 *
 * Divergence from the Python (deliberate, driven by the TS SDK event model):
 *   - The Python RPC path read tool calls and per-message text/thinking out of
 *     `message_end.message.content[]` blocks. The TS SDK emits dedicated
 *     `tool_execution_start`/`tool_execution_end` events and streaming
 *     `text_delta`/`thinking_delta` deltas, so we wire those instead. The guard
 *     classes and decision policy are byte-for-byte the Python logic.
 */

import {
  RepetitionGuard,
  ToolCallLoopGuard,
  ToolErrorLoopGuard,
  OutputBudgetGuard,
} from "./guards.js";
import {
  Supervisor,
  type SupervisorConfig,
  type GuardEvent,
  type GuardKind,
} from "./supervisor.js";

// `detail` and `turnIndex` mirror the underlying GuardEvent so the decision is
// self-describing: session.ts logs and transcribes it verbatim (#37) without
// reaching back into the (pure, SDK-free) guard internals.
export type GuardDecision =
  | { action: "nudge"; message: string; kind: GuardKind; detail: string; turnIndex: number }
  | { action: "kill"; reason: string; kind: GuardKind; detail: string; turnIndex: number };

export interface GuardManagerOptions {
  supervisorConfig?: Partial<SupervisorConfig>;
  /** Per-turn pre-commit output-token budget. Default 12000; 0 disables the guard. */
  outputBudgetPerTurn?: number;
  /** Post-commit output-token budget. Default 24000. */
  outputBudgetPostCommit?: number;
}

const DEFAULT_OUTPUT_BUDGET_PER_TURN = 12000;
const DEFAULT_OUTPUT_BUDGET_POST_COMMIT = 24000;

export class GuardManager {
  private textRepGuard: RepetitionGuard;
  private thinkingRepGuard: RepetitionGuard;
  private toolLoopGuard: ToolCallLoopGuard;
  private toolErrorLoopGuard: ToolErrorLoopGuard;
  private readonly outputBudgetGuard: OutputBudgetGuard | null;
  private readonly supervisor: Supervisor;

  /** junco-side turn counter for the supervisor's escalation window. */
  private turnIndex = 0;

  /**
   * turnIndex at which the last rep nudge of each kind was issued. A rep
   * re-trip at the SAME turnIndex means the steer nudge (delivered only after
   * the turn) was never seen, so it must not be charged as "nudge ignored"
   * (#127). Monotonic turnIndex makes stale entries harmless.
   */
  private readonly repNudgeTurn = new Map<"text_rep" | "thinking_rep", number>();

  /** Per-message cumulative streaming buffers (reset at message/turn boundaries). */
  private textBuf = "";
  private thinkingBuf = "";

  private readonly outputBudgetPerTurn: number;

  constructor(opts: GuardManagerOptions = {}) {
    this.textRepGuard = new RepetitionGuard();
    this.thinkingRepGuard = new RepetitionGuard();
    this.toolLoopGuard = new ToolCallLoopGuard();
    this.toolErrorLoopGuard = new ToolErrorLoopGuard();
    this.outputBudgetPerTurn = opts.outputBudgetPerTurn ?? DEFAULT_OUTPUT_BUDGET_PER_TURN;
    // 0 disables the output-budget guard entirely — keep it null rather than a
    // dead object, so the "disabled" state is structural (no budget can leak
    // back in if a future caller drops the per-turn gate).
    this.outputBudgetGuard =
      this.outputBudgetPerTurn > 0
        ? new OutputBudgetGuard(
            this.outputBudgetPerTurn,
            opts.outputBudgetPostCommit ?? DEFAULT_OUTPUT_BUDGET_POST_COMMIT,
          )
        : null;
    this.supervisor = new Supervisor(opts.supervisorConfig);
  }

  /**
   * Observe one AgentSessionEvent. Returns a decision iff a guard tripped, else
   * null. On a "nudge" decision the caller injects the message; the tripped
   * guard is RE-INSTANTIATED here so it doesn't immediately re-trip on the
   * already-buffered state.
   */
  observe(event: any): GuardDecision | null {
    const type = event?.type;

    switch (type) {
      case "message_start":
      case "turn_start":
        // New assistant message / turn → fresh cumulative buffers (the rep
        // guards key on per-message cumulative text).
        this.textBuf = "";
        this.thinkingBuf = "";
        return null;

      case "message_update":
        return this.onMessageUpdate(event);

      case "tool_execution_start":
        return this.onToolStart(event);

      case "tool_execution_end":
        return this.onToolEnd(event);

      case "turn_end":
        return this.onTurnEnd(event);

      default:
        return null;
    }
  }

  // -- text / thinking repetition -------------------------------------------

  private onMessageUpdate(event: any): GuardDecision | null {
    const ame = event?.assistantMessageEvent;
    const ameType = ame?.type;
    if (ameType === "text_delta") {
      this.textBuf += typeof ame.delta === "string" ? ame.delta : "";
      if (this.textRepGuard.update(this.textBuf)) {
        return this.decideRep("text_rep", this.textRepGuard);
      }
    } else if (ameType === "thinking_delta") {
      this.thinkingBuf += typeof ame.delta === "string" ? ame.delta : "";
      if (this.thinkingRepGuard.update(this.thinkingBuf)) {
        return this.decideRep("thinking_rep", this.thinkingRepGuard);
      }
    }
    return null;
  }

  private decideRep(
    kind: "text_rep" | "thinking_rep",
    guard: RepetitionGuard,
  ): GuardDecision | null {
    // The nudge builder reads trippedGuard.lastName; set it to the kind so the
    // message is keyed correctly (mirrors Python's guard_obj.last_name = kind).
    guard.lastName = kind;
    const evt: GuardEvent = {
      kind,
      detail: `probe=${guard.lastProbe?.length ?? 0}, repeats=${guard.lastCount}`,
      trippedGuard: { lastName: guard.lastName, lastCount: guard.lastCount },
      turnIndex: this.turnIndex,
    };
    // #127: a rep steer nudge is delivered only AFTER the current turn's tool
    // calls, so a re-trip at the SAME turnIndex as its nudge cannot be the model
    // ignoring it — the model never saw it. Gate the supervisor's "nudge
    // ignored" escalation on delivery: a same-turn re-trip is a runaway-output
    // kill with an accurate reason, decided here (not routed through the
    // supervisor, which would overstate it and would leave the same phantom
    // nudge bookkeeping as #126). Only a re-trip at a LATER turnIndex — when the
    // nudge was actually deliverable — falls through to the supervisor below.
    const nudgeTurn = this.repNudgeTurn.get(kind);
    if (nudgeTurn !== undefined && nudgeTurn === this.turnIndex) {
      return {
        action: "kill",
        reason:
          `${kind} re-tripped within the same turn (turn ${this.turnIndex}) as its ` +
          `steer nudge — the nudge is deliverable only after the turn, so the model ` +
          `never saw it: runaway output, not an ignored nudge`,
        kind,
        detail: evt.detail,
        turnIndex: evt.turnIndex,
      };
    }

    const action = this.supervisor.decide(evt);
    if (action.kind === "nudge" && action.nudgeMessage) {
      // Re-instantiate BOTH rep guards AND clear the cumulative buffers.
      // RepetitionGuard.update() statelessly re-evaluates the full buffer on
      // every delta, so a fresh guard alone is not enough: with the buffer kept,
      // the very next delta would re-trip on the same buffered text. With the
      // buffers cleared, a re-trip requires ≥ minChars of FRESH post-nudge
      // repetition — and if that fresh re-trip still lands in the same turn
      // (before the nudge was deliverable), the same-turn gate above kills it as
      // runaway output rather than overstating it as "nudge ignored" (#27/#127).
      // Record the turn the nudge was issued so that gate can fire.
      this.textRepGuard = new RepetitionGuard();
      this.thinkingRepGuard = new RepetitionGuard();
      this.textBuf = "";
      this.thinkingBuf = "";
      this.repNudgeTurn.set(kind, this.turnIndex);
      return {
        action: "nudge",
        message: action.nudgeMessage,
        kind,
        detail: evt.detail,
        turnIndex: evt.turnIndex,
      };
    }
    if (action.kind === "kill") {
      return {
        action: "kill",
        reason: action.reason,
        kind,
        detail: evt.detail,
        turnIndex: evt.turnIndex,
      };
    }
    return null;
  }

  // -- tool-call loop + commit-intent detection -----------------------------

  private onToolStart(event: any): GuardDecision | null {
    const name = typeof event?.toolName === "string" ? event.toolName : "?";
    const args = event?.args ?? {};

    // Commit-intent detection: a `bash` call whose command contains `git commit`
    // raises the output budget (commits_made at the call site, so a failed
    // commit still raises the budget — false positive is safer than negative).
    if (name === "bash" && args && typeof args === "object") {
      const cmd = String((args as Record<string, unknown>).command ?? "");
      if (cmd.includes("git commit")) {
        this.outputBudgetGuard?.observeCommit();
      }
    }

    if (this.toolLoopGuard.observe(name, args)) {
      const evt: GuardEvent = {
        kind: "tool_call_loop",
        detail: `tool=${this.toolLoopGuard.lastName} count=${this.toolLoopGuard.lastCount}`,
        trippedGuard: {
          lastName: this.toolLoopGuard.lastName,
          lastCount: this.toolLoopGuard.lastCount,
        },
        turnIndex: this.turnIndex,
      };
      const action = this.supervisor.decide(evt);
      if (action.kind === "nudge" && action.nudgeMessage) {
        this.toolLoopGuard = new ToolCallLoopGuard();
        return {
          action: "nudge",
          message: action.nudgeMessage,
          kind: "tool_call_loop",
          detail: evt.detail,
          turnIndex: evt.turnIndex,
        };
      }
      if (action.kind === "kill") {
        return {
          action: "kill",
          reason: action.reason,
          kind: "tool_call_loop",
          detail: evt.detail,
          turnIndex: evt.turnIndex,
        };
      }
    }
    return null;
  }

  // -- tool-error loop ------------------------------------------------------

  private onToolEnd(event: any): GuardDecision | null {
    const name = typeof event?.toolName === "string" ? event.toolName : "?";
    const isError = Boolean(event?.isError);
    if (this.toolErrorLoopGuard.observe(name, isError)) {
      const evt: GuardEvent = {
        kind: "tool_error_loop",
        detail: `tool=${this.toolErrorLoopGuard.lastName} count=${this.toolErrorLoopGuard.lastCount}`,
        trippedGuard: {
          lastName: this.toolErrorLoopGuard.lastName,
          lastCount: this.toolErrorLoopGuard.lastCount,
        },
        turnIndex: this.turnIndex,
      };
      const action = this.supervisor.decide(evt);
      if (action.kind === "nudge" && action.nudgeMessage) {
        this.toolErrorLoopGuard = new ToolErrorLoopGuard();
        return {
          action: "nudge",
          message: action.nudgeMessage,
          kind: "tool_error_loop",
          detail: evt.detail,
          turnIndex: evt.turnIndex,
        };
      }
      if (action.kind === "kill") {
        return {
          action: "kill",
          reason: action.reason,
          kind: "tool_error_loop",
          detail: evt.detail,
          turnIndex: evt.turnIndex,
        };
      }
    }
    return null;
  }

  // -- turn boundary + output budget ----------------------------------------

  private onTurnEnd(event: any): GuardDecision | null {
    let decision: GuardDecision | null = null;

    // Observe the turn's output tokens for the budget check BEFORE resetting.
    if (this.outputBudgetGuard) {
      const usage = event?.message?.usage;
      // Pi/oMLX usage shape: { output: N }. Fall back to totalTokens-input if
      // `output` is absent (mirrors RunAccumulator's defensive read).
      let outTokens = 0;
      if (usage && typeof usage === "object") {
        const u = usage as Record<string, unknown>;
        if (typeof u.output === "number") {
          outTokens = u.output;
        } else if (typeof u.totalTokens === "number") {
          outTokens = u.totalTokens - (typeof u.input === "number" ? u.input : 0);
        }
      }
      if (outTokens > 0 && this.outputBudgetGuard.observeOutputTokens(outTokens)) {
        const detail =
          `turn=${this.turnIndex} output_tokens=${this.outputBudgetGuard.lastCount} ` +
          `budget=${this.outputBudgetGuard.lastThreshold} commits=${this.outputBudgetGuard.commitsMade}`;
        // output_budget ALWAYS escalates to kill — a nudge can't unstick a turn
        // already this deep into runaway thinking (mirrors Python). We
        // deliberately do NOT call supervisor.decide() here: on this always-kill
        // path decide() would record a nudge that is never injected, so the
        // failure summary would read "nudges: output_budget=1" while metrics
        // count a kill — the two observability surfaces would disagree (#126).
        // Skipping decide() keeps them consistent: no phantom nudge, just the kill.
        decision = {
          action: "kill",
          reason:
            `output_budget exceeded: ${this.outputBudgetGuard.lastCount} > ` +
            `${this.outputBudgetGuard.lastThreshold} tokens in turn ${this.turnIndex} ` +
            `(commits=${this.outputBudgetGuard.commitsMade})`,
          kind: "output_budget",
          detail,
          turnIndex: this.turnIndex,
        };
      }
    }

    // Advance the turn counter and reset the per-turn budget + cumulative
    // buffers (a new turn starts fresh).
    this.turnIndex += 1;
    this.outputBudgetGuard?.resetTurn();
    this.textBuf = "";
    this.thinkingBuf = "";

    return decision;
  }

  /** Human-readable supervisor summary for the RunResult / logging. */
  get supervisorSummary(): string {
    return this.supervisor.summary;
  }
}
