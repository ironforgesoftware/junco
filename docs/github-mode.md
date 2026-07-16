# GitHub-integrated mode

Dispatch and review work from GitHub issues — the plan → approve → PR loop, lifecycle labels, and offline behavior.

[← back to the README](../README.md)

Junco can use **GitHub Issues as a dispatch surface**: label an issue and the daemon drafts an execution plan, posts it for review, and — once approved — works it in a worktree, opens a PR, and reports back on the issue thread. Junco never executes a raw issue directly; it always plans first. The local inbox keeps working exactly as before — both surfaces feed the same queue, and with `enabled = false` (the default) Junco makes zero GitHub calls.

```json
{
  "github": {
    "enabled": true,
    "triggerLabel": "junco",
    "pollIntervalSeconds": 60,
    "requireApproval": true,
    "repos": [{ "nwo": "owner/repo", "path": "~/code/repo" }]
  }
}
```

`triggerLabel` is the approval marker (default `"junco"`); `pollIntervalSeconds` sets the bridge sweep cadence; `requireApproval` gates execution on a write+ collaborator applying `junco:approved`; optionally set `github.plannerModelId` to plan with a different (e.g. cheaper) model than the one that executes. Each `github.repos[]` entry needs `nwo` (the repo to watch) and `path` (its local clone — origin must point at `nwo`).

**The two-hop loop.** Every sweep, Junco lists open issues carrying the trigger label in each watched repo.

1. **Dispatch → plan.** An eligible issue (trigger label present, no lifecycle label yet) is verified — **who applied the label, and do they have write access?** — then turned into a _planning_ ticket: a read-only, Q&A-style session at the mapped clone that explores the repo and drafts a plan using the same authoring discipline as the `junco-dispatch` skill (single-sourced from `skills/junco-dispatch/TEMPLATE.md`; see `planPrompt.ts`). Set `github.plannerModelId` to plan with a cheaper/different model than the one that executes. The issue flips to `junco:planning`.
2. **Plan → review.** When planning finishes, Junco posts the plan as **one issue comment** — carrying a hidden `<!-- junco:plan -->` anchor so the bridge can recover it later — and flips the issue to `junco:plan-ready`. The comment is ordinary GitHub markdown: **you can edit it**, and whatever it says at approval time is what executes.
3. **Approve → execute.** With `github.requireApproval = true` (the default), a write+ collaborator applies `junco:approved` after reading the plan comment; Junco checks both that a write+ collaborator applied it and that the approval postdates the plan comment (so a stale approval from before a re-plan can't sneak an old plan through). With `github.requireApproval = false`, the plan executes automatically on the next sweep instead — no human gate. Either way, Junco reads the plan back out of the (possibly edited) comment, builds an ordinary execution ticket from it, swaps `junco:plan-ready`/`junco:approved` for `junco:queued`, and the normal pipeline runs from there (atomic claim, worktree, guards, verification, critic, retries) exactly as for a locally-submitted ticket.

When the execution ticket finalizes, Junco posts **one comment** — PR link plus a brief summary, or the failure reason — and flips to `junco:done`/`junco:failed`. The PR body includes `Closes owner/repo#N`, so merging auto-closes the issue.

**Questions skip planning.** Add the ask label (default `junco:ask`) alongside the trigger label and Junco routes straight to the read-only Q&A path (`junco:queued` directly — no plan, no review, no approval) — the session browses the mapped clone with read-only tools and posts its **answer as the comment**. No branch, no PR.

**Lifecycle labels** signal state silently (no notifications) and are visible in the issue list:

| Label              | Meaning                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `junco:planning`   | A planning session is drafting a plan from the raw issue                                                |
| `junco:plan-ready` | Plan posted as a comment — awaiting review (and approval, if `github.requireApproval`)                  |
| `junco:approved`   | Applied by a write+ collaborator after reading the plan; authorizes execution (removed once dispatched) |
| `junco:queued`     | An execution ticket (or Q&A ticket) is in the inbox, waiting for a worker slot                          |
| `junco:working`    | A session is on it right now                                                                            |
| `junco:done`       | Finished — see the closing comment (PR link / answer)                                                   |
| `junco:failed`     | Failed — see the closing comment for the reason (planning or execution)                                 |
| `junco:denied`     | Trigger label was applied by someone without write access                                               |

**Re-plan gestures** (all take effect on the next sweep, no restart needed):

- Remove `junco:plan-ready` (leave the trigger label on) → a fresh planning session runs. If more than one plan comment exists on the issue, the latest one wins.
- Remove `junco:failed` → the issue re-enters at the top: fresh planning, fresh review, fresh approval.
- Edit Junco's own plan comment before it's approved → your edit is what executes, not the model's original draft.

**Trust model.** Issue text is untrusted input until someone with write/maintain/admin permission applies the trigger label — and by labeling, they vouch for the body _as it stands_, so **read the issue before you label it**. From there, the plan hop adds its own guarantees: the planner emits the ticket **body only**, inside a fenced block — frontmatter (`repo:`/`workdir:`/`tools:`) is always built by the bridge itself, never by model output or issue text; a plan comment only counts as authoritative if it was posted by the bridge's own authenticated `gh` login (a forged marker comment from another contributor can't smuggle in a plan); and an approval only counts if it comes from a write+ collaborator **and** postdates the plan comment it's approving. Junco fails closed on any verification error, only ever executes against clone paths from _your config_ (issue content cannot steer it elsewhere), and cross-checks that each mapped clone's `origin` matches the configured repo so a typo can't ship commits to the wrong place. `github.requireApproval = false` removes the human approval gate entirely — reasonable for a private personal repo where you already trust everyone who can apply the trigger label, but keep the default `true` anywhere else. Note too that with `github.requireApproval = false`, anyone who can apply labels — including a triage-only collaborator, whose label edits are _not_ permission-verified on the plan hop — can re-apply `junco:plan-ready` to replay an existing plan comment straight into execution; one more reason auto mode belongs only on a private personal repo.

**Team workflow.** Planning is automatic now, so hand-drafting the task issue is optional rather than required: label a raw bug report and Junco drafts the plan itself, posts it for review, and you approve or edit before anything runs. If a report issue already has a task sub-issue with a concrete plan, label the sub-issue instead — Junco automatically appends the parent issue's title and body as background context for the planner, and closing the sub-issue rolls up into the parent's progress. Either way, nothing executes until a human has seen a concrete plan (or you've deliberately opted out via `github.requireApproval = false`).

**Authoring issues.** The loop above assumes a human (or another tool) writes the first issue. `junco assess <path|owner/repo|owner/repo#N>` lets Junco write it instead: it audits a repo — `npm audit` plus a read-only agent audit — and **parks** the findings for review rather than filing them immediately. `junco assess review` lists what's pending; `junco assess file <id> --all|--only <fingerprint,…>` is the confirm step that actually files them as GitHub issues. On a repo you own, filed issues carry `junco:finding` + `severity/<level>` labels (best-effort); on a repo you don't own they file label-free. The trigger label isn't applied by default; pass `--auto-plan` at audit time to add it to every issue filed from that batch (owned repos only — an external batch always forces it off), feeding them straight into the dispatch → plan hop above on the bridge's next sweep (the target repo still has to be watched, same as any other issue). Point it at `owner/repo#N` instead and the audit scopes to that issue and auto-provisions an unwatched repo — the one exception to "the target repo still has to be watched" just above. See the [vulnerability assessment guide](./assess.md).

**Commenting on issues.** `junco analyze <owner/repo#N|url>` points Junco at a single existing issue instead of the whole repo: it investigates read-only — root cause, evidence, repro, a suggested fix direction — and **parks** the result as a comment draft rather than posting it. `junco analyze review [<id>]` previews the draft (exactly what would post); `junco analyze edit <id>` opens it in `$EDITOR` for a rewrite; `junco analyze post <id>` is the confirm step that actually posts it as a comment, with a disclosure footer on by default (`--no-footer` to omit it). This works identically on owned and unowned repos, and is entirely separate from the trigger-label loop above — an analyze ticket carries no `github:` provenance block, so the bridge's lifecycle labels and finalize comment never touch it; the human-confirmed post is the only outward write. See the [analysis comments guide](./analyze.md).

**Operational notes.** `junco doctor` checks each repo mapping (clone exists, origin matches, repo reachable via `gh`) and that the planner template (`skills/junco-dispatch/TEMPLATE.md`) is readable — that check fails preflight rather than warns, since an unreadable template fails every planning ticket. `junco status` and `/health` report sweep counts. Polling cost is a small, fixed number of API calls per repo per sweep against a 5,000/hr authenticated limit — still negligible. Auth is ambient `gh auth login` by default (no new secrets); set `botAccount.enabled` to have the daemon act as a dedicated bot identity instead — see the [bot account guide](./bot-account.md). If GitHub is unreachable, sweeps skip and the local queue keeps running, and most lost label flips or comments are cosmetic (the queue files and the PR are the source of truth) — with one exception. On the **plan hop**, if the `junco:planning → junco:plan-ready` flip is lost _after_ the plan comment has already posted, the issue strands in `junco:planning` and won't advance to review on its own (the bridge won't re-plan an issue that still carries `junco:planning`). Recover by hand: apply `junco:plan-ready` yourself (the plan comment is already on the thread), or remove `junco:planning` to re-plan from scratch.

## External repos (fork-PR mode)

The two-hop label loop above assumes you can **push to the repo and write its labels** — i.e. a repo you own or collaborate on. For a repo you _don't_ control (an upstream project you want to contribute a fix to), Junco has a **fork-PR mode**: it works the issue in a managed clone, pushes the branch to **your fork**, and opens a **draft pull request** against upstream. It never touches the upstream issue's labels or comments — you have no write access there, and it doesn't assume any. (The one deliberate exception to "no comments" is `junco analyze`'s human-confirmed comment post — see the etiquette invariant below.)

**How to dispatch:**

- **CLI:** `junco dispatch owner/repo#N` (or a full issue URL). Junco detects that you can't push to `owner/repo`, forks it, clones the fork's upstream into a managed directory, builds a ticket, and queues it. The repo is added to your watchlist as an external entry so the dashboard shows it.
- **Dashboard:** press `w` to add the repo — when Junco sees you have no push access it switches to fork-PR mode automatically (leave the local-path field empty; the managed clone is Junco's to place). Then select an issue and press `d` to dispatch it. On an external repo the label keys (`D` ask, `a` approve, `R` re-plan/recycle) don't apply and say so — `d` is the only action, and it queues a fork-PR ticket directly (no planning hop, since there's no upstream label lifecycle to drive it).

**Etiquette invariant.** In fork-PR mode the **only** outward-facing writes Junco makes are: creating your fork, pushing the feature branch to that fork, and opening a draft PR upstream. It applies **no labels and posts no comments** on the upstream issue — an external repo is never added to the bridge's polling set, so nothing there is ever mutated on your behalf. The draft PR is the single artifact that reaches the upstream project, and it lands as a draft so a maintainer never sees work-in-progress as ready-to-merge. (`junco analyze` is the one deliberate exception to "no comments on repos you don't own" — and even there, nothing posts without the explicit, separate `junco analyze post` confirmation described above.)

**Trust note.** The upstream issue body is **untrusted input** — you did not write it, and no permission check vouches for it (unlike the owned-repo flow, where applying the trigger label is a write+ collaborator vouching for the body). Junco builds the ticket frontmatter entirely from machine data and quarantines the issue text as data-not-instructions in the ticket body, but the plan the agent produces is only as trustworthy as the issue that seeded it. **Review the draft PR's diff before you mark it ready for review** — that draft gate is the human checkpoint that replaces the plan-review hop you'd get on an owned repo.

**Iterating on an external PR.** Re-dispatching the same issue collides on the existing branch by design — the feature branch is already on your fork backing the open PR. To push review-feedback commits to that PR, submit a ticket with `amends_pr: <PR number>`, `repo: <the managed clone path>`, and `push_remote: fork`. Junco fetches the PR's head branch from your fork, adds commits onto it, and pushes back, so the upstream PR updates in place.

## Offline / flaky network

**When GitHub is unreachable** (network errors after retry backoff), Junco queues label operations, issue comments, and the PR push+create sequence as durable ops under `<dataDir>/outbox/` — one JSON file per operation. These ops are **stored durably**: if the daemon crashes, they survive the restart and are flushed automatically on the next bridge sweep once GitHub comes back online. Operations are **replayed in FIFO order** to preserve per-issue semantics, are **idempotent** (a crash mid-flush will not double-post comments or duplicate labels), and are **fault-tolerant**: a non-network error on a single op (e.g., you deleted a label) bumps its attempt count and dead-letters it after 3 attempts to `<dataDir>/outbox/dead/`. The ticket itself still **finalizes done/failed** locally (the worker never blocks on GitHub connectivity), so the queue keeps moving — the outbox is for durability, not gating.

**What gets queued:** lifecycle label flips (onStart, onRequeue, onFinal), final comments (PR link + summary | answer | failure reason), and the entire PR push+create sequence (including comment + labels for PR-finalize tickets). Fresh PR operations checkpoint state: if the push succeeds but PR creation fails, the replay skips the push and goes straight to create (no redundant pushes on retry).

**Manual push:** list what's queued with `junco outbox` (shows operation type, target issue/branch, age, attempt count); flush immediately with `junco outbox flush` instead of waiting for the next auto sweep. Both commands work even if the daemon is down.

**Dashboard visibility:**

- **Chip:** the dashboard header shows `⇡N unpushed` when there are queued ops (hidden at N=0). To flush from inside the dashboard, open the `:` command palette and run `outbox` with args `flush` — or run `junco outbox flush` from any shell.
- **Issue list:** when the issue list is served from cache (GitHub was offline during fetch), an `offline · HH:MM` badge in the issue pane's title row shows the cached-at timestamp, so you know the list is stale. The header's `↻ 12s` stamp shows how long ago the last refresh cycle completed — one view-scoped cycle every 30s covers what's on screen (main view: the selected repo's issues + its junco PRs; the `p` monitor: every watched repo's junco PRs), `r` runs it now, and a cycle served from cache shows the oldest cache age instead of claiming freshness.
- **PR offline:** an offline PR-flow ticket still finalizes with its earned terminal status (e.g. `completed`) — the work is done locally. The ticket file's Result section gains the line "PR queued for offline push — junco will open it automatically when GitHub is reachable.", and no issue comment posts at finalize time; when the outbox flushes, the comment that lands reads `Opened <pr-url>` plus the agent's summary. When the branch was built from a possibly-stale base (the base couldn't be fetched while offline), the PR body gains a warning: `⚠️ Built offline from a possibly stale base — rebase check recommended.`

**Dead-letter and recovery:** when an op has failed 3 times, it moves to `<dataDir>/outbox/dead/` to prevent infinite retry. `junco doctor` warns if dead-lettered ops exist; list them with `junco outbox` (shown as `dead: N`). To retry a dead-lettered op, edit it by hand, move it back to `<dataDir>/outbox/`, and run `junco outbox flush`.

**Trust model:** queued ops replay under your own `gh` auth — the same authentication as the live path. Approval verification happens live at sweep time (a plan-ready issue's approval label is checked before an execution ticket is created): queuing changes _when_ a label lands, not _how_ it is verified.
