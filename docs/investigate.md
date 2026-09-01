# Issue investigation

`junco investigate` — investigate a GitHub issue read-only, draft a comment, then post it only after you review it.

[← back to the README](../README.md)

Point junco at any issue — owned repo or not — and it investigates the codebase against that issue: root cause, `file:line` evidence, reproduction steps, a suggested fix direction. Nothing is posted. The investigation is **parked** as a draft you review, can edit, and post yourself, under your own `gh` auth. The only outward-facing write in the whole flow is that human-confirmed post.

**Works on any watched repo — owned or not.** A repo you already watch resolves directly. An unwatched repo is auto-forked and cloned into a managed directory — exactly the provisioning `junco import` does for an external issue — and added to your watchlist, so there's no separate "watch it first" step before you can investigate an issue on it.

## The flow (two phases)

Phase A is the daemon's read-only investigation; it **parks** a comment draft instead of posting it. Phase B is you, reviewing, optionally editing, and explicitly posting — that step runs under your own `gh` auth, not the daemon's.

```
You
│
│ junco investigate <owner/repo#N|issue-url>
▼
inbox/                              ← one machine-owned investigation ticket
│
│ daemon polls every 15s
▼
┌───────────────────────────────────────────────────────────────┐
│ Phase A — junco daemon (analyzeFlow.ts), read-only              │
│                                                                  │
│ 1. claim inbox/ → processing/                                   │
│ 2. external clone? → sync to upstream's default branch first    │
│    (owned checkouts are never fetched or reset)                 │
│ 3. read-only agent investigation of the issue against the repo  │
│ 4. extract the drafted comment from a junco-comment fence        │
│ 5. sanitize (strips HTML comments + control chars, caps length) │
│ 6. park the draft                commentReview.ts (durable store)│
│ 7. finalize processing/ → done/|failed/, summary names the id   │
└───────────────────────────────────────────────────────────────┘
│
▼
one parked draft, keyed by the ticket id
│
│ junco investigate review [<id>]       ← you list / preview the draft
│ junco investigate edit <id>           ← optional: $EDITOR round-trip
│ junco investigate post <id>           ← you confirm
▼
┌───────────────────────────────────────────────────────────────┐
│ Phase B — you, under your own gh auth (analyzeCmd.ts)           │
│                                                                  │
│ 1. compose draft + disclosure footer (unless --no-footer)       │
│ 2. post live (gh issue comment), or queue to the outbox offline │
│ 3. archive the draft to posted/                                 │
└───────────────────────────────────────────────────────────────┘
│
▼
comment on the issue (owner/repo#N)
```

Nothing posts until Phase B runs. A draft that's never reviewed just sits in the pending store — it doesn't expire — and re-investigating the same issue overwrites it rather than piling up duplicates.

## CLI usage

### `junco investigate <owner/repo#N|url>` — investigate

```bash
junco investigate <owner/repo#N|url>
```

Accepts an `owner/repo#N` reference or a full `https://github.com/<owner>/<repo>/issues/<N>` URL — the same reference shape `junco import` accepts. Unlike `junco audit`, there's no local-path form: investigate always targets a specific issue.

Resolution (`resolveIssueTarget`, shared with `junco import`) fetches the issue via `gh`, then either maps it to an already-watched repo's clone or auto-forks and provisions a managed clone for an unowned one, adding it to the watchlist. A bad reference, an unreadable issue, or a provisioning failure aborts before anything is queued.

What gets printed:

| Outcome                         | stdout                                                                                                                                                                                                                                                                                   | Exit |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| No target given                 | `Usage: junco investigate <owner/repo#N\|url>`                                                                                                                                                                                                                                           | 2    |
| Resolution or submission failed | `junco investigate: <error>` (e.g. `junco investigate: not a GitHub issue reference: "..." (expected owner/repo#N or an issue URL)`, or `junco investigate: ticket already queued: <path>` when the same issue's ticket is still waiting in the inbox — see "One draft per issue" below) | 1    |
| Queued                          | `queued: <ticket-path>`, then ``queued — the worker will investigate and park a comment draft; run `junco investigate review` when it lands``                                                                                                                                            | 0    |

The command only resolves the target and submits the ticket. The actual investigation — the agent session, extraction, sanitization, and parking — runs later, whenever the daemon claims the ticket.

### `junco investigate review [<id>]` — list / preview drafts

The same review can also be done without leaving the dashboard: press `v` there to open the in-dashboard review view, which lists comment drafts alongside pending audit batches; `enter` previews a draft, `f`/`enter` posts it, `x` discards it.

```bash
junco investigate review              # list every pending draft
junco investigate review <id>         # preview one draft
```

With no id, prints one line per pending draft: id, `nwo#issue`, `(owned)`/`(external)`, the parked timestamp, and the first non-empty line of the draft (truncated at 60 characters) — or `no pending comment drafts` if the store is empty, followed by a hint line: `review one: junco investigate review <id> · edit: junco investigate edit <id> · post: junco investigate post <id>`.

With an id, prints the draft's `nwo#issue`, scope, and issue title, then **exactly what `junco investigate post` would post** — the draft text plus the disclosure footer when the draft carries one — followed by `post: junco investigate post <id>`.

### `junco investigate edit <id>` — revise a draft

```bash
junco investigate edit <id>
```

Opens the draft in `$VISUAL` (falling back to `$EDITOR`) as a temporary Markdown file, git-commit-message style. On save, the edited text is re-sanitized (same HTML-comment/control-char stripping and length cap as the original draft) and written back to the store — the footer is never part of this file, since it's composed at post/preview time, not stored in the draft text.

| Outcome                         | stdout                                                                                                                            | Exit |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---- |
| No id given                     | `Usage: junco investigate edit <id>`                                                                                              | 2    |
| Draft store read error          | `junco investigate edit: <error>`                                                                                                 | 1    |
| No such draft                   | `junco investigate edit: no pending draft '<id>'`                                                                                 | 2    |
| No `$EDITOR`/`$VISUAL` set      | `junco investigate edit: no $EDITOR (or $VISUAL) set — draft file: <path>`, then `set $EDITOR (or $VISUAL) to edit interactively` | 2    |
| Editor exited nonzero           | `junco investigate edit: editor exited nonzero — draft unchanged`                                                                 | 1    |
| Draft empty after re-sanitizing | `junco investigate edit: draft is empty after sanitize — unchanged`                                                               | 1    |
| Saved                           | `draft updated — junco investigate review <id> to preview`                                                                        | 0    |

With no editor configured, the command prints the pending draft's JSON file path instead of guessing. That file **is** the store: a hand-edit to its `draft` field is picked up verbatim by `junco investigate review`/`post` — and it **skips the re-sanitization** `junco investigate edit` applies on save (your own input is trusted here, so this is a footgun to know about, not a security hole). Prefer setting `$EDITOR` and using `junco investigate edit`, which sanitizes on save.

### `junco investigate post <id> [--no-footer]` — the human confirm step

```bash
junco investigate post <id>
junco investigate post <id> --no-footer
```

Composes the final comment body (draft text, plus the disclosure footer unless the draft has it off or `--no-footer` is passed), then posts it — live via `gh issue comment`, or queued to the durable outbox when GitHub is unreachable — and archives the draft to `posted/` on either outcome. This command **is** the confirm gate: one draft, one deliberate action, no separate `--yes` flag.

| Outcome                                   | stdout                                                           | Exit |
| ----------------------------------------- | ---------------------------------------------------------------- | ---- |
| No id given                               | `Usage: junco investigate post <id> [--no-footer]`               | 2    |
| Draft store read error                    | `junco investigate post: <error>`                                | 1    |
| No such draft                             | `junco investigate post: no pending draft '<id>'`                | 2    |
| Posted live, URL scraped                  | `posted: <url>`                                                  | 0    |
| Posted live, no URL scraped               | `posted`                                                         | 0    |
| GitHub unreachable                        | `offline — queued to the outbox; it will post on the next flush` | 0    |
| Permanent failure (auth, locked issue, …) | `junco investigate post: <error>`                                | 1    |

A failed post (locked issue, permission error, or any other non-network failure) leaves the draft pending — nothing archives, so you can fix the problem and retry the same `<id>`.

## The disclosure footer

Every posted comment carries a one-line disclosure by default:

> `_Analysis drafted with [junco](https://github.com/ironforgesoftware/junco) and human-reviewed before posting._`

The footer is a flag on the parked draft, not text baked into it — `junco investigate review <id>` shows it in the preview exactly as it would post, and `junco investigate post <id> --no-footer` omits it at post time. Because it's a flag rather than embedded text, editing the draft with `junco investigate edit` never has to string-match the footer out.

## Sanitization

The issue text an investigation run reads is untrusted input, and the resulting draft becomes a public comment posted under your account — so the extracted draft is sanitized before it's ever parked: HTML comments are stripped (closing off marker spoofing — a hostile issue steering the agent into emitting a fake `<!-- junco:finding:… -->`-shaped string that could poison `junco audit`'s dedup scan), along with control characters, and the result is capped at 60,000 characters (GitHub's practical comment ceiling, with headroom). An investigation that produces no fenced draft, or one that's empty after sanitizing, finalizes the ticket to `failed/` with a clear reason — nothing parks.

## Offline behavior

Posting goes through the same outbox as every other GitHub write junco makes. When `gh issue comment` fails for a network reason during `junco investigate post`, the comment is queued to the outbox (`<dataDir>/data/outbox/` — or `<dataDir>/outbox/` on a not-yet-migrated legacy tree; see [github-mode.md § Offline / flaky network](github-mode.md#offline--flaky-network)) instead of failing the command — `junco outbox` lists what's queued, `junco outbox flush` (or the next bridge sweep) drains it, and the dashboard header shows a `⇡N unpushed` chip while anything is queued. Either way — sent live or queued — the draft archives to `posted/`, since the outbox delivery is durable from that point on.

## One draft per issue

A draft's id has no timestamp (`analyze-<owner>-<repo>-<n>`), so there is exactly one pending draft per issue at a time:

- **Queuing while the same issue's ticket is still waiting in the inbox** fails loud — `junco investigate: ticket already queued: <path>` — the same "don't silently clobber" guard every ticket submission gets. This guard covers the inbox only: once the daemon claims the ticket into `processing/`, the inbox slot is free again.
- **Queuing while the same issue's ticket is already running** succeeds: both runs execute, and the **last one to park wins** — its draft overwrites the other's in the review store. That's the designed semantics, not a race to guard against: the store is keyed by ticket id precisely so that re-investigation converges on one draft per issue.
- **Re-investigating an issue whose previous run already parked (or failed)** queues and runs cleanly, and when it parks, the new draft **overwrites** the old one — `junco investigate review <id>` always reflects the most recent investigation to finish.
- **Posting twice on one issue** requires two full, deliberate cycles (investigate → review → post) — there's no way to post the same draft twice from one parked entry, since posting archives it.

## Etiquette

The comment posts under your own `gh` identity, on someone else's issue thread (or your own). The human gate — read the draft, edit it if it needs a human touch, then explicitly post — is the control; the default-on disclosure footer is the backstop so readers know a comment was agent-drafted and human-reviewed, not auto-posted. Read a draft before posting it the same way you'd read a comment before submitting it yourself: no promised timelines, no unreviewed prose calling out someone's issue, no posting on a repo you're not otherwise willing to engage with.

## Ticket flavor

`junco investigate` composes and submits the ticket itself — you don't hand-author it. Its frontmatter:

```yaml
---
id: analyze-<owner>-<repo>-<n>
repo: "<clonePath>"
investigate:
  issue: <n>
  title: "<issue title, JSON-escaped>"
---
```

Presence of the `investigate:` mapping selects this flavor (see the flavor table in [docs/tickets.md](./tickets.md)) — the daemon investigates the issue named here against the `repo:` clone and parks a comment draft, instead of running Q&A, PR flow, or an audit. Like an audit ticket, an investigation ticket carries `repo:` but **never opens a pull request** — the daemon checks for `investigate:` before it checks for `repo:`. `analyze:` is a permanently accepted legacy alias for the same mapping — when a ticket carries both, `investigate:` wins (see [docs/tickets.md](./tickets.md#key-frontmatter-fields)).

An investigation ticket deliberately carries **no `github:` provenance block** — the bridge's lifecycle-label/comment reporting keys off that block, and an investigation ticket must produce no un-gated outward write. The reporter no-ops on investigation tickets; the only outward write in the whole feature is the human-confirmed `junco investigate post`.

The issue body itself rides in the ticket **body**, framed as untrusted data, not instructions — the same idiom `junco import` uses for issue content it didn't write.

## Visibility

Both status surfaces report the pending-draft count whenever the store is non-empty, so a backlog of unreviewed drafts doesn't go unnoticed between investigations: `junco status` prints `analyze review: N pending (junco investigate review)`, and `junco doctor` reports `✓ investigate drafts — N pending (junco investigate review)` (informational — a backlog is normal workflow state, not a health problem).
