/**
 * Fences → drafts (spec 2026-09-01 §6.1). Pure. The GitHub planner emits a
 * ticket BODY only ("model output can never set repo:/workdir:/tools:/
 * network:", planPrompt.ts); chat needs model-authored frontmatter to express
 * kinds, so the boundary here is an ALLOWLIST: junco sets `repo:` itself and
 * drops everything not listed, recording the dropped names for the card.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { DraftKind } from "../agent/transcriptSchema.js";
import { PLAN_FENCE } from "../planPrompt.js";
import { PLAN_SET_FENCE, allFencedBlocks, extractPatchBody } from "../githubInbox.js";
import { longestBacktickRun } from "../fences.js";

export const FRONTMATTER_ALLOWLIST: ReadonlySet<string> = new Set([
  "id",
  "pr_title",
  "branch_name",
  "base_branch",
  "priority",
  "labels",
  "reviewers",
  "draft",
  "depends_on",
  "amends_pr",
  "timeout_minutes",
  "github_request",
  "audit",
  "investigate",
  // Legacy aliases parseTicket still accepts (#389); the canonical key wins on a collision.
  "assess",
  "analyze",
]);

export interface ExtractedFile {
  name: string;
  /** Allowlisted frontmatter + repo: + body — byte-identical to what lint sees. */
  content: string;
  frontmatter: Record<string, unknown>;
  body: string;
  droppedKeys: string[];
  id: string | null;
}

export interface ExtractedDraft {
  kind: DraftKind;
  files: ExtractedFile[];
  blocked: "plan_sets_disabled" | null;
  /** audit/investigate: the verb's argv, derived here so confirm never re-reads the fence. */
  commandArgs: string[] | null;
  /** Structural problems found here (lint runs later, in chatDrafts.ts). */
  problems: string[];
}

export interface ExtractCtx {
  /** The session cwd. ALWAYS what junco writes as `repo:`, watched or local
   * (R17): decideRoute and `junco submit` match a ticket to a watched repo by
   * the PATH's origin remote (findWatchedForPath — the dispatch skill's own
   * rule), so an owner/repo there would miss the watchlist AND fail
   * environmentChecks' repo_path_missing. */
  repo: string;
  /** owner/repo for a watched session: the audit/investigate command target
   * ONLY. Never `repo:` — see above. */
  nwo: string | null;
  planSetsEnabled: boolean;
}

const FM_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

// A `junco-patch` fence whose OPENING line survived into the body but whose
// closer didn't: same-backtick-count nesting (outer junco-ticket fence, inner
// junco-patch fence both ```) makes allFencedBlocks's ticket-level scan
// consume the inner fence's own closer as the outer's, truncating the body
// one line short of a complete junco-patch block (real CommonMark ambiguity,
// not a bug — planPrompt.ts's system prompt already tells the model to use
// more backticks on the outer fence for exactly this reason). Detected here
// so the drop is visible on the card instead of silently shipping a ticket
// whose "patch" is missing its last line.
const OPEN_PATCH_FENCE_RE = /^`{3,}junco-patch\s*$/m;

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "ticket";

function h1Of(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1]!.trim() : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface SplitResult {
  file: ExtractedFile;
  /** Whether frontmatter declared `id:` explicitly — the H1 fallback below
   * fills `file.id` either way, but a ticketSet requires the explicit form
   * (an auto-slug isn't something a sibling's `depends_on` could name). */
  explicitId: boolean;
}

function splitFile(raw: string, ctx: ExtractCtx, problems: string[]): SplitResult {
  const m = FM_RE.exec(raw);
  let fm: Record<string, unknown> = {};
  let body = raw;
  if (m) {
    body = m[2] ?? "";
    try {
      const parsed: unknown = parseYaml(m[1] ?? "");
      if (isRecord(parsed)) fm = parsed;
      else if (parsed !== null && parsed !== undefined)
        problems.push("frontmatter is not a mapping");
    } catch (e) {
      problems.push(`frontmatter did not parse: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const kept: Record<string, unknown> = {};
  const droppedKeys: string[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (FRONTMATTER_ALLOWLIST.has(k)) kept[k] = v;
    else droppedKeys.push(k);
  }
  // A ticket carrying both the canonical and the legacy request key: the
  // canonical wins (parseTicket's own precedence, #389) and the loser is
  // dropped here so the parked file never trips the key_collision lint.
  for (const [canonical, legacy] of [
    ["audit", "assess"],
    ["investigate", "analyze"],
  ] as const) {
    if (canonical in kept && legacy in kept) {
      delete kept[legacy];
      droppedKeys.push(legacy);
    }
  }
  const explicitId = typeof kept.id === "string" && kept.id !== "";
  if (!explicitId) {
    const h1 = h1Of(body);
    if (h1) kept.id = slug(h1);
    else delete kept.id;
  }
  kept.repo = ctx.repo;
  const id = typeof kept.id === "string" ? kept.id : null;
  const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
  if (OPEN_PATCH_FENCE_RE.test(trimmedBody) && extractPatchBody(trimmedBody) === null) {
    problems.push(
      "junco-patch fence is not closed — use more backticks for the outer junco-ticket fence",
    );
  }
  const content = `---\n${stringifyYaml(kept).trimEnd()}\n---\n${trimmedBody}\n`;
  const file: ExtractedFile = {
    name: `${id ?? "ticket"}.md`,
    content,
    frontmatter: kept,
    body: trimmedBody,
    droppedKeys,
    id,
  };
  return { file, explicitId };
}

/** The audit/investigate request block: canonical key, else the legacy alias
 * (#389: `audit:`/`investigate:` canonical; `assess:`/`analyze:` accepted). */
function requestBlock(
  fm: Record<string, unknown>,
  canonical: string,
  legacy: string,
): Record<string, unknown> | null {
  if (isRecord(fm[canonical])) return fm[canonical];
  if (isRecord(fm[legacy])) return fm[legacy];
  return null;
}

function kindOf(f: ExtractedFile): DraftKind {
  const fm = f.frontmatter;
  if (requestBlock(fm, "audit", "assess") !== null) return "audit";
  if (requestBlock(fm, "investigate", "analyze") !== null) return "investigate";
  if (fm.amends_pr !== undefined && fm.amends_pr !== null) return "amend";
  if (extractPatchBody(f.body) !== null) return "apply";
  return "ticket";
}

function commandArgsFor(
  kind: DraftKind,
  f: ExtractedFile,
  ctx: ExtractCtx,
  problems: string[],
): string[] | null {
  const fm = f.frontmatter;
  if (kind === "audit") {
    const a = requestBlock(fm, "audit", "assess")!;
    const target = ctx.nwo ?? ctx.repo;
    const issue = typeof a.issue === "number" ? a.issue : null;
    if (issue !== null && ctx.nwo === null) {
      problems.push("an issue-scoped audit needs a watched owner/repo");
      return null;
    }
    return [
      "audit",
      issue !== null ? `${target}#${issue}` : target,
      ...(a.auto_plan === true ? ["--auto-plan"] : []),
    ];
  }
  if (kind === "investigate") {
    const a = requestBlock(fm, "investigate", "analyze")!;
    if (ctx.nwo === null) {
      problems.push("investigate needs a watched owner/repo");
      return null;
    }
    if (typeof a.issue !== "number") {
      problems.push("investigate.issue is required");
      return null;
    }
    return ["investigate", `${ctx.nwo}#${a.issue}`];
  }
  return null;
}

/**
 * Ruling R35, as amended by #448: one id, one file — the FIRST fence's SLOT,
 * the LAST fence's CONTENT. `<id>.md` is the on-disk name, so two fences
 * carrying the same id (the model drafts, reads a file, re-emits a corrected
 * version) would park a "set" whose two entries slugify onto ONE path: the
 * JSON lists two ids and `s` submits the same file twice. The last fence wins
 * on content — it is the model's corrected answer — but it is spliced into the
 * first one's position, because a set is submitted in FILE ORDER (submitArgv)
 * and a redraft must not move a ticket behind the sibling that `depends_on`
 * it. The drop is a visible problem, never silent. Ids are compared as
 * extracted (explicit or H1-derived): both produce the same colliding name.
 */
function dedupeById<T extends SplitResult>(results: T[], problems: string[]): T[] {
  const lastIdx = new Map<string, number>();
  results.forEach((r, i) => {
    if (r.file.id !== null) lastIdx.set(r.file.id, i);
  });
  const emitted = new Set<string>();
  return results.flatMap((r): T[] => {
    const id = r.file.id;
    if (id === null) return [r];
    if (emitted.has(id)) {
      problems.push(`duplicate id ${id}: kept the last fence in the first one's slot`);
      return [];
    }
    emitted.add(id);
    // No duplicate → lastIdx.get(id) is this very entry, i.e. `r` itself.
    return [results[lastIdx.get(id)!]!];
  });
}

function extractTicketDraft(text: string, ctx: ExtractCtx): ExtractedDraft | null {
  const tickets = allFencedBlocks(text, PLAN_FENCE);
  if (tickets.length === 0) return null;
  const problems: string[] = [];
  // Per-fence problems, merged only for the fences that SURVIVE the dedupe: a
  // superseded draft's complaint (an unclosed junco-patch, say) must not be
  // reported against the corrected one that replaced it.
  const all = tickets.map((t) => {
    const own: string[] = [];
    return { ...splitFile(t, ctx, own), own };
  });
  const kept = dedupeById(all, problems);
  for (const r of kept) problems.push(...r.own);
  if (kept.length === 1) {
    const file = kept[0]!.file;
    const kind = kindOf(file);
    const commandArgs = commandArgsFor(kind, file, ctx, problems);
    return { kind, files: [file], blocked: null, commandArgs, problems };
  }
  const results = kept;
  const files = results.map((r) => r.file);
  const ids = new Set<string>();
  results.forEach(({ file: f, explicitId }, i) => {
    if (!explicitId)
      problems.push(`every ticket in a set needs an explicit id (file ${i + 1} has none)`);
    else if (f.id !== null) ids.add(f.id);
  });
  for (const f of files) {
    const deps = Array.isArray(f.frontmatter.depends_on) ? f.frontmatter.depends_on : [];
    const missing = deps.filter((d: unknown) => typeof d === "string" && !ids.has(d));
    if (missing.length > 0)
      problems.push(`${f.id ?? f.name}: depends_on names no sibling: ${missing.join(", ")}`);
  }
  return { kind: "ticketSet", files, blocked: null, commandArgs: null, problems };
}

/** Does this message carry a junco fence of either kind? The scope switch
 *  (R35): the FINAL assistant message is what gets scanned when it has one. */
export function hasJuncoFence(text: string): boolean {
  return (
    allFencedBlocks(text, PLAN_FENCE).length > 0 || allFencedBlocks(text, PLAN_SET_FENCE).length > 0
  );
}

export function extractDrafts(text: string, ctx: ExtractCtx): ExtractedDraft[] {
  const out: ExtractedDraft[] = [];
  const ticketDraft = extractTicketDraft(text, ctx);
  if (ticketDraft) out.push(ticketDraft);
  for (const plan of allFencedBlocks(text, PLAN_SET_FENCE)) {
    // The outer fence must outrun any fence INSIDE the body, or the rewrapped
    // plan truncates at the inner one — for the dashboard's relint and for
    // `junco submit --plan`, which read these same bytes through
    // extractPlanSetBody. Min 4, the count buildPlanComment uses and the
    // planner prompt teaches (R16).
    const fence = "`".repeat(Math.max(4, longestBacktickRun(plan) + 1));
    out.push({
      kind: "planSet",
      files: [
        {
          name: "plan.md",
          content: `${fence}${PLAN_SET_FENCE}\n${plan}\n${fence}\n`,
          frontmatter: {},
          body: plan,
          droppedKeys: [],
          id: null,
        },
      ],
      blocked: ctx.planSetsEnabled ? null : "plan_sets_disabled",
      commandArgs: null,
      problems: [],
    });
  }
  return out;
}
