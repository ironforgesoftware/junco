import { describe, it, expect } from "vitest";
import { summarizeTranscript, toolCallIds } from "../src/transcriptSummary.js";
import {
  agentEnd,
  agentStart,
  guardDecision,
  j,
  metaLine,
  msgEnd,
  runEnd,
  runStart,
  toolEndId,
  toolStartId,
  turnEndFull,
} from "./helpers/transcriptFixtures.js";

const CALL = { id: "c1", name: "find", args: { pattern: "*" }, result: "a\nb" };

/** One complete v2 run: meta, frame, a tool call streamed then confirmed by turn_end. */
const v2 = (): string[] => [
  metaLine(),
  runStart({ flow: "assess", modelId: "local/m1", ts: "2026-08-29T01:02:47.000Z" }),
  agentStart(),
  toolStartId("c1", "find", { pattern: "*" }),
  toolEndId("c1", "find", "a\nb"),
  turnEndFull({ thinking: "hmm", text: "done", calls: [CALL], usage: { input: 10, output: 5 } }),
  agentEnd(),
  runEnd({ stopReason: "stop", durationMs: 1234 }),
];

describe("summarizeTranscript", () => {
  it("frames a v2 run: meta, run_start fields, turns, tool results, run_end", () => {
    const s = summarizeTranscript(v2());
    expect(s.ticketId).toBe("t-1");
    expect(s.version).toBe(2);
    expect(s.live).toBe(false);
    expect(s.invalidLines).toBe(0);
    expect(s.runs).toHaveLength(1);
    const run = s.runs[0];
    expect(run.index).toBe(1);
    expect(run.flow).toBe("assess");
    expect(run.modelId).toBe("local/m1");
    expect(run.startedAt).toBe("2026-08-29T01:02:47.000Z");
    expect(run.end).toEqual({
      stopReason: "stop",
      errorMessage: null,
      timedOut: false,
      abortedByGuard: false,
      durationMs: 1234,
      usage: { input: 1, output: 1, cacheRead: 0, total: 2, costUsd: 0 },
    });
    expect(run.toolCallCount).toBe(1);
    expect(run.turns).toHaveLength(1);
    const t = run.turns[0];
    expect(t.index).toBe(0);
    expect(t.provisional).toBe(false);
    expect(t.thinking).toBe("hmm");
    expect(t.text).toBe("done");
    expect(t.usage).toEqual({ input: 10, output: 5 });
    expect(t.toolCalls).toEqual([
      {
        id: "c1",
        name: "find",
        args: { pattern: "*" },
        result: { text: "a\nb", lines: 2, isError: false },
      },
    ]);
  });

  it("keeps every run of a retried ticket, 1-based, each with its own end", () => {
    const s = summarizeTranscript([
      metaLine(),
      runStart({ modelId: "bad" }),
      agentStart(),
      agentEnd(),
      runEnd({ stopReason: "error", errorMessage: "404: model not found", durationMs: 33 }),
      runStart({ modelId: "good" }),
      agentStart(),
      turnEndFull({ text: "ok" }),
      agentEnd(),
      runEnd(),
    ]);
    expect(s.runs.map((r) => [r.index, r.modelId])).toEqual([
      [1, "bad"],
      [2, "good"],
    ]);
    expect(s.runs[0].end?.errorMessage).toBe("404: model not found");
    expect(s.runs[0].turns).toHaveLength(0);
    expect(s.runs[1].turns[0].text).toBe("ok");
    expect(s.live).toBe(false);
  });

  it("v1 file: agent_start/agent_end bound the run; end carries no usage/duration", () => {
    const s = summarizeTranscript([agentStart(), turnEndFull({ text: "hi" }), agentEnd()]);
    expect(s.ticketId).toBeNull();
    expect(s.version).toBeNull();
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0].flow).toBeNull();
    expect(s.runs[0].end).toEqual({
      stopReason: null,
      errorMessage: null,
      timedOut: false,
      abortedByGuard: false,
      durationMs: null,
      usage: null,
    });
    expect(s.runs[0].turns[0].text).toBe("hi");
    expect(s.live).toBe(false);
  });

  it("a torn last line is counted, never fatal", () => {
    const s = summarizeTranscript([...v2(), '{"type":"turn_end","mess']);
    expect(s.invalidLines).toBe(1);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0].turns).toHaveLength(1);
  });

  it("live: an open run builds a provisional turn from tool_execution events", () => {
    const s = summarizeTranscript([
      runStart(),
      agentStart(),
      turnEndFull({ text: "t1", calls: [CALL] }),
      toolStartId("c2", "read", { path: "a.ts" }),
    ]);
    expect(s.live).toBe(true);
    expect(s.runs[0].end).toBeNull();
    expect(s.runs[0].turns).toHaveLength(2);
    const p = s.runs[0].turns[1];
    expect(p.provisional).toBe(true);
    expect(p.index).toBe(1);
    expect(p.toolCalls).toEqual([{ id: "c2", name: "read", args: { path: "a.ts" }, result: null }]);
    expect(s.runs[0].toolCallCount).toBe(2);
  });

  it("tool_execution_end fills the provisional call's result", () => {
    const s = summarizeTranscript([
      runStart(),
      agentStart(),
      toolStartId("c2", "read", { path: "a.ts" }),
      toolEndId("c2", "read", "body", true),
    ]);
    expect(s.runs[0].turns[0].toolCalls[0].result).toEqual({
      text: "body",
      lines: 1,
      isError: true,
    });
  });

  it("turn_end replaces the provisional turn (no double-counted calls)", () => {
    const s = summarizeTranscript([
      runStart(),
      agentStart(),
      turnEndFull({ text: "t1", calls: [CALL] }),
      toolStartId("c2", "read", { path: "a.ts" }),
      toolEndId("c2", "read", "body"),
      turnEndFull({
        text: "t2",
        calls: [{ id: "c2", name: "read", args: { path: "a.ts" }, result: "body" }],
      }),
    ]);
    expect(s.runs[0].turns).toHaveLength(2);
    expect(s.runs[0].turns[1].provisional).toBe(false);
    expect(s.runs[0].turns[1].text).toBe("t2");
    expect(s.runs[0].toolCallCount).toBe(2);
    expect(toolCallIds(s)).toEqual(["c1", "c2"]);
  });

  it("a run_start while a run is open closes it as truncated (end null); live only at EOF", () => {
    const s = summarizeTranscript([runStart(), agentStart(), runStart(), agentStart(), runEnd()]);
    expect(s.runs).toHaveLength(2);
    expect(s.runs[0].end).toBeNull();
    expect(s.runs[1].end).not.toBeNull();
    expect(s.live).toBe(false);
  });

  it("v2: agent_end does NOT close a framed run — run_end does", () => {
    const s = summarizeTranscript([runStart(), agentStart(), agentEnd()]);
    expect(s.runs[0].end).toBeNull();
    expect(s.live).toBe(true);
  });

  it("guard decisions attach to the open run", () => {
    const s = summarizeTranscript([runStart(), guardDecision({ turnIndex: 0 }), runEnd()]);
    expect(s.runs[0].guardDecisions).toHaveLength(1);
    expect(s.runs[0].guardDecisions[0].turnIndex).toBe(0);
  });

  it("message_end is ignored (turn_end is the authoritative turn record)", () => {
    const s = summarizeTranscript([
      runStart(),
      agentStart(),
      msgEnd("x"),
      turnEndFull({ text: "x" }),
      runEnd(),
    ]);
    expect(s.runs[0].turns).toHaveLength(1);
  });

  it("non-text result blocks summarize as [<type> block]", () => {
    const s = summarizeTranscript([
      runStart(),
      toolStartId("c1", "read", { path: "img.png" }),
      j({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "read",
        result: { content: [{ type: "image", data: "…" }] },
        isError: false,
      }),
    ]);
    expect(s.runs[0].turns[0].toolCalls[0].result).toEqual({
      text: "[image block]",
      lines: 1,
      isError: false,
    });
  });

  it("empty input → no runs, not live", () => {
    expect(summarizeTranscript([])).toEqual({
      ticketId: null,
      version: null,
      runs: [],
      live: false,
      invalidLines: 0,
    });
    expect(summarizeTranscript(["", "  "]).runs).toEqual([]);
  });
});
