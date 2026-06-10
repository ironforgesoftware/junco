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

export type GuardDecision =
  | { action: "nudge"; message: string; kind: GuardKind }
  | { action: "kill"; reason: string; kind: GuardKind };

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
    const action = this.supervisor.decide(evt);
    if (action.kind === "nudge" && action.nudgeMessage) {
      // Re-instantiate BOTH rep guards so we don't immediately re-trip on the
      // same buffered text (mirrors Python). Buffers persist until the next
      // message/turn boundary.
      this.textRepGuard = new RepetitionGuard();
      this.thinkingRepGuard = new RepetitionGuard();
      return { action: "nudge", message: action.nudgeMessage, kind };
    }
    if (action.kind === "kill") {
      return { action: "kill", reason: action.reason, kind };
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
        return { action: "nudge", message: action.nudgeMessage, kind: "tool_call_loop" };
      }
      if (action.kind === "kill") {
        return { action: "kill", reason: action.reason, kind: "tool_call_loop" };
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
        return { action: "nudge", message: action.nudgeMessage, kind: "tool_error_loop" };
      }
      if (action.kind === "kill") {
        return { action: "kill", reason: action.reason, kind: "tool_error_loop" };
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
        const evt: GuardEvent = {
          kind: "output_budget",
          detail:
            `turn=${this.turnIndex} output_tokens=${this.outputBudgetGuard.lastCount} ` +
            `budget=${this.outputBudgetGuard.lastThreshold} commits=${this.outputBudgetGuard.commitsMade}`,
          trippedGuard: {
            lastName: this.outputBudgetGuard.lastName,
            lastCount: this.outputBudgetGuard.lastCount,
          },
          turnIndex: this.turnIndex,
        };
        // Run the decision (for nudge bookkeeping / summary symmetry) but
        // output_budget ALWAYS escalates to kill regardless of the action — a
        // nudge can't unstick a turn already this deep into runaway thinking
        // (mirrors Python exactly).
        this.supervisor.decide(evt);
        decision = {
          action: "kill",
          reason:
            `output_budget exceeded: ${this.outputBudgetGuard.lastCount} > ` +
            `${this.outputBudgetGuard.lastThreshold} tokens in turn ${this.turnIndex} ` +
            `(commits=${this.outputBudgetGuard.commitsMade})`,
          kind: "output_budget",
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
