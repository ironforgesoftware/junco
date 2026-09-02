import { describe, it, expect } from "vitest";
import {
  anchorIds,
  draftAnchor,
  summarizeTranscript,
  toolCallIds,
} from "../src/transcriptSummary.js";
import {
  agentEnd,
  agentStart,
  chatDraft,
  chatPrompt,
  chatReset,
  chatTurnAborted,
  chatTurnEnd,
  chatTurnRejected,
  chatTurnStart,
  compactionEnd,
  compactionStart,
  guardDecision,
  j,
  metaLine,
  msgEnd,
  runEnd,
  runStart,
  toolEndId,
  toolStartId,
  turnEndFull,
  v2RunLines,
} from "./helpers/transcriptFixtures.js";

const CALL = { id: "c1", name: "find", args: { pattern: "*" }, result: "a\nb" };

/** One complete v2 run: meta, frame, a tool call streamed then confirmed by turn_end. */
const v2 = v2RunLines;

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

describe("chat records (spec 2026-09-01 §1.3)", () => {
  const chat = (): string[] => [
    metaLine({ ticketId: "acme__api" }),
    chatPrompt(),
    chatTurnStart(),
    agentStart(),
    turnEndFull({
      thinking: null,
      text: "because of X",
      calls: [],
      usage: { input: 3, output: 4 },
    }),
    agentEnd(),
    chatTurnEnd(),
    chatDraft(),
    chatPrompt({ text: "make a ticket" }),
    chatTurnStart(),
    agentStart(),
    compactionStart(),
    compactionEnd(),
  ];
  it("frames chat turns as runs with flow chat, prompt text, and notes; the last is live", () => {
    const s = summarizeTranscript(chat());
    expect(s.runs).toHaveLength(2);
    expect(s.runs[0]).toMatchObject({
      flow: "chat",
      modelId: "local/m1",
      prompt: "why is the build slow?",
    });
    expect(s.runs[0]!.end).toMatchObject({
      stopReason: "stop",
      errorMessage: null,
      timedOut: false,
      durationMs: 1500,
    });
    expect(s.runs[0]!.turns[0]!.text).toBe("because of X");
    expect(s.runs[0]!.notes).toEqual([
      {
        kind: "draft",
        draftId: "acme__api-20260901-120000-1",
        draftKind: "ticket",
        status: "parked",
        ids: ["add-cache"],
        destination: null,
        ts: expect.any(String),
      },
    ]);
    expect(s.runs[1]!.prompt).toBe("make a ticket");
    expect(s.runs[1]!.notes.map((n) => n.kind)).toEqual(["compaction", "compaction"]);
    expect(s.live).toBe(true);
  });
  it("aborted, error, and rejected turns map onto RunEnd / notes", () => {
    const s = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      agentEnd(),
      chatTurnAborted({ reason: "timeout" }),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      agentEnd(),
      chatTurnEnd({ status: "error", errorClass: "rate_limit", errorMessage: "429" }),
      chatTurnRejected(),
    ]);
    expect(s.runs[0]!.end).toMatchObject({ timedOut: true, stopReason: "aborted:timeout" });
    expect(s.runs[1]!.end).toMatchObject({ errorMessage: "429", stopReason: "error" });
    // a note after a closed run lands on that run
    expect(s.runs).toHaveLength(2);
    expect(s.runs[1]!.notes[0]).toMatchObject({ kind: "rejected", reason: "rate limited" });
    expect(s.live).toBe(false);
  });
  it("a note before any run gets a prompt-less, already-closed run so it still renders", () => {
    const s = summarizeTranscript([metaLine(), chatTurnRejected()]);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ flow: "chat", prompt: null });
    expect(s.runs[0]!.end).not.toBeNull();
    expect(s.runs[0]!.notes[0]).toMatchObject({ kind: "rejected" });
    expect(s.live).toBe(false);
  });
  it("anchorIds is tool ids ∪ draft anchors in file order; ticket transcripts unchanged", () => {
    const s = summarizeTranscript(chat());
    expect(anchorIds(s)).toEqual([draftAnchor("acme__api-20260901-120000-1")]);
    const v2run = summarizeTranscript(v2());
    expect(v2run.runs[0]!.prompt).toBeNull();
    expect(v2run.runs[0]!.notes).toEqual([]);
    expect(anchorIds(v2run)).toEqual(toolCallIds(v2run));
  });
  it("a steer prompt while a run is open is dropped, not reframed as the next run's prompt", () => {
    const s = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      chatPrompt({ mode: "steer", text: "actually check Y too" }),
      agentEnd(),
      chatTurnEnd(),
      chatPrompt({ text: "next" }),
      chatTurnStart(),
    ]);
    expect(s.runs).toHaveLength(2);
    expect(s.runs[0]!.prompt).toBe("why is the build slow?");
    expect(s.runs[1]!.prompt).toBe("next");
  });
  it("session reset and transcript-degraded records attach as notes on the open run", () => {
    const s = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      chatReset({ reason: "operator_new" }),
      j({ type: "junco_chat_transcript_degraded", ts: "2026-09-01T00:00:00.000Z" }),
    ]);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]!.notes).toEqual([
      { kind: "reset", reason: "operator_new", ts: expect.any(String) },
      { kind: "degraded", ts: "2026-09-01T00:00:00.000Z" },
    ]);
  });
});
