# Dashboard Chat — Design

Date: 2026-09-01
Status: approved (chat review); plan: `docs/superpowers/plans/2026-09-01-dashboard-chat.md`

## Motivation

The dashboard observes junco but cannot converse with it. Every unit of work enters through a
ticket authored somewhere else — a harness running the `junco-dispatch` skill, or a hand-written
file — and the operator's questions about a repo ("what does this module do?", "is there a
cheaper way to do #42?", "draft me a ticket for that") go to a separate tool that has no idea what
junco is watching, what it has already done, or how it wants work phrased.

This feature adds an ongoing, per-repo **chat with the coding agent inside the dashboard**, using
the Pi SDK junco already drives in-process, and makes **every dispatch branch reachable from that
conversation**: fresh tickets, ticket sets, plan sets, amend tickets, apply tickets, audit and
investigate requests — each parked for the same human confirmation the audit and investigate flows
already use. The chat is the drafting surface; the queue stays the execution surface.

## Key findings that shape the design

A throwaway spike (2026-09-01, not kept) established:

- **The SDK's `AgentSession` is an interactive harness API, not a batch one.** `prompt()` is
  multi-turn with `streamingBehavior: "steer" | "followUp"`; `steer()`, `isIdle`, `isStreaming`,
  and `messages` exist; session persistence is file-backed through `SessionManager.create(cwd,
sessionDir)` / `.open(path, sessionDir)` with a caller-supplied dir. junco's `runAgent` is
  deliberately one-shot (subscribe → one prompt → dispose) and uses about four methods of it.
  Multi-turn history retention was confirmed empirically (`messages.length === 4` after two
  turns; turn 2 quoted turn 1).
- **The streaming event is `message_update`** (not "delta"); `agent_settled` is the clean
  "ready for the next prompt" signal; per-turn usage and `cost.total` ride on `message_end` and
  `turn_end`, which is exactly what `RunAccumulator` already reads. `compaction_start` /
  `compaction_end` exist and are unhandled by `transcriptSchema.ts` and `TranscriptView.tsx`.
- **`queueMessage` is declared in the `.d.ts` but is `undefined` on the runtime object** (SDK
  0.84.2). `steer()` is real. The design uses only `prompt`, `steer`, `abort`, `subscribe`,
  `dispose`, `isIdle`, `isStreaming`, `messages`.
- **A bare `prompt()` has no time budget.** `runAgent`'s `timeoutMs` and the four guards do not
  apply outside it; a tool-heavy turn on a local model ground for seven minutes before being
  killed by hand. Chat needs its own per-turn timeout and abort.
- **Ink render throughput is not a bottleneck.** A synthetic `message_update` stream into a
  realistic chat pane kept event-loop lag ≤ 13 ms even at 1000 events/s with naive per-event
  `setState`; a 50 ms batch cut renders 12× and bytes ~40% at 300 events/s. The local model
  streams at ~4.6 events/s.
- **`spendLedger.ts` is single-writer.** `recordUsd` is an unlocked read-modify-write with a
  fixed sibling temp path. Two writer processes (400 × $0.01) recorded $2.00 of $4.00, one
  process crashed with an uncaught `ENOENT` on `renameSync`, and a torn file makes `todayUsd()`
  return 0 — which silently disables the daily budget cap. **Chat therefore lives in the daemon
  process**, where the ledger keeps its single writer.
- **`submitTicket` is multi-process safe by design** (hidden tmp file, then hardlink, `EEXIST`
  on a race), and `junco submit --dry-run` (`submitPreflight.ts: decideRoute` + `lintTicket`)
  is the routing/lint verdict the dispatch skill is told to copy, never re-derive.
- **`planPrompt.ts` already declares `PLAN_FENCE = "junco-ticket"`** and treats
  `skills/junco-dispatch/TEMPLATE.md` as the single source of truth; the ticket schema already
  carries `amends_pr`, `audit:`/`investigate:` (with `assess:`/`analyze:` as permanently accepted
  legacy aliases since #389), `depends_on`, and the `junco-patch` body fence.
  Most dispatch branches are frontmatter shapes of one artifact.

## Decisions

Each of these was an explicit brainstorm answer; the "why" is recorded so the plan doesn't
re-litigate them.

- **The session lives in the daemon and survives both a dashboard quit and a daemon restart.**
  File-backed via `SessionManager.create(cwd, <juncoChatDir>)`; never `~/.pi`. Why: the
  ledger's single-writer constraint above, and a chat that evaporates with the TUI isn't a
  harness.
- **Out-of-band scheduling, but gated.** Chat holds no `max_concurrent` slot and no same-repo
  busy key (read-only, no worktree). The daily-budget gate and the provider gate block new
  turns exactly as they block claiming, and a provider failure during a chat turn reports into
  the gate exactly as a ticket's would. Why: spend is spend and a 429 is a 429, whoever
  triggered it; a single local GPU sharing throughput is surfaced, not prevented.
- **Read-only tools, fixed.** `READ_ONLY_TOOLS ∩ cfg.tools`, the Q&A narrowing. Writes happen
  only through the dispatch handoff. Why: the hard rule never to widen the read-only default,
  and a chat that can edit the clone blurs the ticket model.
- **One session per repo, anchored to the rail.** Why: the dashboard's "body follows the
  cursor" model, no session-picker UI, and cleanup rides on `junco unwatch`. `/new` is the
  escape hatch (archive and start fresh).
- **Every dispatch branch is reachable, each parked for confirmation.** Why: dispatch is the
  point of the feature, and park-then-confirm is already the house idiom (audit findings,
  investigate comments).
- **Transport is SSE out, HTTP POST in, on the existing health server.** Chosen over the
  file-drop idiom for harness-feel latency. Node 22 ships no WebSocket server and the repo has
  no `ws` dependency, so this is the zero-dependency form. Consequences owned by this spec: a
  loopback-only auth boundary on `/chat/*`, and an in-flight prompt is lost across a daemon
  restart (the session is not).
- **Confirm spawns the CLI verb**, never an in-process submit. Why: byte-identical file, same
  routing code, same bot/ambient identity handling as the skill, output in the existing command
  view.
- **The trigger for a draft is a fence, not a tool.** Why: mirrors the planner's existing
  `junco-ticket` contract, keeps the session's tool set untouched, and "make a ticket for that"
  works as prose.
- **Implementation happens in a worktree** (`claude -w` / `.claude/worktrees/` or
  `worktrees-manual/`, never `worktrees/`); the main checkout stays parked on `main` for the
  daemon.

## Non-goals (v1)

- A headless `junco chat` REPL. The SSE client makes it cheap later; not now.
- Multiple named sessions per repo.
- A real-SDK e2e in the suite. The spike is the manual evidence; a gated integration test in
  the style of `sandbox.integration.test.ts` is a follow-up.
- Chat reading queue state ("how did that ticket go?"). The transcript records the dispatch;
  the model isn't given a tool to poll it.
- WebSocket transport, or exposing `/chat/*` beyond loopback.
- Widening the read-only tool set, per-session or globally.
- Injecting repository context (README, `git log`) into the prompt. The model has `read`.

---

## 1. Data tree and records (`src/dataTree.ts`, `src/agent/transcriptSchema.ts`)

### 1.1 Layout

Two new layout keys. Both are **materialized eagerly by `ensureDataTree`** (the module's
eager-tree invariant: on bwrap a deny whose target does not exist is skipped, so a lazily-created
denied dir would be a real hole), and both join `flatToV2Pairs` in `dataMigrate.ts` so a flat tree
that already holds chats migrates them:

| key          | v2                 | flat          | `ensureDataTree` makes                             |
| ------------ | ------------------ | ------------- | -------------------------------------------------- |
| `chats`      | `data/chats`       | `chats`       | `<chats>`                                          |
| `chatDrafts` | `data/chat-drafts` | `chat-drafts` | `<chatDrafts>/submitted`, `<chatDrafts>/discarded` |

Per session, under `<chats>/<slug>/`:

```
meta.json          ChatMeta (below)
transcript.jsonl   junco records + raw SDK events — the SSE source and the viewer's input
<sdk session file> written by SessionManager.create(cwd, thisDir); its path is kept in meta.json
corrupt-<ts>/      an SDK session file that failed to open, moved aside (§11)
```

`<chats>/_archive/<slug>-<ts>/` receives a whole session dir on `/new`. `<chatDrafts>/` is a
`makeReviewStore` dir with `submitted/` and `discarded/` archive subdirs.

`sandboxDenyPaths` gains `chats` and `chatDrafts`: the agent must never read its own session
store or the parked drafts.

### 1.2 Repo key and slug

The **key** is the rail's existing selection key: `nwo.toLowerCase()` for a watched repo, the
resolved checkout path for a local-only row. Clients always send the key; the daemon derives the
**slug** (one function, `chatSlug(key)` in `src/chat/chatKey.ts`):

- watched: `owner__repo` (lowercase, `/` → `__`)
- local: `local-<basename>-<sha1(path).slice(0, 8)>`

The prefixes cannot collide. `meta.json` stores the key, so a slug is never parsed back.

```ts
interface ChatMeta {
  key: string; // rail key
  kind: "watched" | "local";
  cwd: string; // resolved at creation (§2.2); re-resolved on open, updated if moved
  sdkSessionFile: string; // SessionManager.getSessionFile()
  createdAt: string; // ISO
}
```

### 1.3 Records

Additive to `JuncoRecord`; `parseTranscriptLine` already forward-tolerates unknown `junco_*`
types, and `TRANSCRIPT_VERSION` stays 2. A chat transcript opens with the existing `junco_meta`
(`ticketId` = the slug). `"chat"` joins `FlowKind`.

```ts
interface ChatPromptRecord {
  type: "junco_chat_prompt";
  text: string;
  mode: "prompt" | "steer"; // steer = arrived while a turn was streaming
  source: "operator" | "auto_lint"; // auto_lint = the one automatic lint follow-up (§6.3)
  ts: string;
}
interface ChatTurnStartRecord {
  type: "junco_chat_turn_start";
  modelId: string;
  tools: string[];
  timeoutMs: number;
  ts: string;
}
interface ChatTurnEndRecord {
  type: "junco_chat_turn_end";
  status: "ok" | "error";
  errorClass: ProviderFailureClass | null;
  errorMessage: string | null;
  usage: Usage;
  durationMs: number;
  ts: string;
}
interface ChatTurnAbortedRecord {
  type: "junco_chat_turn_aborted";
  reason: "timeout" | "operator" | "daemon_stopped" | "crash";
  ts: string;
}
interface ChatTurnRejectedRecord {
  type: "junco_chat_turn_rejected";
  reason: string; // gate.status().reason or the budget line
  until: string | null; // ISO, from GateStatus.until
  ts: string;
}
interface ChatDraftRecord {
  type: "junco_chat_draft";
  draftId: string;
  kind: DraftKind; // §6.1
  status: "parked" | "lint_failed" | "submitted" | "discarded";
  ids: string[]; // ticket ids / audit-investigate ids once known
  destination: "inbox" | "issue" | "command" | null; // null until submitted
  ts: string;
}
interface ChatSessionResetRecord {
  type: "junco_chat_session_reset";
  reason: "corrupt" | "missing" | "operator_new";
  ts: string;
}
interface ChatTranscriptDegradedRecord {
  type: "junco_chat_transcript_degraded";
  ts: string;
}
```

SDK events pass through as today (`message_start`, `message_end`, `turn_start`, `turn_end`,
`tool_execution_*`, `agent_*`, `compaction_start`, `compaction_end`) — with one deliberate
exception that `runAgent` already makes: **`message_update` is never written to the file.** It
is fanned out live on the record bus (§5.2) so the pane streams token by token, but the
persisted transcript records turns, tools, and results, exactly as ticket transcripts do; a
reconnecting client rebuilds the text from `turn_end`'s full assistant message. This keeps the
file small and keeps `summarizeTranscript` unchanged in what it reads.

The chat transcript is written **regardless of `transcriptsEnabled`**: it is the session's
replay log and the SSE source, not optional observability.

**Viewer awareness.** `summarizeTranscript` and `renderTranscriptRows` (the transcript
viewer's pure core) learn the chat records so the dashboard pane and `junco transcript --chat`
share one renderer: `junco_chat_turn_start`/`_end`/`_aborted` frame a run exactly as
`junco_run_start`/`_end` do (`RunSummary.flow === "chat"`), `junco_chat_prompt` becomes
`RunSummary.prompt: string | null` (rendered as a `you:` row ahead of the run), and the
remaining `junco_chat_*` records become `RunSummary.notes: ChatNote[]` rendered as one row
each — a `junco_chat_draft` note carries `anchor: "draft:<draftId>"` so the cursor can land on
it. Every existing ticket transcript renders byte-identically (`prompt` null, `notes` empty).

---

## 2. Session ownership (`src/chat/chatManager.ts`, `src/chat/chatSession.ts`, `src/agent/session.ts`)

### 2.1 `SessionOverrides.sessionManager`

`makePiSessionFactory` gains one optional override:

```ts
export interface SessionOverrides {
  tools?: string[];
  thinkingLevel?: ThinkingLevel | string;
  network?: boolean;
  /** Chat: a file-backed SessionManager (create/open under the junco chat dir).
   *  Absent → SessionManager.inMemory(cwd), unchanged for every other caller. */
  sessionManager?: unknown; // SDK type at the boundary; opaque to callers
}
```

The factory passes it through to `createAgentSession` in place of `SessionManager.inMemory(cwd)`.
The runtime `await import` stays inside `session.ts`; `chatManager` receives a
`makeSessionManager: (mode: {create: cwd, dir} | {open: path, dir}) => Promise<{manager:
unknown; file: string}>` dep that `session.ts` exports (the doctor/wizard-helper precedent for a
second SDK-touching helper in that file), `file` being `getSessionFile()`.

**The seam widens by extension, not mutation.** `AgentSessionLike` stays as it is (every
existing fake keeps compiling). `session.ts` adds

```ts
export interface ChatSessionLike extends AgentSessionLike {
  steer(text: string): Promise<void>;
  readonly isStreaming: boolean;
  readonly isIdle: boolean;
  readonly messages: unknown[];
}
export function makeChatSessionFactory(
  cfg: Config,
  cwd: string,
  overrides: SessionOverrides,
): () => Promise<ChatSessionLike>;
```

`makeChatSessionFactory` runs the same build as `makePiSessionFactory` and returns the SDK
session, which structurally satisfies the wider type — the cast lives at the SDK boundary only.

### 2.2 cwd resolution (`src/chat/chatCwd.ts`)

`resolveChatCwd(cfg, key, deps)` — every watched entry already carries a `path`
(`GithubRepoMapping.path`: the managed clone or the operator's checkout), so there are two
branches, not three:

1. Watched key (contains `/`) → the entry from `resolveWatchedReposForPrs(cfg)` (the
   `external:true` fork entries included — chat is read-only, so the bridge's poll-injection
   exclusion does not apply) whose `nwo.toLowerCase()` matches; its `path` must exist on disk,
   else `{error: "no_checkout"}` (HTTP 409; the pane offers the existing clone action). An
   unknown nwo is `{error: "unknown_key"}` (404).
2. Local key (absolute path) → the path itself, after: it exists, `git rev-parse
--show-toplevel` (via the injectable `gitFn`) resolves to it, and its realpath is not under
   `dataDir`. Otherwise `{error: "not_a_repo"}` (409).

The result is stored in `meta.json`; re-resolved on every open so a moved clone is picked up.

### 2.3 `ChatSession`

One object per slug, created lazily by `ChatManager.get(key)` on the first attach or prompt
after daemon start:

- `meta.json` absent → `SessionManager.create(cwd, dir)`, write meta, write `junco_meta`.
- present → `SessionManager.open(meta.sdkSessionFile, dir, cwd)`; on any throw, move the file to
  `corrupt-<ts>/`, create fresh, append `junco_chat_session_reset{reason}`.
- Then the crash stamp (§11): if the transcript's last turn record is `junco_chat_turn_start`
  with no `_end`/`_aborted` after it, append `junco_chat_turn_aborted{reason:"crash"}`.
- The `AgentSession` itself is built through `makePiSessionFactory(chatCfg, cwd, {tools,
thinkingLevel: chat.thinkingLevel ?? model.thinkingLevel, sessionManager})` where
  `chatCfg = {...cfg, model: {...cfg.model, id: chat.modelId ?? github.plannerModelId ??
model.id}, tools: READ_ONLY_TOOLS ∩ cfg.tools}`.

`ChatSession` owns: the SDK session, the transcript sink (`defaultTranscriptSink` on
`transcript.jsonl`, append), an in-memory **record bus** (§5.2), the current turn (if any), and
`subscribers: Set<(line: string) => void>`.

### 2.4 Lifecycle in the daemon

`ChatManager` is constructed in `mainLoop` after the health server's dependencies exist and is
passed to `startHealthServer` as `chat` (§5). It is idle-cost-free: no timers, no sessions until
used. On `StopFlag.requested` it is drained **before** the health server closes: every
streaming turn is `abort()`ed, `junco_chat_turn_aborted{reason:"daemon_stopped"}` is written,
every subscriber gets the SSE terminal event, sessions are `dispose()`d, sinks ended. A second
signal force-stops as today.

`/new` (`POST /chat/new`) aborts any turn, disposes, moves `<slug>/` to
`_archive/<slug>-<ts>/`, and the next prompt creates fresh. Drafts are untouched.

---

## 3. The turn (`src/chat/chatTurn.ts`)

`runChatTurn(session, text, opts)` mirrors `runAgent`'s subscribe → prompt → settle shape with
**no `GuardManager`**. The human is the supervisor; `steer()` is the nudge.

- If `session.isStreaming` → `session.steer(text)`; record `mode:"steer"`; return (the running
  turn's completion covers it). Else → `session.prompt(text)`; record `mode:"prompt"` and
  `junco_chat_turn_start`.
- Every SDK event goes to the bus; every event except `message_update` goes to the sink (§1.3).
  A fresh `RunAccumulator` (`agent/runResult.ts`) observes the turn: it sums usage on
  `turn_end`, banks `errorMessage`, and its `allText`/`finalText` is what the fence scan reads.
- Completion is `agent_settled` (or the `prompt()` promise resolving, whichever is later —
  the SDK resolves `prompt()` after the loop finishes; `agent_settled` also covers queued
  follow-ups).
- Timeout: `chat.turnTimeoutMinutes ?? worker.defaultTimeoutMinutes`, per turn. On expiry →
  `session.abort()` (soft), `junco_chat_turn_aborted{reason:"timeout"}`. Operator abort → the
  same with `"operator"`. The `ABORT_GRACE_MS`-style settle wait from `runAgent` applies.
- On settle → `junco_chat_turn_end{status:"ok", usage, durationMs}` → `spend.recordUsd(usage.costUsd)`
  (in-process; the ledger keeps one writer) → the manager's own counters (§4).
- On a thrown provider error → `classifyProviderFailure(message)`; if the class is in
  `GATE_CLASSES` → `gate.reportFailure(cls, message)` (symmetric with `runOnce`);
  `junco_chat_turn_end{status:"error", errorClass, errorMessage}`.
- After settle, the assistant message is scanned for fences (§6). This runs **after**
  `junco_chat_turn_end` is written so a draft record always follows its turn's end record.

---

## 4. Gates, spend, metrics (`src/daemon.ts`, `src/metrics.ts`, `src/healthServer.ts`)

**Pre-turn gate check** (`ChatManager.prompt`): the same two steps `gatedReady` runs — if
`dailyBudgetUsd > 0 && spend.todayUsd() >= dailyBudgetUsd` → `gate.reportBudgetExhausted(...)`;
then `gate.claimBlockReason()`. A block → no model call, `junco_chat_turn_rejected{reason,
until}`, HTTP 200 (the rejection is a record, not an error — the stream delivers it). The daemon
hands `ChatManager` the same `gate`, `spend`, and `activeCfg()` closures the poll loop uses.

**Metrics** live on the `ChatManager`, not on `RunMetrics`: `MetricsSnapshot` is a literal in
ten test fixtures, and the `gate`/`spend` precedent already exists for a sibling key on the
`/health` body that an older daemon simply omits. `startHealthServer` gains
`chatStatus?: () => ChatHealth` (beside `gateStatus`/`spendStatus`); `/health` surfaces it as
`chats`, and `HealthBody.chats?: ChatHealth | null`:

```ts
interface ChatStatus {
  key: string;
  slug: string;
  streaming: boolean;
  turns: number; // this daemon lifetime
  lastActivityAt: string | null;
  draftsParked: number; // from the draft store
}
interface ChatHealth {
  enabled: boolean;
  sessions: ChatStatus[];
  turns: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}
```

`totalCostUsd` keeps meaning "tickets".

---

## 5. Transport (`src/chat/chatRoutes.ts`, `src/healthServer.ts`)

### 5.1 Routes

`startHealthServer` takes an optional `chat?: ChatRoutes` — an injected handler object, so the
server stays decoupled from `ChatManager` and tests can pass a fake. All routes are under
`/chat/`; JSON bodies; keys URL-encoded in query strings.

| route                          | body / query                     | response                                                                  |
| ------------------------------ | -------------------------------- | ------------------------------------------------------------------------- |
| `GET /chat/events?key=&since=` | `since` = byte offset (optional) | `text/event-stream`; replay from `since` (or `Last-Event-ID`), then live  |
| `POST /chat/prompt`            | `{key, text}`                    | `202 {mode:"prompt"\|"steer"}`; `200` when gate-rejected (record emitted) |
| `POST /chat/abort`             | `{key}`                          | `202` / `204` if idle                                                     |
| `POST /chat/new`               | `{key}`                          | `202`                                                                     |
| `POST /chat/note`              | `{key, record: ChatDraftRecord}` | `202`; server stamps `ts`, appends to the transcript (§6.6)               |
| `GET /chat/status?key=`        |                                  | `ChatStatus` (also in `/health.chats`)                                    |

Errors: `403` non-loopback or `Origin` present (§5.3); `404` key unknown to the watchlist and
not a local path the client could name; `409 {error:"no_checkout"|"not_a_repo"}` (§2.2);
`503 {error:"chat_disabled"}` when `chat.enabled` is false; `413` text > 64 KiB; `400`
malformed body.

### 5.2 The stream

Each SSE event is one transcript line: `id: <byte offset immediately after the line's newline>`
and `data: <the JSON line>`. An id is therefore "where the next line starts", so `since` (or
`Last-Event-ID`) is simply the offset to resume reading at: absent or `0` replays from the
beginning, and echoing the last id received resumes exactly after it. On connect the route
seeks `transcript.jsonl` to that offset, emits complete lines only (a torn tail is held until
its newline arrives), then attaches to the
session's **record bus** — the in-memory fan-out `ChatSession` writes to at the same moment it
writes the sink. Bus-only events (`message_update`, §1.3) are sent with `data:` and **no `id:`
line**, so `Last-Event-ID` always names a persisted line. Fan-out supports N subscribers (two
dashboards). A `: ping` comment goes out every 15 s. Terminal events: `event: end` with
`data: {reason:"daemon_stopped"|"session_reset"}`.

If the sink is dead (`defaultTranscriptSink`'s degrade path), live delivery continues from the
bus and a `junco_chat_transcript_degraded` record is emitted once; replay after a reconnect
will be incomplete and the header says so.

### 5.3 Auth boundary

`/chat/*` is **loopback-only regardless of `healthHost`**: the route checks an injected
`isLoopback(req)` predicate (default: `req.socket.remoteAddress ∈ {127.0.0.1, ::1,
::ffff:127.0.0.1}`) and returns `403` otherwise. Any request carrying an `Origin` header is
`403` — browsers always send it cross-origin, the TUI never does, which closes the
localhost-CSRF door without a token. `/live`, `/ready`, `/health` are unchanged.

---

## 6. Drafts (`src/chat/fenceExtract.ts`, `src/chat/draftStore.ts`, `src/chat/chatPrompt.ts`)

### 6.1 Detection and kinds

After each completed turn, the final assistant message's text is scanned for fenced blocks
tagged `junco-ticket` (the planner's `PLAN_FENCE`) and `junco-plan`. Kind is derived
deterministically:

| kind          | recognized by                                                                    | confirm runs                                                         |
| ------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ticket`      | one `junco-ticket` fence                                                         | `junco submit <f>` (or `--as-issue <f>`)                             |
| `amend`       | `amends_pr:` in frontmatter                                                      | `junco submit <f>`                                                   |
| `apply`       | body carries a `junco-patch` fence (`extractPatchBody`)                          | `junco submit <f>`                                                   |
| `audit`       | `audit:` block in frontmatter (legacy `assess:` accepted; canonical wins)        | `junco audit <repo\|nwo\|nwo#N> [--auto-plan]` (args from the fence) |
| `investigate` | `investigate:` block in frontmatter (legacy `analyze:` accepted; canonical wins) | `junco investigate <nwo>#<investigate.issue>`                        |
| `ticketSet`   | ≥ 2 `junco-ticket` fences in one message                                         | `junco submit <f_i>` for each, document order                        |
| `planSet`     | one `junco-plan` fence                                                           | `junco submit --plan <f> --repo <cwd>` (or `--as-issue --plan …`)    |

Precedence within a `junco-ticket` fence: `audit` > `investigate` > `amend` > `apply` > `ticket`.
The CLI verbs and canonical frontmatter keys follow #389 (`junco audit`/`junco investigate`;
`audit:`/`investigate:` canonical, `assess:`/`analyze:` legacy — `parseTicket` accepts both and
the canonical key wins on a collision). New identifiers in this feature use the canonical names.
Wrapping an existing plan is `ticket` with the body verbatim — a prompt rule, not a kind.
`planSet` parks with `blocked: "plan_sets_disabled"` when `planSets.enabled` is false. A message
with both a `junco-plan` fence and `junco-ticket` fences parks two drafts.

**Frontmatter allowlist — the planner's security boundary, kept.** The GitHub planner emits a
ticket _body only_ because "model output can never set `repo:`/`workdir:`/`tools:`/`network:`"
(`planPrompt.ts`). Chat needs model-authored frontmatter to express kinds, so the boundary
moves from "none" to "an allowlist": `fenceExtract` parses the fence's frontmatter and keeps
only `id`, `pr_title`, `branch_name`, `base_branch`, `priority`, `labels`, `reviewers`, `draft`,
`depends_on`, `amends_pr`, `timeout_minutes`, `github_request`, `audit`, `investigate`, and the
legacy `assess`, `analyze`. Junco
sets `repo:` itself from the session (`nwo` for a watched repo, `cwd` for a local one) and
**drops** everything else — `tools`, `network`, `workdir`, `push_remote`, `not_before`,
`retry_count`, `deps_satisfied`, `plan`, and any unknown key — recording the dropped names as
`DraftFile.droppedKeys` so the card shows them. An operator who wants one of those adds it in
`e` edit, which is operator-authored input. The prompt tells the model the allowlist.

### 6.2 `PendingDraft` and the store

```ts
type DraftKind = "ticket" | "amend" | "apply" | "audit" | "investigate" | "ticketSet" | "planSet";

interface DraftFile {
  name: string; // <ticket id>.md, or plan.md for planSet
  content: string; // byte-identical to what lint saw (allowlisted frontmatter + repo: + body)
  lint: LintViolation[]; // lintTicket(...).violations — for planSet, the compiler's parse errors as error rows
  route: RouteDecision | null; // decideRoute(...) — null for audit/investigate (command route)
  droppedKeys: string[]; // model frontmatter keys removed by the allowlist (§6.1)
}

interface PendingDraft {
  id: string; // <slug>-<yyyymmdd-hhmmss>-<n>
  key: string;
  slug: string;
  kind: DraftKind;
  files: DraftFile[];
  cwd: string; // for --repo and lint's repoPath
  nwo: string | null;
  createdAt: string;
  lintFailed: boolean;
  blocked: string | null; // "plan_sets_disabled"
  routeOverride: "auto" | "inbox" | "issue";
  commandArgs: string[] | null; // audit/investigate: the verb's argv, derived at park time
}
```

`draftStore = makeReviewStore<PendingDraft>(["id","key","slug","kind","files","cwd",
"createdAt","lintFailed","routeOverride"])` over `<chatDrafts>/`. Files are written as
`<chatDrafts>/<draftId>/<name>` next to the JSON so confirm can hand the CLI a path.

Parking runs, per file: `parseTicket(name, content, cfg.defaultTimeoutMinutes)` →
`lintTicket(body, frontmatter, {repoPath: cwd, repoNwo: nwo, checkLabels: false})` →
`decideRoute(cfg, frontmatter)`. For `ticketSet`, every fence must carry `id:`; `depends_on`
entries naming a non-sibling id produce a **warning** (submit's own behavior), never a block.
For `planSet`, `parsePlanSet(fenceBody, {maxTasks})` is the lint.

`commandArgs` is derived at park time for the command kinds and stored so confirm never
re-reads the fence: `audit` → `["audit", <repo:> + (audit.issue ? "#" + issue : ""),
...(audit.auto_plan ? ["--auto-plan"] : [])]`; `investigate` → `["investigate", <repo:> + "#" +
investigate.issue]` (the block is read from the canonical key, else the legacy one). A missing
`repo:` or `investigate.issue` is a lint error for that file.

### 6.3 Lint failure loops once

Parse or lint errors are formatted with `formatViolations` and fed back **once** as an automatic
follow-up prompt (`source:"auto_lint"`), the loop the skill prescribes for agents. If the
re-emitted draft still fails, it parks with `lintFailed: true`; confirm is disabled, edit is
available. The first failed draft is discarded (not archived) when its retry parks.

### 6.4 Routing is the operator's

The card and the review row show `RouteDecision` verbatim (`destination`, `reasons`,
`carried:`, `would discard:`). `r` cycles `routeOverride` `auto → inbox → issue → auto`. On
confirm, `issue` adds `--as-issue`; `inbox` submits plain; `auto` follows the verdict. A forced
issue the CLI refuses surfaces the refusal in the command view; the draft stays parked. For
`ticketSet`, the override applies per file, submissions run in order, and the first non-zero
exit stops the sequence with the earlier results reported.

### 6.5 Prompt (`src/chat/chatPrompt.ts`)

`buildChatPrompt({cwd, nwo|null, planSetsEnabled})` returns the system prompt:

1. A chat framing block (read-only session; you are talking to the operator of a task queue;
   drafting rules below; never claim to have run or submitted anything).
2. `buildPlannerPrompt(...)`'s TEMPLATE.md-backed authoring contract (single source of truth).
3. An addendum lifted from `skills/junco-dispatch/SKILL.md` **by section heading at build time**
   (`loadSkillSections(headings)`): "Ticket sets", "Wrapping an existing plan file", "Amend
   mode (follow-up tickets on existing PRs)" and its subsections, "Apply mode (patch
   tickets)" and its subsections, and the "Audit mode (sweep a repo → review → file)" /
   "Investigate mode (deep-read an issue → reviewed comment)" "Inputs to gather" subsections. A
   test asserts each heading exists, so the skill and the chat cannot drift.
4. The fence contract: emit ` ```junco-ticket ` per ticket, ` ```junco-plan ` for a
   plan set (only when enabled), an `audit:`/`investigate:` block for those requests, and the
   rule that a wrapped plan's body is copied verbatim.

### 6.6 Confirm surface

The inline card in the pane and the `ReviewView` row are the same draft. Actions, in both:
`y` confirm (spawns the verb via `runCliCommand`), `e` edit (`$EDITOR` through `useSuspend`,
re-lint and re-route on return, file rewritten in place), `d` discard (`store.remove(...,
"discarded")`), `r` cycle route. On success the draft archives to `submitted/` and
`junco_chat_draft{status:"submitted", ids, destination}` is appended to the transcript through
`POST /chat/note` (§5.1) so the conversation can refer to it. (The TUI performed the submit;
the daemon owns the transcript.)

---

## 7. Dashboard client (`src/tui/chatClient.ts`, `src/tui/ghClient.ts`)

`DashboardClient` gains:

```ts
chat: {
  subscribe(key: string, since: number | null, on: {
    record: (offset: number, line: string) => void;
    status: (s: "connecting" | "live" | "reconnecting" | "down" | "ended") => void;
  }): () => void;                                       // unsubscribe
  prompt(key: string, text: string): Promise<Result<{mode: "prompt"|"steer"}>>;
  abort(key: string): Promise<Result<void>>;
  fresh(key: string): Promise<Result<void>>;            // POST /chat/new
  note(key: string, record: ChatDraftRecord): Promise<Result<void>>;
};
prContext(nwo: string, n: number): Promise<Result<string>>;   // body + reviews + comments, rendered
issueContext(nwo: string, n: number): Promise<Result<string>>;
```

`subscribe` uses the injectable `fetchFn`, reads `response.body` as a stream, parses `id:` /
`data:` / `event:` lines and `: ping` comments, and reconnects with backoff (500 ms → 5 s cap)
sending `Last-Event-ID` = the last offset seen. `down` is reported after the health poll says
the daemon is down or three consecutive reconnects fail. `prContext`/`issueContext` shell to
`gh` like the other dashboard gh actions (ambient identity) and render a compact Markdown block.

---

## 8. Dashboard view (`src/tui/hooks/useChat.ts`, `src/tui/components/ChatView.tsx`, `Composer.tsx`, `viewActions.ts`, `App.tsx`)

### 8.1 Navigation

`View` and `OverlayView` gain `"chat"`. The `chat` verb is a **body verb** of the two repo-row
bodies (`BODY_VERBS.issues` and `BODY_VERBS.repoDetail` in `viewActions.ts`), not a
`MAIN_GLOBAL`: a global would claim `t` ahead of the queue body's `retry`, which owns `t` by a
deliberate earlier fix. As a body verb it derives `t` in both repo bodies (`c`, `h`, `a` are
taken or excluded) and never appears on a system row. The view is full-screen like
`transcript`. The session shown is the current rail row's key; moving the rail selection while
in the view switches the subscription.

### 8.2 Layout

- **Header strip:** key · state (`idle` / `streaming` / `blocked: <reason> until <t>` /
  `daemon down` / `transcript degraded`) · turns · today's chat spend · model.
- **Transcript region:** `TranscriptView`'s row renderers (`transcriptRender.ts`) over the
  record buffer: collapsible tool rows, `t` thinking, `f` follow, `[`/`]` scroll. Draft cards
  render inline at their `junco_chat_draft` record; `j`/`k` walks tool rows and cards alike.
  Compaction shows as one dim row. When the 2000-record ring overflows, the header shows
  `showing last 2000`.
- **Composer:** multiline. `enter` submits. Two newline chords, both deterministic in Ink 7's
  keypress parser (`parse-keypress.js`): alt+enter arrives as `\x1b\r` → `key.return &&
key.meta`; ctrl+j arrives as `\n` → `input === "\n"` with `key.return` false. Both insert a
  newline; the hint line names `ctrl+j` (it needs no terminal option-as-meta setting). A
  leading `/` opens an inline completion list: `/draft`, `/audit`, `/investigate N`, `/pr N`,
  `/issue N`, `/abort`, `/new`.

### 8.3 Focus and keys

While the composer is focused it is the only active `useGuardedInput` handler: App's cascade
checks `view === "chat" && composerFocused` first, and `bindingContext` becomes
`{kind: "structuralOnly", view: "chatCompose"}` (chips: `type`, `enter send`, `ctrl+j newline`,
`/ commands`, `esc blur/abort`), so no mnemonic fires from typed prose. `esc` is stateful:
**streaming → abort the turn; idle and focused → blur; blurred → leave the view.**

Blurred, the view's bindings are the `VIEW_OPTIONS.chat` list — every key derived by
`mnemonics.ts` from its label, in this order: `submit` → `s`, `edit` → `e`, `discard`
(guarded) → `D`, `route` → `r`, `thinking` → `t`, `follow` → `f`, `close` (hidden) → `q`.
Structural: `i` (focus composer), `↑/↓`/`j`/`k` (move over tool rows and draft cards),
`enter` (expand), `[`/`]` (scroll), `esc` (leave). The pinned keymap test in
`tests/tuiViewActions.test.ts` gains the `chat` context.

### 8.4 Bracketed paste

Ink 7.1 ships bracketed paste natively: `usePaste(handler, {isActive})` enables mode 2004
while active and delivers a paste as **one string on a separate channel** — "paste content is
never forwarded to `useInput` handlers when `usePaste` is active". `Composer` uses it with
`isActive: focused`; no stdin-pipeline change and no CSI-guard change is needed.

### 8.5 `useChat`

Owns: the record ring (2000, like `useLogTail`), `streaming`, `blocked`, `connection`,
`cards` (derived from `junco_chat_draft` records joined with `draftStore` list via
`DashboardClient`), `composer` text, cursor, follow. `message_update` records coalesce into
state at a 50 ms flush. App passes the nav spine in read-only; the hook is testable through a
Probe component with a fake client.

### 8.6 Ambient signals

The rail row shows a `Badge` (`●` streaming, or a drafts count) from `/health.chats` via the
existing health poll (`HealthInfo` gains `chats: ChatHealth | null`). `HelpModal` lists the
chat bindings.

**`ReviewView`** gains `chatDrafts: PendingDraft[]` as a third list after batches and comment
drafts (combined cursor, `open: {kind: "chatDraft", idx}`), and `VIEW_OPTIONS.review` gains
`submit`, `edit`, `route` **appended after** the existing four so their keys stay pinned
(`a`/`n`/`f`/`D`); the new ones derive `s`/`e`/`r`. `discard` (`D`) already exists and applies.
The same `submitChatDraft`/`editChatDraft`/`cycleChatDraftRoute`/`discardChatDraft` handlers
serve both the pane's card and the review row.

**`$EDITOR`** for `e` runs through `useSuspend`, which needs `SuspendProvider` mounted around
the dashboard `App` (today only `WizardApp` mounts it); `Root.tsx` adds it. The spawn itself
is `AppProps.editFileFn?: (path: string) => Promise<void>` (default: `spawn($EDITOR ?? "vi",
[path], {stdio: "inherit"})`), injectable so tests never open an editor.

---

## 9. CLI and doctor (`src/cli.ts`, `src/transcriptCmd.ts`, `src/statusCmd.ts`, `src/doctor.ts`, `src/unwatchCmd.ts`)

- `junco transcript --chat <key>` renders `<chats>/<slug>/transcript.jsonl` through the
  existing summarize/render core; `junco replay` stays ticket-only.
- `junco status` prints one line per entry in `/health.chats` (`chat owner/repo · streaming ·
3 drafts`).
- `doctor` adds: chat enabled but `healthEnabled` false → warn ("chat requires the health
  server"); `chats` dir writable.
- `planUnwatch` adds `<chats>/<slug>/` and the repo's parked drafts to the deletion plan (kept
  entries listed like the rest).

---

## 10. Config (`src/config.ts`, `tests/helpers/config.ts`)

Additive `chat` block; `null` means inherit:

```ts
chat: {
  enabled: boolean; // default true
  modelId: string | null; // default null → github.plannerModelId ?? model.id
  thinkingLevel: string | null; // default null → model.thinkingLevel
  turnTimeoutMinutes: number | null; // default null → worker.defaultTimeoutMinutes
}
```

`chat.enabled` is a live lever (`configLevers.ts`); the rest read at session creation. The
fields are added to `tests/helpers/config.ts` **as ballast** (`chat: {enabled: true, modelId:
null, thinkingLevel: null, turnTimeoutMinutes: null}`), not as a `ConfigSeams` key: `makeConfig`
has 38 call sites, and no existing test's meaning changes with chat on. The few chat tests that
need it off pass `overrides`. `src/ticketSchema.ts` is untouched.

---

## 11. Error handling

Every failure is a transcript record the pane renders; nothing is a silent state.

- **Provider failure mid-turn** (429, auth, quota, outage, misconfig): classified, reported to
  the gate (symmetric), `junco_chat_turn_end{status:"error"}`. Composer stays enabled; the next
  prompt hits the gate check and gets a `junco_chat_turn_rejected` whose `until` the banner
  shows.
- **Timeout / operator abort / daemon stop / crash:** `junco_chat_turn_aborted{reason}`. The
  first three soft-abort in place; `crash` is stamped on the next open. Caveat recorded here:
  the SDK persists a message only on `message_end`, so an aborted turn's partial text exists in
  junco's transcript but not in the model's history for the next turn.
- **SDK session file missing/corrupt on open:** moved to `corrupt-<ts>/`, fresh session,
  `junco_chat_session_reset{reason}`. Transcript preserved. Never blocks the dashboard.
- **Transcript sink dead:** live SSE continues from the bus; `junco_chat_transcript_degraded`
  emitted once; header shows it.
- **HTTP:** per §5.1. Two subscribers per key are fine; a second `POST /chat/prompt` while a
  steer is already queued queues again (SDK semantics).
- **Draft:** parse/lint error → one automatic follow-up; still failing → `lintFailed`.
  Confirm's CLI non-zero → command view, draft stays parked. `/pr`/`/issue` fetch failure →
  toast, nothing injected. `POST /chat/note` failure after a successful submit → toast; the
  draft is still archived (the submit happened).
- **Spend:** non-finite `costUsd` → the ledger's existing warn-and-drop path.

---

## 12. Testing

The suite stays network-free and model-free; every side effect is behind a seam that already
exists or is introduced in this spec.

- **`tests/helpers/fakeSession.ts`** gains `fakeChatSession(script)`: implements the widened
  seam (`steer`, `isIdle`, `isStreaming`, `messages`) and emits a scripted event list per
  prompt, including `message_update`, `message_end` with usage, `tool_execution_*`,
  `compaction_*`, `agent_settled`. `throwingSession` is reused for provider failures.
- **`chatKey`/`chatCwd`:** slug derivation (watched, local, collision-free); cwd resolution
  three branches + both 409 errors, with an injected `gitFn`/`existsFn`.
- **`chatManager`** on a tmp data tree: lazy create, open with rehydration, corrupt-file reset,
  crash stamp, drain writes `daemon_stopped` and ends subscribers, `/new` archives, exactly one
  `recordUsd` per turn, budget and provider gate rejections with a fake gate, symmetric
  `reportFailure` via `throwingSession`, timeout abort, steer vs prompt.
- **`fenceExtract`:** table-driven over fixtures for all seven kinds, precedence within a
  fence, two-fence-language messages, `ticketSet` sibling `depends_on` warning, `planSet`
  blocked when disabled.
- **`draftStore`/parking:** required-field list, archive subdirs, files written beside the
  JSON, lint/route attached, the single auto-lint retry, `lintFailed` on the second failure.
- **`chatPrompt`:** every lifted heading exists in the packaged `SKILL.md`; the fence contract
  block is present; `planSet` instruction absent when disabled.
- **SSE routes** in `tests/healthServer.test.ts`'s `port: 0` + real `fetch` style: replay from
  `since` and from `Last-Event-ID`, torn-tail hold, live fan-out to two subscribers, `: ping`,
  `event: end` on drain, 202/200/204/404/409/413/503 contracts, `Origin` → 403, and both
  branches of the injected `isLoopback`.
- **`parseTranscriptLine`:** every `junco_chat_*` record classifies as `junco`; version
  unchanged. **`summarizeTranscript`/`renderTranscriptRows`:** chat turn records frame runs
  with `flow: "chat"`, `prompt` and `notes` populate, a draft note carries its anchor, and
  every existing ticket-transcript fixture renders byte-identically.
- **`chatClient`:** SSE parser over a scripted `ReadableStream` (no server): ids, id-less
  events, multi-line data, comments, partial chunks; reconnect sends `Last-Event-ID`; `down`
  after three failures.
- **TUI:** `useChat` through a Probe with a fake client (coalescing, ring overflow, cards
  derivation, status); `Composer` (multiline via `\x1b\r` and `\n`, submit on `\r`, slash
  list, a paste delivered through Ink's paste channel lands as one insertion); App — the view
  opens from a repo row via `t` and the verb is absent on system rows, a focused composer
  swallows every mnemonic, the `esc` state machine, rail switch re-subscribes, each card action
  spawns the right verb through a fake `runCliFn`, `ReviewView` lists chat drafts, `e` calls
  the injected `editFileFn`. Every keystroke gated on `until()` (the Ink stdin batching trap);
  loop-until-condition, never a fixed tick.
- **Drift guards:** `dataTree` has `chats`/`chatDrafts` in both layouts, `ensureDataTree`
  materializes them, `flatToV2Pairs` moves them; `sandboxDenyPaths` includes both;
  `planUnwatch` includes the chat dir and drafts; `FlowKind` includes `"chat"`; new `Config`
  fields appear in `tests/helpers/config.ts` only; the pinned keymap test covers the `chat`
  view, the `chatCompose` structural context, and the review view's three appended verbs.
- **Coverage floor** (`vitest.config.ts`) must not drop.

---

## 13. Documentation

- `ARCHITECTURE.md`: a "Chat" subsection after "The Q&A path" (process model, gates, records,
  transport, auth boundary), `chat/` in the module map, `chats`/`chat-drafts` in the data tree
  description, the `/chat/*` routes under Health endpoints.
- `README.md`: a short "Chat with the agent" section (open from a repo row; drafts park for
  review; every dispatch branch reachable; loopback-only).
- `CHANGELOG.md` Unreleased: `feat(tui): per-repo chat with the agent; drafts every dispatch
branch for review`.
- `skills/junco-dispatch/SKILL.md`: one paragraph noting the dashboard chat consumes the
  authoring sections by heading (so a heading rename is a contract change).
- `CLAUDE.md`: one line — "`/chat/*` routes are loopback-only by construction; the health
  server's `host` never widens them."

## Implementation notes

- Worktree: `.claude/worktrees/dashboard-chat`, branch `feat/dashboard-chat`, based on
  `origin/main` @ `09cb4d5`. Merge `origin/main` between plan tasks.
- Natural task ordering: records + data tree → config → `ChatSessionLike` +
  `SessionOverrides.sessionManager` + `makeSessionManager` → `chatKey`/`chatCwd` → `chatTurn`
  → `chatSession` → `chatManager` (+ daemon wiring, gates, spend) → routes + auth → fence
  extraction → draft store + parking → prompt → transcript viewer awareness → client →
  `useChat` → `Composer` → `ChatView` + App wiring → `ReviewView` + editor → CLI/doctor/unwatch
  → docs. Every task lands with a failing test first and a commit; the suite is green at every
  commit.
