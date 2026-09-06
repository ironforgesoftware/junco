# Dashboard Chat Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard chat streams characters as the provider emits them, shows the model's thinking as its own live block that folds away when the answer starts, shows tool calls as live cards, renders the answer as markdown with highlighted code, and resumes exactly after a reconnect — all at O(live block) render cost per frame.

**Architecture:** The daemon still owns the Pi session and the dashboard still observes it over the health server's SSE stream. The daemon gains a pure per-turn accumulator (`LiveTurn`) that re-tags SDK deltas into three slim bus-only records (`junco_chat_delta`, `junco_chat_tool`, `junco_chat_partial`) — the last is the in-flight snapshot sent first on attach — and a streaming `<think>` splitter for endpoints that emit tags. The client replaces the flat `liveText` string with a block model reduced by a pure `applyLiveRecord`, flushes once per Ink frame, and splits the view into memoized finished turns and a live turn so a flush never re-lays-out history. Markdown is a junco-owned block renderer; fenced code uses Pi's `highlightCode` through the existing `agent/session.ts` import seam.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), `@earendil-works/pi-coding-agent` 0.84.x (runtime import only inside `src/agent/session.ts`), Ink 7.1 + React 19, vitest, `node:http` SSE. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-09-06-chat-streaming-design.md` — every task cites the section it implements. Read the spec's "Decisions" (D1–D9) and "Non-goals" first; they are settled.

## Global Constraints

- Never import the Pi SDK at module top level in `src/`; the runtime `await import(...)` lives only in `src/agent/session.ts`. Type-only imports are fine.
- Every side effect goes behind an injectable `deps` seam. Tests never touch the network or a real model.
- `src/ticketSchema.ts` is untouched. The chat tool set, the `junco_submit` handshake, gates, spend, and the `/chat/*` auth boundary are untouched (spec Non-goals).
- The transcript file never gains a delta, a thinking delta, or a partial. `junco_chat_delta` / `junco_chat_tool` / `junco_chat_partial` are **bus-only** and carry **no SSE `id`**.
- A new `Config` field goes in `tests/helpers/config.ts` (the only full `Config` literal) as ballast, not as a `ConfigSeams` key.
- `src/tui/**`: `eslint-plugin-react-hooks` runs both rules at error; fix deps, never `eslint-disable`.
- Ink tests: gate every assertion on `until()` from `tests/helpers/until.js`; loop-until-condition, never a fixed tick. No snapshots — assert on `lastFrame()` substrings, as the suite does.
- Commits: conventional (`feat:`/`fix:`/`refactor:`/`docs:`/`test:`), **no AI attribution trailers** (`.claude/settings.json` enforces it), suite green at every commit. Run `npx prettier --write` on touched files before committing.
- Work in a manual worktree under `worktrees-manual/` on `feat/chat-streaming`, with its **own** `npm ci` (never a `node_modules` symlink — `git worktree remove --force` and `npm ci` both delete through it). Never touch the main checkout (the daemon's build home). Merge `origin/main` between tasks.
- Full gate before claiming a task done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test && npm run test:e2e` — capture vitest's exit code explicitly (`npx vitest run > /tmp/out 2>&1; echo "exit: $?"`), never pipe it into `tail`/`grep`.
- New top-level `src/*.ts` modules need an `ARCHITECTURE.md` module-map row (`tests/architectureModuleMap.test.ts` pins it). Nested modules (`src/chat/*`, `src/tui/*`) are covered by their directory rows but get a mention in Task 18.

---

## File structure

**New — daemon side:**

| file                        | responsibility                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/chat/liveBlocks.ts`    | `LiveBlock` union + the three bus-only record types + `applyLiveRecord` (pure, shared both sides) |
| `src/chat/thinkSplitter.ts` | streaming `<think>…</think>` state machine (spec §2.1)                                            |
| `src/chat/liveTurn.ts`      | per-turn accumulator: SDK events → bus records + snapshot (spec §1.2, §2.3)                       |

**New — client side:**

| file                                   | responsibility                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `src/tui/markdown/blocks.ts`           | markdown → block list (paragraph, heading, list, quote, fence, rule); pure      |
| `src/tui/markdown/render.ts`           | blocks → `TranscriptRow[]`, closed-block cache, open-tail re-render (spec §4.2) |
| `src/tui/components/ThinkingBlock.tsx` | the four thinking states (spec §4.3)                                            |
| `src/tui/components/ToolCard.tsx`      | live + finished tool cards (spec §4.4)                                          |
| `src/tui/components/LiveTurn.tsx`      | rows for the in-flight turn, O(live block) per frame (spec §4.1)                |
| `src/tui/components/FinishedTurns.tsx` | rows for `summary` only; never re-runs on a flush (spec §4.1)                   |

**Modified:** `src/agent/transcriptSchema.ts`, `src/chat/chatSession.ts`, `src/chat/chatManager.ts`, `src/chat/chatRoutes.ts`, `src/transcriptSummary.ts`, `src/transcriptRender.ts`, `src/tui/hooks/useChat.ts`, `src/tui/hooks/useChatInput.ts`, `src/tui/components/ChatView.tsx`, `src/tui/components/TranscriptBody.tsx`, `src/tui/viewActions.ts`, `src/tui/theme.ts`, `src/dashboardCmd.ts`, `src/agent/session.ts`, `src/doctor.ts`, `src/configSchema.ts`, `src/configAssemble.ts`, `src/types.ts`, `src/configLevers.ts`, `tests/helpers/config.ts`, `tests/helpers/transcriptFixtures.ts`, `tests/helpers/fakeSession.ts`, `tests/e2e/chatSubmit.e2e.ts`, docs.

**Task order** (spec "Implementation notes"): config → schema/fixtures → splitter → liveTurn → session/manager → routes → incremental summary → client reducer → useChat → maxFps → view split → thinking → markdown (pure) → markdown wired + highlighter → tool cards + keys → doctor → e2e → perf/docs.

---

### Task 1: Config knobs `chat.thinkTags` and `chat.maxFps`

Spec §5. Two fields, ballast in the test helper, two levers (the bijection test enforces them).

**Files:**

- Modify: `src/configSchema.ts` (chat block, lines 246–255 — insert after `confirmTimeoutMinutes` at 253)
- Modify: `src/configAssemble.ts` (chat assembly, lines 241–247)
- Modify: `src/types.ts` (`ChatConfig`, lines 108–117)
- Modify: `src/configLevers.ts` (`// --- chat.* ---` block, lines 821–873; append after `chat.confirmTimeoutMinutes`)
- Modify: `tests/helpers/config.ts` (chat ballast, lines 146–153)
- Test: `tests/config.test.ts` (`describe("chat section (spec 2026-09-01 §10)")`, lines 1249–1283), `tests/configLevers.test.ts` (bijection — no new test needed)

**Interfaces:**

- Produces: `Config.chat.thinkTags: "auto" | "on" | "off"` (default `"auto"`), `Config.chat.maxFps: number` (default 60, min 10, max 120).

- [ ] **Step 1: Write the failing test**

In `tests/config.test.ts`, inside the chat describe, extend both `toEqual` literals and add:

```ts
it("streaming knobs: thinkTags defaults auto, maxFps defaults 60 and is bounded (spec 2026-09-06 §5)", () => {
  const cfg = loadConfig(writeJson({}));
  expect(cfg.chat.thinkTags).toBe("auto");
  expect(cfg.chat.maxFps).toBe(60);
  expect(loadConfig(writeJson({ chat: { thinkTags: "off", maxFps: 30 } })).chat).toMatchObject({
    thinkTags: "off",
    maxFps: 30,
  });
  expect(() => loadConfig(writeJson({ chat: { maxFps: 5 } }))).toThrow();
  expect(() => loadConfig(writeJson({ chat: { thinkTags: "maybe" } }))).toThrow();
});
```

The two existing `expect(cfg.chat).toEqual({...})` literals gain `thinkTags: "auto", maxFps: 60` (and `thinkTags: "off", maxFps: 30` where the explicit test sets them — add those to its input too).

- [ ] **Step 2: Run to verify it fails**

`npx vitest run tests/config.test.ts tests/configLevers.test.ts > /tmp/t1 2>&1; echo "exit: $?"` — expected exit 1; `npm run typecheck` fails on `cfg.chat.thinkTags`.

- [ ] **Step 3: Implement**

`src/configSchema.ts` after line 253:

```ts
      thinkTags: z.enum(["auto", "on", "off"]).default("auto"),
      maxFps: z.number().int().min(10).max(120).default(60),
```

`src/configAssemble.ts` after `confirmTimeoutMinutes: d.chat.confirmTimeoutMinutes,`:

```ts
      thinkTags: d.chat.thinkTags,
      maxFps: d.chat.maxFps,
```

`src/types.ts` `ChatConfig`:

```ts
/** Split inline `<think>…</think>` spans into thinking deltas (spec 2026-09-06 §2.1).
 *  `auto`: unless the turn already streamed native thinking_delta. */
thinkTags: "auto" | "on" | "off";
/** Ink frame cap for the dashboard while chat streams (D8). */
maxFps: number;
```

`src/configLevers.ts` after the `chat.confirmTimeoutMinutes` lever:

```ts
  {
    path: "chat.thinkTags",
    type: "string",
    default: "auto",
    values: ["auto", "on", "off"],
    editable: true,
    reload: "live",
    description:
      "Split inline <think>…</think> spans from the answer into the thinking block; auto skips a turn that already streams native thinking.",
  },
  {
    path: "chat.maxFps",
    type: "number",
    default: 60,
    min: 10,
    max: 120,
    editable: true,
    reload: "restart",
    description: "Dashboard frame cap while the chat streams (lower on a slow terminal or machine).",
  },
```

(Match the enum-lever shape the bijection test at `tests/configLevers.test.ts:97` expects — copy an existing `values:` lever, e.g. `sandbox.backend`, for the exact field name.)

`tests/helpers/config.ts` chat ballast: add `thinkTags: "auto", maxFps: 60,`.

- [ ] **Step 4: Verify**

`npx vitest run tests/config.test.ts tests/configLevers.test.ts tests/helpersConfig.test.ts > /tmp/t1 2>&1; echo "exit: $?"` → 0. `npm run typecheck` → 0.

- [ ] **Step 5: Commit**

`feat(config): chat.thinkTags and chat.maxFps (spec 2026-09-06 §5)`

---

### Task 2: Transcript schema — `turn` id, bus-only record types, fixture builders

Spec §1.1. Additive `turn` on `ChatTurnStartRecord`; a separate `ChatBusRecord` union so the bus-only records are typed but **not** writable through `writeRecord` (whose `ChatWriteRecord` derives from `ChatRecord`, `chatSession.ts:116–117`).

**Files:**

- Create: `src/chat/liveBlocks.ts` (types only in this task; the reducer arrives in Task 8)
- Modify: `src/agent/transcriptSchema.ts` (`ChatTurnStartRecord` 107–113; export a `ChatBusRecord` union next to `ChatRecord` 183–192)
- Modify: `tests/helpers/transcriptFixtures.ts` (add `chatDelta`, `chatTool`, `chatPartial`, `msgUpdate` builders; `chatTurnStart` gains a default `turn`)
- Test: `tests/transcriptSchema.test.ts` (parse round-trip), `tests/transcriptFixtures.test.ts` if it exists, else the builders are exercised by later tasks

**Interfaces:**

```ts
// src/chat/liveBlocks.ts
export type LiveBlock =
  | { kind: "text"; contentIndex: number; text: string }
  | { kind: "thinking"; contentIndex: number; text: string; done: boolean; startedAt: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      output: string;
      result: string | null;
      isError: boolean;
      truncated: boolean;
      done: boolean;
    };

export interface ChatDeltaRecord {
  type: "junco_chat_delta";
  turn: string;
  seq: number;
  kind: "text" | "thinking";
  contentIndex: number;
  delta: string;
}
export interface ChatToolRecord {
  type: "junco_chat_tool";
  turn: string;
  seq: number;
  id: string;
  phase: "start" | "output" | "end";
  name?: string;
  args?: unknown;
  output?: string;
  result?: string;
  isError?: boolean;
  truncated?: boolean;
}
export interface ChatPartialRecord {
  type: "junco_chat_partial";
  turn: string;
  seq: number;
  blocks: LiveBlock[];
}
export type ChatBusRecord = ChatDeltaRecord | ChatToolRecord | ChatPartialRecord;
export const CHAT_TOOL_RESULT_CAP = 8_192;
export const CHAT_TOOL_OUTPUT_CAP = 32_768;
```

`transcriptSchema.ts`: `ChatTurnStartRecord` gains `turn?: string` (optional: pre-upgrade transcripts lack it; spec §1.1). Re-export `ChatBusRecord` from `./chat/liveBlocks.js` is NOT done (schema stays the persisted vocabulary); `parseTranscriptLine` already passes any `junco_*` through as `JuncoRecord` (218–233), so a bus record parses as `{kind:"junco", record}` and downstream code narrows on `record.type`.

- [ ] **Step 1: Write the failing test**

`tests/transcriptSchema.test.ts` (append):

```ts
describe("chat streaming records (spec 2026-09-06 §1.1)", () => {
  it("junco_chat_turn_start carries an optional turn id; bus-only records parse as junco records", () => {
    const start = parseTranscriptLine(chatTurnStart({ turn: "t1" }));
    expect(start.kind).toBe("junco");
    expect((start as { record: { turn?: string } }).record.turn).toBe("t1");
    const d = parseTranscriptLine(chatDelta({ turn: "t1", seq: 1, kind: "thinking", delta: "hm" }));
    expect(d).toMatchObject({
      kind: "junco",
      record: { type: "junco_chat_delta", kind: "thinking" },
    });
    const p = parseTranscriptLine(chatPartial({ turn: "t1", seq: 3, blocks: [] }));
    expect(p).toMatchObject({ kind: "junco", record: { type: "junco_chat_partial" } });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — the builders do not exist; `npm run typecheck` fails.

- [ ] **Step 3: Implement**

Builders in `tests/helpers/transcriptFixtures.ts` (next to `chatTurnStart` at 172):

```ts
export const chatDelta = (over: Partial<ChatDeltaRecord> = {}): string =>
  j({
    type: "junco_chat_delta",
    turn: "t1",
    seq: 1,
    kind: "text",
    contentIndex: 0,
    delta: "x",
    ...over,
  });
export const chatTool = (over: Partial<ChatToolRecord> = {}): string =>
  j({
    type: "junco_chat_tool",
    turn: "t1",
    seq: 1,
    id: "c1",
    phase: "start",
    name: "read",
    args: { path: "a" },
    ...over,
  });
export const chatPartial = (over: Partial<ChatPartialRecord> = {}): string =>
  j({ type: "junco_chat_partial", turn: "t1", seq: 0, blocks: [], ...over });
/** A raw SDK message_update carrying one text or thinking delta. */
export const msgUpdate = (
  kind: "text_delta" | "thinking_delta",
  delta: string,
  contentIndex = 0,
): string =>
  j({ type: "message_update", assistantMessageEvent: { type: kind, delta, contentIndex } });
```

`chatTurnStart`'s default object gains `turn: "t1"`.

- [ ] **Step 4: Verify** — `npx vitest run tests/transcriptSchema.test.ts tests/transcriptSummary.test.ts > /tmp/t2 2>&1; echo "exit: $?"` → 0 (an unknown `junco_*` is ignored by `summarizeTranscript`, lines 347–348 — confirm nothing else changed).

- [ ] **Step 5: Commit** — `feat(chat): typed bus-only streaming records and the turn id (spec 2026-09-06 §1.1)`

---

### Task 3: `thinkSplitter.ts`

Spec §2.1. A total, pure streaming state machine.

**Files:**

- Create: `src/chat/thinkSplitter.ts`
- Test: `tests/thinkSplitter.test.ts`

**Interfaces:**

```ts
export interface SplitPiece {
  kind: "text" | "thinking";
  delta: string;
}
export interface ThinkSplitter {
  push(delta: string): SplitPiece[];
  end(): SplitPiece[];
  /** True once an opening tag has been seen (drives `auto` in Task 5). */
  readonly sawTag: boolean;
}
export function makeThinkSplitter(opts?: { open?: string; close?: string }): ThinkSplitter;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { makeThinkSplitter, type SplitPiece } from "../src/chat/thinkSplitter.js";

/** Coalesce adjacent same-kind pieces so chunking is invisible to assertions. */
function join(pieces: SplitPiece[]): SplitPiece[] {
  const out: SplitPiece[] = [];
  for (const p of pieces) {
    if (p.delta === "") continue;
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) last.delta += p.delta;
    else out.push({ ...p });
  }
  return out;
}
function run(chunks: string[]): SplitPiece[] {
  const s = makeThinkSplitter();
  return join([...chunks.flatMap((c) => s.push(c)), ...s.end()]);
}
/** Every way to cut `s` into `n` chunks. */
function* cuts(s: string, n: number, from = 0): Generator<string[]> {
  if (n === 1) {
    yield [s.slice(from)];
    return;
  }
  for (let i = from + 1; i <= s.length - (n - 1); i++)
    for (const rest of cuts(s, n - 1, i)) yield [s.slice(from, i), ...rest];
}

describe("thinkSplitter (spec 2026-09-06 §2.1)", () => {
  it("splits a whole-string tag pair and trims the block's edges", () => {
    expect(run(["<think>\n plan \n</think>answer"])).toEqual([
      { kind: "thinking", delta: "plan" },
      { kind: "text", delta: "answer" },
    ]);
  });
  it("is chunk-invariant: any 3-way cut of a tagged string yields the same pieces", () => {
    const s = "pre<think>abc</think>post";
    const want = run([s]);
    for (const c of cuts(s, 3)) expect(run(c)).toEqual(want);
  });
  it("releases a false prefix as text", () => {
    expect(run(["<thin", "k you"])).toEqual([{ kind: "text", delta: "<think you" }]);
  });
  it("leaves an unclosed block as thinking at end()", () => {
    expect(run(["<think>cut off"])).toEqual([{ kind: "thinking", delta: "cut off" }]);
  });
  it("passes a bare close tag through as text", () => {
    expect(run(["a</think>b"])).toEqual([{ kind: "text", delta: "a</think>b" }]);
  });
  it("does not nest: a second open inside a block is thinking text", () => {
    expect(run(["<think>a<think>b</think>c"])).toEqual([
      { kind: "thinking", delta: "a<think>b" },
      { kind: "text", delta: "c" },
    ]);
  });
  it("reports sawTag", () => {
    const s = makeThinkSplitter();
    s.push("plain");
    expect(s.sawTag).toBe(false);
    s.push("<think>");
    expect(s.sawTag).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — module missing.

- [ ] **Step 3: Implement**

```ts
/**
 * Streaming `<think>…</think>` splitter (spec 2026-09-06 §2.1). Total over any
 * byte sequence, never throws, never drops bytes: at most `tag.length - 1`
 * trailing chars that could be a tag prefix are held back and released on the
 * next push or on end(). Tags are never emitted; whitespace is trimmed only at
 * the two edges of a thinking block. No nesting; a bare close tag is text.
 */
export interface SplitPiece {
  kind: "text" | "thinking";
  delta: string;
}
export interface ThinkSplitter {
  push(delta: string): SplitPiece[];
  end(): SplitPiece[];
  readonly sawTag: boolean;
}

export function makeThinkSplitter(opts: { open?: string; close?: string } = {}): ThinkSplitter {
  const open = opts.open ?? "<think>";
  const close = opts.close ?? "</think>";
  let inThink = false;
  let held = ""; // unemitted tail that may be a tag prefix
  let atBlockStart = false; // trim leading whitespace of a thinking block
  let sawTag = false;

  /** Longest proper prefix of `tag` that `s` ends with — the chars to hold. */
  const tailPrefixLen = (s: string, tag: string): number => {
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
      if (s.endsWith(tag.slice(0, n))) return n;
    }
    return 0;
  };

  const emit = (out: SplitPiece[], kind: SplitPiece["kind"], delta: string): void => {
    if (delta === "") return;
    if (kind === "thinking" && atBlockStart) {
      delta = delta.replace(/^\s+/, "");
      if (delta === "") return;
      atBlockStart = false;
    }
    out.push({ kind, delta });
  };

  const push = (delta: string): SplitPiece[] => {
    const out: SplitPiece[] = [];
    let buf = held + delta;
    held = "";
    for (;;) {
      const tag = inThink ? close : open;
      const i = buf.indexOf(tag);
      if (i === -1) {
        const keep = tailPrefixLen(buf, tag);
        const body = buf.slice(0, buf.length - keep);
        held = buf.slice(buf.length - keep);
        if (inThink) {
          // Hold trailing whitespace too: it is trimmed if the close tag follows.
          const m = /\s+$/.exec(body);
          const ws = m ? m[0] : "";
          emit(out, "thinking", body.slice(0, body.length - ws.length));
          held = ws + held;
        } else emit(out, "text", body);
        return out;
      }
      const before = buf.slice(0, i);
      if (inThink) {
        emit(out, "thinking", before.replace(/\s+$/, ""));
        inThink = false;
      } else {
        emit(out, "text", before);
        inThink = true;
        sawTag = true;
        atBlockStart = true;
      }
      buf = buf.slice(i + tag.length);
    }
  };

  const end = (): SplitPiece[] => {
    const out: SplitPiece[] = [];
    if (held !== "") {
      if (inThink) emit(out, "thinking", held.replace(/\s+$/, ""));
      else emit(out, "text", held);
      held = "";
    }
    return out;
  };

  return {
    push,
    end,
    get sawTag() {
      return sawTag;
    },
  };
}
```

Note on the "bare close tag" rule: with `inThink === false` the loop searches for `open` only, so `</think>` in text is never matched — it flows through as text by construction.

- [ ] **Step 4: Verify** — `npx vitest run tests/thinkSplitter.test.ts > /tmp/t3 2>&1; echo "exit: $?"` → 0. If the chunk-invariance test finds a cut that differs, the bug is in `held` handling around whitespace; fix the splitter, not the test.

- [ ] **Step 5: Commit** — `feat(chat): streaming <think> tag splitter (spec 2026-09-06 §2.1)`

---

### Task 4: `liveTurn.ts` — the daemon accumulator

Spec §1.2, §1.3, §2.3. Pure: SDK events in, bus records out, snapshot on demand. No I/O, no timers; `now` injected.

**Files:**

- Create: `src/chat/liveTurn.ts`
- Test: `tests/liveTurn.test.ts` (fixtures from `tests/helpers/transcriptFixtures.ts` — parse `JSON.parse(msgUpdate(...))` etc. into event objects; add SDK builders for `tool_execution_update` / `bash_execution_update` if absent)

**Interfaces:**

```ts
export interface LiveTurnOpts {
  turn: string;
  now: () => number; // ms epoch
  thinkTags: "auto" | "on" | "off";
  resultCap?: number; // default CHAT_TOOL_RESULT_CAP
  outputCap?: number; // default CHAT_TOOL_OUTPUT_CAP
}
export interface LiveTurn {
  /** Feed one SDK event; returns the bus records to publish, in order. */
  observe(event: unknown): ChatBusRecord[];
  /** Records to flush at turn end (splitter tail). */
  finish(): ChatBusRecord[];
  /** The snapshot record for a late subscriber (spec §1.1). */
  partial(): ChatPartialRecord;
  readonly seq: number;
}
export function makeLiveTurn(opts: LiveTurnOpts): LiveTurn;
```

Behaviour (table in spec §1.2):

- `message_update`/`text_delta` → through the splitter when `thinkTags === "on"`, or `"auto"` and no native `thinking_delta` has been seen this turn; each piece → `junco_chat_delta` with the SDK's `contentIndex` for text and, for tag-derived thinking, `contentIndex` of the text block it was cut from (they interleave correctly because a tag-derived thinking block precedes its answer in the same content block; the client orders by `contentIndex` then arrival).
- `message_update`/`thinking_delta` → native thinking; sets `sawNative = true` (so `auto` stops splitting).
- `thinking_end`, or a text delta arriving while the current thinking block is open → mark it `done`; emit nothing extra (the client marks `done` on the next text delta too — spec §3.2).
- `tool_execution_start` → `junco_chat_tool` `start` with `name`, `args`.
- `tool_execution_update` (`partialResult`), `bash_execution_update` (`delta`) → `output` (delta only); the accumulator keeps a rolling `output` capped at `outputCap` (drop from the head, set `truncated`).
- `tool_execution_end` → `end` with `result` capped at `resultCap` (`truncated: true` when cut), `isError`.
- Anything else → `[]`.
- `partial()` → `{ type: "junco_chat_partial", turn, seq, blocks }` where `blocks` are the accumulated `LiveBlock[]` (text joined from the `string[]` chunks) in first-seen order.
- `seq` increments per emitted record; the partial carries the current `seq`.

- [ ] **Step 1: Write the failing test** (`tests/liveTurn.test.ts`) — cover: text-only turn (one delta per chunk, `contentIndex` preserved), tag turn under `on` (thinking then text pieces; `partial()` shows a thinking block with `done: true` once text starts), native thinking under `auto` (no split even if the text contains `<think>`), tool lifecycle (start/output/end records; output cap drops head and flags `truncated`; result cap), `finish()` flushes the splitter's held tail, `seq` monotonic, unknown events ignored.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** `src/chat/liveTurn.ts` per the interface. Keep blocks in a `Map<string, { block: LiveBlock; chunks: string[] }>` keyed `${kind}:${contentIndex}` / `tool:${id}`, plus an insertion-order array. `partial()` joins `chunks` into `text`/`output` and returns fresh objects (never the internal ones).

- [ ] **Step 4: Verify** — `npx vitest run tests/liveTurn.test.ts > /tmp/t4 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit** — `feat(chat): LiveTurn accumulator emits slim bus-only delta/tool records (spec 2026-09-06 §1.2)`

---

### Task 5: `chatSession.ts` + `chatManager.ts` — emit the new records, mint the turn id, expose the snapshot

Spec §1.1, §1.2, §2.1 (`auto`), §2.3. The one daemon behaviour change on the bus.

**Files:**

- Modify: `src/chat/chatSession.ts` — fields (add `private liveTurn: LiveTurn | null = null;` next to `turnDeadline`, line 204); `admit` (turn_start write 633–640 gains `turn`; construct the `LiveTurn` before `runChatTurn` 641–661); `emitSdk` 291–296 (replace); `settle` 666–699 (`finish()` + reset in `finally`); new `partialLine(): string | null`
- Modify: `src/chat/chatManager.ts` `subscribe` 458–473 — return `partial` (a bus-only line or null) alongside `replay`
- Modify: `tests/chatSession.test.ts` 226–252 (the pinned bus contract), `tests/chatManager.test.ts` (subscribe shape), `tests/helpers/fakeSession.ts` (`chatScriptText` may gain a `thinking` variant: `chatScriptThinking(thinking, text)` emitting a `thinking_delta` then a `text_delta`)

**Interfaces:**

- `ChatSession.partialLine(): string | null` — `JSON.stringify(liveTurn.partial()) + "\n"` while a turn is in flight, else null.
- `ChatManager.subscribe(...)` → `ChatResult<{ replay; partial: string | null; unsubscribe }>`.
- `ChatSessionDeps.turnId?: () => string` (default: `crypto.randomUUID()`), so tests get deterministic ids.

- [ ] **Step 1: Write the failing tests**

`tests/chatSession.test.ts` — change lines 246–248 of the pinned test to:

```ts
const busTypes = bus.map((b) => b.type);
expect(busTypes).not.toContain("message_update");
const delta = bus.find((b) => b.type === "junco_chat_delta");
expect(delta?.offset).toBeNull();
expect(bus.find((b) => b.type === "turn_end")!.offset).toBeGreaterThan(0);
```

and add:

```ts
it("turn_start carries the minted turn id; deltas and the partial snapshot cite it (spec 2026-09-06 §1)", async () => {
  const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
  const { session } = makeSession(root, [chatScriptText("hi", 0.1)], { turnId: () => "turn-A" });
  const lines: string[] = [];
  session.subscribe({ onLine: (l) => lines.push(l), onEnd: () => {} });
  await session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
  const start = lines.map((l) => JSON.parse(l)).find((r) => r.type === "junco_chat_turn_start");
  expect(start.turn).toBe("turn-A");
  const d = lines.map((l) => JSON.parse(l)).find((r) => r.type === "junco_chat_delta");
  expect(d).toMatchObject({ turn: "turn-A", kind: "text", delta: "hi" });
  expect(session.partialLine()).toBeNull(); // idle
});

it("<think> tags are split into thinking deltas under thinkTags=auto; native thinking disables the split", async () => {
  // first script: text "<think>plan</think>ok" → thinking "plan", text "ok"
  // second script: thinking_delta "n" then text_delta "<think>x" → text keeps the tag
});
```

`tests/chatManager.test.ts` — the `subscribe` test asserts `value.partial === null` when idle, and (with a lagging script) a `junco_chat_partial` line whose `blocks[0].text` is the streamed prefix when a subscriber attaches mid-turn (use `laggingChatSession()` at 85).

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

`emitSdk` becomes:

```ts
  /** SDK event: file unless message_update (spec 2026-09-01 §1.3); the bus gets
   *  the slim re-tagged records from LiveTurn instead of the raw delta
   *  (spec 2026-09-06 §1.2). Everything that is persisted still fans out as-is. */
  private emitSdk(event: unknown): void {
    const type = (event as { type?: unknown } | null)?.type;
    if (this.liveTurn !== null) {
      for (const rec of this.liveTurn.observe(event)) this.publish(JSON.stringify(rec) + "\n", null);
    }
    if (type === "message_update") return;
    const line = JSON.stringify(event) + "\n";
    this.publish(line, this.persist(line));
  }
```

In `admit`, before the `turn_start` write: `const turn = this.turnId();` then `writeRecord({ type: "junco_chat_turn_start", turn, ... })`, and before `runChatTurn`: `this.liveTurn = makeLiveTurn({ turn, now: this.now, thinkTags: this.cfg.chat.thinkTags });`. In `settle`'s `finally` (694–698): `const tail = this.liveTurn?.finish() ?? []; for (const rec of tail) this.publish(JSON.stringify(rec) + "\n", null); this.liveTurn = null;` — **before** the `turn_end`/`aborted` record is written, so the client sees the last thinking chunk before the turn closes (move the `finally` reset ahead of the `writeRecord` calls, or call `finish()` at the top of the ok/aborted branches).

`partialLine()`:

```ts
  partialLine(): string | null {
    return this.liveTurn === null ? null : JSON.stringify(this.liveTurn.partial()) + "\n";
  }
```

`ChatManager.subscribe`: between `readLines` and `subscribe`, `const partial = got.value.partialLine();` and return `{ replay, partial, unsubscribe }`. (Same synchronous section — no line can land between.)

- [ ] **Step 4: Verify** — `npx vitest run tests/chatSession.test.ts tests/chatManager.test.ts tests/chatTurn.test.ts > /tmp/t5 2>&1; echo "exit: $?"` → 0. `tests/chatTurn.test.ts:19–25` is unaffected (its `emit` still sees raw SDK events — the re-tagging is in `emitSdk`).

- [ ] **Step 5: Commit** — `feat(chat): daemon publishes junco_chat_delta/tool and keeps a partial snapshot (spec 2026-09-06 §1)`

---

### Task 6: `chatRoutes.ts` — `setNoDelay`, the partial frame first

Spec §1.1 (snapshot ordering), §1.4.

**Files:**

- Modify: `src/chat/chatRoutes.ts` `sse` (151–247): after `res.flushHeaders()` (236) add `res.socket?.setNoDelay(true);`; after the replay loop (237) and **before** `for (const frame of pending)` (238): `if (r.value.partial !== null) res.write(\`data: ${r.value.partial.replace(/\n$/, "")}\n\n\`);`
- Modify: `tests/chatRoutes.test.ts` — `fakeManager`'s `subscribe` stub (43–56) returns `partial: over.partial ?? null`; the pinned test at 363–380 pushes `junco_chat_delta` instead of `message_update` (`events[1]` becomes `'data: {"type":"junco_chat_delta"}'`); new test: with `partial` set, the frame after the replay and before any live frame is the id-less partial.

- [ ] **Step 1: Write the failing test** — as above; also assert `setNoDelay` was called through a spy on `res.socket` (the `serve` helper uses a real `node:http` server, so read `resp` through a raw socket and assert `Nagle` is off is not observable — instead inject `deps.setNoDelay?: (res) => void` defaulting to the real call, and assert the injected spy fired once per stream).

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — per Files above; `ChatRoutesDeps` gains `setNoDelay?: (res: ServerResponse) => void` (default `(res) => res.socket?.setNoDelay(true)`).

- [ ] **Step 4: Verify** — `npx vitest run tests/chatRoutes.test.ts tests/healthServer.test.ts > /tmp/t6 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit** — `feat(chat): SSE sends the in-flight partial first and disables Nagle (spec 2026-09-06 §1.4)`

---

### Task 7: `transcriptSummary.ts` — incremental `extendSummary`

Spec §3.3. Expose the existing per-line state machine step-wise; whole-ring `summarizeTranscript` stays for replay and `junco transcript`.

**Files:**

- Modify: `src/transcriptSummary.ts` — lift `st` (170–182) and the helpers `closeRun`/`openRun`/`ensureRun`/`noteRun` (184–223) into a `SummaryBuilder` class holding `out` + `st`; `summarizeTranscript(lines)` becomes `const b = new SummaryBuilder(); for (const l of lines) b.push(l); return b.result();`. Export `extendSummary(prev: TranscriptSummary | null, state: SummaryState | null, line: string): { summary: TranscriptSummary; state: SummaryState }` where `SummaryState` is the builder (opaque to callers).
- The terminal step (440–443) must be **re-derived**, not mutated: `result()` returns a copy of `out` with `runs` cloned shallowly and, if `st.open !== null`, the open run cloned with `st.provisional` appended to its `turns` and `live: true`. The internal `st.open.turns` is never pushed to by `result()`.
- Test: `tests/transcriptSummaryIncremental.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { summarizeTranscript, extendSummary } from "../src/transcriptSummary.js";
import {
  v2RunLines,
  metaLine,
  chatPrompt,
  chatTurnStart,
  turnEndFull,
  chatTurnEnd,
  toolStartId,
  toolEndId,
  chatDraft,
  chatCommand,
  chatTurnAborted,
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
    chatCommand({ status: "done" }),
  ],
  [
    metaLine({ ticketId: "a" }),
    chatPrompt(),
    chatTurnStart(),
    toolStartId("c1", "bash", { command: "ls" }),
  ], // live, provisional
];

describe("extendSummary (spec 2026-09-06 §3.3)", () => {
  it("equals summarizeTranscript at every prefix of every fixture", () => {
    for (const lines of CASES) {
      let summary = null,
        state = null;
      for (let i = 0; i < lines.length; i++) {
        ({ summary, state } = extendSummary(summary, state, lines[i]!));
        expect(summary).toEqual(summarizeTranscript(lines.slice(0, i + 1)));
      }
    }
  });
  it("does not mutate a previously returned summary", () => {
    const lines = CASES[4]!;
    let summary = null,
      state = null;
    ({ summary, state } = extendSummary(summary, state, lines[0]!));
    const frozen = structuredClone(summary);
    for (const l of lines.slice(1)) ({ summary, state } = extendSummary(summary, state, l));
    expect(structuredClone(summarizeTranscript(lines.slice(0, 1)))).toEqual(frozen);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — the builder refactor. Watch the non-local `junco_chat_command` replacement (330–338) — it scans `out.runs`; in the builder it scans the builder's own `runs` array, which is fine because `result()` clones.

- [ ] **Step 4: Verify** — `npx vitest run tests/transcriptSummary*.test.ts tests/transcriptCmd.test.ts tests/replay*.test.ts > /tmp/t7 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit** — `refactor(transcript): incremental extendSummary equal to the whole-ring summary (spec 2026-09-06 §3.3)`

---

### Task 8: `liveBlocks.ts` — the client reducer `applyLiveRecord`

Spec §3.2. Pure; shared file with Task 2's types.

**Files:**

- Modify: `src/chat/liveBlocks.ts` (add `LiveTurnState` and `applyLiveRecord`)
- Test: `tests/chatLiveModel.test.ts`

**Interfaces:**

```ts
export interface LiveTurnState {
  turn: string;
  seq: number;
  blocks: LiveBlock[];
  expanded: ReadonlySet<string>;
  dropped: number;
}
/** Pure. Returns the same object when nothing changed (referential no-op). */
export function applyLiveRecord(
  state: LiveTurnState | null,
  record: unknown, // a parsed junco record; unknown shapes are dropped and counted
): LiveTurnState | null;
export function startLiveTurn(turn: string): LiveTurnState;
```

Rules (spec §3.2): `junco_chat_turn_start` is handled by the caller (`startLiveTurn(rec.turn ?? rec.ts)`); `junco_chat_partial` replaces blocks/seq when `turn` matches or state is null (and starts a new state when the turn is newer — i.e. differs and state exists: replace too; an older turn is undetectable without ordering, so "differs" = replace); `junco_chat_delta` drops on turn mismatch or `seq <= state.seq`, else appends to the `(kind, contentIndex)` block (create in `contentIndex` order, thinking before text at equal index), a text delta marks any open thinking block `done`; `junco_chat_tool` per phase; the caller nulls the state on turn end/abort. Malformed → `dropped + 1`, state otherwise unchanged (still a new object so the UI can show the count).

- [ ] **Step 1: Write the failing test** — ordering by contentIndex; thinking-before-text at equal index; seq dedupe after a partial; turn mismatch dropped; tool start/output/end; malformed counted; referential no-op on a dropped delta.

- [ ] **Step 2–5** as usual. Commit: `feat(chat): pure client reducer for live blocks (spec 2026-09-06 §3.2)`

---

### Task 9: `useChat` — block state, turn scoping, per-frame flush

Spec §3.1, §3.2, §3.4, §3.5. The state shape change; every pinned test that names `liveText` or `showThinking` changes here.

**Files:**

- Modify: `src/tui/hooks/useChat.ts` — `ChatState` (22–58): remove `liveText`, `showThinking`; add `live: LiveTurnState | null`, `thinking: { pinned: boolean }`, `frame: number`. `freshState` (85–107). Replace `pendingDelta`/`flushTimer` with `pendingLive: MutableRefObject<LiveTurnState | null>` + `flushScheduled: MutableRefObject<boolean>`. `flushDelta` → `flushLive` (`setImmediate`, publishes `pendingLive` and bumps `frame`). `onRecord` (190–306): the delta arm becomes "any `junco_chat_delta`/`_tool`/`_partial` → `pendingLive.current = applyLiveRecord(pendingLive.current, rec); schedule flush; return`"; the ring path uses `extendSummary` (Task 7) instead of `summarizeTranscript(ring.current)` except after an overflow splice (recompute once); `junco_chat_turn_start` → `pendingLive.current = startLiveTurn(rec.turn ?? rec.ts)` and `live` cleared in the updater; turn end/aborted → `pendingLive.current = null`, `live: null`. `toggleThinking` → toggles `thinking.pinned`. Session reset (356) clears `live`, `pendingLive`, and the summary state ref.
- Modify: `tests/useChat.test.tsx` — `Probe` renders `api.chat.live?.blocks.map(b => b.kind === "tool" ? `[${b.name}]` : b.text).join("|") ?? ""`; the test at 134–169 pushes `chatDelta(...)` records (`turn: "t1"`, seq 1, 2) and expects `live:streaming:because`; on `chatTurnEnd()` expects `api.chat!.live` null. Add: a `chatPartial` replaces; a delta with `seq <= applied` is dropped; a delta for another turn is dropped; thinking delta lands in a thinking block; `toggleThinking` flips `thinking.pinned`; `flushMs` option is removed from the hook (per-frame now) — if a test needs deterministic flushing, `await until(...)` already covers it.
- Modify: `tests/tuiChatView.test.tsx` `base()` (22–44): `liveText`/`showThinking` → `live: null`, `thinking: { pinned: false }`, `frame: 0`. (The view itself changes in Task 11; here only the literal compiles.)
- `tests/useChatInput.tsx` — unchanged (`toggleThinking` keeps its name).

- [ ] **Step 1: Write the failing tests** (as above).
- [ ] **Step 2: Run** — `npx vitest run tests/useChat.test.tsx tests/tuiChatView.test.tsx tests/useChatInput.tsx > /tmp/t9 2>&1; echo "exit: $?"` → 1; typecheck fails on `liveText`.
- [ ] **Step 3: Implement** per Files. `flushLive`:

```ts
const flushLive = useCallback((): void => {
  flushScheduled.current = false;
  if (!aliveRef.current) return;
  const live = pendingLive.current;
  setChat((s) => (s === null ? s : { ...s, live, frame: s.frame + 1 }));
}, [aliveRef]);
const scheduleFlush = useCallback((): void => {
  if (flushScheduled.current) return;
  flushScheduled.current = true;
  setImmediate(flushLive);
}, [flushLive]);
```

`ChatView` reads `live` for the live rows in Task 11; until then it renders nothing for the live turn (the intermediate state is acceptable inside one PR but **not** across a commit that leaves `main` unable to show streaming — so Tasks 9–11 land in one PR; each commit still keeps the suite green).

- [ ] **Step 4: Verify** → 0. `npm run lint` clean (hook deps).
- [ ] **Step 5: Commit** — `feat(tui): chat live-block state with turn scoping and a per-frame flush (spec 2026-09-06 §3)`

---

### Task 10: `dashboardCmd.ts` — `maxFps` from config

Spec §3.4, D8.

**Files:**

- Modify: `src/dashboardCmd.ts` — `INK_RENDER_OPTIONS` (37–45) gains `maxFps: 60`; `renderFn` (139–140) becomes `ink.render(el, { ...INK_RENDER_OPTIONS, maxFps: cfg === null ? INK_RENDER_OPTIONS.maxFps : cfg.chat.maxFps })` (the FTUE path has `cfg === null`).
- Test: `tests/dashboardCmd.test.ts` (248–256 pins the options object) — add: with `cfg.chat.maxFps = 30` the injected `renderFn` receives `maxFps: 30`; with `cfg === null` it receives 60.

- [ ] Steps 1–5. Commit: `feat(tui): Ink maxFps 60 by default, chat.maxFps overrides (D8)`

---

### Task 11: View split — `FinishedTurns`, `LiveTurn`, `TranscriptBody` accessor

Spec §4.1. After this task a flush re-renders only the live rows.

**Files:**

- Create: `src/tui/components/FinishedTurns.tsx` (`useMemo` over `[summary, pinned, expanded, width]` → `TranscriptRow[]` via `renderTranscriptRows`; exports a hook `useFinishedRows(...)` rather than a component, since rows are consumed by `TranscriptBody`)
- Create: `src/tui/components/LiveTurn.tsx` (`useLiveRows(live, frame, width, pinned)` → `TranscriptRow[]`; this task renders text blocks as today's `junco: …` rows and thinking/tool blocks as plain dim rows — Tasks 12 and 15 replace those)
- Modify: `src/tui/components/TranscriptBody.tsx` — props `rows: TranscriptRow[]` → `rows: RowSource` where `interface RowSource { length: number; at(i: number): TranscriptRow; anchorRow(id: string): number }`; `bodyWindow` uses `rows.length` and `rows.anchorRow(anchorId)` (77–93); the render loop uses `rows.at(i)`. Export `concatRows(a: TranscriptRow[], b: TranscriptRow[]): RowSource` (no copy; `anchorRow` scans `a` then `b`; memoize the anchor index map by `a`'s identity).
- Modify: `src/tui/components/ChatView.tsx` — the `rows` memo (130–149) becomes `const finished = useFinishedRows(...)`, `const liveRows = useLiveRows(...)`, `const rows = useMemo(() => concatRows(finished, liveRows), [finished, liveRows])`; `anchors` unchanged. Every other `TranscriptBody` caller (`grep -rn "<TranscriptBody" src/`) passes `concatRows(rows, [])` or an adapter — update them.
- Test: `tests/tuiChatView.test.tsx` — the 133–199 test sets `live: { turn: "t1", seq: 1, blocks: [{ kind: "text", contentIndex: 0, text: "thinking about it" }], expanded: new Set(), dropped: 0 }` and keeps `expect(f).toContain("junco: thinking about it")`; new test: with `JUNCO_RENDER_COUNT=1`, pushing a second live frame (`frame: 2`, longer text) re-renders `TranscriptBody` but the `renderTranscriptRows` call count (spy via a `deps.renderRows` seam or `bumpRender("FinishedTurns")`) stays at 1. `tests/tuiTranscript*.test.tsx` for the other `TranscriptBody` callers.

- [ ] Steps 1–5. Commit: `refactor(tui): split chat rows into memoized finished turns and a live turn (spec 2026-09-06 §4.1)`

---

### Task 12: Thinking block

Spec §4.3, D4.

**Files:**

- Modify: `src/transcriptRender.ts` — `RowTone` gains `"thinking"`; `RenderOpts.showThinking` → `pinned: boolean`; the finished-turn thinking rows (248–249) become: header row `▸ thinking · <dur>` (or `▾` when pinned) with `anchor: \`think:${runIdx}:${turnIdx}\``, and when pinned the body in tone `thinking`, indented two. Duration: `turn.usage`/`durationMs`is not per-block; use the turn's`durationMs`when it is the only thinking block else omit the number. For a turn whose`thinking === null`but whose`text`contains`<think>`, apply `splitThinkingText(text)`(a non-streaming helper in`thinkSplitter.ts`: `makeThinkSplitter().push(text)`+`end()` joined) at render time — spec §2.1 last paragraph.
- Modify: `src/tui/components/TranscriptBody.tsx` `toneProps` (18–39): `thinking` → `{ dimColor: true, italic: true }`.
- Modify: `src/tui/components/LiveTurn.tsx` — thinking blocks: not done → header `· thinking · <elapsed>s` (elapsed from `startedAt` via `useClock(1000)`; the header row is the only row that changes per second, and it changes with the frame anyway) + body rows in tone `thinking`; done and not pinned → single collapsed header `▸ thinking · <dur>`; done and pinned → `▾` header + body.
- Modify: `src/tui/viewActions.ts` — the chat `thinking` verb label → `"pin thinking"` (still derives `t`; `tests/tuiViewActions.test.ts:150–194` keymap stays `t: "thinking"` since the id is unchanged; the chip label assertion, if any, updates).
- Test: `tests/tuiChatView.test.tsx` — four states; `tests/transcriptRender.test.ts` — finished-turn header/collapse and the render-time tag split.

- [ ] Steps 1–5. Commit: `feat(tui): live thinking block that streams then folds; t pins it (spec 2026-09-06 §4.3)`

---

### Task 13: Markdown — pure block parser and renderer

Spec §4.2. No dependency; ANSI never enters `wrapText`.

**Files:**

- Create: `src/tui/markdown/blocks.ts` — `parseBlocks(text: string): { closed: MdBlock[]; open: MdBlock | null }` where `MdBlock` is `paragraph | heading(level) | list(ordered, items[] with one nested level) | quote | fence(lang, lines[], closed) | rule`. "Closed" = everything before the last blank line, or a fence that has closed; the last block is `open` unless the text ends with a blank line.
- Create: `src/tui/markdown/render.ts` — `renderMarkdown(text, opts: { width; highlight?: (code: string, lang: string | null) => string[] | null; cache?: MdCache }): TranscriptRow[]` with inline `code` → tone `bold`-less but wrapped in backticks stripped and rendered via a `segments` field? — keep v1 simple: inline emphasis markers are **stripped** and the text rendered plain; inline code keeps its backticks. Headings → tone `bold` with `#` stripped; lists → `• ` / `1. ` prefixes with hanging indent; quotes → `│ ` prefix tone `dim`; rules → `───`; fences → the highlighter's lines verbatim (ANSI allowed; `TranscriptBody` truncates with `wrap="truncate-end"`, never wraps them), unhighlighted fallback is the raw lines. `MdCache` maps closed-block index → rows and is reused when the closed prefix is unchanged (compare block count and the last closed block's source hash).
- Test: `tests/markdown.test.ts` — each block type; the open-tail invariant (render `s.slice(0,i)` then `s` for every `i` → the rows for the closed prefix are identical objects from the cache); an unclosed fence renders as code from its opening line; ANSI from a fake `highlight` passes through untouched and is never wrapped.

- [ ] Steps 1–5. Commit: `feat(tui): block-level markdown renderer with a cached closed prefix (spec 2026-09-06 §4.2)`

---

### Task 14: Markdown wired in; Pi's highlighter through the session seam

Spec §4.2, hard rule (no top-level SDK import).

**Files:**

- Modify: `src/agent/session.ts` — add, next to `listCatalogProviders` (774–788):

```ts
/** Pi's syntax highlighter (pure: code → ANSI lines) through the one runtime-import seam. */
export async function loadHighlighter(): Promise<
  (code: string, lang: string | null) => string[] | null
> {
  const { highlightCode } = await import("@earendil-works/pi-coding-agent");
  return (code, lang) => {
    try {
      return lang === null ? null : highlightCode(code, lang);
    } catch {
      return null;
    }
  };
}
```

(Verify against `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:29` that `highlightCode` is `(code: string, lang: string) => string[]`; if it needs `initTheme()` first, call it once with the watcher disabled and note the side effect in the docstring.)

- Modify: `src/dashboardCmd.ts` — `const highlight = await loadHighlighter().catch(() => null);` alongside the `import("ink")` (134–135); pass through `buildAppProps` as `highlight`; App threads it to `ChatView` (props) → `useFinishedRows`/`useLiveRows` → `renderMarkdown`. Tests use a fake (`(code) => code.split("\n").map((l) => \`\x1b[1m${l}\x1b[0m\`)`).
- Modify: `src/transcriptRender.ts` — the chat answer rows (250–263) call `renderMarkdown(turn.text, …)` for `flow: "chat"` runs only (ticket transcripts stay plain — spec Non-goals); `LiveTurn.tsx` text blocks likewise, with the per-block `MdCache` kept in a `useRef` keyed by `contentIndex`.
- Test: `tests/tuiChatView.test.tsx` — a finished turn with a heading and a fence renders `# Title` as a bold row and the fence lines through the fake highlighter (assert the ANSI-stripped frame contains the code, and `bumpRender` shows no `FinishedTurns` re-run across a live frame); `tests/sdkImportSurface.test.ts` — add `highlightCode` to the verified export list.

- [ ] Steps 1–5. Commit: `feat(tui): markdown answers with Pi-highlighted code fences (spec 2026-09-06 §4.2)`

---

### Task 15: Tool cards, `x` verb, footer

Spec §4.4, §4.5, D6.

**Files:**

- Create: `src/tui/components/ToolCard.tsx` — `toolCardRows(block: LiveBlock & { kind: "tool" }, opts: { width; expanded: boolean; spinnerFrame: number }): TranscriptRow[]`: header `▸ ${fmtToolCall(name, args, w)}  ${spinner|✓|✗}` with `anchor: \`tool:${id}\``; running body = last 6 lines of `output`, tone `dim`; done + collapsed = header + one summary row (`fmtToolResult`-style: `→ N lines`/`→ ✗ first line`); done + expanded = the capped result lines (respecting `TOOL_BODY_MAX_LINES`), errors expanded by default with the header in tone `error`. Reuse `fmtToolCall`/`fmtToolResult`from`transcriptRender.ts:115–146`.
- Modify: `src/tui/components/LiveTurn.tsx` — tool blocks → `toolCardRows`; spinner frame from `useAnimation({ interval: 100 })` (the shared Ink timer, `Spinner.tsx`).
- Modify: `src/transcriptRender.ts` — finished-turn tool rows (264–281) adopt the same card shape (header + summary / expanded body) so live and finished look alike; `expanded` keys stay the tool-call id.
- Modify: `src/tui/viewActions.ts` — chat verbs (216–229) gain `{ id: "expandTool", label: "expand tool" }` after `follow` (derives `x`: e→edit, x is the first free letter of "expand"; verify with the derivation test and adjust the label if `x` is taken); `src/tui/hooks/useChatInput.ts` `chatHandlers` (138–160) gains `expandTool: () => toggleExpanded(anchorUnderCursor)` where the cursor's anchor id is read from `anchorIds(summary)`/the live anchors; `toggleExpanded` already exists (`useChat.ts:542`) and now also toggles `live.expanded` when the id is a live tool.
- Test: `tests/tuiViewActions.test.ts:150–194` keymap gains `x: "expandTool"`; `tests/useChatInput.tsx` — `x` calls `toggleExpanded` with the anchor under the cursor; `tests/tuiChatView.test.tsx` — running card with spinner + tail, collapsed done card, expanded card, error card.

- [ ] Steps 1–5. Commit: `feat(tui): live tool cards with streamed output; x expands (spec 2026-09-06 §4.4)`

---

### Task 16: Doctor hint `chat thinking`

Spec §2.2. A new `info` verdict that never affects the exit code.

**Files:**

- Modify: `src/doctor.ts` — `Verdict` (112) gains `"info"`; `const info = (label, detail) => ({ v: "info", ... })`; glyph ternary (1115) maps `info` → `ℹ`; tallies (1120–1122) ignore it; module doc line 4 lists `ℹ hint`. New check after `needsConfig("chat", …)` (885–899):

```ts
  needsConfig("chat-thinking", async (ctx, cfg) => {
    if (!cfg.chat.enabled || cfg.chat.thinkTags === "off") return [];
    const m = await ctx.resolveInfoFn(cfg);
    if (m.api !== "openai-completions") return []; // native thinking on hosted providers
    const flag = serverThinkingFlag(m.baseUrl); // llama.cpp / LM Studio / generic wording
    return [info("chat thinking", `<think> tags are split by junco (chat.thinkTags=${cfg.chat.thinkTags}); ${flag}`)];
  }),
```

with `serverThinkingFlag(baseUrl)` a pure helper: port 8080 or a `llama` banner → `"for a cleaner stream start llama.cpp with --reasoning-format deepseek"`; port 1234 → `"in LM Studio enable 'Reasoning → separate field' for a cleaner stream"`; else `"move reasoning into reasoning_content on the server for a cleaner stream"`. (`ResolvedModelInfo` has `baseUrl` and `api` — confirm field names at `src/agent/session.ts:732–760`.)

- Test: `tests/doctor.test.ts` / `tests/doctorChecks.test.ts` — three server cases, `off` → no finding, hosted api → no finding, `info` never changes the exit code.
- Docs: `docs/operations.md` doctor section (Task 18).

- [ ] Steps 1–5. Commit: `feat(doctor): chat thinking hint names the server flag for reasoning_content (spec 2026-09-06 §2.2)`

---

### Task 17: E2E — a scripted turn with `<think>` and a tool call

Spec §7 last bullet.

**Files:**

- Modify: `tests/e2e/chatSubmit.e2e.ts` (or a new `tests/e2e/chatStream.e2e.ts` registered the same way) — the model stub scripts one turn whose text is `"<think>consider</think>\n# Done\n\n```sh\nls\n```"` preceded by a `read` tool call; the scenario opens `/chat/events?key=…`, POSTs `/chat/prompt`, and asserts, in order: `junco_chat_tool start`, `junco_chat_tool end`, a `junco_chat_delta` with `kind: "thinking"` and `delta` containing `consider`, `junco_chat_delta` `text`, then the persisted `turn_end` with an `id`, and that no frame of type `message_update` appears. Also: subscribe a second client mid-turn (the stub delays between chunks) and assert its first frame is `junco_chat_partial`.
- The stub is fail-fast (`exhausted`), so the script must include exactly the turns the flow asks for — read the harness's `defaultGhCases` note in CLAUDE.md before adding cases.

- [ ] Steps 1–5. Commit: `test(e2e): chat streams thinking, tool, and text records; a late subscriber gets the partial`

---

### Task 18: Perf test, measurement, docs, changelog, ARCHITECTURE

Spec §8, §9.

**Files:**

- Create: `tests/tuiChatPerf.test.tsx` — renders `ChatView` with a 200-turn summary, drives 300 `chatDelta` records/s for 2 s through a fake client (a real `setInterval`), and asserts: `bumpRender("FinishedTurns")` count is 0 after the first paint; event-loop lag p95 (sample with a 10 ms `setInterval` drift measure) ≤ 40 ms in CI (loose; the spec's 10 ms target is measured manually, §9). Skip under `JUNCO_E2E_SKIP_PERF`.
- Measurement (manual, recorded in the spec §9 table via a follow-up commit): run the same stream against a real `junco dashboard` on the Pi 5 and the Mac with `JUNCO_RENDER_COUNT=1`, before (main) and after; record character-visible latency (timestamp the delta at the fake daemon, timestamp the frame containing it via a marker string), lag, renders/s, daemon CPU per 1k deltas (`process.cpuUsage()` around the emit loop in a script), and bytes per 1k characters (sum of SSE frame lengths). If the Pi 5 misses the 60 fps budget, set `chat.maxFps` default to 30 (Task 1's schema) and amend the spec.
- Docs: `docs/dashboard.md` § Chat (thinking block, `t` pin, `x` cards, reconnect); `docs/configuration.md` § Chat (`thinkTags`, `maxFps`); `docs/operations.md` (the doctor hint + server flags; `/chat/events` gets the partial-first note); `ARCHITECTURE.md` "The chat path" prose (three bus-only records, snapshot-first attach, `setNoDelay`) and module-map rows for `chat/liveBlocks.ts`, `chat/liveTurn.ts`, `chat/thinkSplitter.ts`, `tui/markdown/`, plus the `chat/` and `tui/` directory rows' summaries; `CHANGELOG.md` Unreleased: `### Added` (streaming thinking block, live tool cards, markdown answers, `chat.thinkTags`, `chat.maxFps`, doctor hint), `### Changed` (the SSE stream carries `junco_chat_delta`/`_tool`/`_partial` instead of raw `message_update`; a pre-upgrade dashboard degrades to turn-end text; Ink at 60 fps).
- Run the full gate; open the PR.

- [ ] Steps 1–5. Commit: `docs: chat streaming — dashboard/configuration/operations/ARCHITECTURE/CHANGELOG (spec 2026-09-06 §8)`

---

## PR plan

- **PR A (daemon + wire):** Tasks 1–7. Ships the new records, the splitter, the snapshot, `setNoDelay`, `extendSummary`. The pre-upgrade dashboard still shows the answer at turn end (spec §1.5), so `main` is never worse than today.
- **PR B (client core):** Tasks 8–12. Block state, per-frame flush, `maxFps`, the view split, the thinking block. This is the PR that makes streaming visible; it must not land before A.
- **PR C (rendering):** Tasks 13–15. Markdown, highlighter, tool cards, `x`.
- **PR D (edges):** Tasks 16–18. Doctor hint, e2e, perf test, docs, measurement numbers.

Each PR: rebase on `origin/main`, full gate, CI green, merge; the repo requires branches up to date with `main` and has no auto-merge, so merge strictly in order.
