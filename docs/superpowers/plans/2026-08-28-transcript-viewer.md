# Transcript Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a ticket's per-run event transcript readable from inside junco — a dashboard view opened with `enter` on any running/finished queue row (live-tailing while the ticket runs, with expandable tool results and a thinking toggle) and a `junco transcript <id>` CLI — over one pure summarize/render core.

**Architecture:** Two fs-free modules do all the work: `src/transcriptSummary.ts` reduces JSONL lines (via the existing `parseTranscriptLine`) to runs → turns → tool calls, and `src/transcriptRender.ts` turns that into width-bounded text rows with tones and tool-row anchors. The dashboard adds `DashboardClient.readTranscript` (stat-gated read), a `useTranscript` hook (state + live poll), a `TranscriptView` component (`CommandOutput`/`LogView` shape), a `"transcript"` view wired into App's nav spine and the mnemonic table, and makes RUNNING queue rows selectable. The CLI is `src/transcriptCmd.ts`, a mirror of `replayCmd.ts`.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), Ink + React (dashboard), vitest + ink-testing-library, `node:util` `parseArgs` (CLI).

**Spec:** `docs/superpowers/specs/2026-08-28-transcript-viewer-design.md`

## Global Constraints

- Work on branch `feat/transcript-viewer` in a worktree under `worktrees-manual/` (never `worktrees/`, never on the main checkout — it is the daemon's build home). Conventional commits; suite green at every commit; **no AI attribution trailers** (amend any `Co-Authored-By: Claude` away).
- `src/transcriptSummary.ts` and `src/transcriptRender.ts` are pure: no `node:fs`, no Pi SDK imports (type-only imports from `./agent/transcriptSchema.js` and `./types.js` are fine).
- Every side effect goes behind an injectable seam: `statFn`/`readFileFn` on `GhClientDeps`; `loadCfg`/`readFile`/`stdout`/`columns` on `TranscriptCmdDeps`.
- No new `Config` field, so `tests/helpers/config.ts` is untouched.
- `src/tui/**` runs `react-hooks/exhaustive-deps` at **error** — complete every dependency array; never `eslint-disable`.
- Ink/TUI tests: never assert one `setTimeout` tick after a state change; use `until(() => …)` from `tests/helpers/until.ts`.
- Transcript path resolution is `transcriptPathFor(dataTreePaths(cfg).transcripts, id)` (`src/slug.ts:38`, `src/dataTree.ts:106`) — the same call `replayCmd.ts:301` makes.
- Constants: poll cadence 1 000 ms, `TOOL_BODY_MAX_LINES = 400`, minimum render width 20.
- Prettier (100 cols) may reformat between read and edit: re-read before editing, run `npx prettier --write` on touched files before every commit. Run `npx vitest run <file>` with the exit code captured (`> /tmp/out 2>&1; echo "exit: $?"`) — never pipe vitest into grep/tail.

---

## File structure

| File                                          | Responsibility                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/transcriptSummary.ts` (new)              | JSONL lines → `TranscriptSummary` model; `toolCallIds()`                                                                                     |
| `src/transcriptRender.ts` (new)               | `TranscriptSummary` → `TranscriptRow[]`; `fmtToolCall`, `fmtToolResult`, `fmtRunOutcome`, `wrapText`                                         |
| `src/transcriptCmd.ts` (new)                  | `junco transcript` argv parsing, target resolution, output                                                                                   |
| `src/cli.ts`                                  | subcommand dispatch + help text + strict-parse option declarations                                                                           |
| `src/tui/ghClient.ts`                         | `readTranscript` (stat-gated read), `statFn` dep, `TranscriptRead` type                                                                      |
| `src/tui/hooks/useTranscript.ts` (new)        | `TranscriptState`, open/close/poll/cursor/expand/thinking/follow                                                                             |
| `src/tui/components/TranscriptView.tsx` (new) | the bordered view: header, rows + scrollbar, footer                                                                                          |
| `src/tui/components/QueueView.tsx`            | RUNNING rows join the selectable index space                                                                                                 |
| `src/tui/viewActions.ts`                      | `"transcript"` overlay view: verbs `thinking`/`follow`/close, structural chips; queue body gains `enter transcript`                          |
| `src/tui/App.tsx`                             | `View` member, hook, scroll key, crumbs, binding context, action handlers, input branch, render, `LocalRow` running kind, queue `enter`      |
| `src/tui/cliRunner.ts`                        | palette roster entry                                                                                                                         |
| `tests/helpers/transcriptFixtures.ts`         | new builders: `agentStart`, `toolStartId`, `toolEndId`, `turnEndFull`                                                                        |
| tests (new)                                   | `transcriptSummary.test.ts`, `transcriptRender.test.ts`, `useTranscript.test.tsx`, `tuiTranscriptView.test.tsx`, `transcriptCmd.test.ts`     |
| tests (modified)                              | `tuiGhClient.test.ts`, `tuiQueue.test.tsx`, `tuiViewActions.test.ts`, `tuiApp.test.tsx`, `tuiCliRunner.test.ts`, `helpers/localFixtures.tsx` |
| docs                                          | `ARCHITECTURE.md`, `README.md`, `docs/dashboard.md`, `docs/operations.md`, `CLAUDE.md`, `CHANGELOG.md`                                       |

---

### Task 0: Branch + worktree

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/alxedelweiss/Development/junco
git fetch origin
git worktree add worktrees-manual/transcript-viewer -b feat/transcript-viewer origin/main
cd worktrees-manual/transcript-viewer
npm ci
```

- [ ] **Step 2: Confirm the gate is green before touching anything**

Run: `npm run build > /tmp/out 2>&1; echo "exit: $?"` then `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`
Expected: both `exit: 0`.

---

### Task 1: `transcriptSummary.ts` — the pure model

**Files:**

- Create: `src/transcriptSummary.ts`
- Modify: `tests/helpers/transcriptFixtures.ts` (append four builders after `agentEnd`, line 48)
- Test: `tests/transcriptSummary.test.ts`

**Interfaces:**

- Consumes: `parseTranscriptLine`, `FlowKind`, `GuardDecisionRecord`, `RunStartRecord` from `src/agent/transcriptSchema.ts`; `Usage` from `src/types.ts`.
- Produces (used by Tasks 2–8):
  - `summarizeTranscript(lines: string[]): TranscriptSummary`
  - `toolCallIds(s: TranscriptSummary): string[]` — every tool call id in file order; the cursor index space.
  - types `TranscriptSummary`, `RunSummary`, `RunEnd`, `TurnSummary`, `ToolCallSummary`, `ToolResultSummary` exactly as written in Step 3.

- [ ] **Step 1: Add fixture builders**

Append to `tests/helpers/transcriptFixtures.ts` directly after the `agentEnd` line (line 48):

```ts
export const agentStart = (): string => j({ type: "agent_start" });

/** tool_execution_start with a caller-chosen id (the `c`-only builders above
 * predate result matching; the summary keys results by toolCallId). */
export const toolStartId = (id: string, name: string, args: unknown): string =>
  j({ type: "tool_execution_start", toolCallId: id, toolName: name, args });

export const toolEndId = (id: string, name: string, text: string, isError = false): string =>
  j({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: name,
    result: { content: [{ type: "text", text }] },
    isError,
  });

/** A complete assistant turn_end — thinking/text/toolCall content blocks plus
 * the turn's toolResults, the exact SDK shape the transcript viewer reduces. */
export const turnEndFull = (o: {
  thinking?: string;
  text?: string;
  calls?: { id: string; name: string; args: unknown; result?: string; isError?: boolean }[];
  usage?: { input: number; output: number };
}): string =>
  j({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [
        ...(o.thinking !== undefined ? [{ type: "thinking", thinking: o.thinking }] : []),
        ...(o.text !== undefined ? [{ type: "text", text: o.text }] : []),
        ...(o.calls ?? []).map((c) => ({
          type: "toolCall",
          id: c.id,
          name: c.name,
          arguments: c.args,
        })),
      ],
      usage: o.usage ?? { input: 1, output: 1 },
    },
    toolResults: (o.calls ?? [])
      .filter((c) => c.result !== undefined)
      .map((c) => ({
        role: "toolResult",
        toolCallId: c.id,
        toolName: c.name,
        content: [{ type: "text", text: c.result }],
        isError: c.isError ?? false,
      })),
  });
```

- [ ] **Step 2: Write the failing tests**

Create `tests/transcriptSummary.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/transcriptSummary.test.ts > /tmp/out 2>&1; echo "exit: $?"; head -20 /tmp/out`
Expected: `exit: 1` — "Failed to resolve import ../src/transcriptSummary.js".

- [ ] **Step 4: Implement**

Create `src/transcriptSummary.ts`:

```ts
/**
 * transcriptSummary — reduces a per-ticket JSONL transcript
 * (`<dataDir>/data/transcripts/<id>.jsonl`) to the model the transcript
 * viewer renders (transcriptRender.ts): runs → turns → tool calls with their
 * results. Pure by design, like transcriptSchema.ts: no fs, no Pi SDK —
 * `junco transcript` and the dashboard both hand it `string[]`.
 *
 * Run boundaries follow agent/replay.ts: a v2 run is framed by
 * `junco_run_start`/`junco_run_end`; an unframed (v1) run by
 * `agent_start`/`agent_end`. `turn_end` is the authoritative per-turn record
 * (SDK: `message.content` blocks + `toolResults[]`, matched by toolCallId);
 * `tool_execution_start/end` build a PROVISIONAL turn between turn_ends so a
 * live view shows activity as it happens and a crash-truncated file keeps its
 * partial last turn. `message_end` is ignored — for the assistant role it
 * duplicates turn_end and would double-count.
 */
import type { Usage } from "./types.js";
import {
  parseTranscriptLine,
  type FlowKind,
  type GuardDecisionRecord,
  type RunStartRecord,
} from "./agent/transcriptSchema.js";

export interface ToolResultSummary {
  /** Text blocks joined with "\n"; a non-text block renders as `[<type> block]`. */
  text: string;
  /** `text.split("\n").length`, 0 for "". */
  lines: number;
  isError: boolean;
}

export interface ToolCallSummary {
  /** toolCallId — the cursor/expand identity. */
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** null = not returned yet (live) or lost (truncated file). */
  result: ToolResultSummary | null;
}

export interface TurnSummary {
  /** 0-based; the guard records' `turnIndex` space. */
  index: number;
  /** Built from tool_execution_* after the last turn_end (no text/usage yet). */
  provisional: boolean;
  thinking: string | null;
  text: string | null;
  toolCalls: ToolCallSummary[];
  usage: { input: number; output: number } | null;
}

export interface RunEnd {
  stopReason: string | null;
  errorMessage: string | null;
  timedOut: boolean;
  abortedByGuard: boolean;
  /** null for the v1 agent_end fallback. */
  durationMs: number | null;
  /** null for v1. */
  usage: Usage | null;
}

export interface RunSummary {
  /** 1-based, for "run 2/4". */
  index: number;
  flow: FlowKind | null;
  modelId: string | null;
  startedAt: string | null;
  /** null while live, or for a run the next run_start closed (truncated). */
  end: RunEnd | null;
  turns: TurnSummary[];
  guardDecisions: GuardDecisionRecord[];
  toolCallCount: number;
}

export interface TranscriptSummary {
  ticketId: string | null;
  version: number | null;
  runs: RunSummary[];
  /** The last run has no end record — the file is still being written. */
  live: boolean;
  /** Torn/malformed lines skipped. */
  invalidLines: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Text of a tool result's content blocks — the shape shared by
 * `tool_execution_end.result.content` and `turn_end.toolResults[i].content`. */
function resultFromContent(content: unknown, isError: boolean): ToolResultSummary {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!isRecord(b)) continue;
      const text = str(b.text);
      parts.push(b.type === "text" && text !== null ? text : `[${str(b.type) ?? "unknown"} block]`);
    }
  } else if (typeof content === "string") {
    parts.push(content);
  }
  const text = parts.join("\n");
  return { text, lines: text === "" ? 0 : text.split("\n").length, isError };
}

function usageOf(v: unknown): { input: number; output: number } | null {
  if (!isRecord(v)) return null;
  const n = (x: unknown): number => (typeof x === "number" ? x : 0);
  return { input: n(v.input), output: n(v.output) };
}

const V1_END: RunEnd = {
  stopReason: null,
  errorMessage: null,
  timedOut: false,
  abortedByGuard: false,
  durationMs: null,
  usage: null,
};

export function summarizeTranscript(lines: string[]): TranscriptSummary {
  const out: TranscriptSummary = {
    ticketId: null,
    version: null,
    runs: [],
    live: false,
    invalidLines: 0,
  };
  // Reducer state lives on one object (not `let`s) so the closures below
  // never trip TS's captured-variable narrowing.
  const st: { open: RunSummary | null; framed: boolean; provisional: TurnSummary | null } = {
    open: null,
    framed: false, // opened by junco_run_start → agent_end must not close it
    provisional: null,
  };

  const closeRun = (end: RunEnd | null): void => {
    if (st.open === null) return;
    if (st.provisional !== null) st.open.turns.push(st.provisional);
    st.provisional = null;
    st.open.end = end;
    st.open = null;
  };
  const openRun = (start: RunStartRecord | null): RunSummary => {
    closeRun(null); // a run_start over an open run: the open one is truncated
    const run: RunSummary = {
      index: out.runs.length + 1,
      flow: start?.flow ?? null,
      modelId: start?.modelId ?? null,
      startedAt: start?.ts ?? null,
      end: null,
      turns: [],
      guardDecisions: [],
      toolCallCount: 0,
    };
    out.runs.push(run);
    st.open = run;
    st.framed = start !== null;
    return run;
  };
  const ensureRun = (): RunSummary => st.open ?? openRun(null);

  for (const line of lines) {
    if (line.trim() === "") continue;
    const p = parseTranscriptLine(line);
    if (p.kind === "invalid") {
      out.invalidLines++;
      continue;
    }
    if (p.kind === "junco") {
      const r = p.record;
      switch (r.type) {
        case "junco_meta":
          out.ticketId = r.ticketId;
          out.version = r.version;
          break;
        case "junco_run_start":
          openRun(r);
          break;
        case "junco_run_end":
          ensureRun();
          closeRun({
            stopReason: r.stopReason,
            errorMessage: r.errorMessage,
            timedOut: r.timedOut,
            abortedByGuard: r.abortedByGuard,
            durationMs: r.durationMs,
            usage: r.usage,
          });
          break;
        case "junco_guard_decision":
          ensureRun().guardDecisions.push(r);
          break;
        default:
          break; // forward compat: an unknown junco_* record is ignored
      }
      continue;
    }
    const e = p.event;
    switch (e.type) {
      case "agent_start":
        if (st.open === null) openRun(null);
        break;
      case "agent_end":
        if (st.open !== null && !st.framed) closeRun(V1_END);
        break;
      case "tool_execution_start": {
        const run = ensureRun();
        st.provisional ??= {
          index: run.turns.length,
          provisional: true,
          thinking: null,
          text: null,
          toolCalls: [],
          usage: null,
        };
        st.provisional.toolCalls.push({
          id: str(e.toolCallId) ?? "",
          name: str(e.toolName) ?? "?",
          args: isRecord(e.args) ? e.args : {},
          result: null,
        });
        run.toolCallCount++;
        break;
      }
      case "tool_execution_end": {
        const call = st.provisional?.toolCalls.find((c) => c.id === e.toolCallId);
        if (call)
          call.result = resultFromContent(
            isRecord(e.result) ? e.result.content : undefined,
            e.isError === true,
          );
        break;
      }
      case "turn_end": {
        const run = ensureRun();
        const msg = isRecord(e.message) ? e.message : {};
        const content = Array.isArray(msg.content) ? msg.content : [];
        const thinking: string[] = [];
        const text: string[] = [];
        const toolCalls: ToolCallSummary[] = [];
        for (const b of content) {
          if (!isRecord(b)) continue;
          if (b.type === "thinking" && typeof b.thinking === "string") thinking.push(b.thinking);
          else if (b.type === "text" && typeof b.text === "string") text.push(b.text);
          else if (b.type === "toolCall")
            toolCalls.push({
              id: str(b.id) ?? "",
              name: str(b.name) ?? "?",
              args: isRecord(b.arguments) ? b.arguments : {},
              result: null,
            });
        }
        const results = Array.isArray(e.toolResults) ? e.toolResults : [];
        for (const r of results) {
          if (!isRecord(r)) continue;
          const call = toolCalls.find((c) => c.id === r.toolCallId);
          if (call) call.result = resultFromContent(r.content, r.isError === true);
        }
        if (st.provisional !== null) {
          run.toolCallCount -= st.provisional.toolCalls.length;
          st.provisional = null;
        }
        run.toolCallCount += toolCalls.length;
        run.turns.push({
          index: run.turns.length,
          provisional: false,
          thinking: thinking.length > 0 ? thinking.join("\n") : null,
          text: text.length > 0 ? text.join("\n") : null,
          toolCalls,
          usage: usageOf(msg.usage),
        });
        break;
      }
      default:
        break;
    }
  }
  if (st.open !== null) {
    if (st.provisional !== null) st.open.turns.push(st.provisional);
    out.live = true;
  }
  return out;
}

/** Every tool call id in file order — the transcript view's cursor index space. */
export function toolCallIds(s: TranscriptSummary): string[] {
  return s.runs.flatMap((r) => r.turns.flatMap((t) => t.toolCalls.map((c) => c.id)));
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/transcriptSummary.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: `exit: 0`, 13 passed.

- [ ] **Step 6: Lint/typecheck the new module, commit**

```bash
npx prettier --write src/transcriptSummary.ts tests/transcriptSummary.test.ts tests/helpers/transcriptFixtures.ts
npm run typecheck > /tmp/out 2>&1; echo "exit: $?"
npm run lint > /tmp/out 2>&1; echo "exit: $?"
git add src/transcriptSummary.ts tests/transcriptSummary.test.ts tests/helpers/transcriptFixtures.ts
git commit -m "feat(transcript): pure transcript summary model (runs, turns, tool calls)"
```

---

### Task 2: `transcriptRender.ts` — rows, tones, anchors

**Files:**

- Create: `src/transcriptRender.ts`
- Test: `tests/transcriptRender.test.ts`

**Interfaces:**

- Consumes: `RunSummary`, `ToolResultSummary`, `TranscriptSummary` from Task 1; `GuardDecisionRecord` (type) from `transcriptSchema.ts`.
- Produces (used by Tasks 5 and 8):
  - `renderTranscriptRows(s: TranscriptSummary, o: RenderOpts): TranscriptRow[]`
  - `RenderOpts = { width: number; showThinking: boolean; expanded: ReadonlySet<string> }`
  - `TranscriptRow = { text: string; tone?: RowTone; anchor?: string }`, `RowTone = "dim" | "accent" | "error" | "warn" | "bold" | "success"`
  - `fmtRunOutcome(run: RunSummary, live: boolean): { text: string; tone: RowTone }` (the view header reuses it)
  - `fmtToolCall(name, args, width): string`, `fmtToolResult(r): string`, `wrapText(text, width): string[]`, `TOOL_BODY_MAX_LINES`, `MIN_WIDTH`

- [ ] **Step 1: Write the failing tests**

Create `tests/transcriptRender.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/transcriptRender.test.ts > /tmp/out 2>&1; echo "exit: $?"`
Expected: `exit: 1` — import resolution failure.

- [ ] **Step 3: Implement**

Create `src/transcriptRender.ts`:

```ts
/**
 * transcriptRender — turns a `TranscriptSummary` (transcriptSummary.ts) into
 * width-bounded text rows for the two consumers: the dashboard's
 * TranscriptView (which maps `tone` to Ink props and `anchor` to the cursor)
 * and `junco transcript` (which prints `text` only). Pure: no fs, no Ink.
 *
 * Invariant: no row is wider than `width` (≥ MIN_WIDTH) — prose and expanded
 * tool bodies are word-wrapped, everything else is truncated — so a surface
 * can render rows with `wrap="truncate-end"` and lose nothing.
 */
import type { GuardDecisionRecord } from "./agent/transcriptSchema.js";
import type { RunSummary, ToolResultSummary, TranscriptSummary } from "./transcriptSummary.js";

export type RowTone = "dim" | "accent" | "error" | "warn" | "bold" | "success";

export interface TranscriptRow {
  text: string;
  tone?: RowTone;
  /** Set on a tool-call row: the toolCallId the cursor/expand key targets. */
  anchor?: string;
}

export interface RenderOpts {
  /** Wrap/truncate column; values below MIN_WIDTH are raised to it. */
  width: number;
  showThinking: boolean;
  /** toolCallIds whose result body renders inline under the tool row. */
  expanded: ReadonlySet<string>;
}

export const TOOL_BODY_MAX_LINES = 400;
export const MIN_WIDTH = 20;

const truncate = (s: string, width: number): string =>
  s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`;
const firstLine = (s: string): string => s.split("\n")[0] ?? "";
const compactJson = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "[unserializable]";
  }
};

/** Greedy word wrap: breaks on spaces, hard-splits a token longer than `width`,
 * and keeps blank lines (an empty paragraph → one empty row). */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      let tok = word;
      while (tok.length > w) {
        if (line !== "") {
          out.push(line);
          line = "";
        }
        out.push(tok.slice(0, w));
        tok = tok.slice(w);
      }
      if (line === "") line = tok;
      else if (line.length + 1 + tok.length <= w) line += ` ${tok}`;
      else {
        out.push(line);
        line = tok;
      }
    }
    out.push(line);
  }
  return out;
}

/** `740` / `1.8k` / `34.7k` — local (not tui/queueFmt) to keep this module
 * free of a root → tui import. */
export function fmtK(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** HH:MM:SS (UTC, matching the log's ISO stamps); the raw string if unparsable. */
const hhmmss = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19);
};

/** `read src/a.ts`, `bash npm test`, `grep foo in src` — the argument that
 * identifies the call, not its JSON; anything else prints compact JSON. */
export function fmtToolCall(name: string, args: Record<string, unknown>, width: number): string {
  const s = (k: string): string | undefined =>
    typeof args[k] === "string" ? (args[k] as string) : undefined;
  let detail: string;
  switch (name) {
    case "read":
    case "write":
    case "edit":
      detail = s("path") ?? compactJson(args);
      break;
    case "bash":
      detail = firstLine(s("command") ?? compactJson(args));
      break;
    case "grep":
    case "find": {
      const pat = s("pattern");
      const p = s("path");
      detail = pat === undefined ? compactJson(args) : p !== undefined ? `${pat} in ${p}` : pat;
      break;
    }
    default:
      detail = compactJson(args);
  }
  return truncate(`${name} ${detail}`, width);
}

export function fmtToolResult(r: ToolResultSummary | null): string {
  if (r === null) return "→ …";
  if (r.isError) return truncate(`→ ✗ ${firstLine(r.text) || "error"}`, 60);
  if (r.lines === 0) return "→ empty";
  return `→ ${r.lines} line${r.lines === 1 ? "" : "s"}`;
}

/** The run header's outcome segment. `live` = this is the file's open last run. */
export function fmtRunOutcome(run: RunSummary, live: boolean): { text: string; tone: RowTone } {
  const end = run.end;
  if (end === null)
    return live ? { text: "◐ running…", tone: "accent" } : { text: "truncated", tone: "warn" };
  const failed = end.errorMessage !== null || end.stopReason === "error";
  const base = end.abortedByGuard
    ? "killed by guard"
    : end.timedOut
      ? "timeout"
      : failed
        ? "error"
        : (end.stopReason ?? "stop");
  const parts = [base];
  if (end.durationMs !== null) parts.push(fmtDuration(end.durationMs));
  if (end.usage !== null) parts.push(`in ${fmtK(end.usage.input)} out ${fmtK(end.usage.output)}`);
  const tone: RowTone = failed ? "error" : end.abortedByGuard || end.timedOut ? "warn" : "success";
  return { text: parts.join(" · "), tone };
}

export function renderTranscriptRows(s: TranscriptSummary, o: RenderOpts): TranscriptRow[] {
  const width = Math.max(MIN_WIDTH, o.width);
  const rows: TranscriptRow[] = [];
  const push = (text: string, tone?: RowTone, anchor?: string): void => {
    const row: TranscriptRow = { text };
    if (tone !== undefined) row.tone = tone;
    if (anchor !== undefined) row.anchor = anchor;
    rows.push(row);
  };
  if (s.invalidLines > 0)
    push(`${s.invalidLines} invalid line${s.invalidLines === 1 ? "" : "s"} skipped`, "warn");
  if (s.runs.length === 0) {
    push("no events recorded", "dim");
    return rows;
  }
  s.runs.forEach((run, i) => {
    if (i > 0) push("");
    const live = s.live && i === s.runs.length - 1;
    const outcome = fmtRunOutcome(run, live);
    const head = [
      `run ${run.index}/${s.runs.length}`,
      run.flow ?? "v1",
      run.modelId ?? "?",
      run.startedAt === null ? null : hhmmss(run.startedAt),
      outcome.text,
    ]
      .filter((x): x is string => x !== null)
      .join(" · ");
    push(truncate(`── ${head} ──`, width), "bold");
    if (run.end?.errorMessage)
      for (const l of wrapText(`✗ ${firstLine(run.end.errorMessage)}`, width - 3))
        push(`   ${l}`, "error");
    const guardRow = (g: GuardDecisionRecord): void =>
      push(
        truncate(
          `   ⚑ guard ${g.action} (${g.kind}) at turn ${g.turnIndex + 1} — ${g.detail}`,
          width,
        ),
        "warn",
      );
    for (const turn of run.turns) {
      const usage =
        turn.usage === null ? "" : ` · in ${fmtK(turn.usage.input)} out ${fmtK(turn.usage.output)}`;
      push(truncate(`turn ${turn.index + 1}${turn.provisional ? " ◐" : ""}${usage}`, width), "dim");
      if (o.showThinking && turn.thinking !== null)
        for (const l of wrapText(turn.thinking, width - 2)) push(`  ${l}`, "dim");
      if (turn.text !== null) for (const l of wrapText(turn.text, width - 2)) push(`  ${l}`);
      for (const c of turn.toolCalls) {
        const suffix = fmtToolResult(c.result);
        push(
          `  ▸ ${fmtToolCall(c.name, c.args, Math.max(8, width - 6 - suffix.length))}  ${suffix}`,
          undefined,
          c.id,
        );
        if (o.expanded.has(c.id) && c.result !== null) {
          const body = c.result.text === "" ? ["(empty)"] : c.result.text.split("\n");
          for (const raw of body.slice(0, TOOL_BODY_MAX_LINES))
            for (const l of wrapText(raw, width - 6)) push(`      ${l}`, "dim");
          if (body.length > TOOL_BODY_MAX_LINES)
            push(
              truncate(`      … +${body.length - TOOL_BODY_MAX_LINES} more lines`, width),
              "dim",
            );
        }
      }
      for (const g of run.guardDecisions) if (g.turnIndex === turn.index) guardRow(g);
    }
    for (const g of run.guardDecisions) if (g.turnIndex >= run.turns.length) guardRow(g);
  });
  return rows;
}
```

Note on the tool row width: ` ▸` (4) + call (≤ `width − 6 − suffix`) + two spaces + suffix = `width`. At `width: 40` with a long `→ ✗ …` suffix the call budget floors at 8, so the row can exceed 40 — the invariant test above uses a non-error result on purpose; if you want the hard guarantee, wrap the whole tool row in `truncate(…, width)` (the anchor survives either way).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/transcriptRender.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: `exit: 0`, 12 passed. If the "never emits a row wider than width" case fails on the tool row, apply the `truncate` from the note above.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/transcriptRender.ts tests/transcriptRender.test.ts
npm run typecheck > /tmp/out 2>&1; echo "exit: $?"; npm run lint > /tmp/out 2>&1; echo "exit: $?"
git add src/transcriptRender.ts tests/transcriptRender.test.ts
git commit -m "feat(transcript): render a transcript summary to width-bounded rows"
```

---

### Task 3: `DashboardClient.readTranscript` (stat-gated)

**Files:**

- Modify: `src/tui/ghClient.ts` — imports (line 8), `GhClientDeps` (after `readFileFn?`, ~line 200), `DashboardClient` interface (after `analyzeIssue`, ~line 197), `makeGhDashboardClient` (after `readFileFn` const at line 236; method beside `listReview` at ~line 601)
- Modify: `tests/helpers/localFixtures.tsx` (the `DashboardClient` literal, after `analyzeIssue`, ~line 243); `tests/tuiApp.test.tsx` — every `const client: DashboardClient = {` literal (four: ~lines 127, 202, and the two `npm run typecheck` flags)
- Test: `tests/tuiGhClient.test.ts`

**Interfaces:**

- Consumes: `summarizeTranscript`, `TranscriptSummary` (Task 1); `transcriptPathFor` (`src/slug.ts`); `dataTreePaths` (already imported).
- Produces (Task 4 depends on it):

  ```ts
  export type TranscriptRead =
    | { kind: "missing"; path: string }
    | { kind: "unchanged"; size: number }
    | { kind: "read"; size: number; summary: TranscriptSummary };
  readTranscript(id: string, prevSize: number | null): Promise<Result<TranscriptRead>>;
  // GhClientDeps.statFn?: (p: string) => { size: number }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/tuiGhClient.test.ts` (add the three imports at the top; `cfg` is the file's existing `Config` const):

```ts
import { transcriptPathFor } from "../src/slug.js";
import { dataTreePaths } from "../src/dataTree.js";
import { runEnd, runStart, turnEndFull } from "./helpers/transcriptFixtures.js";

describe("readTranscript", () => {
  const path = transcriptPathFor(dataTreePaths(cfg).transcripts, "t-1");
  const enoent = (): Error => Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

  it("missing file → kind missing with the resolved path, no read attempted", async () => {
    const c = makeGhDashboardClient(cfg, {
      statFn: () => {
        throw enoent();
      },
      readFileFn: () => {
        throw new Error("must not read");
      },
    });
    expect(await c.readTranscript("t-1", null)).toEqual({
      ok: true,
      value: { kind: "missing", path },
    });
  });

  it("same size as prevSize → unchanged, without reading", async () => {
    const reads: string[] = [];
    const c = makeGhDashboardClient(cfg, {
      statFn: () => ({ size: 42 }),
      readFileFn: (p) => {
        reads.push(p);
        return "";
      },
    });
    expect(await c.readTranscript("t-1", 42)).toEqual({
      ok: true,
      value: { kind: "unchanged", size: 42 },
    });
    expect(reads).toEqual([]);
  });

  it("changed size → reads and summarizes", async () => {
    const content = [runStart({ flow: "qa" }), turnEndFull({ text: "hi" }), runEnd()].join("\n");
    const c = makeGhDashboardClient(cfg, {
      statFn: () => ({ size: content.length }),
      readFileFn: (p) => {
        expect(p).toBe(path);
        return content;
      },
    });
    const r = await c.readTranscript("t-1", 5);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== "read") throw new Error("expected read");
    expect(r.value.size).toBe(content.length);
    expect(r.value.summary.runs[0].turns[0].text).toBe("hi");
    expect(r.value.summary.live).toBe(false);
  });

  it("a non-ENOENT stat failure is an error Result", async () => {
    const c = makeGhDashboardClient(cfg, {
      statFn: () => {
        throw new Error("EACCES: denied");
      },
    });
    expect(await c.readTranscript("t-1", null)).toEqual({ ok: false, error: "EACCES: denied" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tuiGhClient.test.ts > /tmp/out 2>&1; echo "exit: $?"`
Expected: `exit: 1` — `c.readTranscript is not a function` (and a type error under `npm run typecheck`).

- [ ] **Step 3: Implement**

In `src/tui/ghClient.ts`:

1. Line 8: add `statSync` to the `node:fs` import. Add after the `dataTree` import:
   ```ts
   import { transcriptPathFor } from "../slug.js";
   import { summarizeTranscript, type TranscriptSummary } from "../transcriptSummary.js";
   ```
2. After the `Result` type (line 27):
   ```ts
   /** One `readTranscript` outcome. `unchanged` is the live poll's steady state
    * (stat only, no read); `missing` is ENOENT — a pre-transcript ticket, or a
    * running one whose agent hasn't started yet. */
   export type TranscriptRead =
     | { kind: "missing"; path: string }
     | { kind: "unchanged"; size: number }
     | { kind: "read"; size: number; summary: TranscriptSummary };
   ```
3. In `DashboardClient`, after `analyzeIssue(...)`:
   ```ts
     /** The ticket's event transcript, summarized for the viewer — stat-gated:
      * pass the size from the previous read and an unchanged file costs one
      * stat. Resolves `transcriptPathFor(dataTreePaths(cfg).transcripts, id)`. */
     readTranscript(id: string, prevSize: number | null): Promise<Result<TranscriptRead>>;
   ```
4. In `GhClientDeps`, after `readFileFn?`:
   ```ts
     /** File size probe for readTranscript's stat gate (default `statSync`). */
     statFn?: (p: string) => { size: number };
   ```
5. In `makeGhDashboardClient`, after the `readFileFn` const (line 236):
   ```ts
   const statFn = deps.statFn ?? ((p: string) => ({ size: statSync(p).size }));
   ```
6. In the returned object, directly after the `listReview()` method:
   ```ts
       readTranscript(id, prevSize) {
         return attempt(async () => {
           const path = transcriptPathFor(dataTreePaths(cfg).transcripts, id);
           let size: number;
           try {
             size = statFn(path).size;
           } catch (e) {
             if ((e as NodeJS.ErrnoException).code === "ENOENT")
               return { kind: "missing" as const, path };
             throw e;
           }
           if (prevSize !== null && size === prevSize) return { kind: "unchanged" as const, size };
           return {
             kind: "read" as const,
             size,
             summary: summarizeTranscript(readFileFn(path).split("\n")),
           };
         });
       },
   ```

- [ ] **Step 4: Satisfy every fake client**

Run `npm run typecheck > /tmp/out 2>&1; echo "exit: $?"; grep -n "readTranscript" /tmp/out` — every `DashboardClient` literal missing the method is listed. Add to each (they all have an `okv` helper in scope):

```ts
    readTranscript: async () => okv({ kind: "missing" as const, path: "/x/transcripts/t.jsonl" }),
```

Known sites: `tests/helpers/localFixtures.tsx` (after `analyzeIssue`), and the `const client: DashboardClient = {` literals in `tests/tuiApp.test.tsx` (≈ lines 127 and 202, plus any others typecheck names). `tests/useReview.test.tsx` casts through `unknown` and needs nothing.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/tuiGhClient.test.ts tests/tuiApp.test.tsx > /tmp/out 2>&1; echo "exit: $?"` and `npm run typecheck > /tmp/out 2>&1; echo "exit: $?"`
Expected: both `exit: 0`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/tui/ghClient.ts tests/tuiGhClient.test.ts tests/helpers/localFixtures.tsx tests/tuiApp.test.tsx
git add -A src/tui/ghClient.ts tests/tuiGhClient.test.ts tests/helpers/localFixtures.tsx tests/tuiApp.test.tsx
git commit -m "feat(dashboard): DashboardClient.readTranscript — stat-gated transcript read"
```

---

### Task 4: `useTranscript` hook — state + live poll

**Files:**

- Create: `src/tui/hooks/useTranscript.ts`
- Test: `tests/useTranscript.test.tsx`

**Interfaces:**

- Consumes: `DashboardClient.readTranscript` (Task 3); `toolCallIds`, `TranscriptSummary` (Task 1).
- Produces (Tasks 5 and 7 depend on these exact names):

  ```ts
  export interface TranscriptState {
    id: string;
    path: string | null;
    expectLive: boolean;
    loading: boolean;
    error: string | null;
    size: number | null;
    summary: TranscriptSummary | null;
    showThinking: boolean;
    follow: boolean;
    cursor: number;
    expanded: ReadonlySet<string>;
  }
  export interface TranscriptApi {
    transcript: TranscriptState | null;
    openTranscript(id: string, opts: { expectLive: boolean }): void;
    closeTranscript(): void;
    toggleThinking(): void;
    setFollow(on: boolean): void;
    moveCursor(delta: number): void;
    setCursor(idx: number): void;
    toggleExpanded(): void;
  }
  export function useTranscript(o: {
    client: DashboardClient;
    aliveRef: MutableRefObject<boolean>;
    pollMs?: number;
  }): TranscriptApi;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/useTranscript.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React, { useRef } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useTranscript, type TranscriptApi } from "../src/tui/hooks/useTranscript.js";
import type { DashboardClient, Result, TranscriptRead } from "../src/tui/ghClient.js";
import { summarizeTranscript } from "../src/transcriptSummary.js";
import { runEnd, runStart, toolStartId, turnEndFull } from "./helpers/transcriptFixtures.js";
import { until } from "./helpers/until.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const okv = <T,>(value: T): Result<T> => ({ ok: true, value });

const DONE = summarizeTranscript([
  runStart(),
  turnEndFull({
    text: "x",
    calls: [
      { id: "c1", name: "read", args: { path: "a" }, result: "r" },
      { id: "c2", name: "read", args: { path: "b" }, result: "r" },
    ],
  }),
  runEnd(),
]);
const LIVE = summarizeTranscript([runStart(), toolStartId("c1", "read", { path: "a" })]);

/** A client whose readTranscript answers from `seq` in order (last one repeats). */
function client(seq: TranscriptRead[]) {
  const calls: (number | null)[] = [];
  const c = {
    readTranscript: async (_id: string, prev: number | null) => {
      calls.push(prev);
      return okv(seq[Math.min(calls.length - 1, seq.length - 1)]);
    },
  } as unknown as DashboardClient;
  return { c, calls };
}

function Probe({
  client: c,
  onReady,
}: {
  client: DashboardClient;
  onReady: (api: TranscriptApi) => void;
}) {
  const aliveRef = useRef(true);
  const api = useTranscript({ client: c, aliveRef, pollMs: 10 });
  onReady(api);
  const t = api.transcript;
  return (
    <Text>
      {t === null
        ? "closed"
        : `id:${t.id}:loading:${t.loading}:live:${t.summary?.live ?? "none"}:err:${t.error ?? "none"}:cursor:${t.cursor}:follow:${t.follow}:exp:${[...t.expanded].join(",")}`}
    </Text>
  );
}

function mount(c: DashboardClient) {
  let api!: TranscriptApi;
  const r = render(<Probe client={c} onReady={(a) => (api = a)} />);
  return { r, api: () => api, frame: () => r.lastFrame() ?? "" };
}

describe("useTranscript", () => {
  it("starts closed; open performs the first read", async () => {
    const { c, calls } = client([{ kind: "read", size: 1, summary: DONE }]);
    const m = mount(c);
    expect(m.frame()).toBe("closed");
    m.api().openTranscript("t-1", { expectLive: false });
    await until(() => m.frame().includes("loading:false:live:false"));
    expect(calls).toEqual([null]);
    await wait(40); // finished transcript → no polling
    expect(calls).toEqual([null]);
  });

  it("polls while live and stops on the first read that is not live", async () => {
    const { c, calls } = client([
      { kind: "read", size: 5, summary: LIVE },
      { kind: "read", size: 9, summary: DONE },
    ]);
    const m = mount(c);
    m.api().openTranscript("t-1", { expectLive: true });
    await until(() => m.frame().includes("live:false"));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]).toBe(5); // prevSize threaded from the last read
    const n = calls.length;
    await wait(40);
    expect(calls.length).toBe(n);
  });

  it("missing + expectLive keeps waiting (no error, keeps polling)", async () => {
    const { c, calls } = client([{ kind: "missing", path: "/p" }]);
    const m = mount(c);
    m.api().openTranscript("t-1", { expectLive: true });
    await until(() => calls.length >= 3);
    expect(m.frame()).toContain("err:none");
    expect(m.frame()).toContain("live:none");
  });

  it("missing without expectLive is terminal", async () => {
    const { c, calls } = client([{ kind: "missing", path: "/p" }]);
    const m = mount(c);
    m.api().openTranscript("t-1", { expectLive: false });
    await until(() => m.frame().includes("err:no transcript for t-1"));
    await wait(40);
    expect(calls).toEqual([null]);
  });

  it("unchanged keeps the previous summary object", async () => {
    const { c } = client([
      { kind: "read", size: 5, summary: LIVE },
      { kind: "unchanged", size: 5 },
    ]);
    const m = mount(c);
    m.api().openTranscript("t-1", { expectLive: true });
    await until(() => m.frame().includes("live:true"));
    await wait(40);
    expect(m.api().transcript?.summary).toBe(LIVE);
  });

  it("cursor clamps and pauses follow; expand toggles by id; close resets", async () => {
    const { c } = client([{ kind: "read", size: 1, summary: DONE }]);
    const m = mount(c);
    m.api().openTranscript("t-1", { expectLive: true });
    await until(() => m.frame().includes("loading:false"));
    expect(m.frame()).toContain("follow:true");
    m.api().moveCursor(5);
    await until(() => m.frame().includes("cursor:1:follow:false"));
    m.api().toggleExpanded();
    await until(() => m.frame().includes("exp:c2"));
    m.api().toggleExpanded();
    await until(() => m.frame().endsWith("exp:"));
    m.api().setCursor(0);
    m.api().toggleExpanded();
    await until(() => m.frame().includes("cursor:0") && m.frame().includes("exp:c1"));
    m.api().closeTranscript();
    await until(() => m.frame() === "closed");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/useTranscript.test.tsx > /tmp/out 2>&1; echo "exit: $?"`
Expected: `exit: 1` — import resolution failure.

- [ ] **Step 3: Implement**

Create `src/tui/hooks/useTranscript.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import type { DashboardClient } from "../ghClient.js";
import { toolCallIds, type TranscriptSummary } from "../../transcriptSummary.js";

export interface TranscriptState {
  id: string;
  path: string | null;
  /** Opened from a RUNNING row: a missing file means "not started yet", not an error. */
  expectLive: boolean;
  loading: boolean;
  /** Terminal read error, or `no transcript for <id>`. */
  error: string | null;
  /** Size of the last read — the client's stat gate. */
  size: number | null;
  summary: TranscriptSummary | null;
  showThinking: boolean;
  /** Pin the viewport to the tail (live). Defaults to `expectLive`. */
  follow: boolean;
  /** Index into `toolCallIds(summary)`; clamped on every read. */
  cursor: number;
  expanded: ReadonlySet<string>;
}

export interface TranscriptApi {
  transcript: TranscriptState | null;
  openTranscript: (id: string, opts: { expectLive: boolean }) => void;
  closeTranscript: () => void;
  toggleThinking: () => void;
  setFollow: (on: boolean) => void;
  /** Move the tool-call cursor; clamps; pauses follow. */
  moveCursor: (delta: number) => void;
  setCursor: (idx: number) => void;
  /** Expand/collapse the cursor's tool result. */
  toggleExpanded: () => void;
}

/**
 * transcript-view domain: the open transcript's state plus its live poll.
 * Like useReview, navigation is the caller's job — App's queue `enter`
 * opens the state AND sets the view; `close` clears it AND navigates back.
 *
 * The poll runs only while the file is still being written (`summary.live`)
 * or, for a running ticket, not yet created (`summary === null &&
 * expectLive`). The client stat-gates the read, so the steady state is one
 * stat per tick; the first read that reports `live: false` ends the poll.
 */
export function useTranscript({
  client,
  aliveRef,
  pollMs = 1_000,
}: {
  client: DashboardClient;
  aliveRef: MutableRefObject<boolean>;
  pollMs?: number;
}): TranscriptApi {
  const [transcript, setTranscript] = useState<TranscriptState | null>(null);

  const readOnce = useCallback(
    (id: string, prevSize: number | null): void => {
      void client.readTranscript(id, prevSize).then((r) => {
        if (!aliveRef.current) return;
        setTranscript((s) => {
          if (s === null || s.id !== id) return s; // closed or reopened meanwhile
          if (!r.ok) return { ...s, loading: false, error: r.error };
          const v = r.value;
          if (v.kind === "unchanged") return s.loading ? { ...s, loading: false } : s;
          if (v.kind === "missing")
            return {
              ...s,
              loading: false,
              path: v.path,
              error: s.expectLive ? null : `no transcript for ${id}`,
            };
          const n = toolCallIds(v.summary).length;
          return {
            ...s,
            loading: false,
            error: null,
            size: v.size,
            summary: v.summary,
            cursor: Math.min(s.cursor, Math.max(0, n - 1)),
          };
        });
      });
    },
    [client, aliveRef],
  );

  const openTranscript = useCallback(
    (id: string, opts: { expectLive: boolean }): void => {
      setTranscript({
        id,
        path: null,
        expectLive: opts.expectLive,
        loading: true,
        error: null,
        size: null,
        summary: null,
        showThinking: false,
        follow: opts.expectLive,
        cursor: 0,
        expanded: new Set(),
      });
      readOnce(id, null);
    },
    [readOnce],
  );

  const id = transcript?.id ?? null;
  const size = transcript?.size ?? null;
  const polling =
    transcript !== null &&
    transcript.error === null &&
    (transcript.summary !== null ? transcript.summary.live : transcript.expectLive);
  useEffect(() => {
    if (!polling || id === null) return;
    const t = setInterval(() => readOnce(id, size), pollMs);
    return () => clearInterval(t);
  }, [polling, id, size, pollMs, readOnce]);

  const closeTranscript = useCallback((): void => setTranscript(null), []);
  const toggleThinking = useCallback(
    (): void => setTranscript((s) => (s === null ? s : { ...s, showThinking: !s.showThinking })),
    [],
  );
  const setFollow = useCallback(
    (on: boolean): void => setTranscript((s) => (s === null ? s : { ...s, follow: on })),
    [],
  );
  const setCursor = useCallback(
    (idx: number): void =>
      setTranscript((s) => {
        if (s === null || s.summary === null) return s;
        const n = toolCallIds(s.summary).length;
        if (n === 0) return s;
        return { ...s, cursor: Math.max(0, Math.min(idx, n - 1)), follow: false };
      }),
    [],
  );
  const moveCursor = useCallback(
    (delta: number): void =>
      setTranscript((s) => {
        if (s === null || s.summary === null) return s;
        const n = toolCallIds(s.summary).length;
        if (n === 0) return s;
        return { ...s, cursor: Math.max(0, Math.min(s.cursor + delta, n - 1)), follow: false };
      }),
    [],
  );
  const toggleExpanded = useCallback(
    (): void =>
      setTranscript((s) => {
        if (s === null || s.summary === null) return s;
        const target = toolCallIds(s.summary)[s.cursor];
        if (target === undefined) return s;
        const expanded = new Set(s.expanded);
        if (expanded.has(target)) expanded.delete(target);
        else expanded.add(target);
        return { ...s, expanded };
      }),
    [],
  );

  return {
    transcript,
    openTranscript,
    closeTranscript,
    toggleThinking,
    setFollow,
    moveCursor,
    setCursor,
    toggleExpanded,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/useTranscript.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: `exit: 0`, 6 passed. Then `npm run lint > /tmp/out 2>&1; echo "exit: $?"` — must be 0 (exhaustive-deps is an error under `src/tui/**`).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/hooks/useTranscript.ts tests/useTranscript.test.tsx
git add src/tui/hooks/useTranscript.ts tests/useTranscript.test.tsx
git commit -m "feat(dashboard): useTranscript hook — open/poll/cursor/expand state"
```

---

### Task 5: `TranscriptView` component

**Files:**

- Create: `src/tui/components/TranscriptView.tsx`
- Test: `tests/tuiTranscriptView.test.tsx`

**Interfaces:**

- Consumes: `TranscriptState` (Task 4); `renderTranscriptRows`, `fmtRunOutcome`, `RowTone`, `TranscriptRow` (Task 2); `toolCallIds` (Task 1); `clampScroll`/`maxScroll` (`src/tui/window.ts`); `Scrollbar`, `ClickableBox`, `theme`.
- Produces (Task 7 mounts it):

  ```ts
  export interface TranscriptViewProps {
    state: TranscriptState;
    scroll: number;
    height: number;
    width: number;
    focused: boolean;
    onScrollMax?: (max: number) => void;
    /** Mouse press on a tool row: its index in toolCallIds(summary). */
    onRowPress?: (anchorIdx: number) => void;
  }
  export const TranscriptView: React.MemoExoticComponent<
    (p: TranscriptViewProps) => React.JSX.Element
  >;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/tuiTranscriptView.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tuiTranscriptView.test.tsx > /tmp/out 2>&1; echo "exit: $?"`
Expected: `exit: 1` — import resolution failure.

- [ ] **Step 3: Implement**

Create `src/tui/components/TranscriptView.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { bumpRender } from "../renderCount.js";
import { theme } from "../theme.js";
import { clampScroll, maxScroll } from "../window.js";
import { Scrollbar } from "./primitives/Scrollbar.js";
import { ClickableBox } from "../ClickableBox.js";
import {
  fmtRunOutcome,
  renderTranscriptRows,
  MIN_WIDTH,
  type RowTone,
  type TranscriptRow,
} from "../../transcriptRender.js";
import { toolCallIds } from "../../transcriptSummary.js";
import type { TranscriptState } from "../hooks/useTranscript.js";

export interface TranscriptViewProps {
  state: TranscriptState;
  scroll: number;
  height: number;
  /** Terminal columns — the renderer wraps prose to fit inside the border. */
  width: number;
  focused: boolean;
  onScrollMax?: (max: number) => void;
  /** Mouse press on a tool row: its index in `toolCallIds(summary)`. */
  onRowPress?: (anchorIdx: number) => void;
}

function headerStatus(s: TranscriptState): { text: string; tone?: RowTone } {
  if (s.error !== null) return { text: s.error, tone: "error" };
  if (s.summary === null)
    return s.expectLive
      ? { text: "waiting for the agent to start…", tone: "dim" }
      : { text: "loading…", tone: "dim" };
  if (s.summary.live) return { text: s.follow ? "◐ live · follow" : "◐ live", tone: "accent" };
  const last = s.summary.runs[s.summary.runs.length - 1];
  return last === undefined ? { text: "empty", tone: "dim" } : fmtRunOutcome(last, false);
}

function toneProps(tone: RowTone | undefined): {
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
} {
  switch (tone) {
    case "dim":
      return { dimColor: true };
    case "accent":
      return { color: theme.accent };
    case "error":
      return { color: theme.error };
    case "warn":
      return { color: theme.warn };
    case "success":
      return { color: theme.success };
    case "bold":
      return { bold: true };
    default:
      return {};
  }
}

/** The transcript view (fullscreen, in the review view's slot). Mirrors
 * CommandOutput's shape: header, sliced rows + Scrollbar, footer. Window math
 * mirrors QueueView: base at `scroll` (or the tail while `follow`), then nudge
 * so the cursor's tool row stays visible. Memoized (perf pass #259 discipline). */
export const TranscriptView = React.memo(function TranscriptView({
  state,
  scroll,
  height,
  width,
  focused,
  onScrollMax,
  onRowPress,
}: TranscriptViewProps): React.JSX.Element {
  bumpRender("TranscriptView");
  // Reserved rows: borders ×2, header, footer.
  const visible = Math.max(1, height - 4);
  // Borders (2) + paddingX (2) + scrollbar column (1) + cursor gutter (1).
  const textWidth = Math.max(MIN_WIDTH, width - 6);
  const rows: TranscriptRow[] =
    state.summary === null
      ? []
      : renderTranscriptRows(state.summary, {
          width: textWidth,
          showThinking: state.showThinking,
          expanded: state.expanded,
        });
  const anchors = state.summary === null ? [] : toolCallIds(state.summary);
  const anchorId = anchors[state.cursor];
  const anchorRow = anchorId === undefined ? -1 : rows.findIndex((r) => r.anchor === anchorId);
  onScrollMax?.(maxScroll(rows.length, visible));
  let start = state.follow
    ? maxScroll(rows.length, visible)
    : clampScroll(scroll, rows.length, visible);
  if (!state.follow && anchorRow >= 0) {
    if (anchorRow < start) start = anchorRow;
    else if (anchorRow >= start + visible) start = anchorRow - visible + 1;
  }
  const end = Math.min(start + visible, rows.length);
  const status = headerStatus(state);
  const runs = state.summary?.runs.length ?? 0;
  const live = state.summary?.live === true;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      height={height}
      flexGrow={1}
    >
      <Text bold wrap="truncate">
        transcript · {state.id}
        {runs > 0 ? ` · ${runs} run${runs === 1 ? "" : "s"}` : ""} ·{" "}
        <Text {...toneProps(status.tone)}>{status.text}</Text>
      </Text>
      <Box flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {rows.slice(start, end).map((row, i) => {
            const isAnchor = row.anchor !== undefined && row.anchor === anchorId;
            const idx = row.anchor === undefined ? -1 : anchors.indexOf(row.anchor);
            return (
              <ClickableBox
                key={start + i}
                hoverBg={row.anchor !== undefined ? theme.hoverBg : undefined}
                onPress={row.anchor !== undefined && onRowPress ? () => onRowPress(idx) : undefined}
              >
                <Text
                  wrap="truncate-end"
                  backgroundColor={isAnchor && focused ? theme.selectionBg : undefined}
                  {...toneProps(row.tone)}
                >
                  <Text color={theme.accent}>{isAnchor ? "▌" : " "}</Text>
                  {row.text || " "}
                </Text>
              </ClickableBox>
            );
          })}
        </Box>
        <Scrollbar offset={start} viewport={visible} total={rows.length} height={visible} />
      </Box>
      <Text dimColor wrap="truncate">
        ↑/↓ tool · enter expand · [/] scroll · t thinking{live ? " · f follow" : ""}
        {rows.length > 0 ? ` · ${start + 1}–${end}/${rows.length}` : ""}
      </Text>
    </Box>
  );
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tuiTranscriptView.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -8 /tmp/out`
Expected: `exit: 0`, 7 passed. (If the "▌" assertion fails because ink-testing-library trims the gutter into the border, assert on `f.includes("▌")` and that the tool line is present instead — the frame is 70 columns wide, so nothing should clip.)

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/TranscriptView.tsx tests/tuiTranscriptView.test.tsx
npm run lint > /tmp/out 2>&1; echo "exit: $?"
git add src/tui/components/TranscriptView.tsx tests/tuiTranscriptView.test.tsx
git commit -m "feat(dashboard): TranscriptView component"
```

---

### Task 6: RUNNING queue rows join the selectable index space

**Files:**

- Modify: `src/tui/components/QueueView.tsx` — doc comment (lines 36–44), RUNNING loop (line 179), WAITING index (line 244/247), RECENT index (line 285/289)
- Modify: `src/tui/App.tsx` — `LocalRow` + comment + `sectionRowsFor("queue")` (lines 457–482), the `retry` handler (~line 1491)
- Test: `tests/tuiQueue.test.tsx` (the two `selectable path` cases at lines 453–490), `tests/tuiApp.test.tsx`

**Interfaces:**

- Produces: `LocalRow` gains `{ kind: "running"; id: string }`; the queue's actionable index space is `running ⧺ waiting ⧺ recent` on both sides (App's `sectionRowsFor` and QueueView's `selectedRow`). Task 7's `enter` handler reads `localTarget.kind === "running" | "recent"`.

- [ ] **Step 1: Rewrite the two selectable tests**

In `tests/tuiQueue.test.tsx`, replace the two `it("selectable path: …")` cases (lines 453–490) with:

```tsx
it("selectable path: index 0 is the first RUNNING row (running ⧺ waiting ⧺ recent)", () => {
  const frame = render(
    <QueueView
      snap={FULL}
      scroll={0}
      now={NOW}
      height={30}
      focused={false}
      selectable
      selectedRow={0}
    />,
  ).lastFrame()!;
  const runLine = frame.split("\n").find((l) => l.includes("#46 exec"))!;
  expect(runLine).toContain("▌");
  const waitLine = frame.split("\n").find((l) => l.includes("1. #51 plan"))!;
  expect(waitLine).not.toContain("▌");
});

it("selectable path: WAITING follows RUNNING; RECENT follows WAITING", () => {
  const waitFrame = render(
    <QueueView
      snap={FULL}
      scroll={0}
      now={NOW}
      height={30}
      focused={false}
      selectable
      selectedRow={FULL.running.length}
    />,
  ).lastFrame()!;
  expect(waitFrame.split("\n").find((l) => l.includes("1. #51 plan"))!).toContain("▌");
  const recFrame = render(
    <QueueView
      snap={FULL}
      scroll={0}
      now={NOW}
      height={30}
      focused={false}
      selectable
      selectedRow={FULL.running.length + FULL.waiting.length}
    />,
  ).lastFrame()!;
  expect(recFrame.split("\n").find((l) => l.includes("#44 exec"))!).toContain("▌");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tuiQueue.test.tsx > /tmp/out 2>&1; echo "exit: $?"`
Expected: `exit: 1` — the running line has no `▌`, and `#51 plan` is highlighted at index 0.

- [ ] **Step 3: QueueView — make RUNNING rows selectable**

In `src/tui/components/QueueView.tsx`:

1. Replace the doc comment's middle sentence (lines 38–41) with:
   ```
    * mode `selectable` turns on a `▌` accent cursor over the actionable rows
    * (RUNNING, then WAITING, then RECENT — `selectedRow` indexes that
    * concatenation; a running row's only action is `enter` → its transcript),
    * and the window follows the cursor so a selected row past the fold stays
    * visible.
   ```
2. Replace `for (const r of snap.running) {` … its first `rows.push(<Text key={`r-${r.id}`} …>)` with:
   ```tsx
     snap.running.forEach((r, ri) => {
       const sel = selectable === true && selectedRow === ri;
       if (sel) selRowIndex = rows.length;
       rows.push(
         pressable(
           ri,
           sel,
           <Text key={`r-${r.id}`} wrap="truncate-end">
             {gutter(sel)}
             <Text color="cyan">◐ </Text>
             <Text bold>{queueLabel(r.github, r.id)}</Text>
             <Text dimColor> {r.id}</Text>
           </Text>,
           `r-${r.id}`,
         ),
       );
   ```
   and close the loop with `});` instead of `}` (the progress/gauge/stall pushes inside stay as they are).
3. WAITING: `const sel = selectable === true && selectedRow === snap.running.length + i;` and `pressable(snap.running.length + i, sel, …)`.
4. RECENT: before the `forEach`, `const recentBase = snap.running.length + snap.waiting.length;`; then `const sel = selectable === true && selectedRow === recentBase + j;` and `pressable(recentBase + j, sel, …)`.

- [ ] **Step 4: App — running rows in `LocalRow` and the retry guard**

In `src/tui/App.tsx`:

1. Replace the comment block + type (lines 457–470) with:
   ```ts
   // Selectable rows for the current section. INVARIANT: this list is the EXACT
   // rendered list each section component highlights, in the same order and
   // 1:1 by index — so the `▌` cursor (localCursorSafe) and the x/R action
   // target (localTarget) are always the SAME row. That means we do NOT pre-
   // filter out non-actionable rows here (a done RECENT row, a live worktree):
   // they stay in the list, exactly where the component draws them, and the
   // x/R handlers guard them into a safe toast instead. RUNNING rows are
   // selectable too (since the transcript viewer: `enter` opens their live
   // transcript) — retry/delete guard them the same way.
   // Gives x/R/o/f an explicit LOCAL target instead of the github currentRepo.
   type LocalRow =
     | { kind: "running"; id: string }
     | { kind: "waiting"; id: string }
     | { kind: "recent"; id: string; status: "done" | "failed" }
     | { kind: "outboxOp"; id: string }
     | { kind: "worktree"; path: string; slug: string; klass: "live" | "stale" | "backup" };
   ```
2. In `sectionRowsFor`, `case "queue"`:
   ```ts
   // running THEN waiting THEN all recent (done+failed) — the identical
   // index space QueueView highlights.
   return [
     ...q.running.map((r) => ({ kind: "running" as const, id: r.id })),
     ...q.waiting.map((w) => ({ kind: "waiting" as const, id: w.id })),
     ...q.recent.map((rr) => ({ kind: "recent" as const, id: rr.id, status: rr.status })),
   ];
   ```
3. In the `retry` action handler (~line 1491), add after the `done` toast:
   ```ts
   if (tgt?.kind === "running")
     return void showToast("info", "running — enter opens its transcript");
   ```

- [ ] **Step 5: App test — retry is inert on a running row**

Append to `tests/tuiApp.test.tsx` inside an existing `describe` that uses `renderApp` (e.g. next to the "shows system ▸ <section>" case):

```tsx
it("t on a RUNNING queue row toasts instead of spawning retry", async () => {
  const { client } = makeClient({ "acme/api": [rawIssue] });
  const spawned: string[] = [];
  const r = renderApp(client, wlc(), 999999, async (name) => {
    spawned.push(name);
    return { code: 0, output: "", timedOut: false };
  });
  await until(() => (r.lastFrame() ?? "").includes("#7"));
  r.stdin.write("j"); // rail → queue row
  await until(() => (r.lastFrame() ?? "").includes("system ▸ queue"));
  r.stdin.write("l"); // into pane 2 — cursor 0 is the RUNNING row (#46)
  await until(() => {
    const line = (r.lastFrame() ?? "").split("\n").find((l) => l.includes("#46 exec"));
    return line !== undefined && line.includes("▌");
  });
  r.stdin.write("t");
  await until(() => (r.lastFrame() ?? "").includes("enter opens its transcript"));
  expect(spawned).toEqual([]);
});
```

(`wlc` is the watchlist helper the neighbouring test uses; `rawIssue`/`makeClient`/`renderApp`/`until` are already in scope.)

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run tests/tuiQueue.test.tsx tests/tuiApp.test.tsx tests/tuiQueuePolish.test.tsx > /tmp/out 2>&1; echo "exit: $?"; grep -E "Tests|failed" /tmp/out`
Expected: `exit: 0`. If `tuiQueuePolish` or another queue test pinned the old "never RUNNING" behaviour, update its expectation to the new index space (running first) — do not weaken the assertion.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/tui/components/QueueView.tsx src/tui/App.tsx tests/tuiQueue.test.tsx tests/tuiApp.test.tsx
npm run lint > /tmp/out 2>&1; echo "exit: $?"
git add src/tui/components/QueueView.tsx src/tui/App.tsx tests/tuiQueue.test.tsx tests/tuiApp.test.tsx
git commit -m "feat(dashboard): running queue rows are selectable (running ⧺ waiting ⧺ recent)"
```

---

### Task 7: The `transcript` view — bindings, App wiring, input

**Files:**

- Modify: `src/tui/viewActions.ts` — `OverlayView` (line 22), `VIEW_OPTIONS` (line 107), `mainStructural` `case "queue"` (line 148), `viewStructural` (line 158)
- Modify: `src/tui/App.tsx` — `View` (line 153), imports (after line 79 / line 60), hook call (after line 306), `scrollKey` (line 437), `crumbs` (line 564), `bindingContext` (line 1112), `actionHandlers` `close` + view cases (lines 1159–1214), `handleSectionBodyInput` (line 1762), the view cascade before `cmdOutput` (line 1928), the render ternary before `view === "review"` (line 2407), a `useCallback` press handler near `sectionRowPress` (line 2202)
- Test: `tests/tuiViewActions.test.ts` (lines 48–60, 90–100), `tests/tuiApp.test.tsx`

**Interfaces:**

- Consumes: Tasks 4–6 (`useTranscript`, `TranscriptView`, `LocalRow.running`), `useScroll`'s `scrollBy`/`toEnd`/`onScrollMax`, `showToast`.
- Produces: `View` and `OverlayView` include `"transcript"`; keymap for that view is `{ t: "thinking", f: "follow", q: "close" }`.

- [ ] **Step 1: Write the failing binding tests**

In `tests/tuiViewActions.test.ts`:

1. Inside `it("overlay views (each with the hidden reserved q close)")`, append:
   ```ts
   expect(km({ kind: "view", view: "transcript" })).toEqual({
     t: "thinking",
     f: "follow",
     q: "close",
   });
   ```
2. In the `contexts` list of `it("no context ever hits the exhaustion fallback …")`, add `{ kind: "view", view: "transcript" },`.
3. Add a new case in the pinned-keymap describe:
   ```ts
   it("main:queue structural chips offer enter → transcript", () => {
     const chips = buildContextBindings({ kind: "main", body: "queue" }, 2, "wide").chips;
     expect(chips).toContainEqual({ kind: "structural", key: "enter", label: "transcript" });
   });
   ```

Run: `npx vitest run tests/tuiViewActions.test.ts > /tmp/out 2>&1; echo "exit: $?"` → Expected `exit: 1` (type error on `"transcript"` / missing chip).

- [ ] **Step 2: viewActions.ts**

```ts
export type OverlayView =
  | "detail"
  | "repoDetail"
  | "prs"
  | "prDetail"
  | "review"
  | "cmdOutput"
  | "transcript";
```

In `VIEW_OPTIONS`, add:

```ts
  transcript: [
    { id: "thinking", label: "thinking" },
    { id: "follow", label: "follow" },
    CLOSE,
  ],
```

In `mainStructural`, split `queue` out of the shared case:

```ts
    case "queue":
      return [s("↑/↓", "move"), s("enter", "transcript"), s("←", "back")];
    case "outbox":
    case "worktrees":
      return [s("↑/↓", "move"), s("←", "back")];
```

In `viewStructural`, add:

```ts
    case "transcript":
      return [s("↑/↓", "tool"), s("enter", "expand"), s("[/]", "scroll"), s("esc", "back")];
```

Run the viewActions test again → `exit: 0`.

- [ ] **Step 3: Write the failing App tests**

Append to `tests/tuiApp.test.tsx` (top-level helpers next to `LOCAL_CHEAP`, then a new `describe`):

```tsx
const RECENT_DONE = {
  id: "assess-x-1",
  github: null,
  status: "done" as const,
  finishedAt: "2026-07-07T10:05:00Z",
  resultStatus: "completed",
  durationSeconds: 667,
  prUrl: null,
  repoPath: null,
};
const LOCAL_CHEAP_WITH_RECENT: LocalCheap = {
  ...LOCAL_CHEAP,
  queue: { ...QUEUE_SNAP, recent: [RECENT_DONE] },
};
const DONE_SUMMARY = summarizeTranscript([
  runStart({ flow: "assess", modelId: "m" }),
  turnEndFull({
    thinking: "deep thoughts",
    text: "Assessment complete.",
    calls: [{ id: "c1", name: "read", args: { path: "game.js" }, result: "L1\nL2" }],
  }),
  runEnd({ stopReason: "stop", durationMs: 1000 }),
]);

describe("transcript view", () => {
  const openRecent = async (client: DashboardClient) => {
    (client as { readTranscript: unknown }).readTranscript = async () =>
      okv({ kind: "read" as const, size: 1, summary: DONE_SUMMARY });
    const r = renderApp(
      client,
      wlc(),
      999999,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => LOCAL_CHEAP_WITH_RECENT,
    );
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("j"); // rail → queue row
    await until(() => (r.lastFrame() ?? "").includes("system ▸ queue"));
    r.stdin.write("l"); // pane 2, cursor 0 = running
    r.stdin.write("j"); // waiting
    r.stdin.write("j"); // recent (assess-x-1)
    await until(() => {
      const line = (r.lastFrame() ?? "").split("\n").find((l) => l.includes("assess-x-1"));
      return line !== undefined && line.includes("▌");
    });
    r.stdin.write("\r");
    await until(() => (r.lastFrame() ?? "").includes("transcript ▸ assess-x-1"));
    return r;
  };

  it("enter on a recent row opens it; esc returns with the cursor preserved", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = await openRecent(client);
    expect(r.lastFrame()).toContain("Assessment complete.");
    expect(r.lastFrame()).toContain("▸ read game.js  → 2 lines");
    expect(r.lastFrame()).toContain("expand"); // footer/chips
    r.stdin.write(ESC);
    await until(
      () =>
        (r.lastFrame() ?? "").includes("system ▸ queue") &&
        !(r.lastFrame() ?? "").includes("Assessment complete."),
    );
    r.stdin.write("\r"); // same row still under the cursor → reopens
    await until(() => (r.lastFrame() ?? "").includes("transcript ▸ assess-x-1"));
  });

  it("t toggles thinking; enter expands the anchored tool result", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = await openRecent(client);
    expect(r.lastFrame()).not.toContain("deep thoughts");
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("deep thoughts"));
    expect(r.lastFrame()).not.toContain("L2");
    r.stdin.write("\r");
    await until(() => (r.lastFrame() ?? "").includes("L2"));
  });

  it("enter on a waiting row toasts — no transcript yet", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wlc());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("j");
    await until(() => (r.lastFrame() ?? "").includes("system ▸ queue"));
    r.stdin.write("l");
    r.stdin.write("j"); // waiting row (#51)
    await until(() => {
      const line = (r.lastFrame() ?? "").split("\n").find((l) => l.includes("#51 plan"));
      return line !== undefined && line.includes("▌");
    });
    r.stdin.write("\r");
    await until(() => (r.lastFrame() ?? "").includes("not started yet"));
    expect(r.lastFrame()).toContain("system ▸ queue");
  });
});
```

Add to the file's imports: `import { summarizeTranscript } from "../src/transcriptSummary.js";` and `import { runEnd, runStart, turnEndFull } from "./helpers/transcriptFixtures.js";`.

Run: `npx vitest run tests/tuiApp.test.tsx -t "transcript view" > /tmp/out 2>&1; echo "exit: $?"` → Expected `exit: 1` (no view opens).

- [ ] **Step 4: App.tsx wiring**

1. `View` union (line 153): add `| "transcript"`.
2. Imports: `import { TranscriptView } from "./components/TranscriptView.js";` (beside `ReviewView`) and `import { useTranscript } from "./hooks/useTranscript.js";` (beside `useReview`).
3. After the `useReview` call (line 306):
   ```ts
   const {
     transcript,
     openTranscript,
     closeTranscript,
     toggleThinking: toggleTranscriptThinking,
     setFollow: setTranscriptFollow,
     moveCursor: moveTranscriptCursor,
     setCursor: setTranscriptCursor,
     toggleExpanded: toggleTranscriptExpanded,
   } = useTranscript({ client, aliveRef });
   ```
   (`aliveRef` is declared at line 299 — move this call below it if needed.)
4. `scrollKey` (line 437): add `if (view === "transcript" && transcript) return \`transcript:${transcript.id}\`;`and`transcript` to the memo deps.
5. `crumbs` (line 564): add `if (view === "transcript" && transcript) return ["transcript", transcript.id];` and `transcript` to the deps.
6. `bindingContext` (line 1112): add `case "transcript":` to the `kind: "view"` group (with `detail`…`cmdOutput`).
7. `actionHandlers`: in `close` add, before the final `setView("main")`:
   ```ts
   if (view === "transcript") {
     closeTranscript();
     return void setView("main");
   }
   ```
   and a new view case beside `case "cmdOutput":`:
   ```ts
         case "transcript":
           return {
             close,
             thinking: toggleTranscriptThinking,
             ...(transcript?.summary?.live
               ? {
                   follow: () => {
                     // Pausing lands at the tail first (log-overlay recipe) so the
                     // paused window shows the newest rows, not a jump to the top.
                     if (transcript.follow) toEnd();
                     setTranscriptFollow(!transcript.follow);
                   },
                 }
               : {}),
           };
   ```
   Add `transcript`, `closeTranscript`, `toggleTranscriptThinking`, `setTranscriptFollow`, `toEnd` to the `actionHandlers` memo deps.
8. `handleSectionBodyInput` (line 1762): after the `logs` branch, before the `j`/`k` lines:
   ```ts
   if (sysSection === "queue" && key.return) {
     const tgt = localTarget;
     if (tgt?.kind === "running" || tgt?.kind === "recent") {
       openTranscript(tgt.id, { expectLive: tgt.kind === "running" });
       setView("transcript");
     } else if (tgt?.kind === "waiting") {
       showToast("info", "not started yet — no transcript");
     }
     return;
   }
   ```
9. View cascade — insert before `if (view === "cmdOutput") {` (line 1928):
   ```ts
   if (view === "transcript") {
     // t/f dispatch at layer 3d (thinking/follow); esc mirrors the q close.
     if (key.escape) return void actionHandlers["close"]?.();
     if (input === "j" || key.downArrow) return void moveTranscriptCursor(1);
     if (input === "k" || key.upArrow) return void moveTranscriptCursor(-1);
     if (key.return || input === " ") return void toggleTranscriptExpanded();
     if (input === "]") return void scrollBy(1);
     if (input === "[") {
       if (transcript?.follow) {
         toEnd();
         setTranscriptFollow(false);
       }
       return void scrollBy(-1);
     }
     if (input === "G" || key.end) {
       if (transcript?.summary?.live) setTranscriptFollow(true);
       return;
     }
     if (input === "g") {
       setTranscriptCursor(0);
       return void scrollBy(-1_000_000); // clamps to 0
     }
     return;
   }
   ```
10. Near `sectionRowPress` (line 2202):
    ```ts
    const transcriptRowPress = useCallback(
      (idx: number): void => {
        setTranscriptCursor(idx);
        toggleTranscriptExpanded();
      },
      [setTranscriptCursor, toggleTranscriptExpanded],
    );
    ```
11. Render — insert before `) : view === "review" ? (` (line 2407):
    ```tsx
          ) : view === "transcript" && transcript ? (
            <ClickableBox
              flexGrow={1}
              onWheel={(d) => {
                if (d < 0 && transcript.follow) {
                  toEnd();
                  setTranscriptFollow(false);
                }
                scrollBy(d);
              }}
            >
              <TranscriptView
                state={transcript}
                scroll={scroll}
                height={listHeight}
                width={size.columns}
                focused
                onScrollMax={onScrollMax}
                onRowPress={transcriptRowPress}
              />
            </ClickableBox>
    ```
    (`size` is the `useTerminalSize` result at line 271; `listHeight` is defined at line 2275 — the render sits below it.)

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/tuiApp.test.tsx tests/tuiViewActions.test.ts tests/tuiChrome.test.tsx tests/tuiDeclutter.test.tsx > /tmp/out 2>&1; echo "exit: $?"; grep -E "Tests|✗|failed" /tmp/out | head`
Expected: `exit: 0`. Then `npm run lint > /tmp/out 2>&1; echo "exit: $?"` — 0 (every new memo/callback dep listed). If a help-modal or footer snapshot test pinned the queue chips, update it to include `enter transcript`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/tui/App.tsx src/tui/viewActions.ts tests/tuiApp.test.tsx tests/tuiViewActions.test.ts
git add src/tui/App.tsx src/tui/viewActions.ts tests/tuiApp.test.tsx tests/tuiViewActions.test.ts
git commit -m "feat(dashboard): transcript view — enter on a queue row, live follow, expand, thinking"
```

---

### Task 8: `junco transcript` CLI + palette entry

**Files:**

- Create: `src/transcriptCmd.ts`
- Modify: `src/cli.ts` — strict-parse options (after the replay-only block, ~line 293), help text (after the `replay` entry, line 209), dispatch (after the `replay` block, ~line 697)
- Modify: `src/tui/cliRunner.ts` — `PALETTE_COMMANDS` (after `cmd("assess", …)`, ~line 58)
- Test: `tests/transcriptCmd.test.ts`; `tests/tuiCliRunner.test.ts` (roster pin, line 45–72)

**Interfaces:**

- Consumes: Tasks 1–2; `transcriptPathFor`, `dataTreePaths`; `loadConfig` via `cli.ts`'s `loadConfigFn`.
- Produces:

  ```ts
  export interface TranscriptCmdDeps {
    loadCfg: () => Config;
    readFile: (p: string) => string;
    stdout: (line: string) => void;
    columns: number;
  }
  export async function runTranscriptCmd(argv: string[], deps: TranscriptCmdDeps): Promise<number>; // 0 ok · 1 not found · 2 usage
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/transcriptCmd.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runTranscriptCmd } from "../src/transcriptCmd.js";
import { transcriptPathFor } from "../src/slug.js";
import { dataTreePaths } from "../src/dataTree.js";
import { makeConfig, type ConfigSeams } from "./helpers/config.js";
import { agentStart, runEnd, runStart, turnEndFull } from "./helpers/transcriptFixtures.js";

const seams: ConfigSeams = {
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/queue",
  worktreeRoot: "/sbxroot/wts",
  tools: [],
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: true,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
};

const FIXTURE = [
  runStart({ flow: "assess", modelId: "m", ts: "2026-08-29T01:02:47.000Z" }),
  agentStart(),
  turnEndFull({
    thinking: "deep thoughts",
    text: "Assessment complete.",
    calls: [{ id: "c1", name: "read", args: { path: "game.js" }, result: "L1\nL2" }],
  }),
  runEnd({ stopReason: "stop", durationMs: 5000 }),
].join("\n");

describe("runTranscriptCmd", () => {
  const deps = (
    files: Record<string, string>,
    cfg: (() => ReturnType<typeof makeConfig>) | null = () => makeConfig(seams),
  ) => {
    const out: string[] = [];
    return {
      out,
      d: {
        loadCfg: () => {
          if (cfg === null) throw new Error("no config");
          return cfg();
        },
        readFile: (p: string) => {
          if (files[p] === undefined) throw new Error("ENOENT");
          return files[p];
        },
        stdout: (l: string) => out.push(l),
        columns: 80,
      },
    };
  };
  const path = transcriptPathFor(dataTreePaths(makeConfig(seams)).transcripts, "t-1");

  it("resolves a bare ticket id through the data tree and renders rows", async () => {
    const { out, d } = deps({ [path]: FIXTURE });
    expect(await runTranscriptCmd(["t-1"], d)).toBe(0);
    expect(out[0]).toContain("── run 1/1 · assess · m · 01:02:47 · stop · 5s");
    expect(out).toContain("  Assessment complete.");
    expect(out).toContain("  ▸ read game.js  → 2 lines");
    expect(out.some((l) => l.includes("deep thoughts"))).toBe(false);
    expect(out.some((l) => l.includes("L2"))).toBe(false);
  });

  it("--thinking and --tools expand thinking and every tool body", async () => {
    const { out, d } = deps({ [path]: FIXTURE });
    expect(await runTranscriptCmd(["t-1", "--thinking", "--tools"], d)).toBe(0);
    expect(out).toContain("  deep thoughts");
    expect(out).toContain("      L2");
  });

  it("a direct .jsonl path needs no config", async () => {
    const { out, d } = deps({ "/tmp/x.jsonl": FIXTURE }, null);
    expect(await runTranscriptCmd(["/tmp/x.jsonl"], d)).toBe(0);
    expect(out[0]).toContain("run 1/1");
  });

  it("bare id without config is exit 1 with guidance", async () => {
    const { out, d } = deps({}, null);
    expect(await runTranscriptCmd(["t-1"], d)).toBe(1);
    expect(out.join("\n")).toContain("no config found");
  });

  it("missing transcript is exit 1 with the path and transcripts dir", async () => {
    const { out, d } = deps({});
    expect(await runTranscriptCmd(["t-1"], d)).toBe(1);
    expect(out.join("\n")).toContain(`no transcript at ${path}`);
    expect(out.join("\n")).toContain("transcripts dir:");
  });

  it("--json prints the summary", async () => {
    const { out, d } = deps({ [path]: FIXTURE });
    expect(await runTranscriptCmd(["t-1", "--json"], d)).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as { runs: { turns: { text: string }[] }[] };
    expect(parsed.runs[0].turns[0].text).toBe("Assessment complete.");
  });

  it("--width bounds every line; bad width and no target are usage errors", async () => {
    const { out, d } = deps({ [path]: FIXTURE });
    expect(await runTranscriptCmd(["t-1", "--width", "30"], d)).toBe(0);
    expect(out.every((l) => l.length <= 30)).toBe(true);
    expect(await runTranscriptCmd(["t-1", "--width", "abc"], deps({}).d)).toBe(2);
    expect(await runTranscriptCmd([], deps({}).d)).toBe(2);
    expect(await runTranscriptCmd(["t-1", "--nope"], deps({}).d)).toBe(2);
  });
});
```

Run: `npx vitest run tests/transcriptCmd.test.ts > /tmp/out 2>&1; echo "exit: $?"` → Expected `exit: 1`.

- [ ] **Step 2: Implement `src/transcriptCmd.ts`**

```ts
/**
 * `junco transcript <ticket-id | path.jsonl> [--thinking] [--tools] [--width N] [--json]`
 * — prints a recorded per-ticket event transcript as the transcript viewer
 * renders it: run headers, turns, tool calls with result summaries (bodies
 * with --tools), the agent's text (thinking with --thinking). Target
 * resolution mirrors replayCmd.ts: a bare id resolves through the data tree
 * (config required); a literal path (ends in .jsonl or contains "/") reads
 * as-is, config optional.
 */
import { parseArgs } from "node:util";
import type { Config } from "./types.js";
import { transcriptPathFor } from "./slug.js";
import { dataTreePaths } from "./dataTree.js";
import { summarizeTranscript, toolCallIds } from "./transcriptSummary.js";
import { renderTranscriptRows, MIN_WIDTH } from "./transcriptRender.js";

export interface TranscriptCmdDeps {
  /** May throw (no config on disk) — tolerated for a direct .jsonl target. */
  loadCfg: () => Config;
  /** Throws (e.g. ENOENT) when the path doesn't exist. */
  readFile: (path: string) => string;
  stdout: (line: string) => void;
  /** Terminal width for wrapping (cli.ts passes `process.stdout.columns ?? 100`). */
  columns: number;
}

const USAGE =
  "Usage: junco transcript <ticket-id | path.jsonl> [--thinking] [--tools] [--width N] [--json]";

function isPathLike(target: string): boolean {
  return target.endsWith(".jsonl") || target.includes("/");
}

export async function runTranscriptCmd(argv: string[], deps: TranscriptCmdDeps): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        thinking: { type: "boolean", default: false },
        tools: { type: "boolean", default: false },
        width: { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    deps.stdout(e instanceof Error ? e.message : String(e));
    deps.stdout(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const target = positionals[0];
  if (!target) {
    deps.stdout(USAGE);
    return 2;
  }
  let width = deps.columns;
  if (values.width !== undefined) {
    width = Number(values.width);
    if (!Number.isInteger(width) || width < MIN_WIDTH) {
      deps.stdout(`junco transcript: --width must be an integer ≥ ${MIN_WIDTH}`);
      return 2;
    }
  }

  let cfg: Config | undefined;
  try {
    cfg = deps.loadCfg();
  } catch {
    cfg = undefined;
  }
  let transcriptPath: string;
  if (isPathLike(target)) {
    transcriptPath = target;
  } else {
    if (!cfg) {
      deps.stdout(
        `junco transcript: no config found — cannot resolve ticket id '${target}' to a transcript ` +
          "path; pass a direct .jsonl path instead",
      );
      return 1;
    }
    transcriptPath = transcriptPathFor(dataTreePaths(cfg).transcripts, target);
  }

  let content: string;
  try {
    content = deps.readFile(transcriptPath);
  } catch {
    const hint = cfg ? ` (transcripts dir: ${dataTreePaths(cfg).transcripts})` : "";
    deps.stdout(`junco transcript: no transcript at ${transcriptPath}${hint}`);
    return 1;
  }

  const summary = summarizeTranscript(content.split("\n"));
  if (values.json) {
    deps.stdout(JSON.stringify(summary, null, 2));
    return 0;
  }
  const rows = renderTranscriptRows(summary, {
    width,
    showThinking: values.thinking === true,
    expanded: new Set(values.tools === true ? toolCallIds(summary) : []),
  });
  for (const r of rows) deps.stdout(r.text);
  return 0;
}
```

- [ ] **Step 3: Wire `cli.ts`**

1. Help text — after the `replay` entry's last line (line 209):
   ```
     transcript <ticket-id|path.jsonl> [--thinking] [--tools] [--width N] [--json]
                           Print a recorded event transcript — runs, turns, tool
                           calls and results, the agent's answer (the dashboard
                           opens the same view with enter on a queue row)
   ```
2. Strict-parse options — after the replay-only block (~line 293):
   ```ts
         // transcript-only (src/transcriptCmd.ts parses its own slice; declared
         // here for the same reason as the replay knobs above).
         thinking: { type: "boolean", default: false },
         tools: { type: "boolean", default: false },
         width: { type: "string" },
   ```
   (`json` is already declared.)
3. Dispatch — after the `replay` block (~line 697):
   ```ts
   // ------------------------------------------------------------
   // transcript: render a recorded event transcript (src/transcriptCmd.ts).
   // Same raw sub-argv handoff and lazy import as replay above.
   // ------------------------------------------------------------
   if (subcommand === "transcript") {
     const { runTranscriptCmd } = await import("./transcriptCmd.js");
     const idx = argv.indexOf("transcript");
     const subArgv = idx === -1 ? positionals.slice(1) : argv.slice(idx + 1);
     return runTranscriptCmd(subArgv, {
       loadCfg: () => loadConfigFn(configPath),
       readFile: (p: string) => readFileSync(p, "utf8"),
       stdout: (l: string) => printFn(l + "\n"),
       columns: process.stdout.columns ?? 100,
     });
   }
   ```

- [ ] **Step 4: Palette roster**

In `src/tui/cliRunner.ts`, after the `cmd("assess", …)` entry:

```ts
  cmd("transcript", "<ticket-id> [--thinking] [--tools]", "Print a ticket's event transcript"),
```

In `tests/tuiCliRunner.test.ts`, the roster pin: `"carries 19 runnable and 2 excluded-with-reason entries"` and add `"transcript"` to the sorted expected list (between `"submit"` and `"unwatch"`, keeping it alphabetical). Run `npx vitest run tests/tuiPalette.test.tsx tests/usePalette.test.tsx` too — update any other pinned count the same way.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/transcriptCmd.test.ts tests/tuiCliRunner.test.ts tests/tuiPalette.test.tsx tests/usePalette.test.tsx tests/cli.test.ts > /tmp/out 2>&1; echo "exit: $?"; grep -E "Tests|failed" /tmp/out`
Expected: `exit: 0`. Then a real smoke in a sandbox (the maintainer's HOME holds live state — never run against it):

```bash
npm run build > /tmp/out 2>&1; echo "exit: $?"
SB=$(mktemp -d) && cd "$SB" && HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /Users/alxedelweiss/Development/junco/worktrees-manual/transcript-viewer/dist/cli.js transcript /nonexistent.jsonl; echo "exit: $?"; cd / && rm -rf "$SB"
```

Expected: `junco transcript: no transcript at /nonexistent.jsonl`, `exit: 1`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/transcriptCmd.ts src/cli.ts src/tui/cliRunner.ts tests/transcriptCmd.test.ts tests/tuiCliRunner.test.ts
git add src/transcriptCmd.ts src/cli.ts src/tui/cliRunner.ts tests/transcriptCmd.test.ts tests/tuiCliRunner.test.ts tests/tuiPalette.test.tsx tests/usePalette.test.tsx
git commit -m "feat(cli): junco transcript <id|path.jsonl> — print a recorded event transcript"
```

---

### Task 9: Documentation + full gate

**Files:**

- Modify: `ARCHITECTURE.md` (module map: after the `replayCmd.ts` row, line 274; the `tui/` row, line 284), `README.md` (CLI table, line 202+), `docs/dashboard.md` (lines 21, 68, 82, 96, 108, 112, 114), `docs/operations.md` (line 74), `CLAUDE.md` (line 68), `CHANGELOG.md` (`[Unreleased]`)

- [ ] **Step 1: ARCHITECTURE.md**

After the `replayCmd.ts` row add three rows in the same table style:

```
| `transcriptSummary.ts`      | `summarizeTranscript(lines)` — reduces a per-ticket JSONL transcript to runs → turns → tool calls (with results matched by toolCallId from `turn_end.toolResults`), run frames from `junco_run_start/end` (v1 fallback: `agent_start/end`, as `agent/replay.ts`), a PROVISIONAL turn built from `tool_execution_*` between turn_ends (live view + crash-truncated files), guard decisions, and `live` (last run has no end record). Pure — the transcript viewer's model for both the dashboard and `junco transcript`. `toolCallIds()` is the viewer's cursor index space. |
| `transcriptRender.ts`       | `renderTranscriptRows(summary, { width, showThinking, expanded })` — width-bounded text rows with tones and tool-row anchors: run headers (`fmtRunOutcome`), turn lines, wrapped prose, `fmtToolCall`/`fmtToolResult` one-liners, expanded result bodies capped at `TOOL_BODY_MAX_LINES` (400). Pure; the dashboard maps tones to Ink props, the CLI prints `text`. |
| `transcriptCmd.ts`          | `junco transcript <ticket-id\|path.jsonl> [--thinking] [--tools] [--width N] [--json]` — prints a transcript through `transcriptSummary`/`transcriptRender`; target resolution and deps seam mirror `replayCmd.ts`. |
```

In the `tui/` row, where the hooks/components are listed, add: `` `hooks/useTranscript.ts` (open transcript state + the 1 s live poll, stat-gated through `DashboardClient.readTranscript`) and `components/TranscriptView.tsx` (the `transcript` view: `enter` on a RUNNING/RECENT queue row; `j/k` over tool rows, `enter` expands a result, `t` thinking, `f` follow while live, `[`/`]` scroll) ``.

- [ ] **Step 2: README.md**

In "CLI at a glance", after the `junco doctor` row:

```
| `junco transcript <ticket-id>`                                | print a ticket's recorded event transcript — runs, tool calls, results, the agent's answer (`--thinking`, `--tools`) |
```

- [ ] **Step 3: docs/dashboard.md**

1. Line 21 (breadcrumb list): after `` `command ▸ <name>` while a palette command's output is open (e.g. `command ▸ junco retry`), `` insert `` `transcript ▸ <ticket-id>` while a ticket's transcript is open, ``.
2. Line 68 (`enter` row): change the description to `open the selection — repo detail (rail), issue detail (issues), PR overlay (PR monitor/PRs), the log overlay (logs row), the transcript (running/recent queue row)`.
3. Line 82 (queue row keys): `` `enter` open the ticket's transcript · `t` retry a failed ticket · `D` Delete a queued ticket (confirmed) ``.
4. Line 96 (palette): add `transcript` to the args-taking list: ``(commands that take arguments — `list`, `retry`, `outbox`, `submit`, `logs`, `service`, `transcript` — get an args field first)``.
5. Line 108 (Queue bullet), append before the final sentence: `` `enter` on a running or recent row opens its transcript (see below). ``
6. After the Logs bullet (line 112) add:
   ```
   - **Transcript** — `enter` on a running or recent queue row opens the ticket's recorded event transcript as a fullscreen view: one header per run (`run 2/4 · assess · <model> · 01:02:47 · stop · 11m07s · in 34.7k out 1.9k`, or the error line for a failed attempt), then each turn's text and its tool calls (`▸ read game.js  → 214 lines`). `j`/`k` (or the arrows) move a cursor over the tool rows and `enter`/space expands that call's full result under it (capped at 400 lines); `[`/`]` scroll row-wise; `t` shows the model's thinking blocks (hidden by default); `g` jumps to the top. A running ticket's transcript is live: the view follows the tail as the agent works (`f` or `G` toggles/resumes follow, scrolling up pauses it) and flips to the final outcome when the run ends — opening a running row before its agent has started shows `waiting for the agent to start…` and fills in by itself. `esc`/`q` returns to the queue with the cursor where it was. The same rendering is available from the CLI as `junco transcript <ticket-id>`.
   ```
7. Line 114: replace `Rows the daemon itself owns are never selectable: running/processing queue rows and live worktrees render — so you can see them — but the cursor skips past them (running) or guards the action into a safe toast (live worktrees).` with `Rows the daemon itself owns are never actionable: a running queue row can be selected only to open its transcript (retry toasts instead), and a live worktree guards the prune into a safe toast.`

- [ ] **Step 4: docs/operations.md and CLAUDE.md**

`docs/operations.md` line 74, append to the Transcripts paragraph: ``Read one with `junco transcript <ticket-id>` (`--thinking` for reasoning blocks, `--tools` for full tool output, `--json` for the parsed model) or with `enter` on the ticket's row in the dashboard's queue section — live while it runs.``

`CLAUDE.md` line 68, append: `` `junco transcript <id>` (or `enter` on the dashboard's queue row) renders it: runs, tool calls + results, the agent's answer. ``

- [ ] **Step 5: CHANGELOG.md**

Under `## [Unreleased]`:

```
### Added

- Transcript viewer. `junco transcript <ticket-id|path.jsonl> [--thinking] [--tools] [--width N] [--json]` prints a ticket's recorded event transcript — one header per run (flow, model, outcome, duration, tokens; the error line for a failed attempt), each turn's text, and every tool call with a one-line result summary (`--tools` prints the bodies, `--thinking` the model's reasoning). The dashboard opens the same view with `enter` on any running or recent queue row: `j`/`k` move over tool calls, `enter` expands a result inline (capped at 400 lines), `t` toggles thinking, and a running ticket's transcript follows live (`f`/`G` follow, scrolling pauses) until the run ends. RUNNING queue rows are now selectable for this; retry/delete stay inert on them.
```

- [ ] **Step 6: Full gate**

```bash
npx prettier --write ARCHITECTURE.md README.md docs/dashboard.md docs/operations.md CLAUDE.md CHANGELOG.md
npm run lint > /tmp/out 2>&1; echo "lint: $?"
npm run format:check > /tmp/out 2>&1; echo "format: $?"
npm run typecheck > /tmp/out 2>&1; echo "typecheck: $?"
npm run build > /tmp/out 2>&1; echo "build: $?"
npx vitest run > /tmp/out 2>&1; echo "test: $?"; tail -6 /tmp/out
npx vitest run --coverage > /tmp/cov 2>&1; echo "coverage: $?"
```

Expected: every exit 0 (coverage thresholds in `vitest.config.ts` still met — the new modules are fully tested, so the floor rises, never falls).

- [ ] **Step 7: Commit, then finish the branch**

```bash
git add ARCHITECTURE.md README.md docs/dashboard.md docs/operations.md CLAUDE.md CHANGELOG.md
git commit -m "docs: transcript viewer — dashboard view, junco transcript, module map"
git log --format='%B' origin/main..HEAD | grep -iE 'co-authored-by|generated with' && echo "STRIP AI TRAILERS (git rebase -i is unavailable: use git commit --amend / filter per commit)" || echo "trailers clean"
```

Then use the `superpowers:finishing-a-development-branch` skill: push `feat/transcript-viewer`, open a PR against `main` (title `feat: transcript viewer — dashboard view + junco transcript`), and wait for the `quality-gate` check. **Do not** tag, release, or touch the maintainer's live `~/.junco` state.

---

## Self-review

**Spec coverage.** §1 model → Task 1; §2 rendering (grammar, wrap, cap, `fmtToolCall` families, outcome states) → Task 2; §3 `readTranscript` stat gate + `statFn` → Task 3; §4 hook (poll rule, `expectLive`, cursor clamp, no `setView`) → Task 4; §5 component (window math, header states, footer) → Task 5, running rows selectable → Task 6, App wiring (`View`, bindings `t`/`f`/`q`, structural chips incl. queue `enter transcript`, `scrollKey`, crumbs, close restores the queue cursor, mouse wheel/press) → Task 7; §6 CLI + palette → Task 8; §7 error table → Tasks 3/4/5/8 tests (missing/waiting/torn/v1/read-throw/cap); §8 test list → one file per bullet; §9 docs → Task 9. Decision "no config knobs" honoured (no `Config` change).

**Placeholders.** None: every step has its code, command, and expected output. The one conditional in Task 2 Step 4 (tool-row `truncate`) names the exact change.

**Type consistency.** `TranscriptRead` kinds `missing|unchanged|read` (Task 3) match the hook (Task 4) and its tests; `TranscriptState` fields used by `TranscriptView` (Task 5) and App (Task 7) — `id/expectLive/loading/error/summary/showThinking/follow/cursor/expanded` — are all declared in Task 4; `TranscriptApi` names (`openTranscript(id, { expectLive })`, `closeTranscript`, `toggleThinking`, `setFollow(on)`, `moveCursor(delta)`, `setCursor(idx)`, `toggleExpanded`) are the ones App destructures (aliased with a `Transcript` infix); `renderTranscriptRows(summary, { width, showThinking, expanded })` is called identically by Task 5 and Task 8; `LocalRow.running` (Task 6) is what Task 7's `enter` handler reads; the `transcript` keymap `{ t, f, q }` derives from labels `thinking`/`follow` under `OVERLAY_RESERVED` (`close → q`) exactly as the viewActions test pins.
