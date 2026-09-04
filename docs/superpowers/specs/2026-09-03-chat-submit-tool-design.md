# Chat submit tool — design

**Date:** 2026-09-03 · **Status:** approved for planning · **Supersedes:** the read-only
tool clause of the chat spec (`2026-09-01-dashboard-chat-design.md` §2.3) and the
CLAUDE.md hard rule "the chat session's tools are the Q&A read-only subset", both widened by
exactly one tool as described here.

## 1. Problem

The live chat of 2026-09-03 showed the operator typing "submit" and "can you dispatch it
from this shell?" into the chat after the model had parked a ticket draft. The model is
read-only by design, so it declined — and, knowing nothing about the dashboard's draft
card, sent the operator to copy the fence into a file. The draft sat parked with `s submit`
one keystroke away. The gap is not navigation and not a shell: it is that **queueing the
work the chat just drafted cannot be asked for in the chat.**

The maintainer's scope (2026-09-03): the chat interfaces with the codebase and queues
work; every other action (approve, retry, rm, audit review, …) stays on the dashboard.
No dashboard navigation from the chat, ever.

## 2. What ships

One custom SDK tool for the chat model, **`junco_submit`**, whose only effect is submitting
an **already-parked draft** — to the inbox or as a parked GitHub issue — **after the operator
confirms in the dashboard, synchronously inside the model's turn**, so the model reports the
real outcome in the same reply. Plus a composer shortcut, `/submit`, for the operator who
would rather not spend a model turn.

Nothing else changes about what the model can do: its file tools stay the read-only subset
(`read`, `grep`, `find`, `ls`), it still drafts by emitting a `junco-ticket` fence that is
parked when its turn ends, and it still cannot run a shell.

## 3. The tool (daemon side)

### 3.1 Contract

```
junco_submit({ draft?: string, route?: "inbox" | "issue" })
```

- `draft` names a parked draft of THIS chat: its draft id (`acme__api-20260903-120000-1`) or
  one of its ticket ids (the fence's `id:`, which is also the draft file's stem). Omitted →
  the only parked draft of this chat; two or more parked and no `draft` → the tool fails
  and lists the candidates (the model must name one); a name matching nothing → fails
  naming what IS parked.
- `route` overrides the draft's destination for this submission (`--as-issue` or not).
  Omitted → the draft's own route (`routeOverride`, else the route decided at park time).
- A draft that failed lint or is blocked is refused before anything is proposed: the
  operator must edit it (`e`) or discard it first.
- The tool **blocks** until one of: the operator decides (`run` / `decline`); the operator
  aborts the turn; `chat.confirmTimeoutMinutes` elapses; the daemon stops.
- Result text (the model's tool result) states plainly what happened — one of:
  `submitted → inbox · <ticket ids> (exit 0)` + the CLI's output tail;
  `submit failed (exit N)` + output tail (the draft stays parked);
  `the operator declined — the draft stays parked`;
  `no decision within N minutes — the draft stays parked`;
  an error (thrown) for unknown/ambiguous/unsubmittable drafts, a second call while one
  is pending, or the tool being disabled.
- One pending confirmation per chat session at a time.

### 3.2 Wiring

- `src/agent/session.ts` — `SessionOverrides.customTools?: unknown[]`; `makePiSessionFactory`
  registers `[...sandboxTools ?? [], ...overrides.customTools ?? []]` as `customTools`. The
  SDK enables a custom tool only when its name is in the `tools` allowlist (verified: 0.84.4
  `agent-session.js` `_refreshToolRegistry`), so the chat passes
  `tools: [...readOnlyNames, "junco_submit"]`; `buildSandbox` skips names it does not know,
  so the sandbox path is unaffected.
- `src/chat/submitTool.ts` — the tool definition as a plain object (name, label,
  description, a plain JSON-schema `parameters` — the SDK's validator compiles plain JSON
  schema, no TypeBox import needed — and `execute(toolCallId, params, signal)`). The module
  is SDK-free; the object is cast at the single SDK boundary like the sandbox tools.
- `src/chat/chatSession.ts` builds the tool with callbacks bound to the session (§3.3) and
  passes it through `sessionFactoryFor` when `cfg.chat.submitTool` is true. The
  `junco_chat_turn_start.tools` record lists the real tool list, `junco_submit` included.

### 3.3 The confirmation handshake

```
model calls junco_submit ──► session.propose()  writes  junco_chat_command{status:"proposed"}
                                               pauses the turn deadline
                                               registers {commandId, resolve}
                                               awaits decision | abort | confirm timeout
dashboard shows the card ──► operator y/n ──► POST /chat/decide ──► session.decide()
                                               resolves the pending promise
                             on "run":         writes junco_chat_command{status:"running"}
                                               runs `junco submit …` (spawned CLI, §3.4)
                                               archives the draft, writes junco_chat_draft
                                               {status:"submitted"} + junco_chat_command
                                               {status:"ran"|"failed"}
                             on "decline":     writes junco_chat_command{status:"declined"}
                                               resumes the turn deadline
                             tool returns ───► the model finishes its answer
```

- `commandId` = the SDK's `toolCallId` (unique per call, visible on both sides).
- The **turn deadline pauses** while a confirmation is pending (`TurnDeadline` in
  `chatTurn.ts`: a pausable timer that subtracts the paused span), so a slow human never
  trips the 30-minute turn timeout; the confirm has its own budget.
- `ChatSession.abort()` settles a pending confirmation as `aborted` before signalling the
  turn (belt and braces — the SDK also aborts the tool's own signal).
- `drain()` (daemon stop) settles it as `aborted` too; on the next start,
  `stampCrashIfNeeded` closes any OPEN record — `proposed` or `running` — with no
  terminal record as `expired` (`detail: "daemon restarted"`), the way it stamps a
  crashed turn.
- **Amendment (#478).** The operator's `y` settles the pending slot at once, but the
  terminal record only lands when the spawned CLI exits (≈1 s for the inbox route,
  up to the 120 s budget for `--as-issue`). For that window the card used to still
  read `awaiting you`, the header still `◐ awaiting your confirmation`, and a second
  `y` toasted "that confirmation is no longer pending" against a card that said
  otherwise. `confirmSubmit` therefore writes an additive
  `junco_chat_command{status:"running"}` the instant a `run` decision releases the
  tool into `runSubmit`. A RECORD rather than a local dashboard flag on purpose: the
  transcript replays on every (re)connect, so a dashboard restarted mid-submit
  rebuilds the same state. It does not make `abort()` able to interrupt the spawned
  CLI — that stays out of scope.

### 3.4 Executing the submit

- `src/chat/submitExec.ts` — `runSubmit(cfg, draft, route, deps)`: builds the argv with the
  SAME builder the dashboard's `s` uses (`submitArgv`, moved from
  `src/tui/hooks/useChatDrafts.ts` to `src/chat/submitArgv.ts`), spawns the real CLI per
  file through a shared spawner (`src/cliSpawn.ts`, extracted from `src/tui/cliRunner.ts` so
  the daemon never imports from `src/tui`), stops at the first non-zero exit, and on
  success archives the draft (`archiveChatDraft(cfg, id, "submitted")`). Output is capped
  to a 4 KiB tail. The spawn budget is the palette's default, 120 s per invocation
  (`--as-issue` reaches GitHub through the outbox-backed path the CLI already has, so a
  slow network queues rather than hangs).
- The daemon spawns `dist/cli.js` next to its own entry (`new URL("../cli.js",
import.meta.url)` from `dist/chat/`), the same trick `cliRunner.ts` uses; tests inject
  `spawnFn`/`cliPath`.
- A draft that is no longer parked when `run` arrives (the operator pressed `s` on the card
  or in the review view meanwhile) → `failed`, `detail: "draft no longer parked"`, nothing
  spawned.

### 3.5 Records

```ts
export interface ChatCommandRecord {
  type: "junco_chat_command";
  commandId: string; // the SDK toolCallId
  command: "submit";
  draftId: string;
  ids: string[]; // the draft's ticket ids, for the row
  route: "inbox" | "issue"; // effective destination
  // `proposed` and `running` are both OPEN; exactly one of the other five closes it.
  status: "proposed" | "running" | "ran" | "failed" | "declined" | "expired" | "aborted";
  exitCode: number | null; // ran/failed only
  output: string | null; // ran/failed only; ≤ 4 KiB tail
  detail: string | null; // human context: "no decision in 10m", "daemon restarted", …
  ts: string;
}
```

`transcriptSummary.ts` folds it into the run's notes (`kind: "command"`) and exposes the
anchor `cmd:<commandId>` in `anchorIds`, so the card is reachable with `tab`, revealable,
and expandable. `transcriptRender.ts` renders one row per record (§4.2); `junco transcript
--chat` prints the same rows.

## 4. The dashboard side

### 4.1 State

`ChatState.pending: { commandId, draftId, ids, route, running } | null`, derived in
`useChat`'s record handler: a `proposed` record sets it (and blurs the composer, and parks
the cursor on the card's anchor); a `running` record with the same `commandId` flips
`running: true` and nothing else (the card is still the operator's — it is not a terminal
record, so no drafts reload and the composer stays blurred); a terminal record clears it
and reloads the drafts list (the daemon archived the draft). Replay on (re)connect
rebuilds it, so a dashboard restarted mid-confirmation — or mid-submit — shows the card in
the state the transcript left it.

### 4.2 Rows

| status   | row (tone)                                                                                  |
| -------- | ------------------------------------------------------------------------------------------- |
| proposed | `   ▸ submit <ids> → <route> — awaiting you · y submit · n keep parked` (accent)            |
| running  | `   ▸ submitting <ids> → <route>…` (accent) — the CLI is running (#478)                     |
| ran      | `   ✓ submitted → <route> · <ids> · exit 0` (success) — `⏎` expands the CLI output          |
| failed   | `   ✗ submit failed · exit N · <ids> — draft stays parked` (error) — `⏎` expands the output |
| declined | `   – submit declined · <ids> · draft stays parked` (dim)                                   |
| expired  | `   ⌛ submit expired · <detail> · draft stays parked` (warn)                               |
| aborted  | `   – submit aborted with the turn · <ids> · draft stays parked` (dim)                      |

The draft card itself flips to `▣ draft submitted → inbox …` on `ran`, exactly as it does
after the dashboard's own `s` (the daemon writes the same `junco_chat_draft` note).

### 4.3 Keys and footer

While `pending !== null` and the composer is blurred, the binding context is a new
structural-only view `chatConfirm`: actions row `y submit` (pill) · `n keep parked`;
navigate row `↑↓ scroll · ⇞⇟ page · i compose · esc back`. Its keymap is EMPTY — the draft
verbs (`s e r D`) are unbound while a submit awaits confirmation, so the same draft cannot
be submitted twice. `y`/`n` are handled in `useChatInput`'s blurred branch and POST the
decision; the footer chips are clickable through the existing chip dispatch. `i` still
focuses the composer (a steer typed now is delivered after the tool returns — the SDK
queues it at the next tool boundary); `esc` leaves the view as today, the card keeps
waiting. The header reads `◐ awaiting your confirmation` — and, once the card is
`running` (#478), `▸ submitting…`, with `y`/`n` disarmed in `useChat.decide` (a keystroke
there toasts "that submit is already running" instead of posting a decision the daemon
would 409).

### 4.4 `/submit`

`/submit [draft]` in the composer submits through the dashboard's own path
(`chatDraftActions.submit`, the card's `s`) — no model turn. Resolution as §3.1; refused with
a toast while a confirmation is pending. Listed in `SLASH_COMMANDS` with a hint.

### 4.5 Route

`POST /chat/decide { key, commandId, decision: "run" | "decline" }` → `202` when the
decision settled a pending confirmation, `409 { error: "not_pending" }` otherwise. Same
loopback/Host/Origin boundary as every `/chat/*` route. Client: `client.chat.decide(key,
commandId, decision)`.

## 5. Prompt

`chatPrompt.ts` gains one paragraph: the tool exists; it submits a parked draft after the
operator confirms; call it only when the operator asks to submit/queue/dispatch/send; the
call blocks until they decide; never in the same turn as the draft (a draft is parked when
the turn ends, so it does not exist yet); report exactly what the tool returned and never
claim a submission the tool did not return `ran` for. The existing "read-only" framing
becomes "read-only except for `junco_submit`". The draft-card paragraph from #475 stays:
the operator can also press `s`.

## 6. Configuration

| key                          | default | reload  | meaning                                                                               |
| ---------------------------- | ------- | ------- | ------------------------------------------------------------------------------------- |
| `chat.submitTool`            | `true`  | restart | register `junco_submit` on new chat sessions; `false` → the model keeps drafting only |
| `chat.confirmTimeoutMinutes` | `10`    | restart | how long a proposed submit waits for `y`/`n` before expiring                          |

`restart` for both: the tool list and its budget are fixed when the SDK session is built
(an existing session keeps whatever it was built with, like `chat.modelId`).

## 7. Failure handling

- Operator aborts (`esc` while streaming, `/abort`) → `aborted`; the draft stays parked.
- Confirm timeout → `expired` with `detail: "no decision in Nm"`; the turn deadline resumes.
- Daemon restart mid-confirmation → the pending promise dies with the process; on start the
  record is closed as `expired (daemon restarted)`; a late `POST /chat/decide` → 409.
- Dashboard closed → nobody decides → expiry as above. Two dashboards → first decision
  wins, the other's gets 409 and a toast.
- CLI exit ≠ 0 → `failed` with the output tail; the draft is NOT archived.
- Transcript degraded (append failing) → records still reach the bus; the card shows, the
  decision works, nothing persists — as with every other record today.
- The tool disabled (`chat.submitTool: false`) → not registered; a model that still emits
  the name gets the SDK's unknown-tool error.

## 8. Security posture

- No shell, no free-form argv: the model names a draft and a route; the argv is built by
  junco from files junco wrote. The operator sees ids and destination on the card before
  anything runs.
- The decision route is loopback-only with the Host allowlist and the Origin refusal every
  `/chat/*` route has; `commandId` must match a live pending confirmation.
- The tool never widens the model's file tools; `readOnly: true` and the sandbox are
  unchanged. CLAUDE.md's hard rule is rewritten to name the single exception.

## 9. Testing

- `submitTool.test.ts` — the definition's schema; `execute` with scripted `confirm`/`run`
  deps: run, decline, expiry, abort signal, unknown/ambiguous/lint-failed draft, second call
  while pending.
- `chatSession.test.ts` — the factory receives `customTools` + the `junco_submit` name when
  enabled and neither when disabled; the pending handshake through `propose`/`decide`;
  `abort()` settles pending as `aborted`; the turn deadline pauses while pending;
  `stampCrashIfNeeded` closes a dangling `proposed`.
- `chatTurn.test.ts` — `TurnDeadline` pause/resume arithmetic and that a paused turn does
  not time out.
- `submitExec.test.ts` — argv per route, first-failure stop, archive on success, output
  tail cap, "no longer parked".
- `chatRoutes.test.ts` — `/chat/decide` 202/409/400, method and boundary checks.
- `transcriptSummary.test.ts` / `transcriptRender.test.ts` — the note, the anchor, every
  status row, expanded output.
- Dashboard: `useChat.test.tsx` (pending derived from records, composer blur, cursor on the
  card, drafts reload), `useChatInput.test.tsx` (`y`/`n` post the decision, `/submit`
  resolution and the pending refusal), `useFooterBindings`/`footerModel` (`chatConfirm`),
  `tuiApp.chat.test.tsx` (the full round trip through frames with a fake client emitting
  the records).
- `tests/e2e/chatSubmit.e2e.ts` — the real thing: sandboxed daemon, scripted stub model
  (turn 1 drafts a fence, turn 2 calls `junco_submit`), the test reads `/chat/events`, POSTs
  `/chat/decide`, and asserts the ticket landed in the sandbox inbox and the transcript
  carries `ran`. This is the only test that proves the SDK registers and aborts the custom
  tool as designed.

## 10. Out of scope (deliberately)

Any other CLI verb for the model; read-only `status`/`list` tools; dashboard navigation;
submitting a ticket the model has not first parked as a draft; a rail badge for a pending
confirmation (follow-up if wanted); moving the dashboard's own `s` through the daemon.
