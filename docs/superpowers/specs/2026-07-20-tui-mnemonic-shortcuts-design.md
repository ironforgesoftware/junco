# TUI Mnemonic Shortcuts — Per-View First-Letter Derivation — Design

**Date:** 2026-07-20
**Status:** approved (per-view guarded cascade; one derived table drives chips, help, and key dispatch)

## Goal

Replace the hand-assigned shortcut keys with **derived mnemonics**: in every
view, each named option's hotkey is derived from its label (first letter when
free, cascading otherwise), and the binding is rendered by coloring the winning
character inside the label itself (`[r]efresh`, `a[s]sess`). One derived table
per context drives the footer chips, the help modal, and the keyboard dispatch
— render and input cannot drift.

Locked scope decisions (from the maintainer):

- **Re-derive, not render-only.** Bindings BECOME the cascade's output;
  existing keys change wherever they weren't already what the cascade yields
  (breaking; folds into the pending 0.9.0).
- **Per-view derivation** (not one global assignment): each context's option
  list claims letters independently, in canonical order.
- **Guarded cascade** rule-set: `quit`→`q` and `help`→`?` are pre-reserved in
  every context; destructive verbs claim UPPERCASE (shift) letters; everything
  else cascades first letter → later word-initials → remaining letters.
- **Approach 1**: a pure derivation engine + per-context option tables feeding
  BOTH rendering and dispatch through one action-handler table.

## Background facts the design relies on

- `src/tui/components/Chrome.tsx` exports `hintsFor(view, pane, mode,
filtering)` and `hintsForUnified(view, bodyKind, pane, mode, filtering)`
  returning `[key, label][]`; `Footer` renders `key label` chips (key accent,
  label dim), clickable when `footerActions` carries the key; overflow clips.
- `src/tui/App.tsx` holds `LOG_OVERLAY_HINTS`, a per-view `footerActions`
  memo whose handlers deliberately duplicate the keyboard branches verbatim,
  and a keyboard cascade with hard-coded letter branches for named actions
  (d/a/c/s/S/D/R/t/p/v/w/r/x/o/f/X, overlay f/l/t) layered over structural
  keys (movement j/k/h/l/g/G, panes 1/2/3/i/tab/arrows, enter/esc, symbols
  `/ : ? ,`, scroll `[ ]`).
- Main-view "globals" (t/p/v/w/r/s/S/,/:/?/q) act from ANY pane of the main
  view; chips are pane-filtered. Body verbs vary by `bodyKind`
  (issues/repoDetail/queue/outbox/worktrees/daemon/logs — railModel.ts).
- Confirm-modal-guarded verbs today: delete ticket, prune worktree, restart
  daemon. `review`'s discard is destructive WITHOUT a confirm.
- Ink test frames strip ANSI — color placement is not assertable from frames;
  it must be assertable structurally (segments/charIndex).

## 1 — Derivation engine (`src/tui/mnemonics.ts`, pure)

```ts
export interface MnemonicOption {
  id: string; // stable action id ("refresh", "addRepo", …)
  label: string; // display label — the mnemonic source
  guarded?: boolean; // destructive: claims UPPERCASE candidates
  hidden?: boolean; // claims a key but renders only in help (shift variants)
}
export interface DerivedMnemonic {
  id: string;
  key: string; // the bound key, exactly as matched against ink input
  label: string;
  charIndex: number | null; // index in label of the winning char; null = fallback
}
export function deriveMnemonics(
  options: MnemonicOption[],
  ctx: { reserved: ReadonlyMap<string, string>; excluded: ReadonlySet<string> },
): DerivedMnemonic[];
```

Rules, in claim order (options claim strictly in list order):

1. `reserved` entries (id → key) are claimed before anything else; a reserved
   id present in `options` gets its reserved key (charIndex from the label
   when the key appears in it — `[q]uit`; else null — `? help`).
2. Candidate sequence per option: first letter of the label → first letters of
   subsequent words → remaining letters left-to-right (deduped, letters only,
   lowercased). `guarded` options walk the SAME sequence uppercased.
3. A candidate is skipped when already claimed, in `excluded`, or in the
   reserved value set. First surviving candidate wins; `charIndex` = the index
   of the first occurrence of that letter (case-insensitive) in the label.
4. Exhaustion fallback: first unclaimed letter a–z (uppercase for guarded)
   with `charIndex: null`. Never throws. A context test asserts the fallback
   is never exercised by real tables.

## 2 — Context tables (`src/tui/viewActions.ts`)

A derivation context is **(view, bodyKind)** — NOT pane. Contexts:

- `main:<bodyKind>` for each of issues / repoDetail / queue / outbox /
  worktrees / daemon / logs;
- one per overlay view: detail, repoDetail (full-width), prs, prDetail,
  review, cmdOutput;
- `logOverlay`.
- palette / addRepo / config / help / filtering keep their purely structural
  hint sets (typing + navigation only — nothing derivable).

Canonical option order inside a `main:*` context: **main globals first, in
fixed order** (add repo, unwatch, browser, refresh, assess, queue, review,
PRs, commands), **then the body's verbs** (e.g. queue: retry, delete;
issues: dispatch, approve, analyze), **then hidden variants** (dispatch as
ask, assess auto-plan, re-plan — issues only). Globals derive identically in
every main context by construction (same prefix list), so cross-body
consistency of the shared verbs is a free property; body verbs claim from
what remains. The queue body's requeue verb is labeled `retry` — the CLI verb
it spawns (`junco retry`), and a label whose letters don't exhaust against
the global claims.

Guarded (uppercase) verbs: delete, prune, restart, discard (review), and
re-plan (it rewinds lifecycle state — and guarding keeps it off the
exhaustion fallback, landing it on today's `R`). Hidden: dispatch-as-ask
(guarded), assess-auto-plan (guarded), re-plan (guarded).

Per-context `excluded` letters = that context's structural keys: main
contexts `{j,k,h,l,g,G,i}` (movement + pane alias); logOverlay `{G}` (bottom
jump); the scroll-only overlay views exclude nothing (their structural keys
are non-letters). Reserved everywhere: `quit → q`, `help → ?`; in the log
overlay `q` is reserved for `close` (its established second close key).

```ts
export interface ContextBindings {
  /** Render order: structural chips (key-first form) + mnemonic chips. */
  chips: Chip[];
  /** key → action id, for the cascade tail and the help modal. */
  keymap: ReadonlyMap<string, string>;
}
export type Chip =
  | { kind: "structural"; key: string; label: string; inert?: boolean }
  | { kind: "mnemonic"; id: string; key: string; label: string; charIndex: number | null };
export function buildContextBindings(
  context: BindingContext,
  pane: 1 | 2 | 3,
  mode: LayoutMode,
): ContextBindings;
```

`chips` is pane-filtered (rail chips on pane 1, body chips on pane 2/3);
`keymap` is the full context map (globals act from any pane, exactly today's
behavior). Hidden options appear in `keymap` and in the help modal, never in
footer chips. `hintsFor`/`hintsForUnified`/`LOG_OVERLAY_HINTS` are replaced
by this module; the actual derived letters are pinned by per-context tests
(§6) and documented in `docs/dashboard.md` — the spec deliberately does not
hand-enumerate them (the algorithm + order above are normative).

## 3 — Rendering

`Footer` accepts `Chip[]`. A mnemonic chip renders its label with the winning
character in accent color (and uppercased in place for guarded keys —
`Delete` with the accent D signals shift); the rest of the label dim. A
structural chip renders today's `key label` form. `charIndex: null` mnemonics
render key-first as a defensive fallback. Chip click handlers come from the
action table (§4) by id — every mnemonic chip is clickable by construction.
`HelpModal`'s "this view" section renders the context's chips INCLUDING
hidden options; its hand-written sections keep structural keys and drop any
hard-coded named letters.

## 4 — Dispatch (one action table)

Per context, App builds `actionHandlers: Record<string /* action id */, ()
=> void>` — the generalization of today's `footerActions` (which already
duplicates every keyboard recipe for mouse). The keyboard cascade keeps its
structural branches (movement, panes, enter/esc, symbols, filter typing,
confirm modal, log overlay ownership) and ends with:

```ts
const id = bindings.keymap.get(input);
if (id !== undefined) {
  actionHandlers[id]?.();
  return;
}
```

Every hard-coded named-action letter branch is deleted. Guards stay INSIDE
handlers (external-repo gates, row-kind toasts, confirm modals) — unchanged
semantics, single implementation for key + click.

## 5 — Consequences

Bindings change wherever the cascade disagrees with today's assignment; the
per-context pinned tests make every final letter explicit in the PR diff for
review. `docs/dashboard.md` key tables are rewritten from the pinned maps;
CHANGELOG gains a breaking entry (0.9.0). Confirm modals, mouse behavior,
structural navigation, palette/addRepo/config typing are untouched.

## 6 — Testing

- `mnemonics.test.ts`: conflict cascade, word-initials, remaining-letter
  fallback, guarded uppercase, reserved claims, exclusions, exhaustion
  fallback, determinism.
- `viewActions.test.ts`: one test per context pinning the FULL derived keymap
  (id → key) — a label copy-edit that would re-bind fails loudly; plus an
  assertion that no context ever hits the exhaustion fallback and that global
  ids share keys across all `main:*` contexts.
- Footer/HelpModal segment tests: charIndex placement asserted structurally
  (frames strip ANSI).
- App-level: for each body kind, drive one action through its DERIVED key
  (read from viewActions, not hard-coded) and assert the handler fired; the
  guarded uppercase actually requires shift; hidden variants dispatch without
  chips.
- Full gate; existing suites that hard-code old letters get retargeted to
  read the derived maps.
