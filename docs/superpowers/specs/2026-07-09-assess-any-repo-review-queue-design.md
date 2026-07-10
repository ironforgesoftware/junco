# Assess any repo: durable review queue + least-privilege filing (SP-1)

**Date:** 2026-07-09
**Status:** draft

## Problem

`junco assess` audits a repo and files one GitHub issue per finding, but it refuses
repos the operator does not own:

1. **The command gate.** `junco assess <nwo>` resolves through `resolveWatchedRepos`,
   which excludes `external: true` watchlist entries (`src/watchlist.ts:92`), so an
   external repo reports "not watched" (`src/assessCmd.ts:96`). The dashboard `A` key
   short-circuits earlier with a toast (`src/tui/App.tsx:772`).
2. **The label mechanic.** Every finding issue is created *with* labels
   (`junco:finding`, `severity/*`), and junco first *creates* those labels via
   `gh label create --force` (`src/githubOutbox.ts:331`). On a repo the operator lacks
   triage rights for, both label-creation and `gh issue create --label` hard-fail, and
   the dedup scan (`fetchFindingMarkers`) filters by that label, so dedup breaks too.
3. **The etiquette invariant.** The external-repo spec deliberately forbids issue-tracker
   writes on unowned repos (`2026-07-08-external-repo-dispatch-design.md:29`): "junco's
   only outward-facing writes are the fork, pushes to it, and the PR. No lifecycle labels,
   no comments on the upstream issue tracker."

The operator wants assess-and-file-issues as an integral workflow on repos they do not
own. This reverses a documented invariant and crosses a social line (auto-filing on
strangers' trackers reads as spam), so the design is built around a human confirmation
gate rather than a silent policy flip.

Notably, the assess *engine* already resolves its target from the clone's `origin`
remote and files there (`src/assessFlow.ts:250-260`); for an external managed clone
`origin` **is** the upstream. The engine can already file upstream — the blockers are the
two gates and the label mechanic above.

## Goal

Run `junco assess` against **any** watched repo — owned or external — and file findings
as GitHub issues on it, gated by a durable, per-finding human review step. Owned and
unowned repos run the identical code path; labels become an optional owned-only adornment.

This is **SP-1** of a larger direction (below); it also builds the shared least-privilege
write core that SP-2 and SP-3 consume.

## The larger direction (context, not scope)

The operator's broader intent is **least-privilege engagement with any repo**. Every junco
outward action decomposes into GitHub primitives at two privilege tiers:

- **Unprivileged (any repo):** open an issue, open a PR from a fork, post a comment, read.
- **Privileged (owned only):** create/apply/remove labels — the trigger label, the
  working/done/failed lifecycle, finding/severity adornment.

Capabilities map onto the unprivileged tier:

| Capability                          | Primitive                    | Where            |
| ----------------------------------- | ---------------------------- | ---------------- |
| Assess sweep → file findings        | open issue (+ opt. labels)   | **SP-1 (this)**  |
| Fix → fork PR                        | open PR                      | exists (dispatch)|
| Analysis comment on an issue        | post comment                 | SP-2             |
| Assess in an issue's context        | open issue / comment         | SP-3             |

### Redrawn etiquette invariant

The `2026-07-08` invariant is superseded (its dispatch-PR clauses stay true; the
issue-tracker prohibition is lifted under a confirmation gate):

> On any repo, junco's outward writes are limited to the unprivileged tier — opening
> issues, opening PRs, posting comments. It never uses privileged features (labels) it
> lacks rights for; it silently omits them. **Every outward write on a repo the operator
> does not own is both operator-initiated *and* human-confirmed** (findings previewed
> before filing; comment text approved before posting). Junco never applies labels, edits
> others' content, or acts on a poll/webhook it was not explicitly pointed at.

The confirmation spine is load-bearing: it is what separates this from an auto-spam
cannon. SP-1 implements the findings half; the comment half arrives in SP-2.

**Out of scope for SP-1:** dispatch's label-driven trigger and working/done/failed
lifecycle labels are unchanged. They are a maintainer-signaling mechanic on owned repos —
an intentional divergence, not part of this cleanup.

## Decisions (from brainstorming)

| Decision              | Choice                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| Filing posture        | Preview → confirm, **universal** (owned and unowned identical)            |
| Eligibility           | Any watchlist repo (owned or external)                                    |
| Preview durability    | Durable review queue — audit parks findings, review/confirm later         |
| Confirm granularity   | Per-finding select                                                        |
| Filing mechanic       | Least-privilege: plain issue (severity in title, marker in body) + best-effort labels |
| Dedup mechanic        | `--author @me` + body-marker scan, **one path** for owned and unowned     |
| Freshness             | Sync external managed clones to upstream's default branch before audit; never touch owned checkouts |

## Architecture: two-phase assess

Today `runAssessFlow` audits *and* files in one daemon pass. Split it:

```
Phase A  (daemon, read-only)          Phase B  (operator, in-process)
┌──────────────────────────┐          ┌──────────────────────────────┐
│ npm audit + agent audit  │          │ list pending → per-finding    │
│ + hallucination filter   │  parks   │ select → confirm              │
│ + severity floor         │ ───────► │   → author-scoped dedup       │
│ + within-run dedup       │  review  │   → file selected (outbox)    │
│ + audit-time GH dedup    │  store   │   → archive batch             │
│ → PendingAssess batch    │          │                               │
└──────────────────────────┘          └──────────────────────────────┘
   assessFlow.ts (changed)   assessReview.ts   assessFiling.ts (new core)
```

Phase B runs **in the CLI/TUI process under the operator's own gh auth**, exactly like
today's dashboard label actions (`src/tui/ghClient.ts`) — not in the daemon. The daemon
never performs an outward write.

## Components

### 1. `src/assessReview.ts` — durable pending store (new)

Same discipline as `watchlist.ts` / `githubOutbox.ts`: one JSON file per batch under
`<state_dir>/assess-review/`, atomic tmp+rename, never throws on read (missing → empty;
corrupt → empty + error string the caller surfaces).

```ts
interface PendingAssess {
  id: string;          // = the assess ticket id (stable across requeue → re-run overwrites, no dup batch)
  nwo: string;         // resolved from origin at audit time
  external: boolean;   // path-based (see §2); drives label set + freshness sync
  autoPlan: boolean;   // owned+autoPlan → trigger label at confirm; forced false when external
  repoPath: string;    // provenance
  createdAt: string;   // ISO (stamped by the caller; Date is injected)
  findings: Finding[]; // full candidate set (all ≥ minSeverity — see §2)
}
```

Functions: `writePending` (atomic, keyed on ticket id), `listPending`, `readPending`,
`removePending` (archive to `assess-review/filed/<id>.json` rather than delete, for an
audit trail), `pendingCount` (for status/health).

Keying the batch on the **assess ticket id** (stable across a transient requeue) means a
re-run overwrites the same file rather than accumulating duplicate batches.

### 2. `src/assessFlow.ts` — Phase A changes

Phases 1–7 (resolve, nwo, npm audit, agent audit, merge/filter, GitHub dedup) are
**unchanged analysis**. Phases 8–9 (label + file) are removed from the flow. New tail:

- **External detection is path-based:** `external = repoPath is under
  resolve(cfg.github.externalReposRoot)`. Deterministic, offline, true by construction
  (`ensureExternalClone` always places external clones there).
- **Freshness sync (external only):** before the audit, `git fetch origin`, resolve
  origin's default branch (`git symbolic-ref refs/remotes/origin/HEAD`), hard-reset the
  clone's working tree to it. Junco owns these clones, so a reset is safe. **Owned repos
  are never fetched or reset** — assess audits whatever is checked out, as today.
- **No cap at parking.** `maxIssuesPerRun` was an auto-file spam guard; with per-finding
  human review the human is the cap. Park **all** findings ≥ `minSeverity`. The config
  field is repurposed as the review UI's *pre-selection* count: the top-`maxIssuesPerRun`
  by severity start checked, the rest start unchecked — preserving the field's
  volume-guarding spirit under human control (no breaking config change).
- **Audit-time GH dedup stays as a pre-filter** (drop findings already filed), so the
  review list is clean; the authoritative dedup re-runs at confirm (§4).
- **Park, don't file:** write the `PendingAssess` batch, finalize the ticket with an "N
  findings awaiting review" summary. `external ⇒ autoPlan := false`.

No `Config` schema change and no `ticketSchema` change: `external`, `autoPlan`, and `nwo`
are all derived at audit time. (Holding the "no new Config field" line avoids the
makeConfig-fixture sweep.)

### 3. `src/assessFiling.ts` — least-privilege filing core (new; the shared seam)

`createIssueLive` moves here out of `assessFlow.ts` (the flow no longer files). New entry
point, reused by both the CLI `file` command and the TUI confirm:

```ts
fileFindings(cfg, batch: PendingAssess, selected: Set<fingerprint>, deps): Promise<FileResult>
```

It: (a) re-runs authoritative author-scoped GH dedup, (b) for each selected, un-filed
finding calls `tryOrEnqueue` → `createIssueLive` (live) or an `issue-create` outbox op
(offline), (c) archives the batch. Returns `{ created, queuedOffline, deduped, failed, urls }`.

**Label set is computed from the batch, not branched in code:**

```
labels = external ? [] : [FINDING_LABEL, `severity/${sev}`, ...(autoPlan ? [trigger] : [])]
```

With `labels: []` the existing executor's `ensureFindingLabels(…, [])` is a no-op and
`gh issue create` gets no `--label` flags — a plain issue any authenticated user can open.
No owned/unowned code fork. (Hardening: wrap `ensureFindingLabels` in a swallow so an
owned repo with a transient label-permission glitch still files the issue label-free.)

This module **is the foundation SP-2/SP-3 build on** — SP-2 adds a `postComment`
counterpart (over the existing outbox `comment` op) behind the same confirm gate.

### 4. `src/githubOutbox.ts` — dedup unification

`fetchFindingMarkers` changes its **list query** from `--label FINDING_LABEL` to
`--author @me --state all` (still `--json body`, still scans bodies via
`extractFindingMarkers` — the `<!-- junco:finding:fp -->` marker is unchanged). One query,
owned and unowned alike.

**No `OutboxOp` shape change and no back-compat break:** issues filed by older
label-based runs were authored by `@me` too, so author-scoped replay dedup covers them.
The `issue-create` executor is otherwise untouched; external ops simply carry `labels: []`.

### 5. Surfaces

- **CLI** (`src/assessCmd.ts`):
  - Resolution: include external watchlist entries (read the raw watchlist, not
    `resolveWatchedRepos`), so `junco assess <external-nwo>` maps to the managed clone.
  - `junco assess review` — list pending batches (id, nwo, count, age).
  - `junco assess review <id>` — findings with fingerprints + default selection state.
  - `junco assess file <id> --all | --only <fp,…>` — confirm. **No bare default**; a
    selection flag is required, since these writes land on someone else's tracker.
- **TUI** (`src/tui/App.tsx`, `ghClient.ts`): the `A` key stops refusing external repos —
  it submits an assess ticket for the selected repo. A new **review view** lists pending
  batches; entering one gives a per-finding checklist (`space` toggle, `a` all, `n` none,
  `f`/enter files selected). Mirrors existing queue/detail view patterns.
- **Visibility:** `pendingCount` surfaced in `status` and `/health`, mirroring
  `outboxDepth`.

## Tradeoffs & limitations

- **Author-scoped dedup on shared owned repos.** The old label filter was
  author-agnostic; `--author @me` only sees the operator's own issues. On a repo where
  **multiple operator accounts** file findings, one account can miss another's and
  re-file. The body marker keeps this from ever corrupting state — it is a possible
  duplicate, not a wrong write — and single-operator installs (the norm) are unaffected.
  A future widening (union a best-effort label scan on owned repos) is deferred.
- **Discard is per-run.** Un-selected findings re-surface on the next assess (no issue
  exists → GH dedup does not suppress them). Permanent per-finding suppression is a
  non-goal here.
- **500-issue dedup cap** (`fetchFindingMarkers --limit 500`) is the pre-existing issue
  #41 follow-up, unchanged.
- **`gh issue create` on an unowned repo** requires only auth + issues enabled; `--label`
  requires triage. This is the empirical assumption to verify during implementation
  against a *throwaway* repo the operator controls (never a real project).

## Non-goals

- Commenting on / analysis of existing issues (**SP-2**).
- Assess scoped to a specific issue (**SP-3**).
- Collapsing dispatch's label-driven trigger / lifecycle labels into least-privilege.
- Permanent per-finding suppression; dedup pagination past 500; bridge polling of external
  repos (still never).

## Testing

- **`assessReview`** (unit): write/list/read/remove/archive; atomic; missing → empty;
  corrupt → empty + error; `pendingCount`.
- **External detection** (unit): path under `externalReposRoot` ⇒ external; sibling paths
  ⇒ not.
- **`assessFlow`**: parks instead of files; transient requeue overwrites the same batch id
  (no dup); `external ⇒ autoPlan false`; external clone synced to origin default before
  audit; **owned repo never fetched/reset**; `maxIssuesPerRun` drives pre-selection, not
  parking count.
- **`assessFiling`** (real-git harness): author-scoped dedup; `--only`/`--all`; label set
  by external flag (external ⇒ no `--label`); archive to `filed/`; file-time dedup
  convergence; offline → `issue-create` op enqueued.
- **`githubOutbox`**: `fetchFindingMarkers` lists by author; replay of an
  older-style op (labelled issue) still dedups by author (back-compat).
- **TUI** (Ink, loop-until-condition per the flake gotcha): review view renders batches;
  per-finding toggle; file-selected; `A` submits for an external repo.
- **No `Config` field added** → no makeConfig fixture sweep (deliberate).
- **One live check** during implementation: label-free `gh issue create` succeeds on an
  unowned repo, `--label` fails — against a throwaway repo only.

## Docs to update

- **This spec supersedes** the `2026-07-08` etiquette-invariant clause on issue-tracker
  writes; add a pointer there and land the redrawn invariant.
- **README** — assess was just restructured (commit `2d27c82`) as "files issues
  directly." Update to preview → confirm (all repos) + external eligibility, stack-agnostic.
- **Packaged `junco-dispatch` skill** — Assess-mode blurb updated for the review gate +
  external repos; no personal-setup strings.
- **ARCHITECTURE.md** — add the review store + two-phase assess to the module map.

## Implementation phasing

One spec, two plan-sized implementations, both TDD, commit-per-task, `feat/` branch off
**latest** `origin/main`:

- **Plan 1 (core, headless-complete):** `assessReview` + `assessFiling` + two-phase
  `assessFlow` + external detect/sync + outbox dedup unification + CLI `review`/`file` +
  resolution gate removal + status/health + docs. Delivers the full capability via CLI.
- **Plan 2 (TUI UX):** review view + per-finding checklist + `A`-key rewire.
