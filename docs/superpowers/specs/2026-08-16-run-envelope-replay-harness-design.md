# Run Envelope + Transcript Replay Harness — Design

Date: 2026-08-16
Status: approved (chat review); plan: `docs/superpowers/plans/2026-08-16-run-envelope-replay-harness.md`

## Motivation

Two ideas borrowed from DeepSeek Harness's session-log architecture, sized for junco:

1. **Run envelope.** Five call sites (runOnce Q&A, assessFlow, analyzeFlow, prFlow main,
   prFlow corrective) hand-copy the same wrapper around `runAgent`: GuardManager
   construction from config, transcript-path resolution, metrics hooks, and immediate
   spend recording. The copies must stay in parity by comment discipline alone
   (see the `#180.3` parity comments in `runOnce.ts`). Collapse them into one module.
2. **Replay harness.** Guards (`guards.ts`) and the Supervisor are pure, event-driven
   reducers. A recorded per-ticket transcript can therefore be re-run through a fresh
   `GuardManager` under a *different* policy to answer "what would this config have done
   on that real failed run?" — turning the live failure archive into a regression corpus
   and a policy-tuning tool (`junco replay`).

## Key finding that shapes the design

The SDK's `message_end` and `turn_end` events carry the full `AgentMessage` (content
blocks included), and the transcript already records every non-delta event. So **existing
v1 transcripts are already replayable for all five guard kinds** — the replay engine
synthesizes one coarse `text_delta`/`thinking_delta` per content block at `message_end`.
No live-path format change is needed for replay (1a). The only new records are for
reconstructability (1b): `junco_meta`, `junco_run_start`, `junco_run_end`.

## Decisions

- **Sink ownership moves to the envelope.** `runAgent` gains `transcript?: TranscriptSink
  | null` (caller-owned, never `end()`ed by runAgent); the legacy
  `transcriptPath`/`transcriptSink` options are removed once all call sites migrate.
  The envelope opens the sink, writes `junco_meta` (file-creation only) and
  `junco_run_start`, runs the agent, writes `junco_run_end`, then closes.
- **Schema v2 is additive.** SDK events are recorded verbatim as today; junco records are
  distinguished by a `junco_` type prefix. `TRANSCRIPT_VERSION = 2`. v1 files (no junco
  meta/run records) remain fully readable; replay falls back to `agent_end` as the
  run boundary (live semantics: a fresh GuardManager per `runAgent` call).
- **Secrets are scrubbed by construction.** `junco_run_start` carries `modelId` (a string),
  never a serialized `cfg.model` (which can hold `apiKey`). An explicit test asserts no
  transcript line ever contains the configured apiKey.
- **Replay is decision-point analysis, not trajectory simulation.** A replayed nudge
  cannot simulate the model's reaction; replay is faithful up to each run's first
  divergent decision, and rep-guard replay is message-granular (trip lands at
  `message_end`, same `turnIndex`, since `turnIndex` only advances on `turn_end`).
  The report states these caveats.
- **Replay stops feeding the GuardManager after a kill decision** until the next run
  boundary — mirroring `session.ts`'s `killReason` gate, so decision streams match live.
- **No new Config fields.** All guard knobs already exist (`supervisorEnabled`,
  `supervisorBudgetPerKind`, `supervisorEscalationWindow`, `supervisorOutputBudgetPerTurn`,
  `supervisorOutputBudgetPostCommit`, `transcriptsEnabled`). CLI policy overrides are
  flags, not config.

## Non-goals (deliberate)

- **Resume/fork (1c)** — separate future spec. This work lays its substrate:
  `junco_run_start` records the exact prompt body + cwd + tools + model id, and
  `message_end` events already persist full messages. The 1c spec must investigate the
  Pi SDK's own session persistence ("saves messages on message_end",
  `agent-session.d.ts:241`) before inventing storage.
- **Delta/chunk recording** — unnecessary (see key finding). Revisit only if a real
  tuning session needs sub-message trip timing.
- **Full outcome-router extraction** — prFlow's routing is interleaved with salvage
  phases; only the shared `isRoutableFailure` predicate (the `!timedOut &&
  !abortedByGuard` parity rule from #180.3) is extracted, as an optional final task.
- **TUI integration for replay** — CLI + `--json` only.

## Module map (new/changed)

| Module | Responsibility |
| --- | --- |
| `src/agent/runEnvelope.ts` | `guardOptionsFromConfig`, `buildGuardManager`, `openTicketTranscript`, `runEnveloped` — the single wrapper every agent run goes through |
| `src/agent/transcriptSchema.ts` | v2 record types + `parseTranscriptLine`; the only place junco record shapes are defined |
| `src/agent/replay.ts` | `replayTranscript(lines, opts)` — pure engine, no fs/SDK |
| `src/replayCmd.ts` | `junco replay <id|path>` CLI: resolve transcript, run engine, render report |
| `src/agent/session.ts` | `runAgent` accepts caller-owned `transcript` sink; legacy path options removed at end of migration |
| `src/runOnce.ts`, `src/assessFlow.ts`, `src/analyzeFlow.ts`, `src/prFlow.ts` | call `runEnveloped` instead of hand-rolled wrappers |
