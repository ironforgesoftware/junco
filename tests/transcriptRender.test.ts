import { describe, it, expect } from "vitest";
import {
  fmtRunOutcome,
  fmtToolCall,
  fmtToolResult,
  renderTranscriptRows,
  wrapText,
  TOOL_BODY_MAX_LINES,
} from "../src/transcriptRender.js";
import { commandAnchor, summarizeTranscript, type RunSummary } from "../src/transcriptSummary.js";
import {
  agentEnd,
  agentStart,
  chatDraft,
  chatPrompt,
  chatReset,
  chatTurnEnd,
  chatTurnRejected,
  chatTurnStart,
  compactionEnd,
  compactionStart,
  guardDecision,
  j,
  metaLine,
  runEnd,
  runStart,
  toolStartId,
  turnEndFull,
  v2RunLines as v2Lines,
} from "./helpers/transcriptFixtures.js";

const opts = (over: { width?: number; pinned?: boolean; expanded?: Set<string> } = {}) => ({
  width: over.width ?? 80,
  pinned: over.pinned ?? false,
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
  prompt: null,
  notes: [],
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
  it("a chat turn's aborted:<reason> stopReason renders as 'aborted (<reason>)' with warn tone", () => {
    const r = run({
      end: { ...run().end!, stopReason: "aborted:timeout", durationMs: 5000, usage: null },
    });
    expect(fmtRunOutcome(r, false)).toEqual({ text: "aborted (timeout) · 5s", tone: "warn" });
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
      // The recorded run carries the internal flow id "assess" (transcriptSchema.ts's
      // FlowKind, unchanged data) — the header renders it as "audit", the CLI verb
      // that now produces these runs (same display-mapping pattern as fmtQueueKind).
      text: "── run 1/1 · audit · local/m · 01:02:47 · stop · 11m07s · in 1 out 1 ──",
      tone: "bold",
    });
    expect(rows.map((r) => r.text)).toContain("turn 1 · in 1.8k out 85");
    expect(rows.map((r) => r.text)).toContain("  Assessment complete.");
    // Spec 2026-09-06 §4.4: the finished tool row is the same card the live
    // turn showed — header with the done glyph, one dim summary row under it.
    const at = rows.findIndex((r) => r.anchor === "c1");
    expect(rows[at]).toEqual({ text: "  ▸ read game.js  ✓", anchor: "c1" });
    expect(rows[at + 1]).toEqual({ text: "    → 3 lines", tone: "dim" });
    // Two anchored rows: the tool call and the thinking header (spec
    // 2026-09-06 §4.3) — the latter is not in toolCallIds' cursor space.
    expect(rows.filter((r) => r.anchor !== undefined).map((r) => r.anchor)).toEqual([
      "think:0:0",
      "c1",
    ]);
    expect(rows.some((r) => r.text.includes("deep thoughts"))).toBe(false);
  });

  it("maps the recorded flow id to its current CLI verb for display (M-2)", () => {
    const rowsAnalyze = renderTranscriptRows(
      summarizeTranscript([
        runStart({ flow: "analyze", modelId: "local/m", ts: "2026-08-29T01:02:47.000Z" }),
        runEnd({ stopReason: "stop", durationMs: 1000 }),
      ]),
      opts(),
    );
    expect(rowsAnalyze[0]?.text).toContain(" · investigate · ");
    // A flow untouched by the rename (e.g. "pr") passes through unchanged.
    const rowsPr = renderTranscriptRows(
      summarizeTranscript([
        runStart({ flow: "pr", modelId: "local/m", ts: "2026-08-29T01:02:47.000Z" }),
        runEnd({ stopReason: "stop", durationMs: 1000 }),
      ]),
      opts(),
    );
    expect(rowsPr[0]?.text).toContain(" · pr · ");
  });

  // Spec 2026-09-06 §4.3: the thinking block is a header row (collapsed unless
  // pinned) that carries its own anchor, and — when the run has exactly one
  // turn and a known duration — the run's duration, since a turn has none of
  // its own.
  it("unpinned: a collapsed `▸ thinking · <dur>` header with an anchor and no body", () => {
    const rows = renderTranscriptRows(done(), opts());
    const head = rows.find((r) => r.anchor === "think:0:0")!;
    expect(head.text).toBe("  ▸ thinking · 11m07s");
    expect(rows.some((r) => r.text.includes("deep thoughts"))).toBe(false);
    const ti = rows.indexOf(head);
    expect(rows.findIndex((r) => r.text === "turn 1 · in 1.8k out 85")).toBeLessThan(ti);
    expect(rows.findIndex((r) => r.text === "  Assessment complete.")).toBeGreaterThan(ti);
  });

  it("pinned: `▾ thinking · <dur>` then the body in tone thinking, indented under it", () => {
    const rows = renderTranscriptRows(done(), opts({ pinned: true }));
    const ti = rows.findIndex((r) => r.anchor === "think:0:0");
    expect(rows[ti].text).toBe("  ▾ thinking · 11m07s");
    expect(rows[ti + 1]).toEqual({ text: "    deep thoughts", tone: "thinking" });
    expect(rows.findIndex((r) => r.text === "  Assessment complete.")).toBeGreaterThan(ti + 1);
  });

  it("the duration is omitted when the run has more than one turn or no end", () => {
    const two = summarizeTranscript([
      runStart({ flow: "assess", modelId: "local/m", ts: "2026-08-29T01:02:47.000Z" }),
      agentStart(),
      turnEndFull({ thinking: "first", text: "a", calls: [] }),
      turnEndFull({ thinking: "second", text: "b", calls: [] }),
      runEnd({ stopReason: "stop", durationMs: 667_000 }),
    ]);
    const rows = renderTranscriptRows(two, opts());
    expect(rows.find((r) => r.anchor === "think:0:0")?.text).toBe("  ▸ thinking");
    expect(rows.find((r) => r.anchor === "think:0:1")?.text).toBe("  ▸ thinking");
    const open = summarizeTranscript([
      runStart({ flow: "assess", modelId: "local/m", ts: "2026-08-29T01:02:47.000Z" }),
      agentStart(),
      turnEndFull({ thinking: "only", text: "a", calls: [] }),
    ]);
    expect(renderTranscriptRows(open, opts()).find((r) => r.anchor === "think:0:0")?.text).toBe(
      "  ▸ thinking",
    );
  });

  it("a turn with no thinking shows no header at all", () => {
    const rows = renderTranscriptRows(
      summarizeTranscript([
        runStart(),
        agentStart(),
        turnEndFull({ thinking: null, text: "plain", calls: [] }),
        runEnd(),
      ]),
      opts({ pinned: true }),
    );
    expect(rows.some((r) => r.text.includes("thinking"))).toBe(false);
    expect(rows.some((r) => r.anchor?.startsWith("think:"))).toBe(false);
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
    // No result yet: the header carries `…` and the summary row says so.
    const at = rows.findIndex((r) => r.anchor === "c2");
    expect(rows[at]?.text).toBe("  ▸ read a  …");
    expect(rows[at + 1]).toEqual({ text: "    → …", tone: "dim" });
  });

  it("an errored tool call: header in the error tone, body open by default; expanding it collapses", () => {
    const s = summarizeTranscript([
      runStart(),
      turnEndFull({
        calls: [
          {
            id: "e1",
            name: "read",
            args: { path: "nope" },
            result: "ENOENT: nope\nx",
            isError: true,
          },
        ],
      }),
      runEnd(),
    ]);
    const rows = renderTranscriptRows(s, opts());
    const at = rows.findIndex((r) => r.anchor === "e1");
    expect(rows[at]).toEqual({ text: "  ▸ read nope  ✗", tone: "error", anchor: "e1" });
    expect(rows.slice(at + 1, at + 3).map((r) => [r.text, r.tone])).toEqual([
      ["      ENOENT: nope", "dim"],
      ["      x", "dim"],
    ]);
    // `expanded` is a toggle against the card's default: an error card
    // toggled once shows only its summary row.
    const folded = renderTranscriptRows(s, opts({ expanded: new Set(["e1"]) }));
    const fat = folded.findIndex((r) => r.anchor === "e1");
    expect(folded[fat + 1]).toEqual({ text: "    → ✗ ENOENT: nope", tone: "dim" });
    expect(folded.map((r) => r.text)).not.toContain("      ENOENT: nope");
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
  const prose = (text?: string, thinking?: string, pinned = false) =>
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
      opts({ pinned }),
    )
      .slice(2)
      // The thinking header (spec 2026-09-06 §4.3) is not prose.
      .filter((r) => !r.anchor?.startsWith("think:"))
      .map((r) => r.text);

  it("collapses blank runs inside a block and drops its leading/trailing padding", () => {
    expect(prose("\n\nFiles match\n\n\n\nmore\n")).toEqual(["  Files match", "", "  more"]);
  });

  it("a block of only newlines renders no prose rows at all", () => {
    expect(prose("\n\n\n\n")).toEqual([]);
  });

  it("thinking is trimmed the same way", () => {
    expect(prose(undefined, "\n\nthought\n\n\n\ntwo\n", true)).toEqual([
      "    thought",
      "",
      "    two",
    ]);
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

describe("chat rows (spec 2026-09-01 §1.3)", () => {
  it("renders the prompt as a `you:` row before the run header and notes as rows; the draft note carries its anchor", () => {
    const s = summarizeTranscript([
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
      chatTurnRejected(),
    ]);
    const rows = renderTranscriptRows(s, opts({ width: 80 }));
    const texts = rows.map((r) => r.text);
    expect(texts[0]).toBe("you: why is the build slow?");
    expect(texts[1]).toMatch(/^── run 1\/1 · chat · local\/m1/);
    // The answer carries the other side's label, in the same tone as `you:`.
    const answer = rows.find((r) => r.text.startsWith("junco:"));
    expect(answer).toEqual({ text: "junco: because of X", tone: "accent" });
    const draftRow = rows.find((r) => r.anchor === "draft:acme__api-20260901-120000-1");
    expect(draftRow?.text).toContain("draft parked · ticket · add-cache");
    expect(
      rows.some((r) => r.text.includes("turn rejected: rate limited") && r.tone === "warn"),
    ).toBe(true);
  });
  // Spec 2026-09-06 §2.1 last paragraph / §4.3: the persisted turn keeps its
  // `<think>` tags (the splitter runs on the live stream only), so the finished
  // turn is split at render time and looks exactly like the live one did.
  it("a finished turn whose text still carries <think> tags is split at render time", () => {
    const s = summarizeTranscript([
      metaLine({ ticketId: "acme__api" }),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      turnEndFull({
        thinking: null,
        text: "<think>hmm\nmore</think>\nThe answer",
        calls: [],
        usage: { input: 3, output: 4 },
      }),
      agentEnd(),
      chatTurnEnd(),
    ]);
    const collapsed = renderTranscriptRows(s, opts({ width: 80 }));
    const head = collapsed.find((r) => r.anchor === "think:0:0")!;
    expect(head.text).toMatch(/^ {2}▸ thinking/);
    expect(collapsed.some((r) => r.text.includes("hmm"))).toBe(false);
    expect(collapsed.some((r) => r.text.includes("<think>"))).toBe(false);
    // The answer's leading newline (what followed the close tag) is trimmed.
    expect(collapsed.find((r) => r.text.startsWith("junco:"))).toEqual({
      text: "junco: The answer",
      tone: "accent",
    });
    const pinned = renderTranscriptRows(s, opts({ width: 80, pinned: true }));
    const ti = pinned.findIndex((r) => r.anchor === "think:0:0");
    expect(pinned[ti].text).toMatch(/^ {2}▾ thinking/);
    expect(pinned.slice(ti + 1, ti + 3)).toEqual([
      { text: "    hmm", tone: "thinking" },
      { text: "    more", tone: "thinking" },
    ]);
    expect(pinned.findIndex((r) => r.text === "junco: The answer")).toBeGreaterThan(ti + 2);
  });
  it("a ticket transcript renders byte-identically to before", () => {
    const before = renderTranscriptRows(summarizeTranscript(v2Lines()), opts({ width: 80 }));
    expect(before[0]!.text).toMatch(/^── run 1\/1 · audit/);
    expect(before.some((r) => r.text.startsWith("you:"))).toBe(false);
    expect(before.some((r) => r.text.startsWith("junco:"))).toBe(false); // chat-only labels
  });

  it("a multi-line chat answer is labelled on its first line only, and wraps under it", () => {
    const s = summarizeTranscript([
      metaLine({ ticketId: "acme__api" }),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      turnEndFull({ thinking: null, text: "first line\n\nsecond paragraph", calls: [] }),
      agentEnd(),
      chatTurnEnd(),
    ]);
    const texts = renderTranscriptRows(s, opts({ width: 80 })).map((r) => r.text);
    const at = texts.indexOf("junco: first line");
    expect(at).toBeGreaterThan(0);
    expect(texts.slice(at, at + 3)).toEqual(["junco: first line", "", "  second paragraph"]);
  });

  it("a tool-only chat turn (empty text) gets no bare label row", () => {
    // The live transcript's exploring turns carry text "" with tool calls —
    // labelling those printed a lone `junco:` above every ▸ row.
    const s = summarizeTranscript([
      metaLine({ ticketId: "acme__api" }),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      turnEndFull({
        thinking: null,
        text: "",
        calls: [{ id: "c1", name: "read", args: { path: "x" }, result: "ok" }],
      }),
      turnEndFull({ thinking: null, text: "done", calls: [] }),
      agentEnd(),
      chatTurnEnd(),
    ]);
    const texts = renderTranscriptRows(s, opts({ width: 80 })).map((r) => r.text);
    expect(texts.filter((t) => t.startsWith("junco:"))).toEqual(["junco: done"]);
  });
  it("a note landing before any run opens a synthetic, prompt-less run — its header is suppressed, only the note row renders (R23)", () => {
    const s = summarizeTranscript([metaLine(), chatTurnRejected()]);
    const rows = renderTranscriptRows(s, opts({ width: 80 }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain("turn rejected: rate limited");
    expect(rows.some((r) => r.text.startsWith("── run"))).toBe(false);
  });
  it("draft note text and tone vary by status; destination shown once submitted", () => {
    const s = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      agentEnd(),
      chatTurnEnd(),
      chatDraft({ status: "lint_failed" }),
      chatDraft({ status: "submitted", destination: "inbox" }),
      chatDraft({ status: "discarded" }),
    ]);
    const rows = renderTranscriptRows(s, opts({ width: 80 }));
    const draftRows = rows.filter((r) => r.anchor?.startsWith("draft:"));
    expect(draftRows.map((r) => r.tone)).toEqual(["warn", "success", "bold"]);
    expect(draftRows[0]!.text).toContain("draft parked (lint failed)");
    expect(draftRows[1]!.text).toContain("draft submitted → inbox");
    expect(draftRows[2]!.text).toContain("draft discarded");
  });
  it("session-reset and transcript-degraded notes render as warn rows", () => {
    const s = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      agentEnd(),
      chatTurnEnd(),
      chatReset({ reason: "missing" }),
      j({ type: "junco_chat_transcript_degraded", ts: "2026-09-01T00:00:00.000Z" }),
    ]);
    const rows = renderTranscriptRows(s, opts({ width: 80 }));
    expect(rows.some((r) => r.text.includes("session reset (missing)") && r.tone === "warn")).toBe(
      true,
    );
    expect(
      rows.some(
        (r) =>
          r.text.includes("transcript disabled — history will not survive a reconnect") &&
          r.tone === "warn",
      ),
    ).toBe(true);
  });
  it("compaction notes render distinct start/end text", () => {
    const s = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      compactionStart(),
      compactionEnd(),
    ]);
    const rows = renderTranscriptRows(s, opts({ width: 80 }));
    expect(rows.some((r) => r.text.includes("compacting context…"))).toBe(true);
    expect(rows.some((r) => r.text.includes("context compacted"))).toBe(true);
  });
});

describe("junco_chat_command rows", () => {
  const lines = (over: Record<string, unknown>, expanded: string[] = []) => {
    const s = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      JSON.stringify({
        type: "junco_chat_command",
        commandId: "call_1",
        command: "submit",
        draftId: "d1",
        ids: ["add-readme"],
        route: "inbox",
        status: "proposed",
        exitCode: null,
        output: null,
        detail: null,
        ts: "2026-09-03T10:00:00.000Z",
        ...over,
      }),
    ]);
    return renderTranscriptRows(s, opts({ width: 100, expanded: new Set(expanded) }));
  };
  const row = (rows: ReturnType<typeof lines>) =>
    rows.find((r) => r.anchor === commandAnchor("call_1"))!;

  it("renders one row per status, anchored, in the spec's tone", () => {
    expect(row(lines({}))).toMatchObject({
      text: "   ▸ submit add-readme → inbox — awaiting you · y submit · n keep parked",
      tone: "accent",
    });
    // #478: the window between the operator's `y` and the CLI's exit.
    expect(row(lines({ status: "running" }))).toMatchObject({
      text: "   \u25b8 submitting add-readme \u2192 inbox\u2026",
      tone: "accent",
    });
    expect(row(lines({ status: "ran", exitCode: 0, output: "ok" }))).toMatchObject({
      text: "   ✓ submitted → inbox · add-readme · exit 0",
      tone: "success",
    });
    expect(row(lines({ status: "failed", exitCode: 1, output: "boom" }))).toMatchObject({
      text: "   ✗ submit failed · exit 1 · add-readme — draft stays parked",
      tone: "error",
    });
    expect(row(lines({ status: "declined" }))).toEqual({
      text: "   – submit declined · add-readme · draft stays parked",
      tone: "dim",
      anchor: commandAnchor("call_1"),
    });
    expect(row(lines({ status: "expired", detail: "no decision in 10m" })).text).toBe(
      "   ⌛ submit expired · no decision in 10m · draft stays parked",
    );
    expect(row(lines({ status: "aborted" }))).toEqual({
      text: "   – submit aborted with the turn · add-readme · draft stays parked",
      tone: "dim",
      anchor: commandAnchor("call_1"),
    });
  });

  it("a ran row appends its detail — a queued-but-unarchived submit says so (#479)", () => {
    // `code 0` with a failed archive records `ran` WITH a detail; without it
    // the row reads as a clean success beside a draft card still marked parked.
    expect(
      row(
        lines({
          status: "ran",
          exitCode: 0,
          detail: "submitted, but the draft did not archive: EACCES",
        }),
      ).text,
    ).toBe(
      "   ✓ submitted → inbox · add-readme · exit 0 · submitted, but the draft did not archive: EACCES",
    );
  });

  it("a failed row shows its detail instead of the parked tail (final review #2c)", () => {
    // "draft stays parked" is a lie when the detail says the draft is gone —
    // and the detail is the only thing the row cannot infer from the record.
    expect(
      row(lines({ status: "failed", exitCode: null, detail: "draft no longer parked" })).text,
    ).toBe("   ✗ submit failed · exit ? · add-readme · draft no longer parked");
  });

  it("expands the CLI output under a ran/failed row, dim and indented", () => {
    const rows = lines({ status: "ran", exitCode: 0, output: "queued add-readme\ninbox: 1" }, [
      commandAnchor("call_1"),
    ]);
    const at = rows.findIndex((r) => r.anchor === commandAnchor("call_1"));
    expect(rows[at + 1]).toEqual({ text: "      queued add-readme", tone: "dim" });
    expect(rows[at + 2]).toEqual({ text: "      inbox: 1", tone: "dim" });
    // Not expanded → no output rows.
    expect(
      lines({ status: "ran", exitCode: 0, output: "x" }).some((r) => r.text.includes("      x")),
    ).toBe(false);
  });

  // A CLI that printed nothing still has an expandable body: `output: ""` is
  // "it ran and said nothing", which must not read as "not expandable yet".
  // (`null` — the non-ran statuses — has no body at all.)
  it("an expanded empty output says (no output); a null output has no body row", () => {
    const at = (rows: ReturnType<typeof lines>) =>
      rows.findIndex((r) => r.anchor === commandAnchor("call_1"));
    const empty = lines({ status: "ran", exitCode: 0, output: "" }, [commandAnchor("call_1")]);
    expect(empty[at(empty) + 1]).toEqual({ text: "      (no output)", tone: "dim" });
    const none = lines({ status: "declined" }, [commandAnchor("call_1")]);
    expect(none[at(none) + 1]?.text ?? "").not.toContain("(no output)");
  });
});

// Task 14 (spec 2026-09-06 §4.2): a chat answer is typeset as markdown on the
// dashboard (`markdown: true`); ticket transcripts and the `junco transcript`
// CLI (no flag) keep the plain prose rows — spec Non-goals.
describe("chat answers as markdown (spec 2026-09-06 §4.2)", () => {
  const MD = "# Title\n\nSome **bold** text\n\n- a\n- b\n\n```ts\nconst x = 1;\n```";
  const chatLines = (text: string) => [
    metaLine({ ticketId: "acme__api" }),
    chatPrompt(),
    chatTurnStart(),
    agentStart(),
    turnEndFull({ thinking: null, text, calls: [] }),
    agentEnd(),
    chatTurnEnd(),
  ];
  const fake = (code: string, lang: string | null) =>
    lang === null ? null : code.split("\n").map((l) => `<${lang}>${l}`);

  it("a chat run renders headings bold, lists bulleted and fences through the highlighter, indented under a lone label", () => {
    const rows = renderTranscriptRows(summarizeTranscript(chatLines(MD)), {
      ...opts({ width: 80 }),
      markdown: true,
      highlight: fake,
    });
    const at = rows.findIndex((r) => r.text === "junco:");
    expect(at).toBeGreaterThan(0);
    expect(rows[at]).toEqual({ text: "junco:", tone: "accent" });
    expect(rows[at + 1]).toEqual({ text: "  Title", tone: "bold" });
    const texts = rows.map((r) => r.text);
    expect(texts).toContain("  Some bold text");
    expect(texts).toContain("  • a");
    expect(texts).toContain("  • b");
    expect(texts).toContain("  <ts>const x = 1;");
    expect(texts.some((t) => t.includes("**"))).toBe(false);
  });

  it("a paragraph-first answer keeps the label on its first line, wrapped with it", () => {
    const rows = renderTranscriptRows(
      summarizeTranscript(chatLines("first line\n\nsecond paragraph")),
      { ...opts({ width: 80 }), markdown: true, highlight: null },
    );
    const texts = rows.map((r) => r.text);
    const at = texts.indexOf("junco: first line");
    expect(rows[at]?.tone).toBe("accent");
    expect(texts.slice(at, at + 3)).toEqual(["junco: first line", "", "  second paragraph"]);
  });

  it("without a highlighter a fence renders its raw lines", () => {
    const rows = renderTranscriptRows(summarizeTranscript(chatLines(MD)), {
      ...opts({ width: 80 }),
      markdown: true,
      highlight: null,
    });
    expect(rows.map((r) => r.text)).toContain("  const x = 1;");
  });

  it("the CLI path (no markdown flag) and a ticket run stay plain", () => {
    const cli = renderTranscriptRows(summarizeTranscript(chatLines(MD)), opts({ width: 80 }));
    expect(cli.map((r) => r.text)).toContain("junco: # Title");
    expect(cli.map((r) => r.text)).toContain("  Some **bold** text");
    const ticket = renderTranscriptRows(
      summarizeTranscript([
        metaLine(),
        runStart(),
        agentStart(),
        turnEndFull({ thinking: null, text: MD, calls: [] }),
        agentEnd(),
        runEnd(),
      ]),
      { ...opts({ width: 80 }), markdown: true, highlight: fake },
    );
    const texts = ticket.map((r) => r.text);
    expect(texts).toContain("  # Title");
    expect(texts).toContain("  Some **bold** text");
    expect(texts.some((t) => t.includes("<ts>"))).toBe(false);
  });

  it("the md cache hands back the same row objects for an unchanged turn", () => {
    const s = summarizeTranscript(chatLines(MD));
    const mdCache = new Map();
    const a = renderTranscriptRows(s, { ...opts(), markdown: true, highlight: fake, mdCache });
    const b = renderTranscriptRows(s, { ...opts(), markdown: true, highlight: fake, mdCache });
    const ia = a.findIndex((r) => r.text === "  Title");
    const ib = b.findIndex((r) => r.text === "  Title");
    expect(ia).toBeGreaterThan(0);
    expect(b[ib]).toBe(a[ia]);
    expect(mdCache.size).toBe(1);
  });
});
