/**
 * `junco replay <ticket-id | path.jsonl>` — re-runs a recorded per-ticket
 * event transcript through a FRESH GuardManager under a chosen policy and
 * reports what the guards would decide today: a guard-policy what-if over
 * history (src/agent/replay.ts owns the actual replay reduction; this module
 * is target resolution + policy precedence + report rendering around it).
 *
 * Policy precedence, per knob (highest wins):
 *   1. An explicit CLI flag.
 *   2. The FIRST `junco_run_start.guard` recorded in the file (v2
 *      transcripts only — a v1 file or an unframed prefix has none).
 *   3. The loaded config, via `guardOptionsFromConfig` (Task 1).
 *   4. GuardManager's own built-in defaults — reached only when config could
 *      not be loaded at all (e.g. a direct .jsonl path with no config on
 *      disk; see the bare-ticket-id branch below, which REQUIRES config to
 *      resolve a path in the first place).
 */
import { parseArgs } from "node:util";
import type { Config } from "./types.js";
import { replayTranscript, type ReplayReport, type ReplayRun } from "./agent/replay.js";
import { guardOptionsFromConfig } from "./agent/runEnvelope.js";
import { parseTranscriptLine, type RunStartRecord } from "./agent/transcriptSchema.js";
import { transcriptPathFor } from "./slug.js";
import { dataTreePaths } from "./dataTree.js";

export interface ReplayCmdDeps {
  /** May throw (no config on disk) — tolerated for a direct .jsonl target. */
  loadCfg: () => Config;
  /** Throws (e.g. ENOENT) when the path doesn't exist. */
  readFile: (path: string) => string;
  stdout: (line: string) => void;
}

const USAGE =
  "Usage: junco replay <ticket-id | path.jsonl> [--budget-per-kind N] " +
  "[--escalation-window N] [--output-budget-per-turn N] [--output-budget-post-commit N] [--json]";

type KnobKey =
  | "budgetPerKind"
  | "escalationWindow"
  | "outputBudgetPerTurn"
  | "outputBudgetPostCommit";

const KNOB_LABEL: Record<KnobKey, string> = {
  budgetPerKind: "budgetPerKind",
  escalationWindow: "escalationWindow",
  outputBudgetPerTurn: "outputBudgetPerTurn",
  outputBudgetPostCommit: "outputBudgetPostCommit",
};

/**
 * GuardManager's own built-in defaults, mirrored here purely for the
 * report's "source" line — they are module-private consts, not exported.
 * Keep in sync with src/agent/supervisor.ts:56-58 (DEFAULT_CONFIG's
 * budgetPerKind/escalationWindowTurns) and src/agent/guardManager.ts:53-54
 * (DEFAULT_OUTPUT_BUDGET_PER_TURN/POST_COMMIT).
 */
const GUARD_MANAGER_DEFAULTS: Record<KnobKey, number> = {
  budgetPerKind: 1,
  escalationWindow: 3,
  outputBudgetPerTurn: 12000,
  outputBudgetPostCommit: 24000,
};

interface ResolvedKnob {
  key: KnobKey;
  value: number;
  source: "flag" | "recorded run_start" | "config" | "GuardManager defaults";
}

function resolveKnob(
  key: KnobKey,
  flagVal: number | undefined,
  recordedVal: number | undefined,
  configVal: number | undefined,
): ResolvedKnob {
  if (flagVal !== undefined) return { key, value: flagVal, source: "flag" };
  if (recordedVal !== undefined) return { key, value: recordedVal, source: "recorded run_start" };
  if (configVal !== undefined) return { key, value: configVal, source: "config" };
  return { key, value: GUARD_MANAGER_DEFAULTS[key], source: "GuardManager defaults" };
}

/** Resolves all four knobs, in a fixed canonical order (used both to build
 * the GuardManagerOptions fed to replayTranscript and to render the
 * `policy:` lines below). */
function resolvePolicy(
  flags: Partial<Record<KnobKey, number>>,
  recordedGuard: RunStartRecord["guard"] | undefined,
  cfg: Config | undefined,
): ResolvedKnob[] {
  const cfgGuard = cfg ? guardOptionsFromConfig(cfg) : undefined;
  const recSupervisor = recordedGuard?.supervisorConfig;
  return [
    resolveKnob(
      "budgetPerKind",
      flags.budgetPerKind,
      recSupervisor?.budgetPerKind,
      cfgGuard?.supervisorConfig?.budgetPerKind,
    ),
    resolveKnob(
      "escalationWindow",
      flags.escalationWindow,
      recSupervisor?.escalationWindowTurns,
      cfgGuard?.supervisorConfig?.escalationWindowTurns,
    ),
    resolveKnob(
      "outputBudgetPerTurn",
      flags.outputBudgetPerTurn,
      recordedGuard?.outputBudgetPerTurn,
      cfgGuard?.outputBudgetPerTurn,
    ),
    resolveKnob(
      "outputBudgetPostCommit",
      flags.outputBudgetPostCommit,
      recordedGuard?.outputBudgetPostCommit,
      cfgGuard?.outputBudgetPostCommit,
    ),
  ];
}

/** Groups consecutive same-source knobs (in resolvePolicy()'s canonical
 * order) onto one `policy:` line — e.g. `policy: budgetPerKind=1
 * escalationWindow=3 (source: recorded run_start)` when both share a
 * source, a separate line each when they don't. */
function renderPolicyLines(resolved: ResolvedKnob[]): string[] {
  const lines: string[] = [];
  let i = 0;
  while (i < resolved.length) {
    const source = resolved[i].source;
    const group: ResolvedKnob[] = [];
    while (i < resolved.length && resolved[i].source === source) {
      group.push(resolved[i]);
      i++;
    }
    lines.push(
      `policy: ${group.map((k) => `${KNOB_LABEL[k.key]}=${k.value}`).join(" ")} (source: ${source})`,
    );
  }
  return lines;
}

type DecisionLike = { action: string; kind: string; turnIndex: number };

function fmtDecision(d: DecisionLike | undefined): string {
  return d ? `${d.action}(${d.kind}@t${d.turnIndex})` : "—";
}

function decisionsEqual(rec: DecisionLike | undefined, rep: DecisionLike | undefined): boolean {
  return (
    rec !== undefined &&
    rep !== undefined &&
    rec.action === rep.action &&
    rec.kind === rep.kind &&
    rec.turnIndex === rep.turnIndex
  );
}

/**
 * One run's report lines. A run whose `start` is undefined renders as
 * "boundary-inferred" — true for a v1 transcript AND, even inside a
 * version-2 report, for the pre-v2 prefix of a file appended to after the
 * upgrade (replayTranscript infers THAT run's boundaries from agent_end
 * rather than framing — see replay.ts's ReplayRun.start doc comment).
 */
function renderRunLines(run: ReplayRun): string[] {
  const label = run.start ? run.start.flow : "boundary-inferred";
  const header = `run ${run.index + 1} (${label})`;
  const n = Math.max(run.recorded.length, run.replayed.length);
  if (n === 0) return [`${header}: no guard decisions`];
  const pairs = Array.from({ length: n }, (_, i) => {
    const rec = run.recorded[i];
    const rep = run.replayed[i]?.decision;
    const mark = decisionsEqual(rec, rep) ? "✓" : "✗";
    return `recorded ${fmtDecision(rec)} → replayed ${fmtDecision(rep)} ${mark}`;
  });
  if (pairs.length === 1) return [`${header}: ${pairs[0]}`];
  return [`${header}:`, ...pairs.map((p) => `  ${p}`)];
}

function renderVerdictLines(report: ReplayReport): string[] {
  if (report.identical) return ["verdict: decisions identical under this policy"];
  const diverged = report.runs.filter((run) => {
    if (run.recorded.length !== run.replayed.length) return true;
    return run.recorded.some((rec, k) => !decisionsEqual(rec, run.replayed[k].decision));
  });
  return [
    `verdict: ${diverged.length} run(s) diverge from the recorded decisions under this policy`,
    ...diverged.map((r) => `  run ${r.index + 1} diverges`),
  ];
}

/** report.caveats plus (when the file had damage) a CLI-level caveat: a
 * merged rep-guard buffer across a truncation boundary can produce a
 * divergence that is an artifact of file damage, not a real policy finding. */
function renderCaveatLines(report: ReplayReport): string[] {
  const lines = ["caveats:", ...report.caveats.map((c) => `  - ${c}`)];
  if (report.invalidLines > 0) {
    lines.push(
      `  - ${report.invalidLines} damaged/truncated line(s) were skipped; a merged rep-guard ` +
        "buffer across a truncated boundary can produce a divergence that is an artifact of file " +
        "damage, not a policy finding",
    );
  }
  return lines;
}

function isPathLike(target: string): boolean {
  return target.endsWith(".jsonl") || target.includes("/");
}

/** The first `junco_run_start.guard` in the file, if any (precedence layer 2). */
function firstRunStartGuard(lines: string[]): RunStartRecord["guard"] | undefined {
  for (const line of lines) {
    const p = parseTranscriptLine(line);
    if (p.kind === "junco" && p.record.type === "junco_run_start") return p.record.guard;
  }
  return undefined;
}

function parseNumFlag(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`junco replay: --${flag} expects a number, got '${raw}'`);
  }
  return n;
}

export async function runReplayCmd(argv: string[], deps: ReplayCmdDeps): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "budget-per-kind": { type: "string" },
        "escalation-window": { type: "string" },
        "output-budget-per-turn": { type: "string" },
        "output-budget-post-commit": { type: "string" },
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

  let flags: Partial<Record<KnobKey, number>>;
  try {
    flags = {
      budgetPerKind: parseNumFlag(
        "budget-per-kind",
        values["budget-per-kind"] as string | undefined,
      ),
      escalationWindow: parseNumFlag(
        "escalation-window",
        values["escalation-window"] as string | undefined,
      ),
      outputBudgetPerTurn: parseNumFlag(
        "output-budget-per-turn",
        values["output-budget-per-turn"] as string | undefined,
      ),
      outputBudgetPostCommit: parseNumFlag(
        "output-budget-post-commit",
        values["output-budget-post-commit"] as string | undefined,
      ),
    };
  } catch (e) {
    deps.stdout(e instanceof Error ? e.message : String(e));
    return 2;
  }

  let cfg: Config | undefined;
  try {
    cfg = deps.loadCfg();
  } catch {
    cfg = undefined; // tolerated for a direct .jsonl target — see below
  }

  const pathLike = isPathLike(target);
  let transcriptPath: string;
  if (pathLike) {
    transcriptPath = target;
  } else {
    if (!cfg) {
      deps.stdout(
        `junco replay: no config found — cannot resolve ticket id '${target}' to a transcript ` +
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
    deps.stdout(`junco replay: no transcript at ${transcriptPath}${hint}`);
    return 1;
  }

  const lines = content.split("\n");
  const recordedGuard = firstRunStartGuard(lines);
  const resolved = resolvePolicy(flags, recordedGuard, cfg);
  const byKey = Object.fromEntries(resolved.map((k) => [k.key, k.value])) as Record<
    KnobKey,
    number
  >;

  const report = replayTranscript(lines, {
    guard: {
      supervisorConfig: {
        budgetPerKind: byKey.budgetPerKind,
        escalationWindowTurns: byKey.escalationWindow,
      },
      outputBudgetPerTurn: byKey.outputBudgetPerTurn,
      outputBudgetPostCommit: byKey.outputBudgetPostCommit,
    },
  });

  if (values.json) {
    deps.stdout(JSON.stringify(report, null, 2));
    return 0;
  }

  const out: string[] = [
    ...renderPolicyLines(resolved),
    ...report.runs.flatMap(renderRunLines),
    ...renderVerdictLines(report),
    ...renderCaveatLines(report),
  ];
  for (const line of out) deps.stdout(line);
  return 0;
}
