/**
 * Keeping the chat's checkout current (#526).
 *
 * The dashboard chat hands the agent a watched clone's **working tree** as its
 * cwd (`chatCwd.ts`), and until this module nothing ever advanced that tree: a
 * clone provisioned in August was still being read in September while
 * `origin/main` had moved eighteen commits on. The model reported honestly on
 * what it saw and drafted tickets whose line-number anchors were true of the
 * stale tree and false of the repo. Ticket RUNS never shared the bug —
 * `worktree.ts` fetches and cuts every worktree from `origin/<base>`
 * (`worktree.ts:292`, `:310`) — so the chat planned against commit A while the
 * executor built on commit B, with nothing surfacing the gap.
 *
 * `fastForwardChatCheckout` closes it on session open (`chatManager.ts`), and
 * only there — never off the poll loop. It is deliberately the most timid
 * thing that can work:
 *
 *   - it refuses any path junco does not own — the same clone roots
 *     `unwatchCmd.ts`'s `classifyClone` calls managed — so a watchlist entry
 *     pointing at the operator's own checkout is read and reported, never
 *     written. `assertOwnedCheckout` re-checks that at the mutation itself,
 *     the way `externalRepo.ts`'s `assertContained` does: whatever gating a
 *     caller believes it applied;
 *   - `merge --ff-only` is the only mutation. No reset, no checkout, no branch
 *     switch, no stash — nothing that can discard work;
 *   - a dirty tree, a detached HEAD, a branch that is not origin's default, an
 *     unset `origin/HEAD`, or local commits ahead of the remote each SKIP,
 *     with the reason on the record;
 *   - the fetch is bounded (`FETCH_TIMEOUT_MS`) and its failure is an outcome,
 *     not an exception: the chat opens on the tree as it stands and says so.
 *
 * Every outcome carries the branch and the HEAD commit, which is the other
 * half of the fix: the transcript now states which commit the conversation
 * reasoned about instead of leaving it to be inferred.
 */
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Config } from "../types.js";
import type { ChatCheckoutRecord } from "../agent/transcriptSchema.js";
import { dataTreePaths } from "../dataTree.js";
import { git } from "../git.js";
import { isSafeGitRef } from "../repoContext.js";
import { log } from "../logging.js";

/** Bounded on purpose: this runs while the operator waits for the chat pane to
 *  open, so a wedged network degrades to `fetch_failed` in seconds rather than
 *  holding the session build for the three minutes `worktree.ts` allows a
 *  ticket's fetch. */
const FETCH_TIMEOUT_MS = 15_000;
/** Local plumbing (rev-parse, status, symbolic-ref, merge) — no network. */
const LOCAL_TIMEOUT_MS = 30_000;

/** The record minus what `ChatSession.writeRecord` stamps. */
export type ChatCheckoutOutcome = Omit<ChatCheckoutRecord, "type" | "ts">;

export interface ChatCheckoutDeps {
  gitFn?: typeof git;
  /** Test seam for the bounded fetch (default FETCH_TIMEOUT_MS). */
  fetchTimeoutMs?: number;
  realpathFn?: (p: string) => string;
}

const canon = (p: string, realpathFn: (x: string) => string): string => {
  try {
    return realpathFn(p);
  } catch {
    return resolve(p);
  }
};

/** Strictly under `root` — a clone root is not itself a checkout. Same notion
 *  as `unwatchCmd.ts`'s `isUnder`, realpathed on both sides so a symlinked
 *  dataDir (and macOS's /var → /private/var) cannot defeat it. */
function isStrictlyUnder(child: string, root: string, realpathFn: (p: string) => string): boolean {
  const c = canon(child, realpathFn);
  const r = canon(root, realpathFn);
  return c !== r && c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Managed ⇔ the checkout lives under a junco-owned clone root — the same two
 *  roots `unwatchCmd.ts`'s `classifyClone` deletes under. Everything else is
 *  the operator's: their own checkout, named by a watchlist entry or by a
 *  local chat key. */
export function isJuncoOwnedCheckout(
  cfg: Config,
  path: string,
  realpathFn: (p: string) => string = (p) => realpathSync.native(p),
): boolean {
  const p = dataTreePaths(cfg);
  return (
    isStrictlyUnder(path, p.clonesWatched, realpathFn) ||
    isStrictlyUnder(path, p.clonesExternal, realpathFn)
  );
}

/**
 * The mutation's own self-guard. `fastForwardChatCheckout` already gates on
 * `isJuncoOwnedCheckout` and never reaches the merge otherwise; this throws
 * anyway, immediately before the only write, because the cost of that gate
 * being wrong once is the operator's uncommitted branch — `externalRepo.ts`
 * carries the identical guard in front of its hard reset for the same reason.
 */
export function assertOwnedCheckout(cfg: Config, path: string): void {
  if (!isJuncoOwnedCheckout(cfg, path))
    throw new Error(
      `refusing to fast-forward ${path}: junco does not own it ` +
        `(not under ${dataTreePaths(cfg).clonesWatched} or ${dataTreePaths(cfg).clonesExternal})`,
    );
}

/**
 * Fast-forward `cwd` to `origin/<default branch>` when — and only when — every
 * safety condition holds. Never throws: the chat must open whatever git says.
 */
export async function fastForwardChatCheckout(
  cfg: Config,
  cwd: string,
  deps: ChatCheckoutDeps = {},
): Promise<ChatCheckoutOutcome> {
  const gitFn = deps.gitFn ?? git;
  const realpathFn = deps.realpathFn ?? ((p: string) => realpathSync.native(p));
  const base: ChatCheckoutOutcome = {
    cwd,
    branch: null,
    head: null,
    action: "skipped",
    reason: null,
    from: null,
    commits: null,
  };
  // FIRST, before any git at all: an unowned path is read-only to junco, and
  // "read-only" here means we do not even open it. The record still names it,
  // so a watchlist entry on the operator's own checkout is visibly exempt
  // rather than silently unfreshened.
  if (!isJuncoOwnedCheckout(cfg, cwd, realpathFn))
    return { ...base, action: "skipped", reason: "not_managed" };

  // check:false throughout — a probe's non-zero exit is an answer here, not an
  // exception (src/git.ts RunOpts.check). The try/catch covers the wrapper
  // itself throwing (a missing cwd, a killed process).
  const run = async (args: string[]): Promise<{ code: number; stdout: string } | null> => {
    try {
      return await gitFn(cfg, ["-C", cwd, ...args], {
        check: false,
        timeoutMs: LOCAL_TIMEOUT_MS,
      });
    } catch (e) {
      log.debug(`chat checkout probe failed: git ${args.join(" ")} — ${String(e)}`);
      return null;
    }
  };

  const branchOut = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchOut === null || branchOut.code !== 0)
    return { ...base, action: "skipped", reason: "not_a_repo" };
  const branch = branchOut.stdout.trim();
  if (branch === "" || branch === "HEAD") return { ...base, action: "skipped", reason: "detached" };

  const headOut = await run(["rev-parse", "HEAD"]);
  const head = headOut !== null && headOut.code === 0 ? headOut.stdout.trim() : null;
  const at: ChatCheckoutOutcome = { ...base, branch, head };

  // The operator's lever, checked AFTER the probes: the record's whole other
  // job is naming the commit the chat reads, and that answer is as useful with
  // the fast-forward turned off as with it on.
  if (!cfg.chat.fastForward) return { ...at, action: "skipped", reason: "disabled" };

  // submitPreflight.ts's spelling of "origin's default branch", verbatim.
  const defOut = await run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const def =
    defOut !== null && defOut.code === 0 ? defOut.stdout.trim().replace(/^origin\//, "") : "";
  // isSafeGitRef even though git itself produced this: it becomes an argv token
  // below, and `--` alone is the other half of that rail (issue #347).
  if (def === "" || !isSafeGitRef(def))
    return { ...at, action: "skipped", reason: "no_default_branch" };
  if (branch !== def) return { ...at, action: "skipped", reason: "not_default_branch" };

  const status = await run(["status", "--porcelain"]);
  if (status === null || status.code !== 0)
    return { ...at, action: "skipped", reason: "not_a_repo" };
  if (status.stdout.trim() !== "") return { ...at, action: "skipped", reason: "dirty" };

  // The first thing that touches the network, and the first thing that writes
  // anything (remote-tracking refs). Bounded, single attempt, no retry: a chat
  // that opens late is worse than a chat that opens honest.
  let fetched: { code: number } | null = null;
  try {
    fetched = await gitFn(cfg, ["-C", cwd, "fetch", "origin", "--", def], {
      check: false,
      timeoutMs: deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
    });
  } catch (e) {
    log.debug(`chat checkout fetch threw: ${String(e)}`);
    fetched = null;
  }
  if (fetched === null || fetched.code !== 0)
    return { ...at, action: "failed", reason: "fetch_failed" };

  // "<behind>\t<ahead>" relative to the remote-tracking ref the fetch just
  // advanced. Ahead of origin at all ⇒ the clone holds commits the remote does
  // not, which is never ours to resolve.
  const counts = await run(["rev-list", "--left-right", "--count", `origin/${def}...HEAD`]);
  if (counts === null || counts.code !== 0)
    return { ...at, action: "skipped", reason: "not_a_repo" };
  const [behindRaw, aheadRaw] = counts.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindRaw ?? "", 10);
  const ahead = Number.parseInt(aheadRaw ?? "", 10);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead))
    return { ...at, action: "skipped", reason: "not_a_repo" };
  if (ahead > 0) return { ...at, action: "skipped", reason: "diverged", commits: behind };
  if (behind === 0) return { ...at, action: "up_to_date", commits: 0 };

  assertOwnedCheckout(cfg, cwd); // see the doc comment: deliberately redundant
  const merged = await run(["merge", "--ff-only", "--", `origin/${def}`]);
  if (merged === null || merged.code !== 0)
    return { ...at, action: "failed", reason: "merge_failed", commits: behind };
  const after = await run(["rev-parse", "HEAD"]);
  return {
    ...at,
    action: "fast_forwarded",
    from: head,
    head: after !== null && after.code === 0 ? after.stdout.trim() : head,
    commits: behind,
  };
}
