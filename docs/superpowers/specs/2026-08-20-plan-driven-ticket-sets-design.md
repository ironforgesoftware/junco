# Plan-driven ticket sets — design

Status: approved design, pending implementation plan
Date: 2026-08-20

## Context

Junco's unit of work today is one ticket = one independent run. The GitHub bridge
already has a planning control plane for a single ticket: a planner session emits a
plan, the bridge posts it as an editable issue comment, a verified write+ approval
transfers trust, and `buildExecutionTicket` compiles the approved comment into one
execution ticket. This design extends that machinery to **sets**: a plan that
decomposes into multiple tickets with dependency edges, compiled deterministically
by the bridge, executed in dependency order, with per-task acceptance criteria
feeding the existing critic and verification phases.

Origin: comparison against an internal delivery-workflow design (Linear intake
→ PM planning → human approval → isolated executor → draft PR). Its genuine
delta over junco is multi-task decomposition with a dependency graph and
durable planning documents; everything else junco already has. This spec grows
junco in that direction without giving up its invariants.

## Invariants preserved (verified against the current code)

1. **Fail-closed frontmatter.** Ticket frontmatter is built by the bridge, never
   taken from model output or issue text (`buildExecutionTicket`,
   `src/githubInbox.ts:587`; smuggled-frontmatter stripping at `:178`). Compile
   errors stop dispatch.
2. **Temporal approval verification.** Approval must come from a write+
   collaborator and must postdate both `created_at` and `updated_at` of the plan
   comment (`src/githubInbox.ts:722-739`), failing closed on unparseable
   timestamps. Note: this already invalidates edit-after-approval — the
   content hash introduced below is compile _provenance_, not an approval gate.
3. **The plan is the editable artifact of record.** The (possibly hand-edited)
   comment is read back at approval time and is what compiles.
4. **Filesystem queue semantics.** Atomic-rename claim, `inbox/processing/done/failed`
   directories, durable outbox replay, requeue with backoff.
5. **Harness-agnosticism on the dispatch side.** Anything that writes a
   conforming document can feed junco.

## Decisions (settled during design review)

- **Dependency satisfaction = ticket done AND PR merged.** For a parent that
  opened a PR, the edge is satisfied only once that PR merges — children branch
  off an updated base and see the parent's code; human merges pace the set. A
  parent with no PR (Q&A ticket, `completed_no_changes`) satisfies at ticket-done.
- **Per-task PRs; no stacked branches.** Current PR behavior is unchanged. An
  integration-branch/stacked strategy is explicitly a later phase.
- **No new concurrency machinery.** Same-repo serialization plus merge pacing
  already serialize a single-repo set; cross-repo sets are out of scope.
- **No `blocked/` directory.** Dependency eligibility is a claim-time predicate
  beside the existing `not_before` filter, plus an explicit failure cascade.
- **Mode boundaries drawn for offline from day one.** Layer 1 (queue semantics)
  is mode-agnostic by construction; merge detection is a standalone sweep, not
  bridge functionality; the plan compiler is a pure module with the bridge as its
  first door and a CLI door as a fast-follow.

## Layer 1 — dependency-aware queue

### Schema additions (`src/ticketSchema.ts`, additive)

```yaml
depends_on:
  [<ticket-id>, ...] # dispatcher-settable; claim is gated until all
  # entries are satisfied (see semantics below)
plan: # optional set membership / provenance
  id: <plan-id> # set identifier (bridge: the execution-id base)
  task: <task-id> # which plan task produced this ticket
  hash:
    <hex> # worker-managed: content hash of the approved
    # plan this ticket was compiled from
deps_satisfied:
  [<ticket-id>, ...] # worker-managed: edges confirmed satisfied
  # by the dependency sweep; do not set by hand
```

`depends_on` is honored whenever present — it is part of the public contract and
is not gated behind the `planSets` config flag (silently ignoring an edge would
execute out of order). The flag gates only plan _compilation_ (Layer 2).

### Claim predicate

A ticket with `depends_on` is eligible only when `depends_on ⊆ deps_satisfied`.
The check is a pure frontmatter comparison — no filesystem walking, no network —
implemented as a filter alongside the `not_before` filter in `claimNextTask`
(`src/runOnce.ts:154-158`). All satisfaction analysis happens in the dependency
sweep (below), which runs in the daemon loop ahead of the claim pass, so a dep
satisfied on a tick is claimable on that same tick.

### Ticket-state resolver

A shared helper `ticketState(id) → done | processing | inbox | failed | absent`
generalizing the glob logic of `ticketInFlight` (`src/githubInbox.ts:568-582`,
`<id>.md` or `*__<id>.md`) across all four queue directories, keyed on
frontmatter `id` (filenames can gain `-r{n}` collision suffixes via
`moveBackToInbox`). Precedence when one id has files in several directories
(possible after supersede recompiles): **done > processing > inbox > failed** —
satisfaction is monotone; once a task has a done ticket it stays satisfied.

### Dependency sweep

Runs in the daemon poll loop before the claim pass, independent of
`github.enabled`, throttled by `planSets.mergePollSeconds` (default 60). It is a
no-op when no inbox ticket carries an unsatisfied `depends_on`. For each
unsatisfied edge `d` of each waiting ticket:

- `ticketState(d)` = `absent | inbox | processing` → wait (dangling edges wait,
  they do not error — sets may arrive through the inbox door out of order).
- `failed` → **cascade** (below).
- `done` → read the parent ticket's appended result block:
  - no PR recorded → stamp `d` into `deps_satisfied` (textual frontmatter
    upsert, the `upsertFrontmatterKey` pattern from `src/requeue.ts:37-46`).
  - PR recorded → query PR state via `cfg.ghBin`
    (`gh pr view --json state,mergedAt` on the PR reference recorded in the
    parent's result block — no bridge repo-mapping involved, so this works for
    locally-dispatched sets too):
    - merged → stamp `deps_satisfied`.
    - open → wait.
    - closed without merge → **cascade**.
    - `gh` error (offline, auth, rate limit) → warn and wait. Cascade fires only
      on an affirmative negative signal, never on inability to check.

Single-process safety: the daemon holds the single-instance lock and the sweep
runs serially before the claim loop, so upserting inbox frontmatter cannot race
a claim.

### Failure cascade

Without it, dependents of a dead parent starve silently in `inbox/`. Triggers:
(a) a ticket finalizes into `failed/`, or (b) the sweep observes a dependency's
PR closed unmerged. Effect: every transitive dependent still in `inbox/` is
finalized into `failed/` with a result block recording
`dependency_failed: <parent-id>` (the immediate parent). Dependents can never be
in `processing/` when this fires — they could only have been claimed after the
parent was done and merged, and a done parent cannot subsequently fail.

Recovery is keyed on that marker: `junco retry <id>` additionally resurrects
tickets in `failed/` whose `dependency_failed` names `<id>`, transitively.
Retrying a cascade-failed child directly also works: it returns to `inbox/`, and
the sweep re-evaluates its edges fresh (covering "PR was closed, then reopened
and merged"). `junco retry` stays a keyed, legible, single-command operation.

### Visibility

`junco list` annotates waiting tickets with their unsatisfied edges
(`waiting on: <ids>`); `status` counts them and surfaces edges resolving to
`absent` (likely typos or a half-submitted set) with a staleness warning.
`junco submit` warns — does not refuse — when a submitted ticket's `depends_on`
references an id not present anywhere in the queue.

## Layer 2 — the plan as a compilable artifact

### Plan document format

The planner (or a human) may now emit a `junco-plan` fence instead of the
single-ticket `junco-ticket` fence. The existing fence remains fully supported —
the bridge branches on which fence the approved comment contains, so plan
comments authored before an upgrade still compile exactly as today.

````markdown
(prose overview / intent — human-facing, not parsed)

```junco-plan
version: 1
shared_context: |
  Architecture decisions and constraints that apply to every task.
tasks:
  - id: schema            # [a-z0-9][a-z0-9-]{0,31}, unique within the plan
    title: Add the plan/depends_on frontmatter keys
    depends_on: []        # task ids within this plan
    description: |
      What to build and why, self-contained.
    acceptance:
      - Testable assertion 1
      - Testable assertion 2
    prohibitions:
      - Do not touch X
    verification: |
      npx vitest run tests/ticket.test.ts
  - id: resolver
    depends_on: [schema]
    ...
```
````

Fenced YAML rather than markdown conventions, deliberately: with fail-closed
compilation plus an error comment, a parse _error_ is cheap (edit, re-approve),
while a silent mis-parse of loose markdown structure is expensive. Choose the
format with the sharpest validity boundary. Prose stays outside the fence.

### The compiler (pure module)

`compilePlan(plan: string, ctx) → { tickets } | { errors }` — a pure function
with no I/O, no `gh`, no filesystem, per junco's deps-seam style. Callers ("doors")
wrap it with their own trust machinery. Validation, all fail-closed (nothing
dispatches; errors are reported whole, not first-only):

- YAML parse failure, unknown `version`, missing/duplicate/malformed task ids
- `depends_on` references to unknown task ids; dependency cycles
- more than `planSets.maxTasks` tasks (default 10)
- empty task description or acceptance list
- smuggled frontmatter inside any task text (existing `SMUGGLED_FRONTMATTER_RE`
  applied per task)

Task blocks cannot set `repo`, `base_branch`, `tools`, `network`, or any other
frontmatter — those come from the door (bridge config / CLI flags). All child
tickets of one plan target one repo; cross-repo sets are out of scope.

Child ticket ids extend the existing deterministic family
(`githubTicketId`, `src/githubInbox.ts:97-103`): `<execution-base>-<task-id>`.
Stable ids make compilation idempotent — a crash mid-fan-out self-heals on the
next sweep by resubmitting only what is missing. The fan-out's existence check
uses the `ticketState` resolver (skip when the id is anywhere in the queue,
`done/` and `failed/` included), not the inbox/processing-only `ticketInFlight`
guard — a child that finished between crash and re-sweep must not be re-run. Task-level `depends_on` compiles to
ticket-level `depends_on` with the same mapping.

Child frontmatter (door-built): `id`, `repo`, `github: {nwo, issue, kind: pr}`
(bridge door), `plan: {id, task, hash}`, `depends_on`. `pr_title` deliberately
omitted, as today.

### Bridge door (GitHub mode, behind `planSets.enabled`)

Flow deltas relative to the current single-ticket plan path:

- `planPrompt.ts` includes multi-task instructions (teaching the `junco-plan`
  fence) only when `planSets.enabled`; otherwise the planner keeps emitting
  `junco-ticket` fences.
- On approval (unchanged temporal check), the bridge extracts the fence,
  hashes the fence content (sha256, first 12 hex), runs `compilePlan`, and
  submits the children **in one pass before any label swap** (existing
  submit-before-label ordering). Compile errors post as one issue comment and
  move the label to `junco:failed`.
- `buildPlanComment`'s `COMMENT_LIMIT` (60k) becomes a **refusal** for
  multi-task plans, not a truncation — a silently truncated set would compile
  "successfully" minus its tail tasks.

### Set dashboard (separate comment)

The plan comment is never edited by the bridge after approval — editing it would
bump `updated_at` and entangle the temporal check and the recorded hash. Instead
the bridge maintains a second comment (`<!-- junco:plan-status -->` marker,
same own-login authorship check as the plan comment): a task checklist updated
by the reporter as children reach terminal states (queued / waiting on `<ids>` /
working / done with PR link / failed / superseded). Set-level issue labels:
`junco:working` while any child is non-terminal, `junco:done` when all children
are done, `junco:failed` when the set degrades (any cascade or terminal child
failure), with a single "set degraded" comment naming the failed task and the
parked dependents.

### Supersede (mid-set re-approval)

Editing the plan comment mid-set does nothing by itself — running children were
compiled from an approved version, recorded by hash. A **fresh** `junco:approved`
event postdating the edit (the existing temporal rule, applied to the new
timestamps) triggers supersede:

1. Wait until the set is quiescent (no children in `processing/`) — avoids
   ambiguity about whether an in-flight run's result belongs to the new plan.
2. Finalize unclaimed children of the old compile into `failed/` with
   `superseded: <new-hash>` in the result block. This is done as one batch over
   the whole old set and does not additionally trigger the failure cascade —
   supersede finalization _is_ the old set's disposition.
3. Recompile from the current comment. Tasks whose `<execution-base>-<task-id>`
   already has a **done** ticket are skipped (task id is task identity across
   plan versions); their ids remain valid `depends_on` targets for new children.
4. Submit the new children; update the dashboard.

Automatic re-planning never happens; a human edits and re-approves.

### CLI door (fast-follow)

`junco submit --plan <file>` runs the same `compilePlan` over a local plan
document and submits the children. No approval machinery: local dispatch is
already trusted — the junco-dispatch preview gate is the approval, exactly the
trust model of every locally-authored ticket today. This door is a thin wrapper
and easier to test than the bridge door (no fake `gh` needed for compile logic);
it ships as the first fast-follow, not v1, purely to bound v1 review scope.

## Layer 3 — context travels in the ticket body

No plan file is committed to the work branch (it would pollute every PR diff,
feed the critic noise, conflict across siblings, and permanently mark user repo
history). Instead the compiler writes rich child bodies aligned with the
`TEMPLATE.md` section conventions, which the existing machinery consumes with
**zero runtime changes**:

- `# <task title>` and the task description
- `## Behavior (acceptance — testable assertions)` — the task's acceptance list;
  the diff-vs-spec critic consumes the entire body as the spec
  (`src/critic.ts:186`)
- `## Prohibitions` — task-level plus plan-level prohibitions
- `## Shared context` — the plan's `shared_context` verbatim, plus a note naming
  the dependency tickets whose merged PRs precede this task
- `## Verification (junco runs this — do NOT run it yourself)` — the task's
  `verification` block; `runSpecVerification` executes it as today
  (`src/verify.ts:163`)

The durable plan copy lives under the data root (`<dataDir>/data/plans/<plan-id>.md`,
alongside the transcripts precedent), written at compile time by either door.

## Configuration

```jsonc
"planSets": {
  "enabled": false,        // gates plan compilation (bridge + CLI doors)
  "mergePollSeconds": 60,  // dependency-sweep throttle
  "maxTasks": 10           // compiler cap per plan
}
```

`depends_on` handling (predicate, sweep, cascade, retry resurrection) is always
on; it activates lazily when an edge exists and costs nothing otherwise.

## Error handling summary

| Failure                                                 | Behavior                                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Compile error (parse, cycle, unknown ref, cap, smuggle) | Nothing dispatches; one error comment; `junco:failed`                                               |
| Plan comment over 60k                                   | Refusal at render, same as compile error                                                            |
| Dependency ticket fails terminally                      | Transitive dependents cascade to `failed/` with `dependency_failed`                                 |
| Dependency PR closed unmerged                           | Same cascade                                                                                        |
| `gh` unreachable during sweep                           | Warn and wait; never cascade on inability to check                                                  |
| Dangling `depends_on` reference                         | Wait; `submit` warns; `status` surfaces staleness                                                   |
| Crash mid-fan-out                                       | Next sweep resubmits only children absent from the whole queue (deterministic ids + resolver check) |
| Plan edited mid-set                                     | No effect until a fresh approval postdates the edit → supersede                                     |

## Testing approach

- **Compiler**: pure-module unit tests — happy path, every fail-closed error
  class, id determinism, body layout. No `gh`, no filesystem.
- **Resolver / predicate / cascade / retry**: queue-directory tests in tmp dirs
  via `makeConfig`; cascade transitivity; resolver precedence with duplicate ids.
- **Sweep**: fake `gh` shell scripts (existing pattern) for merged / open /
  closed / error; stamping idempotence; no-PR parent path; lazy no-op when no
  edges exist.
- **Bridge door**: extend the existing `githubInbox` fake-gh harness — fence
  branching (`junco-ticket` vs `junco-plan`), submit-before-label crash points,
  supersede sequence, dashboard comment lifecycle, 60k refusal.
- **Scheduler**: dependency-gated claim under `runScheduler` (real-tick sleep,
  per the testing gotchas).
- New `Config` field `planSets` lands in `tests/helpers/config.ts` (a feature
  toggle → a `ConfigSeams` key).

## Phasing

1. **Layer 1** — schema keys, resolver, claim predicate, dependency sweep,
   cascade, retry resurrection, list/status visibility. Mode-agnostic; useful
   immediately with hand-authored sets through the inbox door.
2. **Layer 2 + 3** — `junco-plan` fence, pure compiler, bridge door, dashboard,
   supersede, plan materialization to dataDir; behind `planSets.enabled`.
3. **Fast-follow** — CLI door (`junco submit --plan`), a thin wrapper over the
   phase-2 compiler.
4. Revisit with usage data: integration-branch / stacked PR strategy, GitHub
   sub-issues as an external surface (`fetchParent` already reads the field),
   Linear bridge.

## Out of scope

- Stacked branches / plan-level integration branch
- Cross-repo plan sets
- Automatic re-planning on failure
- GitHub sub-issues as the set surface (internal-first; dashboard comment only)
- Linear bridge; remote executor / credential split
