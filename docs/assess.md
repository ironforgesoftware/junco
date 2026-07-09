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
│ junco assess <path|owner/repo> [--auto-plan]
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

### `junco assess <path|owner/repo> [--auto-plan]` — audit

```bash
junco assess <path|owner/repo> [--auto-plan]
```

- **`<path>`** — an absolute or `~`-relative filesystem path to a local git checkout.
- **`<owner/repo>`** — matched case-insensitively against the watched repo list: `[[github.repos]]` entries, anything added from the dashboard, **and external (unowned, fork-managed) watchlist entries**. The target must already be watched — if not, the command errors instead of guessing a clone path.
- **`--auto-plan`** — apply the configured GitHub trigger label (`[github].trigger_label`, default `junco`) to every issue filed from this batch, so the bridge can pick each one up. Only takes effect on owned repos filed via Phase B below — an external batch always forces `autoPlan` off, regardless of this flag. See the caveat below.

A target that looks like `owner/repo` (word characters either side of one slash) is treated as a watched-repo lookup unless a local directory by that literal name exists, in which case it's treated as a path instead.

What gets printed:

| Outcome                  | stdout                                                                                                                                                   | Exit |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| No target given          | `Usage: junco assess <path\|owner/repo> [--auto-plan]`                                                                                                   | 2    |
| `owner/repo` not watched | `junco assess: '<target>' is not watched — add it under [[github.repos]] in config.toml, or watch it from the dashboard, then retry`                     | 2    |
| Path is not a directory  | `junco assess: not a directory: <resolved-path>`                                                                                                         | 2    |
| Ticket submission failed | `junco assess: <error>`                                                                                                                                  | 1    |
| Queued                   | `queued: <ticket-path>`, then `queued — the worker will audit the repo and file issues on its next claim` (plus a third line when `--auto-plan` was set) | 0    |

The command only composes and submits the ticket. The actual audit — `npm audit`, the agent session, dedup, and parking — runs later, whenever the daemon claims the ticket. Nothing files yet; that's Phase B, below.

### `junco assess review [<id>]` — list / inspect pending findings

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

- **Issue creation goes through the same outbox as everything else GitHub.** When `gh issue create` fails for a network reason during `junco assess file`, the create is queued to `<state_dir>/github-outbox/` instead of failing the run. `junco outbox` lists what's queued, `junco outbox flush` (or the next bridge sweep) drains it, and the dashboard header shows a `⇡N unpushed` chip while anything is queued.
- **`npm audit` needs registry access.** A failure — offline or otherwise — never aborts the audit: it's recorded as a warning in the ticket's finalize summary, and the run continues with agent-only (code) findings, still parked for review.
- **The GitHub-side dedup scan can itself be offline,** at either phase. During the audit (Phase A), a network failure degrades to an empty dedup set rather than failing the run — findings park as if new. During filing (Phase B), the same degrade applies — findings file as if new — and the outbox's fresh re-scan at flush time is what keeps that from duplicating. Any other dedup-scan failure (not network-shaped) is fatal to the run/file attempt, since junco won't risk mass-refiling against unknown upstream state.

## `--auto-plan` caveat

`--auto-plan` only gets a finding as far as the trigger label, and only on an **owned** repo — an external batch forces `autoPlan` off no matter what the flag said at audit time, since junco doesn't queue plan/PR work against a repo it doesn't own. On an owned repo, the label lands on every issue the batch files (once you confirm with `junco assess file`) either way, but it's the bridge that turns a labeled issue into a plan — and the bridge only sweeps repos it's watching, and only when `[github].enabled = true`. If the target repo isn't bridge-watched (or the bridge is disabled), the issues still file, but the label sits there inert until the repo is watched.

## Config

`[assess]` — knobs for `junco assess` runs (verified against `src/config.ts`):

| Key                  | Default | Description                                                                                                                                                                                                                                                                                  |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_issues_per_run` | `20`    | Historical cap on issues filed per run. Parking has no cap — your review pass at `junco assess file` is the volume gate now — so this field currently has no effect; it's kept for config compatibility and may resurface as a review-list pre-selection default in a future dashboard view. |
| `min_severity`       | `"low"` | Findings ranked below this are dropped before parking. One of `critical`, `high`, `medium`, `low`.                                                                                                                                                                                           |
| `npm_bin`            | `"npm"` | Binary used for the dependency scan (`<npm_bin> audit --json`).                                                                                                                                                                                                                              |

## Ticket flavor

`junco assess` composes and submits the ticket itself — you don't hand-author it. Its frontmatter:

```yaml
---
id: assess-<repo-basename>-<UTC stamp>
repo: <absolute path to the audit target>
assess:
  auto_plan: true # only present with --auto-plan; otherwise `assess: {}`
---
```

Presence of the `assess:` mapping is what selects this flavor (see the flavor table in [docs/tickets.md](./tickets.md)) — the daemon audits the `repo:` path and parks issues for review instead of running Q&A or PR flow. Unlike every other ticket carrying `repo:`, an assess ticket **never opens a pull request**: the daemon checks for `assess:` before it checks for `repo:`, so an assess ticket always short-circuits into the audit flow above.

The pending review batch is keyed by this ticket's `id`, so a transient requeue (crash, transient agent failure) that re-runs the same ticket **overwrites** the same batch rather than creating a duplicate — `junco assess review <id>` always reflects the latest audit for that ticket.

## Visibility

`junco status` and `junco doctor` both print `assess review: N pending (junco assess review)` whenever the pending-review store is non-empty, so a backlog of unreviewed findings doesn't go unnoticed between audits.
