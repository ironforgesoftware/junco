# TUI Dashboard Polish — Design

Date: 2026-07-20. Follows the unified view (2026-07-20-tui-unified-view-design.md)
and mnemonic shortcuts (2026-07-20-tui-mnemonic-shortcuts-design.md).

## Goal

Declutter and stabilize the dashboard: drop pane-number labels and hotkeys,
remove the daemon dot, relocate the refresh stamp, freeze column geometry
against selection changes, give lists real table headers, fill the top bar
with useful live metrics, and highlight bot-authored issues/PRs.

## Decisions (user-confirmed)

- ↻ refresh stamp: **daemon detail panel only** (not the top bar, not the rail).
- Top-bar additions: **24h record + rate, live run + ETA, health warnings**
  (spend explicitly excluded).
- Third column: **always reserved in wide mode**; system rows show an
  **activity card**, local repos a dim note.
- Table structure: list headers get **bold/color/cell** treatment — a styled
  column-header row aligned with fixed-width data columns.
- New header chips are driven from `localCheap.queue.stats` (`QueueStats`) —
  no new fetches, one source of truth. Extending `ghClient.HealthInfo` for
  stats was rejected (duplicate parse of the same /health body, no ledger).
- Component richness (user-directed expansion): build an in-house primitives
  kit and adopt richer UI elements across the dashboard (§6–§7).

## Research: modern TUI patterns → junco

Surveyed: lazygit/btop (persistent multi-panel, fixed geometry), k9s
(drill-down + breadcrumb orientation, tables with header rows and status
pills), gh-dash (columnar PR/issue tables, state badges), btop/glances (stat
cards, gauges, sparklines), Textual's widget set (DataTable, Sparkline,
ProgressBar, Rule, scrollable viewports with visible scrollbars) and the Ink
ecosystem (`@inkjs/ui`: Spinner/ProgressBar/Badge/StatusMessage/Alert +
input kit).

Mapping onto junco: fixed geometry → §3 reserved slot; breadcrumbs → §2
header trail; tables + pills → §§3–4; stat cards/sparklines/gauges →
ActivityCard + DaemonSection (§§3, 7); visible scrollbars → §6 Scrollbar;
dialog buttons → §7 confirm upgrade.

**Build vs buy:** primitives are built in-house rather than adopting
`@inkjs/ui`. Reasons: junco already owns a Spinner (precedent), the theme
system (`theme.ts`, NO_COLOR discipline, chalk downsampling) would fight
`@inkjs/ui`'s context-based theming, deps are exact-pinned and audited, and
the needed surface is ~7 small pure components. No new dependencies.

## 1. Declutter

**Pane titles** (digit prefixes deleted):

| Surface                           | Before                | After               |
| --------------------------------- | --------------------- | ------------------- |
| `UnifiedRail`                     | `1 repos`             | `repos`             |
| `IssueList`                       | `2 issues · 12`       | `issues · 12`       |
| pane-3 monitor (`App.pane3Title`) | `3 PRs · acme/reef`   | `PRs · acme/reef`   |
| `PrList` standalone default       | `p pull requests · N` | `pull requests · N` |

**Hotkeys**: the `input === "1" / "2" / "3"` branches in App's main handler are
deleted. Kept: `←`/`→`, `h`/`l`, `tab` cycling, and the `i`
jump-to-issues alias (structural, already excluded from mnemonic derivation).
HelpModal's `["1/2/3", "jump pane directly …"]` navigate row is deleted; the
`←/→ · h/l · tab` row stays.

**Daemon dot** (both sites):

- Header chip: `daemon ● up 2h13m` / `daemon ○` → `daemon up 2h13m`
  (success color) / `daemon down` (warn color). Same `fmtUp` text, no glyph.
- Rail system row badge (`sectionBadge` case `"daemon"`): `●`/`○` → `up`/`down`.

**↻ stamp**: removed from `Header` (prop `refreshedAt` deleted). The daemon
detail panel (`DaemonSection`) gains a `refreshed` line — `↻ 32s ago` via the
existing `relTimeShort`, labeled as the GitHub-data refresh cycle (it is the
unified refresh stamp, not the daemon poll). `DaemonSection` gains
`refreshedAt: string | null` and `now: Date` props; `null` renders `—`.

## 2. Top bar

Right-side pulse, one row, order left→right. Conditional chips render nothing
in their resting state.

| Chip              | Source                                                                                  | Visibility                                             |
| ----------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `⬆ v0.9.1`        | updateLatest (unchanged)                                                                | wide, when newer                                       |
| `watchlist!`      | unchanged                                                                               | any, on error                                          |
| `gate ⚠ <reason>` | `stats.gate` when `state !== "ok"` (reason truncated ~16)                               | **all modes**, warn color                              |
| `restart pending` | `stats.pendingRestartFields.length > 0`                                                 | **all modes**, warn color                              |
| `bridge ✗N`       | health (unchanged)                                                                      | wide, when > 0                                         |
| `●N review`       | unchanged                                                                               | any, when > 0                                          |
| `⚑N PR`           | unchanged                                                                               | any, when > 0                                          |
| `24h ✓12 ✗1 92%`  | `stats.window24h` (rate omitted when `successRate` null)                                | wide; hidden when no ledger rows (`done+failed === 0`) |
| `last ✓ 2m`       | health (unchanged)                                                                      | wide                                                   |
| `▸ fix-login`     | first running ticket id (`stripStamp`ped, truncated ~20; `+N` suffix when more running) | any, when running                                      |
| `eta 8m`          | `stats.etaSeconds`                                                                      | wide, when waiting > 0 and eta non-null                |
| `daemon up 2h13m` | health (dot removed, §1)                                                                | any                                                    |
| `◐N ⏳N`          | queue snapshot (unchanged)                                                              | any, when > 0                                          |
| `⇡N unpushed`     | outbox depth (unchanged)                                                                | any, when > 0                                          |

Dropped chips: since-restart `✓N ✗N` (superseded by 24h record — restart
resets made it misleading), lifetime `tok` (24h tokens live in the activity
card), `↻` stamp (§1). Layout invariant unchanged: repo name is the only
flexible element; the chip group stays `flexShrink 0`, overflow truncates the
repo name first.

New `Header` props: `stats: QueueStats | null`, `runningIds: string[]`
(display ids, already stripped). Deleted props: `refreshedAt`. `queueRunning`
stays (the `◐` count).

## 3. Stable columns

**Reserved third slot (wide mode).** The pane-3 box at `layout.previewWidth`
renders for **every** main-view body, not only `body.kind === "issues"`:

- issues body (watched repo): PR monitor, unchanged.
- section body (system row selected): **`ActivityCard`** (new component):
  - title `activity`
  - `7d` row: per-day bars from `stats.perDay7d` (`▁▂▃▄▅▆▇█` scaled to the
    week's max done+failed; zero-task days render `▁` dim), plus `✓total ✗total`
  - `24h` row: `✓12 ✗1 · 92%` (`window24h`, rate omitted when null)
  - `avg` row: `avg 6m · tok 1.2m` (`avgDurationSeconds` via `fmtDurShort`,
    `tokensOut` via `fmtCompact`; each omitted when null)
  - `cost` row: `$3.20` (`costUsd`, omitted when null)
  - `stats === null` → dim `no history yet`.
  - Border/title/focus conventions identical to the other panes; never
    focusable (pane cycling still tops out at 2 on non-issue bodies —
    `maxPane` logic unchanged).
- repoDetail body (local repo selected): reserved pane with dim
  `local repo — no linked PRs`.

Full-screen views (`repoDetail` via enter, `prs`, `review`, overlays) are
whole-body swaps, not selection-driven — unchanged.

**Columnar lists.** IssueList and PrList rows become fixed-width columns
shared with the new header row (§4):

- IssueList: `▌`(1) · state glyph(1) · `#num` right-aligned(5) ·
  title(flex, truncate) · state badge(fixed = longest `stateMeta` badge,
  computed from the meta table at module scope) · age(right-aligned 4 —
  `relTime` can emit `365d`).
- PrList: `▌`(1) · glyph(1) · `#num`(5) · title(flex) ·
  repo(when `showNwo`: width = max nwo length over current rows, capped
  `NWO_MAX_WIDTH`, truncate-start) · checks(width = max checks string over
  current rows, min 2) · state badge(fixed, from `prStateMeta` table) ·
  age(right-aligned 4).

Widths derive from the meta tables (constants) or the current dataset — never
from the selected row, so selection cannot shift columns.

## 4. Table headers

New shared helper (`src/tui/components/tableHeader.tsx`): renders a
full-width header strip — labels **bold**, accent color, on the
`theme.hoverBg` background (NO_COLOR/no-bg terminals degrade to bold text) —
with each label padded to its column width from §3.

- IssueList header: blank(2) · `#`(5, right) · `title`(flex) · `state` · `age`.
- PrList header: blank(2) · `#`(5, right) · `title`(flex) · [`repo`] ·
  [`checks`] · `state` · `age` (bracketed cells only when the column renders).
- QueueView group headers (`running` / `waiting` / `recent —`) and the
  RepoDetail/DaemonSection section headers adopt the same strip styling
  (bold + accent + bg) without columnization — cohesion, not tables.

The header row costs one content row per list; windowing math
(`listRowsHeight`, pane-3/PR list slicing) adjusts by −1 accordingly.

## 5. Bot-authored highlighting

- `DashPr` already carries `author` (no fetch change). `DashIssue` gains
  `author: string | null`; `listIssues` adds `author` to its `--json` field
  list (`.author.login`). Cached issue entries written before this change
  parse to `null` → no highlight until the next fresh fetch. Additive — no
  cache-format break.
- Bot login resolution: when `cfg.botAccount.enabled`, resolve once, lazily,
  via `gh api user --jq .login` with `GH_CONFIG_DIR` pointed at
  `cfg.botAccount.configDir` — the doctor's existing probe shape, extracted
  into a new shared `src/botIdentity.ts` exporting
  `resolveBotLogin(cfg, deps): Promise<string | null>` (injectable exec seam;
  doctor keeps its own probe — refactoring it onto the helper is optional and
  out of scope). Failure or disabled → `null` → feature inert. The login is
  fetched off the render path and cached for the session.
- Rendering: rows whose `author` equals the bot login render their `#num`
  cell in accent color (instead of dim). Applies to IssueList, PrList (both
  variants). HelpModal legend gains one line: accent `#` = opened by the
  junco bot.

## 6. Component kit (`src/tui/components/primitives/`)

Each primitive is a pure, themed component with an exported pure
string/segment builder (the `chipSegments` pattern) so tests assert structure
without ANSI. NO_COLOR degradation noted per primitive.

- **`Badge`** — state pill: `label` on a semantic `backgroundColor` with
  black text; `padTo` prop pads the label so pill columns align. NO_COLOR →
  bare label text (chalk strips bg), same width.
- **`Gauge`** — `▰▰▰▱▱▱` fill bar: `value/max` → filled cells over `width`,
  optional trailing label (`23m/45m`). `value === null` → all-track dim bar.
  Glyph pair carries meaning colorlessly.
- **`Sparkline`** — wraps the existing `fmtSpark` bars with an optional
  accent color; dim when all-zero.
- **`Rule`** — titled divider `── title ─────────` (bold title, dim line);
  replaces the rail's bare `─…` separator and sections detail panels.
- **`Scrollbar`** — right-edge vertical track (`│` dim) with a proportional
  thumb (`█`); props `{offset, viewport, total, height}`. Hidden when
  `total <= viewport`.
- **`StatRow`** — aligned key/value line for detail panels: dim label column
  (fixed width per panel), bold value, optional dim hint suffix.
- **`Button`** — `[ y confirm ]` chip: bracketed label with the key in
  accent, `tone: "danger" | "neutral" | "primary"` background; clickable via
  `ClickableBox`. NO_COLOR → brackets + bold key.
- **`TableHeader`** — the §4 column-header strip (lives in primitives/).

## 7. Component adoption

- **Lists (§3/§4)**: state cells become `Badge` pills (fixed `padTo` from the
  meta tables); both lists gain `TableHeader` strips.
- **QueueView**: group headers (`running`/`waiting`/`recent`) restyle as
  header strips; each running row gains a time-budget `Gauge` (elapsed since
  `startedAt` vs the configured task timeout) under its progress line — the
  determinate data /health actually has. Phase-index progress needs a daemon
  change → out of scope, noted as future.
- **DaemonSection**: restyled as a `StatRow` grid (state, uptime, tasks,
  tokens, cost, endpoint, `refreshed` line from §1) with `Rule` section
  dividers, the gate as a `Badge`, and — when a daily budget is configured —
  a spend `Gauge` (`todayUsd/dailyBudgetUsd`). (§2's "no spend chip" applies
  to the top bar only; the daemon panel is its detail home.)
- **RepoDetail**: section headers restyle as `Rule`s; key/value lines adopt
  `StatRow`.
- **Scrollbar adoption**: Preview, PrPreview, CommandOutput, LogView
  (overlay variant), DaemonSection, RepoDetail — every pane that already
  tracks `scroll`/`onScrollMax`.
- **Confirm modal**: the `y/enter confirm · n/esc cancel` hint line becomes
  two `Button`s (`[ y confirm ]` danger-toned when `confirm.danger`,
  `[ esc cancel ]` neutral), mouse-clickable, keyboard behavior unchanged.
- **Header (§2 addendum)**: the right-side pulse groups its chips with dim
  `│` separators — warnings │ record (`24h`, `last`) │ live (`▸ run`,
  `eta`) │ system (`daemon`, `◐⏳`, `⇡`). The left cell becomes a breadcrumb
  trail (`crumbs: string[]` joined with dim `▸`): main view `acme/reef`;
  issue detail `acme/reef ▸ #124`; PR detail `acme/reef ▸ PR #86`; system
  body `system ▸ queue`; full-screen views their name (`pull requests`,
  `review`). Replaces the bare `repoNwo` prop.

## 8. Tests & docs

- Retarget existing assertions on `1 repos` / `2 issues` / `3 PRs` /
  `p pull requests` titles and the digit hotkeys.
- Every primitive ships with unit tests over its pure builder (Badge padding,
  Gauge fill math incl. null/zero/overflow, Sparkline scaling, Scrollbar
  thumb geometry, Button segments, Rule width, TableHeader cells).
- New behavior tests: ActivityCard rendering (bars/degenerate stats/null),
  reserved-slot presence across body kinds (issues/section/repoDetail select
  → middle pane width constant), fixed badge/checks column widths,
  bot-highlight cell color (structural), daemon-panel `refreshed` line +
  StatRow grid, header chip set and grouping (24h/run/eta/gate/
  restart-pending visibility rules), breadcrumb composition per view,
  confirm-modal buttons (click + keyboard parity), QueueView running-row
  gauge, removed digit hotkeys no-op.
- Docs: `docs/dashboard.md` (top-bar chip table, third-column behavior,
  headers, primitives glossary, bot highlight), `ARCHITECTURE.md` tui row if
  the component list changes, CHANGELOG entry under the pending 0.9.0 block.

## Out of scope

- Spend/budget chip in the top bar (explicitly declined; daemon panel gauge
  is in, §8).
- QueueView columnization (narrative view; header styling + gauge only).
- Any daemon/health endpoint changes — the TUI consumes existing fields
  only. Future: a phase-index field in `currentProgress` would upgrade the
  running-row gauge from time-budget to phase progress.
- Detail views (Preview/PrPreview) content redesign (they gain scrollbars
  only).
- New dependencies (`@inkjs/ui` evaluated and declined — see Research).
