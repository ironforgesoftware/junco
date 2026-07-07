# GitHub-Integrated Inbox Mode — Design

- **Date:** 2026-07-02 · **Revised:** 2026-07-06 (planner stage promoted to the default PR path)
- **Status:** Approved (revision approved 2026-07-06)
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

**Revision rationale (2026-07-06).** Real issues are prose reports, not plan-shaped
tickets — and plan quality is the single biggest lever on execution quality (the
junco-dispatch skill exists for exactly this reason). The v1 verbatim-copy path fed raw
prose straight into the PR flow. This revision promotes the previously-parked planner
stage to the default path: the daemon **self-authors the plan** from the raw issue using
the junco-dispatch authoring discipline, posts it on the issue for human review, and
executes only the reviewed plan.

## Decisions (settled during brainstorming + revision)

| Decision       | Choice                                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger model  | Label (default `junco`) applied by a user with write/maintain/admin; permission verified via API, fail-closed. (Assignment-as-trigger considered and deferred: labels keep the applied-by verification path uniform.)              |
| Repo mapping   | Explicit `[[github.repos]]` `nwo` → local clone `path` in config                                                                                                                                                                   |
| PR path        | **Two-hop: plan, then execute.** Raw issue → planning ticket (read-only, self-authors the plan) → plan posted as an issue comment → approval gate → execution ticket → PR                                                          |
| Plan authoring | The daemon reuses the junco-dispatch discipline: `skills/junco-dispatch/TEMPLATE.md` is the single-source template, loaded at runtime; a daemon-specific preamble adapts it (read the clone, emit body only)                       |
| Approval gate  | `require_approval = true` (default): a verified writer applies `junco:approved` **after** the plan comment exists; `false` ⇒ plan-ready auto-executes next sweep. The plan comment is editable before approval — edits take effect |
| Planner model  | Optional `[github] planner_model_id` — planning sessions may run a stronger model id on the same endpoint                                                                                                                          |
| Feedback       | Silent lifecycle labels + ONE plan comment (PR path) + ONE finalize comment                                                                                                                                                        |
| Q&A scope      | `junco:ask` routes directly to the read-only Q&A path (no planning — questions need no plan); answer posted as the comment                                                                                                         |
| Architecture   | Inbox bridge: both planning and execution tickets are ordinary inbox tickets riding the existing queue rails                                                                                                                       |
| Task layer     | Sub-issue parents fetched and appended as background context to the planner's input                                                                                                                                                |
| Mode switching | `[github] enabled` flag; local and GitHub dispatch coexist (both feed the same queue)                                                                                                                                              |

## Architecture

````
GitHub issue (trigger-labeled, raw prose — no ticket format expected)
  │  bridge sweep (github.poll_interval_seconds, default 60s)
  ├─ verify trigger-labeler permission ──fail→ junco:denied, stop
  ├─ verify mapped clone origin == nwo (once per repo per process)
  ├─ [junco:ask] → direct Q&A ticket → junco:queued  (no planning; unchanged)
  ├─ [sub-issue] fetch parent title/body (non-fatal)
  ├─ write inbox/gh-<owner>-<repo>-<n>-plan.md   (PLANNING ticket: kind "plan",
  │     workdir = clone, body = planner preamble + TEMPLATE.md + issue + parent)
  └─ apply junco:planning
  │  planning ticket rides the Q&A rails (read-only tools, cwd = clone,
  │  optional planner_model_id override); retries/guards/transcripts as usual
  └─ finalize → reporter (kind plan):
       ├─ plan extracted from ```junco-ticket fence → post PLAN COMMENT
       │    (<!-- junco:plan --> marker + fenced plan body) → junco:plan-ready
       └─ no usable plan / failure → failure comment → junco:failed
  │  human reviews the plan comment (may EDIT it — edits take effect)
  │  applies junco:approved            [skipped when require_approval = false]
  │  bridge sweep (approval scan, same single list call)
  ├─ verify approver permission (write+) AND approval postdates the plan comment
  ├─ fetch latest plan comment AUTHORED BY the bridge's own gh login
  ├─ extract plan body, strip any smuggled frontmatter
  ├─ write inbox/gh-<owner>-<repo>-<n>.md   (EXECUTION ticket: kind "pr",
  │     repo = mapped path, body = the reviewed plan)
  └─ swap labels: −plan-ready −approved +queued
  │  existing pipeline, byte-for-byte: claim → junco:working → PR flow in
  │  worktree — PR body gets "Closes <nwo>#<n>"
  └─ finalize → reporter.onFinal → ONE comment (PR link + summary | failure)
                                    → junco:done | junco:failed
  │  human merges PR → GitHub auto-closes the issue
````

Tickets are **snapshots**; the plan comment is the durable, human-editable copy of the
plan (GitHub is the store — bridge state stays process-local). Labels mirror local
state; local `done/`/`failed/` plus the PR are the source of truth.

### Label state machine

Lifecycle labels all derive from the trigger label (`<trigger>:<state>`); the bridge
creates them idempotently, including `approved` so humans can pick it from the label UI.

| Label                         | Applied by     | Meaning                                                          |
| ----------------------------- | -------------- | ---------------------------------------------------------------- |
| `junco`                       | human (write+) | Dispatch this issue                                              |
| `junco:planning`              | bridge         | Planning ticket queued or running                                |
| `junco:plan-ready`            | bridge         | Plan comment posted; awaiting approval (or next sweep when auto) |
| `junco:approved`              | human (write+) | Execute the posted plan (must postdate the plan comment)         |
| `junco:queued`                | bridge         | Execution (or ask) ticket in the inbox                           |
| `junco:working`               | bridge         | Execution session in flight                                      |
| `junco:done` / `junco:failed` | bridge         | Terminal; see the finalize comment                               |
| `junco:denied`                | bridge         | Trigger label applied without write permission                   |

Eligibility for the NEW-issue path = trigger label present AND none of
{queued, working, done, failed, denied, planning, plan-ready}. `approved` alone does
**not** block eligibility (a pre-applied approval is neutralized by the timestamp rule,
not by wedging the issue).

**Re-dispatch gestures** (all one label removal): remove `failed` → full re-cycle
(fresh plan); remove `plan-ready` → re-plan (a newer plan comment supersedes — latest
own-authored marker comment wins); edit the plan comment before approving → the edited
plan is what executes.

### `src/planPrompt.ts` — the planner prompt asset

- `loadDispatchTemplate()` reads `skills/junco-dispatch/TEMPLATE.md` from the package
  root (resolved one level up from the module dir — `dist/` and `src/` are both direct
  children, so the same resolution works built and under vitest). `EXAMPLE.md` is
  appended when readable. Missing template → throw (planning tickets fail loud;
  `doctor` checks readability when the bridge is enabled). **Single source:** the skill
  and the daemon share the template file verbatim; only the preamble is daemon-specific.
- `buildPlannerPrompt({title, body, nwo, parent})` assembles: a preamble (you are
  planning, not implementing; explore the repo read-only; verify file paths and
  signatures before citing them; populate every template section or write `_None._`;
  **emit ONLY the ticket body inside a ```junco-ticket fence — no frontmatter, the
  worker builds it**; if the issue already contains a complete plan, adopt it with
  minimal changes) + the template + the example + the issue title/body + the parent
  context section.

### Planning ticket (kind `plan`)

```markdown
---
id: gh-acme-api-42-plan
workdir: /Users/me/code/api
github:
  nwo: acme/api
  issue: 42
  kind: plan
---

<planner preamble + TEMPLATE.md + EXAMPLE.md + issue title/body + parent context>
```

Routes through the existing Q&A path untouched: read-only default toolset, session cwd
at the clone, default timeout, transient-failure requeue (label stays `junco:planning`
across requeues — accurate). When `[github] planner_model_id` is set, `executeClaimed`
swaps `cfg.model.id` for plan-kind tickets only (same endpoint/key).

### Plan comment format

````text
<!-- junco:plan -->
**Proposed plan** for #42 — review it, then apply `junco:approved` to execute.
You can edit this comment first; the edited plan is what runs.

```junco-ticket
# <plan H1>
## Why
...full plan body, no frontmatter...
```
````

- `PLAN_COMMENT_MARKER` (`<!-- junco:plan -->`) + the ```junco-ticket fence make the
  plan machine-recoverable; the fence renders as a readable code block.
- Size guard: a fenced plan that would exceed the comment limit fails planning
  ("plan too large") rather than truncating the machine copy.
- When `require_approval = false` the comment says the plan executes on the next sweep.

### Execution ticket (kind `pr`) — built at approval time

```markdown
---
id: gh-acme-api-42
repo: /Users/me/code/api
github:
  nwo: acme/api
  issue: 42
  kind: pr
---

<plan body extracted from the comment, frontmatter-stripped>
```

- `pr_title` is omitted — `derivePrTitle` picks the plan's H1.
- Frontmatter is **machine-built only**: any frontmatter block inside the extracted plan
  is stripped, so neither the model's output nor issue text can ever set `repo:`,
  `workdir:`, `tools:`, or timeouts.

### `src/githubInbox.ts` — sweep (revised)

One `gh issue list --label <trigger>` call per repo (unchanged cost); issues are then
classified locally by their label set:

1. **New** (no lifecycle label): verify trigger-labeler (existing fail-closed gate) →
   ask label present ⇒ direct ask ticket + `queued`; else planning ticket + `planning`.
2. **Plan-ready**: fetch the latest plan comment **authored by the bridge's own gh
   login** (`gh api user` once per process, cached in `BridgeState`); when
   `require_approval`, additionally verify the most recent `junco:approved` labeled
   event — actor has write+, and the event **postdates the plan comment** (stale/
   pre-applied approvals are ignored and logged). Extract the plan (extraction failure →
   log error, skip — a human can fix the comment), build the execution ticket, submit
   (duplicate-guard tolerant), then one label edit: −plan-ready [−approved] +queued.
3. **Everything else** (planning/queued/working/done/failed/denied): skip.

Submit-before-label ordering is preserved on both hops, so every crash window self-heals
through the duplicate guard. All per-issue and per-repo failures stay contained exactly
as in v1.

### `src/githubReport.ts` — reporter (revised)

Kind-aware; the ticket's `github.kind` selects behavior:

- **`pr` / `ask`:** unchanged — onStart `queued→working`, onRequeue back, onFinal posts
  the single finalize comment then flips `done`/`failed`.
- **`plan`:** onStart/onRequeue are label no-ops (`planning` stays accurate). onFinal:
  terminal-done AND `extractPlanBody(finalText)` succeeds → post the plan comment, flip
  `planning→plan-ready`; otherwise → failure comment ("planner produced no usable plan"
  or the failure reason), flip `planning→failed`.

All reporter calls remain best-effort and confined to `executeClaimed`.

### Config

```toml
[github]
enabled = false                # default: bridge fully off (zero gh calls)
trigger_label = "junco"
ask_label = "junco:ask"        # default: "<trigger_label>:ask"
poll_interval_seconds = 60
require_approval = true        # false ⇒ plan-ready auto-executes next sweep
# planner_model_id = "prov/bigger-model"   # optional: planning-only model id

[[github.repos]]
nwo  = "acme/api"
path = "~/code/api"
```

## Security model (revised)

**The trigger label opens planning; the approval label authorizes execution.** Stacked
boundaries:

1. **Trigger permission gate** — labeler identity from issue events, permission from the
   collaborators API; fail-closed; `denied` stops re-checks.
2. **Plan review gate** — with `require_approval` (default), execution needs
   `junco:approved` from a verified writer, applied **after** the plan comment exists.
   The gate's semantic is "a human reviewed THIS plan"; timestamp ordering enforces it.
3. **Machine-owned frontmatter** — planner emits body only; extraction strips smuggled
   frontmatter; `repo:`/`workdir:` come exclusively from operator config; origin
   cross-check unchanged.
4. **Forged-plan defense** — only plan comments authored by the bridge's own gh login
   are recoverable; a contributor's fake `<!-- junco:plan -->` comment is ignored.
   (Maintainers amend plans by editing junco's comment, not posting their own.)
5. **Planning is read-only** — the planner session runs the Q&A toolset against the
   clone; asks stay read-only as before.

Residual risks, documented: with `require_approval = false`, labeling a raw issue
delegates plan authorship AND execution to the model — recommended only for private,
personal repos. Plan/answer comments post publicly (same exposure class as PR diffs).

## Error handling (additions)

| Failure                                             | Behavior                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| Planner emits no ```junco-ticket fence / empty plan | Failure comment + `junco:failed`; remove label to re-plan           |
| Plan too large for a comment                        | Same as above ("plan too large")                                    |
| Plan comment fetch/extract fails at approval        | Log, skip issue this sweep; retry next (human can fix the comment)  |
| Approval by non-writer / predates plan comment      | Ignored + logged; label stays until re-applied post-plan            |
| TEMPLATE.md unreadable                              | Planning tickets fail loud; `doctor` reports it when bridge enabled |
| Planning transient failure                          | Existing requeue/backoff; `junco:planning` persists                 |
| Crash between exec-submit and label swap            | Duplicate guard; labels re-swapped next sweep                       |

## Cost (revised)

Steady-state poll unchanged (one list call/repo/sweep). Per PR issue: **one extra model
session** (planning — the point of the feature) + ~3 API calls at each transition
(events/permission at trigger; comments/events at approval; label edits). Ask issues
unchanged.

## Testing (additions)

- `Config` gains `requireApproval`/`plannerModelId` ⇒ fixture sweep across every
  `makeConfig`/`cfg()` helper (known gotcha, explicit plan task).
- Pure helpers: `lifecycleLabels` (8 labels), `isEligible` (new exclusions; `approved`
  non-blocking), `extractPlanBody` (fence, frontmatter strip, absent → null),
  `buildPlanComment` (marker, wording per mode, size guard), planner prompt assembly
  (template single-sourcing, fence instruction).
- Sweep: new-issue path emits planning tickets; ask path unchanged; approval scan
  (happy, unapproved, stale approval, non-writer approval, forged-author comment,
  auto mode, fetch-failure containment); label bookkeeping.
- Reporter: plan-kind onFinal both branches; no-op onStart/onRequeue.
- `executeClaimed`: planner model id swap observed via the session-factory seam.

## Out of scope (v1.1) — each keeps a seam

Webhooks/real-time dispatch; assignment-as-trigger; auto-cloning unmapped repos;
cancel-on-unlabel; re-execute-same-plan gesture (re-dispatch after failure re-plans);
planner-suggested timeouts; full `[github.planner_model]` endpoint override (id-only in
this revision); responding to PR review comments; priority-from-labels; search-API O(1)
sweep; non-GitHub forges.
