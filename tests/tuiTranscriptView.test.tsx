import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { TranscriptView } from "../src/tui/components/TranscriptView.js";
import type { TranscriptState } from "../src/tui/hooks/useTranscript.js";
import { summarizeTranscript } from "../src/transcriptSummary.js";
import { agentStart, runEnd, runStart, turnEndFull } from "./helpers/transcriptFixtures.js";

const state = (over: Partial<TranscriptState> = {}): TranscriptState => ({
  id: "t-1",
  path: null,
  expectLive: false,
  loading: false,
  error: null,
  size: 1,
  summary: null,
  showThinking: false,
  follow: false,
  cursor: 0,
  expanded: new Set(),
  ...over,
});

const SMALL = summarizeTranscript([
  runStart({ flow: "assess", modelId: "m", ts: "2026-08-29T01:02:47.000Z" }),
  agentStart(),
  turnEndFull({
    thinking: "deep",
    text: "hello world",
    calls: [{ id: "c1", name: "read", args: { path: "a.ts" }, result: "L1\nL2" }],
  }),
  runEnd({ stopReason: "stop", durationMs: 5000 }),
]);

/** 30 turns, one tool call each — more rows than any test viewport. */
const BIG = summarizeTranscript([
  runStart(),
  agentStart(),
  ...Array.from({ length: 30 }, (_, i) =>
    turnEndFull({
      text: `t${i + 1}`,
      calls: [{ id: `c${i + 1}`, name: "read", args: { path: `f${i + 1}` }, result: "x" }],
    }),
  ),
  runEnd(),
]);

const frame = (
  s: TranscriptState,
  over: { scroll?: number; height?: number; width?: number } = {},
): string =>
  render(
    <TranscriptView
      state={s}
      scroll={over.scroll ?? 0}
      height={over.height ?? 14}
      width={over.width ?? 70}
      focused
    />,
  ).lastFrame() ?? "";

describe("TranscriptView", () => {
  it("header: id, run count, outcome", () => {
    expect(frame(state({ summary: SMALL }))).toContain("transcript · t-1 · 1 run · stop · 5s");
  });

  it("header states: loading, waiting (live open), error", () => {
    expect(frame(state({ loading: true }))).toContain("loading…");
    expect(frame(state({ expectLive: true }))).toContain("waiting for the agent to start…");
    expect(frame(state({ error: "no transcript for t-1" }))).toContain("no transcript for t-1");
  });

  it("rows: tool line, prose; thinking only when toggled; expansion inline", () => {
    const f = frame(state({ summary: SMALL }));
    expect(f).toContain("▸ read a.ts  → 2 lines");
    expect(f).toContain("hello world");
    expect(f).not.toContain("deep");
    expect(frame(state({ summary: SMALL, showThinking: true }))).toContain("deep");
    const x = frame(state({ summary: SMALL, expanded: new Set(["c1"]) }));
    expect(x).toContain("L1");
    expect(x).toContain("L2");
  });

  it("cursor gutter marks the anchored tool row; footer shows the visible range", () => {
    const f = frame(state({ summary: SMALL }));
    const line = f.split("\n").find((l) => l.includes("▸ read a.ts"))!;
    expect(line).toContain("▌");
    expect(f).toMatch(/1–\d+\/\d+/);
    expect(f).toContain("t thinking");
    expect(f).not.toContain("f follow"); // not live
  });

  it("follow pins the viewport to the tail", () => {
    const f = frame(state({ summary: BIG, follow: true }), { height: 12 });
    expect(f).toContain("t30");
    expect(f).not.toContain("▸ read f1 ");
  });

  it("cursor past the fold nudges the window so its row is visible", () => {
    const f = frame(state({ summary: BIG, cursor: 29 }), { height: 12 });
    expect(f).toContain("▸ read f30");
    expect(f).not.toContain("▸ read f1 ");
  });

  it("live: footer offers f follow and the header reads ◐ live", () => {
    const live = summarizeTranscript([runStart(), agentStart(), turnEndFull({ text: "go" })]);
    const f = frame(state({ summary: live, expectLive: true, follow: true }));
    expect(f).toContain("◐ live · follow");
    expect(f).toContain("f follow");
  });
});
