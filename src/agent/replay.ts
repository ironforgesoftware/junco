/**
 * replay — re-runs a recorded per-ticket JSONL transcript through a fresh
 * GuardManager and reports what the guards WOULD decide today.
 *
 * The point is what-if analysis: "would this ticket still have been killed
 * under budgetPerKind=2?" A transcript is the only durable record of a run's
 * event stream, so replay is how a supervisor-policy change gets evidence
 * before it ships.
 *
 * Pure by design — no fs, no Pi SDK. The caller supplies the lines (the CLI
 * reads the file) and the guard options (the CLI resolves policy precedence);
 * this module only reduces lines → decisions.
 *
 * Fidelity boundaries, all of them structural (see `caveats` on the report):
 *   - Transcripts do not contain `message_update` deltas (session.ts:261 skips
 *     them), so rep-guard input is synthesized from each `message_end`'s
 *     content blocks — ONE delta per block. A live mid-stream trip fires
 *     partway through a message; replay's fires at the end of it, and a
 *     post-nudge re-trip needs fresh text the recorded stream cannot supply.
 *   - Everything after a decision is a what-if trajectory: a replayed nudge is
 *     never injected, so the recorded events that follow are the model's
 *     reaction to the ORIGINAL decision (or to none at all).
 *   - An unframed run — a v1 transcript, or the pre-v2 prefix of a file
 *     appended to after the upgrade — has no `junco_run_start`, so its
 *     boundaries are inferred from `agent_end`.
 */
import { GuardManager, type GuardDecision, type GuardManagerOptions } from "./guardManager.js";
import {
  parseTranscriptLine,
  type GuardDecisionRecord,
  type RunEndRecord,
  type RunStartRecord,
} from "./transcriptSchema.js";

export interface ReplayedDecision {
  decision: GuardDecision;
  /** Index into the `lines` array of the event that produced the decision. */
  lineIndex: number;
  runIndex: number;
}

export interface ReplayRun {
  index: number;
  /** v2 only — a v1 transcript has no run framing. */
  start?: RunStartRecord;
  /** v2 only. */
  end?: RunEndRecord;
  /** `junco_guard_decision` records as the live run wrote them. */
  recorded: GuardDecisionRecord[];
  /** What this replay's GuardManager decided. */
  replayed: ReplayedDecision[];
  /** A replayed kill fired, so the rest of the run's events were not fed. */
  stoppedAtKill: boolean;
}

export interface ReplayReport {
  /** 2 iff any `junco_run_start` is present — `junco_meta` is informational. */
  version: 1 | 2;
  runs: ReplayRun[];
  invalidLines: number;
  caveats: string[];
  /** Per run, recorded[] and replayed[] agree pairwise on (action, kind, turnIndex). */
  identical: boolean;
}

export interface ReplayOptions {
  /** Applied fresh to EVERY run; recorded per-run guard configs are not used. */
  guard: GuardManagerOptions;
}

const CAVEAT_REP_GRANULARITY =
  "rep-guard replay is message-granular; live mid-stream trips and post-nudge re-trips may differ";
const CAVEAT_WHAT_IF =
  "post-decision trajectories are what-if only — a replayed nudge cannot simulate the model's reaction";
const CAVEAT_V1_BOUNDARIES = "v1 transcript: run boundaries inferred from agent_end";

/** The live run's state, rebuilt per run boundary. */
interface ActiveRun {
  run: ReplayRun;
  gm: GuardManager;
  /** Mirrors session.ts:271-273 — once a kill is decided, stop feeding the guard. */
  killed: boolean;
}

type SynthesizedDelta = { type: "text_delta" | "thinking_delta"; delta: string };

/**
 * The `message_update` delta a recorded content block stands in for. Unknown
 * block types (images, tool_use, …) carry no rep-guard input: skip them.
 */
function deltaForBlock(block: unknown): SynthesizedDelta | null {
  const b = block as { type?: string; text?: string; thinking?: string } | null | undefined;
  if (b?.type === "text" && typeof b.text === "string") {
    return { type: "text_delta", delta: b.text };
  }
  if (b?.type === "thinking" && typeof b.thinking === "string") {
    return { type: "thinking_delta", delta: b.thinking };
  }
  return null;
}

/**
 * Replay `lines` (one JSONL transcript record each) against a fresh
 * GuardManager per run.
 */
export function replayTranscript(lines: string[], opts: ReplayOptions): ReplayReport {
  const parsed = lines.map(parseTranscriptLine);
  // Version keys on run_start presence, never on junco_meta: a pre-v2 file
  // appended to after the upgrade carries run records with no header.
  const version: 1 | 2 = parsed.some(
    (p) => p.kind === "junco" && p.record.type === "junco_run_start",
  )
    ? 2
    : 1;

  const runs: ReplayRun[] = [];
  let invalidLines = 0;
  let active: ActiveRun | null = null;

  const openRun = (start?: RunStartRecord): ActiveRun => {
    const run: ReplayRun = {
      index: runs.length,
      start,
      recorded: [],
      replayed: [],
      stoppedAtKill: false,
    };
    runs.push(run);
    // Ruling: the guard is built from `opts` for every run — the recorded
    // per-run `guard` config is reference data the CLI reconciles, not input.
    return { run, gm: new GuardManager(opts.guard), killed: false };
  };

  const record = (a: ActiveRun, decision: GuardDecision, lineIndex: number): void => {
    a.run.replayed.push({ decision, lineIndex, runIndex: a.run.index });
    if (decision.action === "kill") {
      a.killed = true;
      a.run.stoppedAtKill = true;
    }
  };

  for (const [i, p] of parsed.entries()) {
    if (p.kind === "invalid") {
      // A blank line is the file's trailing newline, not a truncated record.
      if (p.raw.trim() !== "") invalidLines++;
      continue;
    }
    if (p.kind === "junco") {
      switch (p.record.type) {
        case "junco_run_start":
          active = openRun(p.record);
          break;
        case "junco_run_end":
          // Does not close the run: run_start opens the next one, and a stray
          // trailing event still belongs to the run that produced it.
          if (active) active.run.end = p.record;
          break;
        case "junco_guard_decision":
          // Collected even past a kill (it is the live record, not an input)
          // and never fed to the GuardManager.
          if (!active) active = openRun();
          active.run.recorded.push(p.record);
          break;
        default:
          // junco_meta, plus any junco_* record a newer junco writes.
          break;
      }
      continue;
    }

    const ev = p.event;
    // Boundary for an UNFRAMED run: agent_end ends it, mirroring the live
    // one-GuardManager-per-runAgent-call lifetime. That covers a v1 transcript
    // and the pre-v2 prefix of a file appended to after the upgrade (v2 records
    // with no meta header). A run opened by a junco_run_start ignores agent_end
    // — its own framing is authoritative.
    if (ev.type === "agent_end" && active?.run.start === undefined) {
      active = null;
      continue;
    }
    if (!active) active = openRun();
    if (active.killed) continue;

    if (ev.type === "message_end") {
      // The transcript's stand-in for the deltas it never recorded. Each block
      // goes through the same kill gate: a kill mid-message stops the rest.
      const msg = ev.message as { role?: string; content?: unknown[] } | undefined;
      if (msg?.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const delta = deltaForBlock(block);
          if (!delta) continue;
          const d = active.gm.observe({ type: "message_update", assistantMessageEvent: delta });
          if (d) {
            record(active, d, i);
            if (d.action === "kill") break;
          }
        }
      }
      continue;
    }

    const decision = active.gm.observe(ev);
    if (decision) record(active, decision, i);
  }

  const identical = runs.every(
    (run) =>
      run.recorded.length === run.replayed.length &&
      run.recorded.every((rec, k) => {
        const rep = run.replayed[k].decision;
        return (
          rec.action === rep.action && rec.kind === rep.kind && rec.turnIndex === rep.turnIndex
        );
      }),
  );

  const caveats = [CAVEAT_REP_GRANULARITY, CAVEAT_WHAT_IF];
  if (version === 1) caveats.push(CAVEAT_V1_BOUNDARIES);

  return { version, runs, invalidLines, caveats, identical };
}
