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
  /** The session cwd — `repo:` for a local session. */
  repo: string;
  /** owner/repo for a watched session — `repo:` then, and the audit/investigate target. */
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
  kept.repo = ctx.nwo ?? ctx.repo;
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

function extractTicketDraft(text: string, ctx: ExtractCtx): ExtractedDraft | null {
  const tickets = allFencedBlocks(text, PLAN_FENCE);
  if (tickets.length === 0) return null;
  if (tickets.length === 1) {
    const problems: string[] = [];
    const { file } = splitFile(tickets[0]!, ctx, problems);
    const kind = kindOf(file);
    const commandArgs = commandArgsFor(kind, file, ctx, problems);
    return { kind, files: [file], blocked: null, commandArgs, problems };
  }
  const problems: string[] = [];
  const results = tickets.map((t) => splitFile(t, ctx, problems));
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

export function extractDrafts(text: string, ctx: ExtractCtx): ExtractedDraft[] {
  const out: ExtractedDraft[] = [];
  const ticketDraft = extractTicketDraft(text, ctx);
  if (ticketDraft) out.push(ticketDraft);
  for (const plan of allFencedBlocks(text, PLAN_SET_FENCE)) {
    out.push({
      kind: "planSet",
      files: [
        {
          name: "plan.md",
          content: `\`\`\`${PLAN_SET_FENCE}\n${plan}\n\`\`\`\n`,
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
