import { describe, it, expect } from "vitest";
import { GuardManager } from "../src/agent/guardManager.js";

// ---------------------------------------------------------------------------
// Synthetic event helpers (no SDK). Shapes mirror the Pi AgentSessionEvent
// surface verified in src/agent/session.ts / dist type defs:
//   tool_execution_start  { type, toolName, args }
//   tool_execution_end    { type, toolName, isError }
//   message_update        { type, assistantMessageEvent: { type:"text_delta"|"thinking_delta", delta } }
//   turn_end              { type, message: { usage: { output } } }
// ---------------------------------------------------------------------------

function toolStart(toolName: string, args: unknown) {
  return { type: "tool_execution_start", toolCallId: "x", toolName, args };
}
function toolEnd(toolName: string, isError: boolean) {
  return { type: "tool_execution_end", toolCallId: "x", toolName, result: {}, isError };
}
function textDelta(delta: string) {
  return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } };
}
function thinkingDelta(delta: string) {
  return { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } };
}
function turnEnd(output: number) {
  return {
    type: "turn_end",
    message: { usage: { output, input: 0, cacheRead: 0, totalTokens: output } },
  };
}

describe("GuardManager — tool_call_loop", () => {
  it("nudges on the 3rd identical bash call, then kills on re-trip", () => {
    const gm = new GuardManager();
    const args = { command: "ls -la" };
    // bash threshold is 3 (DEFAULT_TOOL_LOOP_THRESHOLDS).
    expect(gm.observe(toolStart("bash", args))).toBeNull();
    expect(gm.observe(toolStart("bash", args))).toBeNull();
    const d = gm.observe(toolStart("bash", args));
    expect(d).not.toBeNull();
    expect(d!.action).toBe("nudge");
    expect(d!.kind).toBe("tool_call_loop");
    if (d!.action === "nudge") {
      expect(d!.message).toContain("JUNCO NOTICE");
      expect(d!.message).toContain("bash");
    }
    // The guard is re-instantiated on nudge → it does NOT immediately re-trip
    // on the very next identical call (run length resets to 1).
    expect(gm.observe(toolStart("bash", args))).toBeNull();
    expect(gm.observe(toolStart("bash", args))).toBeNull();
    // 3rd identical call after re-instantiation trips again → supervisor
    // budget (1) is exhausted → kill.
    const d2 = gm.observe(toolStart("bash", args));
    expect(d2).not.toBeNull();
    expect(d2!.action).toBe("kill");
    expect(d2!.kind).toBe("tool_call_loop");
  });

  it("detects git commit intent on a bash tool call and raises the output budget", () => {
    const gm = new GuardManager({ outputBudgetPerTurn: 12000, outputBudgetPostCommit: 24000 });
    // A bash call containing 'git commit' marks a commit → post-commit budget (24000).
    gm.observe(toolStart("bash", { command: "git commit -m 'wip'" }));
    // 12000 alone would have tripped the pre-commit budget; post-commit it does not.
    expect(gm.observe(turnEnd(12001))).toBeNull();
  });
});

describe("GuardManager — tool_error_loop", () => {
  it("nudges after 3 consecutive same-tool errors", () => {
    const gm = new GuardManager();
    expect(gm.observe(toolEnd("bash", true))).toBeNull();
    expect(gm.observe(toolEnd("bash", true))).toBeNull();
    const d = gm.observe(toolEnd("bash", true));
    expect(d).not.toBeNull();
    expect(d!.action).toBe("nudge");
    expect(d!.kind).toBe("tool_error_loop");
    if (d!.action === "nudge") expect(d!.message).toContain("JUNCO NOTICE");
  });

  it("does not trip when an intervening success resets the run", () => {
    const gm = new GuardManager();
    gm.observe(toolEnd("bash", true));
    gm.observe(toolEnd("bash", true));
    gm.observe(toolEnd("bash", false)); // success resets
    expect(gm.observe(toolEnd("bash", true))).toBeNull();
    expect(gm.observe(toolEnd("bash", true))).toBeNull();
  });
});

describe("GuardManager — output_budget", () => {
  it("always kills when the per-turn output budget is exceeded (never nudges)", () => {
    const gm = new GuardManager({ outputBudgetPerTurn: 12000 });
    const d = gm.observe(turnEnd(12001));
    expect(d).not.toBeNull();
    expect(d!.action).toBe("kill");
    expect(d!.kind).toBe("output_budget");
    if (d!.action === "kill") expect(d!.reason).toContain("output_budget");
  });

  it("resets the per-turn counter on each turn boundary", () => {
    const gm = new GuardManager({ outputBudgetPerTurn: 12000 });
    // Two turns of 8000 each must NOT trip (each turn resets).
    expect(gm.observe(turnEnd(8000))).toBeNull();
    expect(gm.observe(turnEnd(8000))).toBeNull();
  });

  it("is disabled entirely when outputBudgetPerTurn is 0", () => {
    const gm = new GuardManager({ outputBudgetPerTurn: 0 });
    expect(gm.observe(turnEnd(999999))).toBeNull();
  });
});

describe("GuardManager — turn boundary", () => {
  it("increments turnIndex so the supervisor escalation window advances", () => {
    // With escalationWindow=1, a same-kind re-trip more than 1 turn later is a
    // fresh budget decision, not an escalation. We exercise this by checking that
    // turn_end advances the turnIndex used in GuardEvents.
    const gm = new GuardManager({
      supervisorConfig: { budgetPerKind: 2, escalationWindowTurns: 1 },
    });
    const args = { command: "echo hi" };
    // First trip (turn 0) → nudge #1.
    gm.observe(toolStart("bash", args));
    gm.observe(toolStart("bash", args));
    const a = gm.observe(toolStart("bash", args));
    expect(a!.action).toBe("nudge");
    // Advance two turns so the prior nudge falls OUT of the escalation window.
    gm.observe(turnEnd(10));
    gm.observe(turnEnd(10));
    // Second trip → still within budget (2) and outside escalation window → nudge #2.
    gm.observe(toolStart("bash", args));
    gm.observe(toolStart("bash", args));
    const b = gm.observe(toolStart("bash", args));
    expect(b!.action).toBe("nudge");
  });
});

// A paragraph that reliably trips RepetitionGuard (proven in guards.test.ts):
// probe ≥200 chars, ≥10 unique chars, recurring ≥4× in the 2000-char window.
const REP_BLOCK =
  "This is an important paragraph with varied content and punctuation; worth flagging when it repeats. ".repeat(
    2,
  ) + "\n\n";

describe("GuardManager — text repetition", () => {
  it("nudges when cumulative text repeats the same paragraph, then re-instantiates", () => {
    const gm = new GuardManager();
    let decision = null as ReturnType<GuardManager["observe"]>;
    // Feed the block as accumulating deltas; the manager accumulates per-message.
    // 5 copies in the cumulative buffer reliably trips the guard.
    for (let i = 0; i < 8 && decision === null; i++) {
      decision = gm.observe(textDelta(REP_BLOCK));
    }
    expect(decision).not.toBeNull();
    expect(decision!.action).toBe("nudge");
    expect(decision!.kind).toBe("text_rep");
    if (decision!.action === "nudge") expect(decision!.message).toContain("JUNCO NOTICE");

    // After re-instantiation + a fresh-message boundary, the buffer is reset and
    // a brand-new short message does not immediately re-trip.
    gm.observe({ type: "message_start", message: { role: "assistant" } });
    expect(gm.observe(textDelta("short reply"))).toBeNull();
  });

  it("does not re-trip right after a nudge — the tripped buffer is cleared with it", () => {
    // The nudge is a steering prompt the SDK can only deliver AFTER the
    // current assistant turn — if the cumulative buffer survived the nudge,
    // the very next delta would re-trip the fresh guard on the same buffered
    // text and the supervisor would kill with "nudge ignored" before the
    // nudge could ever reach the model (issue #27).
    const gm = new GuardManager();
    let first = null as ReturnType<GuardManager["observe"]>;
    for (let i = 0; i < 8 && first === null; i++) first = gm.observe(textDelta(REP_BLOCK));
    expect(first!.action).toBe("nudge");
    // Immediately after the nudge: further deltas must NOT re-trip while the
    // fresh (post-nudge) text is still below the guard's minChars (1000).
    // Each REP_BLOCK is ~200 chars, so the first four stay under the floor.
    for (let i = 0; i < 4; i++) {
      expect(gm.observe(textDelta(REP_BLOCK))).toBeNull();
    }
  });

  it("escalates to kill when text repetition re-trips after the nudge", () => {
    const gm = new GuardManager();
    let first = null as ReturnType<GuardManager["observe"]>;
    for (let i = 0; i < 8 && first === null; i++) first = gm.observe(textDelta(REP_BLOCK));
    expect(first!.action).toBe("nudge");
    // The buffer was cleared with the nudge, so ≥ minChars of FRESH repetitive
    // text must accumulate before the guard can trip again. Same kind re-trips
    // within the escalation window (same turnIndex) → kill ("nudge ignored").
    let second = null as ReturnType<GuardManager["observe"]>;
    for (let i = 0; i < 12 && second === null; i++) second = gm.observe(textDelta(REP_BLOCK));
    expect(second).not.toBeNull();
    expect(second!.action).toBe("kill");
    expect(second!.kind).toBe("text_rep");
  });

  it("clears the thinking buffer too when a thinking_rep nudge is issued", () => {
    const gm = new GuardManager();
    let first = null as ReturnType<GuardManager["observe"]>;
    for (let i = 0; i < 8 && first === null; i++) first = gm.observe(thinkingDelta(REP_BLOCK));
    expect(first!.action).toBe("nudge");
    expect(first!.kind).toBe("thinking_rep");
    for (let i = 0; i < 4; i++) {
      expect(gm.observe(thinkingDelta(REP_BLOCK))).toBeNull();
    }
  });
});

describe("GuardManager — thinking repetition", () => {
  it("nudges on repeated thinking with kind=thinking_rep", () => {
    const gm = new GuardManager();
    let decision = null as ReturnType<GuardManager["observe"]>;
    for (let i = 0; i < 8 && decision === null; i++)
      decision = gm.observe(thinkingDelta(REP_BLOCK));
    expect(decision).not.toBeNull();
    expect(decision!.action).toBe("nudge");
    expect(decision!.kind).toBe("thinking_rep");
  });
});

describe("GuardManager — summary", () => {
  it("reports nudge counts after trips", () => {
    const gm = new GuardManager();
    const args = { command: "ls" };
    gm.observe(toolStart("bash", args));
    gm.observe(toolStart("bash", args));
    gm.observe(toolStart("bash", args));
    expect(gm.supervisorSummary).toContain("tool_call_loop");
  });
});
