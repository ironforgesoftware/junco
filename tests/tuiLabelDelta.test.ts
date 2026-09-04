// #443: `labelDelta` is the SINGLE source of truth for DashAction → label
// transitions. Two exhaustive switches used to encode it — `labelsOpFor`
// (ghClient, the real `gh` call) and `optimisticLabels` (App, the local UI
// update) — and only *adding* an action was compile-safe: changing one
// action's labels in one of them let the dashboard and GitHub disagree
// silently. These tests pin the table itself, and then pin that the optimistic
// view is the delta plus a NAMED prediction set and nothing else.
import { describe, it, expect } from "vitest";
import { labelDelta } from "../src/tui/state.js";
import { optimisticLabels } from "../src/tui/App.js";
import type { DashAction } from "../src/tui/state.js";

const NAMES = { trigger: "junco", askLabel: "junco:ask" };
const ALL: DashAction[] = ["dispatch", "dispatchAsk", "approve", "replan", "recycle"];

/** A representative starting label set per action — the lifecycle state its
 * `allowedActions` entry actually offers it from (state.ts's ACTIONS table). */
const FROM: Record<DashAction, string[]> = {
  dispatch: [],
  dispatchAsk: [],
  approve: ["junco", "junco:plan-ready"],
  replan: ["junco", "junco:plan-ready", "junco:approved"],
  recycle: ["junco", "junco:done"],
};

/** The ONLY labels the optimistic overlay may add beyond the real delta: the
 * bridge state the dashboard PREDICTS the daemon will move to on pickup. This
 * mirrors App.tsx's OPTIMISTIC_PREDICTION — if that table grows an entry
 * without this one growing too, the invariant test below fails. */
const PREDICTED: Partial<Record<DashAction, string[]>> = {
  dispatch: ["junco:planning"],
  dispatchAsk: ["junco:queued"],
};

describe("labelDelta", () => {
  it("dispatch adds the trigger label only", () => {
    expect(labelDelta("dispatch", [], NAMES)).toEqual({ add: ["junco"], remove: [] });
  });

  it("dispatchAsk adds trigger + the configured ask label", () => {
    expect(labelDelta("dispatchAsk", [], NAMES)).toEqual({
      add: ["junco", "junco:ask"],
      remove: [],
    });
  });

  it("dispatchAsk honors a non-default ask label", () => {
    expect(labelDelta("dispatchAsk", [], { trigger: "bot", askLabel: "question" })).toEqual({
      add: ["bot", "question"],
      remove: [],
    });
  });

  it("approve adds the approved label", () => {
    expect(labelDelta("approve", FROM.approve, NAMES)).toEqual({
      add: ["junco:approved"],
      remove: [],
    });
  });

  it("replan drops plan-ready, and approved only when it is present", () => {
    expect(labelDelta("replan", ["junco", "junco:plan-ready"], NAMES)).toEqual({
      add: [],
      remove: ["junco:plan-ready"],
    });
    expect(labelDelta("replan", FROM.replan, NAMES)).toEqual({
      add: [],
      remove: ["junco:plan-ready", "junco:approved"],
    });
  });

  it("recycle drops exactly the terminal labels present", () => {
    expect(labelDelta("recycle", ["junco", "junco:failed"], NAMES)).toEqual({
      add: [],
      remove: ["junco:failed"],
    });
  });

  it("recycle with no terminal label is the zero-op short-circuit (null)", () => {
    expect(labelDelta("recycle", ["junco"], NAMES)).toBeNull();
  });
});

describe("optimisticLabels agrees with labelDelta", () => {
  it.each(ALL)("%s: delta applied, plus only the named predictions", (action) => {
    const labels = FROM[action];
    const delta = labelDelta(action, labels, NAMES);
    expect(delta).not.toBeNull();
    const after = new Set(optimisticLabels(action, labels, NAMES));
    for (const l of delta!.add) expect(after.has(l)).toBe(true);
    for (const l of delta!.remove) expect(after.has(l)).toBe(false);
    // Everything the optimistic view shows that the delta did not put there
    // must be a declared prediction — no third, undocumented divergence.
    const extra = [...after].filter((l) => !labels.includes(l) && !delta!.add.includes(l));
    expect(extra.sort()).toEqual([...(PREDICTED[action] ?? [])].sort());
  });

  it("a zero-op recycle moves no label at all", () => {
    expect(optimisticLabels("recycle", ["junco"], NAMES).sort()).toEqual(["junco"]);
  });
});
