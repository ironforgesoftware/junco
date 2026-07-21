# Dashboard `o` Consistency + Clickable Detail Links — Design

**Date:** 2026-07-08
**Status:** Awaiting user review
**Branch:** `feat/tui-open-consistency` (off main, post-PR-#13/#18 merge)
**Release hold:** Do NOT push / tag / release / publish without explicit maintainer approval.

## Goal

Two small dashboard follow-ups to the TUI-nits work:

1. **One label for `o`.** The key does the same thing in every context — open the selected
   resource in the browser — but the footer hints label it three ways: `browser` (issue
   detail), `open` (PRs view, PR overlay, pane-3 monitor), `repo` (rail). Standardize on
   **`browser`** (maintainer-confirmed).
2. **Clickable `↗` in the detail views.** The issue detail view and the fullscreen PR overlay
   already render the `↗ owner/repo#n` metadata line (OSC 8 cmd+clickable, `o`-openable); make
   it a click target for the dashboard's own mouse layer too.

## Locked decisions

1. Label is `browser` at all five `hintsFor` sites: issue detail (unchanged), prs view,
   prDetail overlay, pane-3 monitor, rail. The rail's repo-page nuance moves to the help
   modal's `o` row: "open in browser (repo from pane 1, PR from PR views)".
2. Approach A for clicks: `src/tui/hitTest.ts` extends its `view` union with
   `"detail" | "prDetail"` — geometry stays in the one tested module; NO inline coordinate
   math in App.tsx.
3. Click targets are snapshot-anchored: the detail view opens `detail.issue` (the frozen
   snapshot, same as its keyboard `o`), the overlay opens `prDetail.pr` — a re-sorting poll
   can never make the click open a different resource than the one on screen.
4. No `Config` changes, no new dependencies.

## Part 1 — label standardization

- `src/tui/components/Chrome.tsx` `hintsFor`: `["o", "open"]` → `["o", "browser"]` in the
  `prs` and `prDetail` cases and the pane-3 list; `["o", "repo"]` → `["o", "browser"]` in the
  pane-1 list. The detail case already reads `["o", "browser"]`.
- `src/tui/components/HelpModal.tsx`: the "act on issue" row becomes
  `["o", "open in browser (repo from pane 1, PR from PR views)"]`.
- `docs/dashboard.md`: the `o` keys-table row gains the PR-overlay/PR-views mention so prose
  matches the uniform footer.
- Tests asserting the old labels (`tuiChrome`, `tuiModal`, any footer-string waits in
  `tuiApp`) update to follow the behavior.

## Part 2 — clickable ↗ in detail + prDetail

**Geometry (verified):** both views render in the middle slot; the rail stays visible on the
left and no right pane renders (`layout.mode === "wide"` right-pane block returns null for
these views), so the middle band spans `[railWidth, columns)`. Both cards place the ↗ line at
pane-relative row `LINK_LINE_ROW` (3) → absolute screen row 4: Preview renders it directly
under the heading; PrPreview carries it as `rows[1]`, which survives `maxRows` slicing at any
usable height.

**hitTest** (`src/tui/hitTest.ts`):

- `HitContext["view"]` becomes `"main" | "prs" | "detail" | "prDetail"`.
- For the two new views: `x < railWidth` → `none` (the rail is not interactive while a
  detail view is open — matches the keyboard model, where these views capture all input);
  middle band with `r === LINK_LINE_ROW` → `{ type: "linkLine" }`; everything else → `none`.
  The list-count/window fields are not read on this path.

**App** (`src/tui/App.tsx` `onMouseEvent`):

- `prDetail` leaves the ignore list. New routing:
  - `queue` / `cmdOutput`: wheel scrolls, presses have no targets (unchanged).
  - `detail`: wheel scrolls (unchanged); a press runs `hitTest` and `linkLine` opens the
    SNAPSHOT issue (`client.openInBrowser(currentNwo, detail.issue.number)` — the same call
    the view's keyboard `o` makes; extract the shared callback so the two stay one code path).
  - `prDetail`: no wheel action (nothing scrolls); a press runs `hitTest` and `linkLine`
    opens `prDetail.pr` via `client.openPrInBrowser` (same shared-callback treatment).
- Failures toast through the existing `Result` path; no new error surface.

## Testing

- **hitTest units:** for each new view — ↗ row in the middle band resolves `linkLine`; the
  same row in the rail band is `none`; other rows/bands are `none`; tooSmall is `none`.
- **App integration (ink-testing-library, bounded until-loops):** open the issue detail via
  keyboard, click the ↗ row (1-based `y=5`, `x≥28`), assert the recorded `openInBrowser`
  call carries the snapshot's number; mirror test for the PR overlay and `openPrInBrowser`.
- **Label tests:** footer/help assertions updated to the uniform `browser` label.
- Full gate before every commit: `npm run lint && npm run format:check && npm run typecheck
&& npm run build && npm test`.

## Out of scope

- Clickable links in the queue / command-output views (no resource metadata there).
- Any change to what `o` does — labels and click routing only.
