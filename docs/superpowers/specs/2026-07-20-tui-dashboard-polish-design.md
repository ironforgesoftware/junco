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

- `DashIssue` and `DashPr` gain `author: string | null`; `listIssues`/
  `listPrs` add `author` to their `--json` field lists (`.author.login`).
  Cached entries written before this change parse to `null` → no highlight
  until the next fresh fetch. Additive — no cache-format break.
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

## 6. Tests & docs

- Retarget existing assertions on `1 repos` / `2 issues` / `3 PRs` /
  `p pull requests` titles and the digit hotkeys.
- New: ActivityCard rendering (bars/degenerate stats/null), reserved-slot
  presence across body kinds (issues/section/repoDetail select → middle pane
  width constant), header-strip segments (structural helper tests — frames
  strip ANSI), fixed badge/checks column widths, bot-highlight cell color
  (structural), daemon-panel `refreshed` line, header chip set (24h/run/eta/
  gate/restart-pending visibility rules), removed digit hotkeys no-op.
- Docs: `docs/dashboard.md` (top-bar chip table, third-column behavior,
  headers, bot highlight), `ARCHITECTURE.md` tui row if the component list
  changes, CHANGELOG entry under the pending 0.9.0 block.

## Out of scope

- Spend/budget chip (explicitly declined).
- QueueView columnization (narrative view; styling only).
- Any daemon/health endpoint changes — the TUI consumes existing fields only.
- Detail views (Preview/PrPreview) styling.
