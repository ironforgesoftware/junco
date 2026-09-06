/**
 * extendSummary (spec 2026-09-06 §3.3): the incremental entry point must
 * produce, at every prefix of every fixture, exactly what a whole-ring
 * summarizeTranscript over that prefix produces — and must never reach back
 * into a summary it already returned.
 */
import { describe, it, expect } from "vitest";
import {
  summarizeTranscript,
  extendSummary,
  type SummaryState,
  type TranscriptSummary,
} from "../src/transcriptSummary.js";
import {
  v2RunLines,
  metaLine,
  chatPrompt,
  chatTurnStart,
  turnEndFull,
  chatTurnEnd,
  chatTurnAborted,
  chatTurnRejected,
  toolStartId,
  toolEndId,
  chatDraft,
  chatCommand,
  chatReset,
  compactionStart,
  compactionEnd,
  agentStart,
  agentEnd,
  guardDecision,
  runStart,
  turnEnd,
} from "./helpers/transcriptFixtures.js";

const CASES: string[][] = [
  v2RunLines(),
  [
    metaLine({ ticketId: "a" }),
    chatPrompt(),
    chatTurnStart(),
    toolStartId("c1", "read", { path: "x" }),
    toolEndId("c1", "read", "ok"),
    turnEndFull({ text: "hi" }),
    chatTurnEnd(),
  ],
  [metaLine({ ticketId: "a" }), chatPrompt(), chatTurnStart(), chatTurnAborted()],
  [
    metaLine({ ticketId: "a" }),
    chatPrompt(),
    chatTurnStart(),
    chatDraft(),
    chatCommand({ status: "proposed" }),
    chatCommand({ status: "ran", exitCode: 0, output: "submitted" }),
  ],
  [
    metaLine({ ticketId: "a" }),
    chatPrompt(),
    chatTurnStart(),
    toolStartId("c1", "bash", { command: "ls" }),
  ], // live, provisional
  // Two chat turns with a steer prompt, a provisional call confirmed by
  // turn_end, and a command whose terminal record lands in a LATER run.
  [
    metaLine({ ticketId: "b" }),
    chatPrompt({ text: "first" }),
    chatTurnStart(),
    chatPrompt({ text: "steer", mode: "steer" }),
    toolStartId("c1", "grep", { q: "x" }),
    turnEndFull({ thinking: "t", text: "a", calls: [{ id: "c1", name: "grep", args: {} }] }),
    chatDraft(),
    chatCommand({ status: "proposed" }),
    chatTurnEnd(),
    chatCommand({ status: "expired" }),
    chatPrompt({ text: "second" }),
    chatTurnStart(),
    compactionStart(),
    compactionEnd(),
    chatTurnRejected(),
    chatReset(),
    turnEndFull({ text: "b" }),
    chatTurnEnd({ status: "error", errorMessage: "boom" }),
  ],
  // v1 (unframed) run, a truncating run_start, guard decisions, invalid lines.
  [
    agentStart(),
    toolStartId("c1", "bash", { command: "ls" }),
    turnEnd(),
    agentEnd(),
    "not json",
    "",
    runStart({ flow: "qa" }),
    guardDecision(),
    toolStartId("c2", "bash", { command: "ls" }),
    runStart({ flow: "assess" }),
    toolStartId("c3", "read", { path: "y" }),
  ],
  // A note before any run: a prompt-less closed chat run.
  [chatDraft(), chatCommand({ status: "proposed" }), chatCommand({ status: "declined" })],
];

describe("extendSummary (spec 2026-09-06 §3.3)", () => {
  it("equals summarizeTranscript at every prefix of every fixture", () => {
    for (const lines of CASES) {
      let summary: TranscriptSummary | null = null;
      let state: SummaryState | null = null;
      for (let i = 0; i < lines.length; i++) {
        ({ summary, state } = extendSummary(summary, state, lines[i]!));
        expect(summary).toEqual(summarizeTranscript(lines.slice(0, i + 1)));
      }
    }
  });

  it("does not mutate a previously returned summary", () => {
    for (const lines of CASES) {
      let summary: TranscriptSummary | null = null;
      let state: SummaryState | null = null;
      const returned: { at: number; snapshot: TranscriptSummary; ref: TranscriptSummary }[] = [];
      for (let i = 0; i < lines.length; i++) {
        ({ summary, state } = extendSummary(summary, state, lines[i]!));
        returned.push({ at: i + 1, snapshot: structuredClone(summary), ref: summary });
      }
      for (const r of returned) {
        expect(r.ref).toEqual(r.snapshot);
        expect(r.ref).toEqual(summarizeTranscript(lines.slice(0, r.at)));
      }
    }
  });

  it("reads the live provisional tail without pushing it into the builder", () => {
    const lines = CASES[4]!;
    let summary: TranscriptSummary | null = null;
    let state: SummaryState | null = null;
    for (const l of lines) ({ summary, state } = extendSummary(summary, state, l));
    expect(summary!.live).toBe(true);
    expect(summary!.runs[0]!.turns).toHaveLength(1);
    expect(summary!.runs[0]!.turns[0]!.provisional).toBe(true);
    // Asking for the summary again (no new line) must not duplicate the tail.
    const again = extendSummary(summary, state, "").summary;
    expect(again).toEqual(summary);
    // Confirming the call with a turn_end replaces the tail, not appends to it.
    const confirmed = extendSummary(
      again,
      state,
      turnEndFull({ text: "done", calls: [{ id: "c1", name: "bash", args: {}, result: "x" }] }),
    ).summary;
    expect(confirmed.runs[0]!.turns).toHaveLength(1);
    expect(confirmed.runs[0]!.turns[0]!.provisional).toBe(false);
    expect(confirmed.runs[0]!.toolCallCount).toBe(1);
  });

  it("starts from nothing when handed a null state", () => {
    const { summary, state } = extendSummary(null, null, metaLine({ ticketId: "z" }));
    expect(summary.ticketId).toBe("z");
    expect(state).not.toBeNull();
    expect(summary).toEqual(summarizeTranscript([metaLine({ ticketId: "z" })]));
  });
});
