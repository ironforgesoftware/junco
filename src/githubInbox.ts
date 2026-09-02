/**
 * GitHub → inbox bridge (dispatch side of GitHub-integrated mode).
 *
 * Design: docs/superpowers/specs/2026-07-02-github-inbox-design.md.
 * Issues are SNAPSHOTS: the labeled body is copied once into an ordinary
 * ticket via submitTicket; the existing queue machinery runs unchanged from
 * there. Lifecycle labels on GitHub mirror local state — local done//failed/
 * plus the PR are the source of truth.
 */

import { readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, GithubRepoMapping } from "./types.js";
import { gh, git } from "./git.js";
import { queuePaths } from "./config.js";
import { submitTicket } from "./dispatch.js";
import { log } from "./logging.js";
import { PLAN_FENCE, buildPlannerPrompt } from "./planPrompt.js";
import { resolveWatchedRepos } from "./watchlist.js";
import {
  flushOutbox,
  tryOrEnqueue,
  withCommentMarker,
  type FlushResult,
  type OutboxOp,
} from "./githubOutbox.js";
// NOTE: planSetBridge.ts imports githubTicketId/lifecycleLabels from this
// module, so this import creates a module cycle. Runtime-safe: both bindings
// are only dereferenced inside function bodies (pollGithubInbox /
// dispatchPlanSet / maintainPlanSets), never during module evaluation — same
// pattern as runOnce.ts's assessFlow/analyzeFlow cycles.
import { dispatchPlanSet, maintainPlanSets } from "./planSetBridge.js";

/** GitHub's hard cap is 65,536 chars; leave headroom for the truncation note.
 * Lives here (not githubReport.ts) so buildPlanComment can share it without an
 * import cycle; githubReport re-exports it for existing importers. */
export const COMMENT_LIMIT = 60_000;

/** Shape of `gh issue list --json number,title,body,labels`. */
export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
}

export interface LifecycleLabels {
  queued: string;
  working: string;
  done: string;
  failed: string;
  denied: string;
  planning: string;
  planReady: string;
  approved: string;
}

/** Lifecycle label names derive from the trigger label. */
export function lifecycleLabels(trigger: string): LifecycleLabels {
  return {
    queued: `${trigger}:queued`,
    working: `${trigger}:working`,
    done: `${trigger}:done`,
    failed: `${trigger}:failed`,
    denied: `${trigger}:denied`,
    planning: `${trigger}:planning`,
    planReady: `${trigger}:plan-ready`,
    approved: `${trigger}:approved`,
  };
}

/** Eligible = trigger label present AND no lifecycle label. Re-dispatch = the
 * operator removes the lifecycle label and leaves the trigger on. */
export function isEligible(issue: GhIssue, trigger: string): boolean {
  const names = new Set(issue.labels.map((l) => l.name));
  if (!names.has(trigger)) return false;
  const ll = lifecycleLabels(trigger);
  return ![ll.queued, ll.working, ll.done, ll.failed, ll.denied, ll.planning, ll.planReady].some(
    (n) => names.has(n),
  );
}

/** Parse owner/repo out of a github.com remote URL (https or ssh). Null when
 * the URL is not a github remote — the origin cross-check fails closed on it. */
export function nwoFromRemoteUrl(url: string): string | null {
  const u = url.trim();
  const m =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Normalize human repo input — bare `owner/repo` OR a github.com URL
 * (https/ssh, .git optional) — to canonical `owner/repo`. Null = unusable.
 * The dashboard's add-repo form accepts pasted URLs through this. */
export function parseRepoInput(input: string): string | null {
  const t = input.trim();
  if (t === "") return null;
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(t)) return nwoFromRemoteUrl(t);
  return /^[\w.-]+\/[\w.-]+$/.test(t) ? t : null;
}

/** Stable, collision-free ticket id for a GitHub issue. The slug keeps it
 * human-recognizable; a short hash of the RAW `owner/repo` disambiguates the
 * owner/name boundary the slug alone loses — `acme/api-x#5` and `acme-api/x#5`
 * both slug to `gh-acme-api-x-5`, which cross-wired their tickets and stranded
 * the second issue (#133). The hash is over the lowercased nwo so it agrees
 * with the case-insensitive dedup used everywhere else. */
export function githubTicketId(nwo: string, issueNumber: number, suffix?: string): string {
  const [owner, name] = nwo.split("/");
  const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  const hash = createHash("sha256").update(nwo.toLowerCase()).digest("hex").slice(0, 8);
  const base = `gh-${slug(owner)}-${slug(name)}-${hash}-${issueNumber}`;
  return suffix ? `${base}-${suffix}` : base;
}

/** Convert an eligible issue into a Junco ticket file (id + full content).
 * JSON.stringify produces valid YAML double-quoted scalars — titles and paths
 * with quotes/colons round-trip through parseTicket. */
export function issueToTicket(
  issue: GhIssue,
  repo: GithubRepoMapping,
  cfg: Config,
  parent: { title: string; body: string | null } | null,
): { id: string; content: string } {
  const id = githubTicketId(repo.nwo, issue.number);
  const kind = issue.labels.some((l) => l.name === cfg.github.askLabel) ? "ask" : "pr";

  const fm: string[] = ["---", `id: ${id}`];
  if (kind === "pr") {
    fm.push(`repo: ${JSON.stringify(repo.path)}`);
    fm.push(`pr_title: ${JSON.stringify(issue.title)}`);
  } else {
    fm.push(`workdir: ${JSON.stringify(repo.path)}`);
  }
  fm.push(
    "github:",
    `  nwo: ${JSON.stringify(repo.nwo)}`,
    `  issue: ${issue.number}`,
    `  kind: ${kind}`,
    "---",
  );

  const parts: string[] = [`# ${issue.title}`];
  const body = (issue.body ?? "").trim();
  if (body) parts.push(body);
  if (parent) {
    const pBody = (parent.body ?? "").trim();
    parts.push(
      "## Context: parent issue\n\n" +
        "_Background only — the instruction is the body above._\n\n" +
        `**${parent.title}**` +
        (pBody ? `\n\n${pBody}` : ""),
    );
  }
  return { id, content: fm.join("\n") + "\n\n" + parts.join("\n\n") + "\n" };
}

/** Materialize the PLANNING ticket for a raw PR issue: Q&A rails (workdir,
 * read-only), kind "plan", body = the full planner prompt (transparent — the
 * inbox file shows exactly what the planner was asked). */
export function buildPlanningTicket(
  issue: GhIssue,
  repo: GithubRepoMapping,
  cfg: Config,
  parent: { title: string; body: string | null } | null,
): { id: string; content: string } {
  const id = githubTicketId(repo.nwo, issue.number, "plan");
  const fm = [
    "---",
    `id: ${id}`,
    `workdir: ${JSON.stringify(repo.path)}`,
    "github:",
    `  nwo: ${JSON.stringify(repo.nwo)}`,
    `  issue: ${issue.number}`,
    "  kind: plan",
    "---",
  ];
  const prompt = buildPlannerPrompt({
    title: issue.title,
    body: issue.body ?? "",
    nwo: repo.nwo,
    parent,
    planSets: cfg.planSets.enabled,
  });
  return { id, content: fm.join("\n") + "\n\n" + prompt };
}

export const PLAN_COMMENT_MARKER = "<!-- junco:plan -->";

/** Fence tag for a plan SET (multi-ticket) comment/finalText, as opposed to the
 * single-ticket `PLAN_FENCE` ("junco-ticket"). See extractPlanSetBody. */
export const PLAN_SET_FENCE = "junco-plan";

// Mirrors ticket.ts FRONTMATTER_RE — used to STRIP a smuggled block, never to parse it.
const SMUGGLED_FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n?/;

/** Longest run of consecutive backticks at the START of any line in `text`.
 * Line-anchored is sufficient because extractPlanBody is itself line-anchored:
 * only fences that begin a line can open/close a block. */
function longestBacktickRun(text: string): number {
  let max = 0;
  for (const line of text.split("\n")) {
    const m = /^(`+)/.exec(line);
    if (m && m[1].length > max) max = m[1].length;
  }
  return max;
}

/** Line-range [openFenceIdx, closeFenceIdx] (inclusive, into `lines`) of the
 * LAST complete ```<fenceTag> block, fence-length-aware CommonMark matching:
 * an opening fence of N backticks is closed by the first later line that is a
 * run of >= N backticks with no info text, so a plan that itself contains a
 * ```bash block (the template mandates one) does not truncate at the inner
 * fence. Null = no complete block of that tag. Shared range-finder behind
 * both extractFencedBlock (content) and replaceFencedBlock (splice). */
function lastFencedBlockRange(
  lines: string[],
  fenceTag: string,
): { open: number; close: number } | null {
  const openRe = new RegExp("^(`{3,})" + fenceTag + "\\s*$");
  let last: { open: number; close: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = openRe.exec(lines[i]);
    if (!m) continue;
    const n = m[1].length;
    const closeRe = new RegExp("^`{" + n + ",}\\s*$");
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j])) {
        close = j;
        break;
      }
    }
    if (close === -1) continue; // no closer → not a complete block; ignore
    last = { open: i, close };
    i = close; // resume scanning after this block's closer
  }
  return last;
}

/** Pull the LAST complete ```<fenceTag> block out of `text` (planner finalText
 * or a plan comment — same format both places). Any frontmatter block inside
 * the fence is stripped: frontmatter is machine-owned, model output and issue
 * text can never set repo:/workdir:/tools:. Null = no usable (complete)
 * block. Shared by the single-ticket (junco-ticket), plan-set (junco-plan),
 * and patch-series (junco-patch) extractors — the last opts out of the
 * frontmatter strip via `opts.stripFrontmatter: false` (see
 * extractPatchBody). Defaults preserve today's behavior byte-for-byte for the
 * two existing callers. */
function extractFencedBlock(
  text: string,
  fenceTag: string,
  opts: { stripFrontmatter?: boolean } = {},
): string | null {
  const { stripFrontmatter = true } = opts;
  // Normalize CRLF (and lone CR) to LF first: editing the plan comment in
  // GitHub's web UI yields CRLF, and the fence match survives only via
  // incidental `\s*` tolerance while interior `\r` would otherwise leak
  // verbatim into the execution ticket and PR body (#134).
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const range = lastFencedBlockRange(lines, fenceTag);
  if (range === null) return null;
  const last = lines.slice(range.open + 1, range.close).join("\n");
  const stripped = (stripFrontmatter ? last.replace(SMUGGLED_FRONTMATTER_RE, "") : last).trim();
  return stripped === "" ? null : stripped;
}

/** Replace the LAST complete ```<fenceTag> fenced block (both delimiter lines
 * plus everything between) with a single `replacement` line, leaving the rest
 * of `text` — including any prose before or after the fence — untouched.
 * Returns `text` unchanged when no complete block of that tag exists. Used to
 * keep an apply ticket's mbox series out of a PR body / prose scan without
 * dropping the ticket's own Why/Verification sections (buildPrBody,
 * derivePrTitle, no_forbidden_phrases — see patchTicket.ts). */
export function replaceFencedBlock(text: string, fenceTag: string, replacement: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const range = lastFencedBlockRange(lines, fenceTag);
  if (range === null) return text;
  return [...lines.slice(0, range.open), replacement, ...lines.slice(range.close + 1)].join("\n");
}

/** Invisible delimiters for a parked `--as-issue` ticket body (#329). The
 * rendered plan IS the machine payload: GitHub's REST API returns an issue
 * body as raw markdown, so the second (fenced) copy #327 added bought only
 * bytes and a desync surface. The 8-hex nonce plays the role wrapInFence's
 * longest-run logic plays for fences — a body that itself quotes a
 * marker-shaped comment cannot terminate its own block. */
const TICKET_MARKER_NONCE = "[0-9a-f]{8}";

export function ticketMarkers(nonce: string): { start: string; end: string } {
  return {
    start: `<!-- junco:ticket:start:${nonce} -->`,
    end: `<!-- junco:ticket:end:${nonce} -->`,
  };
}

/** Body delimited by the LAST complete junco:ticket marker pair. Post-
 * processing is deliberately identical to extractFencedBlock's: CRLF
 * normalized (#134), a smuggled frontmatter block stripped (frontmatter is
 * machine-owned — issue text can never set repo:/workdir:/tools:), trimmed,
 * empty → null.
 *
 * Fence-aware on purpose: `extractPlanBody` (below) tries this BEFORE the
 * fence fallback, and serves three doors — the parked-issue body (markers),
 * planner plan COMMENTS (fence-only), and the planner's whole-run allText
 * (fence-only). A fenced plan that itself QUOTES a complete marker pair (a
 * plan about junco's own marker format — junco is dogfooded on junco, so
 * this is a matter of time, not a hypothetical) must never let the quoted
 * pair outrank the visible, human-approved fence: a marker line that occurs
 * inside a fenced code block is never treated as a real delimiter. An
 * unbalanced fence in the plan (the fence never closes) degrades to "no
 * marker-eligible lines" for the remainder of the scan, same as
 * extractFencedBlock's own unterminated-fence handling — no marked block →
 * fence fallback → planner route. */
function extractMarkedBlock(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  // First pass: which lines sit at the TOP level (outside any fenced code
  // block)? Only those are eligible to open or close a marker pair — a
  // marker-shaped comment quoted inside a ```-fenced example is just text.
  const atTopLevel: boolean[] = new Array(lines.length);
  let fenceLen = 0; // 0 = at top level; >0 = inside a fence of this length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenceLen === 0) {
      const open = /^(`{3,})/.exec(line);
      if (open) {
        fenceLen = open[1].length;
        atTopLevel[i] = false;
        continue;
      }
      atTopLevel[i] = true;
    } else {
      atTopLevel[i] = false;
      if (new RegExp(`^\`{${fenceLen},}\\s*$`).test(line)) fenceLen = 0;
    }
  }

  const openRe = new RegExp(`^<!--\\s*junco:ticket:start:(${TICKET_MARKER_NONCE})\\s*-->\\s*$`);
  let last: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!atTopLevel[i]) continue;
    const m = openRe.exec(lines[i]);
    if (!m) continue;
    const closeRe = new RegExp(`^<!--\\s*junco:ticket:end:${m[1]}\\s*-->\\s*$`);
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (!atTopLevel[j]) continue; // a fenced end-marker can't close this pair
      if (closeRe.test(lines[j])) {
        close = j;
        break;
      }
    }
    if (close === -1) continue; // unterminated → not a complete block; ignore
    // The extracted SPAN still includes any fenced lines verbatim (a quoted
    // example inside the outer pair rides through as literal text) — only
    // the SCAN for delimiters ignores fenced lines, not the slice itself.
    last = lines.slice(i + 1, close).join("\n");
    i = close; // resume after this block's closer
  }
  if (last === null) return null;
  const stripped = last.replace(SMUGGLED_FRONTMATTER_RE, "").trim();
  return stripped === "" ? null : stripped;
}

/** Pull the plan body out of a parked issue body: the invisible junco:ticket
 * markers (#329) first, falling back to the LAST ```junco-ticket fence in
 * `text` for issues parked by an older version (see extractFencedBlock for
 * the fence matching rules) and for planner-produced plan COMMENTS, which are
 * fence-only and never carry markers. Null = no usable (complete) plan. */
export function extractPlanBody(text: string): string | null {
  return extractMarkedBlock(text) ?? extractFencedBlock(text, PLAN_FENCE);
}

/** Pull the plan-set body out of the LAST ```junco-plan fence in `text`. See
 * extractFencedBlock for the matching rules. Null = no usable (complete)
 * plan set. */
export function extractPlanSetBody(text: string): string | null {
  return extractFencedBlock(text, PLAN_SET_FENCE);
}

/** Fence tag for an apply ticket's `git format-patch` mbox series. */
export const PATCH_FENCE = "junco-patch";

/** Pull the mbox series out of the LAST ```junco-patch fence. Unlike the plan
 * extractors this does NOT strip a leading frontmatter block: an mbox contains
 * `---` diffstat separators, and the series must reach `git am` byte-exact. */
export function extractPatchBody(text: string): string | null {
  return extractFencedBlock(text, PATCH_FENCE, { stripFrontmatter: false });
}

/** Render the ONE plan comment: marker (machine-recoverable) + instructions +
 * the plan in a fence (readable AND re-extractable). `fenceTag` selects the
 * fence (default `PLAN_FENCE` = "junco-ticket"); the plan-set bridge passes
 * `PLAN_SET_FENCE` instead. Null when the result would blow GitHub's comment
 * cap — the caller fails the plan instead of truncating the machine copy. */
export function buildPlanComment(
  planBody: string,
  opts: { issue: number; trigger: string; requireApproval: boolean; fenceTag?: string },
): string | null {
  const tag = opts.fenceTag ?? PLAN_FENCE;
  const next = opts.requireApproval
    ? `review it, then apply \`${opts.trigger}:approved\` to execute. You can EDIT this comment first — the edited plan is what runs.`
    : `it will execute on the next sweep (\`require_approval = false\`). You can still EDIT this comment before then.`;
  // Outer fence must outrun any inner fence in the plan (>= 4 backticks so the
  // template's mandatory ```bash block round-trips through the fence extractors).
  const fence = "`".repeat(Math.max(4, longestBacktickRun(planBody) + 1));
  const out =
    `${PLAN_COMMENT_MARKER}\n**Proposed plan** for #${opts.issue} — ${next}\n\n` +
    fence +
    tag +
    "\n" +
    planBody +
    "\n" +
    fence +
    "\n" +
    `\n_Re-plan: remove \`${opts.trigger}:plan-ready\` (a newer plan comment supersedes this one)._\n`;
  return out.length > COMMENT_LIMIT ? null : out;
}

// ---------------------------------------------------------------------------
// Sweep — poll watched repos, verify, materialize tickets, mark queued.
// ---------------------------------------------------------------------------

export interface BridgeState {
  /** nwo set whose lifecycle labels were ensured this process. */
  labelsEnsured: Set<string>;
  /** `${nwo}|${path}` → origin-check verdict (a mismatch disables the repo this
   * process). Keyed by path too so a watchlist hot-reload that corrects (or
   * breaks) a mapped path is re-validated instead of served from a stale nwo. */
  originOk: Map<string, boolean>;
  /** Authenticated gh login (cached) — plan comments must be self-authored. */
  login: string | null;
}

export function newBridgeState(): BridgeState {
  return { labelsEnsured: new Set(), originOk: new Map(), login: null };
}

export interface BridgeDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
  submitFn?: (cfg: Config, content: string, opts?: { idHint?: string }) => string;
  /** Outbox replay, run before the repo loop so a reconnect auto-drains
   * within one sweep. Defaults to the real flushOutbox — every caller gets
   * flush-first behavior for free unless a test overrides it. */
  flushFn?: typeof flushOutbox;
  /** Fired with the flush result right after it completes. The daemon layer
   * uses this to route metrics (mirrors how recordBridgeSweep is recorded
   * one layer up, at the bridgeSweepFn call site) without githubInbox.ts
   * importing the metrics singleton itself. */
  onFlush?: (r: FlushResult) => void;
}

const GH_TIMEOUT = 60_000;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const LABEL_SPECS: ReadonlyArray<[keyof LifecycleLabels, string, string]> = [
  ["queued", "FBCA04", "junco: queued for the worker"],
  ["working", "1D76DB", "junco: worker is on it"],
  ["done", "0E8A16", "junco: finished — see the closing comment"],
  ["failed", "B60205", "junco: failed — see the closing comment"],
  ["denied", "5319E7", "junco: trigger label applied without write permission"],
  ["planning", "C5DEF5", "junco: authoring a plan from this issue"],
  ["planReady", "D4A72C", "junco: plan posted — review the plan comment"],
  ["approved", "54AEFF", "apply AFTER reviewing the plan comment to authorize execution"],
];

async function originOkFor(
  cfg: Config,
  repo: GithubRepoMapping,
  state: BridgeState,
  gitFn: typeof git,
): Promise<boolean> {
  const key = `${repo.nwo.toLowerCase()}|${repo.path}`;
  const cached = state.originOk.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const r = await gitFn(cfg, ["-C", repo.path, "remote", "get-url", "origin"], { check: false });
    const actual = r.code === 0 ? nwoFromRemoteUrl(r.stdout.trim()) : null;
    ok = actual !== null && actual.toLowerCase() === repo.nwo.toLowerCase();
    if (!ok) {
      log.error("github bridge: mapped path origin does not match nwo; repo disabled this run", {
        nwo: repo.nwo,
        path: repo.path,
        actual,
      });
    }
  } catch (e) {
    log.error("github bridge: origin check failed; repo disabled this run", {
      nwo: repo.nwo,
      error: errMsg(e),
    });
  }
  state.originOk.set(key, ok);
  return ok;
}

async function ensureLabels(
  cfg: Config,
  nwo: string,
  state: BridgeState,
  ghFn: typeof gh,
): Promise<void> {
  if (state.labelsEnsured.has(nwo)) return;
  const ll = lifecycleLabels(cfg.github.triggerLabel);
  for (const [key, color, description] of LABEL_SPECS) {
    // --force = create-or-update, idempotent.
    await ghFn(
      cfg,
      [
        "label",
        "create",
        ll[key],
        "--repo",
        nwo,
        "--color",
        color,
        "--description",
        description,
        "--force",
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
  }
  state.labelsEnsured.add(nwo);
}

/** Who last applied `label`, and may they dispatch? Fail-closed: any
 * verification error → "unverified" (skip this sweep, retry next). Also used
 * for the approval label — `atMs` lets the caller compare against the plan
 * comment's timestamp (a stale approval that predates the current plan must
 * not authorize it). Exported for the plan-set bridge (see
 * docs/superpowers/specs/2026-08-20-plan-driven-ticket-sets-design.md), which
 * reuses the same writer/timestamp verification for a plan-SET's approval
 * label. */
export async function verifyLabelApplier(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  label: string,
  ghFn: typeof gh,
): Promise<{ verdict: "ok" | "denied" | "unverified"; atMs: number | null }> {
  try {
    const ev = await ghFn(
      cfg,
      [
        "api",
        "--paginate",
        `repos/${nwo}/issues/${issueNumber}/events`,
        "--jq",
        '.[] | select(.event == "labeled") | {actor: .actor.login, label: .label.name, created_at: .created_at}',
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    const events = ev.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { actor: string; label: string; created_at?: string });
    const last = [...events].reverse().find((l) => l.label === label);
    if (!last) return { verdict: "unverified", atMs: null };
    const perm = await ghFn(
      cfg,
      ["api", `repos/${nwo}/collaborators/${last.actor}/permission`, "--jq", ".permission"],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    const p = perm.stdout.trim();
    const atMs = last.created_at ? Date.parse(last.created_at) : null;
    // The legacy permission field maps maintain→write, so admin|write covers it.
    return { verdict: p === "admin" || p === "write" ? "ok" : "denied", atMs };
  } catch (e) {
    log.warn("github bridge: label-applier verification failed; skipping this sweep", {
      nwo,
      issue: issueNumber,
      label,
      error: errMsg(e),
    });
    return { verdict: "unverified", atMs: null };
  }
}

/** Sub-issue parent lookup (GraphQL `parent` field). Non-fatal: null on any
 * error. Carries the parent's own coordinates (sub-issues may live in another
 * repo) so the caller can run the body-vouching check against the right issue;
 * a parent without them is unvettable and reads as absent. */
async function fetchParent(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  ghFn: typeof gh,
): Promise<{ nwo: string; number: number; title: string; body: string | null } | null> {
  const [owner, name] = nwo.split("/");
  try {
    const r = await ghFn(
      cfg,
      [
        "api",
        "graphql",
        "-f",
        "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){parent{number repository{nameWithOwner} title body}}}}",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${issueNumber}`,
        "--jq",
        ".data.repository.issue.parent",
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    const out = r.stdout.trim();
    if (!out || out === "null") return null;
    const p = JSON.parse(out) as {
      number?: unknown;
      repository?: { nameWithOwner?: unknown };
      title?: unknown;
      body?: unknown;
    };
    const pNwo = p.repository?.nameWithOwner;
    return typeof p.title === "string" && typeof p.number === "number" && typeof pNwo === "string"
      ? {
          nwo: pNwo,
          number: p.number,
          title: p.title,
          body: typeof p.body === "string" ? p.body : null,
        }
      : null;
  } catch {
    return null; // background context only — never blocks dispatch
  }
}

/** The issue body's last-edit time (GraphQL `lastEditedAt`), in epoch ms, or
 * null when the body was never edited. `verified: false` on any lookup failure
 * OR an unparseable timestamp, so the body-vouching gate can fail closed — a
 * body we cannot vet is never dispatched. lastEditedAt (a true body-edit
 * timestamp, unlike the coarse `updatedAt`, which also bumps on comments, label
 * changes, and the documented re-dispatch gesture) is the precise signal and is
 * GraphQL-only — `gh issue list --json` does not expose it. */
async function fetchIssueLastEdited(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  ghFn: typeof gh,
): Promise<{ verified: true; lastEditedMs: number | null } | { verified: false }> {
  const [owner, name] = nwo.split("/");
  try {
    const r = await ghFn(
      cfg,
      [
        "api",
        "graphql",
        "-f",
        "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){lastEditedAt}}}",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${issueNumber}`,
        "--jq",
        ".data.repository.issue.lastEditedAt",
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    const out = r.stdout.trim();
    if (!out || out === "null") return { verified: true, lastEditedMs: null };
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? { verified: true, lastEditedMs: ms } : { verified: false };
  } catch (e) {
    log.warn("github bridge: issue lastEditedAt lookup failed", {
      nwo,
      issue: issueNumber,
      error: errMsg(e),
    });
    return { verified: false };
  }
}

async function viewerLogin(cfg: Config, state: BridgeState, ghFn: typeof gh): Promise<string> {
  if (state.login === null) {
    const r = await ghFn(cfg, ["api", "user", "--jq", ".login"], {
      timeoutMs: GH_TIMEOUT,
      retryNetwork: true,
    });
    state.login = r.stdout.trim();
  }
  return state.login;
}

/** Latest plan comment AUTHORED BY the bridge's own login — a contributor's
 * forged marker comment is never recoverable. Null = nothing usable.
 * updatedAtMs (NaN when missing/unparseable — the approval gate fails closed
 * on it) lets the caller bind an approval to the comment's CURRENT content:
 * GitHub bumps updated_at on every edit while created_at stays fixed, so an
 * edit after approval is only visible through updated_at. Exported for the
 * plan-set bridge (see docs/superpowers/specs/2026-08-20-plan-driven-ticket-
 * sets-design.md), which recovers its own-authored plan-set comment the same
 * way. */
export async function findOwnPlanComment(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  login: string,
  ghFn: typeof gh,
): Promise<{ body: string; createdAtMs: number; updatedAtMs: number } | null> {
  const r = await ghFn(
    cfg,
    [
      "api",
      "--paginate",
      `repos/${nwo}/issues/${issueNumber}/comments`,
      "--jq",
      ".[] | {author: .user.login, body: .body, created_at: .created_at, updated_at: .updated_at}",
    ],
    { timeoutMs: GH_TIMEOUT, retryNetwork: true },
  );
  let found: { body: string; createdAtMs: number; updatedAtMs: number } | null = null;
  for (const line of r.stdout.trim().split("\n").filter(Boolean)) {
    const c = JSON.parse(line) as {
      author: string;
      body: string;
      created_at: string;
      updated_at?: string;
    };
    if (c.author === login && c.body.includes(PLAN_COMMENT_MARKER)) {
      found = {
        body: c.body,
        createdAtMs: Date.parse(c.created_at),
        updatedAtMs: c.updated_at === undefined ? NaN : Date.parse(c.updated_at),
      }; // last wins
    }
  }
  return found;
}

/** Is a ticket with this id currently IN FLIGHT in the local queue? Shared by
 * all three dispatch paths (ask, planning, execution): each submits BEFORE
 * marking the issue, so a crash — or a swallowed label-add failure — between
 * the two leaves the issue eligible while the ticket lives on. Scans ONLY
 * inbox/ and processing/ for `${id}.md` or a claim-prefixed `*__${id}.md`; a
 * missing dir (ENOENT) counts as absent. Both dirs matter: once the worker
 * CLAIMS the ticket into processing/, submitTicket's inbox-filename collision
 * no longer fires, and the whole run duration is a duplicate-submit window.
 * done/ and failed/ are deliberately NOT scanned: a finalized ticket there
 * belongs to a PREVIOUS cycle, and counting it would wedge the documented
 * re-cycle gesture (remove junco:failed → fresh plan → fresh approval) by
 * skipping the new submit while still flipping labels. Already-dispatched
 * issues are normally short-circuited earlier by the lifecycle-label bail. */
function ticketInFlight(cfg: Config, id: string): boolean {
  const paths = queuePaths(cfg);
  const exact = `${id}.md`;
  const claimed = `__${id}.md`;
  for (const dir of [paths.inbox, paths.processing]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // ENOENT or unreadable → nothing here
    }
    if (entries.some((e) => e === exact || e.endsWith(claimed))) return true;
  }
  return false;
}

/** Bounded timeout carried from `junco submit --as-issue` in the VOUCHED issue
 * body (spec 2026-08-31-dispatch-hardening-design.md). Clamped [1, 480] on
 * both write and read; the body is covered by the edited-after-label guard,
 * and the clamp bounds hostile edits regardless. */
const TIMEOUT_MARKER_RE = /<!--\s*junco:timeout:(\d{1,4})\s*-->/g;

export function timeoutMarker(n: number): string {
  return `<!-- junco:timeout:${Math.min(480, Math.max(1, Math.round(n)))} -->`;
}

/** Takes the LAST marker match, mirroring extractFencedBlock's "newer plan
 * supersedes" rule for the junco-ticket fence — a hand-edited body carrying
 * two park generations should have its fence and timeout agree on which one
 * is current. Only reachable by manual edit; the clamp bounds either way. */
export function parseTimeoutMarker(text: string): number | null {
  const matches = [...text.matchAll(TIMEOUT_MARKER_RE)];
  if (matches.length === 0) return null;
  const n = Number(matches[matches.length - 1][1]);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(480, Math.round(n));
}

/** Execution ticket from a reviewed plan: machine frontmatter (id, mapped
 * repo path, provenance) + the plan body verbatim. pr_title omitted —
 * derivePrTitle picks the plan's H1. `opts.timeoutMinutes` stamps a
 * `timeout_minutes:` frontmatter line when the issue-body fence door carried
 * one (parseTimeoutMarker) — the plan-comment door never passes it, since a
 * planner-produced plan comment carries no marker. */
export function buildExecutionTicket(
  issueNumber: number,
  repo: GithubRepoMapping,
  planBody: string,
  opts: { timeoutMinutes?: number | null } = {},
): { id: string; content: string } {
  const id = githubTicketId(repo.nwo, issueNumber);
  const fm = ["---", `id: ${id}`, `repo: ${JSON.stringify(repo.path)}`];
  const tm = opts.timeoutMinutes;
  if (typeof tm === "number" && Number.isFinite(tm) && tm >= 1) {
    fm.push(`timeout_minutes: ${Math.min(480, Math.round(tm))}`);
  }
  fm.push(
    "github:",
    `  nwo: ${JSON.stringify(repo.nwo)}`,
    `  issue: ${issueNumber}`,
    "  kind: pr",
    "---",
  );
  return { id, content: fm.join("\n") + "\n\n" + planBody + "\n" };
}

/** Post a single issue comment via `gh issue comment --body-file` (avoids
 * shell-escaping the body). Mirrors githubReport.ts's postComment tempfile
 * pattern — including embedding the outbox idempotency marker
 * (withCommentMarker) in the posted body, so a lost-ack replay of a queued
 * comment op is deduped by the next flush and never double-posts (#132) —
 * a standalone door-side helper since githubInbox.ts has no reporter-style
 * closure to hang a comment poster off of. Used by the plan-set dispatch
 * door to post a compile-failure summary. `body` is the RAW (unmarked) text:
 * callers pass the same raw body to the paired outbox `{ kind: "comment" }`
 * op, so tryOrEnqueue/flush compute the identical content-derived marker on
 * both the live path and a queued replay. */
async function postIssueComment(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  body: string,
  ghFn: typeof gh,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "junco-ghc-"));
  const file = join(dir, "comment.md");
  writeFileSync(file, withCommentMarker(nwo, issueNumber, body), "utf8");
  try {
    await ghFn(cfg, ["issue", "comment", String(issueNumber), "--repo", nwo, "--body-file", file], {
      timeoutMs: GH_TIMEOUT,
      retryNetwork: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Outbox-aware guard: on a network-shaped failure, `fn`'s side effect is
 * parked in the durable outbox (`op`) instead of being lost; any other
 * failure keeps the old best-effort contract — warn and swallow, since the
 * next sweep re-derives and retries state from GitHub reality. Local copy of
 * githubReport.ts's guardOrQueue idiom (never import reporter internals —
 * this module has no standing reporter-callback context to hang it off of). */
async function guardOrQueue(
  cfg: Config,
  label: string,
  id: string,
  op: OutboxOp,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await tryOrEnqueue(cfg, "bridge", op, fn);
  } catch (e) {
    log.warn(`github bridge: ${label} failed (issue state on GitHub may be stale)`, {
      id,
      error: errMsg(e),
    });
  }
}

/** argv for one `gh issue edit` label swap. Owns the approval-cleanup
 * invariant (#357): a swap that takes an issue OUT of `plan-ready` also
 * strips `approved` in requireApproval mode — a lingering approval label is
 * exactly what verifyLabelApplier would vouch a LATER plan against. Every
 * plan-ready transition builds its argv here rather than by hand, so a new
 * transition cannot forget the clause. Argv order is add, then remove(s). */
export function labelSwapArgs(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  swap: { add?: string; remove?: string },
): string[] {
  const ll = lifecycleLabels(cfg.github.triggerLabel);
  const args = ["issue", "edit", String(issueNumber), "--repo", nwo];
  if (swap.add !== undefined) args.push("--add-label", swap.add);
  if (swap.remove !== undefined) args.push("--remove-label", swap.remove);
  if (swap.remove === ll.planReady && cfg.github.requireApproval) {
    args.push("--remove-label", ll.approved);
  }
  return args;
}

/** The seams processIssue reaches for, resolved once by pollGithubInbox. */
type IssueDeps = Required<Pick<BridgeDeps, "ghFn" | "submitFn">>;

/**
 * One issue of a sweep: the plan-ready door (approval → execution ticket)
 * first, then the trigger-label doors (denied / ask / issue-body fence /
 * plan set / planner). Resolves true when a ticket was dispatched (the
 * sweep's `bridged` count), false on every skip. Throws propagate to the
 * caller's per-issue catch; the only catch here is the pre-existing
 * approval-scan one, which contains the plan-ready door on its own.
 */
export async function processIssue(
  cfg: Config,
  repo: GithubRepoMapping,
  issue: GhIssue,
  state: BridgeState,
  deps: IssueDeps,
): Promise<boolean> {
  const { ghFn, submitFn } = deps;
  const trigger = cfg.github.triggerLabel;
  const ll = lifecycleLabels(trigger);
  const names = new Set(issue.labels.map((l) => l.name));
  if (names.has(ll.planReady)) {
    try {
      // Already dispatched on a prior sweep (a lifecycle label proves the
      // execution ticket left the gate) but the label swap that should
      // have cleared plan-ready/approved was lost. Re-attempt ONLY that
      // cleanup — never re-submit — and move on.
      if ([ll.queued, ll.working, ll.done, ll.failed].some((n) => names.has(n))) {
        await ghFn(cfg, labelSwapArgs(cfg, repo.nwo, issue.number, { remove: ll.planReady }), {
          timeoutMs: GH_TIMEOUT,
          retryNetwork: true,
        });
        log.info("github bridge: plan-ready lingering after dispatch; cleaned up labels", {
          nwo: repo.nwo,
          issue: issue.number,
        });
        return false;
      }
      const login = await viewerLogin(cfg, state, ghFn);
      const comment = await findOwnPlanComment(cfg, repo.nwo, issue.number, login, ghFn);
      if (!comment) {
        log.warn("github bridge: plan-ready but no own-authored plan comment", {
          nwo: repo.nwo,
          issue: issue.number,
        });
        return false;
      }
      if (cfg.github.requireApproval) {
        if (!names.has(ll.approved)) return false; // awaiting review
        const approval = await verifyLabelApplier(cfg, repo.nwo, issue.number, ll.approved, ghFn);
        if (approval.verdict !== "ok") {
          log.warn("github bridge: approval not by a verified writer; ignoring", {
            nwo: repo.nwo,
            issue: issue.number,
          });
          return false;
        }
        // Fail closed on an unparseable timestamp on EITHER side: an
        // approval only counts if it is strictly newer than BOTH the
        // plan comment's creation AND its last edit (updated_at). The
        // body that executes is read fresh below, so an edit AFTER the
        // approval label must invalidate it — otherwise an injected
        // plan would run under the stale approval.
        if (
          !(
            Number.isFinite(comment.createdAtMs) &&
            Number.isFinite(comment.updatedAtMs) &&
            approval.atMs !== null &&
            approval.atMs > comment.createdAtMs &&
            approval.atMs > comment.updatedAtMs
          )
        ) {
          log.warn(
            "github bridge: approval predates the plan comment or its latest edit; re-apply it",
            {
              nwo: repo.nwo,
              issue: issue.number,
            },
          );
          return false;
        }
      }
      // Layer 2: a junco-plan fence (multi-task set) takes precedence
      // when the feature is on; the single-ticket junco-ticket path
      // below is unchanged and still handles every pre-existing plan
      // comment.
      const setBody = cfg.planSets.enabled ? extractPlanSetBody(comment.body) : null;
      if (setBody !== null) {
        const dr = dispatchPlanSet(cfg, repo, issue.number, setBody, new Date().toISOString(), {
          submitFn,
        });
        if (!dr.ok) {
          const errList = dr.errors.map((e) => `- ${e}`).join("\n");
          // Unlike the supersede failure comment (planSetBridge.ts),
          // "edit + re-approve" is a dead end here: this branch already
          // removed plan-ready and flips to junco:failed below, so the
          // dispatch branch (which requires plan-ready) can never see a
          // re-approval — and re-adding plan-ready by hand while
          // junco:failed stands gets stripped by the lingering-label
          // cleanup on the next sweep. Mirror the single-ticket failure
          // comment's working gesture instead (githubReport.ts).
          const failureComment =
            `**Junco could not compile this plan set** — nothing was dispatched.\n\n${errList}\n\n` +
            `_Remove the \`${ll.failed}\` label to re-plan from scratch._\n`;
          const failId = `${repo.nwo}#${issue.number}`;
          const failRemove = [ll.planReady, ...(cfg.github.requireApproval ? [ll.approved] : [])];
          // Labels FIRST, then the comment — the inverse of the
          // reporter's comment-first ordering. There, the comment is
          // the valuable artifact worth protecting; here, flipping to
          // junco:failed is what BOUNDS re-entry into this branch: a
          // lost label swap would otherwise leave plan-ready+approved
          // standing, and every subsequent sweep would re-dispatch
          // this same compile failure and post another failure
          // comment, unbounded. The compile errors also land in the
          // daemon log either way, so the comment is comparatively
          // cheap to lose to an outbox queue/warn-and-swallow.
          await guardOrQueue(
            cfg,
            "plan set failure labels",
            failId,
            {
              kind: "labels",
              nwo: repo.nwo,
              issue: issue.number,
              add: [ll.failed],
              remove: failRemove,
            },
            async () => {
              await ghFn(
                cfg,
                labelSwapArgs(cfg, repo.nwo, issue.number, {
                  add: ll.failed,
                  remove: ll.planReady,
                }),
                { timeoutMs: GH_TIMEOUT, retryNetwork: true },
              );
            },
          );
          await guardOrQueue(
            cfg,
            "plan set failure comment",
            failId,
            { kind: "comment", nwo: repo.nwo, issue: issue.number, body: failureComment },
            () => postIssueComment(cfg, repo.nwo, issue.number, failureComment, ghFn),
          );
          return false;
        }
        // I3 (#298 review round 2): a per-child submit throw is now
        // CONTAINED inside dispatchPlanSet/submitPlanSet rather than
        // propagating. dispatchPlanSet ALSO seeds the record's
        // `pendingFanout` from `stranded` (fix wave C, item 1) — THAT
        // is the actual recovery: the next `maintainPlanSets` sweep's
        // `drainPendingFanout` resubmits straight from the record,
        // independent of what labels stand on this issue. Still leave
        // `plan-ready` (and, in requireApproval mode, `approved`)
        // standing rather than swapping to `junco:queued` here — this
        // is belt-and-suspenders, not load-bearing: it only keeps this
        // door itself from reporting the set as cleanly dispatched
        // while a child hasn't actually landed yet. (A prior version
        // of this comment claimed leaving `plan-ready` standing was
        // BY ITSELF sufficient to guarantee a retry — it is not: the
        // SAME sweep's `maintainPlanSets` unconditionally sets a
        // lifecycle label on the fresh record regardless of what this
        // branch does, so by the NEXT sweep the "already dispatched"
        // branch above would see `plan-ready` next to a lifecycle
        // label, strip both, and return — never re-dispatching.
        // Before `pendingFanout` was seeded on this door, nothing else
        // would have resubmitted the child either — it was lost for
        // good.)
        if (dr.stranded.length > 0) {
          log.warn(
            "github bridge: plan set dispatch stranded child submit(s); leaving plan-ready for retry",
            { nwo: repo.nwo, issue: issue.number, stranded: dr.stranded },
          );
          return false;
        }
        // Same submit-before-label ordering as the single path.
        await ghFn(
          cfg,
          labelSwapArgs(cfg, repo.nwo, issue.number, { add: ll.queued, remove: ll.planReady }),
          { timeoutMs: GH_TIMEOUT, retryNetwork: true },
        );
        log.info("github bridge: approved plan set dispatched", {
          nwo: repo.nwo,
          issue: issue.number,
        });
        return true;
      }
      const planBody = extractPlanBody(comment.body);
      if (!planBody) {
        log.error("github bridge: plan comment has no extractable plan; fix the comment", {
          nwo: repo.nwo,
          issue: issue.number,
        });
        return false;
      }
      const t = buildExecutionTicket(issue.number, repo, planBody);
      // A prior sweep may have queued this ticket then crashed before the
      // label swap. Detect the existing file and skip re-submit, going
      // straight to the (idempotent) label swap.
      if (ticketInFlight(cfg, t.id)) {
        log.info("github bridge: execution ticket already in local queue; re-marking", {
          id: t.id,
        });
      } else {
        try {
          submitFn(cfg, t.content, { idHint: t.id });
        } catch (e) {
          if (!errMsg(e).includes("already queued")) throw e;
          log.info("github bridge: execution ticket already queued; re-marking", {
            id: t.id,
          });
        }
      }
      await ghFn(
        cfg,
        labelSwapArgs(cfg, repo.nwo, issue.number, { add: ll.queued, remove: ll.planReady }),
        { timeoutMs: GH_TIMEOUT, retryNetwork: true },
      );
      log.info("github bridge: approved plan dispatched for execution", {
        nwo: repo.nwo,
        issue: issue.number,
        id: t.id,
      });
      return true;
    } catch (e) {
      log.warn("github bridge: approval scan failed for issue; retrying next sweep", {
        nwo: repo.nwo,
        issue: issue.number,
        error: errMsg(e),
      });
    }
    return false;
  }
  if (!isEligible(issue, trigger)) return false;
  const verdict = await verifyLabelApplier(cfg, repo.nwo, issue.number, trigger, ghFn);
  if (verdict.verdict === "unverified") return false; // fail-closed; retry next sweep
  if (verdict.verdict === "denied") {
    await ghFn(
      cfg,
      ["issue", "edit", String(issue.number), "--repo", repo.nwo, "--add-label", ll.denied],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    log.warn("github bridge: trigger label applied without write permission", {
      nwo: repo.nwo,
      issue: issue.number,
    });
    return false;
  }
  // The trigger label vouches the issue body AS IT WAS WHEN LABELED. A
  // zero-permission author can edit the body between labeling and this
  // sweep; the ask/plan dispatch below reads the CURRENT body, so an
  // edit after the vouching label would auto-run (ask) or auto-post a
  // plan (plan path) an un-approved instruction. Refuse if the body was
  // edited after the label event — re-apply the trigger to re-vouch.
  // Fail closed if we can't establish either timestamp. Mirrors the
  // plan-comment postdate defense on the approval path above (#130).
  const edited = await fetchIssueLastEdited(cfg, repo.nwo, issue.number, ghFn);
  if (
    !edited.verified ||
    verdict.atMs === null ||
    (edited.lastEditedMs !== null && edited.lastEditedMs > verdict.atMs)
  ) {
    log.warn(
      "github bridge: issue body edited after the trigger label (or unverifiable); re-apply the label to re-vouch",
      { nwo: repo.nwo, issue: issue.number },
    );
    return false;
  }
  const isAsk = issue.labels.some((l) => l.name === cfg.github.askLabel);
  // junco-plan fence: a multi-task set dispatches through the plan-set
  // compiler, mirroring the approval-comment door. Checked before the
  // single-ticket fence, same precedence as the comment path. Gated on
  // planSets.enabled exactly like that path — disabled, the fence is
  // invisible and the issue falls through to the planner.
  const fenceSet = isAsk || !cfg.planSets.enabled ? null : extractPlanSetBody(issue.body ?? "");
  if (fenceSet !== null) {
    const dr = dispatchPlanSet(cfg, repo, issue.number, fenceSet, new Date().toISOString());
    if (!dr.ok) {
      const errList = dr.errors.map((e) => `- ${e}`).join("\n");
      const failureComment =
        `**Junco could not compile this plan set** — nothing was dispatched.\n\n${errList}\n\n` +
        `_Remove the \`${ll.failed}\` label and re-apply the \`${cfg.github.triggerLabel}\` label to retry._\n`;
      const failId = `${repo.nwo}#${issue.number}`;
      await guardOrQueue(
        cfg,
        "issue plan set failure labels",
        failId,
        {
          kind: "labels",
          nwo: repo.nwo,
          issue: issue.number,
          add: [ll.failed],
          remove: [],
        },
        async () => {
          await ghFn(
            cfg,
            ["issue", "edit", String(issue.number), "--repo", repo.nwo, "--add-label", ll.failed],
            { timeoutMs: GH_TIMEOUT, retryNetwork: true },
          );
        },
      );
      await guardOrQueue(
        cfg,
        "issue plan set failure comment",
        failId,
        { kind: "comment", nwo: repo.nwo, issue: issue.number, body: failureComment },
        () => postIssueComment(cfg, repo.nwo, issue.number, failureComment, ghFn),
      );
      return false;
    }
    await ghFn(
      cfg,
      ["issue", "edit", String(issue.number), "--repo", repo.nwo, "--add-label", ll.queued],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    log.info("github bridge: issue-body plan set dispatched", {
      nwo: repo.nwo,
      issue: issue.number,
    });
    return true;
  }
  // Issue-as-inbox door (spec 2026-08-21): a vouched body carrying a
  // junco-ticket fence queues verbatim — the planner is only the fence
  // PRODUCER for issues that arrive without one. Ask wins over a fence
  // (ask rails are prose-in, read-only). The edited-after-label guard
  // above vouches the body this fence is read from.
  const fenceTicket = isAsk ? null : extractPlanBody(issue.body ?? "");
  const carriedTimeout = fenceTicket !== null ? parseTimeoutMarker(issue.body ?? "") : null;
  let parent =
    isAsk || fenceTicket !== null ? null : await fetchParent(cfg, repo.nwo, issue.number, ghFn);
  // The trigger label vouched the CHILD body; the parent is a different
  // issue with a different author whose body also flows into the
  // planner prompt. Apply the same edited-after-label check to it, but
  // a failed check drops the (background-only) context rather than
  // refusing the child — the child was vouched on its own (#342).
  if (parent !== null) {
    const pEdited = await fetchIssueLastEdited(cfg, parent.nwo, parent.number, ghFn);
    if (
      !pEdited.verified ||
      (pEdited.lastEditedMs !== null && pEdited.lastEditedMs > verdict.atMs)
    ) {
      log.warn(
        "github bridge: parent issue body edited after the trigger label (or unverifiable); dropping parent context",
        { nwo: repo.nwo, issue: issue.number, parent: `${parent.nwo}#${parent.number}` },
      );
      parent = null;
    }
  }
  const t = isAsk
    ? issueToTicket(issue, repo, cfg, null)
    : fenceTicket !== null
      ? buildExecutionTicket(issue.number, repo, fenceTicket, {
          timeoutMinutes: carriedTimeout,
        })
      : buildPlanningTicket(issue, repo, cfg, parent);
  const stateLabel = isAsk || fenceTicket !== null ? ll.queued : ll.planning;
  // Same in-flight guard as the execution path: a prior sweep may have
  // submitted this ticket and then lost the label add (crash, or a
  // non-network gh failure swallowed by the per-issue catch). Once the
  // worker claims it into processing/, submitTicket's inbox collision
  // no longer fires — detect the file and skip straight to the
  // (idempotent) label marking instead of double-running the ticket.
  if (ticketInFlight(cfg, t.id)) {
    log.info("github bridge: ticket already in local queue; re-marking", { id: t.id });
  } else {
    try {
      submitFn(cfg, t.content, { idHint: t.id });
    } catch (e) {
      if (!errMsg(e).includes("already queued")) throw e;
      log.info("github bridge: ticket already queued; re-marking", { id: t.id });
    }
  }
  await ghFn(
    cfg,
    ["issue", "edit", String(issue.number), "--repo", repo.nwo, "--add-label", stateLabel],
    { timeoutMs: GH_TIMEOUT, retryNetwork: true },
  );
  log.info("github bridge: dispatched issue", {
    nwo: repo.nwo,
    issue: issue.number,
    id: t.id,
    kind: isAsk ? "ask" : fenceTicket !== null ? "fence" : "plan",
  });
  return true;
}

/**
 * One bridge sweep across all configured repos. Failures are contained at the
 * repo and issue level — the queue never depends on GitHub being up. Ordering
 * per issue: submit BEFORE label, so a crash between the two self-heals (the
 * next sweep re-submits, hits the duplicate guard, and re-applies the label).
 *
 * Flush-first: the outbox is replayed BEFORE the repo/issue loop, so a
 * reconnect after an outage auto-drains within a single sweep instead of
 * waiting on whatever unrelated GitHub call happens to run next. flushOutbox
 * is designed to never throw, but it's guarded here anyway (the sweep's usual
 * error posture — contained, logged, never fatal) and its offline-ness never
 * gates the rest of the sweep: an offline flush leaves the per-repo/per-issue
 * try/catches below to absorb whatever GitHub calls also fail.
 */
export async function pollGithubInbox(
  cfg: Config,
  state: BridgeState,
  deps: BridgeDeps = {},
): Promise<number> {
  const ghFn = deps.ghFn ?? gh;
  const gitFn = deps.gitFn ?? git;
  const submitFn = deps.submitFn ?? submitTicket;
  const flushFn = deps.flushFn ?? flushOutbox;
  const trigger = cfg.github.triggerLabel;

  try {
    const fr = await flushFn(cfg);
    deps.onFlush?.(fr);
  } catch (e) {
    log.warn("github bridge: outbox flush failed; continuing sweep", { error: errMsg(e) });
  }
  let bridged = 0;

  for (const repo of resolveWatchedRepos(cfg)) {
    try {
      if (!(await originOkFor(cfg, repo, state, gitFn))) continue;
      await ensureLabels(cfg, repo.nwo, state, ghFn);
      const list = await ghFn(
        cfg,
        [
          "issue",
          "list",
          "--repo",
          repo.nwo,
          "--label",
          trigger,
          "--state",
          "open",
          "--limit",
          "100",
          "--json",
          "number,title,body,labels",
        ],
        { timeoutMs: GH_TIMEOUT, retryNetwork: true },
      );
      const issues = JSON.parse(list.stdout) as GhIssue[];

      for (const issue of issues) {
        try {
          if (await processIssue(cfg, repo, issue, state, { ghFn, submitFn })) bridged++;
        } catch (e) {
          log.warn("github bridge: issue skipped", {
            nwo: repo.nwo,
            issue: issue.number,
            error: errMsg(e),
          });
        }
      }
    } catch (e) {
      log.warn("github bridge: repo sweep failed; queue unaffected", {
        nwo: repo.nwo,
        error: errMsg(e),
      });
    }
  }

  // Sweep-driven plan-set maintenance (dashboard/labels/degraded comment):
  // once per sweep, after the repo/issue loop, so it runs on the same
  // cadence regardless of which (if any) repos had eligible issues this
  // round. Contained like everything else here — a maintenance bug must
  // never take the queue down with it.
  if (cfg.planSets.enabled) {
    try {
      await maintainPlanSets(cfg, { ghFn });
    } catch (e) {
      log.warn("plan-set maintenance failed; queue unaffected", { error: errMsg(e) });
    }
  }

  return bridged;
}
