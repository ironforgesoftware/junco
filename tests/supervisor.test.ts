/**
 * Tests for supervisor.ts decision engine.
 * Policy order verified against supervisor.py.
 */
import { describe, it, expect } from "vitest";
import { Supervisor } from "../src/agent/supervisor.js";
import type { GuardEvent, SupervisorConfig } from "../src/agent/supervisor.js";

function makeEvt(kind: GuardEvent["kind"], turnIndex: number = 0): GuardEvent {
  return {
    kind,
    detail: "test trip",
    trippedGuard: { lastName: "TestTool", lastCount: 3 },
    turnIndex,
  };
}

describe("Supervisor.decide()", () => {
  it("first trip of a kind → nudge, nudgeMessage set, nudgesUsed incremented", () => {
    const sup = new Supervisor();
    const action = sup.decide(makeEvt("tool_call_loop", 0));
    expect(action.kind).toBe("nudge");
    expect(action.nudgeMessage).toBeTruthy();
    expect(action.reason).toContain("recovery attempt 1/1 for tool_call_loop");
    expect(sup.totalNudges).toBe(1);
  });

  it("second trip of same kind, turns far apart (outside window) → kill with 'budget exhausted'", () => {
    const sup = new Supervisor(); // budgetPerKind=1, window=3
    // First trip at turn 0 → nudge
    sup.decide(makeEvt("tool_call_loop", 0));
    // Second trip at turn 10 → outside the 3-turn window, budget exhausted
    const action = sup.decide(makeEvt("tool_call_loop", 10));
    expect(action.kind).toBe("kill");
    expect(action.reason).toContain("nudge budget exhausted for tool_call_loop");
    expect(action.reason).toContain("1/1");
  });

  it("same kind re-trips WITHIN escalationWindowTurns → kill with 'nudge ignored'", () => {
    const sup = new Supervisor(); // window=3
    // Nudge issued at turn 0
    sup.decide(makeEvt("tool_call_loop", 0));
    // Re-trip at turn 2 → within 3-turn window (2 - 0 = 2, cutoff = 2-3 = -1, record at 0 > -1)
    const action = sup.decide(makeEvt("tool_call_loop", 2));
    expect(action.kind).toBe("kill");
    expect(action.reason).toContain("nudge ignored");
    expect(action.reason).toContain("tool_call_loop");
    expect(action.reason).toContain("at turn 0");
    expect(action.reason).toContain("now turn 2");
  });

  it("different kinds have independent budgets", () => {
    const sup = new Supervisor();
    // nudge tool_call_loop (exhausts its budget)
    const a1 = sup.decide(makeEvt("tool_call_loop", 0));
    expect(a1.kind).toBe("nudge");
    // nudge text_rep (separate budget, should also nudge)
    const a2 = sup.decide(makeEvt("text_rep", 10));
    expect(a2.kind).toBe("nudge");
    expect(sup.totalNudges).toBe(2);
    // tool_call_loop budget now exhausted → kill
    const a3 = sup.decide(makeEvt("tool_call_loop", 20));
    expect(a3.kind).toBe("kill");
    expect(a3.reason).toContain("budget exhausted for tool_call_loop");
    // text_rep budget also exhausted → kill
    const a4 = sup.decide(makeEvt("text_rep", 30));
    expect(a4.kind).toBe("kill");
    expect(a4.reason).toContain("budget exhausted for text_rep");
  });

  it("totalNudges sums across kinds", () => {
    const cfg: SupervisorConfig = { budgetPerKind: 2, escalationWindowTurns: 1 };
    const sup = new Supervisor(cfg);
    sup.decide(makeEvt("tool_call_loop", 0));
    sup.decide(makeEvt("tool_call_loop", 5));
    sup.decide(makeEvt("text_rep", 10));
    expect(sup.totalNudges).toBe(3);
  });

  it("summary — no nudges → 'no nudges issued'", () => {
    const sup = new Supervisor();
    expect(sup.summary).toBe("no nudges issued");
  });

  it("summary — after nudges → 'nudges: kind=count'", () => {
    const cfg: SupervisorConfig = { budgetPerKind: 2, escalationWindowTurns: 1 };
    const sup = new Supervisor(cfg);
    sup.decide(makeEvt("tool_call_loop", 0));
    sup.decide(makeEvt("tool_error_loop", 10));
    const s = sup.summary;
    expect(s).toMatch(/^nudges: /);
    expect(s).toContain("tool_call_loop=1");
    expect(s).toContain("tool_error_loop=1");
  });

  it("escalation-window cleanup: a record older than window is dropped → budget logic applies", () => {
    // window=3, so cutoff = evt.turnIndex - 3
    // nudge at turn 0, then trip at turn 4: cutoff = 4-3 = 1; record at 0 is NOT > 1, so it's pruned
    // The second trip hits budget logic (not escalation) → kill with budget exhausted
    const sup = new Supervisor();
    sup.decide(makeEvt("tool_call_loop", 0)); // nudge at turn 0
    const action = sup.decide(makeEvt("tool_call_loop", 4)); // turn 4: cutoff=1, record@0 pruned
    expect(action.kind).toBe("kill");
    expect(action.reason).toContain("nudge budget exhausted for tool_call_loop");
    // Should NOT say "nudge ignored"
    expect(action.reason).not.toContain("nudge ignored");
  });

  it("custom config: budgetPerKind=2 allows two nudges", () => {
    const cfg: SupervisorConfig = { budgetPerKind: 2, escalationWindowTurns: 1 };
    const sup = new Supervisor(cfg);
    const a1 = sup.decide(makeEvt("tool_call_loop", 0));
    expect(a1.kind).toBe("nudge");
    expect(a1.reason).toContain("recovery attempt 1/2");
    // Second nudge at turn 5 (outside 1-turn window; cutoff=5-1=4, record@0 not > 4 → pruned)
    const a2 = sup.decide(makeEvt("tool_call_loop", 5));
    expect(a2.kind).toBe("nudge");
    expect(a2.reason).toContain("recovery attempt 2/2");
    // Third: budget exhausted
    const a3 = sup.decide(makeEvt("tool_call_loop", 10));
    expect(a3.kind).toBe("kill");
    expect(a3.reason).toContain("2/2");
  });
});
