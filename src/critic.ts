/**
 * Post-session critic — a faithful port of worker.py's critic
 * (`_CRITIC_MARKER_RE`, `_CRITIC_PROMPT_TEMPLATE`, `CriticResult`, `_git_diff`,
 * `_scan_critic_marker`, `run_critic_pass`, `_build_corrective_prompt`).
 *
 * The ONE adaptation: the Python worker spawned a separate `pi -p` subprocess
 * (`--no-tools --thinking <level> ...`). Here the critic runs the model
 * IN-PROCESS via the same agent infrastructure as the worker — `runAgent` with
 * a session built by `makePiSessionFactory(cfg, wt, { tools: [], thinkingLevel:
 * cfg.criticThinking })`. The session factory is dependency-injected so the
 * pass is testable without a real model.
 *
 * Informational only: a MISSING verdict drives an optional corrective
 * re-dispatch (see `buildCorrectivePrompt`), but never blocks the push.
 */

import type { Config, Ticket, Usage } from "./types.js";
import { git } from "./git.js";
import { runAgent, makePiSessionFactory, type AgentSessionLike } from "./agent/session.js";

export interface CriticResult {
  status: "pass" | "missing" | "skipped" | "error";
  findings: string;
  rawOutput: string;
  /** Token/cost usage for this critic pass's in-process session — zeroed for
   * the skip paths below (no session ran). Aggregated with the main run's (and
   * any corrective turn's) usage by prFlow so the ticket's recorded cost
   * reflects the whole ticket, not just the main worker turn. */
  usage: Usage;
}

/** A critic pass that never dispatched a session (disabled / empty diff)
 * reports zero usage — nothing was spent. */
const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 };

/**
 * Mirrors Python `_CRITIC_MARKER_RE = re.compile(r"JUNCO_VERIFY:\s*(PASS|MISSING)\b\s*(.*?)$", re.MULTILINE)`.
 * The `m` flag makes `$` match per-line (Python's re.MULTILINE); `g` is needed
 * to collect ALL matches so we can take the last one (Python's `finditer`).
 */
const CRITIC_MARKER_RE = /JUNCO_VERIFY:\s*(PASS|MISSING)\b\s*(.*?)$/gm;

/**
 * Verbatim copy of worker.py `_CRITIC_PROMPT_TEMPLATE`. The wording is
 * load-bearing — it instructs the model on the exact single-line verdict
 * format the marker regex scans for. `{spec}`/`{diff}`/`{base}` are filled by
 * `buildCriticPrompt`.
 */
export const CRITIC_PROMPT_TEMPLATE = `\
You are a strict code reviewer. The ticket spec below was given to a worker
agent. The worker emitted the diff that follows.

Your job: decide whether the diff fully implements every In-scope item from
the spec. Output EXACTLY ONE of these two lines as your final output, with no
other prose:

    JUNCO_VERIFY: PASS
    JUNCO_VERIFY: MISSING <comma-separated short labels of missing items>

Rules:
- "MISSING" only for items the spec marks as in-scope. Out-of-scope items are
  not considered.
- Style nits, minor naming, or refactor suggestions are NOT MISSING — only
  flag concrete spec items the diff fails to ship.
- If the spec is unambiguous and the diff matches, output PASS. Be generous —
  the worker's job is "did the work," not "perfect aesthetics."

============================================================
TICKET SPEC
============================================================
{spec}

============================================================
DIFF (git diff {base}..HEAD --unified=3)
============================================================
{diff}

Now output your single-line verdict.
`;

/**
 * Fill the verbatim template. Replaces all `{spec}`/`{diff}`/`{base}`
 * placeholders (mirrors Python `str.format`). Uses `split/join` rather than
 * regex replacement so `$`-sequences in the diff/spec are inserted literally.
 *
 * When the diff carries the truncation marker, guidance is appended so the
 * critic does not flag items as MISSING merely because they fall beyond the
 * cutoff (false MISSING verdicts trigger a pointless corrective re-dispatch).
 */
export function buildCriticPrompt(spec: string, diff: string, base: string): string {
  const truncationGuidance = diff.includes("DIFF TRUNCATED")
    ? "\nNOTE: the diff above is TRUNCATED. Judge only the hunks you can see; " +
      "do not report MISSING for items you cannot see solely because the diff " +
      "is cut off. When truncation leaves you unsure about an item, lean PASS.\n"
    : "";
  return CRITIC_PROMPT_TEMPLATE.split("{spec}")
    .join(spec)
    .split("{base}")
    .join(base)
    .split("{diff}")
    .join(diff + truncationGuidance);
}

export const DIFF_TRUNCATION_NOTE =
  "\n\n[... DIFF TRUNCATED: only the first 100,000 characters are shown; " +
  "see git diff in the worktree for the rest ...]";

/**
 * Capture `git diff base..HEAD --unified=3` for the critic to review. Truncated
 * at 100k chars to avoid blowing past the model's context (parity with Python
 * `_git_diff`). `check:false` so a non-zero git exit yields whatever stdout it
 * produced rather than throwing.
 */
export async function gitDiff(cfg: Config, wtPath: string, baseRef: string): Promise<string> {
  try {
    const cp = await git(cfg, ["diff", `${baseRef}..HEAD`, "--unified=3"], {
      cwd: wtPath,
      timeoutMs: 30_000,
      check: false,
    });
    let diff = cp.stdout || "";
    if (diff.length > 100_000) {
      diff = diff.slice(0, 100_000) + DIFF_TRUNCATION_NOTE;
    }
    return diff;
  } catch (e) {
    return `[error capturing diff: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

/**
 * Return `{status, findings}` with status ∈ {pass, missing, error}. Port of
 * Python `_scan_critic_marker`: no text → error; no marker → error; otherwise
 * the LAST marker wins. PASS → pass/""; MISSING → missing/<trimmed rest>.
 */
export function scanCriticMarker(text: string): {
  status: "pass" | "missing" | "error";
  findings: string;
} {
  if (!text) return { status: "error", findings: "no output from critic" };
  // matchAll collects every occurrence (mirrors Python finditer). The regex is
  // a module-level `g`-flagged literal; matchAll resets lastIndex each call so
  // re-use across calls is safe.
  const matches = [...text.matchAll(CRITIC_MARKER_RE)];
  if (matches.length === 0) {
    return { status: "error", findings: "critic did not emit JUNCO_VERIFY marker" };
  }
  const last = matches[matches.length - 1];
  const verdict = last[1].toUpperCase();
  const rest = (last[2] || "").trim();
  if (verdict === "PASS") return { status: "pass", findings: "" };
  return { status: "missing", findings: rest };
}

export interface CriticDeps {
  /** Inject a session factory (the critic's no-tools session). Tests pass a
   * fake; production omits it so the real in-process Pi session is built. */
  criticSessionFactory?: () => Promise<AgentSessionLike>;
}

/**
 * Run the critic: diff the worktree against `baseRef`, prompt an in-process
 * no-tools model session for a PASS/MISSING verdict, and scan its final text
 * for the marker. Port of Python `run_critic_pass`, adapted from a `pi -p`
 * subprocess to an in-process `runAgent`.
 */
export async function runCriticPass(
  cfg: Config,
  task: Ticket,
  wtPath: string,
  baseRef: string,
  deps?: CriticDeps,
): Promise<CriticResult> {
  if (!cfg.criticEnabled) {
    return {
      status: "skipped",
      findings: "cfg.critic_enabled=false",
      rawOutput: "",
      usage: ZERO_USAGE,
    };
  }
  const diff = await gitDiff(cfg, wtPath, baseRef);
  if (!diff.trim()) {
    return { status: "skipped", findings: "empty diff", rawOutput: "", usage: ZERO_USAGE };
  }
  const prompt = buildCriticPrompt(task.body, diff, baseRef);
  // No tools (diff-vs-spec review needs none) + the configured critic thinking
  // level. No guardManager — the critic is a single bounded read-only turn.
  const factory =
    deps?.criticSessionFactory ??
    makePiSessionFactory(cfg, wtPath, { tools: [], thinkingLevel: cfg.criticThinking });
  const result = await runAgent({
    body: prompt,
    cwd: wtPath,
    timeoutMs: 300_000,
    createSession: factory,
  });
  // Scan the WHOLE run for the verdict marker, not just the last message: #36
  // redefined finalText as the last assistant message only, so a verdict
  // emitted before any trailing prose would be lost and read as an error (#67).
  // scanCriticMarker already takes the LAST marker, so the whole-run text is
  // safe. allText is the whole-run concatenation; fall back for empty runs.
  const text = result.allText ?? result.finalText;
  const scan = scanCriticMarker(text);
  return { status: scan.status, findings: scan.findings, rawOutput: text, usage: result.usage };
}

/**
 * Prompt for the one corrective re-dispatch turn after the critic flags
 * MISSING. Verbatim port of Python `_build_corrective_prompt` with `task.body`
 * appended.
 */
export function buildCorrectivePrompt(task: Ticket, missingItems: string): string {
  return (
    "## Corrective re-dispatch — the critic flagged missing items\n\n" +
    "You ran a prior session on this ticket and committed work to the branch. " +
    "A reviewer compared your diff to the ticket spec and found these items " +
    "are still missing:\n\n" +
    `  ${missingItems}\n\n` +
    "Add ONE focused commit (or two if logically separated) on top of your " +
    "existing commits that addresses ONLY the items above. Do NOT redo work " +
    "that's already committed. Do NOT amend, rebase, or force-change prior " +
    "commits. After the fix, output a one-line summary and stop.\n\n" +
    "---\n\n" +
    "## Original ticket spec\n\n" +
    task.body
  );
}
