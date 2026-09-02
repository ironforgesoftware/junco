import type { RunResult, ToolCall, Usage } from "../types.js";
import type { AgentEvent } from "./session.js";

export class RunAccumulator {
  private text = "";
  /** Last COMPLETED non-empty assistant message (see message_start below). */
  private lastText = "";
  /** Every COMPLETED non-empty assistant message, in order — joined into
   * `allText` so a fence banked before the closing message survives (#67). */
  private completedTexts: string[] = [];
  private toolCalls: ToolCall[] = [];
  private usage: Usage = { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 };
  private stopReason: string | null = null;
  private errorMessage: string | null = null;
  private turns = 0;
  private lastTool: string | null = null;

  observe(event: AgentEvent): void {
    // The PUBLIC boundary is typed (AgentEvent — callers and fakes are checked
    // at the subscribe layer); internally we parse defensively against partial
    // shapes (test fakes, older servers), so access goes through one local cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- defensive read of a partial SDK event shape
    const e = event as any;
    switch (e?.type) {
      case "message_start":
        // A new ASSISTANT message begins: bank the previous message's text and
        // reset the accumulator, so finalText is the agent's LAST message —
        // not the whole run's narration concatenated with no separator
        // (issue #36). message_start also fires for user and toolResult
        // messages (SDK MessageStartEvent); those must not reset.
        if (e.message?.role === "assistant") {
          if (this.text.trim() !== "") {
            this.lastText = this.text;
            this.completedTexts.push(this.text);
          }
          this.text = "";
        }
        break;
      case "message_update":
        if (e.assistantMessageEvent?.type === "text_delta")
          this.text += e.assistantMessageEvent.delta ?? "";
        break;
      case "tool_execution_start":
        // `args` lives on the START event; tool_execution_end carries `result`,
        // not `args` (verified against the SDK's ToolExecution*Event type defs).
        this.toolCalls.push({ name: e.toolName, args: e.args });
        this.lastTool = typeof e.toolName === "string" ? e.toolName : this.lastTool;
        break;
      case "turn_end": {
        const u = e.message?.usage;
        if (u) {
          // The SDK Usage field is `totalTokens` (the Python worker/fake used the
          // same name); fall back to `total`, then to input+output, for safety.
          const turnTotal = u.totalTokens ?? u.total ?? (u.input ?? 0) + (u.output ?? 0);
          // The SDK's per-turn Usage carries its own USD figure at `cost.total`
          // (pi-ai types.d.ts:248-269), computed by calculateCost in models.js
          // from the model's rate card — sum it rather than deriving our own
          // pricing table. Absent on fakes/providers that don't report cost.
          this.usage = {
            input: this.usage.input + (u.input ?? 0),
            output: this.usage.output + (u.output ?? 0),
            cacheRead: this.usage.cacheRead + (u.cacheRead ?? 0),
            total: this.usage.total + turnTotal,
            costUsd: this.usage.costUsd + (u.cost?.total ?? 0),
          };
        }
        if (e.message?.stopReason) this.stopReason = e.message.stopReason;
        // First-attempt non-retryable errors never emit auto_retry_end (the
        // SDK only fires it when a retry was attempted) — the assistant
        // message's errorMessage is the only record. auto_retry_end's
        // finalError still overwrites this when it fires.
        if (e.message?.errorMessage && this.errorMessage === null) {
          this.errorMessage = String(e.message.errorMessage);
        }
        this.turns++;
        break;
      }
      case "auto_retry_end":
        // SDK shape (agent-session.d.ts AgentSessionEvent union): `{ type:
        // "auto_retry_end"; success: boolean; attempt: number; finalError?:
        // string }`. The SDK emits turn_end for the ERRORED assistant message
        // BEFORE deciding to retry — the null-guarded capture above already
        // banked that error — and only fires auto_retry_end once the retry
        // decision is made. When the retry SUCCEEDS (success:true) there is
        // no finalError: the first attempt's error was TRANSIENT and
        // RECOVERED, so clear it — otherwise a fully-recovered run keeps a
        // poisoned errorMessage forever (prFlow sends completed committed
        // work to failed/, Q&A gate-routes a clean run as a failure, budgeted
        // paths regress). When it FAILS, finalError still overwrites.
        if (e.success === true) this.errorMessage = null;
        else if (e.finalError) this.errorMessage = String(e.finalError);
        break;
    }
  }

  /** Cheap live-progress view for the metrics surface. */
  progress(): { turns: number; lastTool: string | null; outputTokens: number } {
    return { turns: this.turns, lastTool: this.lastTool, outputTokens: this.usage.output };
  }

  setError(msg: string): void {
    this.errorMessage = msg;
  }

  result(durationMs: number, timedOut = false, abortedByGuard = false): RunResult {
    // Whole-run text: every completed message plus the in-flight one (never
    // banked at a message_start), newline-joined. Undefined when empty so the
    // `allText ?? finalText` fallback at the parse sites degrades cleanly (#67).
    const parts = [...this.completedTexts];
    if (this.text.trim() !== "") parts.push(this.text);
    const allText = parts.join("\n");
    return {
      // The in-flight (last) message when it has text; otherwise the last
      // completed non-empty message (a run often ends on a tool-only message).
      finalText: this.text.trim() || this.lastText.trim(),
      allText: allText.trim() !== "" ? allText : undefined,
      toolCalls: this.toolCalls,
      usage: this.usage,
      stopReason: this.stopReason,
      errorMessage: this.errorMessage,
      timedOut,
      durationMs,
      abortedByGuard,
    };
  }
}
