# Issue-as-inbox: verbatim fence dispatch through the GitHub bridge

**Date:** 2026-08-21
**Status:** Draft for review
**Scope:** `githubInbox.ts` sweep precedence, `junco submit --as-issue`, junco-dispatch skill surface

## Problem

A ticket authored by the junco-dispatch skill has exactly one entry into the queue: the local
inbox. The GitHub bridge cannot carry a pre-authored ticket — a trigger-labeled issue always
routes PR-shaped work through the daemon-side planner (`buildPlanningTicket` → planning session →
plan comment → approval → `extractPlanBody` of the *comment*). Even an issue body containing a
complete, skill-quality plan is re-authored by the local model: a second lossy hop, a full
planning inference spent transcribing a finished document, and no verbatim guarantee.

The routing is also confusing to reason about because it reads as three route-shaped concepts —
local inbox, ask-verbatim, plan-mediated — plus two identities (operator account, bot account)
with no single rule for where the human gate sits.

## Design invariant

> **The daemon executes only tickets whose body came from a human-vouched fence; frontmatter is
> always machine-built.** The planner is not a route — it is the fence *producer* for issues
> that arrive without one.

Everything below is mechanism serving that one sentence. Zero new config keys.

### The one human gate, per door

| Door                    | Author                       | Human gate                          |
| ----------------------- | ---------------------------- | ----------------------------------- |
| Local inbox             | skill (in-session)           | in-session preview gate → submit    |
| Issue with fence (NEW)  | skill via `--as-issue` (bot) | **human applies the trigger label** |
| Loose issue (planner)   | issue author, then planner   | human approves the plan comment     |

Bot authors; only a human launches. The bot account never applies the trigger label.

## Bridge changes (`githubInbox.ts`)

The labeled-issue sweep branch becomes an ordered precedence list:

1. **Ask label** → `issueToTicket` verbatim prose on read-only Q&A rails — unchanged. Ask wins
   even if the body contains a fence (ask rails cannot mutate; prose is the ask contract).
2. **Vouched body contains a fence** → extract and queue directly, skipping planning:
   - ` ```junco-plan ` fence, with `planSets.enabled` → the plan-set compilation door
     (`dispatchPlanSet`), exactly as a plan-set comment would compile. With plan sets disabled
     the fence is ignored (fall through to rule 3), mirroring the comment path's gating.
   - ` ```junco-ticket ` fence → execution ticket. Checked after `junco-plan`, mirroring the
     comment path's precedence.
3. **No fence** → `buildPlanningTicket`, planning session, plan comment, approval — unchanged.

### Shared extraction — `queueFromFence()`

Factor the fence→execution-ticket materialization currently inline at the plan-comment approval
site (`extractPlanBody(comment.body)` → machine-built frontmatter → `submitFn`) into one helper
used by both the approval path and the new door. One extractor (`extractFencedBlock`), one
frontmatter builder, one in-flight guard (`ticketInFlight`), one idempotent label-marking step.

### Trust and vouching — no new machinery

- The trigger label vouches the issue body **as it was when labeled**; the existing
  edited-after-label check ("re-apply the label to re-vouch") runs before extraction and covers
  this door with zero new code.
- Frontmatter stays machine-owned: fence content can never set `repo:` / `workdir:` / `tools:` /
  network rails — identical boundary to the plan-comment path.
- `requireApproval` does not apply to this door: there is no plan-ready stage. The label **is**
  the approval. (It continues to govern the planner door unchanged.)
- Labeling a fence issue you did not read is the same trust decision as approving a plan comment
  you did not read. The gate is a human reading what they vouch; the door does not change that.

### Lifecycle

Fence-door tickets are ordinary bridge tickets: id `githubTicketId(nwo, issueNumber)` (the
authored local `id:` is discarded at `--as-issue` time — machine ids keep bridge dedup and
lifecycle exactly as today), `github: {nwo, issue, kind: pr}` frontmatter, lifecycle labels
`queued → working → done/failed` (the `planning`/`plan-ready` states are simply never entered),
and the existing report-comment/close flow via `githubReport.ts` applies unchanged.

## CLI: `junco submit --as-issue <ticketfile>`

Files a locally-authored ticket as a **parked, unlabeled** GitHub issue instead of dropping it
in the inbox.

1. **Validate** the ticket exactly as plain `submit` does (`parseTicket` must succeed).
2. **Resolve the target repo** from `repo:` frontmatter. Refuse, with the reason, unless the
   repo is **owned, bridge-watched, and GitHub integration is enabled** — the door needs label
   rights and a sweeping bridge to ever launch. (Unowned repos are out of scope: no triage
   rights, no label, no gate.)
3. **Refuse unless `botAccount.enabled`.** The filing identity is the bot (isolated
   `GH_CONFIG_DIR`, as assess `fileAs: bot` does). Error text suggests enabling the bot account
   or submitting locally. No `--as-me` fallback in v1.
4. **Build the issue:** title from `pr_title:` (fallback: ticket's first `#` heading); body =
   the ticket body — frontmatter stripped — wrapped in a ` ```junco-ticket ` fence, preceded by
   one plain-prose summary line (GitHub list/notification legibility) and followed by a marker
   comment `<!-- junco:as-issue -->` (provenance only; the bridge keys on the fence, not the
   marker).
5. **Apply no labels.** Print the issue URL and the launch instruction:
   `parked — apply label '<trigger>' to queue`.

A `junco-plan` fenced document (ticket-set dispatch) rides the same flag: `--as-issue` with
`--plan <file>` wraps the plan fence instead. Refused when `planSets.enabled` is off (it could
never launch).

## Skill surface (`skills/junco-dispatch/SKILL.md`)

- The preview gate gains a destination choice: **inbox (default)** or **GitHub issue (parked)**.
  Explicit trigger phrases route directly: "park it on github", "junco as issue: …",
  "dispatch as issue".
- On the issue route the skill runs `junco submit --as-issue` and sets expectations: nothing
  runs until a human applies the trigger label — doable from the GitHub app on a phone.
- The existing "linked tracking issue" (`github_request.create_issue`) text gains one contrast
  sentence: that option is issue-as-artifact of a local dispatch; `--as-issue` is
  issue-as-queue-entry. The current SKILL.md framing that dispatch is local-only is **rewritten,
  not appended to** (lean consolidation).

## Lean review — what this supersedes

- The rejected alternatives are recorded here so they are not re-litigated: issue-as-mirror
  (files issue + inbox ticket; no gate, two sources of truth) and planner-passthrough (prompt
  the planner to transcribe fences verbatim; still model-mediated, still a planning inference).
- No existing mitigation is removed. The planner door, ask door, and local inbox are unchanged;
  this inserts one precedence rule and reuses the extraction/vouch machinery verbatim.
- `docs/ARCHITECTURE.md` bridge section gets the three-door precedence list, replacing the
  current two-branch description.

## Testing

Unit (existing harness patterns — fake `gh` shell script, `tests/helpers/config.ts`):

- Sweep precedence: ask label beats fence; `junco-plan` fence beats `junco-ticket`; fence beats
  planner; no fence falls through to planner unchanged.
- `queueFromFence` parity: plan-comment approval path and issue-body path produce identical
  ticket content for identical fences.
- Vouch: body edited after label → refused with re-vouch log line (reuse of existing guard,
  asserted against the fence door specifically).
- Plan-set gating: `junco-plan` fence with `planSets.enabled` off falls through to the planner.
- `--as-issue`: happy path (issue body round-trips — wrap then sweep-extract yields the authored
  body); refusal paths (unwatched repo, unowned repo, GitHub integration off, bot account off,
  invalid ticket); no label applied; URL printed.
- Lifecycle: fence-door ticket carries `github:` frontmatter and machine id; in-flight guard
  dedups a relabel.

Integration: extend the existing bridge sweep test with a fence-carrying issue end-to-end
(label → queued ticket file content → lifecycle labels), no planning session spawned.

## Out of scope (deliberate)

- Unowned repos (no label rights → no gate).
- Ask-with-fence semantics (ask stays prose).
- A `--go` auto-label flag (in-session gate variant) — deferred until wanted.
- Who-applied-the-label verification — the label-vouch trust model is unchanged from today.
