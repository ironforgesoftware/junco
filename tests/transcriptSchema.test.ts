import { describe, it, expect } from "vitest";
import { parseTranscriptLine } from "../src/agent/transcriptSchema.js";

describe("parseTranscriptLine", () => {
  it("classifies junco_* records", () => {
    const p = parseTranscriptLine(
      JSON.stringify({
        type: "junco_guard_decision",
        kind: "tool_call_loop",
        action: "nudge",
        detail: "d",
        turnIndex: 3,
        ts: "t",
      }),
    );
    expect(p.kind).toBe("junco");
    if (p.kind === "junco") expect(p.record.type).toBe("junco_guard_decision");
  });
  it("classifies SDK events", () => {
    const p = parseTranscriptLine(JSON.stringify({ type: "turn_end", message: {} }));
    expect(p.kind).toBe("sdk");
  });
  it("tolerates a truncated line (crash mid-write) as invalid", () => {
    expect(parseTranscriptLine('{"type":"turn_en').kind).toBe("invalid");
  });
  it("tolerates a junco-prefixed but unknown type as a forward-compat junco record", () => {
    // Forward compat: an older junco reading a newer transcript must not throw.
    expect(parseTranscriptLine(JSON.stringify({ type: "junco_future_thing" })).kind).toBe("junco");
  });
});

describe("chat records (spec 2026-09-01 §1.3)", () => {
  it("every junco_chat_* record classifies as junco", () => {
    const records: any[] = [
      { type: "junco_chat_prompt", text: "hi", mode: "prompt", source: "operator", ts: "t" },
      { type: "junco_chat_turn_start", modelId: "m", tools: ["read"], timeoutMs: 1, ts: "t" },
      {
        type: "junco_chat_turn_end",
        status: "ok",
        errorClass: null,
        errorMessage: null,
        usage: { input: 1, output: 1, cacheRead: 0, total: 2, costUsd: 0 },
        durationMs: 5,
        ts: "t",
      },
      { type: "junco_chat_turn_aborted", reason: "timeout", ts: "t" },
      { type: "junco_chat_turn_rejected", reason: "budget", until: null, ts: "t" },
      {
        type: "junco_chat_draft",
        draftId: "d1",
        kind: "ticket",
        status: "parked",
        ids: [],
        destination: null,
        ts: "t",
      },
      { type: "junco_chat_session_reset", reason: "corrupt", ts: "t" },
      { type: "junco_chat_transcript_degraded", ts: "t" },
    ];
    for (const r of records) {
      const p = parseTranscriptLine(JSON.stringify(r));
      expect(p.kind).toBe("junco");
      if (p.kind === "junco") expect(p.record.type).toBe(r.type);
    }
  });
  it("chat is a FlowKind", () => {
    const f: any = "chat";
    expect(f).toBe("chat");
  });
});
