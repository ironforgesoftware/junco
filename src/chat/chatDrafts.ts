/**
 * Parking (spec 2026-09-01 §6.2–6.4): the same lintTicket/decideRoute that
 * `junco submit --dry-run` runs, per file, then writeChatDraft + a
 * junco_chat_draft record. The auto-lint retry (§6.3) is a decision made
 * here and executed by the manager: the hook returns the follow-up text
 * once, keyed by slug, and replaces the failed draft when the retry parks.
 */
import type { Config } from "../types.js";
import { parseTicket } from "../ticket.js";
import { lintTicket, formatViolations, type LintViolation } from "../planLint.js";
import { decideRoute, type PreflightDeps, type RouteDecision } from "../submitPreflight.js";
import { parsePlanSet } from "../planCompiler.js";
import type { ReviewStoreDeps } from "../reviewStore.js";
import type { ChatManagerDeps } from "./chatManager.js";
import type { ChatSession } from "./chatSession.js";
import { extractDrafts, type ExtractedDraft } from "./fenceExtract.js";
import {
  removeChatDraft,
  writeChatDraft,
  type DraftFile,
  type PendingDraft,
} from "./draftStore.js";

export interface ParkDeps {
  lintFn?: typeof lintTicket;
  routeFn?: typeof decideRoute;
  /** decideRoute's own seams (git/fs) — the real one probes the watchlist by
   *  the repo PATH's origin remote when github + bot are on (R17). */
  routeDeps?: PreflightDeps;
  store?: ReviewStoreDeps;
  now?: () => number;
}

type SessionRef = Pick<ChatSession, "slug" | "key" | "cwd" | "nwo">;

/** Extraction problems as lint rows. A set's problems are addressed
 * `"<id>: …"` and land on that file; unaddressed ones land on every file
 * (a single-file draft) or the first file (a set-wide problem).
 *
 * An unknown `depends_on` inside a set is submit's own warn-and-wait (the
 * sibling may land later, ticketDeps.ts gates the claim), so it is a WARNING
 * here rather than the error every other extraction problem is. */
function problemsFor(x: ExtractedDraft, fileIdx: number): LintViolation[] {
  const f = x.files[fileIdx]!;
  const mine = x.problems.filter((p) => {
    const addressed = /^([^:\s]+): /.exec(p);
    if (!addressed) return x.kind !== "ticketSet" || fileIdx === 0;
    return addressed[1] === f.id || addressed[1] === f.name;
  });
  return mine.map((message) =>
    x.kind === "ticketSet" && message.includes("depends_on names no sibling")
      ? { rule: "depends_on_sibling", severity: "warning" as const, message }
      : { rule: "chat_extract", severity: "error" as const, message },
  );
}

/** Monotonic within the process; the millisecond stamp keeps ids unique
 * across restarts. Two drafts parked in the same millisecond (a set, or an
 * auto-lint retry landing fast) must NOT collide: the retry path removes the
 * previous draft by id, and a collision would delete the replacement. */
let seq = 0;

function draftId(slug: string, now: number): string {
  const d = new Date(now);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const ts =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}`;
  return `${slug}-${ts}-${++seq}`;
}

/** One extracted draft's files, linted and routed. audit/investigate run a
 * CLI verb rather than a ticket, so plan-lint (a plan-body ruleset) does not
 * apply to them and there is nothing to route; a planSet is validated by the
 * compiler that will actually expand it. */
async function lintFiles(
  cfg: Config,
  session: SessionRef,
  x: ExtractedDraft,
  lintFn: typeof lintTicket,
  routeFn: typeof decideRoute,
  routeDeps: PreflightDeps | undefined,
): Promise<DraftFile[]> {
  const files: DraftFile[] = [];
  for (const [i, f] of x.files.entries()) {
    const lint: LintViolation[] = problemsFor(x, i);
    let route: RouteDecision | null = null;
    if (x.kind === "planSet") {
      const parsed = parsePlanSet(f.body, { maxTasks: cfg.planSets.maxTasks });
      if (!parsed.ok)
        for (const message of parsed.errors)
          lint.push({ rule: "plan_set", severity: "error", message });
    } else if (x.kind !== "audit" && x.kind !== "investigate") {
      const t = parseTicket(f.name, f.content, cfg.defaultTimeoutMinutes);
      lint.push(
        ...lintFn(t.body, t.frontmatter, {
          repoPath: session.cwd,
          repoNwo: session.nwo,
          // No network from a chat turn: the label check shells out to gh.
          checkLabels: false,
        }).violations,
      );
      route = await routeFn(cfg, t.frontmatter, routeDeps);
    }
    files.push({ name: f.name, content: f.content, lint, route, droppedKeys: f.droppedKeys });
  }
  return files;
}

export async function parkDrafts(
  cfg: Config,
  session: SessionRef,
  extracted: ExtractedDraft[],
  deps: ParkDeps = {},
): Promise<PendingDraft[]> {
  const lintFn = deps.lintFn ?? lintTicket;
  const routeFn = deps.routeFn ?? decideRoute;
  const now = deps.now ?? ((): number => Date.now());
  const out: PendingDraft[] = [];
  for (const x of extracted) {
    const files = await lintFiles(cfg, session, x, lintFn, routeFn, deps.routeDeps);
    const at = now();
    const draft: PendingDraft = {
      id: draftId(session.slug, at),
      key: session.key,
      slug: session.slug,
      kind: x.kind,
      files,
      cwd: session.cwd,
      nwo: session.nwo,
      createdAt: new Date(at).toISOString(),
      lintFailed: files.some((f) => f.lint.some((v) => v.severity === "error")),
      blocked: x.blocked,
      routeOverride: "auto",
      commandArgs: x.commandArgs,
    };
    writeChatDraft(cfg, draft, deps.store);
    out.push(draft);
  }
  return out;
}

/** The one automatic follow-up (spec §6.3): every error, and the skill's own
 * loop instruction — fix exactly what was cited, re-emit the whole fence. */
export function lintFollowUp(drafts: PendingDraft[]): string | null {
  const failed = drafts.filter((d) => d.lintFailed);
  if (failed.length === 0) return null;
  const parts = failed.flatMap((d) =>
    d.files
      .filter((f) => f.lint.some((v) => v.severity === "error"))
      .map((f) => `${f.name}:\n${formatViolations(f.lint.filter((v) => v.severity === "error"))}`),
  );
  return (
    `junco's plan-lint rejected the draft you just emitted:\n\n${parts.join("\n\n")}\n\n` +
    "Fix exactly the rules cited and re-emit the complete fence(s). Do not change anything else."
  );
}

/**
 * ChatManager.onTurnComplete: extract → park → record → decide the retry.
 *
 * The follow-up is offered only for an `operator` turn, so a retry that still
 * fails parks its violations and stops (the manager enforces the same rule on
 * its side — the two together make "exactly one, never chained" hold even if
 * a future caller returns a followUp from an auto_lint turn).
 */
export function makeTurnHook(
  cfg: () => Config,
  deps: ParkDeps = {},
): NonNullable<ChatManagerDeps["onTurnComplete"]> {
  const pendingRetry = new Map<string, string>(); // slug → failed draft id awaiting its retry
  return async (session, result, source) => {
    if (result.mode !== "prompt" || result.status !== "ok") return;
    const c = cfg();
    const extracted = extractDrafts(result.allText, {
      repo: session.cwd,
      nwo: session.nwo,
      planSetsEnabled: c.planSets.enabled,
    });
    if (extracted.length === 0) return;
    const parked = await parkDrafts(c, session, extracted, deps);
    const previous = pendingRetry.get(session.slug);
    if (source === "auto_lint" && previous !== undefined) {
      // The rejected first attempt is REMOVED, not archived: it was never a
      // card the operator saw, and its retry is on disk now.
      removeChatDraft(c, previous);
      pendingRetry.delete(session.slug);
    }
    for (const d of parked)
      session.writeRecord({
        type: "junco_chat_draft",
        draftId: d.id,
        kind: d.kind,
        status: d.lintFailed ? "lint_failed" : "parked",
        ids: d.files.map((f) => f.name.replace(/\.md$/, "")),
        destination: null,
      });
    const followUp = lintFollowUp(parked);
    if (followUp !== null && source === "operator") {
      pendingRetry.set(session.slug, parked.find((d) => d.lintFailed)!.id);
      return { followUp };
    }
    return;
  };
}
