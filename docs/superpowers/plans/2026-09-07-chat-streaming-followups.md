# Chat Streaming Follow-ups — Plan

Date: 2026-09-07. Closes the issues the 2026-09-06 chat streaming execution filed (#507–#516). Decisions taken with the maintainer: #513 closes as-is (error bodies open by default everywhere); #516 keeps `chat.maxFps` at 60 (synthetic Pi 5 numbers are within budget; the knob exists to drop back).

Same rules as `2026-09-06-chat-streaming.md` (Global Constraints), test-first, one commit per task, no attribution trailers, full gate per PR.

## PR E — daemon + docs (`feat/chat-followups-e`)

- **E1 (#509)** `src/chat/thinkSplitter.ts`: after a close tag, swallow exactly one `\n` (or `\r\n`) that immediately follows it — held across chunk boundaries like a tag prefix. `splitThinkingText` inherits it. Tests: `tests/thinkSplitter.test.ts` (whole-string, cross-chunk, `\r\n`, two newlines keep one, no newline unchanged), `tests/liveTurn.test.ts` tag cases, and `tests/e2e/chatStream.e2e.ts`'s `TEXT` pin becomes the bare markdown.
- **E2 (#507, #511-3)** `src/chat/liveBlocks.ts`: `ChatToolRecord.output` gains `replace?: true`; thinking `LiveBlock` gains `doneAt?: string`. `src/chat/liveTurn.ts`: when a `partialResult` snapshot does not extend `lastSnapshot`, emit the whole snapshot with `replace: true`; set `doneAt` (ISO from `now`) when a thinking block is marked done and carry it in `partial()`. Reducer `applyLiveRecord`: `replace` overwrites `output`; `doneAt` copied through. Keep `bash_execution_update` routing but document it as defensive (chat never calls `executeBash`) in the file header. Tests in `tests/liveTurn.test.ts` and `tests/chatLiveModel.test.ts`.
- **E3 (#508, #515, #516)** docs only: spec `2026-09-06-chat-streaming-design.md` §2.3 says the caps are UTF-16 code units (why: byte slicing splits characters; worst case ~24 KB) and §9 gets the decision line for #516 (keep 60; Mac measurement not run); `src/configLevers.ts` `chat.thinkTags` → `reload: "restart"` (a session snapshots `cfg`); `docs/configuration.md` § Chat footnote updated to match; CHANGELOG Unreleased `### Fixed` bullets for #509/#507/#515.

## PR F — client (`feat/chat-followups-f`, branched from E)

- **F1 (#510)** `src/tui/hooks/useChat.ts`: on ring overflow splice `max(1, floor(ringSize/10))` oldest lines at once (not one), so the whole-ring recompute happens once per ~200 records; `overflowed` semantics unchanged; header still says "showing last N". Test: the existing overflow test plus one asserting the recompute count (spy `summarizeTranscript` via a deps seam or count `extendSummary` state resets).
- **F2 (#511)** drop `ChatState.frame` (memo keys use `live` identity; `useLiveRows` deps updated); fold duration from `block.doneAt` when present (client-measured fallback kept); thinking headers navigable — add `think:*` anchors to the live/finished anchor lists (`chatAnchorIds`), cursor lands on them, and `t` on a thinking header toggles THAT block's expansion (`expanded` set, same mechanism as tool cards) while `t` elsewhere still flips the global pin. Tests: `tests/useChat.test.tsx`, `tests/tuiChatView.test.tsx`, `tests/useChatInput.test.tsx`.
- **F3 (#512)** `src/tui/markdown/render.ts`: open fences highlight per complete line with a per-line cache (only the last, incomplete line re-highlighted each frame); `useFinishedRows`' `mdCache` map resets when the chat key changes; links: `TranscriptRow.links?: Array<{ text; url }>` emitted by the renderer, `TranscriptBody` wraps such rows in Ink `<Transform>` applying `hyperlink()` post-layout with the URL dim (the `↗` line's existing pattern); `chat.theme: "auto" | "dark" | "light"` (schema default `auto`, lever, `tests/helpers/config.ts` ballast, docs) passed to `loadHighlighter(theme)` → `initTheme(name)`. Tests: `tests/markdown.test.ts`, `tests/tuiChatView.test.tsx`, `tests/config.test.ts`, `tests/dashboardCmd.test.ts`.

## PR G — tests (`feat/chat-followups-g`)

- **G1 (#514)** `tests/dashboardCmd.test.ts` → `makeConfig`; `chat.enabled` becomes a `ConfigSeams` key in `tests/helpers/config.ts` (update `tests/helpersConfig.test.ts` and the doctor fixtures that set it); `tests/helpers/fakeSession.ts` shapes checked with `satisfies` against the SDK's `AssistantMessageEvent`/`AgentSessionEvent` types (type-only import); `tests/chatRoutes.test.ts` `readSse` takes a bounded deadline (default 2 s) and fails fast with the frames seen so far.

Closing: each PR body says `Closes #…` for the issues it fully resolves; #513 and #516 are closed with a comment.
