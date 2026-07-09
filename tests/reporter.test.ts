import { describe, it, expect } from "vitest";
import { outcomeFromPrFlow, outcomeFromQa, NOOP_REPORTER } from "../src/reporter.js";
import type { PrFlowResult } from "../src/prFlow.js";
import type { RunResult } from "../src/types.js";

const flow: PrFlowResult = {
  dst: "/q/done/t.md",
  status: "completed",
  requeued: false,
  prUrl: "https://github.com/acme/api/pull/7",
  commitCount: 3,
  finalText: "Did the thing.\n\nDetails...",
  phaseError: null,
  prQueued: false,
};
const qaResult: RunResult = {
  finalText: "The answer.",
  toolCalls: [],
  usage: { input: 1, output: 2, cacheRead: 0, total: 3 },
  stopReason: "end_turn",
  errorMessage: null,
  timedOut: false,
  durationMs: 1000,
  abortedByGuard: false,
};

describe("outcome mapping", () => {
  it("maps a PrFlowResult", () => {
    expect(outcomeFromPrFlow(flow)).toEqual({
      kind: "pr",
      status: "completed",
      prUrl: "https://github.com/acme/api/pull/7",
      finalText: "Did the thing.\n\nDetails...",
      failureReason: null,
      prQueued: false,
    });
  });

  it("maps a Q&A result with failure reason", () => {
    const o = outcomeFromQa("failed", { ...qaResult, errorMessage: "boom" });
    expect(o).toEqual({
      kind: "qa",
      status: "failed",
      prUrl: null,
      finalText: "The answer.",
      failureReason: "boom",
    });
  });

  it("threads allText through both mapping sites (#86)", () => {
    // Q&A/result path (the one planning tickets run through): the whole-run
    // text must reach the reporter so a fence banked before the closing
    // message survives.
    expect(
      outcomeFromQa("completed", { ...qaResult, allText: "fence\n\nThe answer." }).allText,
    ).toBe("fence\n\nThe answer.");
    // PR/flow path.
    expect(outcomeFromPrFlow({ ...flow, allText: "all the text" }).allText).toBe("all the text");
    // Absent on the source RunResult/PrFlowResult → undefined (the `?? finalText`
    // fallback at the read site keeps behavior unchanged).
    expect(outcomeFromQa("completed", qaResult).allText).toBeUndefined();
    expect(outcomeFromPrFlow(flow).allText).toBeUndefined();
  });

  it("noop reporter resolves without effect", async () => {
    await expect(NOOP_REPORTER.onStart({} as never)).resolves.toBeUndefined();
    await expect(NOOP_REPORTER.onRequeue({} as never)).resolves.toBeUndefined();
    await expect(NOOP_REPORTER.onFinal({} as never, {} as never)).resolves.toBeUndefined();
  });
});
