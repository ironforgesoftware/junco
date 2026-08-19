# Unwatch cleanup — design

Date: 2026-08-19
Status: approved in brainstorm (Approach A); this document is the written spec.

## Problem

Unwatching a repo from the dashboard (`src/tui/App.tsx` `unwatch`, ~line 908) removes the
`watchlist.json` entry and evicts the TUI's in-memory issue/PR cache — nothing else. Every
on-disk trace survives: the managed clone, queued tickets, worktrees, outbox ops, pending
reviews, assess history, mirror and legacy github-cache entries. There is also no
confirmation step: `unwatch` is an unguarded mnemonic, one keypress.

## Goals

1. Unwatching a repo also deletes its junco-owned **operational state** (scope below).
2. The user **confirms first**, and the confirmation **itemizes what will be deleted**
   (and what is deliberately kept) before anything happens.
3. The flow reports what was actually deleted afterward.
4. The operation is scriptable from the shell and idempotent (safe to re-run after a
   partial failure).

## Non-goals

- **Audit trail stays.** `done/`, `failed/`, per-ticket transcripts, task-history shards
  (`history/tasks-YYYY-MM.jsonl`), the spend ledger, outbox `dead/`, and the review
  archives (`review/assess/filed`, `review/comments/{posted,discarded}`) are never
  touched.
- **No outward GitHub actions.** The bot's fork (fork-PR mode) and any collaborator
  grants stay; deleting them is a separate, explicitly outward operation.
- **No cancellation of in-flight work.** A repo with a `processing/` ticket cannot be
  unwatched until the run finishes (chosen over skip-and-strand and over active abort).
- **Config-defined repos remain un-unwatchable** (existing rule: `config.json` wins;
  only watchlist entries can be unwatched). Unchanged.

## Design

### New module: `src/unwatchCmd.ts`

Standard injectable `deps` seam (fs fns, `rmFn`, `nowFn`, git runner for the one git
call below). No Pi SDK involvement. No new `Config` field.

#### `planUnwatch(cfg, nwo, deps) → PlanOutcome`

Read-only enumeration. Returns a discriminated union:

```ts
type PlanOutcome =
  | { ok: false; reason: "config-defined" | "watchlist-unreadable" }
  | { ok: true; plan: UnwatchPlan };

interface UnwatchPlan {
  nwo: string; // watchlist casing when watched; input casing in residue mode
  mode: "watched" | "residue"; // residue: nwo absent from watchlist (see Idempotency)
  external: boolean; // fork-PR entry (watched mode only; false in residue mode)
  /** null when residue mode finds no managed clone. managed:false ⇒ kept. */
  clone: { path: string; managed: boolean } | null;
  items: PlanItem[]; // everything that WILL be deleted
  kept: string[]; // human-readable lines for deliberate keeps (e.g. "clone (user-owned)")
  blocked: { ticketId: string } | null; // processing/ ticket targeting this repo
}

interface PlanItem {
  kind:
    | "clone" // managed clone directory
    | "inbox-ticket"
    | "worktrees" // the per-repo namespace dir, one item
    | "outbox-op"
    | "assess-review" // pending batch in review/assess
    | "comment-review" // pending draft in review/comments
    | "assess-history" // the repo's history file
    | "mirror" // mirror/<owner>/<repo>
    | "github-cache"; // legacy TUI cache files (issues + PRs)
  path: string; // absolute path that will be removed
  detail?: string; // ticket id, op issueKey, etc. — for the confirm modal / summary
}
```

Enumeration rules, per store (all nwo comparisons case-insensitive, matching the
watchlist's own dedup rule; all path comparisons on `resolve()`d paths, realpathed
when the path exists so symlinked roots compare correctly — unit tests use synthetic
nonexistent paths so canonicalization is a no-op, same idiom as the sandbox tests):

| Store | Match | Included |
| --- | --- | --- |
| Clone | `resolve(entry.path)` under `dataTreePaths(cfg).clonesWatched` or `cfg.github.externalReposRoot` (prefix compare with a path-separator guard) | as `clone` item when managed; as `kept` line when user-supplied |
| Inbox tickets | frontmatter `repo:` resolves to `entry.path` (raw-frontmatter read, same as `tui/queueSnapshot.ts`; Q&A tickets have no `repo:` and never match) | one item per ticket |
| Worktrees | the single dir `join(cfg.worktreeRoot, repoDiscriminator(entry.path))` (per-repo namespace, issue #33), when it exists | one item |
| Outbox (live only) | `op.nwo` matches, or `op.repoPath` resolves to `entry.path` (push ops carry only `repoPath`) | one item per op |
| review/assess | pending batch `nwo` matches | one item per batch |
| review/comments | pending draft `nwo` matches | one item per draft |
| Assess history | the store file for the nwo (`historyKey(nwo)` under `assess-history/`) | one item when present |
| Mirror | `mirror/<owner>/<repo>` dir when present | one item |
| Github cache | `cachePathFor(cfg, nwo)` and its PRs sibling when present | one item per existing file |
| Blocker | any `processing/` ticket whose `repo:` resolves to `entry.path` | `blocked: { ticketId }` |

#### `runUnwatch(cfg, nwo, deps) → UnwatchResult`

Re-plans internally (fresh blocker check at execute time — closes the confirm→execute
race), refuses without deleting anything when the plan is refused or blocked, then
deletes in this order:

1. **Watchlist entry** (atomic rewrite via `writeWatchlist` minus the entry) — first,
   so the bridge's next sweep stops polling. Skipped in residue mode.
2. Inbox tickets.
3. Outbox ops.
4. Pending review entries — via the stores' existing archive verbs, not unlink:
   comment drafts through `removeDraft(cfg, id, "discarded")`, assess batches
   through a new `purgePending(cfg, id)` that archives into
   `review/assess/discarded` (the existing `discardPending` archives into
   `filed/`, which would misrepresent an unfiled batch). Archiving preserves
   the audit non-goal while emptying the pending queue.
5. Worktree namespace dir — under the existing `worktreesLockPath` advisory lock
   (same discipline as prune).
6. When the clone is **kept** (user-owned; watched mode only — residue mode never
   knows a user path): best-effort `git -C <entry.path> worktree prune` to clear the
   stale `.git/worktrees` registrations junco left behind; failures ignored (the
   checkout may be gone or moved).
7. Assess history file, mirror dir, github-cache files.
8. **Managed clone last** (largest item; ordering means a mid-run crash leaves the
   recoverable small state gone and the re-clonable big state present, and residue
   mode can still derive the worktree namespace from a still-present clone).

Every deletion is individually try/caught — one failure never strands the rest:

```ts
interface UnwatchResult {
  ok: boolean; // false when refused, blocked, or any item failed
  refused: "config-defined" | "watchlist-unreadable" | "blocked" | null;
  blockedTicketId: string | null;
  watchlistRemoved: boolean;
  summary: Array<{
    kind: PlanItem["kind"] | "watchlist-entry";
    path: string;
    outcome: "deleted" | "kept" | "failed";
    reason?: string; // failure reason
  }>;
}
```

#### Idempotency: residue mode

Because the watchlist entry is deleted first, a re-run after a partial failure cannot
resolve the entry by nwo. When the nwo is absent from the watchlist, `planUnwatch`
switches to `mode: "residue"`:

- Everything **nwo-keyed** is enumerated exactly as above (outbox, both review stores,
  assess history, mirror, github-cache).
- The **managed clone** is probed at its deterministic locations
  (`clonesWatched/<owner>/<repo>`, `<externalReposRoot>/<owner>/<repo>`); when one
  exists, its **worktree namespace** (`repoDiscriminator` of that clone path) and any
  **inbox tickets** targeting it are enumerated too, and a `processing/` ticket
  targeting it blocks, exactly as in watched mode. Without a clone,
  path-keyed traces are unreachable by nwo and are out of residue scope (they belong
  to a kept user checkout anyway).
- Zero items ⇒ "nothing to clean" — success, not a refusal.

Residue mode makes `junco unwatch <nwo>` safely re-runnable until it reports nothing
to clean.

### CLI: `junco unwatch <nwo> [--plan]` (`src/cli.ts`)

Follows the `rm`/`retry` pattern: lazy import of `unwatchCmd.js`, `loadConfigFn`,
`printFn`; usage text states the destructive semantics.

- `--plan`: prints the `UnwatchPlan` (or refusal) as JSON on stdout. Exit 0 even when
  blocked — planning is not a failure.
- Execute (no flag): prints one line per summary item (`deleted: inbox ticket
  fix-login-123` / `kept: clone (user-owned)` / `failed: worktrees — <reason>`),
  refusals as the first line. Exit 0 on full success (including "nothing to clean");
  exit 1 when refused, blocked, or any item failed. The first output line is always
  the headline (`runLocalAction` toasts exactly that line).
- No interactive y/n in the CLI: typing the command is the confirmation, consistent
  with `junco rm`. The TUI owns the interactive gate.

### TUI flow (`src/tui/App.tsx`, `src/tui/viewActions.ts`)

- `unwatch` in `MAIN_GLOBALS` gains `guarded: true` (uppercase key, like `delete` /
  `prune` / `restart`). The mnemonic pin in `tests/tuiViewActions.test.ts` updates
  loudly — deliberate.
- Handler replaces today's direct `removeEntry` path:
  1. Cheap pre-checks stay as instant toasts (not in watchlist / defined in
     config.json / watchlist unreadable) — no modal for cases that cannot proceed.
  2. Spawn `unwatch <nwo> --plan` via the existing CLI runner (busy toast while it
     runs; dedupe by key like other local actions).
  3. Plan arrives: if `blocked`, info toast `1 ticket in flight — wait for it to
     finish`; no modal. Otherwise open the `useConfirm` modal, danger tone, title
     `unwatch <nwo>`, body itemizing deletions from `plan.items` (grouped with
     counts, e.g. `managed clone · 3 queued tickets · worktrees · 1 outbox op ·
     assess history`) plus the `kept` lines.
  4. `y` ⇒ `runLocalAction("unwatch", [nwo])`. On success: toast the summary line,
     `githubEvictRepo(nwo)`, reload the watchlist hook state, and the immediate
     cheap re-poll `runLocalAction` already performs. Two small seams enable
     this: `useWatchlist` gains a `reload()` (the hook only re-reads the file at
     mount and at its own write time, so the CLI's on-disk removal is invisible
     without it), and `runLocalAction` gains an optional `onSuccess` callback
     fired when the spawned command exits 0. The plan JSON is printed by the CLI
     as a single line and the TUI parses the last non-empty output line (store
     warnings may precede it in the merged stream).
- The watchlist write moves entirely into the CLI command — `useWatchlist.removeEntry`
  is no longer called on this path; the destructive flow has exactly one writer.

## Edge cases

- **Confirm→execute race:** `runUnwatch` re-plans; a ticket claimed into
  `processing/` during the modal turns execution into a clean refusal before any
  deletion (the watchlist write happens after the blocker check).
- **Fork-PR entries (`external: true`):** clone is under `clones/external/` ⇒ managed
  ⇒ deleted. The GitHub-side fork stays (non-goal).
- **User-owned clone kept:** worktree namespace still deleted; best-effort
  `git worktree prune` cleans the checkout's stale registrations.
- **Daemon down:** everything still works — the command touches only the filesystem;
  the advisory worktrees lock serializes against a daemon that comes back mid-run.
- **nwo casing:** all matching case-insensitive; the plan echoes the watchlist's
  stored casing.

## Testing

TDD, one commit per task, suite green at every commit.

- `tests/unwatchCmd.test.ts` (bulk): per-store plan enumeration; managed vs
  user-owned clone classification (synthetic `/sbxroot/...`-style nonexistent paths
  so canonicalization no-ops); blocker detection; deletion order; per-item failure
  isolation (one `rmFn` throw ⇒ rest still deleted, `ok: false`, failure in
  summary); residue mode (nwo-keyed sweep, clone-derived worktrees, nothing-to-clean);
  case-insensitive matching. All against `makeConfig` + injected fs fakes — no
  `tests/helpers/config.ts` change (no new Config field).
- One git-harness test: real managed clone + worktree; run; namespace gone; and the
  kept-user-clone variant where `git worktree prune` clears `.git/worktrees`.
- `tests/tuiViewActions.test.ts`: guarded `unwatch` pin update.
- App-level TUI test (fake CLI runner): plan → modal body itemizes → `y` → execute
  spawn → evict + re-poll; blocked plan → toast, no modal; `n`/esc → nothing spawned.
  Loop-until-condition assertions per the Ink gotcha.
- CLI wiring test: `--plan` JSON shape, exit codes (0 success/nothing-to-clean/blocked
  plan; 1 refused/blocked execute/partial failure), headline-first output.
