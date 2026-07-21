# Issue-scoped assess (SP-3, Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `junco assess owner/repo#N` — run the vulnerability audit scoped to the code a specific issue implicates, with filed findings carrying a `**Context:** owner/repo#N` reference (GitHub's auto-cross-reference then surfaces each finding on the issue's timeline).

**Architecture:** A _prompt-scoped_ assess — no new flow, store, or write kind. The assess target parser gains issue-refs (resolved through SP-2's `resolveIssueTarget`, which fail-fast fetches the issue and auto-provisions unowned clones); the ticket contract gains additive `assess.issue`/`assess.issue_title`; the audit prompt gains an untrusted issue-context section; `PendingAssess` threads an optional `issue`; `buildIssueBody` renders the context line (keeping its marker-last + truncation invariants). TUI: pane-2 `s` becomes issue-scoped for the selected issue.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, Ink TUI, `gh` behind deps seams.

**Spec:** `docs/superpowers/specs/2026-07-09-issue-targeted-engagement-design.md` (SP-3 section).

## Global Constraints

- **Branch:** `feat/assess-issue-scope` (created off `origin/main` @ `fa1410d`, which includes #95–#98).
- **ESM/NodeNext** `.js` imports. **`src/ticketSchema.ts` additive-only.** Injectable deps seams. No top-level Pi SDK imports. No new `Config` field.
- **Fingerprints untouched** — `fingerprintFinding` must not change; an issue-scoped finding and a whole-repo finding of the same defect must collide (cross-mode dedup is load-bearing).
- **Plain-target behavior unchanged:** `junco assess <path>` and `junco assess <nwo>` keep today's exact behavior (incl. the stricter already-watched rule for bare nwo); only issue-ref targets auto-provision. Existing `tests/assessCmd.test.ts` cases must keep passing (fixture-shape edits only if a type widens).
- **Ink test gotcha:** `until()` bounded retry only. **No AI attribution.** Conventional commits; suite green at every commit.
- **Full gate before done**; capture vitest exit explicitly.

## File Structure

| File                                                                                    | Responsibility                                             | Action |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------ |
| `src/ticketSchema.ts`, `src/types.ts`, `src/ticket.ts`                                  | Additive `assess.issue` + `assess.issue_title`             | Modify |
| `src/assessPrompt.ts`                                                                   | Optional `issueContext` section                            | Modify |
| `src/assessCmd.ts`                                                                      | Issue-ref target resolution + extended `buildAssessTicket` | Modify |
| `src/assessFlow.ts`, `src/assessReview.ts`                                              | Thread `issue` into the parked batch                       | Modify |
| `src/findings.ts`, `src/assessFiling.ts`                                                | Context line in filed issue bodies                         | Modify |
| `src/tui/App.tsx`, `Chrome.tsx`, `HelpModal.tsx`                                        | Pane-aware `s`                                             | Modify |
| Docs (assess.md, README, dashboard.md, tickets.md, SKILL.md, ARCHITECTURE.md if needed) |                                                            | Modify |

---

### Task 1: additive ticket contract — `assess.issue` / `assess.issue_title`

**Files:**

- Modify: `src/ticketSchema.ts` (the `assess` mapping's `properties`), `src/types.ts:165`, `src/ticket.ts` (the assess parse at ~52-56)
- Test: `tests/ticket.test.ts` (and `tests/ticketSchema.test.ts` per sibling placement)

**Interfaces:**

- Produces: `Ticket.assess: { autoPlan: boolean; issue?: number; issueTitle?: string } | null`. Parse: `issue` present and `Number.isInteger` → included (else omitted, mapping still valid — leniency mirrors the container's posture); `issueTitle: String(a.issue_title ?? "")` included only when `issue` is. Schema: add optional `issue` (integer) + `issue_title` (string) properties to the existing `assess` mapping with descriptions mirroring the `analyze` mapping's prose ("Issue-scoped audit: the audit prompt is steered to the code this issue implicates; filed findings carry a Context reference. Set by `junco assess owner/repo#N`.").

- [ ] **Step 1: Failing test** — round-trip via real `parseTicket`: `assess:\n  auto_plan: true\n  issue: 7\n  issue_title: "Bug"` → `{ autoPlan: true, issue: 7, issueTitle: "Bug" }`; `assess: {}` → `{ autoPlan: false }` (no `issue` key — assert `t.assess?.issue` undefined); non-integer issue → mapping valid, `issue` omitted.
- [ ] **Step 2: RED** (`issue` not on the type).
- [ ] **Step 3: Implement.** Fixture note: widening with OPTIONAL fields breaks no `assess: null` or `assess: { autoPlan }` literals — `npm run typecheck` confirms; sweep only if it flags.
- [ ] **Step 4: GREEN** + full typecheck.
- [ ] **Step 5: Commit** — `feat(assess): additive issue-scope ticket contract`

---

### Task 2: `buildAssessPrompt` issue-context section

**Files:**

- Modify: `src/assessPrompt.ts` (`buildAssessPrompt(opts: { nwo: string | null; repoPath: string; issueContext?: { nwo: string; issue: number; title: string; body: string } })`)
- Test: `tests/assessPrompt.test.ts`

**Interfaces:**

- Produces: when `issueContext` is set, the prompt gains (after the audit instructions, before the output contract — read the file to place it naturally): an `## Issue context (untrusted content)` section framed with the data-not-instructions idiom used by `buildAnalyzePrompt` (`src/analyzePrompt.ts` — mirror its corrected wording: "the title and text below"), the issue ref/title/body (empty body → `(no issue body)`), and the scoping instruction: "Scope the audit to the code this issue implicates — the files, subsystems, and dependency paths it names or exercises. Findings outside that scope are still valid but secondary; prioritize the implicated area." Existing callers (no `issueContext`) produce byte-identical output — lock with a test comparing against the current golden output if one exists (read the test file; if it snapshot-asserts, that's the lock).

- [ ] **Step 1: Failing test** — with `issueContext`: output contains the section header, the ref `up/stream#7`, the framing sentence, and the scoping instruction; without: output identical to before (assert the section ABSENT).
- [ ] **Step 2: RED.** — **Step 3: Implement.** — **Step 4: GREEN.**
- [ ] **Step 5: Commit** — `feat(assess): issue-context section in the audit prompt`

---

### Task 3: issue-ref targets in `junco assess`

**Files:**

- Modify: `src/assessCmd.ts` (`runAssessCommand` target resolution + `buildAssessTicket`), `src/cli.ts` (usage line only)
- Test: `tests/assessCmd.test.ts`

**Interfaces:**

- Consumes: `parseIssueRef`, `resolveIssueTarget`, `type IssueTarget` (`./externalDispatch.js` — shipped in SP-2).
- Produces:
  - `buildAssessTicket(repoPath, opts: { autoPlan: boolean; issueContext?: { nwo: string; issue: number; title: string; body: string } }, now)` — when `issueContext` set: frontmatter `assess:` block gains `  issue: <n>` and `  issue_title: <JSON.stringify(title)>` (alongside `auto_plan` when true); body = `buildAssessPrompt({ nwo: issueContext.nwo, repoPath, issueContext })`. Without: byte-identical to today (existing golden-ticket tests must pass unedited).
  - `runAssessCommand`: BEFORE the existing NWO/path branches, try `parseIssueRef(target)`; on a match → `resolveIssueTarget(cfg, target, …)` (fail-fast fetch; auto-provisions unowned clones + watchlist entry — dispatch/analyze semantics), then build with `issueContext` from the resolved `IssueTarget` (`title`, `body`) and `repoPath = t.clonePath`. Resolve errors → `junco assess: <msg>`, exit 1. Plain path/nwo branches untouched.
  - Usage line: `assess <path|owner/repo|owner/repo#N> [--auto-plan]  audit a repo — or scoped to one issue; findings await review`.

- [ ] **Step 1: Failing tests** — (a) golden issue-scoped ticket: injected `resolveFn` returning a full IssueTarget → `buildAssessTicket` output round-trips via `parseTicket` with `assess.issue === 7`, `assess.issueTitle`, body containing the issue-context section; (b) `runAssessCommand` with `"up/stream#7"` submits (captured `submitFn`) using the resolved clonePath; (c) resolve throw → exit 1 + message; (d) existing plain-nwo/path tests unedited-green.
- [ ] **Step 2: RED.** — **Step 3: Implement** (add `resolveFn?: typeof resolveIssueTarget` to `AssessCmdDeps`). — **Step 4: GREEN** + full file green.
- [ ] **Step 5: Commit** — `feat(assess): junco assess owner/repo#N — issue-scoped audit target`

---

### Task 4: thread `issue` through flow → store

**Files:**

- Modify: `src/assessReview.ts` (`PendingAssess` + `issue?: number` — additive, one line + comment), `src/assessFlow.ts` (park site)
- Test: `tests/assessFlow.test.ts`

**Interfaces:**

- Produces: the parked batch carries `issue: ticket.assess?.issue` (omit the key when undefined — spread `...(ticket.assess?.issue !== undefined ? { issue: ticket.assess.issue } : {})` so stored JSON stays clean for unscoped runs). Old batches (no `issue`) parse fine (optional field, loose store).

- [ ] **Step 1: Failing test** — assess ticket with `assess:\n  issue: 7` parks a batch where `listPending(cfg)[0].issue === 7`; unscoped ticket → `issue` undefined AND the key absent from the stored JSON (read the raw file).
- [ ] **Step 2: RED.** — **Step 3: Implement.** — **Step 4: GREEN** + typecheck.
- [ ] **Step 5: Commit** — `feat(assess): parked batches carry the scoping issue`

---

### Task 5: context line in filed issues

**Files:**

- Modify: `src/findings.ts` (`buildIssueBody`, `renderIssueBody`), `src/assessFiling.ts` (the `buildIssueBody` call in `fileFindings`)
- Test: `tests/findings.test.ts`, `tests/assessFiling.test.ts`

**Interfaces:**

- Produces: `buildIssueBody(f: Finding, context?: { nwo: string; issue: number }): string` — threads to `renderIssueBody(f, truncated, context)`; when set, a `**Context:** <nwo>#<issue>` section renders immediately BEFORE the machine-readable `<details>` block. INVARIANTS (read the function first — they're documented in it): the finding marker stays the literal last line; the truncation re-render path passes the same `context` (so an oversize body keeps its context line); the machine-readable JSON embeds the FINDING only (context is issue-body metadata, not part of `Finding` — do NOT add it to the JSON or the fingerprint input). `fileFindings`: `buildIssueBody(f, batch.issue !== undefined ? { nwo: batch.nwo, issue: batch.issue } : undefined)`.

- [ ] **Step 1: Failing tests** — (a) `buildIssueBody(f, { nwo: "o/r", issue: 7 })` contains `**Context:** o/r#7` before `<details>` and the marker is still the last line; (b) without context → byte-identical to today (existing tests unedited); (c) truncation path (oversize description) keeps the context line; (d) `fileFindings` on a batch with `issue: 7` → the gh-fake's body-file content contains the context line; batch without → doesn't.
- [ ] **Step 2: RED.** — **Step 3: Implement.** — **Step 4: GREEN** (existing findings tests unedited) + typecheck.
- [ ] **Step 5: Commit** — `feat(assess): filed findings reference the scoping issue`

---

### Task 6: pane-aware `s` in the dashboard

**Files:**

- Modify: `src/tui/App.tsx`, `src/tui/components/Chrome.tsx` (pane-2 hints), `src/tui/components/HelpModal.tsx`
- Test: `tests/tuiApp.test.tsx`

**Interfaces:**

- Produces: in the ISSUES pane (pane 2) with an issue selected, `s` runs an issue-scoped assess of the selected issue — reuse the existing `runAssess` machinery but pass the issue-ref target: the cleanest cut (read `runAssess` first) is a target parameter, e.g. `runAssess(autoPlan, targetOverride?: string)` defaulting to `currentNwo`, with the pane-2 branch calling `runAssess(false, \`${currentNwo}#${currentIssue.number}\`)` — the CLI (`runCliFn("assess", [target, ...]))` already accepts issue-refs after Task 3. Everywhere else (`pane 1`, global) `s`/`S`behavior is UNCHANGED. In-flight dedup:`assessInFlightRef`keys on the target string (so a repo-scoped and an issue-scoped run don't block each other, but double-pressing the same issue does). Toast:`assessing ${target}…`. Post-#97 note: the `s`binding lives in the github-mode key section; do not touch LOCAL-mode routing. Chrome pane-2 hints gain`["s","assess issue"]`; HelpModal "act on issue" gains `["s","assess scoped to this issue (findings reference it)"]`.
- **Key-routing caveat:** `s` is currently a GLOBAL main-view binding (fires regardless of pane). The pane-2 issue-scoped variant must intercept BEFORE the global one when pane 2 is focused with a selection — read the useInput cascade order (pane-scoped blocks vs global block) and place accordingly; if the global `s` fires first structurally, gate it (`if (pane === 2 && currentIssue) → issue-scoped else → repo-scoped`) at the single existing binding instead of adding a second. Pick whichever matches the file's structure; state which in your report.

- [ ] **Step 1: Failing tests** — (a) pane 2 focused + issue selected + `s` → `runCliFn` captured with `("assess", ["acme/api#7"])`; (b) pane 1 focused + `s` → `("assess", ["acme/api"])` (repo-scoped, unchanged); (c) existing global-`s`/`S` tests unedited-green.
- [ ] **Step 2: RED.** — **Step 3: Implement.** — **Step 4: GREEN** + typecheck.
- [ ] **Step 5: Commit** — `feat(tui): pane-aware s — assess scoped to the selected issue`

---

### Task 7: docs

**Files:**

- Modify: `docs/assess.md` (new "Issue-scoped assess" section: target form, auto-provisioning for issue-refs vs already-watched rule for bare nwo, the Context line + timeline cross-reference, fingerprint-shared dedup), `README.md` (command-table target column), `docs/dashboard.md` (`s` key row: pane-aware), `docs/tickets.md` (assess frontmatter fields table: `issue`/`issue_title`), `skills/junco-dispatch/SKILL.md` (assess-mode blurb: issue-scoped form), `ARCHITECTURE.md` only if its assess row now misdescribes behavior (check).
- **Staleness re-check** (the standing lesson): grep docs/ + README for claims contradicted by issue-scoped assess (e.g. "audits the whole repo" absolutes, target-form lists). Fix what's stale.
- **Stack-agnostic sweep** over shipped files touched; prettier; `npm run format:check`.

- [ ] **Step 1:** Write; verify quoted stdout/CLI forms against the code. — **Step 2:** sweeps + format. — **Step 3: Commit** — `docs: issue-scoped assess`

---

## Final verification (before the PR)

- [ ] Full gate (explicit vitest exit) + `npx tsc --noEmit -p tsconfig.eslint.json` (no new errors) + attribution sweep.
- [ ] Merge `origin/main` if it moved; re-run the gate.

## Self-review (completed by plan author)

- **Spec coverage:** issue-ref target + auto-provision (T3) · additive contract (T1) · prompt scoping (T2) · store threading (T4) · context line with marker/truncation invariants + fingerprint untouched (T5) · pane-aware `s` (T6) · docs incl. staleness (T7). Documented asymmetry (bare-nwo stays strict) restated in T3 + T7.
- **Placeholders:** none; each step has concrete code-or-locus and named invariants.
- **Type consistency:** `issueContext {nwo,issue,title,body}` consistent T2/T3; `context {nwo,issue}` consistent T5; `PendingAssess.issue?: number` consistent T4/T5.
