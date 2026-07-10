# Issue-targeted engagement: analysis comments (SP-2) + issue-scoped assess (SP-3)

**Date:** 2026-07-09
**Status:** draft

## Problem

SP-1 (`2026-07-09-assess-any-repo-review-queue-design.md`, shipped in #95/#96) built the
least-privilege engagement model: junco can now open **issues** on any repo — owned or not —
behind a durable park→review→confirm gate. Two capabilities from the same endorsed roadmap
remain unbuilt:

1. **SP-2 — analysis comment on an existing issue.** Point junco at any issue (owned or
   unowned repo); it investigates the codebase read-only, drafts an analysis (root cause,
   evidence, repro, suggested fix direction), and — only after the operator reviews and
   optionally edits the text — posts it as a comment on that issue.
2. **SP-3 — assess scoped to a specific issue.** Run the vulnerability audit focused on the
   code a particular issue implicates, with filed findings referencing that issue, instead
   of a whole-repo sweep.

The redrawn etiquette invariant (SP-1 spec) **already authorizes both**: "posting comments"
is named in the unprivileged tier, and "comment text approved before posting" is verbatim in
the invariant. SP-2 implements a promise the spec already made; SP-3 adds no new write kind
at all. No invariant change is needed.

## Goal

- `junco analyze <owner/repo#N|issue-url>` → read-only investigation → parked comment draft
  → `junco analyze review/edit/post` (and the dashboard) → comment posted on the issue.
- `junco assess owner/repo#N` → issue-scoped audit → findings (referencing the issue) parked
  into the existing assess review queue → filed through the existing confirm surfaces.
- One code path for owned and unowned repos in both features. Comments are unprivileged
  everywhere, so SP-2 has **zero** owned/external branching (external clones get the
  freshness sync; owned checkouts are never touched — same rule as assess).

## Decisions (from brainstorming)

| Decision            | Choice                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| Packaging           | One spec (this), two implementation plans — SP-2 first, SP-3 second        |
| CLI namespace       | `analyze` (`junco analyze <ref>` / `analyze review` / `analyze edit` / `analyze post`), mirroring assess's pattern |
| Disclosure footer   | Default-on, removable: one-line footer appended at post time; `analyze post --no-footer` (or editing the flag off) removes it |
| TUI scope           | Folded into the SP-2 plan (pane-2 `c` key + review-view union); SP-2 branches off main after #96 merges |
| Draft editing       | Full text editing via `junco analyze edit <id>` ($EDITOR round-trip, git-commit style); the TUI previews and posts/discards but does not edit |
| SP-3 trigger        | `junco assess owner/repo#N` (target parser gains issue-refs); TUI pane-2 `s` becomes issue-scoped for the selected issue |

## What already exists (the reuse map)

| Need                                            | Existing seam                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| Post a comment durably + idempotently           | outbox `comment` op + `postCommentIdempotent` (`githubOutbox.ts`) |
| Resolve `owner/repo#N` / issue URL              | `parseIssueRef` (`externalDispatch.ts`)                           |
| Fetch issue, auto-fork/clone unowned repos      | `dispatchIssue`'s provisioning (`ensureExternalClone` + watchlist) |
| Read-only agent run, requeue, transcript, guards| `assessFlow.ts` shape (mirrors Q&A)                               |
| Fenced-output extraction                        | `extractLastFencedBlock` (`findings.ts`, exported)                |
| Untrusted-text sanitization                     | `sanitizeFindingText` (HTML comments, control chars, caps)        |
| Durable park → human confirm                    | review store pattern + CLI/TUI confirm surfaces (SP-1/#96)        |

## Shared plumbing (built in the SP-2 plan, consumed by both)

### `resolveIssueTarget(cfg, ref, deps)` — extracted from `dispatchIssue`

Returns `{ nwo, issue, title, body, clonePath, external }`: parse the ref, fail-fast
`gh issue view` fetch, owned-map lookup (config ∪ non-external watchlist) or
`ensureExternalClone` + watchlist add for unowned repos. `dispatchIssue` is refactored to be
its first consumer (behavior unchanged, existing tests as the net); `analyze` and
`assess #N` are consumers two and three.

### Generic review store — `src/reviewStore.ts`

`makeReviewStore<T extends { id: string }>(subdir, archiveSubdirs)` capturing SP-1's store
discipline once: one JSON file per entry under `<state_dir>/<subdir>/`, atomic tmp+rename,
slugified id→filename (issue #32 class), never-throw reads (missing → empty; corrupt →
skipped/error), archive-on-remove. `assessReview.ts` becomes a thin wrapper **preserving its
exact current exports** (`writePending`, `listPending`, `readPending`, `removePending`,
`pendingCount`) — zero consumer churn; its existing tests must pass unchanged.
`commentReview.ts` is the second instantiation.

## SP-2 architecture

### Phase A — `analyzeFlow.ts` (daemon, read-only)

Mirrors `assessFlow.ts` phase-for-phase: repo containment → nwo from origin → path-based
external detection → `syncExternalClone` (external only, warning on failure) → agent run
(read-only tool default, per-ticket `tools:` override, supervisor/guards, transcript,
timeout, transient requeue) → **extract** the last complete ```` ```junco-comment ```` fence
from `finalText` → **sanitize** → **park** → finalize with a "draft parked — run
`junco analyze review <id>`" summary. No fence or an empty draft finalizes to failed with a
clear message (nothing parks).

**Sanitization is load-bearing:** the issue text is untrusted input and the draft becomes a
public post under the operator's account. The draft is stripped of HTML comments — this
blocks **marker spoofing** (a malicious issue steering the agent to emit
`<!-- junco:finding:… -->` / `<!-- junco:outbox:… -->` strings that would poison SP-1's
dedup scans) — plus control characters, and capped at 60,000 chars (GitHub's practical
comment ceiling with headroom). `sanitizeFindingText` already does exactly this.

**Ticket shape (additive to `ticketSchema.ts`, the stable contract):**

```yaml
id: analyze-<owner>-<repo>-<n>        # no timestamp: queued duplicate fails loud;
repo: "<clonePath>"                   # a re-run overwrites the parked draft (store keyed by id)
analyze:
  issue: <n>
  title: <json-string>                # machine-built, sanitized; display-only
```

The issue body lands only in the ticket **body**, inside the same explicit
data-not-instructions block dispatch uses. Deliberately **no `github:` frontmatter block**:
the reporter's comment/label lifecycle keys off it, and analyze tickets must produce **no
un-gated outward write** — the only outward write is the human-confirmed post. (Plan task:
verify and test that the reporter no-ops on analyze tickets.)

`runOnce.ts` routes `ticket.analyze` **before** the `hasRepo` branch — same trap as assess
(analyze tickets carry `repo:`, which would otherwise trigger the PR flow).

### The pending store — `commentReview.ts`

```ts
interface PendingComment {
  id: string;          // ticket id (analyze-<owner>-<repo>-<n>)
  nwo: string;
  issue: number;
  issueTitle: string;  // sanitized, display-only
  external: boolean;
  repoPath: string;
  createdAt: string;   // ISO
  draft: string;       // sanitized; stored WITHOUT the footer
  footer: boolean;     // default true; post appends the footer line when true
}
```

Directory `<state_dir>/comment-review/`; archives: `posted/` and `discarded/`. Footer is a
**flag applied at post time**, not text in the draft — preview surfaces show it, `--no-footer`
clears it, and editing never has to string-match it out. Footer text (stack-agnostic; junco
is the product's own public name):

> `_Analysis drafted with [junco](https://github.com/ironforgesoftware/junco) and human-reviewed before posting._`

### Phase B — confirm surfaces

**CLI** (`analyzeCmd.ts`, mirroring `assessCmd.ts`):

- `junco analyze <owner/repo#N|url>` — resolve, provision, submit the ticket.
- `junco analyze review [<id>]` — list drafts (id · nwo#N · age · first line) / show one
  (full draft + footer preview).
- `junco analyze edit <id>` — $EDITOR round-trip (temp `.md`, spawn `$VISUAL`/`$EDITOR`,
  re-read, re-sanitize, update the store). No editor set → print the pending file's path and
  exit non-zero instead of guessing.
- `junco analyze post <id> [--no-footer]` — compose (draft + footer if flagged), post via
  `tryOrEnqueue` (live `gh issue comment` / durable outbox `comment` op offline), archive to
  `posted/`, print the comment URL (or "queued"). The explicit `post <id>` command **is** the
  confirm gate — one draft, one deliberate action; no additional flag required.
- A failed post (locked issue, auth, etc. — non-network) surfaces the error and leaves the
  draft pending; nothing archives on failure.

**TUI** (tail tasks of the SP-2 plan; requires #96's `ReviewView`):

- Pane-2 key **`c`** — "draft an analysis comment on the selected issue" (owned and
  external alike), fire-and-toast like `d`-dispatch.
- The `v` review view lists **both kinds** — finding batches and comment drafts, badged.
  Enter on a draft → scrollable preview (with footer line shown); `f`/enter posts; `x`
  discards (archives to `discarded/`). Editing stays CLI-side (Ink text editing is not
  worth building).
- `DashboardClient` gains `listCommentDrafts` / `postCommentDraft` / `discardCommentDraft` /
  `analyzeIssue` — same closure-over-`cfg` seam; `App` still never touches `cfg`.

**Visibility:** pending-draft count joins the pending-findings count in `status`, `doctor`,
and the dashboard header chip.

## SP-3 architecture

A **prompt-scoped assess** — no new flow, no new store, no new write kind:

- **Target:** `junco assess owner/repo#N` (or an issue URL). The assess target parser tries
  `parseIssueRef` first; on a match it goes through `resolveIssueTarget` (which fail-fast
  fetches the issue and **auto-provisions** unowned clones, exactly like dispatch/analyze).
  Plain `junco assess <nwo>` keeps its stricter already-watched rule — documented asymmetry.
- **Ticket (additive):** `assess: { auto_plan?, issue: <n>, issue_title: <json-string> }`;
  the issue body rides the ticket body in the untrusted-context block.
- **Prompt:** `buildAssessPrompt` gains an optional issue-context section — the framed
  untrusted block plus "scope the audit to the code this issue implicates; findings outside
  that scope are still valid but secondary."
- **Flow/store:** `assessFlow` threads `issue` into the parked batch (`PendingAssess` gains
  optional `issue?: number` — additive, old batches parse fine). Everything else unchanged.
- **Filing:** when `batch.issue` is set, `buildIssueBody` (optional second param, so the
  marker-last and truncation invariants stay inside the one function that owns them) renders
  a `**Context:** <nwo>#<n>` line. GitHub's automatic cross-referencing then surfaces each
  filed finding on the original issue's timeline — a free backlink; posting prose on the
  issue remains SP-2's job and is not bundled.
- **Dedup for free:** fingerprints are computed from `kind|ruleId|locus` and are deliberately
  untouched — an issue-scoped finding and a whole-repo finding of the same defect collide,
  so re-running assess in either mode never double-files.
- **TUI:** pane-aware `s` — issues pane (pane 2) assesses the *selected issue's* scope by
  passing `owner/repo#N` to the existing CLI runner; pane 1/global `s` stays repo-scoped.
  (`S`/auto-plan downgrade for external repos already happens one layer down.)

## Risks & limitations

- **Public posting under the operator's account.** The human gate (review + optional edit +
  explicit post) is the control; the default-on disclosure footer is the etiquette backstop.
  Named residual risk: a draft could quote something sensitive the agent read in an owned
  repo's working tree — the review step is the mitigation, and the docs say so.
- **Marker spoofing** via hostile issue text → blocked by draft sanitization (HTML-comment
  stripping) before parking; explicit test required.
- **One draft per issue at a time** (id has no timestamp): a re-analysis overwrites the
  pending draft. Posting twice on one issue requires two full deliberate cycles — accepted.
- **Locked/closed issues** fail at post time with a surfaced error; the draft survives.
- **Reporter must no-op** on analyze tickets (no `github:` block) — verified by test, since
  an accidental reporter comment would be an un-gated outward write.

## Non-goals

- Editing drafts inside the TUI (CLI/$EDITOR only).
- Auto-commenting on the original issue when SP-3 files findings (the body cross-reference
  suffices; use SP-2 deliberately if prose is wanted).
- Threaded replies / reacting to maintainer responses (a future SP; requires re-reading the
  issue conversation).
- Labels on comments (GitHub has none) or any lifecycle state on unowned trackers.
- Auto-provisioning for plain `assess <nwo>` (issue-ref targets provision; bare nwo keeps
  SP-1's already-watched rule).

## Testing

- `reviewStore` factory: SP-1's `assessReview` tests pass **unchanged** through the wrapper;
  generic store unit tests (atomicity, slug containment, corrupt/missing, archive dirs).
- `resolveIssueTarget`: owned map vs external provisioning vs bad ref/auth fail-fast;
  `dispatchIssue` regression suite passes unchanged post-refactor.
- `analyzeFlow`: parks a sanitized draft; **spoofed-marker stripping** (draft containing
  `<!-- junco:finding:x -->` parks clean); no-fence → failed, nothing parked; external sync
  called only for external; requeue overwrites the same draft id; reporter no-ops.
- `analyzeCmd`: review list/show; edit round-trip (injected editor fn); post appends footer
  by default / omits with `--no-footer`; post archives to `posted/`; offline post enqueues a
  `comment` op (replayable, idempotent via the existing outbox marker); failed post leaves
  the draft pending.
- SP-3: issue-ref target resolution + provisioning; prompt contains the framed context
  block; `PendingAssess.issue` threads through to a `**Context:**` line rendered before the
  machine block and marker; fingerprint equality across scoped/whole-repo runs.
- TUI (Ink, `until()` bounded-retry only): `c` dispatches; review view lists both kinds;
  draft preview → post/discard; pane-2 `s` sends `owner/repo#N`.

## Docs to update

- README (analyze verb + the issue-targeted loop), new `docs/analyze.md` (mirroring
  `docs/assess.md`), `docs/assess.md` (issue-scoped section), `docs/dashboard.md` (`c` key,
  review-view union, pane-aware `s`), ARCHITECTURE.md module map (`reviewStore.ts`,
  `commentReview.ts`, `analyzeFlow.ts`, `analyzeCmd.ts`, `analyzePrompt.ts`), the packaged
  `junco-dispatch` skill blurb. All shipped docs stay stack-agnostic.
- No etiquette-invariant change: SP-1's redrawn invariant already names human-confirmed
  comment posting; this spec cites it rather than amending it.

## Implementation phasing

Two plans, sequential SDD execution, each branched off latest `origin/main`:

- **Plan A (SP-2, ~12 tasks):** `reviewStore` extraction → `resolveIssueTarget` extraction →
  `commentReview` store → analyze ticket/prompt/flow (+ runOnce routing + reporter no-op
  test) → `analyze` CLI quartet → status/doctor/header counts → TUI (client methods, review
  view union, `c` key) → docs. **Branch after #96 merges** (TUI tasks build on `ReviewView`).
- **Plan B (SP-3, ~7 tasks):** assess target issue-refs via `resolveIssueTarget` → additive
  schema + prompt context → flow/store threading → filing context line → pane-aware `s` →
  docs.
