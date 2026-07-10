/**
 * GitHub → inbox bridge (dispatch side of GitHub-integrated mode).
 *
 * Design: docs/superpowers/specs/2026-07-02-github-inbox-design.md.
 * Issues are SNAPSHOTS: the labeled body is copied once into an ordinary
 * ticket via submitTicket; the existing queue machinery runs unchanged from
 * there. Lifecycle labels on GitHub mirror local state — local done//failed/
 * plus the PR are the source of truth.
 */

import { readdirSync } from "node:fs";
import type { Config, GithubRepoMapping } from "./types.js";
import { gh, git } from "./git.js";
import { queuePaths } from "./config.js";
import { submitTicket } from "./dispatch.js";
import { log } from "./logging.js";
import { PLAN_FENCE, buildPlannerPrompt } from "./planPrompt.js";
import { resolveWatchedRepos } from "./watchlist.js";
import { flushOutbox, type FlushResult } from "./githubOutbox.js";

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

/** Convert an eligible issue into a Junco ticket file (id + full content).
 * JSON.stringify produces valid YAML double-quoted scalars — titles and paths
 * with quotes/colons round-trip through parseTicket. */
export function issueToTicket(
  issue: GhIssue,
  repo: GithubRepoMapping,
  cfg: Config,
  parent: { title: string; body: string | null } | null,
): { id: string; content: string } {
  const [owner, name] = repo.nwo.split("/");
  const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  const id = `gh-${slug(owner)}-${slug(name)}-${issue.number}`;
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
  parent: { title: string; body: string | null } | null,
): { id: string; content: string } {
  const [owner, name] = repo.nwo.split("/");
  const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  const id = `gh-${slug(owner)}-${slug(name)}-${issue.number}-plan`;
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
  });
  return { id, content: fm.join("\n") + "\n\n" + prompt };
}

export const PLAN_COMMENT_MARKER = "<!-- junco:plan -->";

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

/** Pull the plan body out of the LAST ```junco-ticket fence in `text` (planner
 * finalText or a plan comment — same format both places). Fence-length-aware
 * CommonMark matching: an opening fence of N backticks is closed by the first
 * later line that is a run of >= N backticks with no info text, so a plan that
 * itself contains a ```bash block (the template mandates one) does not truncate
 * at the inner fence. Any frontmatter block inside the fence is stripped:
 * frontmatter is machine-owned, model output and issue text can never set
 * repo:/workdir:/tools:. Null = no usable (complete) plan. */
export function extractPlanBody(text: string): string | null {
  // Normalize CRLF (and lone CR) to LF first: editing the plan comment in
  // GitHub's web UI yields CRLF, and the fence match survives only via
  // incidental `\s*` tolerance while interior `\r` would otherwise leak
  // verbatim into the execution ticket and PR body (#134).
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const openRe = new RegExp("^(`{3,})" + PLAN_FENCE + "\\s*$");
  let last: string | null = null;
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
    last = lines.slice(i + 1, close).join("\n");
    i = close; // resume scanning after this block's closer
  }
  if (last === null) return null;
  const stripped = last.replace(SMUGGLED_FRONTMATTER_RE, "").trim();
  return stripped === "" ? null : stripped;
}

/** Render the ONE plan comment: marker (machine-recoverable) + instructions +
 * the plan in a fence (readable AND re-extractable). Null when the result
 * would blow GitHub's comment cap — the caller fails the plan instead of
 * truncating the machine copy. */
export function buildPlanComment(
  planBody: string,
  opts: { issue: number; trigger: string; requireApproval: boolean },
): string | null {
  const next = opts.requireApproval
    ? `review it, then apply \`${opts.trigger}:approved\` to execute. You can EDIT this comment first — the edited plan is what runs.`
    : `it will execute on the next sweep (\`require_approval = false\`). You can still EDIT this comment before then.`;
  // Outer fence must outrun any inner fence in the plan (>= 4 backticks so the
  // template's mandatory ```bash block round-trips through extractPlanBody).
  const fence = "`".repeat(Math.max(4, longestBacktickRun(planBody) + 1));
  const out =
    `${PLAN_COMMENT_MARKER}\n**Proposed plan** for #${opts.issue} — ${next}\n\n` +
    fence +
    PLAN_FENCE +
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
 * not authorize it). */
async function verifyLabelApplier(
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

/** Sub-issue parent lookup (GraphQL `parent` field). Non-fatal: null on any error. */
async function fetchParent(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  ghFn: typeof gh,
): Promise<{ title: string; body: string | null } | null> {
  const [owner, name] = nwo.split("/");
  try {
    const r = await ghFn(
      cfg,
      [
        "api",
        "graphql",
        "-f",
        "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){parent{title body}}}}",
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
    const p = JSON.parse(out) as { title?: unknown; body?: unknown };
    return typeof p.title === "string"
      ? { title: p.title, body: typeof p.body === "string" ? p.body : null }
      : null;
  } catch {
    return null; // background context only — never blocks dispatch
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
 * edit after approval is only visible through updated_at. */
async function findOwnPlanComment(
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

/** Execution ticket from a reviewed plan: machine frontmatter (id, mapped
 * repo path, provenance) + the plan body verbatim. pr_title omitted —
 * derivePrTitle picks the plan's H1. */
export function buildExecutionTicket(
  issueNumber: number,
  repo: GithubRepoMapping,
  planBody: string,
): { id: string; content: string } {
  const [owner, name] = repo.nwo.split("/");
  const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  const id = `gh-${slug(owner)}-${slug(name)}-${issueNumber}`;
  const fm = [
    "---",
    `id: ${id}`,
    `repo: ${JSON.stringify(repo.path)}`,
    "github:",
    `  nwo: ${JSON.stringify(repo.nwo)}`,
    `  issue: ${issueNumber}`,
    "  kind: pr",
    "---",
  ];
  return { id, content: fm.join("\n") + "\n\n" + planBody + "\n" };
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
  const ll = lifecycleLabels(trigger);

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
          const names = new Set(issue.labels.map((l) => l.name));
          if (names.has(ll.planReady)) {
            try {
              // Already dispatched on a prior sweep (a lifecycle label proves the
              // execution ticket left the gate) but the label swap that should
              // have cleared plan-ready/approved was lost. Re-attempt ONLY that
              // cleanup — never re-submit — and move on.
              if ([ll.queued, ll.working, ll.done, ll.failed].some((n) => names.has(n))) {
                const cleanupArgs = [
                  "issue",
                  "edit",
                  String(issue.number),
                  "--repo",
                  repo.nwo,
                  "--remove-label",
                  ll.planReady,
                ];
                if (cfg.github.requireApproval) cleanupArgs.push("--remove-label", ll.approved);
                await ghFn(cfg, cleanupArgs, { timeoutMs: GH_TIMEOUT, retryNetwork: true });
                log.info("github bridge: plan-ready lingering after dispatch; cleaned up labels", {
                  nwo: repo.nwo,
                  issue: issue.number,
                });
                continue;
              }
              const login = await viewerLogin(cfg, state, ghFn);
              const comment = await findOwnPlanComment(cfg, repo.nwo, issue.number, login, ghFn);
              if (!comment) {
                log.warn("github bridge: plan-ready but no own-authored plan comment", {
                  nwo: repo.nwo,
                  issue: issue.number,
                });
                continue;
              }
              if (cfg.github.requireApproval) {
                if (!names.has(ll.approved)) continue; // awaiting review
                const approval = await verifyLabelApplier(
                  cfg,
                  repo.nwo,
                  issue.number,
                  ll.approved,
                  ghFn,
                );
                if (approval.verdict !== "ok") {
                  log.warn("github bridge: approval not by a verified writer; ignoring", {
                    nwo: repo.nwo,
                    issue: issue.number,
                  });
                  continue;
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
                  continue;
                }
              }
              const planBody = extractPlanBody(comment.body);
              if (!planBody) {
                log.error("github bridge: plan comment has no extractable plan; fix the comment", {
                  nwo: repo.nwo,
                  issue: issue.number,
                });
                continue;
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
              const editArgs = [
                "issue",
                "edit",
                String(issue.number),
                "--repo",
                repo.nwo,
                "--add-label",
                ll.queued,
                "--remove-label",
                ll.planReady,
              ];
              if (cfg.github.requireApproval) editArgs.push("--remove-label", ll.approved);
              await ghFn(cfg, editArgs, { timeoutMs: GH_TIMEOUT, retryNetwork: true });
              bridged++;
              log.info("github bridge: approved plan dispatched for execution", {
                nwo: repo.nwo,
                issue: issue.number,
                id: t.id,
              });
            } catch (e) {
              log.warn("github bridge: approval scan failed for issue; retrying next sweep", {
                nwo: repo.nwo,
                issue: issue.number,
                error: errMsg(e),
              });
            }
            continue;
          }
          if (!isEligible(issue, trigger)) continue;
          const verdict = await verifyLabelApplier(cfg, repo.nwo, issue.number, trigger, ghFn);
          if (verdict.verdict === "unverified") continue; // fail-closed; retry next sweep
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
            continue;
          }
          const isAsk = issue.labels.some((l) => l.name === cfg.github.askLabel);
          const parent = isAsk ? null : await fetchParent(cfg, repo.nwo, issue.number, ghFn);
          const t = isAsk
            ? issueToTicket(issue, repo, cfg, null)
            : buildPlanningTicket(issue, repo, parent);
          const stateLabel = isAsk ? ll.queued : ll.planning;
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
          bridged++;
          log.info("github bridge: dispatched issue", {
            nwo: repo.nwo,
            issue: issue.number,
            id: t.id,
            kind: isAsk ? "ask" : "plan",
          });
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
  return bridged;
}
