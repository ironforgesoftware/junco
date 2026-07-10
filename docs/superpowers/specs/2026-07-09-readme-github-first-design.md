# README, GitHub-first — design

**Date:** 2026-07-09 · **Status:** approved by maintainer (design conversation, this date)

## Goal

Restructure `README.md` (which is also the npm package page — it ships in the tarball) to be
more informative and to carry the positioning of junco.ironforgesoftware.com: GitHub-first,
TUI-forward, with the folder flow as the second door. A README, not a marketing page: tables,
doc links, and checkable specifics keep their place.

## Locked decisions (maintainer-confirmed)

1. **GitHub-first restructure** (not a light touch, not a full site mirror): new tagline
   "Issues in. Pull requests out.", a new "The loop" walkthrough section, assess gets its own
   section, "Two ways to feed it" dissolves (GitHub half → The loop; folder half → a short
   "Or drop a ticket in a folder" section).
2. **npm timing:** merge to main now (GitHub page updates immediately); the npm page refreshes
   with the next natural release. No docs-only release.
3. **Mock glyphs:** the dashboard mock adopts the site's aligned 84-ch layout but restores the
   REAL TUI glyphs the site substituted for font-subset reasons (`🐦` header mark, `⚑1 PR`
   attention chip, `⏳2` queue chip, `◍1` pending-checks count) — GitHub/npm rendering has no
   font-subset constraint, and fidelity to the actual TUI wins here.
4. Closing **bird line** (from the site footer) after the License section: "Named after the
   dark-eyed junco — a small, unassuming snowbird that works through winter."

## New outline

```
# junco
_Issues in. Pull requests out._
[badges — unchanged] · site link line — unchanged
Positioning paragraph — rewritten GitHub-first
[dashboard mock — site layout + real TUI glyphs]
## The loop: label → plan → approve → PR      (NEW)
## Why junco                                   (bullets reordered GitHub/TUI-first)
## It files its own issues                     (NEW — assess)
## Sixty seconds to a running worker           (dashboard promoted to 2nd command)
## Or drop a ticket in a folder                (replaces "Two ways to feed it")
## Documentation                               (table unchanged; verify rows at impl)
## CLI at a glance                             (table unchanged; verify rows at impl)
## Contributing                                (test count corrected; keep dogfood line)
## License                                     (+ bird line beneath)
```

## Section requirements

- **Positioning paragraph:** GitHub-first — label an issue `junco` → plan as an issue comment →
  approve → supervised agent in an isolated worktree → pull request; any OpenAI-compatible
  inference endpoint; code/git/credentials stay local; Markdown tickets in a folder as the
  other door (any tool or human can author them; junco is harness-agnostic on dispatch).
- **The loop:** numbered walkthrough carrying the exact lifecycle labels (`junco` →
  `junco:planning` → plan comment + `junco:plan-ready` → `junco:approved` → `junco:queued` /
  `junco:working` → PR with `Closes owner/repo#N` → `junco:done`; say "draft" only if the
  impl verifies draft-by-default in config for bridge tickets); then three
  one-liners: trust model (approval verified — write+ collaborator, postdates the plan comment;
  frontmatter always bridge-built, never model output; fails closed), `junco:ask` (read-only
  Q&A, no branch, no PR), offline outbox (durable FIFO replay of labels, comments, PR pushes;
  dead-letter after 3 attempts). Ends with the site's 12-line `junco logs -f` transcript as a
  static fenced block (verbatim — every line already code-verified this session, including the
  `gh-acme-reef-api-52` ids and the 17-minute human gap).
- **Why junco:** existing seven bullets, reordered GitHub/TUI-first (GitHub-native dispatch,
  plans before code, dashboard, tickets in/PRs out, local-first, offline-tolerant, supervised);
  copy edits only where the reorder demands.
- **It files its own issues:** `junco assess <path|owner/repo> [--auto-plan]` — npm audit +
  read-only agent audit; issues titled `[<severity>] <title> (<ruleId>)` with `junco:finding` +
  `severity/<level>` labels; fingerprint dedup against the last 500 findings **including closed
  ones** (the sharp fact the site's word budget cut — the README carries it); `--auto-plan`
  adds the trigger label so the loop consumes junco's own findings.
- **Sixty seconds:** keep wizard-first `npx` line; `junco dashboard` becomes the second
  command; `junco submit` third; keep the schema/examples/junco-dispatch pointer.
- **Or drop a ticket in a folder:** 3–4 lines — inbox, 14-phase pipeline, worktree → verify →
  critic → draft PR, requeue with backoff; link docs/tickets.md.
- **Contributing:** replace the stale "~1,100 tests" with the real current count (measure via
  the gate run at impl; round to the nearest hundred with `~`), in both the prose and the
  clone-and-test snippet.

## Hard rules

- Stack-agnostic (ships to npm): no AI vendor/model/inference-server names; "inference
  endpoint" / "any OpenAI-compatible inference endpoint" only. No personal-setup strings.
- House style: no hype words (blazing/seamless/powerful/…); claims carry checkable specifics;
  label names, log lines, and CLI/docs table rows verified against the current tree at impl.
- Relative links stay relative (npm rewrites them against the repository field).
- No AI attribution in commits. Conventional commits; branch `docs/readme-github-first` in
  worktree `worktrees-manual/readme-github-first`; full quality gate before the PR; PR opened
  for the maintainer's merge — never merged autonomously.

## Out of scope

Any other repo file (docs/, CHANGELOG, package.json). Any release action. The junco-site repo.
