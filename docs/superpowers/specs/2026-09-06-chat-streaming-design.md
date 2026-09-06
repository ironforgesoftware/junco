# Dashboard Chat Streaming — Design

Date: 2026-09-06
Status: draft (for refinement); plan: `docs/superpowers/plans/2026-09-06-chat-streaming.md` (to follow)
Builds on: `2026-09-01-dashboard-chat-design.md` (transport, records, session ownership),
`2026-09-03-chat-submit-tool-design.md` (the `junco_submit` card), `2026-09-01-ink-render-perf-design.md`
(Ink render tiers).

## Motivation

The dashboard chat works, but it does not _feel_ like talking to the agent. Text lands in
50 ms lumps, the model's reasoning is invisible until the turn ends and then only as dim rows
behind a toggle, tool calls happen off-screen, a reconnect mid-turn blanks the answer, and
the whole conversation is re-laid-out for every lump. Pi's own interactive mode is the
reference for the feel we want: characters appear as the provider emits them, thinking is a
visibly separate block that streams and then folds away, tool calls show up as they run, and
the answer is rendered as markdown with highlighted code.

This spec brings that feel into the existing Ink dashboard without changing who owns the
session: the daemon still runs the Pi session, the dashboard still observes it over the
health server. Every change is either on the wire (slimmer, resumable), in the daemon (a
splitter and a snapshot), or in the client (a block model and a renderer that costs O(live
block) per frame instead of O(transcript)).

## Key findings that shape the design

A read-only survey of the current path (2026-09-06, on main @ 389e950) established:

- **Character granularity is already on the wire.** The Pi SDK emits one `message_update`
  per provider chunk, with `text_delta` and `thinking_delta` as distinct event kinds and a
  `contentIndex` on each (`pi-ai/dist/types.d.ts:400-451`). `ChatSession.emitSdk` publishes
  every one to the in-memory bus synchronously; `chatRoutes.ts` writes each frame the moment
  `publish` calls it, with no batching. SSE is not the bottleneck and a WebSocket would add
  nothing for a one-way stream plus small admission POSTs. The spec-level non-goal from
  2026-09-01 stands.
- **The 50 ms client flush and Ink's 30 fps cap are the latency floor** (`useChat.ts:15`,
  `ink/build/ink.js:194` → 33 ms). Worst case ~83 ms per character. The 2026-09-01 spec
  documents the 50 ms as "cheap insurance", not a measured need: per-delta `setState` kept
  event-loop lag ≤ 13 ms at 1000 events/s in the spike.
- **`thinking_delta` is discarded by the client** (`useChat.ts:193-200` handles only
  `text_delta`). Thinking is reconstructed at `turn_end` from `message.content[].type ===
"thinking"` (`transcriptSummary.ts:400-429`), so it can never show live.
- **Rendering is O(transcript) per flush.** `liveText` is a dependency of the memo that
  builds every row (`ChatView.tsx:131-149`), so each flush re-runs `renderTranscriptRows`
  over the whole summary and hands `TranscriptBody` a fresh array that defeats its
  `React.memo`. Every non-delta record also re-summarizes the whole 2000-line ring
  (`useChat.ts:207`).
- **The wire payload is quadratic.** Each `message_update` line carries the whole
  accumulating message twice (`message` and `assistantMessageEvent.partial`), serialized with
  `JSON.stringify` inside the SDK's synchronous subscriber (`chatSession.ts:291-296`). The
  SDK awaits subscribers sequentially in its token loop (`pi-agent-core/dist/agent.js:417`),
  so this cost also stalls token consumption.
- **Deltas are un-resumable by construction.** Bus-only frames carry no SSE `id` and are
  never persisted (spec 2026-09-01 §5.2), so a reconnect mid-turn loses the streamed text
  until `turn_end` replays.
- **The operator's endpoint emits thinking as inline `<think>` tags.** The SDK's
  openai-completions path recognizes only `reasoning_content`/`reasoning`/`reasoning_text`
  fields (`pi-ai/dist/api/openai-completions.js:155,415`); it never splits tags out of
  text. With tags, thinking arrives as `text_delta` and would render inside the answer.
- **Pi's TUI is not embeddable.** `@earendil-works/pi-tui` is a separate differential-render
  framework (own 16 ms loop, input, focus), its components take a live `TUI` host, and the
  package is a nested dependency not resolvable from junco. What `pi-coding-agent` does
  re-export publicly and side-effect-free are pure string renderers: `renderDiff`,
  `highlightCode(code, lang): string[]`, `getLanguageFromPath`, and the `Theme` color slots
  (including `thinkingText`). Ink renders embedded ANSI in `<Text>` unchanged, so those are
  reusable; every visual component is not. Pi's markdown renderer (`pi-tui` `Markdown`) is
  _not_ re-exported.
- **No `setNoDelay`** is set on the SSE socket anywhere (`chatRoutes.ts`, `healthServer.ts`),
  so Nagle can hold small frames at Node's defaults.

## Decisions

Recorded 2026-09-06 with the maintainer:

| #   | Topic            | Decision                                                                                                                                                                               |
| --- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Transport        | SSE out, POST in, unchanged. Add `setNoDelay(true)` on the SSE socket and a slim per-delta record. No WebSocket.                                                                       |
| D2  | Endpoint         | Design for a local openai-compatible server; thinking must be absent gracefully.                                                                                                       |
| D3  | Think tags       | A daemon-side streaming splitter re-tags `<think>…</think>` spans as thinking deltas, plus a `junco doctor` hint naming the server flag that moves reasoning into `reasoning_content`. |
| D4  | Thinking UX      | Live in its own block while the model thinks; auto-collapses to a one-line header when the answer starts; `t` expands or pins.                                                         |
| D5  | Answer rendering | Full markdown, rendered incrementally per block; fenced code highlighted with Pi's `highlightCode`.                                                                                    |
| D6  | Tool activity    | Live tool cards: name + args, spinner while running, streamed bash output, truncated result with an expand key.                                                                        |
| D7  | Reconnect        | The daemon keeps the in-flight turn's blocks and replays them as a snapshot on attach. Deltas still never persist.                                                                     |
| D8  | Frame rate       | Per-frame flush aligned to Ink; `maxFps: 60`; measured on the Pi 5; a config knob to drop back.                                                                                        |
| D9  | Scope            | Dashboard chat only. No separate full-screen Pi mode.                                                                                                                                  |

## Non-goals

- Persisting deltas or thinking to `transcript.jsonl`. The transcript stays the record of
  complete turns (spec 2026-09-01 §1.3); `junco transcript --chat` output is unchanged.
- Any change to the chat tool set, the `junco_submit` handshake, gates, spend, or the auth
  boundary. `/chat/*` stays loopback-only with the Origin and Host checks.
- Rendering images, LaTeX, or Mermaid. Pi does; junco's chat renders text.
- Ticket-transcript rendering (`junco transcript <id>`, the queue row's overlay). The block
  renderer is chat-only in v1; unifying is a follow-up.
- A WebSocket transport, a second HTTP server, or exposing the chat off loopback.

## 1. Wire contract (`src/agent/transcriptSchema.ts`, `src/chat/chatSession.ts`, `src/chat/chatRoutes.ts`)

### 1.1 Records

Three new **bus-only** junco records replace the raw SDK `message_update` on the stream. They
are never written to the transcript file and never carry an SSE `id` (the 2026-09-01 §5.2
rule: `Last-Event-ID` always names a persisted line). Everything else on the stream is
unchanged.

```ts
// One provider chunk, re-tagged. `contentIndex` is the SDK's content-block index so
// interleaved text/thinking blocks keep their order; `seq` is a per-turn counter the
// client uses to drop duplicates after a snapshot.
{ type: "junco_chat_delta", turn: string, seq: number, kind: "text" | "thinking",
  contentIndex: number, delta: string }

// Tool lifecycle, compact. `args` is the SDK's parsed args object; `output` is the
// streamed bash output (bash_execution_update) or a tool_execution_update partial;
// `result` is the final text, truncated by the daemon to CHAT_TOOL_RESULT_CAP bytes
// with `truncated: true` so a 40 KB `cat` never crosses the wire.
{ type: "junco_chat_tool", turn: string, seq: number, id: string,
  phase: "start" | "output" | "end", name?: string, args?: unknown,
  output?: string, result?: string, isError?: boolean, truncated?: boolean }

// The in-flight turn as of subscribe time (D7). Sent first, before any live frame,
// only while a turn is streaming. `blocks` is the same shape the client keeps, so
// applying it is a replace, not a merge.
{ type: "junco_chat_partial", turn: string, seq: number, blocks: LiveBlock[] }
```

`LiveBlock` (shared type in `src/chat/liveBlocks.ts`, pure, no I/O):

```ts
type LiveBlock =
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
```

`turn` is a new `turn: string` field on the persisted `junco_chat_turn_start` record (an
additive change to `ChatTurnStartRecord`; a ULID-style id minted by `ChatSession.admit`).
Records written before this field exists have none, so the client falls back to the
record's `ts` as the turn id — only ever relevant when replaying an old transcript, where
no live deltas exist anyway. The client discards deltas whose `turn` is not the current
one, which closes the resubscribe race in `useChat.ts` without the 1 s grace timer's help.

### 1.2 What the daemon emits, and when

`ChatSession.emitSdk` stops publishing `message_update`. Instead a `LiveTurn` accumulator
(`src/chat/liveTurn.ts`, pure) observes every SDK event for the current turn and emits the
records above:

| SDK event                                                      | Effect                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `message_update` / `text_delta`                                | Through the think-tag splitter (§2.1) → zero or more `junco_chat_delta` (`text` or `thinking`) |
| `message_update` / `thinking_delta`                            | `junco_chat_delta` `thinking` (native reasoning; no splitting)                                 |
| `message_update` / `thinking_end`, `text_start` after thinking | Marks the thinking block `done` (drives the client's auto-collapse)                            |
| `tool_execution_start`                                         | `junco_chat_tool` `start`                                                                      |
| `tool_execution_update`, `bash_execution_update`               | `junco_chat_tool` `output` (delta only)                                                        |
| `tool_execution_end`                                           | `junco_chat_tool` `end` (result capped)                                                        |
| `turn_end`, `junco_chat_turn_aborted`, `junco_chat_turn_end`   | Accumulator reset; the persisted records flow as today                                         |

All other SDK events keep their current treatment (persisted + bus, unchanged), so
`summarizeTranscript` and `junco transcript --chat` see exactly what they see today.

The accumulator also _is_ the snapshot source: `ChatSession.subscribe` (via
`ChatManager.subscribe`'s replay-then-attach) sends `junco_chat_partial` from
`liveTurn.blocks()` after the file replay and before attaching the live fan-out, inside the
same synchronous section that already guarantees no line slips between replay and attach.

### 1.3 Per-frame cost on the daemon

The per-chunk work in the SDK's synchronous subscriber becomes: splitter step (O(delta)),
one small object, one `JSON.stringify` of tens of bytes, one `res.write`. The quadratic
`partial` serialization goes away entirely. `LiveTurn` keeps the accumulating text in a
`string[]` per block and joins only on snapshot.

### 1.4 Socket

`chatRoutes.ts` calls `res.socket?.setNoDelay(true)` right after `writeHead` on the SSE
response. Keep-alive ping cadence is unchanged (15 s).

### 1.5 Compatibility

A pre-upgrade dashboard attached to a post-upgrade daemon sees `junco_chat_delta` records
it does not understand and ignores them (`useChat` already drops unknown junco records), so
it shows the answer at turn end as today. The reverse (new dashboard, old daemon) gets raw
`message_update` frames and ignores them the same way. Both degrade to the current
behaviour; neither errors. `/chat/status` is unchanged.

## 2. Daemon (`src/chat/chatSession.ts`, `src/chat/liveTurn.ts`, `src/chat/thinkSplitter.ts`, `src/doctor.ts`)

### 2.1 Think-tag splitter (D3)

`src/chat/thinkSplitter.ts` exports a pure streaming state machine:

```ts
interface ThinkSplitter {
  push(delta: string): Array<{ kind: "text" | "thinking"; delta: string }>;
  end(): Array<{ kind: "text" | "thinking"; delta: string }>; // flush any held bytes
}
makeThinkSplitter(opts?: { open?: string; close?: string }): ThinkSplitter // defaults <think> / </think>
```

Rules:

- Case-sensitive exact tags, matched across chunk boundaries: the splitter holds back at
  most `open.length - 1` trailing bytes that could be a tag prefix and releases them on the
  next push or on `end()`. Nothing is dropped; a false prefix (`<thin` followed by `k you`)
  is released as text.
- The tags themselves are never emitted. Whitespace immediately after `<think>` and
  immediately before `</think>` is trimmed from the thinking block; nothing else is trimmed.
- An unclosed `<think>` at `end()` leaves the block as thinking (the model was cut off).
- A `</think>` with no open is text (some templates emit a bare close; showing it is
  wrong, hiding it silently is worse — it is passed through as text so the transcript is
  honest).
- Nesting is not supported; a second `<think>` inside a thinking block is text inside it.

The splitter is applied only to `text_delta`, only in chat, and only when
`chat.thinkTags` is `"auto"` (default) or `"on"`. `"off"` disables it. `auto` means: on
unless the turn has already produced a native `thinking_delta`, in which case tags are left
alone (a model that streams `reasoning_content` and also happens to say `<think>` in prose
should not be split).

The same splitter is **not** applied to the persisted turn: `turn_end`'s message keeps the
tags in its text content, exactly as the SDK produced it. The summary renderer for finished
turns (§4.3) applies a non-streaming version of the same split at render time, so finished
and live turns look the same without rewriting the transcript.

### 2.2 Doctor hint (D3)

A new advisory check `chat thinking` in `runDoctor`'s check table:

- If `chat.thinkTags` is not `"off"` and the model is inline-resolved (openai-completions):
  probe nothing (no billed traffic; the endpoint check already ran). Report `ℹ chat
thinking — <think> tags are split by junco; move reasoning into reasoning_content on the server for the cleanest stream` and name the flag for the two servers junco can recognize
  from `model.baseUrl` or the endpoint's `/v1/models` banner if the existing probe captured
  one: llama.cpp `--reasoning-format deepseek`, LM Studio "Reasoning → separate field". Unknown
  server: generic wording.
- Never a failure or a warning; it is a hint (`ℹ`, a new severity glyph in the doctor
  output, rendered like `✓` for exit-code purposes).

### 2.3 Result cap

`CHAT_TOOL_RESULT_CAP = 8_192` bytes on `junco_chat_tool.end.result` and a
`CHAT_TOOL_OUTPUT_CAP = 32_768` rolling cap on accumulated `output` in `LiveTurn` (the card
shows the tail). The SDK's own tool result is untouched; only the wire copy is capped.

## 3. Client state (`src/tui/hooks/useChat.ts`, `src/tui/chatLiveModel.ts`)

### 3.1 State shape

`ChatState` changes in three places; everything else is unchanged:

```ts
// removed
liveText: string;
// added
live: LiveTurnState | null; // the in-flight turn, null when idle
thinking: {
  pinned: boolean;
} // replaces showThinking
frame: number; // bumps once per applied flush; the memo key for the live rows

interface LiveTurnState {
  turn: string;
  seq: number; // highest applied
  blocks: LiveBlock[]; // §1.1
  expanded: Set<string>; // tool card ids the operator expanded
}
```

`summary` stays, but is **incremental** (§3.3). `showThinking` becomes `thinking.pinned`:
`t` toggles the pin. Unpinned (default) is D4's behaviour — the live thinking block shows
while it streams and collapses when `done`; pinned keeps it open, and also expands the
finished turns' thinking rows the way `showThinking` did.

### 3.2 Applying records

`src/tui/chatLiveModel.ts` is a pure reducer, `applyLiveRecord(state, record): LiveTurnState
| null`, tested without React:

- `junco_chat_turn_start` → new `LiveTurnState` with that turn id.
- `junco_chat_partial` → replace `blocks` and `seq` wholesale (only if `turn` matches the
  current or there is none; otherwise start a new state from it).
- `junco_chat_delta` → drop if `turn` mismatches or `seq <= state.seq`; else append to the
  block with that `contentIndex` and `kind`, creating it if absent, in `contentIndex` order.
  A `text` delta arriving after a not-`done` thinking block marks it `done` (belt and braces
  against a missing `thinking_end`).
- `junco_chat_tool` → `start` creates a tool block; `output` appends (respecting the rolling
  cap); `end` sets `result`/`isError`/`done`.
- `turn_end` / `junco_chat_turn_end` / `junco_chat_turn_aborted` → `live = null`; the finished
  turn arrives through the summary as today.

The reducer mutates a pending copy accumulated between flushes (§3.4); React sees one new
`live` object per frame.

### 3.3 Incremental summary

`summarizeTranscript(ring)` over the whole ring on every record becomes
`extendSummary(summary, record)`: `transcriptSummary.ts` gains an incremental entry point
that appends one record's effect to an existing `TranscriptSummary` (the same state machine
it already runs, exposed step-wise), with the whole-ring function kept for the replay path
and for `junco transcript`. Ring overflow (`overflowed`) recomputes from the ring once, as
today. The output must be identical to a whole-ring recompute — pinned by a property test
that feeds recorded transcripts both ways.

### 3.4 Per-frame flush (D8)

Replace the 50 ms trailing timer with a frame-aligned flush:

- Incoming records are applied to a pending `LiveTurnState` synchronously in the SSE
  callback (cheap: string append).
- A flush is scheduled with `setImmediate` if none is pending; the flush does one
  `setChat` that publishes the pending state and bumps `frame`.
- Ink's own throttle (`maxFps`) then bounds paint rate. With `maxFps: 60` the added latency is
  ≤ 16 ms; with the old 30 it is ≤ 33 ms. Either way the 50 ms is gone.

`INK_RENDER_OPTIONS.maxFps` becomes `60`. `chat.maxFps` (config, default `60`, min 10, max 120) is read by `dashboardCmd` and passed through; the knob exists so the Pi 5 (or any slow
terminal) can drop back without a code change.

### 3.5 Resubscribe

`CHAT_RESUBSCRIBE_MS` (1 s after `end`) stays. The `turn`-scoped dedupe in §3.2 makes the
reconnect exact: the daemon's `junco_chat_partial` replaces whatever the client had, and any
delta already applied is dropped by `seq`.

## 4. Rendering (`src/tui/components/ChatView.tsx`, `src/tui/chatBlocks/*.tsx`, `src/tui/markdown/*`)

### 4.1 Structure and memoization

`ChatView` renders two children with independent memo boundaries:

- `<FinishedTurns rows={finishedRows} …/>` — rows built from `summary` only. The memo key is
  `[summary, thinking.pinned, expanded, width]`; `live` and `frame` are **not** inputs. A
  flush never re-runs this.
- `<LiveTurn live={live} frame={frame} width={width} …/>` — rows built from `live.blocks`
  only. Cost per frame is O(bytes in the live turn), and within that the text block renders
  only its last paragraph fresh (§4.2).

`TranscriptBody`'s windowing stays; it receives the concatenation lazily (a row-count and a
`rowAt(i)` accessor instead of a materialized array) so the finished rows array is never
copied per frame.

### 4.2 Markdown (D5)

`src/tui/markdown/` is a small block-level renderer, junco-owned, with no new dependency
(the repo already has `marked` transitively through Pi, but a direct dependency would need
exact-pinning and a licence check; the subset needed is small):

- Blocks: paragraph, heading (1–3), bullet/numbered list (one level of nesting), blockquote,
  fenced code, horizontal rule. Inline: `code`, **bold**, _italic_, links (rendered as text
  with the URL dim, OSC 8 hyperlink when the terminal supports it — `links.ts` already
  decides).
- Fenced code is highlighted with Pi's `highlightCode(code, lang)`; the language comes from
  the fence info string, falling back to plain. The import is type-safe through the same
  `await import("@earendil-works/pi-coding-agent")` seam in `agent/session.ts` (hard rule: no
  top-level SDK import), exposed as `deps.highlight` so tests use a fake.
- **Streaming rule:** the renderer works on _closed_ blocks plus one _open_ tail. Closed
  blocks (everything before the last blank line, or a fence that has closed) are rendered
  once and cached by block index; only the open tail is re-rendered per frame. An unclosed
  fence renders as code from its opening line, so a streaming code block is highlighted
  line by line as it arrives.
- Wrapping uses the existing `wrapText`; tables are rendered as preformatted text (no
  column layout in v1).

### 4.3 Thinking block (D4)

- Live, not done: a header row `· thinking` with the elapsed seconds ticking (the shared
  spinner timer from the render-perf spec), followed by the streamed text in
  `theme.thinkingText` (dim italic), indented two columns, plain-wrapped (no markdown —
  reasoning is not prose to typeset).
- Done, unpinned: collapses to one row `▸ thinking · 3.2s` (the duration from `startedAt`).
  `t` (pin) expands it; the pin persists for the session.
- Done, pinned: the full text stays, with the header now `▾ thinking · 3.2s`.
- Finished turns: the same header row, collapsed unless pinned; the text comes from the
  turn's thinking content, or from a render-time tag split of the text content when the
  turn was produced through the splitter (§2.1). This replaces today's dim rows behind
  `showThinking`.
- A turn with no thinking shows no header at all (D2: absent gracefully).

### 4.4 Tool cards (D6)

One card per tool block:

```
▸ read  src/chat/chatSession.ts                          ⠋
```

- Header: glyph, tool name, a one-line argument summary (path for read/edit/write/ls,
  pattern for grep/find, the command for bash — the existing `transcriptRender.ts` already
  formats these for the ticket transcript; reuse its helper), a spinner while running, `✓`
  or `✗` when done.
- Body while running: the last N lines of streamed output (N = 6), dim.
- Body when done: collapsed by default to the header plus a one-line result summary (line
  count / bytes / first line); `enter` on the card, or `x` (a new chat-view verb, derived
  through `viewActions.ts` like every other), expands to the capped result in a scrollable
  block; again collapses. Expanded ids live in `live.expanded` and, for finished turns, in
  the existing `expanded` set keyed by tool-call id.
- Errors render the header `✗` in the danger tone and the body expanded.

### 4.5 Keys

Existing chat keys are unchanged. `t` changes meaning from "show thinking" to "pin
thinking" (the label in the footer becomes `pin thinking`). New: `x` expand/collapse the tool
card under the cursor. Both derive through `viewActions.ts`; the footer chip list for the
chat view gains `x` and relabels `t`.

## 5. Config (`src/configSchema.ts`, `docs/configuration.md`, `tests/helpers/config.ts`)

```ts
chat: {
  …existing,
  thinkTags: z.enum(["auto", "on", "off"]).default("auto"),
  maxFps: z.number().int().min(10).max(120).default(60),
}
```

Both are hot-reloadable in the sense the rest of `chat` is: `thinkTags` is read per turn,
`maxFps` per dashboard launch. Add to `tests/helpers/config.ts` (the one full `Config`
literal) and document under `docs/configuration.md` § Chat.

## 6. Error handling

- A malformed `junco_chat_delta` (missing fields) is dropped by the client reducer, counted
  in a `dropped` field on `LiveTurnState` shown as a dim `(n frames dropped)` in the header
  when non-zero. It never throws out of the SSE callback (a throwing subscriber is removed
  by the bus — the existing rule — so the client must be the resilient side).
- A snapshot for a turn the client has never seen replaces state (§3.2); a snapshot for an
  older turn than the current is ignored.
- The splitter never throws; it is total over any byte sequence.
- Tool output beyond the rolling cap is dropped from the head with a `…` marker row.
- If `highlightCode` throws for a language, the block renders unhighlighted; the error is
  logged once per language per session.

## 7. Testing

Contracts that change (and the pinning tests to update):

- `tests/chatSession.test.ts:226-251` — the bus carries `junco_chat_delta`, not
  `message_update`; the persisted record list is unchanged.
- `tests/chatRoutes.test.ts:363-437` — live frames are `junco_chat_delta` without `id`;
  a subscribe during a streaming turn is preceded by exactly one `junco_chat_partial`.
- `tests/useChat.test.tsx` — `liveText` assertions become `live.blocks` assertions; the
  coalescing test asserts one `setChat` per flush rather than per 50 ms.
- `tests/tuiChatView.test.tsx` — snapshots for the thinking header states, tool cards, and
  markdown rows.

New tests:

- `tests/thinkSplitter.test.ts` — property-based: any string split into arbitrary chunk
  boundaries produces the same block sequence as the whole string; tags across boundaries;
  false prefixes; unclosed; bare close; nested.
- `tests/liveTurn.test.ts` — the daemon accumulator: SDK event fixtures (extend
  `tests/helpers/transcriptFixtures.ts`) → emitted records and snapshot.
- `tests/chatLiveModel.test.ts` — the client reducer: ordering by `contentIndex`, `seq`
  dedupe after a snapshot, turn mismatch, caps.
- `tests/transcriptSummaryIncremental.test.ts` — `extendSummary` equals whole-ring
  `summarizeTranscript` over every recorded chat transcript fixture.
- `tests/markdown.test.ts` — block/inline rendering; the open-tail invariant (rendering a
  prefix then the rest yields the same rows as rendering the whole).
- `tests/tuiChatPerf.test.tsx` — a synthetic 300 events/s stream for 5 s against a 200-turn
  summary: asserts the finished-turns memo is not re-run, and event-loop lag stays under a
  budget (measured, see §9), with the budget asserted loosely enough for CI.
- `tests/doctor.test.ts` — the `chat thinking` hint for the recognized servers and the
  generic case.
- E2E: `tests/e2e/chatSubmit.e2e.ts` gains a scripted turn whose stub emits `<think>` text
  and a tool call, asserting the dashboard-side records via `/chat/events`.

## 8. Documentation

- `docs/dashboard.md` § Chat: thinking block behaviour, `t` pin, `x` cards, the reconnect
  guarantee.
- `docs/configuration.md` § Chat: `thinkTags`, `maxFps`.
- `docs/operations.md`: the doctor hint and the server flags.
- `ARCHITECTURE.md`: "The chat path" prose gets the three bus-only records and the
  snapshot; module-map rows for `chat/liveTurn.ts`, `chat/thinkSplitter.ts`,
  `chat/liveBlocks.ts`, `tui/chatLiveModel.ts`, `tui/markdown/`.
- `CHANGELOG.md` Unreleased: `### Changed` for the wire records (a pre-upgrade dashboard
  degrades to turn-end text) and `### Added` for thinking, tool cards, markdown, `maxFps`.

## 9. Measurement plan

Before the first rendering task lands, and again at the end, on the Pi 5 and on the
maintainer's Mac, with the synthetic stream from `tests/tuiChatPerf.test.tsx` driven through
a real `junco dashboard` (`JUNCO_RENDER_COUNT=1`):

| Metric                                          | Today (measure) | Target            |
| ----------------------------------------------- | --------------- | ----------------- |
| Character-visible latency (delta → paint), p95  |                 | ≤ 20 ms at 60 fps |
| Event-loop lag at 300 events/s, p95             |                 | ≤ 10 ms           |
| `ChatView` renders per second at 300 events/s   |                 | ≤ maxFps          |
| `FinishedTurns` renders during a streaming turn |                 | 0                 |
| Daemon CPU per 1k deltas (bus + SSE write)      |                 | ≤ 25% of today's  |
| Bytes on the wire per 1k characters             |                 | ≤ 5% of today's   |

If the Pi 5 cannot hold 60 fps under the budget, the default `chat.maxFps` ships at 30 and
the spec is amended with the numbers; D8 authorizes that fallback.

## Implementation notes

- Order of work (the plan will sequence these as TDD tasks): splitter → `LiveTurn` +
  records → routes (`setNoDelay`, snapshot) → client reducer + incremental summary →
  per-frame flush + `maxFps` → `FinishedTurns`/`LiveTurn` split → thinking block →
  markdown → tool cards → keys/footer → doctor hint → docs/changelog → measurement.
- The wire records land with the client reducer in the same PR so `main` never has a
  daemon emitting frames no shipped dashboard understands beyond the degrade path in §1.5.
- Hard rules honoured: no SDK import at module top level (the highlighter goes through the
  `session.ts` seam), every side effect behind `deps`, `ticketSchema.ts` untouched, the
  Q&A read-only default untouched, `/chat/*` boundary untouched.
