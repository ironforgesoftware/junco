# Unified data root — design

**Date:** 2026-07-16
**Status:** approved (brainstormed + section-by-section approval in session)
**Rollout:** three sequenced PRs (§12)

## 1. Summary

Junco's on-disk state is split across three roots today: the ticket queue under
`vaultRoot/juncoSubdir`, everything else under `observability.stateDir`
(default `~/.local/state/junco`), and PR-flow build worktrees under
`git.worktreeRoot` (default `~/junco/worktrees`). Several pipeline objects have
no first-class disk representation at all (issues, PRs, metrics), some
directories are invisible until first use (`github-outbox/`), and the layout is
documented only in fragments across five docs pages.

This design unifies everything under **one configurable data root** (`dataDir`),
gives **every atomic pipeline object a filesystem representation**, makes the
tree **self-gitignoring** so it can live inside a repo checkout without ever
landing in a commit, adds a **`junco data`** command that prints the resolved
tree, and promotes the dashboard's issue/PR cache to a **first-class read-only
mirror** so junco is browsable and useful offline.

## 2. Goals

- One root: every path junco reads or writes resolves under `dataDir` by
  default.
- Completeness: every state and atomic object that moves through the pipeline
  is representable as a file — tickets, findings, drafts, outbox ops, issues,
  PRs, transcripts, clones, worktrees, spend, metrics, watchlist.
- Read-offline: everything junco knows about GitHub is browsable, greppable,
  and renderable (dashboard) with no network. Writes queue through the existing
  outbox. GitHub remains the single source of truth.
- Zero-breakage upgrade: every existing config behaves identically until the
  operator removes a legacy key. Nothing surprising moves.
- Self-protection: the root carries a `.gitignore` containing `*`, so pointing
  it inside a git checkout (e.g. the junco repo itself) can never dirty a
  commit.
- Visibility: `junco data` answers "where is X and what's in it" in one
  command, including directories that are currently empty.

## 3. Non-goals

- **Work-offline (two-way sync).** The mirror is strictly one-way
  (GitHub → disk). Dispatch/approve/replan still require the outbox path;
  no local label state machine, no conflict resolution.
- **Ticket→PR "receipt" objects.** Cut as YAGNI: the done-ticket's
  `junco-result` block and `mirror/<repo>/prs/` already record the linkage from
  both ends.
- **Changing `src/ticketSchema.ts`.** The ticket contract is untouched.
- **Multi-machine sync / remote state.** Out of scope.

## 4. The tree

```
<dataDir>/                                   default: ~/.local/state/junco
  .gitignore                                 contains "*" — self-ignoring (cargo target/ trick)
  queue/
    inbox/          processing/          done/          failed/
  review/
    assess/         (+ filed/)                          parked assess findings, one JSON per ticket
    comments/       (+ posted/ discarded/)              parked analyze drafts, one JSON per ticket
  outbox/           (+ dead/)                           GitHub write ops, one JSON per op; created eagerly
  mirror/
    <owner>__<repo>/
      meta.json                                         fetchedAt stamps per kind
      issues/<n>.json                                   one file per issue, last-known GitHub state
      prs/<n>.json                                      one file per junco PR
  clones/
    watched/<owner>/<repo>/                             dashboard-cloned watched repos
    external/<owner>/<repo>/                            managed clones of unowned repos (fork/assess flow)
  worktrees/                                            ephemeral PR-flow build worktrees
  transcripts/<ticket-id>.jsonl                         per-run event stream
  watchlist.json    spend.json    metrics.json    worker.log    migrated.json
```

### Object lifecycles (who writes what, when)

| Object                        | Appears                                                                                                      | Moves/leaves                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ticket                        | Born in `queue/inbox/` (submit/dispatch/bridge/assess/analyze); requeued transients return here with backoff | Atomic rename to `processing/` on claim; finalize appends the `junco-result` block and renames to `done/` or `failed/` (terminal); crash orphans swept back to `inbox/` |
| Assess findings               | Parked in `review/assess/<ticket-id>.json` at end of Phase A; requeue overwrites                             | `junco assess file` archives the batch to `review/assess/filed/`                                                                                                        |
| Analyze draft                 | Parked in `review/comments/<ticket-id>.json` at end of Phase A                                               | `post` archives to `posted/`, discard to `discarded/`                                                                                                                   |
| Outbox op                     | One JSON per failed-live GitHub write (`tryOrEnqueue`)                                                       | FIFO flush on bridge sweep or `junco outbox flush`; 3 non-network failures → `outbox/dead/`                                                                             |
| Issue/PR mirror file          | Upserted by every bridge sweep and dashboard refresh (write-through)                                         | Removed when the object vanishes from a successful full fetch — the mirror always equals last-known GitHub state                                                        |
| Clone                         | `clones/watched` on dashboard `w` with empty path; `clones/external` on first unowned-repo dispatch/assess   | External clones force-synced to upstream default branch before each run; removed only manually                                                                          |
| Worktree                      | Created at PR-flow run start                                                                                 | Removed after push; `junco worktree prune` reaps leftovers                                                                                                              |
| Transcript                    | Appended live during the run                                                                                 | Never moves                                                                                                                                                             |
| `spend.json` / `metrics.json` | Updated at run end (spend) / snapshot on finalize + graceful shutdown (metrics)                              | n/a                                                                                                                                                                     |
| `watchlist.json`              | Dashboard `w`/`x`                                                                                            | Re-read every sweep; no restart needed                                                                                                                                  |
| `migrated.json`               | Written by migration (§7) as a journal/receipt                                                               | n/a                                                                                                                                                                     |

## 5. Config surface

New **top-level, optional** key:

```jsonc
{ "dataDir": "~/.local/state/junco" } // default; may point anywhere, incl. inside a repo
```

Legacy keys become optional, per-subtree overrides that **always win when
explicitly set**, each emitting a one-line deprecation warning at config load:

| Legacy key                  | Overrides                                                                                                             | Schema change                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `vaultRoot` + `juncoSubdir` | queue root (`<vaultRoot>/<juncoSubdir>` with the flat `inbox/`… layout)                                               | `vaultRoot` required → optional; `juncoSubdir` only consulted when `vaultRoot` is set |
| `observability.stateDir`    | acts as `dataDir` for the whole state subtree (everything except queue/worktrees when those have their own overrides) | `.default(…)` → `.optional()` so explicit-set is detectable                           |
| `git.worktreeRoot`          | worktrees root                                                                                                        | `.default(…)` → `.optional()`                                                         |
| `github.externalReposRoot`  | external-clones root                                                                                                  | already optional                                                                      |

Resolution (in `resolveConfig`):

```
dataDir      = expandHome(raw.observability.stateDir ?? raw.dataDir ?? "~/.local/state/junco")
               // legacy-wins: stateDir is optional post-change, so its presence is always explicit
queueRoot    = raw.vaultRoot ? join(vaultRoot, juncoSubdir) : join(dataDir, "queue")
worktreeRoot = raw.git.worktreeRoot ?? join(dataDir, "worktrees")
externalRoot = raw.github.externalReposRoot ?? join(dataDir, "clones", "external")
watchedRoot  = join(dataDir, "clones", "watched")
```

The **new subtree names are canonical in code everywhere** — there is exactly
one layout; legacy keys move its roots, never its shape (that is what migration
normalizes, §7). The resolved `Config` carries the fully-resolved paths;
`reviewStore` subdirs become `review/assess` and `review/comments`;
`githubOutbox` uses `outbox/`.

`dataDir` and every derived root join `overlayFrozenRestartFields` (restart
levers must be frozen across `junco restart`, per the #186 gotcha).

Setting both `dataDir` and a legacy key is **not an error**: legacy wins for
its subtree, and the deprecation warning says so. `junco doctor` and
`junco data` both flag legacy-overridden paths.

## 6. Eager materialization + self-gitignore

`ensureDataTree(cfg)` (called at daemon startup, by `junco data`, and by any
command that writes) mkdir-p's the full standard tree — including empty
`outbox/`, `outbox/dead/`, `mirror/`, `review/*` archives — and writes
`<dataDir>/.gitignore` containing `*` if absent (never overwrites an existing
file). No directory is invisible-until-first-use anymore.

## 7. Migration

Safety property: **the queue never moves implicitly** (`vaultRoot` is required
today, so every existing config has it; while it is set, the queue stays put).
The state subtree, by contrast, is normalized in place — same-directory renames
at the resolved root.

**Automatic (daemon startup, under the daemon lock; also any CLI command via a
shared `migrateStateTree` helper guarded by a lockfile):** for the resolved
`dataDir`, rename old-name subdirs to new names when the source exists and the
destination does not:

```
assess-review  → review/assess        github-outbox → outbox
comment-review → review/comments      repos         → clones/watched
external       → clones/external      github-cache  → (deleted — it is a cache; PR 2 rebuilds it as mirror/)
```

Renames are same-filesystem by construction (same parent dir) and atomic.
Each completed step is journaled to `<dataDir>/migrated.json`; re-running is a
no-op. If both old and new names exist (a partial previous run), the non-empty
one wins and the conflict is logged + surfaced by `doctor` rather than guessed
at.

**Explicit (`junco data migrate`):** the opt-in full unification for a config
that still carries legacy keys. It refuses to run while the daemon is up
(pidfile check), then: moves the queue dirs from `<vaultRoot>/<juncoSubdir>/`
into `<dataDir>/queue/` (rename; copy+fsync+verify+delete fallback across
filesystems), runs the state-tree normalization above, rewrites `config.json`
to drop the now-redundant legacy keys (via the existing validated
`config set` machinery), and prints a receipt. `--dry-run` prints the plan
without acting.

Old worktree roots are ignored (worktrees are disposable); `doctor` hints when
a legacy `worktreeRoot` path still contains directories.

## 8. `junco data`

Prints the resolved tree with live counts and provenance:

```
data root  ~/.local/state/junco            (dataDir, default)
  queue/                                   ← legacy override: vaultRoot (~/junco/tickets)  [deprecated]
    inbox 2 · processing 1 · done 148 · failed 9
  review/assess    1 pending · 6 filed
  review/comments  0 pending · 4 posted · 1 discarded
  outbox           0 queued · 0 dead
  mirror           2 repos · 37 issues · 5 prs      (fetched 3m ago)
  clones           watched 1 · external 1
  worktrees        1 active
  transcripts      158 files · 214 MB
  spend.json $12.41 · metrics.json ok · watchlist 2 repos · worker.log 3.2 MB
```

`--json` emits the same as a machine-readable object (paths, counts, overrides,
existence). Directories that do not exist yet are still listed (with `absent` —
only possible pre-`ensureDataTree` or for legacy-overridden roots). The
existing `inbox-path` command is unchanged (scripting contract).

## 9. Mirror (PR 2)

One module (`mirrorStore.ts`) owns the format and the only write path:

- **Write-through:** after each successful per-repo fetch (bridge sweep issue
  poll, dashboard issue/PR refresh), upsert `mirror/<owner>__<repo>/issues/<n>.json`
  (atomic tmp+rename), delete files absent from the fetch result, stamp
  `meta.json` (`{ issuesFetchedAt, prsFetchedAt }`). Deletion only happens on a
  _successful full_ fetch — a failed or partial fetch never erases knowledge.
- **Reads are never-throw:** missing dir → empty list; corrupt file → skipped
  and logged (same semantics as `reviewStore`).
- **Consumers:** the dashboard reads _only_ the mirror — render is offline by
  construction; network merely refreshes files. (Mirror-backed offline fallback
  for `assess`/`analyze` issue-target resolution is a follow-up issue, not in
  PR 2 scope.)
- **Replaces `github-cache`:** the per-repo blob format and its
  `cachePathFor`/`prCachePathFor` paths are removed; migration deletes the
  directory.
- The file payload is the same normalized shape the dashboard already uses
  (`DashIssue` / `DashPr`) plus the raw label set — one issue's file is
  self-contained and greppable.

GitHub remains the source of truth. The mirror is never consulted to decide
writes (dedup, filing) — those stay authoritative-fetch-at-flush-time as today.

## 10. Metrics persistence (PR 3)

`metrics.json` snapshot written at each ticket finalize and on graceful
shutdown (no periodic timer). Load-on-startup restores counters so `/health`
and `status` survive restarts. Atomic tmp+rename; corrupt/missing file →
zeroed counters (never fatal).

## 11. Error handling

- **Migration:** lock-held, journaled (`migrated.json`), idempotent, resumable.
  Rename is atomic; the cross-fs copy fallback verifies (size + count) before
  deleting the source. A failed step leaves the old path intact and reports.
- **Mirror:** write failures are log-and-continue — a stale mirror is degraded,
  not corrupt. Reads never throw.
- **Config:** legacy + `dataDir` both set → legacy wins per subtree with a loud
  warning; never an error. Unknown/absent dirs are created, not fatal.
- **`.gitignore`:** written only when absent; an operator-customized file is
  respected.

## 12. Testing

- **Config precedence matrix:** {new only, legacy only, both, neither} × each
  subtree (queue/state/worktrees/external) — unit tests on `resolveConfig`.
- **Migration:** tmp-dir harness — fresh run, re-run (no-op), partial-state
  resume (old+new both present), cross-fs queue fallback, daemon-running
  refusal, `--dry-run`, config rewrite.
- **Mirror:** upsert/delete/meta semantics against a fake `gh`; corrupt-file
  skip; failed-fetch-preserves-files; dashboard renders from mirror with `gh`
  hard-failing (the offline proof).
- **`junco data`:** snapshot test of tree output + `--json` shape, incl.
  legacy-override provenance flags.
- **Fan-out:** the `Config` shape change touches every `makeConfig`/`cfg()`
  fixture (`tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts`) —
  sweep with `npx tsc --noEmit -p tsconfig.eslint.json`.
- Full gate green at every commit; docs pages (`operations`, `github-mode`,
  `assess`, `analyze`, `dashboard`) updated to the new paths in the same PR
  that moves them.

## 13. Rollout — three PRs

1. **`feat/unified-data-root`** — `dataDir` + resolution + legacy overrides +
   deprecation warnings, `ensureDataTree` + self-gitignore, state-tree
   migration (auto + `junco data migrate`), `junco data` command, docs.
   Minor version bump (additive config semantics; nothing breaks).
2. **`feat/github-mirror`** — `mirrorStore.ts`, bridge/dashboard write-through,
   dashboard reads mirror, `github-cache` removal, offline render test, docs.
3. **`feat/metrics-persistence`** — `metrics.json` snapshot/restore.

Each PR is independently shippable and gate-green; 2 and 3 build on 1's settled
layout.
