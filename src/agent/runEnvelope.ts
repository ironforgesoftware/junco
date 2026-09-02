/**
 * runEnvelope — the single wrapper every junco agent run goes through:
 * guard construction, per-ticket transcript framing (`junco_meta` once per
 * file, `junco_run_start`/`junco_run_end` per run), the `runAgent` call, and
 * spend recording. Observability (the transcript writes) is best-effort
 * (#78). Replaces the five formerly hand-copied wrappers (runOnce Q&A,
 * assessFlow, analyzeFlow, prFlow main, prFlow corrective) whose parity used
 * to rest on comments (#180.3).
 */
import { existsSync } from "node:fs";
import type { Config, RunResult } from "../types.js";
import { transcriptPathFor } from "../slug.js";
import { dataTreePaths } from "../dataTree.js";
import { log } from "../logging.js";
import { GuardManager, type GuardManagerOptions, type GuardDecision } from "./guardManager.js";
import {
  defaultTranscriptSink,
  runAgent,
  type AgentSessionLike,
  type TranscriptSink,
  type TranscriptSinkFactory,
} from "./session.js";
import {
  TRANSCRIPT_VERSION,
  type FlowKind,
  type MetaRecord,
  type RunStartRecord,
  type RunEndRecord,
} from "./transcriptSchema.js";

/** The four supervisor knobs, mapped verbatim — one site instead of five. */
export function guardOptionsFromConfig(cfg: Config): GuardManagerOptions {
  return {
    supervisorConfig: {
      budgetPerKind: cfg.supervisorBudgetPerKind,
      escalationWindowTurns: cfg.supervisorEscalationWindow,
    },
    outputBudgetPerTurn: cfg.supervisorOutputBudgetPerTurn,
    outputBudgetPostCommit: cfg.supervisorOutputBudgetPostCommit,
  };
}

export function buildGuardManager(cfg: Config): GuardManager | undefined {
  return cfg.supervisorEnabled ? new GuardManager(guardOptionsFromConfig(cfg)) : undefined;
}

export interface EnvelopeSpec {
  ticketId: string;
  flow: FlowKind;
  body: string;
  cwd: string;
  timeoutMs: number;
}

export interface EnvelopeDeps {
  createSession: () => Promise<AgentSessionLike>;
  abortSignal?: AbortSignal;
  onProgress?: (p: { turns: number; lastTool: string | null; outputTokens: number }) => void;
  onGuardDecision?: (d: GuardDecision) => void;
  spend?: { recordUsd(usd: number): void };
  /** Injectable fs seams (tests); default to real fs. */
  transcriptSink?: TranscriptSinkFactory;
  fileExists?: (path: string) => boolean;
}

/**
 * Opens the per-ticket transcript sink and reports whether the file is new
 * (i.e. whether the `junco_meta` header should be written) — split out from
 * `runEnveloped` so the "new file?" check is a pure, injectable decision
 * rather than baked into the write sequence.
 */
function openTicketTranscript(
  path: string,
  factory: TranscriptSinkFactory,
  fileExists: (p: string) => boolean,
): { sink: TranscriptSink | null; created: boolean } {
  const created = !fileExists(path);
  return { sink: factory(path), created };
}

/**
 * Best-effort transcript write (#78 discipline, mirroring `runAgent`'s
 * observability try/catch in session.ts):
 * a broken sink (a full disk, a closed stream) must NOT throw up through
 * `runEnveloped` and turn a completed/failed run into a rejection the caller
 * never asked for — degrade to a warning instead. Observability must never
 * change the run's outcome. Exported so a non-agent run-shaped writer
 * (applyPatch.ts's agent-less apply frames, Stage 4a) can append its own
 * junco_* records with the same discipline instead of a second try/catch.
 */
export function writeTranscriptRecord(sink: TranscriptSink | null, line: string): void {
  if (!sink) return;
  try {
    sink.write(line);
  } catch (err) {
    log.warn("transcript record write failed; ignoring", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Same best-effort discipline for closing the sink (#78, mirroring session.ts's
 * write-guard discipline for transcript.write — session.ts itself never calls
 * end() on the sink; the caller that opened it owns closing it). Exported for
 * the same reason as writeTranscriptRecord above — applyPatch.ts owns closing
 * the sink it opens via openRunTranscriptSink. */
export function endSink(sink: TranscriptSink | null): void {
  if (!sink) return;
  try {
    sink.end();
  } catch (err) {
    log.warn("transcript sink end() failed; ignoring", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Shared by both run_end write sites (success + catch) — one field list.
 * Exported: applyPatch.ts's agent-less apply frames (Stage 4a) write a
 * junco_run_end too and must use the identical shape/discipline. */
export function writeRunEnd(
  sink: TranscriptSink | null,
  fields: Omit<RunEndRecord, "type" | "ts">,
): void {
  writeTranscriptRecord(
    sink,
    JSON.stringify({
      type: "junco_run_end",
      ts: new Date().toISOString(),
      ...fields,
    } satisfies RunEndRecord) + "\n",
  );
}

/** Injectable fs seams shared by every opener of the per-ticket transcript
 * sink (tests); default to real fs. */
export interface RunTranscriptDeps {
  transcriptSink?: TranscriptSinkFactory;
  fileExists?: (path: string) => boolean;
}

/**
 * Opens the per-ticket transcript sink for `ticketId` and writes the
 * `junco_meta` header exactly once per file — the preamble every run-shaped
 * writer needs before appending its own `junco_run_start`/`junco_run_end`
 * (and, for an agent run, turn/tool frames in between). Extracted out of
 * `runEnveloped` (Stage 4a) so `applyPatchSeries` (src/applyPatch.ts) can
 * reuse the identical "create the file, or append if a prior writer already
 * has" decision instead of a second junco_meta-on-first-write implementation
 * that could drift from this one.
 *
 * Returns null when `cfg.transcriptsEnabled` is false, or when the sink could
 * not be opened (the run continues without a transcript, same as
 * `runEnveloped`'s own handling) — every write/close helper above treats a
 * null sink as a no-op, so callers never need to branch on it themselves.
 */
export function openRunTranscriptSink(
  cfg: Config,
  ticketId: string,
  deps: RunTranscriptDeps = {},
): TranscriptSink | null {
  if (!cfg.transcriptsEnabled) return null;
  const path = transcriptPathFor(dataTreePaths(cfg).transcripts, ticketId);
  const { sink, created } = openTicketTranscript(
    path,
    deps.transcriptSink ?? defaultTranscriptSink,
    deps.fileExists ?? existsSync,
  );
  if (sink && created) {
    writeTranscriptRecord(
      sink,
      JSON.stringify({
        type: "junco_meta",
        version: TRANSCRIPT_VERSION,
        ticketId,
        createdAt: new Date().toISOString(),
      } satisfies MetaRecord) + "\n",
    );
  }
  return sink;
}

/**
 * The single wrapper every junco agent run goes through: opens/frames the
 * per-ticket transcript (junco_meta on first write, junco_run_start/end
 * bracketing the run), builds the guard manager, calls `runAgent`, and
 * records spend — replacing the five hand-copied call sites (#180.3).
 */
export async function runEnveloped(
  cfg: Config,
  spec: EnvelopeSpec,
  deps: EnvelopeDeps,
): Promise<RunResult> {
  const guardManager = buildGuardManager(cfg);
  let sink: TranscriptSink | null = null;
  if (cfg.transcriptsEnabled) {
    sink = openRunTranscriptSink(cfg, spec.ticketId, deps);
    // Reconstructability (spec 1b): modelId is a STRING on purpose — never
    // serialize cfg.model (it can carry apiKey).
    writeTranscriptRecord(
      sink,
      JSON.stringify({
        type: "junco_run_start",
        flow: spec.flow,
        body: spec.body,
        cwd: spec.cwd,
        modelId: cfg.model.id,
        tools: cfg.tools,
        timeoutMs: spec.timeoutMs,
        guard: { enabled: cfg.supervisorEnabled, ...guardOptionsFromConfig(cfg) },
        ts: new Date().toISOString(),
      } satisfies RunStartRecord) + "\n",
    );
  }
  const start = Date.now();
  try {
    const result = await runAgent({
      body: spec.body,
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
      createSession: deps.createSession,
      guardManager,
      abortSignal: deps.abortSignal,
      onProgress: deps.onProgress,
      onGuardDecision: deps.onGuardDecision,
      transcript: sink,
    });
    // Spend BEFORE any caller branching — parity with every migrated site
    // ("the dollars were spent regardless of what the ticket does next").
    deps.spend?.recordUsd(result.usage.costUsd);
    writeRunEnd(sink, {
      errorMessage: result.errorMessage,
      stopReason: result.stopReason,
      timedOut: result.timedOut,
      abortedByGuard: result.abortedByGuard,
      usage: result.usage,
      durationMs: result.durationMs,
    });
    return result;
  } catch (e) {
    // A rejecting session factory throws before/inside runAgent; the frame
    // still gets a run_end so replay sees the boundary. Rethrow the ORIGINAL
    // error unchanged (writeRunEnd is best-effort and never throws) — crash
    // containment stays the callers' business (runOnce.ts top-level).
    writeRunEnd(sink, {
      errorMessage: e instanceof Error ? e.message : String(e),
      stopReason: null,
      timedOut: false,
      abortedByGuard: false,
      usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
      durationMs: Date.now() - start,
    });
    throw e;
  } finally {
    endSink(sink);
  }
}
