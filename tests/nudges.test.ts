/**
 * Tests for nudges.ts — verbatim template wording verified against nudges.py.
 */
import { describe, it, expect } from "vitest";
import { buildNudgeForGuardEvent } from "../src/agent/nudges.js";
import type { GuardEvent } from "../src/agent/supervisor.js";

function makeEvt(
  kind: GuardEvent["kind"],
  lastName: string | null,
  lastCount: number,
): GuardEvent {
  return {
    kind,
    detail: "test",
    trippedGuard: { lastName, lastCount },
    turnIndex: 0,
  };
}

describe("buildNudgeForGuardEvent", () => {
  it("tool_call_loop — contains hallmark phrase, tool name, and count", () => {
    const msg = buildNudgeForGuardEvent(makeEvt("tool_call_loop", "Write", 3));
    expect(msg).toContain("⚠️ JUNCO NOTICE:");
    expect(msg).toContain("`Write`");
    expect(msg).toContain("3×");
    expect(msg).toContain("calling again will not produce different output");
    expect(msg).toContain("Do NOT call `Write` with these args again.");
  });

  it("tool_call_loop — uses fallback '?' when lastName is null", () => {
    const msg = buildNudgeForGuardEvent(makeEvt("tool_call_loop", null, 2));
    expect(msg).toContain("`?`");
  });

  it("tool_error_loop — contains hallmark phrase, tool name, and count", () => {
    const msg = buildNudgeForGuardEvent(makeEvt("tool_error_loop", "Bash", 4));
    expect(msg).toContain("⚠️ JUNCO NOTICE:");
    expect(msg).toContain("`Bash`");
    expect(msg).toContain("4×");
    expect(msg).toContain("Stop retrying");
    expect(msg).toContain("note this step as blocked in your final summary");
  });

  it("text_rep — says 'text'", () => {
    const msg = buildNudgeForGuardEvent(makeEvt("text_rep", null, 0));
    expect(msg).toContain("⚠️ JUNCO NOTICE:");
    expect(msg).toContain("Your text output is repeating");
    expect(msg).toContain("Do not continue the current line of reasoning.");
  });

  it("thinking_rep — says 'thinking'", () => {
    const msg = buildNudgeForGuardEvent(makeEvt("thinking_rep", null, 0));
    expect(msg).toContain("⚠️ JUNCO NOTICE:");
    expect(msg).toContain("Your thinking output is repeating");
    expect(msg).toContain("Do not continue the current line of reasoning.");
  });

  it("output_budget — formats count with comma (14000 → '14,000')", () => {
    const msg = buildNudgeForGuardEvent(makeEvt("output_budget", null, 14000));
    expect(msg).toContain("⚠️ JUNCO NOTICE:");
    expect(msg).toContain("14,000");
    expect(msg).toContain("output tokens without a state-changing tool call");
    expect(msg).toContain("The ticket will land in failed/");
  });

  it("output_budget — small count still renders (1 → '1')", () => {
    const msg = buildNudgeForGuardEvent(makeEvt("output_budget", null, 1));
    expect(msg).toContain("1 output tokens");
  });
});
