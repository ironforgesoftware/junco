import type { RunResult, ToolCall, Usage } from "../types.js";

export class RunAccumulator {
  private text = "";
  private toolCalls: ToolCall[] = [];
  private usage: Usage = { input: 0, output: 0, cacheRead: 0, total: 0 };
  private stopReason: string | null = null;
  private errorMessage: string | null = null;

  observe(event: any): void {
    switch (event?.type) {
      case "message_update":
        if (event.assistantMessageEvent?.type === "text_delta") this.text += event.assistantMessageEvent.delta ?? "";
        break;
      case "tool_execution_end":
        this.toolCalls.push({ name: event.toolName, args: event.args });
        break;
      case "turn_end": {
        const u = event.message?.usage;
        if (u) {
          this.usage = {
            input: this.usage.input + (u.input ?? 0),
            output: this.usage.output + (u.output ?? 0),
            cacheRead: this.usage.cacheRead + (u.cacheRead ?? 0),
            total: this.usage.total + (u.total ?? 0),
          };
        }
        if (event.message?.stopReason) this.stopReason = event.message.stopReason;
        break;
      }
      case "auto_retry_end":
        if (event.finalError) this.errorMessage = String(event.finalError);
        break;
    }
  }

  setError(msg: string): void { this.errorMessage = msg; }

  result(durationMs: number, timedOut = false): RunResult {
    return {
      finalText: this.text.trim(),
      toolCalls: this.toolCalls,
      usage: this.usage,
      stopReason: this.stopReason,
      errorMessage: this.errorMessage,
      timedOut,
      durationMs,
    };
  }
}
