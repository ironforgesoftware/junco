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
  it("tolerates a junco-prefixed but unknown type as sdk passthrough", () => {
    // Forward compat: an older junco reading a newer transcript must not throw.
    expect(parseTranscriptLine(JSON.stringify({ type: "junco_future_thing" })).kind).toBe("junco");
  });
});
