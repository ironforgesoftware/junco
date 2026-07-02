# GitHub-Integrated Inbox Mode — Design

- **Date:** 2026-07-02
- **Status:** Approved
- **Approach:** A — Inbox bridge (GitHub is a dispatch surface, not a replacement queue)

## Motivation

Junco's inbox today requires filesystem access to the daemon host. Bridging GitHub Issues
into the queue lets anyone with repo permission dispatch work from the GitHub web UI,
mobile app, or API — and the issue thread becomes a free audit trail and notification
channel ("issue in, PR out", the dominant coding-agent interaction pattern). Junco's
differentiator over Copilot coding agent / Jules / Codex cloud and over stateless
Actions-based runners (Claude Code GHA, OpenHands resolver): a persistent self-hosted
daemon against the operator's own inference endpoint, with durable queue semantics
(retries, orphan recovery, per-repo scheduling, salvage) that GitHub merely feeds.

## Decisions (settled during brainstorming)

| Decision       | Choice                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Trigger model  | Label (default `junco`) applied by a user with write/maintain/admin; permission verified via API, fail-closed              |
| Repo mapping   | Explicit `[[github.repos]]` `nwo` → local clone `path` in config                                                           |
| Feedback       | Silent lifecycle labels + exactly ONE comment at finalize                                                                  |
| Q&A scope      | Both paths in v1 — `junco:ask` label routes to the read-only Q&A path, answer posted as the comment                        |
| Architecture   | Inbox bridge: issues are copied into the existing `inbox/` as ordinary tickets                                             |
| Task layer     | Docs teach report→task-sub-issue→label workflow; bridge appends parent-issue context when the labeled issue is a sub-issue |
| Mode switching | `[github] enabled` flag; local and GitHub dispatch coexist (both feed the same queue)                                      |

## Architecture

Two new modules, two seams, zero changes to queue semantics:

```
GitHub issue (trigger-labeled)
  │  bridge sweep (github.poll_interval_seconds, default 60s)
  ├─ verify labeler permission ──fail→ junco:denied, stop
  ├─ verify mapped clone origin == nwo (once per repo per process)
  ├─ [sub-issue] fetch parent title/body → "## Context: parent issue" section (non-fatal)
  ├─ write inbox/gh-<owner>-<repo>-<n>.md   (atomic submitTicket)
  └─ apply junco:queued                      (submit-before-label: crash self-heals)
  │  existing pipeline, byte-for-byte: atomic claim → processing/
  ├─ reporter.onStart  → junco:queued → junco:working
  │  PR flow in worktree (14 phases, untouched) — PR body gets "Closes <nwo>#<n>"
  ├─ transient failure → existing requeue/backoff → reporter.onRequeue → junco:queued
  └─ finalize → done/ | failed/
       └─ reporter.onFinal → ONE comment (PR link + summary | answer | failure reason)
                             then junco:done | junco:failed
  │  human merges PR → GitHub auto-closes the issue
```

The ticket is a **snapshot**: issue edits after dispatch do not propagate. Labels on
GitHub mirror local state; local `done/`/`failed/` plus the PR are the source of truth.

### `src/githubInbox.ts` — the bridge (dispatch side)

`pollGithubInbox(cfg, deps): Promise<number>` — one sweep, returns tickets bridged.

Per configured repo:

1. `gh issue list --repo <nwo> --label <trigger> --state open --limit 100
--json number,title,body,labels,author` — one API call.
2. **Eligibility:** has trigger label AND no lifecycle label
   (`<trigger>:queued|working|done|failed|denied`). Re-dispatch = remove the lifecycle
   label, leave the trigger label on.
3. **Permission gate:** find the most recent `labeled` event for the trigger label via
   `gh api repos/<nwo>/issues/<n>/events`; check that actor via
   `gh api repos/<nwo>/collaborators/<login>/permission` — accept `admin`/`write`
   (the legacy field maps maintain→write). API error → skip this sweep (fail-closed,
   log warn). Actor lacks permission → apply `<trigger>:denied` (stops re-checking;
   operator removes the label to retry) and log.
4. **Origin cross-check** (once per repo per process, cached): the mapped path must be a
   git repo whose `origin` resolves to the configured `nwo`; mismatch → log error, skip
   the repo entirely this process.
5. **Parent context:** if the issue is a sub-issue, fetch the parent's title/body and
   append a `## Context: parent issue` section (clearly marked as background; the
   labeled body remains the instruction). Fetch failure is non-fatal (log, proceed).
6. **Convert** (see Ticket conversion) and `submitTicket()` atomically into `inbox/`.
   A duplicate-id throw (crash-window replay, or label manually removed while queued)
   is caught: log, proceed to labeling.
7. Apply `<trigger>:queued`.

Lifecycle labels are created idempotently per repo (cached per process) before first use.
Sweep-level failures (GitHub down, rate limit) log a warning and skip the cycle; the
queue and in-flight work are unaffected. Individual `gh` calls reuse the existing
network-retry wrapper.

**Bridge state is process-local only** (labels-ensured set, origin-verified cache);
everything durable lives in the queue files and on GitHub labels.

### Ticket conversion

```markdown
---
id: gh-acme-api-42
repo: /Users/me/code/api # PR ticket: mapped path.  Ask ticket: omitted
workdir: /Users/me/code/api # Ask ticket only: session cwd (read-only tools)
pr_title: <issue title> # PR ticket only
github:
  nwo: acme/api
  issue: 42
  kind: pr # or "ask"
---

# <issue title>

<issue body>

## Context: parent issue # only when the labeled issue is a sub-issue

<parent title + body>
```

- id: `gh-<owner>-<repo>-<number>`, slugified.
- `junco:ask` label present → `kind: ask`, no `repo:`, `workdir:` set → routes to the
  existing read-only Q&A path with cwd at the clone.
- `github:` and `workdir:` are **additive** ticket-schema fields. `github` is
  worker-managed provenance (like `retry_count`); `workdir` is generally useful
  (local dispatchers may set it for repo-scoped Q&A).

### `src/githubReport.ts` — the reporter (feedback side)

```ts
interface TicketReporter {
  onStart(ticket: Ticket): Promise<void>; // queued → working
  onRequeue(ticket: Ticket): Promise<void>; // working → queued
  onFinal(ticket: Ticket, outcome: TicketOutcome): Promise<void>;
}
// TicketOutcome: { kind: "pr" | "qa"; status: string; prUrl?: string;
//                  summary?: string; answer?: string; failureReason?: string }
```

- Threaded through `executeClaimed` as an injectable dep (`RunDeps.reporter`), default
  no-op. The daemon wires the GitHub implementation only when `github.enabled`. The
  GitHub reporter ignores tickets without a `github:` block, so local tickets are
  untouched even in GitHub mode. **All reporter calls are made from `executeClaimed`
  only** (single choke point; `prFlow` stays reporter-free).
- `onFinal` ordering: post the comment first (the valuable artifact), then flip the
  label. Everything is best-effort with network retry; persistent failure logs loudly
  and never fails the ticket. Worst case is a stale label — cosmetic, documented.
- Comment content:
  - PR success: PR URL + title + brief summary (first paragraph of the PR body).
    `timeout_partial` / guard-kill salvage reports as `junco:done` with an explicit
    "partial work salvaged into a draft PR" note.
  - Ask: the agent's answer, truncated at ~60,000 chars with a truncation note
    (GitHub hard limit 65,536).
  - Failure: `junco:failed` + failure reason + pointer to the transcript on the
    worker host.

### Pipeline changes (all additive)

- **`runPrFlow` return** grows from `dst: string` to
  `{ dst, status, prUrl, summary, requeued }` — internal signature; callers updated.
  `executeClaimed` maps outcomes → reporter calls (requeued → `onRequeue`, else
  `onFinal`); same for the Q&A path.
- **PR body:** when the ticket has `github:` provenance, the flow appends a
  deterministic `Closes <nwo>#<n>` line at PR-open time (not delegated to the prompt).
- **Q&A cwd:** `executeClaimed` uses `ticket.workdir ?? paths.processing` as the session
  cwd. `workdir` must exist and be a directory; when `allowed_repo_roots` is configured
  it must satisfy it (defense-in-depth — tools can read absolute paths regardless, same
  exposure class as the PR flow).
- **`parseTicket`:** exposes `github: {nwo, issue, kind} | null` and
  `workdir: string | null`, parsed defensively (malformed → null, never throws).

### Daemon wiring

A throttled `maybeBridgeSweep()` closure (last-sweep timestamp, interval from config)
runs at the top of each loop iteration — both the serial loop and `runScheduler`.
Injectable via `MainLoopDeps` for tests. No new async machinery. Serial-mode caveat
(documented): a long-running task delays the next sweep; issues wait durably on GitHub.
`enabled=false` (default) ⇒ zero `gh` calls, local behavior byte-for-byte unchanged.

### Config

```toml
[github]
enabled = false                # default: bridge fully off
trigger_label = "junco"
ask_label = "junco:ask"        # default: "<trigger_label>:ask"
poll_interval_seconds = 60

[[github.repos]]
nwo  = "acme/api"
path = "~/code/api"
```

- Nested `github` object on `Config`, zod-validated: `nwo` must match
  `owner/repo`; `path` non-empty (expanded via `expandHome`). Lifecycle label names are
  derived from `trigger_label` (`<trigger>:queued` etc.).
- `enabled=true` with empty `repos` is valid; `doctor` warns.
- The shipped config template includes a commented-out `[github]` example
  (stack-agnostic wording).

### Observability

- `doctor`: per-repo checks — nwo reachable via `gh`, path exists and is a clone,
  origin matches nwo; warns on enabled-but-empty repos.
- `metrics`/`/health`/`status`: bridge section — last sweep time, sweep errors,
  tickets bridged.

## Security model

**The label is the approval.** An issue body is untrusted text until someone with
write/maintain/admin applies the trigger label; the labeler vouches for the content as
it stands (docs: "review before you label"). Stacked boundaries:

1. **Permission gate** — labeler identity from the issue-events API, permission from the
   collaborators API; presence of the label alone is never trusted; fail-closed.
2. **Explicit repo mapping** — `repo:`/`workdir:` come only from config, never from
   issue content; hostile issues cannot point Junco at arbitrary paths. Mapped paths
   still pass the existing `allowed_repo_roots` enforcement downstream.
3. **Origin cross-check** — config typos cannot ship commits to the wrong repository.
4. **Ask tickets stay read-only** — the Q&A default toolset is unchanged; the bridge
   never sets per-ticket `tools:`.

Residual risks, documented plainly: labeling without reading delegates commit rights to
the issue author; ask-answers post publicly (same exposure class as PR diffs). No new
secrets — auth is whatever `gh auth` already holds.

## Error handling

Principles: the queue never depends on GitHub being up; reporting is best-effort; every
crash window self-heals.

| Failure                                 | Behavior                                                          |
| --------------------------------------- | ----------------------------------------------------------------- |
| GitHub down / rate-limited during sweep | Log warn, skip cycle; queue unaffected                            |
| Crash between submit and queued-label   | Next sweep re-submits → duplicate guard → catch → re-apply label  |
| Crash mid-execution                     | Existing orphan recovery → requeue → `onRequeue` flips label back |
| Reporter comment/label failure          | Retry network errors, then log loudly; never fails the ticket     |
| Issue closed/unlabeled after dispatch   | v1 does not cancel; snapshot runs and reports (documented)        |
| Parent-context fetch failure            | Non-fatal; ticket proceeds without the section                    |
| Empty issue body                        | Title-only ticket; existing plan-lint/critic gates apply          |

## Cost

GitHub API is free; limits only. Steady state: 1 list call/repo/sweep = 60 req/hr/repo
at defaults (5,000/hr limit). Permission checks (~2 calls) only for newly labeled
issues; reporter ~4 calls per ticket. `junco:denied` prevents per-sweep re-checks.
Documented escape hatch (not built): single search-API sweep across repos = O(1) calls.

## Testing

All against existing seams — no network, no real model:

- **Unit** (deps-seam fakes): issue→ticket conversion (golden), eligibility filtering
  (label combinations), permission-gate fail-closed paths, origin cross-check,
  submit/label ordering idempotency, reporter status→label/comment mapping, comment
  truncation, `workdir` validation, `parseTicket` new fields.
- **Integration:** bridge against the fake-`gh` shell fixture emitting canned JSON;
  daemon tests for sweep throttling and for `enabled=false` ⇒ zero `gh` invocations.
- **Config:** zod validation cases; `Config` gains a `github` object ⇒ update every
  `makeConfig`/`cfg()` fixture helper (known gotcha, explicit plan task).
- **prFlow:** return-shape change covered by updated existing tests.

## Out of scope (v1) — each gets a seam, not an implementation

Webhooks/real-time dispatch; auto-cloning unmapped repos; cancel-on-unlabel;
issue-edit propagation; responding to PR review comments; priority-from-labels;
search-API O(1) sweep; planner stage (`junco:plan` → proposed plan posted for human
approval) — natural v2; non-GitHub forges (bridge isolated in
`githubInbox.ts`/`githubReport.ts` so a GitLab twin is additive).
