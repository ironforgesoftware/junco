import { describe, it, expect } from "vitest";
import {
  fmtRunOutcome,
  fmtToolCall,
  fmtToolResult,
  renderTranscriptRows,
  wrapText,
  TOOL_BODY_MAX_LINES,
} from "../src/transcriptRender.js";
import { summarizeTranscript, type RunSummary } from "../src/transcriptSummary.js";
import {
  agentStart,
  guardDecision,
  runEnd,
  runStart,
  toolStartId,
  turnEndFull,
} from "./helpers/transcriptFixtures.js";

const opts = (over: { width?: number; showThinking?: boolean; expanded?: Set<string> } = {}) => ({
  width: over.width ?? 80,
  showThinking: over.showThinking ?? false,
  expanded: over.expanded ?? new Set<string>(),
});

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  index: 1,
  flow: "assess",
  modelId: "local/m",
  startedAt: "2026-08-29T01:02:47.000Z",
  end: {
    stopReason: "stop",
    errorMessage: null,
    timedOut: false,
    abortedByGuard: false,
    durationMs: 667_000,
    usage: { input: 34_699, output: 1_891, cacheRead: 0, total: 36_590, costUsd: 0 },
  },
  turns: [],
  guardDecisions: [],
  toolCallCount: 0,
  ...over,
});

const CALL = { id: "c1", name: "read", args: { path: "game.js" }, result: "L1\nL2\nL3" };

const done = () =>
  summarizeTranscript([
    runStart({ flow: "assess", modelId: "local/m", ts: "2026-08-29T01:02:47.000Z" }),
    agentStart(),
    turnEndFull({
      thinking: "deep thoughts",
      text: "Assessment complete.",
      calls: [CALL],
      usage: { input: 1812, output: 85 },
    }),
    runEnd({ stopReason: "stop", durationMs: 667_000 }),
  ]);

describe("fmtRunOutcome", () => {
  it("stop with duration and tokens", () => {
    expect(fmtRunOutcome(run(), false)).toEqual({
      text: "stop · 11m07s · in 34.7k out 1.9k",
      tone: "success",
    });
  });
  it("error / timeout / killed / live / truncated", () => {
    const e = run({
      end: { ...run().end!, stopReason: "error", errorMessage: "404", durationMs: 33, usage: null },
    });
    expect(fmtRunOutcome(e, false)).toEqual({ text: "error · 0s", tone: "error" });
    const t = run({ end: { ...run().end!, timedOut: true, durationMs: null, usage: null } });
    expect(fmtRunOutcome(t, false)).toEqual({ text: "timeout", tone: "warn" });
    const k = run({ end: { ...run().end!, abortedByGuard: true, durationMs: null, usage: null } });
    expect(fmtRunOutcome(k, false)).toEqual({ text: "killed by guard", tone: "warn" });
    expect(fmtRunOutcome(run({ end: null }), true)).toEqual({ text: "◐ running…", tone: "accent" });
    expect(fmtRunOutcome(run({ end: null }), false)).toEqual({ text: "truncated", tone: "warn" });
  });
  it("abortedByGuard with errorMessage renders as killed by guard with warn tone", () => {
    const r = run({
      end: {
        ...run().end!,
        abortedByGuard: true,
        errorMessage: "boom",
        durationMs: null,
        usage: null,
      },
    });
    expect(fmtRunOutcome(r, false)).toEqual({ text: "killed by guard", tone: "warn" });
  });
  it("timedOut with errorMessage renders as timeout with warn tone", () => {
    const r = run({
      end: {
        ...run().end!,
        timedOut: true,
        errorMessage: "connection lost",
        durationMs: null,
        usage: null,
      },
    });
    expect(fmtRunOutcome(r, false)).toEqual({ text: "timeout", tone: "warn" });
  });
});

describe("fmtToolCall / fmtToolResult", () => {
  it("shows the identifying argument per tool family", () => {
    expect(fmtToolCall("read", { path: "src/a.ts" }, 80)).toBe("read src/a.ts");
    expect(fmtToolCall("bash", { command: "npm test\necho done" }, 80)).toBe("bash npm test");
    expect(fmtToolCall("grep", { pattern: "foo", path: "src" }, 80)).toBe("grep foo in src");
    expect(fmtToolCall("find", { pattern: "**/*" }, 80)).toBe("find **/*");
    expect(fmtToolCall("todo_write", { items: [1] }, 80)).toBe('todo_write {"items":[1]}');
  });
  it("truncates to width with an ellipsis", () => {
    const s = fmtToolCall("read", { path: "x".repeat(100) }, 20);
    expect(s).toHaveLength(20);
    expect(s.endsWith("…")).toBe(true);
  });
  it("result states", () => {
    expect(fmtToolResult(null)).toBe("→ …");
    expect(fmtToolResult({ text: "", lines: 0, isError: false })).toBe("→ empty");
    expect(fmtToolResult({ text: "a", lines: 1, isError: false })).toBe("→ 1 line");
    expect(fmtToolResult({ text: "a\nb", lines: 2, isError: false })).toBe("→ 2 lines");
    expect(fmtToolResult({ text: "ENOENT: no such file\nmore", lines: 2, isError: true })).toBe(
      "→ ✗ ENOENT: no such file",
    );
  });
});

describe("wrapText", () => {
  it("wraps on spaces, hard-splits long tokens, keeps blank lines", () => {
    expect(wrapText("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
});

describe("renderTranscriptRows", () => {
  it("header, turn line, prose, tool row with anchor; thinking hidden by default", () => {
    const rows = renderTranscriptRows(done(), opts());
    expect(rows[0]).toEqual({
      text: "── run 1/1 · assess · local/m · 01:02:47 · stop · 11m07s · in 1 out 1 ──",
      tone: "bold",
    });
    expect(rows.map((r) => r.text)).toContain("turn 1 · in 1.8k out 85");
    expect(rows.map((r) => r.text)).toContain("  Assessment complete.");
    const tool = rows.find((r) => r.anchor === "c1")!;
    expect(tool.text).toBe("  ▸ read game.js  → 3 lines");
    expect(rows.filter((r) => r.anchor !== undefined)).toHaveLength(1);
    expect(rows.some((r) => r.text.includes("deep thoughts"))).toBe(false);
  });

  it("showThinking renders the thinking block dim, before the text", () => {
    const rows = renderTranscriptRows(done(), opts({ showThinking: true }));
    const i = rows.findIndex((r) => r.text === "  deep thoughts");
    expect(rows[i].tone).toBe("dim");
    expect(rows.findIndex((r) => r.text === "  Assessment complete.")).toBeGreaterThan(i);
  });

  it("expanded tool result renders its body dim under the tool row, capped", () => {
    const rows = renderTranscriptRows(done(), opts({ expanded: new Set(["c1"]) }));
    const i = rows.findIndex((r) => r.anchor === "c1");
    expect(rows.slice(i + 1, i + 4).map((r) => [r.text, r.tone])).toEqual([
      ["      L1", "dim"],
      ["      L2", "dim"],
      ["      L3", "dim"],
    ]);
    const big = summarizeTranscript([
      runStart(),
      turnEndFull({
        calls: [
          {
            id: "c9",
            name: "read",
            args: {},
            result: Array.from({ length: TOOL_BODY_MAX_LINES + 50 }, (_, k) => `l${k}`).join("\n"),
          },
        ],
      }),
      runEnd(),
    ]);
    const bigRows = renderTranscriptRows(big, opts({ expanded: new Set(["c9"]) }));
    expect(bigRows.filter((r) => /^ {6}l\d+$/.test(r.text))).toHaveLength(TOOL_BODY_MAX_LINES);
    expect(bigRows.at(-1)?.text).toBe("      … +50 more lines");
  });

  it("failed run: error line under the header; guard rows after their turn", () => {
    const s = summarizeTranscript([
      runStart(),
      agentStart(),
      turnEndFull({ text: "loop" }),
      guardDecision({
        turnIndex: 0,
        action: "nudge",
        kind: "tool_call_loop",
        detail: "tool=bash count=3",
      }),
      runEnd({ stopReason: "error", errorMessage: "404: Model 'x' not found\nsecond line" }),
    ]);
    const rows = renderTranscriptRows(s, opts());
    expect(rows[1]).toEqual({ text: "   ✗ 404: Model 'x' not found", tone: "error" });
    const turn = rows.findIndex((r) => r.text === "  loop");
    expect(rows[turn + 1]).toEqual({
      text: "   ⚑ guard nudge (tool_call_loop) at turn 1 — tool=bash count=3",
      tone: "warn",
    });
  });

  it("live: last run reads ◐ running… and a provisional turn is marked", () => {
    const s = summarizeTranscript([
      runStart(),
      agentStart(),
      toolStartId("c2", "read", { path: "a" }),
    ]);
    const rows = renderTranscriptRows(s, opts());
    expect(rows[0].text).toContain("◐ running…");
    expect(rows.map((r) => r.text)).toContain("turn 1 ◐");
    expect(rows.find((r) => r.anchor === "c2")?.text).toBe("  ▸ read a  → …");
  });

  it("never emits a row wider than width; blank row between runs", () => {
    const s = summarizeTranscript([
      runStart({ modelId: "m".repeat(120) }),
      agentStart(),
      turnEndFull({
        text: `${"word ".repeat(60)}${"x".repeat(90)}`,
        calls: [
          { id: "c1", name: "bash", args: { command: "y".repeat(200) }, result: "z".repeat(150) },
        ],
      }),
      runEnd(),
      runStart(),
      runEnd(),
    ]);
    const rows = renderTranscriptRows(s, opts({ width: 40, expanded: new Set(["c1"]) }));
    expect(rows.every((r) => r.text.length <= 40)).toBe(true);
    expect(rows.filter((r) => r.text === "")).toHaveLength(1);
    expect(rows.filter((r) => r.text.startsWith("── run 2/2")).length).toBe(1);
  });

  it("empty summary and invalid-line notice", () => {
    expect(renderTranscriptRows(summarizeTranscript([]), opts())).toEqual([
      { text: "no events recorded", tone: "dim" },
    ]);
    const rows = renderTranscriptRows(summarizeTranscript([runStart(), runEnd(), "{bad"]), opts());
    expect(rows[0]).toEqual({ text: "1 invalid line skipped", tone: "warn" });
  });

  it("width invariant at MIN_WIDTH with invalid line and error result", () => {
    const longErrorFirstLine = "x".repeat(80);
    const s = summarizeTranscript([
      runStart(),
      agentStart(),
      turnEndFull({
        calls: [{ id: "c1", name: "bash", args: { command: "fail" }, result: longErrorFirstLine }],
      }),
      runEnd(),
      "{bad",
    ]);
    const rows = renderTranscriptRows(s, opts({ width: 20 }));
    expect(rows.every((r) => r.text.length <= 20)).toBe(true);
    const toolRow = rows.find((r) => r.anchor === "c1");
    expect(toolRow).toBeDefined();
    expect(toolRow!.text.length).toBeLessThanOrEqual(20);
  });
});

// Real model output is newline-padded ('\n\nFiles match the spec…\n\n', and
// sometimes only newlines): 35–46% of the rows a real transcript rendered were
// blank before the renderer trimmed each block's edges.
describe("renderTranscriptRows — newline-padded model output", () => {
  /** rows[0] is the run header, rows[1] the turn line — the rest is prose. */
  const prose = (text?: string, thinking?: string, showThinking = false) =>
    renderTranscriptRows(
      summarizeTranscript([
        runStart(),
        agentStart(),
        turnEndFull({
          ...(text === undefined ? {} : { text }),
          ...(thinking === undefined ? {} : { thinking }),
        }),
        runEnd(),
      ]),
      opts({ showThinking }),
    )
      .slice(2)
      .map((r) => r.text);

  it("collapses blank runs inside a block and drops its leading/trailing padding", () => {
    expect(prose("\n\nFiles match\n\n\n\nmore\n")).toEqual(["  Files match", "", "  more"]);
  });

  it("a block of only newlines renders no prose rows at all", () => {
    expect(prose("\n\n\n\n")).toEqual([]);
  });

  it("thinking is trimmed the same way", () => {
    expect(prose(undefined, "\n\nthought\n\n\n\ntwo\n", true)).toEqual(["  thought", "", "  two"]);
    expect(prose(undefined, "\n\n\n", true)).toEqual([]);
  });

  it("a malformed run_end errorMessage never throws", () => {
    const s = summarizeTranscript([
      runStart(),
      agentStart(),
      runEnd({ stopReason: "error", errorMessage: 123 as unknown as string }),
    ]);
    const rows = renderTranscriptRows(s, opts());
    expect(rows.map((r) => r.text)).toContain("   ✗ 123");
  });
});
