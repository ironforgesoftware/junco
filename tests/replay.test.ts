import { describe, it, expect } from "vitest";
import { replayTranscript } from "../src/agent/replay.js";
import {
  agentEnd,
  guardDecision,
  metaLine,
  msgEnd,
  msgEndBlocks,
  msgStart,
  repetitiveText,
  runEnd,
  runStart,
  toolLoopStream,
  TOOL_LOOP_TRIP_TURN,
  turnEnd,
} from "./helpers/transcriptFixtures.js";

/**
 * Replay engine contracts. Every fixture is a recorded JSONL transcript as a
 * `string[]`; the engine re-runs it through a FRESH GuardManager per run and
 * reports what the guards would decide today.
 *
 * Guard thresholds the fixtures are built against (src/agent/guards.ts):
 *   - ToolCallLoopGuard: bash threshold 3 (DEFAULT_TOOL_LOOP_THRESHOLDS).
 *   - RepetitionGuard: minChars 1000, window 2000, probe 200, threshold 4.
 *   - OutputBudgetGuard: 12000 pre-commit tokens per turn (GuardManager default).
 *   - Supervisor: budgetPerKind 1 → the first trip of a kind nudges, the next kills.
 */
describe("replayTranscript", () => {
  it("replays a tool-call loop into a nudge decision", () => {
    const lines = toolLoopStream();
    const report = replayTranscript(lines, { guard: {} });

    expect(report.version).toBe(1);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].replayed).toHaveLength(1);
    const { decision, lineIndex, runIndex } = report.runs[0].replayed[0];
    expect(decision.action).toBe("nudge");
    expect(decision.kind).toBe("tool_call_loop");
    expect(decision.turnIndex).toBe(TOOL_LOOP_TRIP_TURN);
    // The third tool_execution_start is line 6 (three lines per turn).
    expect(lineIndex).toBe(6);
    expect(runIndex).toBe(0);
    expect(report.runs[0].stoppedAtKill).toBe(false);
    expect(report.invalidLines).toBe(0);
  });

  it("flips the same stream to a kill under a what-if policy", () => {
    const lines = toolLoopStream();
    const report = replayTranscript(lines, { guard: { supervisorConfig: { budgetPerKind: 0 } } });

    expect(report.runs[0].replayed).toHaveLength(1);
    expect(report.runs[0].replayed[0].decision.action).toBe("kill");
    expect(report.runs[0].replayed[0].decision.kind).toBe("tool_call_loop");
    expect(report.runs[0].stoppedAtKill).toBe(true);
  });

  it("trips the rep guard from a message_end text block (no deltas recorded)", () => {
    const lines = [msgStart(), msgEnd(repetitiveText())];
    const report = replayTranscript(lines, { guard: {} });

    expect(report.runs[0].replayed).toHaveLength(1);
    const d = report.runs[0].replayed[0].decision;
    expect(d.kind).toBe("text_rep");
    expect(d.action).toBe("nudge");
    expect(report.runs[0].replayed[0].lineIndex).toBe(1);
  });

  it("trips the rep guard from a message_end thinking block", () => {
    const lines = [msgStart(), msgEndBlocks([{ type: "thinking", thinking: repetitiveText() }])];
    const report = replayTranscript(lines, { guard: {} });

    expect(report.runs[0].replayed).toHaveLength(1);
    expect(report.runs[0].replayed[0].decision.kind).toBe("thinking_rep");
  });

  it("stops synthesizing a message's remaining blocks after a kill", () => {
    // budgetPerKind 0 → every trip kills. Without the mid-message gate the
    // thinking block would produce a second decision from the same line.
    const lines = [
      msgStart(),
      msgEndBlocks([
        { type: "text", text: repetitiveText() },
        { type: "thinking", thinking: repetitiveText() },
      ]),
    ];
    const report = replayTranscript(lines, { guard: { supervisorConfig: { budgetPerKind: 0 } } });

    expect(report.runs[0].replayed).toHaveLength(1);
    expect(report.runs[0].replayed[0].decision.kind).toBe("text_rep");
    expect(report.runs[0].stoppedAtKill).toBe(true);
  });

  it("ignores non-assistant messages, unknown blocks, and non-repetitive text", () => {
    const lines = [
      msgEndBlocks([{ type: "text", text: repetitiveText() }], "user"),
      msgEndBlocks([{ type: "image", source: "x" }]),
      msgEnd("a short, harmless answer"),
    ];
    const report = replayTranscript(lines, { guard: {} });

    expect(report.runs[0].replayed).toHaveLength(0);
  });

  it("stops feeding the guard manager after a kill (mirrors session.ts's killReason gate)", () => {
    // output_budget always kills; the tool loop that follows would trip too.
    const lines = [turnEnd(999_999), ...toolLoopStream()];
    const report = replayTranscript(lines, { guard: {} });

    expect(report.runs[0].replayed).toHaveLength(1);
    const d = report.runs[0].replayed[0].decision;
    expect(d.action).toBe("kill");
    expect(d.kind).toBe("output_budget");
    expect(report.runs[0].stoppedAtKill).toBe(true);
  });

  it("infers v1 run boundaries from agent_end, with a fresh guard manager per run", () => {
    const lines = [...toolLoopStream(), agentEnd(), ...toolLoopStream()];
    const report = replayTranscript(lines, { guard: {} });

    expect(report.version).toBe(1);
    expect(report.runs).toHaveLength(2);
    for (const run of report.runs) {
      expect(run.replayed).toHaveLength(1);
      // Fresh supervisor state per run: the second loop nudges again rather
      // than escalating to "nudge ignored".
      expect(run.replayed[0].decision.action).toBe("nudge");
      expect(run.replayed[0].decision.kind).toBe("tool_call_loop");
      expect(run.start).toBeUndefined();
    }
    expect(report.runs[1].replayed[0].runIndex).toBe(1);
    expect(report.caveats).toContain("v1 transcript: run boundaries inferred from agent_end");
  });

  it("frames v2 runs on junco_run_start/run_end and compares recorded vs replayed", () => {
    const loop = toolLoopStream();
    const lines = [
      metaLine(),
      runStart({ flow: "pr" }),
      ...loop.slice(0, 7), // through the tripping tool_execution_start
      guardDecision({ turnIndex: TOOL_LOOP_TRIP_TURN }),
      ...loop.slice(7),
      agentEnd(),
      runEnd({ stopReason: "end_turn" }),
    ];
    const report = replayTranscript(lines, { guard: {} });

    expect(report.version).toBe(2);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].start?.flow).toBe("pr");
    expect(report.runs[0].end?.stopReason).toBe("end_turn");
    expect(report.runs[0].recorded).toHaveLength(1);
    expect(report.runs[0].replayed).toHaveLength(1);
    expect(report.identical).toBe(true);
    // agent_end is NOT a v2 boundary — run_start is.
    expect(report.caveats).not.toContain("v1 transcript: run boundaries inferred from agent_end");
  });

  it("reports identical:false when a what-if policy diverges, keeping the recorded decision", () => {
    const loop = toolLoopStream();
    const lines = [
      runStart(),
      ...loop.slice(0, 7),
      guardDecision({ turnIndex: TOOL_LOOP_TRIP_TURN }),
      ...loop.slice(7),
      runEnd(),
    ];
    const report = replayTranscript(lines, {
      guard: { supervisorConfig: { budgetPerKind: 0 } },
    });

    expect(report.identical).toBe(false);
    // The recorded decision is collected, never fed to the GuardManager.
    expect(report.runs[0].recorded).toHaveLength(1);
    expect(report.runs[0].recorded[0].action).toBe("nudge");
    expect(report.runs[0].replayed).toHaveLength(1);
    expect(report.runs[0].replayed[0].decision.action).toBe("kill");
  });

  it("counts a length mismatch between recorded and replayed as not identical", () => {
    const lines = [runStart(), ...toolLoopStream(), runEnd()];
    const report = replayTranscript(lines, { guard: {} });

    expect(report.runs[0].recorded).toHaveLength(0);
    expect(report.runs[0].replayed).toHaveLength(1);
    expect(report.identical).toBe(false);
  });

  it("counts invalid lines without aborting the replay", () => {
    const loop = toolLoopStream();
    const lines = [
      ...loop.slice(0, 3),
      '{"type":"tool_execu', // truncated by a crash mid-write
      ...loop.slice(3),
      "", // a trailing newline in the file: not a malformed record
    ];
    const report = replayTranscript(lines, { guard: {} });

    expect(report.invalidLines).toBe(1);
    expect(report.runs[0].replayed).toHaveLength(1);
    expect(report.runs[0].replayed[0].decision.kind).toBe("tool_call_loop");
  });

  it("keys the version on junco_run_start, not junco_meta", () => {
    // A pre-v2 file appended to after the upgrade: run records, no meta header.
    const headerless = replayTranscript([runStart(), ...toolLoopStream(), runEnd()], { guard: {} });
    expect(headerless.version).toBe(2);
    expect(headerless.runs[0].start).toBeDefined();

    // Meta alone is informational — it never makes a transcript v2.
    const metaOnly = replayTranscript([metaLine(), ...toolLoopStream()], { guard: {} });
    expect(metaOnly.version).toBe(1);
    expect(metaOnly.runs).toHaveLength(1);
    expect(metaOnly.runs[0].start).toBeUndefined();
  });

  it("closes an unframed run at agent_end even in a v2 transcript", () => {
    // A pre-v2 file appended to after the upgrade: two unframed runs (no meta,
    // no run_start), then a v2-framed one. Without the unframed-run boundary
    // the two prefix loops would share a GuardManager and the second would
    // escalate to a "nudge ignored" kill.
    const lines = [
      ...toolLoopStream(),
      agentEnd(),
      ...toolLoopStream(),
      agentEnd(),
      runStart(),
      ...toolLoopStream(),
      agentEnd(),
      runEnd(),
    ];
    const report = replayTranscript(lines, { guard: {} });

    expect(report.version).toBe(2);
    expect(report.runs).toHaveLength(3);
    expect(report.runs.map((r) => r.start === undefined)).toEqual([true, true, false]);
    for (const run of report.runs) {
      expect(run.replayed).toHaveLength(1);
      expect(run.replayed[0].decision.action).toBe("nudge");
      expect(run.stoppedAtKill).toBe(false);
    }
  });

  it("always reports the epistemic caveats", () => {
    const report = replayTranscript([runStart(), runEnd()], { guard: {} });

    expect(report.caveats).toHaveLength(2);
    expect(report.caveats.some((c) => c.includes("message-granular"))).toBe(true);
    expect(report.caveats.some((c) => c.includes("what-if"))).toBe(true);
  });

  it("handles an empty transcript", () => {
    const report = replayTranscript([], { guard: {} });

    expect(report.version).toBe(1);
    expect(report.runs).toHaveLength(0);
    expect(report.identical).toBe(true);
    expect(report.invalidLines).toBe(0);
  });

  it("ignores a junco_run_end with no open run", () => {
    // Only reachable from a damaged file (its run_start truncated) — the record
    // is dropped rather than conjuring a run that never produced events.
    const report = replayTranscript([runEnd()], { guard: {} });

    expect(report.runs).toHaveLength(0);
    expect(report.identical).toBe(true);
  });

  it("attaches a guard decision recorded before any run to an implicit run", () => {
    const report = replayTranscript([guardDecision(), agentEnd()], { guard: {} });

    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].recorded).toHaveLength(1);
    expect(report.runs[0].replayed).toHaveLength(0);
  });
});
