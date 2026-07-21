import { describe, it, expect } from "vitest";
import {
  deriveState,
  stateMeta,
  allowedActions,
  sortIssues,
  type DashIssue,
} from "../src/tui/state.js";
import { makeDashIssue } from "./helpers/dashFixtures.js";

const T = "junco";
const iss = (n: number, labels: string[], updatedAt: string): DashIssue =>
  makeDashIssue({ number: n, title: `t${n}`, labels, updatedAt });

describe("deriveState", () => {
  it.each([
    [[], "raw"],
    [["junco"], "raw"],
    [["junco", "junco:planning"], "planning"],
    [["junco", "junco:plan-ready"], "plan-ready"],
    [["junco", "junco:plan-ready", "junco:approved"], "approved"],
    [["junco", "junco:queued"], "queued"],
    [["junco", "junco:working"], "working"],
    [["junco", "junco:done"], "done"],
    [["junco", "junco:failed"], "failed"],
    [["junco", "junco:denied"], "denied"],
  ] as const)("%j → %s", (labels, expected) => {
    expect(deriveState([...labels], T)).toBe(expected);
  });

  it("terminal states win over stale earlier labels", () => {
    expect(deriveState(["junco", "junco:plan-ready", "junco:failed"], T)).toBe("failed");
    expect(deriveState(["junco", "junco:queued", "junco:done"], T)).toBe("done");
  });

  it("approved without plan-ready is NOT the approved state (pre-approval is inert)", () => {
    expect(deriveState(["junco", "junco:approved"], T)).toBe("raw");
  });

  it("custom trigger derives custom lifecycle names", () => {
    expect(deriveState(["bot", "bot:working"], "bot")).toBe("working");
  });
});

describe("allowedActions", () => {
  it.each([
    ["raw", ["dispatch", "dispatchAsk"]],
    ["planning", []],
    ["plan-ready", ["approve", "replan"]],
    ["approved", ["replan"]],
    ["queued", []],
    ["working", []],
    ["done", ["recycle"]],
    ["failed", ["recycle"]],
    ["denied", ["recycle"]],
  ] as const)("%s → %j", (state, actions) => {
    expect(allowedActions(state)).toEqual(actions);
  });
});

describe("stateMeta", () => {
  it("every state has glyph, color, badge", () => {
    for (const s of [
      "raw",
      "planning",
      "plan-ready",
      "approved",
      "queued",
      "working",
      "done",
      "failed",
      "denied",
    ] as const) {
      const m = stateMeta(s);
      expect(m.glyph.length).toBeGreaterThan(0);
      expect(m.color.length).toBeGreaterThan(0);
      expect(m.badge.length).toBeGreaterThan(0);
    }
  });
});

describe("sortIssues", () => {
  it("needs-review first, then raw, then in-flight, then terminal; updatedAt desc within groups", () => {
    const sorted = sortIssues(
      [
        iss(1, ["junco", "junco:done"], "2026-07-06T10:00:00Z"),
        iss(2, ["junco"], "2026-07-06T09:00:00Z"),
        iss(3, ["junco", "junco:plan-ready"], "2026-07-01T00:00:00Z"),
        iss(4, ["junco", "junco:working"], "2026-07-06T11:00:00Z"),
        iss(5, ["junco"], "2026-07-06T12:00:00Z"),
      ],
      T,
    );
    expect(sorted.map((i) => i.number)).toEqual([3, 5, 2, 4, 1]);
  });
});
