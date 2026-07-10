# Dashboard LOCAL Mode — Two-Mode Actionable Local Visibility — Design

**Date:** 2026-07-09
**Status:** approved (uiMode axis; sectioned local dashboard; actionable via spawned CLI; worktree prune behind a shared daemon lock)

## Goal

Give `junco dashboard` a first-class **local runtime** surface alongside its
GitHub surface. Today the whole TUI is "a GitHub client" — watched repos,
issues, PRs — with local state leaking in only through the `t` queue view and a
rail card. This adds a second top-level mode, **LOCAL**, that shows and *acts on*
the machine-local runtime: the four queue directories, the GitHub offline
outbox op-log, the repos/clones/forks junco knows about and **where they live on
disk**, the per-ticket worktrees, and the daemon/health detail. A persistent
header tab pair (`GITHUB │ LOCAL`) plus a hotkey swap between the two modes.

Locked scope decisions (from the maintainer):

- **Levers surfaced (v1):** queue dirs + repo/clone/fork paths & links (core),
  plus **Worktrees**, the **GitHub outbox op-log**, and **Daemon & health
  detail**. Locks/pidfile and orphan surfacing are deferred (future lever).
- **Stance: actionable.** LOCAL exposes inline *mutating* actions (requeue a
  failed ticket, delete a queued ticket, flush the outbox, prune a stale
  worktree, restart the daemon) — a deliberate departure from the read-only
  north-star, reconciled by §"Action model & daemon safety".
- **Layout: sectioned dashboard** — a section rail (Queue / Outbox / Repos /
  Worktrees / Daemon) with the selected section rendered in the body. The
  existing `t` queue view folds in as the Queue section.
- **Swap: two-mode with header tabs** — a `uiMode` axis above `View`, toggled by
  **`m`** (alias Shift+Tab, plus clickable header tabs).
- **v1 defaults:** "add repo" stays a GitHub-mode action (dropped from LOCAL);
  the dashboard launches into LOCAL mode when `github.enabled` is false.

## Background facts the design relies on

Verified against the current tree (line numbers checked at design time; treat as
signposts, re-confirm at implementation).

- **One stateful component.** `src/tui/App.tsx` (~1,589 lines) is the only
  stateful component; every other TUI module is near-pure. Navigation is a
  `useState<View>` string-union machine (`App.tsx:77-86`:
  `main|detail|help|addRepo|palette|cmdOutput|queue|prs|prDetail`) plus one
  `useInput` cascade (`:1059-1324`) and one `onMouseEvent` (`:1326-1431`). No
  router, no reducer.
- **`main` IS the GitHub surface.** There is no `"github"` constant; `main`
  renders the repo rail + issues + PR panes. `pane:1|2|3` (`:72,219`) is a
  second axis *within* `main`.
- **The Rail renders above the body ternary** (`:1493`), so it shows in every
  view; the body ternary (`:1502-1587`) swaps the middle slot by `view`.
- **Existing local precedent.** `t` → `QueueView.tsx` is a read-only windowed
  scroll view over `QueueSnapshot`, fed by `makeQueueSnapshotFn(cfg, deps)`
  (`src/tui/queueSnapshot.ts:81-251`) which reads inbox/processing/done/failed +
  `/health` progress + outbox depth. Deps-injectable
  (`readdir/readFile/stat/fetch/now`), never-throws + `error` field. Polled @2s
  (`App.tsx:623-637`).
- **`mode` is already taken.** `Header` and `HelpModal` take `mode: LayoutMode`
  (`"wide"|"medium"|…`), tested directly (`tuiChrome.test.tsx:59,84,105,123`),
  wired at `App.tsx:1457`. The new axis therefore must **not** reuse `mode` — it
  is named **`uiMode`** end-to-end.
- **Wiring point.** `src/dashboardCmd.ts runDashboard` (`:64-79`) constructs the
  gh client, `makeQueueSnapshotFn`, `clonesDir = join(stateDir, "repos")`
  (`:75`), and injects them as `<App>` props. It **refuses to launch when
  `github.enabled` is false** (`:35`) and enforces the non-TTY guard (`:24`).
  Dashboard modules are lazily imported (`Promise.all`, `:43-57`) so `react`/the
  Pi SDK never enter the module graph until `junco dashboard` runs.
- **"Outbox" is not a queue dir.** `queuePaths(cfg)` (`src/config.ts:357`) has
  only inbox/processing/done/failed. The only "outbox" is the **GitHub
  store-and-forward op-log** under `<stateDir>/github-outbox/` (`githubOutbox.ts`)
  — one JSON file per deferred gh side-effect, drained by `junco outbox flush`,
  poison ops dead-lettered to `.../dead/`.
- **Daemon is the single writer** of `processing/` and `worktreeRoot`.
  `claimNextTask` (`runOnce.ts:74`) claims inbox→processing by **atomic rename**
  (`queue.ts:28`). `requeueTicket` (`requeue.ts:59-82`) moves processing→inbox
  atomically. Worktree provisioning/cleanup/prune (`worktree.ts`
  `prepareWorktree`/`cleanupWorktree`/`pruneStaleWorktrees`) take **no lock** —
  safe today only because a singleton daemon is the sole mutator. `worktreeRoot`
  is daemon-owned; junco force-removes paths there (CLAUDE.md).
- **No external per-ticket kill.** SIGTERM/SIGINT hit the whole daemon
  (`daemon.ts:119-137`); the supervisor's kill is in-process. There is no
  mechanism to kill one running ticket from outside → the coarsest safe control
  is `junco restart`.
- **The `:` palette spawns the real CLI** (`cliRunner.ts runCliCommand` +
  `PALETTE_COMMANDS`) — "no reimplementation, no drift." Existing subcommands:
  `retry` (`retryCmd.ts`), `outbox` (`outboxCmd.ts`), `restart`
  (`restartCmd.ts`), plus list/submit/logs/service.

## Mode architecture

### The `uiMode` axis (above `View`)

```ts
type UiMode = "github" | "local";
const [uiMode, setUiMode] = useState<UiMode>(initialUiMode); // prop; default "github"
```

`View` is untouched and only meaningful when `uiMode === "github"`. LOCAL owns a
small state cluster:

```ts
type LocalSection = "queue" | "outbox" | "repos" | "worktrees" | "daemon";
const [localSection, setLocalSection] = useState<LocalSection>("queue");
const [localFocus, setLocalFocus]     = useState<"rail" | "body">("rail");
const [localCursor, setLocalCursor]   = useState<Record<LocalSection, number>>({...});
const [localScroll, setLocalScroll]   = useState(0);          // daemon panel scroll
const [confirm, setConfirm]           = useState<ConfirmState | null>(null);
const [localCheap, setLocalCheap]     = useState<LocalCheap | null>(null);
const [localHeavy, setLocalHeavy]     = useState<LocalHeavy | null>(null);
```

### GitHub mode stays byte-for-byte unchanged

The `useInput` cascade is **wrapped, not edited**. Layer order is load-bearing:
the text-owning surfaces are hoisted *above* the mode split so they run in either
mode (this is what prevents a stranded text field in LOCAL).

```ts
useInput((input, key) => {
  if (isMouseInput(input)) return;                               // 1 (keep first)
  if (view === "addRepo") { handleAddRepoInput(input, key); return; }  // 2 text
  if (view === "palette") { handlePaletteInput(input, key); return; }  // 2 text
  if (canToggleMode() && isModeToggle(input, key)) {             // 3 toggle
    setUiMode((m) => (m === "github" ? "local" : "github")); dismissToast(); return;
  }
  if (uiMode === "local") { handleLocalInput(input, key); return; }    // 4 local
  /* 5 ── existing github cascade, verbatim from :1064 onward ── */
});
```

`canToggleMode()` is false while `filtering`, `view ∈ {addRepo, palette}`, or a
`confirm` modal is open, so the toggle key can never eat a typed character.

Render branches once, at the Workspace children:

```tsx
<Workspace header={<Header uiMode={uiMode} githubEnabled={githubEnabled} .../>}
           modal={modal /* + confirm */}>
  {uiMode === "local"
    ? <LocalDashboard cheap={localCheap} heavy={localHeavy} section={localSection}
        focus={localFocus} cursor={localCursor[localSection]} scroll={localScroll}
        layout={layout} now={queueNow}/>
    : <><Rail .../>{/* existing body ternary, unchanged */}</>}
</Workspace>
```

`<Rail>` is scoped inside the GitHub fragment; LOCAL substitutes its own
`SectionRail` inside `LocalDashboard`.

### Toggle key (resolved)

Tab is bound to pane-cycle (`:1223`) and `[`/`]` are scroll aliases — both
rejected. **Canonical: `m`** (mnemonic *mode*), genuinely unbound, testable as a
literal byte, bound in layer 3 in both modes, intentionally reserved from ever
becoming a GitHub key. **Alias: Shift+Tab** — `isModeToggle` for the Tab path
**requires `key.shift`** so a bare Tab still reaches pane-cycle. **Mouse:** the
header tabs (below).

### esc / q semantics

- **github:** unchanged (`q` quits only from `main`; esc backs out).
- **local:** `confirm` open → esc/`n` cancel, `y`/enter confirm (input routes to
  the confirm handler only). `focus==="body"` → esc/`h`/← returns to the section
  rail (mirrors GitHub pane-3 `esc → setPane(2)`). `focus==="rail"`, no modal →
  `q` quits, esc is a no-op. **esc never crosses modes** — crossing is only via
  `m` / Shift+Tab / header click.

### Header tabs + clickable region (live in every view)

`Header` gains `uiMode` + `githubEnabled` and renders a leading `flexShrink={0}`
tab segment after the brand mark. **NO_COLOR:** the active tab is marked by
**brackets** (which survive SGR stripping), reinforced by accent —
`[GITHUB] local` ↔ `github [LOCAL]` — never color+bold alone. **60-col budget:**
below `WIDE_COLS` the tab collapses to a single-letter compact form (`[G] l` /
`g [L]`) and folds into the existing chip-drop logic (`Chrome.tsx:107-126`); it
does not rely on repo-name slack. A `columns=60` Header test with a full medium
chip set asserts `height===1`, no wrap.

Clickability must not depend on the per-view hit-test body logic (whose
`HitContext.view` covers only `main|prs|detail|prDetail`). Resolve the header
band **first, in `onMouseEvent`, before the per-view guard**:

```ts
function onMouseEvent(ev) {
  if (ev.y === 0) { const t = headerTabBands(columns).hit(ev.x); if (t) { setUiMode(t); return; } }
  if (confirm) return;
  if (uiMode === "local") return;          // local body is keyboard-first in v1
  if (view === "help" || view === "palette" || view === "addRepo") return;
  /* … existing github hitTest routing, unchanged … */
}
```

`headerTabBands(columns)` lives in `geometry.ts`, shared by `Header` and
`hitTest`, so component and hit-test never drift on coordinates.

## Local mode UI

### Layout (`LocalDashboard.tsx`, new)

Reuses `RAIL_WIDTH = 26` and the `bodyRows` budget:

```
┌ sections ─┐┌ <selected section> ─────────────────────┐
│▌queue   ▸2││  RUNNING (1/2) …                         │
│ outbox ⇡3 ││  WAITING (4) …                           │
│ repos     ││  RECENT …                                │
│ worktrees⚑││                                          │
│ daemon  ● ││                                          │
│ 1/5       ││  3/12                                    │
└───────────┘└──────────────────────────────────────────┘
```

- **`SectionRail`** — fixed 5-row list rendered like `Rail` (`▌` accent cursor,
  `selectionBg` on the selected row, border accent when `focus==="rail"`). Live
  badges from `localCheap`: outbox `⇡N` (hidden at 0), daemon `●/○`, worktrees
  stale-count `⚑N`, queue running-count `▸N`. Never windowed. A compact
  `↻ localRefreshedAt` line is pinned at the bottom so the tall 26-wide column
  doesn't read as empty.
- **Body** — one `bodyRows`-tall bordered pane; border accent when
  `focus==="body"`.

Two focus levels: the rail moves the section; the body drives the in-section
cursor.

### Navigation

| Key | rail focus | body focus |
|---|---|---|
| `j`/`k`/↑/↓ | move section | move cursor |
| `l`/→/enter | enter body | section action / open |
| `h`/←/esc | — | back to rail |
| `g`/`G` | first/last section | first/last row |
| `[`/`]` | — | scroll (daemon panel) — scroll-alias parity |
| `r` | full local refresh | full local refresh |
| `m` / Shift+Tab | → github | → github |
| `q` | quit | — (esc first) |

Section switch resets `localScroll = 0` and preserves each section's cursor via
`localCursor[section]`, clamped on shrink like `issueIdxSafe` (`App.tsx:294-300`).

### Windowing

List sections window to `listRowsHeight(layout.bodyRows)` via `windowSlice`
(`window.ts`), with a lifted `prevStart` ref per section (pattern at
`App.tsx:343-375`). `cursor+1/total` on the last row (`Rail.tsx:68-72`). Daemon
is a non-list detail panel using `localScroll` + `slice(scroll, scroll+height-3)`
(`QueueView.tsx:139`).

### Per-section bodies

- **Queue** — honors "the `t` view *is* the Queue section." `QueueView` gains
  **additive optional props** `selectable?`, `selectedRow?`, `onRows?`. Absent
  (GitHub `t`) → renders exactly as today (frames byte-identical). Present
  (LOCAL) → `▌` cursor on **actionable rows only**: WAITING/inbox and
  RECENT/failed. **RUNNING/processing rows render but are never selectable** —
  the daemon owns `processing/`.
- **Outbox** — header `⇡{depth} live · ✗{dead} dead`; windowed selectable list
  of live `StoredOp` (`listOps`, `githubOutbox.ts:135`) rendered like `opLine`
  (`outboxCmd.ts:45-49`): age, `kind target`, `attempts=N`, `lastError`. Dead
  sub-list from new `listDeadOps`. Per-op detail expands under the cursor
  (multi-line `lastError`). Read-only except flush.
- **Repos** — windowed list of `LocalRepo`: `nwo`, on-disk path (truncate-start),
  origin/fork GitHub links, `branch@sha7`, `✎dirty`, source tag
  `(cfg)`/`(watch)`/`(external)`/`(clone)`. Template: `doctor.ts:175-194`.
- **Worktrees** — windowed list of `LocalWorktree`: mapped repo nwo (or
  `⟨unmapped⟩`), slug, display class `live/stale/backup`, `HEAD sha7`, age.
  **The FS class is display-only; it is NOT the safety signal** (see prune).
  Backups (`.old-<ts>`) dim.
- **Daemon** — detail panel: `pid`, `up 2h13m`, `inference endpoint ●/○`
  (stack-agnostic wording), health host:port, live per-ticket turn progress
  (turns/lastTool/tokens), `tok in/out`, `guard: nudges N · kills N`,
  `tasksByStatus`. Scrollable.

### Degraded states

- **github disabled:** launch straight into LOCAL; the GITHUB tab is dim +
  disabled; clicking it or pressing `m` toasts
  `"github mode is off ([github] enabled=false)"`.
- **daemon down:** Daemon shows `○ not running`; Queue RUNNING falls back to the
  `processing/` scan (already handled by the reused `QueueSnapshot`,
  `queueSnapshot.ts:204-216`); endpoint reachability is independent
  (`health.ts:40`).
- **empty lists:** `"none"` dim rows (`Rail.tsx:50`). Missing dirs → empty,
  never error.
- **snapshot error:** each section renders `unavailable: {error}` dim without
  collapsing the frame.

### Theme / footer

One accent (`#eb6f92`) for the section cursor, focused border, and active-tab
reinforcement only. Status colors stay semantic; `▌` and bracket glyphs keep
everything legible under `NO_COLOR`. New `localHintsFor(section, focus)` in
`Chrome.tsx` (GitHub `hintsFor` untouched, plus `["m","local"]` added to the
GitHub main-pane hint set so the global key is discoverable from both sides):

- rail: `↑/↓ section · → open · m github · r refresh · ? help · q quit`
- queue/body: `↑/↓ move · R requeue · x delete · ← back`
- outbox/body: `↑/↓ move · f flush · ← back`
- worktrees/body: `↑/↓ move · x prune · ← back`
- daemon: `[/] scroll · X restart · f flush · ← back`

## Data model (`src/tui/localSnapshot.ts`, new)

### Two sibling factories, split by cost + async git

`QueueSnapshot` is polled @2s on the GitHub path and must not pay for per-repo /
per-worktree git. LOCAL gets its own snapshot, split cheap vs heavy:

```ts
export interface LocalCheap {
  queue: QueueSnapshot;                             // via makeQueueSnapshotFn (single /health)
  counts: { done: number; failed: number } | null; // only when Queue section selected
  outbox: { depth: number; dead: number; ops: StoredOp[]; deadOps: StoredOp[]; error: string | null };
  daemon: DaemonDetail;
  error: string | null;
}
export interface LocalHeavy { repos: LocalRepo[]; worktrees: LocalWorktree[]; error: string | null; }

export interface LocalRepo {
  nwo: string | null; path: string; source: "config"|"watchlist"|"external"|"clone";
  originUrl: string | null; forkUrl: string | null; githubUrl: string | null;
  branch: string | null; headSha: string | null; dirty: boolean | null; error: string | null;
}
export interface LocalWorktree {
  path: string; repoPath: string | null; repoNwo: string | null; slug: string;
  kind: "live"|"stale"|"backup"; headSha: string | null; ageSeconds: number | null; error: string | null;
}
export interface DaemonDetail {
  up: boolean; pid: number | null; uptimeSeconds: number | null;
  endpointReachable: boolean; healthHost: string; healthPort: number;
  guardNudges: number | null; guardKills: number | null;
  tokensIn: number | null; tokensOut: number | null;
  tasksByStatus: Record<string, number>;
  currentTickets: string[];   // authoritative live set — drives the prune liveness gate
  progress: Record<string, { turns:number; lastTool:string|null; outputTokens:number; startedAt:string }>;
  error: string | null;
}
```

- `makeLocalCheapFn(cfg, deps)` — `queue`, `counts` (gated), `outbox`, `daemon`.
  **One `/health` fetch total** (below). Poll @ `localCheapPollMs` (default 3000)
  while `uiMode === "local"`.
- `makeLocalHeavyFn(cfg, deps)` — `repos` + `worktrees`. **`gitFn` is async**
  (spawn + await), run through a **bounded concurrency pool** (per repo). Poll @
  `localHeavyPollMs` (default 15000) while `uiMode === "local"` **and**
  `localSection ∈ {repos, worktrees}`, plus an immediate run on `r` and on first
  entry to those sections. An `aliveRef` drops late results; the effect cleanup
  calls `AbortController.abort()` / `child.kill()` so a mode-switch/unmount never
  orphans git children or blocks the Ink event loop.

`deps` seams (tests never touch network/git): `readdirFn`, `readFileFn`,
`statFn`, `fetchFn`, `nowFn`, `gitFn(args, cwd) => Promise<{code, stdout}>`.

### Enumerators (all read-only, lock-free)

**Every enumerator git call passes `--no-optional-locks`** and uses lock-free
forms so the observer never takes `index.lock` in a live daemon-owned base repo.
Dirty check is `git --no-optional-locks status --porcelain` (or `diff --quiet`),
never a plain `git status`.

- **Repos** (template `doctor.ts:175-194`): union of (1) `cfg.github.repos`; (2)
  **raw** `readWatchlist(...).entries` — deliberately not `resolveWatchedRepos`,
  which drops `external:true` forks (`watchlist.ts:92`); (3) one-level walk of
  `cfg.github.externalReposRoot`; (4) one-level walk of
  `join(cfg.stateDir, "repos")`. Dedup by `resolve(path)`. Per repo,
  individually wrapped git calls (never-throws → null + `error`):
  `rev-parse --abbrev-ref HEAD`, `rev-parse HEAD`,
  `status --porcelain --no-optional-locks`, `remote get-url origin` →
  `nwoFromRemoteUrl` (`githubInbox.ts:72`). External: managed clone's origin is
  the fork → `forkUrl = originUrl`, upstream nwo = watchlist key. Owned:
  `forkUrl = null`.
- **Worktrees**: walk `cfg.worktreeRoot`; layout
  `worktreeRoot/<repoDiscriminator>/<slug>` + `.old-<ts>` backups
  (`worktree.ts:148-162`). Display class only: `.old-<ts>` → `backup`; dir with
  `.git` → `live`; else `stale`. HEAD via `currentHeadSha` (`worktree.ts:71`).
  Reverse-map `repoDiscriminator` (`worktree.ts:58-62`) by precomputing it for
  each enumerated repo path; unmatched → `repoNwo: null`. New pure module (only a
  private walker exists today inside `pruneStaleWorktrees`, `:325-361`).
- **Outbox**: `outboxDepth` (`:160`), `deadCount` (`:171`), `listOps` (`:135`);
  add **`listDeadOps`** by extracting a shared `listOpsFrom(dir, deps)` and
  calling it with `outboxPaths(cfg).dir` / `.dead` (`:93`) — no clone, no drift.
- **Full counts**: `countMd(dir)` for `done`/`failed` — **only when the Queue
  section is selected** (not on the 3s poll).
- **Daemon**: the single `/health` body → `pid`, `uptimeSeconds`,
  `guardNudges/Kills`, `currentProgress`, `currentTickets`, `tasksByStatus`,
  tokens (`healthServer.ts:113`, `metrics.ts:11-59`); plus `endpointReachable`
  (`health.ts:40`). `HealthInfo` (`ghClient.ts:92`) omits pid/guards, so we fetch
  `/health` raw.

### Never-throws contract

Top-level try/catch sets `error`; per-item `error` fields on individual failures
(posture of `makeQueueSnapshotFn`, `queueSnapshot.ts:115-249`). A vanished
repo/worktree/op never sinks the snapshot.

### One `/health` fetch per cheap tick

`makeLocalCheapFn` fetches `/health` **once** (AbortController-timed, mirroring
`queueSnapshot.ts:169-199`) and threads the parsed body into both consumers: it
passes the body into `makeQueueSnapshotFn` via a `healthOverride` seam so the
queue layer does not issue its own request, and reuses the same body for
`DaemonDetail`. One request, one consistent `daemonUp`.

### Cadence + scope

Two effects, both gated `if (uiMode !== "local") return;`: cheap @3s; heavy @15s
additionally gated on `localSection ∈ {repos, worktrees}`, with an immediate fire
on entry and on `r`. `counts` (full `done`/`failed`) is computed in the cheap fn
**only when `localSection === "queue"`**. Both use `setInterval` (not a spin
loop), honoring the fake-`sleep`/real-tick discipline. A separate
`localRefreshedAt` stamp avoids colliding with the GitHub cycle.

### dashboardCmd wiring + guard relaxation

In `runDashboard` (`dashboardCmd.ts:64-79`): inject `localCheapFn`,
`localHeavyFn`, `initialUiMode: cfg.github.enabled ? "github" : "local"`,
`githubEnabled`. Add `makeLocalCheapFn`/`makeLocalHeavyFn` to the lazy
`Promise.all` (`:43-57`) to preserve the lazy-import invariant. **Relax the
`github.enabled` refusal (`:35`)** — when GitHub is disabled, launch into LOCAL
with the GITHUB tab disabled. The dispatch-would-hang rationale applies only to
GitHub-mode dispatch, which is exactly what's disabled.

### Zero Config churn

Everything derives from existing `Config` (`stateDir`, `worktreeRoot`,
`github.repos`, `github.externalReposRoot`, `health*`, `gitBin`, `ghBin`,
`maxConcurrent`). **No new Config field → no `makeConfig`/`cfg()` fixture edits**
across `tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts`.

## Action model & daemon safety

**Invariant honored:** the TUI reimplements no logic — it spawns the real junco
CLI (`runCliFn` → `cliRunner.runCliCommand`), fire-and-toast like `runAssess`
(`App.tsx:762-798`), then forces an immediate local re-poll. Where no CLI exists,
we **add the CLI subcommand first** so identical safety logic backs both CLI and
TUI. An in-flight guard set (like `assessInFlightRef`, `:747`) prevents
double-spawn.

### Action table (final)

| Section / row | Key | Effect | Execution | Safety class |
|---|---|---|---|---|
| Queue · WAITING/inbox | `x` | Delete queued ticket (`inbox/<name>.md`) | **new** `junco rm <name>` | **DESTRUCTIVE — confirm** |
| Queue · RECENT/failed | `R` | Requeue failed → inbox | `junco retry <name>` (`retryCmd.ts:40`) | SAFE (single); confirm on `--all` |
| Queue · RUNNING/processing | — | none (non-selectable) | — | **FORBIDDEN — daemon owns `processing/`** |
| Outbox | `f` | Flush backlog | `junco outbox flush` (`outboxCmd.ts:58`) | SAFE (flush.lock-guarded, idempotent) |
| Outbox · dead row | — | view detail only (v1) | — | read-only (drop = future) |
| Repos | `o` | Open origin/fork in browser | `openRepoBrowser(nwo)` — explicit local target | SAFE |
| Repos · watchlist row | `x` | Unwatch | `unwatch(nwo)` — explicit local target | SAFE (reversible; toast no-op if not watched) |
| Worktrees · stale/backup | `x` | Prune one worktree | **new** `junco worktree prune <path>` (lock-guarded) | **DESTRUCTIVE — confirm** |
| Worktrees · live row | — | none (non-selectable) | — | **FORBIDDEN — in-flight ticket** |
| Daemon | `X` | Restart daemon | `junco restart` (`restartCmd.ts:120`) | **DESTRUCTIVE — confirm (scope-aware body)** |
| Daemon | `f` | Flush outbox (shortcut) | `junco outbox flush` | SAFE |

Embedded key decisions:

- **`x`/`R` split, never overloaded by row-class.** `x` = "remove the thing under
  the cursor" everywhere (delete inbox ticket / prune worktree / unwatch repo);
  `R` = requeue failed. One key never straddles the destructive boundary.
- **Prune is on `x`, not `p`.** `p` = PRs in GitHub mode; `o`/`r`/`g`/`G`/`j`/`k`
  stay identical across modes; the intentional divergences (`x`,`R`,`X`) are
  documented in HelpModal.
- **Repos actions take an explicit `LocalRepo` target** from `localCursor.repos`,
  never the GitHub `currentRepo` (a different, smaller set). Clone-only/external
  repos absent from the watchlist → `x` toasts "not in watchlist," no-op.
- **`w` (add repo) is dropped from LOCAL in v1.** Adding a repo drives the
  addRepo text state machine (a GitHub-mode affordance); to add, toggle to
  GitHub. Removes the stranded-text-field trap and shrinks scope.

### New CLI subcommands (add-CLI-first)

**`junco rm <name>`** (`src/rmCmd.ts`) — deletes from `inbox/` only. Fuzzy-match
like `retryCmd` (`:67-80`). Refuses any name resolving outside `inbox/`; refuses
`processing/` outright. **ENOENT-tolerant** (the daemon may atomically rename
into `processing/` between list and delete). **Truthful toast:** on ENOENT prints
`"not present in inbox — it may be claimed or mid-requeue and could reappear"`
and exits 0 — it does **not** claim the ticket is gone (a `requeueTicket` final
rename INTO `inbox/`, `requeue.ts:82`, can legitimately resurrect a just-deleted
name). Documented as best-effort against `inbox/`, not an authoritative kill.
Registered in `cli.ts` USAGE + `PALETTE_COMMANDS`.

**`junco worktree prune <path>`** (`src/worktreePruneCmd.ts`) — the destructive
safety lives here so CLI and TUI share one chokepoint. This is the crux of the
daemon-safety hardening:

1. **Path containment:** `resolve(path)` must be under `cfg.worktreeRoot`, else
   refuse.
2. **Shared lock (single-writer preserved):** acquire `worktrees.lock` — a
   pidfile lock using the same stale-tolerant helper that backs `flush.lock`.
   **The daemon must acquire the same lock** around its worktree mutations
   (`prepareWorktree`, `cleanupWorktree`, `pruneStaleWorktrees`). This makes
   prune and daemon provisioning mutually exclusive; they can no longer race the
   shared `.git/worktrees/<id>` metadata or `index.lock`.
3. **Liveness gate *inside the lock*:** refuse if the worktree's `slug` matches a
   ticket in `processing/` **or** a `/health` `currentTickets` entry
   (`metrics.ts:18`) — computed as `worktreeSlug(id)` per live/processing ticket,
   matched against the worktree's slug segment (does **not** depend on the repo
   reverse-map, so `⟨unmapped⟩` worktrees are still gated). Because the check runs
   under the lock, it sees the committed `processing/` state the daemon writes
   while provisioning — closing the TOCTOU. Daemon down / health disabled → fall
   back to the `processing/` scan (authoritative when no concurrent writer
   exists).
4. **Remove:** `git worktree remove --force` then `rmdir` the empty discriminator
   parent (mirrors `cleanupWorktree`, `:282-300`). `--force` is acceptable *only
   because* steps 2–3 have already established, under the lock, that no live run
   owns this tree — we do **not** rely on git's lock semantics as a backstop
   (junco never calls `git worktree lock`).

Optional defense-in-depth (deferred, v1.1): have the daemon `git worktree lock`
its live worktrees and have prune drop `--force`, so an errant external remove
fails at the git layer too.

### Explicitly FORBIDDEN (and why)

- **Any action on `processing/`/RUNNING rows** — the daemon owns `processing/`,
  finalizes/moves files mid-run, runs up to `maxConcurrent` concurrently. Rows
  are read-only, non-selectable.
- **Pruning a `live`-classified or slug-matched worktree** — belongs to an
  in-flight run; pruning corrupts the run and its salvage.
- **Unsynchronized worktree mutation** — no `git worktree remove` from outside
  `worktrees.lock`. The FS `live/stale/backup` class is display-only and is
  explicitly **not** the safety signal (the FS cannot tell an in-use worktree
  from a crashed-run leftover — both hold a `.git` file). The only authoritative
  signal is the slug match consulted under the lock.
- **Bare daemon kill** — only `junco restart` (launchctl `kickstart -k`,
  `restartCmd.ts:145-152`); a plain SIGTERM leaves launchd `KeepAlive` down.
- **Requeue a `done` ticket** — `junco retry` reads only `failed/`
  (`retryCmd.ts:47`); a `requeue <box> <name>` extension is deferred.
- **locks/pidfile & orphans surfacing** — out of v1 scope (future lever).

### Confirm + toast UX

Reuse `Modal` (`App.tsx:1459`). `confirm` state `{ title, body, danger,
onConfirm }`; while open it owns input (`y`/enter confirm, `n`/esc cancel) and is
added to the `onMouseEvent` guard. **Restart's confirm body is scope-aware:**
populated from `/health` `currentTickets` —
`"Restart will interrupt N in-flight ticket(s) (soft-abort, committed work
salvaged). Continue?"`. On confirm, spawn via `runCliFn`, toast the first
non-empty output line (`firstNonEmptyLine`, `:129`) with success/error coloring.
Offline: `outbox flush` self-reports offline (`outboxCmd.ts:76`);
`rm`/`retry`/`prune`/`restart` are local and unaffected.

## Wiring checklist (exact edit points)

- **`src/tui/App.tsx`** — add `UiMode` + `uiMode` state (above `View`, ~`:77`) +
  the local state cluster; restructure `useInput` (`:1059`) into the 5 layers
  above (verbatim move of `:1064-1324` into the github branch); add hoisted
  `handleLocalInput`, `runLocalAction`, `askConfirm`; parameterize
  `unwatch(nwo)` / `openRepoBrowser(nwo)`; two `uiMode==="local"`-gated poll
  effects (cheap 3s, heavy 15s + section-gated) with `aliveRef` + AbortController
  cleanup; render branch at Workspace children (`:1493`); `Header` call passes
  `uiMode`/`githubEnabled`; `onMouseEvent` resolves the header band FIRST (all
  views), `if (confirm) return`, `if (uiMode==="local") return` before per-view
  routing; add the confirm `Modal` to the `modal` composition; new `AppProps`
  `localCheapFn`/`localHeavyFn`/`initialUiMode`/`githubEnabled`/`localCheapPollMs?`/`localHeavyPollMs?`.
- **`src/tui/components/Chrome.tsx`** — `Header` gains `uiMode`/`githubEnabled` +
  responsive `GITHUB│LOCAL` tab (bracket-marked active, compact form <WIDE_COLS,
  folded into chip-drop); add `localHintsFor`; add `["m","local"]` to the github
  main hint set. `hintsFor`/`mode:LayoutMode` untouched.
- **`src/tui/geometry.ts`** — new `headerTabBands(columns)` shared by Header +
  hitTest.
- **`src/tui/hitTest.ts`** — `HitContext.uiMode?: UiMode` (optional, defaults
  `"github"` so existing `tuiHitTest` y===0→`none` cases stay green); `HitTarget`
  gains `{type:"modeTab"; mode}` additively; header-band emission guarded on a
  supplied `uiMode`. (Local section/row hit targets deferred to v1.1 — LOCAL is
  keyboard-first.)
- **`src/tui/components/QueueView.tsx`** — additive optional
  `selectable?`/`selectedRow?`/`onRows?`; default-absent path renders identically
  to today.
- **`src/dashboardCmd.ts`** — inject local fns + `initialUiMode`/`githubEnabled`;
  relax the `github.enabled` guard (`:35`); add localSnapshot imports to the lazy
  `Promise.all`.
- **`src/githubOutbox.ts`** — extract shared `listOpsFrom(dir, deps)`; add
  `listDeadOps`.
- **`src/worktree.ts`** — daemon-side: acquire `worktrees.lock` around
  `prepareWorktree`/`cleanupWorktree`/`pruneStaleWorktrees` (behavior-preserving:
  a singleton daemon already is the sole writer).
- **New CLI:** `src/rmCmd.ts`, `src/worktreePruneCmd.ts`; register in `cli.ts`
  USAGE + `PALETTE_COMMANDS` (a consistency test pins palette names to USAGE,
  `cliRunner.ts:32`).
- **New TUI modules:** `src/tui/localSnapshot.ts` (+ types & enumerators),
  `src/tui/components/LocalDashboard.tsx` (+ `SectionRail`, `OutboxSection`,
  `ReposSection`, `WorktreesSection`, `DaemonSection`).
- **`src/tui/components/HelpModal.tsx`** — a "local mode" section: `m`/Shift+Tab,
  section keys, action/safety table, the intentional cross-mode key divergences.
- **`docs/dashboard.md`** — reframe intro to "two modes: GITHUB and LOCAL"; scope
  "mouse works throughout" to GitHub (state that local rows are keyboard-only in
  v1); document `m`/Shift+Tab, the section list, actions, safety rails, and that
  `[`/`]` scroll the local daemon panel. Keep all new user-visible text
  **stack-agnostic** ("inference endpoint").

## Testing

**Pure-module tests (fakes only):**

- `localSnapshot.test.ts`: repos union/dedup (config ∪ **raw** watchlist incl.
  `external:true` ∪ externalReposRoot ∪ clonesDir); worktree class +
  discriminator reverse-map (matched + unmapped); outbox live/dead split;
  done/failed counts (present only when Queue selected); `DaemonDetail` from a
  fake `/health` body; **single-fetch** assertion (cheap fn issues exactly one
  `/health` request; queue + daemon share it); **async gitFn** bounded-pool +
  late-result-drop on abort; **never-throws** (throwing
  `readdirFn`/`gitFn`/`fetchFn` → renderable snapshot, populated `error` fields);
  **no plain `git status`** — assert every git invocation carries
  `--no-optional-locks`; ordering stability.
- `githubOutbox.test.ts`: `listOpsFrom`/`listDeadOps` (empty → `[]`, sorted,
  skips unparseable — mirror `listOps`).
- `rmCmd.test.ts`: fuzzy match; ENOENT → exit 0 with the truthful "may reappear"
  message; refuses names outside `inbox/`; refuses `processing/`.
- `worktreePruneCmd.test.ts`: path-containment refusal; **lock acquired before
  mutation**; **liveness gate under lock** (processing/ slug + `/health`
  currentTickets → refuse; unmapped worktree still gated by slug); daemon-down
  fallback to processing/ scan; happy-path remove + parent rmdir; a
  **serialization test** where a held `worktrees.lock` blocks prune (proving
  mutual exclusion with the daemon).

**Component tests (`ink-testing-library`, fixed `sizeOverride`, fakes for
`localCheapFn`/`localHeavyFn`/`runCliFn`):**

- `tuiLocal.test.ts`: `m`/Shift+Tab toggles `uiMode`; header shows the bracketed
  active tab **and stays distinguishable with `NO_COLOR=1`**; header at
  `columns=60` with a full medium chip set stays `height===1` (no wrap); section
  rail navigation; each section frame; empty/daemon-down/error frames;
  github-disabled launches into LOCAL with the GITHUB tab disabled.
- `tuiLocalActions.test.ts`: `R` on a failed row → `retry <name>`; `f` →
  `outbox flush`; `x` on a stale worktree → confirm → `y` → `worktree prune`; `x`
  on an inbox row → confirm → `rm`; actions disabled on live/running rows (assert
  **no spawn**); Repos `x`/`o` act on the **local cursor target**, not github
  `currentRepo`; restart confirm body includes the in-flight count; confirm-cancel
  path; header-tab click toggles mode from a non-`main` view (e.g. `prs`).
- `tuiMouse.test.ts`: in LOCAL a body click/wheel is a **no-op** (no github state
  mutation); header-band click still toggles.

**Flake rule:** never assert one fixed `setTimeout` tick after a state change —
bounded until-loop on the frame string, then assert.

**Atomic-switch staging (green at every commit):**

1. `localSnapshot.ts` + `listOpsFrom`/`listDeadOps` + enumerators — unwired,
   unit-tested.
2. `worktrees.lock` daemon-side acquisition in `worktree.ts` —
   behavior-preserving, with a lock-contention test.
3. `rmCmd`/`worktreePruneCmd` + CLI registration — unwired from TUI, CLI-tested.
4. `LocalDashboard` + sections + `QueueView` additive props — unwired (default
   props keep `tuiQueue` green).
5. **ONE atomic commit** rewires `App.tsx` (uiMode state + input restructure +
   render branch + confirm), adds the Header tab + `HitContext.uiMode?` +
   `headerTabBands` (landed *with* the rewire — it is not inert, it changes the
   y===0 hit result and ripples into `tuiHitTest` helpers), wires `dashboardCmd`,
   and **migrates all header-row frame tests in the same commit**. Because the
   tab renders in both modes, this touches **every** full-`<App>` frame capture
   and every direct `Header` render — enumerate up front with
   `grep -n lastFrame tests/{tuiApp,tuiInteractive,tuiChrome,tuiQueue,tuiModal,tuiIssueList,tuiPrList}.test.tsx`
   and budget the snapshot rewrite accordingly; also update the `tuiHitTest`
   `medium()`/`wide()` helpers for the new optional field.

**Invariants preserved:** non-TTY guard (`dashboardCmd.ts:24`) still returns 1;
lazy-import assertion holds (`localSnapshot.ts` imports only node + pure junco
modules; `LocalDashboard` reached only via App's existing dynamic import); no new
Config field → no fixture edits.

## Explicitly out of scope (YAGNI, v1)

- Locks/pidfile holder + orphan surfacing (future lever).
- Dropping/retrying individual dead-letter outbox ops (view-only in v1).
- Mouse selection/clicks inside the LOCAL body (keyboard-first; header-tab click
  only).
- `git worktree lock` defense-in-depth on the daemon side.
- Requeue from `done/` (retry reads only `failed/`).
- Per-worktree live-`git status` beyond HEAD/branch/dirty on the heavy poll.
- `fs.watch`/push updates or per-second tickers (poll-driven only).

## Appendix — resolved-risk provenance

The design was adversarially red-teamed across three lenses (daemon-race/safety,
architecture/test-fit, UX/conventions). Blockers/majors resolved:

| Finding | Resolution |
|---|---|
| Worktree prune = second unsynchronized mutator of daemon-owned `worktreeRoot` | shared `worktrees.lock` the daemon also acquires; in-lock liveness gate |
| "git refuses a locked tree" backstop is false | claim removed; safety is the lock + slug gate, not git semantics |
| FS class can't distinguish live vs orphaned worktree | FS class is display-only; slug match under the lock is the sole liveness signal |
| Enumerator `git status` takes `index.lock` on live repos | `--no-optional-locks` on every enumerator git call |
| `mode` prop collides with `LayoutMode` | new axis renamed `uiMode` end-to-end |
| Mouse mutates hidden github state in LOCAL | `onMouseEvent` early-returns in LOCAL after the header band; body keyboard-first |
| Repos `x`/`o` reuse github selection → wrong target | parameterized `unwatch(nwo)`/`openRepoBrowser(nwo)` on the local cursor |
| Double `/health` fetch per tick | single fetch threaded into queue + daemon |
| Sync git poller blocks the Ink loop / orphans children | async `gitFn`, bounded pool, `aliveRef` + AbortController cleanup |
| Atomic-commit test scope under-estimated | tab renders in both modes → enumerate every `lastFrame` test up front |
| hitTest staging not inert | `HitContext.uiMode?` optional; lands with the App rewire |
| addRepo text handler stranded in LOCAL | addRepo/palette handlers hoisted above the mode split; local `w` dropped |
| `R` = both delete and requeue | split: `x` = destructive remove, `R` = requeue |
| Header one-row budget at 60 cols unproven | responsive compact tab + 60-col full-chip Header test |
| Active tab invisible under NO_COLOR | bracket-marked active tab + accent reinforcement |
| Header tab clickable in only 4/9 views | header band resolved in `onMouseEvent` before the per-view guard |
