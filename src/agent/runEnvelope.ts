/**
 * runEnvelope — the single wrapper every junco agent run goes through.
 *
 * Grows over this plan into: guard construction (Task 1), transcript
 * lifecycle + junco_run records, the runAgent call, and spend recording
 * (this task) — replacing the five hand-copied wrappers (runOnce Q&A,
 * assessFlow, analyzeFlow, prFlow main, prFlow corrective) whose parity
 * previously rested on comments (#180.3).
 */
import { existsSync } from "node:fs";
import type { Config, RunResult } from "../types.js";
import { transcriptPathFor } from "../slug.js";
import { dataTreePaths } from "../dataTree.js";
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
export function openTicketTranscript(
  path: string,
  factory: TranscriptSinkFactory,
  fileExists: (p: string) => boolean,
): { sink: TranscriptSink | null; created: boolean } {
  const created = !fileExists(path);
  return { sink: factory(path), created };
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
    const path = transcriptPathFor(dataTreePaths(cfg).transcripts, spec.ticketId);
    const opened = openTicketTranscript(
      path,
      deps.transcriptSink ?? defaultTranscriptSink,
      deps.fileExists ?? existsSync,
    );
    sink = opened.sink;
    if (sink && opened.created) {
      sink.write(
        JSON.stringify({
          type: "junco_meta",
          version: TRANSCRIPT_VERSION,
          ticketId: spec.ticketId,
          createdAt: new Date().toISOString(),
        } satisfies MetaRecord) + "\n",
      );
    }
    // Reconstructability (spec 1b): modelId is a STRING on purpose — never
    // serialize cfg.model (it can carry apiKey).
    sink?.write(
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
    sink?.write(
      JSON.stringify({
        type: "junco_run_end",
        errorMessage: result.errorMessage,
        stopReason: result.stopReason,
        timedOut: result.timedOut,
        abortedByGuard: result.abortedByGuard,
        usage: result.usage,
        durationMs: result.durationMs,
        ts: new Date().toISOString(),
      } satisfies RunEndRecord) + "\n",
    );
    return result;
  } catch (e) {
    // A rejecting session factory throws before/inside runAgent; the frame
    // still gets a run_end so replay sees the boundary. Rethrow unchanged —
    // crash containment stays the callers' business (runOnce.ts top-level).
    sink?.write(
      JSON.stringify({
        type: "junco_run_end",
        errorMessage: e instanceof Error ? e.message : String(e),
        stopReason: null,
        timedOut: false,
        abortedByGuard: false,
        usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
        durationMs: Date.now() - start,
        ts: new Date().toISOString(),
      } satisfies RunEndRecord) + "\n",
    );
    throw e;
  } finally {
    sink?.end();
  }
}
