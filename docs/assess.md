# Vulnerability assessment

`junco assess` — audit a repository and turn what it finds into GitHub issues.

[← back to the README](../README.md)

Junco authors the issues; it never merges anything on its own. The human gates are the same ones GitHub-integrated mode already has: **triage** (labeling a filed issue for planning), **approval** (of the resulting plan), and **merge** (of the resulting PR) — assess just gives junco something concrete to author instead of waiting for you to write the first issue.

## The flow

```
You (or CI, a cron job, …)
│
│ junco assess <path|owner/repo> [--auto-plan]
▼
<vault_root>/Junco/inbox/           ← one machine-owned assessment ticket
│
│ daemon polls every 15s
▼
┌───────────────────────────────────────────────────────────────┐
│ junco daemon (assessFlow.ts)                                   │
│                                                                  │
│ 1. claim inbox/ → processing/                                   │
│ 2. npm audit --json          → dependency findings              │
│ 3. read-only agent audit     → code findings                    │
│ 4. validate + sanitize + severity filter + within-run dedupe    │
│ 5. GitHub-side dedup          fetchFindingMarkers (last 500)    │
│ 6. cap at [assess].max_issues_per_run                           │
│ 7. file issues                 junco:finding + severity/<level>│
│ 8. finalize processing/ → done/|failed/                         │
└───────────────────────────────────────────────────────────────┘
│
▼
GitHub issues (junco:finding, severity/<level>)
│
│ --auto-plan only, and only if the target repo is bridge-watched
▼
+ trigger label → the plan → approve → PR loop (docs/github-mode.md)
```

## CLI usage

```bash
junco assess <path|owner/repo> [--auto-plan]
```

- **`<path>`** — an absolute or `~`-relative filesystem path to a local git checkout.
- **`<owner/repo>`** — matched case-insensitively against the watched repo list (`[[github.repos]]` entries and anything added from the dashboard). The target must already be watched — if not, the command errors instead of guessing a clone path.
- **`--auto-plan`** — apply the configured GitHub trigger label (`[github].trigger_label`, default `junco`) to every issue this run files, so the bridge can pick each one up. See the caveat below.

A target that looks like `owner/repo` (word characters either side of one slash) is treated as a watched-repo lookup unless a local directory by that literal name exists, in which case it's treated as a path instead.

What gets printed:

| Outcome                  | stdout                                                                                                                                                   | Exit |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| No target given          | `Usage: junco assess <path\|owner/repo> [--auto-plan]`                                                                                                   | 2    |
| `owner/repo` not watched | `junco assess: '<target>' is not watched — add it under [[github.repos]] in config.toml, or watch it from the dashboard, then retry`                     | 2    |
| Path is not a directory  | `junco assess: not a directory: <resolved-path>`                                                                                                         | 2    |
| Ticket submission failed | `junco assess: <error>`                                                                                                                                  | 1    |
| Queued                   | `queued: <ticket-path>`, then `queued — the worker will audit the repo and file issues on its next claim` (plus a third line when `--auto-plan` was set) | 0    |

The command only composes and submits the ticket. The actual audit — `npm audit`, the agent session, dedup, and filing — runs later, whenever the daemon claims the ticket.

## Issue format

Each finding files as one GitHub issue:

- **Title:** `[<severity>] <title> (<ruleId>)` — flattened to one line, capped at 120 characters.
- **Body:** whichever of these sections apply — `## Summary`, `## Package` (dependency findings: name / vulnerable range / fixed-in), `## Location` (code findings: `path` or `path:line`), `## Evidence`, `## Remediation`, `## References` — followed by a `<details><summary>machine-readable</summary>` block containing the full finding as JSON, and closing with a `<!-- junco:finding:<fingerprint> -->` marker as the literal last line, outside every fence. That marker line is what the dedup scan reads back.
- **Labels:** `junco:finding` + `severity/<level>`, plus the configured trigger label when the run was `--auto-plan`.

**Fingerprint:** `sha256("<kind>|<ruleId>|<locus>")` truncated to 16 hex characters, where `locus` is the package name for dependency findings, else the code location's file path, else the title. Line numbers are deliberately excluded from the fingerprint, so it survives the surrounding code drifting.

## Dedup semantics

- **Within a run:** npm-audit findings and agent findings are merged; the first occurrence of each fingerprint wins, and later duplicates are dropped before anything files.
- **Against GitHub:** before filing, junco scans the most recent 500 issues carrying the `junco:finding` label — **`--state all`**, so closed issues count too — for their `<!-- junco:finding:... -->` markers, and skips any fingerprint already present.
- **Offline replay is idempotent:** a queued issue-create op re-runs that same marker scan fresh at flush time (never from a cache), so two offline runs that both queued the same finding still converge to one issue.

> **Caveat — read this before closing a finding as wontfix.** Because closed issues still count toward the scan, closing a finding issue for any reason suppresses that fingerprint **forever** — including a genuine future regression that hashes to the same fingerprint. To let junco re-file it, delete the issue, or edit the `<!-- junco:finding:... -->` marker line out of its body.

## Offline behavior

- **Issue creation goes through the same outbox as everything else GitHub.** When `gh issue create` fails for a network reason, the create is queued to `<state_dir>/github-outbox/` instead of failing the run. `junco outbox` lists what's queued, `junco outbox flush` (or the next bridge sweep) drains it, and the dashboard header shows a `⇡N unpushed` chip while anything is queued.
- **`npm audit` needs registry access.** A failure — offline or otherwise — never aborts the run: it's recorded as a warning in the ticket's finalize summary, and the run continues with agent-only (code) findings.
- **The GitHub-side dedup scan can itself be offline.** A network failure there degrades to an empty dedup set rather than failing the run — findings file as if new, and the outbox's fresh re-scan at flush time is what keeps that from duplicating. Any other dedup-scan failure (not network-shaped) is fatal to the run, since junco won't risk mass-refiling against unknown upstream state.

## `--auto-plan` caveat

`--auto-plan` only gets a finding as far as the trigger label. The label lands on every issue the run creates either way, but it's the bridge that turns a labeled issue into a plan — and the bridge only sweeps repos it's watching, and only when `[github].enabled = true`. If the target repo isn't watched (or the bridge is disabled), the issues still file, but the label sits there inert until the repo is watched.

## Config

`[assess]` — knobs for `junco assess` runs (verified against `src/config.ts`):

| Key                  | Default | Description                                                                                                    |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `max_issues_per_run` | `20`    | Cap on issues filed per run. Anything beyond it is recorded in the summary (with titles) so a re-run files it. |
| `min_severity`       | `"low"` | Findings ranked below this are dropped before filing. One of `critical`, `high`, `medium`, `low`.              |
| `npm_bin`            | `"npm"` | Binary used for the dependency scan (`<npm_bin> audit --json`).                                                |

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

Presence of the `assess:` mapping is what selects this flavor (see the flavor table in [docs/tickets.md](./tickets.md)) — the daemon audits the `repo:` path and files issues instead of running Q&A or PR flow. Unlike every other ticket carrying `repo:`, an assess ticket **never opens a pull request**: the daemon checks for `assess:` before it checks for `repo:`, so an assess ticket always short-circuits into the audit flow above.
