# Vulnerability assessment

`junco assess` — audit a repository, park what it finds for review, then file the findings you confirm as GitHub issues.

[← back to the README](../README.md)

Junco authors the issues; it never merges anything on its own. Filing is gated by a human review step of its own — you see every finding's fingerprint, severity, and title before anything lands on a tracker. Beyond that, the human gates are the same ones GitHub-integrated mode already has: **triage** (labeling a filed issue for planning), **approval** (of the resulting plan), and **merge** (of the resulting PR) — assess just gives junco something concrete to author instead of waiting for you to write the first issue.

**Works on any watched repo — owned or not.** A repo you own gets `junco:finding` + `severity/<level>` labels on filed issues (best-effort) and can opt into `--auto-plan`. A repo you don't own gets label-free issues (junco never assumes triage rights it doesn't have), and `--auto-plan` has no effect there — junco doesn't queue plan/PR work against a repo it doesn't own.

## The flow (two phases)

Phase A is the daemon's read-only audit; it **parks** findings instead of filing them. Phase B is you (or a follow-up `junco assess` invocation), reviewing and confirming what actually gets filed — that step runs under your own `gh` auth, not the daemon's.

```
You (or CI, a cron job, …)
│
│ junco assess <path|owner/repo|owner/repo#N> [--auto-plan]
▼
inbox/                              ← one machine-owned assessment ticket
│
│ daemon polls every 15s
▼
┌───────────────────────────────────────────────────────────────┐
│ Phase A — junco daemon (assessFlow.ts), read-only               │
│                                                                  │
│ 1. claim inbox/ → processing/                                   │
│ 2. external clone? → sync to upstream's default branch first    │
│    (owned checkouts are never fetched or reset)                 │
│ 3. npm audit --json          → dependency findings              │
│ 4. read-only agent audit     → code findings                    │
│ 5. validate + sanitize + severity filter + within-run dedupe    │
│ 6. GitHub-side dedup           fetchFindingMarkers (last 500,   │
│                                 your own issues, any repo)      │
│ 7. park ALL survivors          assessReview.ts (durable store)  │
│ 8. finalize processing/ → done/|failed/, summary names the id   │
└───────────────────────────────────────────────────────────────┘
│
▼
pending review batch, keyed by the ticket id
│
│ junco assess review [<id>]        ← you list / inspect pending findings
│ junco assess file <id> --all | --only <fingerprint,…>
▼
┌───────────────────────────────────────────────────────────────┐
│ Phase B — you, in-process, under your own gh auth (assessFiling.ts) │
│                                                                  │
│ 1. re-run authoritative dedup for the selected findings          │
│ 2. owned repo → best-effort ensure junco:finding + severity/*    │
│    labels; external repo → label-free by construction            │
│ 3. file each selected, un-filed finding as a GitHub issue        │
│    (via the offline-durable outbox)                              │
│ 4. archive the batch                                             │
└───────────────────────────────────────────────────────────────┘
│
▼
GitHub issues (labeled on owned repos, label-free on repos you don't own)
│
│ --auto-plan only, owned + bridge-watched repos only
▼
+ trigger label → the plan → approve → PR loop (docs/github-mode.md)
```

Nothing is filed until Phase B runs. A batch that's never reviewed just sits in the pending store — it doesn't expire, and a re-run of `junco assess` on the same ticket id overwrites it rather than piling up duplicates.

## CLI usage

### `junco assess <path|owner/repo|owner/repo#N> [--auto-plan]` — audit

```bash
junco assess <path|owner/repo|owner/repo#N> [--auto-plan]
```

- **`<path>`** — an absolute or `~`-relative filesystem path to a local git checkout.
- **`<owner/repo>`** — matched case-insensitively against the watched repo list: `github.repos` entries, anything added from the dashboard, **and external (unowned, fork-managed) watchlist entries**. The target must already be watched — if not, the command errors instead of guessing a clone path.
- **`owner/repo#N`** (or an issue URL) — scopes the audit to one issue instead of a whole-repo sweep, and **auto-provisions** an unwatched repo (fork, clone, watchlist add) instead of requiring it be watched already. See [Issue-scoped assess](#issue-scoped-assess) below.
- **`--auto-plan`** — apply the configured GitHub trigger label (`github.triggerLabel`, default `junco`) to every issue filed from this batch, so the bridge can pick each one up. Only takes effect on owned repos filed via Phase B below — an external batch always forces `autoPlan` off, regardless of this flag. See the caveat below.

A target that looks like `owner/repo#N` (or an issue URL) is resolved as an issue reference first. Otherwise, a target that looks like `owner/repo` (word characters either side of one slash) is treated as a watched-repo lookup unless a local directory by that literal name exists, in which case it's treated as a path instead.

What gets printed:

| Outcome                  | stdout                                                                                                                                                                                                                                      | Exit |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| No target given          | `Usage: junco assess <path\|owner/repo\|owner/repo#N> [--auto-plan]`                                                                                                                                                                        | 2    |
| `owner/repo` not watched | `junco assess: '<target>' is not watched — add it under github.repos in config.json, or watch it from the dashboard, then retry`                                                                                                            | 2    |
| Path is not a directory  | `junco assess: not a directory: <resolved-path>`                                                                                                                                                                                            | 2    |
| Ticket submission failed | `junco assess: <error>`                                                                                                                                                                                                                     | 1    |
| Queued                   | `queued: <ticket-path>`, then `queued — the worker will audit the repo and park findings for review on its next claim; run 'junco assess review' then 'junco assess file <id>' to file them` (plus a third line when `--auto-plan` was set) | 0    |

The command only composes and submits the ticket. The actual audit — `npm audit`, the agent session, dedup, and parking — runs later, whenever the daemon claims the ticket. Nothing files yet; that's Phase B, below.

### `junco assess review [<id>]` — list / inspect pending findings

The same review can also be done without leaving the dashboard: press `v` there to open the in-dashboard review view, a per-finding checklist with the same select/confirm-to-file flow described below.

```bash
junco assess review              # list every pending batch
junco assess review <id>         # show one batch's findings
```

With no id, prints one line per pending batch: id, nwo, `(owned)`/`(external)`, finding count, and the audit's timestamp — or `no pending assess reviews` if the store is empty.

With an id, prints the batch's `nwo`/scope followed by each finding's fingerprint, severity, and title, then two ready-to-run hints: `junco assess file <id> --all` and a `--only <fp,fp>` example built from the first two fingerprints.

### `junco assess file <id> --all | --only <fingerprint,…>` — confirm and file

```bash
junco assess file <id> --all
junco assess file <id> --only <fingerprint>,<fingerprint>,…
```

Files the selected findings as GitHub issues (through `assessFiling.ts`) and archives the batch. **There is no bare default** — you must pass `--all` or `--only <fingerprints>` — because these are writes landing on someone else's issue tracker as much as your own. Findings you don't select simply stay unreviewed for the next audit; they aren't suppressed (see dedup semantics below).

Before filing, it re-runs the authoritative dedup scan (so a finding someone already filed by hand in the meantime is skipped, not duplicated) and, on an owned repo, best-effort ensures the `junco:finding` + `severity/<level>` labels exist — if that fails (e.g. a transient permission glitch), the issue still files, just label-free, rather than the whole run failing.

Prints a one-line summary — `filed N · queued N · already-filed N · failed N` — followed by the created issue URLs and any warnings, and exits `1` if anything failed to file.

## Issue-scoped assess

`junco assess owner/repo#N` (or a full issue URL) points the audit at one issue instead of sweeping the whole repo. Target resolution goes through the same `resolveIssueTarget` helper `junco dispatch` and `junco analyze` use: a fail-fast `gh issue view` fetch, then either resolve against an already-watched repo or **auto-provision** an unwatched one — fork, clone into a managed directory, add it to the watchlist.

**This auto-provisioning is asymmetric with the plain `owner/repo` form above, and that's deliberate.** `junco assess <nwo>` on its own still requires the repo be already watched — no clone is provisioned for it. An issue reference is treated as an explicit, single-issue ask; a bare repo target is a broader operation that shouldn't silently provision a clone just because you typed a name it recognizes as `owner/repo`-shaped.

The audit prompt gains an extra section carrying the issue's title and body, framed the same way `junco dispatch`/`junco analyze` frame issue text: explicit untrusted data, not instructions, with an instruction to scope the audit to the code that issue implicates (findings outside that scope are still reported, just deprioritized).

Findings park exactly like a whole-repo audit's do — same store, same `junco assess review` / `junco assess file` flow, same dashboard review view. The one difference is in what gets filed: each finding's issue body gets a `**Context:** <owner/repo>#<N>` line immediately before the machine-readable block. GitHub turns that into an automatic cross-reference, so every filed finding shows up on the original issue's timeline for free. **No comment is posted on the issue itself** — an issue-scoped assess run is read-only apart from the issues it files; posting prose on the original issue is a different, deliberate command, `junco analyze` (see the [analysis comments guide](./analyze.md)).

**Dedup is shared, not scoped.** Fingerprints (`sha256("<kind>|<ruleId>|<locus>")`) never fold in the scoping issue, so a finding surfaced by an issue-scoped audit and the same finding surfaced later by a whole-repo audit — or vice versa — collide and dedup against each other. Re-running assess in either mode never double-files the same defect.

**From the dashboard:** `s`/`S` scope to the selected issue when the issues pane (pane 2) is focused and an issue is selected; everywhere else they stay repo-scoped. See [Dashboard](./dashboard.md).

## Issue format

Each filed finding becomes one GitHub issue:

- **Title:** `[<severity>] <title> (<ruleId>)` — flattened to one line, capped at 120 characters.
- **Body:** whichever of these sections apply — `## Summary`, `## Package` (dependency findings: name / vulnerable range / fixed-in), `## Location` (code findings: `path` or `path:line`), `## Evidence`, `## Remediation`, `## References` — followed by a `<details><summary>machine-readable</summary>` block containing the full finding as JSON, and closing with a `<!-- junco:finding:<fingerprint> -->` marker as the literal last line, outside every fence. That marker line is what the dedup scan reads back.
- **Labels — owned repos only, best-effort:** `junco:finding` + `severity/<level>`, plus the configured trigger label when the batch was `--auto-plan`. A repo you don't own gets **no labels at all** — junco doesn't create or apply labels it may not have rights to; the severity and fingerprint still live in the title and the marker, so the issue is fully self-describing without them.

**Fingerprint:** `sha256("<kind>|<ruleId>|<locus>")` truncated to 16 hex characters, where `locus` is the package name for dependency findings, else the code location's file path, else the title. Line numbers are deliberately excluded from the fingerprint, so it survives the surrounding code drifting.

## Dedup semantics

- **Within a run:** npm-audit findings and agent findings are merged; the first occurrence of each fingerprint wins, and later duplicates are dropped before anything is parked.
- **Against GitHub, one path for owned and unowned repos:** both the audit-time pre-filter and the authoritative file-time check scan **your own most recent 500 issues on the target repo** (`gh issue list --author @me --state all`) for `<!-- junco:finding:... -->` markers, and skip any fingerprint already present. This replaced an earlier label-based scan (`--label junco:finding`) — issues filed by older, label-based runs were authored by you too, so they're still found.
- **Offline replay is idempotent:** an issue queued to the outbox re-runs that same marker scan fresh at flush time (never from a cache), so two offline runs that both queued the same finding still converge to one issue.
- **Author-scoped is a tradeoff, not a correctness gap.** If more than one of your own GitHub accounts files findings on the same repo, one account's scan won't see another's, and a finding can be re-filed under both. The `<!-- junco:finding:... -->` marker means that's a possible duplicate, never a corrupted state — and it doesn't affect the common single-account case.

> **Caveat — read this before closing a finding as wontfix.** Because closed issues still count toward the scan, closing a finding issue for any reason suppresses that fingerprint **forever** — including a genuine future regression that hashes to the same fingerprint. To let junco re-file it, delete the issue, or edit the `<!-- junco:finding:... -->` marker line out of its body.
>
> **A parked-but-never-filed finding is different: it isn't suppressed.** If you review a batch and don't select a finding (or never run `junco assess file` on it at all), the next audit re-parks it, because no issue — and so no marker — exists yet.

## Offline behavior

- **Issue creation goes through the same outbox as everything else GitHub.** When `gh issue create` fails for a network reason during `junco assess file`, the create is queued to `<dataDir>/outbox/` instead of failing the run. `junco outbox` lists what's queued, `junco outbox flush` (or the next bridge sweep) drains it, and the dashboard header shows a `⇡N unpushed` chip while anything is queued.
- **`npm audit` needs registry access.** A failure — offline or otherwise — never aborts the audit: it's recorded as a warning in the ticket's finalize summary, and the run continues with agent-only (code) findings, still parked for review.
- **The GitHub-side dedup scan can itself be offline,** at either phase. During the audit (Phase A), a network failure degrades to an empty dedup set rather than failing the run — findings park as if new. During filing (Phase B), the same degrade applies — findings file as if new — and the outbox's fresh re-scan at flush time is what keeps that from duplicating. Any other dedup-scan failure (not network-shaped) is fatal to the run/file attempt, since junco won't risk mass-refiling against unknown upstream state.

## `--auto-plan` caveat

`--auto-plan` only gets a finding as far as the trigger label, and only on an **owned** repo — an external batch forces `autoPlan` off no matter what the flag said at audit time, since junco doesn't queue plan/PR work against a repo it doesn't own. On an owned repo, the label lands on every issue the batch files (once you confirm with `junco assess file`) either way, but it's the bridge that turns a labeled issue into a plan — and the bridge only sweeps repos it's watching, and only when `github.enabled = true`. If the target repo isn't bridge-watched (or the bridge is disabled), the issues still file, but the label sits there inert until the repo is watched.

## Config

`assess.*` — knobs for `junco assess` runs (verified against `src/config.ts`):

| Key                      | Default | Description                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assess.maxIssuesPerRun` | `20`    | Historical cap on issues filed per run. Parking has no cap — your review pass at `junco assess file` is the volume gate now — so this field currently has no effect; it's kept for config compatibility and may resurface as a review-list pre-selection default in a future dashboard view. |
| `assess.minSeverity`     | `"low"` | Findings ranked below this are dropped before parking. One of `critical`, `high`, `medium`, `low`.                                                                                                                                                                                           |
| `assess.npmBin`          | `"npm"` | Binary used for the dependency scan (`<npmBin> audit --json`).                                                                                                                                                                                                                               |

## Ticket flavor

`junco assess` composes and submits the ticket itself — you don't hand-author it. Its frontmatter:

```yaml
---
id: assess-<repo-basename>-<UTC stamp>
repo: <absolute path to the audit target>
assess:
  auto_plan: true # only present with --auto-plan
  issue: 42 # only present when scoped via `junco assess owner/repo#N`
  issue_title: "..." # machine-built, display-only; travels with `issue`
# `assess: {}` when neither --auto-plan nor an issue scope applies
---
```

Presence of the `assess:` mapping is what selects this flavor (see the flavor table in [docs/tickets.md](./tickets.md)) — the daemon audits the `repo:` path and parks findings for review instead of running Q&A or PR flow. Unlike every other ticket carrying `repo:`, an assess ticket **never opens a pull request**: the daemon checks for `assess:` before it checks for `repo:`, so an assess ticket always short-circuits into the audit flow above.

The pending review batch is keyed by this ticket's `id`, so a transient requeue (crash, transient agent failure) that re-runs the same ticket **overwrites** the same batch rather than creating a duplicate — `junco assess review <id>` always reflects the latest audit for that ticket.

## Assess history — the rail indicator

Every whole-repo `junco assess` run records one history entry for that repo when it finishes — success or failure. Three surfaces read it: the dashboard rail (a compact indicator next to each repo), and `junco status`/`junco doctor` (a plain-text line with the full breakdown). Nothing is recorded until a whole-repo run finishes; a ticket that dies before the repo is resolved records nothing either.

In the dashboard rail (pane 1), each watched repo's row ends with a fixed-width indicator:

| Indicator | Meaning                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------- |
| `—`       | Never assessed — no whole-repo run has ever finished, success or failure.                          |
| `2h 0✓`   | Last successful whole-repo audit finished 2 hours ago and found nothing.                           |
| `21d 4⚠`  | Last successful whole-repo audit finished 21 days ago and found 4 findings.                        |
| `21d! 4⚠` | Same as above, but the most recent attempt (since that success) failed — the `!` suffixes the age. |
| `— !`     | The repo has never had a successful whole-repo audit, and the most recent attempt failed.          |

Age caps at `99d+`, the finding count at `99+`, so a long-neglected repo can't blow out the rail's fixed-width column.

**The age always tracks the last _successful_ whole-repo audit — never a failed attempt.** A failed run appends the `!` marker so a broken audit doesn't go unnoticed, but it never moves the age or the finding count: a repo whose audits keep failing stays visibly distinct from one that was genuinely re-audited, and a crashed run can never make a stale repo look freshly checked.

**Issue-scoped runs (`junco assess owner/repo#N`) deliberately do not update this history at all.** They audit only the code the referenced issue implicates rather than sweeping the whole repo, so folding their result into the repo's freshness indicator would overstate how much of the repo was actually covered. Only a whole-repo `junco assess <path|owner/repo>` run writes a history entry; an issue-scoped run leaves the rail, `status`, and `doctor` output for that repo untouched.

## Visibility

`junco status` and `junco doctor` both print `assess review: N pending (junco assess review)` whenever the pending-review store is non-empty, so a backlog of unreviewed findings doesn't go unnoticed between audits.

They also print the same per-repo assess history the rail shows, as plain text, once per repo that has ever been assessed (silent when none has). `junco status`:

```
assess:    <owner/repo> assessed 2026-07-14 · 4 found · 4 parked
assess:    <owner/repo> assessed 2026-07-14 · 4 found · 4 parked · last attempt failed 2026-07-16
assess:    <owner/repo> never assessed · last attempt failed 2026-07-16
```

`junco doctor` reports the same repos as informational lines — always `ok`, never a warning, since a stale or never-assessed repo is normal workflow state, not a health problem:

```
✓ assess history — <owner/repo>: assessed 2026-07-14 (last attempt failed)
✓ assess history — <owner/repo>: never assessed
```

Both the date printed (`assessed YYYY-MM-DD`) and the `last attempt failed` marker trace back to the same fields the rail indicator reads, so the rail, `status`, and `doctor` always agree with each other.
