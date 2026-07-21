# TUI Unified View — Kill the GITHUB/LOCAL Toggle — Design

**Date:** 2026-07-20
**Status:** approved (rail row union; system group in the rail; RepoDetail body; uiMode axis removed)

## Goal

Collapse the dashboard's two top-level modes (GITHUB / LOCAL, the `uiMode` axis
from the 2026-07-09 dashboard-local-mode design) into **one view**. The rail
becomes the single navigation spine: it lists every repo junco knows about —
github-linked and local-only — with a pinned `system` group (queue, outbox,
worktrees, daemon, logs) below. The body follows the rail cursor. The `m` /
Shift+Tab toggle, the header tab pair, and the parallel LOCAL input/hint
systems are deleted.

Locked scope decisions (from the maintainer):

- **Kill the toggle entirely** — no uiMode axis survives; the machine-level
  sections get homes in the single view.
- **System group in the rail** — repos on top, `system` rows pinned below
  (absorbing today's queue card). Selecting a system row renders that
  section's body where issues/PRs normally go. `t` becomes an alias.
- **RepoDetail body for local-only repos** — path/source/origin, branch@sha,
  dirty, repo-scoped worktrees, recent queue activity. The same panel is
  reachable for github-linked repos (enter / click-again on the rail row) —
  one component, two entry points.
- **Approach A** — rail row discriminated union + key-anchored selection;
  section components reused as body arms; single input cascade.

## Background facts the design relies on

Verified against the tree at design time (signposts — re-confirm at
implementation):

- `src/tui/App.tsx` (~2,909 lines) holds the whole `uiMode` axis: state
  cluster (`uiMode`, `localSection`, `localFocus`, `localCursor`,
  `localCheap`, `localHeavy`, `localRefreshedAt`), the layer-3 mode toggle
  (`canToggleMode` / `isModeToggle` / `handleModeTab`), the LOCAL dispatch
  (`handleLocalInput`), LOCAL mouse handlers (`localSectionPress`,
  `localRowPress`), LOCAL branches of the footer-actions map, hints ternary,
  and render tree.
- `src/tui/geometry.ts` exports `UiMode` and `QUEUE_CARD_ROWS = 6`;
  `railListHeight = bodyRows - 4 - QUEUE_CARD_ROWS`.
- `src/tui/components/Rail.tsx` renders watched repos (badges via
  `COUNT_ORDER`, pinned `ASSESS_COL = 8` assess column) + the queue card.
- `src/tui/components/LocalDashboard.tsx` holds `SectionRail`,
  `sectionBadge`, `OutboxSection`, `ReposSection`, `WorktreesSection`,
  `DaemonSection`, and the default `LocalDashboard` composition.
- `src/tui/localSnapshot.ts`: `collectRepoCandidates` unions config repos,
  RAW watchlist, `externalReposRoot` walk, `<dataDir>/clones/watched` walk,
  **deduped by `resolve(path)`** (first source wins). `buildRepo` enriches
  with origin/fork URLs, branch, headSha, dirty (`--no-optional-locks`,
  pool 4, never-throws). `enumerateWorktrees` rows carry
  `repoPath`/`repoNwo` (reverse-mapped discriminator).
- `src/tui/queueSnapshot.ts` rows (`QueueRunning`/`QueueWaiting`/
  `QueueRecent`) carry `github: TicketGithub | null` but **no repo path** —
  RepoDetail's recent-tickets list needs an additive `repoPath` field
  (parseTicket already reads the ticket's `repo:`).
- `src/ticketSchema.ts`: `repo:` is an absolute path; `github:` provenance is
  optional — tickets can target repos with no GitHub linkage, so local-only
  repos legitimately have queue history.
- `src/dashboardCmd.ts:120-121` wires `initialUiMode: c.github.enabled ?
"github" : "local"` and `githubEnabled`.
- `src/tui/components/Chrome.tsx`: `Header` renders the fixed-width tab pair;
  `hintsFor` (github) and `localHintsFor` (LOCAL) are parallel hint systems.
  `HelpModal` takes `uiMode`/`localSection`.
- The `"queue"` View (`t`) is a full-width read-only QueueView next to the
  rail — precedent for full-width bodies (the body slot flexGrows when pane 3
  is absent).
- Open-PR survey at design time: none open — no collision risk.

## 1 — Data model: the rail row union

```ts
type SystemSection = "queue" | "outbox" | "worktrees" | "daemon" | "logs";
// LocalSection minus "repos" (absorbed by the rail itself)

type RailRow = { kind: "repo"; repo: UnifiedRepo } | { kind: "system"; section: SystemSection };

interface UnifiedRepo {
  key: string; // nwo.toLowerCase() when linked, else resolved path
  nwo: string | null; // null → local-only row
  path: string; // every source (config/watchlist/heavy walk) carries one
  fromConfig: boolean;
  external: boolean;
  source: "config" | "watchlist" | "external" | "clone";
  watched: boolean; // in config ∪ watchlist (repoMappings)
  git: {
    // heavy-poll enrichment; null until first heavy tick
    branch: string | null;
    headSha: string | null;
    dirty: boolean | null;
    originUrl: string | null;
    error: string | null;
  } | null;
}
```

Derivation: start from `repoMappings` (config ∪ watchlist, nwo-keyed, config
wins — unchanged memo), attach git enrichment from `localHeavy.repos` matched
by resolved path then nwo; append heavy candidates matching no watched entry
as local-only rows. Dedupe: nwo (case-insensitive) for linked repos, resolved
path for the rest. Extra same-nwo paths (e.g. a stray managed clone of a
watched repo) collapse into the watched row and surface as "clones" lines in
RepoDetail. Ordering: watched repos first (config then watchlist, current
order), then discovered rows stable by path. The five system rows append
after the repos in the flat row list.

**Selection is key-anchored:** `railSel: string | null` (`"acme/api"`,
`"/Users/x/dev/scratch"`, `"sys:queue"`), resolved to an index each render
with the established clamp-to-last-slot fallback (`lastIdxRef` pattern). A
bare index would land on a system row whenever the heavy poll discovers a new
clone mid-session. `repoIdx`/`repoIdxSafe` die; `currentNwo` derives from the
selected row (`kind === "repo" && repo.nwo`).

## 2 — Rail rendering

Repos block on top, windowed via `windowSlice` exactly as today. Row format:

- nwo rows: unchanged — nwo, `(cfg)` tag, lifecycle badges (`COUNT_ORDER`),
  pinned assess column.
- local-only rows: path tail (`truncStart`), dim source tag (`(ext)` /
  `(clone)` / `(local)`), no badges, blank assess column.

Pinned below the repo window: separator, `system` header row, five system
rows with live badges from the existing `sectionBadge` logic (`queue ▸n`,
`outbox ⇡n`, `worktrees ⚑n`, `daemon ●/○`, logs unbadged). Gate-paused shows
on the queue row (`⚠` suffix). This **replaces the queue card**; the
running-ticket + turns line moves behind the queue row (one keystroke away),
and the header's ◐/⏳ chips keep the counts at a glance — a deliberate,
documented trade.

`geometry.ts`: `QUEUE_CARD_ROWS` → `SYSTEM_BLOCK_ROWS = 7` (separator +
header + 5 rows); `railListHeight = bodyRows - 4 - SYSTEM_BLOCK_ROWS`. The
`UiMode` type is deleted.

## 3 — Body routing and input

`pane 1|2|3` survives (1 = rail, 2 = body, 3 = PRs). Pane 2's body follows
the selected rail row:

| Selected row                 | Pane 2 body                                  | Pane 3 (wide)       |
| ---------------------------- | -------------------------------------------- | ------------------- |
| repo w/ nwo, github enabled  | IssueList (unchanged incl. `/`, d/D/a/R/c)   | PR pane (unchanged) |
| repo w/ nwo, github disabled | RepoDetail                                   | — (body flexGrows)  |
| local-only repo              | RepoDetail                                   | —                   |
| queue                        | QueueView selectable (R requeue, x delete)   | —                   |
| outbox                       | OutboxSection (f flush)                      | —                   |
| worktrees                    | WorktreesSection (x prune)                   | —                   |
| daemon                       | DaemonSection ([/], X restart, f flush)      | —                   |
| logs                         | — (enter/→/click opens the overlay directly) | —                   |

**RepoDetail** (the one new component, `components/RepoDetail.tsx`):
identity (path, source, origin URL, extra clone paths), git state
(branch@sha, dirty ✎), repo-scoped worktrees (filter `enumerateWorktrees`
rows by `repoPath`), recent queue activity (rows whose new `repoPath` field
resolves to this repo). Scroll-only in v1 (`[`/`]` + wheel, `clampScroll`
posture like DaemonSection). For github-linked rows the same component opens
as a full-width `"repoDetail"` View via **enter or click-again on the rail
row** (esc/q back) — feature parity for the dying ReposSection. For
local-only rows (where pane 2 already IS RepoDetail) enter/click-again is a
no-op beyond focusing pane 2.

Queue snapshot change (additive): `QueueRunning`/`QueueWaiting`/`QueueRecent`
gain `repoPath: string | null` (parseTicket already reads `repo:`).

**Input merge.** One cascade; the pane-2 branch keys off body kind. The
per-section row cursors keep the `Record<section, number>` shape under a
rename (`sectionCursor`); `localRows`/`localCursorSafe`/`localTarget` carry
over with the union row list feeding them. Key changes:

- `m` / Shift+Tab / header tabs: **removed** (m regains its "no-op / types
  into filter" meaning).
- `t`: alias — sets `railSel = "sys:queue"` + pane 2. The `"queue"` View
  entry dies.
- Repo-only keys on system rows: `x`/`o`/`s` toast harmlessly. `o` on a
  local-only row toasts (no GitHub URL).
- Everything else keeps its meaning: q, ?, p, v, w, s, :, `,`, /,
  enter-detail, 1/2/3/tab/h/l pane movement. `r` always runs
  `forceLocalRefresh`, plus the gh `refreshAll` cycle when the selected row
  has an nwo and github is enabled.
- Destructive-action confirm modal, log overlay input ownership, and the
  layer-2 addRepo/config fences carry over unchanged.

`hintsFor`/`localHintsFor` merge into one `hintsFor(view, bodyKind, pane,
mode, filtering)`; the footer-actions map collapses the LOCAL branch into the
main switch, keyed the same way. `HelpModal` drops `uiMode`/`localSection`
and renders one unified key list.

## 4 — Data flow / polls

- **localCheap @3s and localHeavy @15s lose their `uiMode === "local"` gates
  and run always.** Cheap feeds system badges, header, and the
  queue/outbox/daemon bodies + RepoDetail recent tickets; heavy feeds
  local-only rail rows, the ⚑ worktree badge, and RepoDetail git state.
  Heavy stays bounded (pool 4, `--no-optional-locks`), first tick immediate
  so local rows appear at mount. The cheap `section` option gets the selected
  system section (or undefined).
- The known cheap-vs-`queueFn` redundancy (both snapshot the queue) is
  deliberately left as-is; consolidation is a follow-up issue.
- Issues/PRs polls unchanged, gated on `githubEnabled` && selected row has
  nwo; the monitor sweep gates on `githubEnabled`. The gh-error-toast gate
  (`uiModeRef`) becomes "an issues body is on screen" (ref over the derived
  body kind).
- `scrollKey` arms update: `repo:${key}` (RepoDetail), `sys:${section}`,
  `logOverlay`, plus the surviving view keys.
- `dashboardCmd`: drop `initialUiMode`; keep `githubEnabled`,
  `localCheapFn`/`localHeavyFn` (now ungated). No config schema change → no
  LEVERS entry.

## 5 — Deletions

`uiMode` state + `initialUiMode` prop + `geometry.ts UiMode`; the Header tab
block + `onModeTab`; `canToggleMode`/`isModeToggle`/`handleModeTab`; the
m/Shift+Tab binding; `handleLocalInput` (merged); `localHintsFor` (merged);
`localFocus` (pane axis covers it); the `"queue"` View; `LocalDashboard`
default component + `SectionRail` + `ReposSection`; `localSectionPress`; the
LOCAL branches of footer-actions/hints/render. Surviving section components
(`sectionBadge`, `OutboxSection`, `WorktreesSection`, `DaemonSection`)
relocate to `components/sections.tsx`; QueueView, LogView + overlay machinery
move over untouched.

## 6 — Error handling

All snapshot sources keep the never-throws + `error`-field posture. Toast
policy: gh failures toast only while an issues body is visible; local action
failures toast as today. `githubEnabled === false` needs no launch-mode
special case — nwo rows render RepoDetail, no gh poll fires, `w` toasts
"github disabled". Watchlist-corruption handling untouched.

## 7 — Testing

Rewrite the mode-toggle/LOCAL suites against the unified model rather than
patching them. New/rewritten coverage:

- Rail union rendering (nwo rows, local rows, system badges, windowing with
  the pinned system block).
- Key-anchored selection: heavy poll discovers a clone mid-session → cursor
  stays on its row; unwatch → clamp fallback.
- Body routing per row kind (all eight table rows above).
- RepoDetail: both entry points, worktree/ticket scoping, clones lines.
- `t` alias; removed-`m` regression (m types into filter, toggles nothing).
- github-disabled fallback (RepoDetail body, no gh polls, `w` toast).
- Mouse parity: rail row click / click-again → repoDetail; system row click;
  footer chips per body kind.
- `queueSnapshot` `repoPath` field.

AppProps changes ripple into every tui fixture — `npm run typecheck` catches
misses. Ink gotchas apply (loop-until-condition, no fixed-tick asserts).
Full gate before done. CHANGELOG: breaking TUI change → 0.9.0 (release
itself stays behind the maintainer's explicit approval).
