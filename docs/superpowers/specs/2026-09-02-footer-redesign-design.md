# Dashboard footer redesign — design

**Status:** approved design, 2026-09-02 (brainstorm with the maintainer; mockups in
`.superpowers/brainstorm/14395-1788382169/content/05-composed.html`).
**Supersedes** the footer half of `2026-07-20-tui-mnemonic-shortcuts-design.md` §2 (chip
rendering and chip order); the mnemonic _derivation_ (§1) is unchanged.
**Builds on** `2026-09-01-dashboard-chat-design.md` §8 (the chat view and its bindings).

## 1. Problem

The bottom bar is the dashboard's only always-visible key reference, and it fails at its one
job. Measured on the real frames (120 columns, `tests/helpers/localFixtures.tsx` repos):

```
 ↑/↓ move · add repo · Unwatch · browser · refresh · audit · queue · commands · quit · ? help
 ↑/↓ move · ←/→ panes · enter preview · / filter · import · approve · investigate · audit · PRs · quit · ? help
 i compose · ↑/↓ move · enter expand · [/] scroll · submit · edit · Discard · route · thinking · follow · esc back
```

1. **Chat is invisible.** `t` opens the repo chat from the rail, the repo detail body and the PR
   pane, but no main-view chip lists it (`RAIL_CHIP_ORDER` never included `chat`), and on the
   issue list `t` is the ticket transcript (#330), which is not listed either. The dashboard's
   largest new feature is reachable only by reading the help modal.
2. **Two key languages in one run.** Mnemonic chips hide the key as one accent-coloured letter
   inside a dim word (`refresh`); structural chips are key-first (`↑/↓ move`). Nothing groups
   them; the run reads as a single dim sentence.
3. **The stable keys are not stable.** Movement and pane keys appear and disappear per pane
   (the rail shows only `↑/↓ move`; the queue body shows `← back` but not panes), so the part of
   the bar an operator should learn once keeps changing.
4. **A wasted row.** The chrome is three rows — header, a toast row that is blank except for
   the four seconds after an action, and the one-line footer.

## 2. Decisions (from the brainstorm)

| #   | Decision                                                                                                                                                                                                                                                                                                                                         | Chosen over                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| D1  | **Lit-letter mnemonics, amplified**: the key is the letter in the label, drawn bold + underlined + accent; labels in the default foreground (not dim).                                                                                                                                                                                           | Keycaps for every key; `[t]` bracketed keys.                                                                          |
| D2  | **Two rows: actions above, navigation below.** The toast row is reclaimed; the chrome stays three rows (header + two footer rows).                                                                                                                                                                                                               | One grouped row; navigation above actions.                                                                            |
| D3  | **A toast replaces the actions row** for its lifetime (4 s or the next keystroke, as today); the navigation row stays.                                                                                                                                                                                                                           | A separate toast row.                                                                                                 |
| D4  | **The chat pill**: the chat verb renders as a solid accent pill with the lit letter inside — the only filled element on the bar.                                                                                                                                                                                                                 | Glyph-led chip; two-tone key pill; right-pinned slot; a global chord key (rejected: would not apply on every screen). |
| D5  | **`c` is chat, everywhere.** "chat" becomes the first main-view global, so it derives `c` in every main context; the palette's `c commands` chip is retired — the palette keeps its fixed `:` and is listed on the navigation row. `t` means _transcript_ only (its rail/PR-pane chat binding from `2026-09-01` §8.1 / Ruling R27 is withdrawn). | A pane-dependent `t`; a muted "one hop away" pill on the issue list; hiding the pill there.                           |
| D6  | **`c` on an issue or PR opens the repo chat with the composer prefilled** (`/issue 46`, `/pr 12`) — not sent.                                                                                                                                                                                                                                    | Plain repo chat; send immediately.                                                                                    |
| D7  | **Every overlay with a repo in context gets the pill**: issue detail, PR detail, PRs list, transcript (the ticket's checkout), review (the selected item's repo).                                                                                                                                                                                | Main view only; the three unambiguous overlays only.                                                                  |

## 3. The bar

Two rows, each exactly one terminal line, `paddingX 1`, never wrapping: overflow clips from
the right (the row is informational; the invariant "chrome = 3 rows" holds).

### 3.1 Row 1 — actions (`what you can do to the thing under the cursor`)

```
 <target>   [c̲hat]  verb  verb  verb  │  go  go  go
```

- **Target label** (dim, up to 16 columns, truncated, padded to the row-2 label so the two
  rows' chips start in the same column): what the verbs act on —
  `acme/api` (rail repo row, repo detail, PR pane's repo), `issue #46`, `PR #12`, `queue` /
  `outbox` / `worktrees` / `daemon` / `logs` (system bodies), `chat · acme/api`, `#46` in the
  issue-detail overlay, the ticket id in the transcript overlay, `review`. The label is data
  App already has (the crumb source); it is never derived from the chips.
- **Chat pill** first, when a repo is in context (§5). Absent — not muted — otherwise.
- **Row verbs**: the body's verbs for the focused pane (today's `bodyVerbs`), then the
  repo-scoped globals (`audit`, `browser`, `refresh`, `add repo`, `unwatch`), in that order.
- `│` separator (dim), then the **go-somewhere globals**: `queue`, `review`, `PRs`.
- Guarded verbs keep the uppercase lit letter (`U`nwatch, `D`elete).

### 3.2 Row 2 — navigate (`how to move in what you are looking at`)

```
 navigate   ↑↓ move  ←→ panes  ⏎ preview  / filter  g G first/last  : palette  , config          ? help  quit
```

- Structural keys as **muted keycaps** (`↑↓`, `←→`, `⏎`, `esc`, `g G`, `/`, `[ ]`, `:`, `,`)
  in `theme.keycapBg` with the default foreground; the label in the default foreground.
- The **same vocabulary in every context**. Only the _label_ of `⏎` / `←` / `→` changes to say
  what they do here (`detail`, `preview`, `transcript`, `issues`, `rail`, `expand`); the keys
  never move and never disappear. A key that is a no-op in a context is omitted rather than
  relabelled (there is no `/ filter` outside the issues body).
- `? help` and `q`uit (or `q` close in overlays) are pinned to the right edge (a flex spacer).
- Medium width (60–109 columns): `g G`, `:` and `,` are dropped from the row (they stay in the
  help modal and the keymap). `tooSmall` renders as today.

### 3.3 Toast

A toast paints over row 1 in the toast colour for its lifetime — 4 s (`useToast`) or until the
next keystroke dismisses it, exactly today's semantics. Row 2 is untouched, so navigation is
never hidden. The multi-line collapse (`\n` → `·`) stays.

### 3.4 Rendering language

| Element           | Style                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lit letter        | `theme.accent`, bold, underline (Ink `underline`) — uppercase when guarded                                                                                                 |
| Label             | default foreground (today's `dimColor` is dropped)                                                                                                                         |
| Structural keycap | `backgroundColor: theme.keycapBg` (new token, `#3b4261`-class, chosen for both dark and light terminals), default foreground, one space of padding each side               |
| Chat pill         | `backgroundColor: theme.accent`, foreground `theme.pillFg` (new token, the terminal-background-like dark), bold; the lit letter additionally underlined; one space padding |
| Row label         | dim, fixed-width slot                                                                                                                                                      |
| Separator         | `│` dim                                                                                                                                                                    |
| Toast             | `toastColor(kind)` as today                                                                                                                                                |

Frames strip ANSI, so tests assert placement through the pure segment model (§7), never
through colours in `lastFrame()`.

## 4. Per-context tables

Row 2 uses one vocabulary; the per-context differences are the `⏎`/`←`/`→` labels and the
presence of `/ filter`, `[ ]`, `esc`. Row 1 lists the pill (when §5 says so), the verbs, then
`│` and the go-globals. `q` is `quit` in the main view and `close` in overlays; `?` is `help`
everywhere except the help modal itself.

| Context                                                | Row 1 (after the target label)                                                                  | Row 2 (before `? help · q`)                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| main · rail, repo row                                  | pill · audit · browser · refresh · add repo · unwatch │ queue · review · PRs                    | ↑↓ move · → issues · ⏎ detail · g G · : palette · , config                                 |
| main · rail, system row                                | (body verbs of that system section, e.g. queue: retry · delete) │ review · PRs                  | ↑↓ move · → open · ⏎ open (logs: ⏎ log) · g G · : · ,                                      |
| main · issues (pane 2)                                 | pill · import · approve · investigate · transcript · audit · browser │ PRs · review · queue     | ↑↓ move · ←→ panes · ⏎ preview · / filter · g G · : · ,                                    |
| main · repo detail body                                | pill · browser · refresh · audit │ queue · review · PRs                                         | [ ] scroll · ← rail · : · ,                                                                |
| main · PR pane (pane 3)                                | pill · browser │ PRs · review                                                                   | ↑↓ move · ⏎ detail · ← issues · g G · : · ,                                                |
| main · queue / outbox / worktrees / daemon / logs body | body verbs │ review · PRs                                                                       | as today's `mainStructural` labels, keycap style                                           |
| overlay · issue detail                                 | pill · browser · transcript                                                                     | ↑↓ scroll · esc back                                                                       |
| overlay · PR detail                                    | pill · browser                                                                                  | esc back                                                                                   |
| overlay · PRs list                                     | pill · browser                                                                                  | ↑↓ move · ⏎ detail · esc back                                                              |
| overlay · review                                       | pill (selected item's repo) · all · none · file · discard · submit · edit · route               | ↑↓ move · ⏎ open/file · space toggle · esc back                                            |
| overlay · transcript                                   | pill (ticket's checkout) · thinking · follow                                                    | ↑↓ tool · ⏎ expand · [ ] scroll · esc back                                                 |
| overlay · command output                               | re-run                                                                                          | ↑↓ scroll · esc back                                                                       |
| overlay · chat, composer focused                       | **⏎ send** (the pill becomes the view's primary) · ctrl+j newline · / commands · esc blur/abort | (row 2 shows a dim one-line reminder of the blurred keys — the composer owns the keyboard) |
| overlay · chat, blurred                                | submit · edit · discard · route · thinking · follow                                             | i compose · ↑↓ move · ⏎ expand · [ ] scroll · esc back                                     |
| log overlay                                            | follow · level · ticket                                                                         | / search · [ ] scroll · G bottom · esc close                                               |
| palette / add repo / config / filtering / help         | today's structural chips, keycap style, on row 2; row 1 carries only the target label           | —                                                                                          |

The exact derived letters are pinned by `tests/tuiViewActions.test.ts` (updated in place, not
loosened); the chip texts by the footer-model tests (§7).

## 5. The chat verb

- **Key:** `c`, in every context above that lists the pill. Derivation makes it so: `chat` is
  the first entry of `MAIN_GLOBALS`, and `{ id: "chat", label: "chat" }` is added to each
  overlay's options (`c` is free in all of them; the pinned test proves it). The palette's
  `commands` option is removed from `MAIN_GLOBALS` (the `:` dispatch in App is untouched).
- **Target and prefill** (D6): rail repo row / repo detail / PR pane / transcript / review →
  `openChat(key)`; issue row / issue detail → `openChat(key, { composer: "/issue <n>" })`;
  PR row / PR detail / PRs list → `openChat(key, { composer: "/pr <n>" })`. The prefill lands
  in the composer with focus, not sent; `esc` blurs and leaves it, a second `esc` leaves the
  view; `enter` sends it (the existing slash router pulls the thread in).
- **No repo in context** (system bodies, an unwatched-path-less transcript, a review item
  without a repo): the pill is absent and `c` toasts `select a repo first (←)`.
- **Key for chat's own view:** unchanged (`2026-09-01` §8.3) — the chat view has no `c`.
- **`t`** is the ticket transcript on issue rows and in the issue-detail overlay (`t`ranscript
  now renders as a chip there); it is unbound on the rail and the PR pane.

## 6. Architecture

Everything that decides _what_ the bar says stays pure and testable; App only forwards data.

- `src/tui/viewActions.ts` — the tables (§4, §5): `MAIN_GLOBALS` gains `chat` at index 0 and
  loses `commands`; `VIEW_OPTIONS.*` gain `chat`; `BODY_VERBS.issues` loses the `chat`↔
  `transcript` swap (`bodyVerbs` collapses to `BODY_VERBS[body]`; `BindingContext.main.pane`
  stays — the chip subset is still pane-scoped). Structural chip sets move to the new
  vocabulary (`⏎`, `←→`, `g G`, keycap keys) and gain a `role: "nav"` so the model can place
  them on row 2. `ContextBindings` is unchanged in shape (chips / keymap / all), so the mouse
  layer and HelpModal keep working during the migration.
- **New `src/tui/footerModel.ts`** (pure): `buildFooterRows(bindings, ctx: { target: string;
chatReachable: boolean; mode: LayoutMode }) → { actions: FooterRow; navigate: FooterRow }`
  with `FooterRow = { label: string; chips: FooterChip[]; pinned: FooterChip[] }` and
  `FooterChip = { kind: "pill" | "mnemonic" | "structural" | "separator"; key; label;
charIndex; guarded; id }`. It owns: the pill promotion of the `chat` mnemonic, the row split,
  group order, the `│` insertion, the medium-width drops, and the chat-view "⏎ send" primary.
  `footerSegments(chip)` replaces `chipSegments` as the one pure styling model (text +
  `{accent, underline, keycap, pill}` flags) that both the renderer and the tests consume.
- `src/tui/components/Chrome.tsx` — `Footer` renders the two rows from `FooterRows` and takes
  `toast` (row 1 swaps to the toast when non-null); `Toast` is deleted. `chipActions` keeps
  its mnemonic-by-id / structural-by-key contract, so `structuralChipActions` and the
  click tests are untouched.
- `src/tui/theme.ts` — `keycapBg`, `pillFg`.
- `src/tui/App.tsx` — passes `toast` and a `footerTarget` string (from the crumb source) to
  `Footer`, drops the `<Toast>` mount, and routes the chat verb through `useMainActions` /
  `useViewActions` with the D6 prefill. The App function is pinned at 1913 lines
  (`eslint.config.js`); this work must not raise it — the target label is computed in a small
  hook (`useFooterTarget`) beside the crumbs, and the overlay chat handlers live in
  `useViewActions`.
- `src/tui/hooks/useChat.ts` — `openChat(key, opts?: { composer?: string })`.
- `src/tui/components/HelpModal.tsx` — reads the navigation vocabulary from the same
  structural table (single source), so `: palette` / `, config` and the `t on an issue`
  reading stay true; the "flow:" intro line gains `c chat — ask the agent about a repo`.
- `src/tui/layout.ts` — `CHROME_ROWS` stays 3 (header + 2 footer rows).

## 7. Testing

- `tests/tuiViewActions.test.ts`: every pinned keymap updated in place — `c: "chat"` in each
  main context and each overlay that lists it; `commands` gone from main keymaps (`:` is
  structural); rail `t` gone; issue list keeps `t: "transcript"`.
- **New `tests/footerModel.test.ts`**: for every context in §4, the two rows' chip texts and
  kinds, the target label, pill presence/absence, `│` placement, the medium-width drops, the
  toast swap, and `footerSegments` flags (accent/underline/keycap/pill) per chip kind.
- `tests/tuiChrome.test.tsx` (or the existing Chrome suite): the two rows render at the right
  height, right-pinned `? help · q`, clipping without wrap, the toast replacing row 1 only,
  clickable chips still dispatch (`chipActions`).
- App-level (`tests/tuiApp.test.tsx`, `tuiApp.chat.test.tsx`, `tuiMouseApp.test.tsx`): `c` from
  the rail, the issue list (composer prefilled `/issue 46`, not sent), the PR pane, issue
  detail, PR detail, PRs list, transcript, review; `c` on a system body toasts; `t` on an issue
  row still opens the transcript; `:` still opens the palette; the footer target label per
  view; the frame stays within `rows`. Every keystroke gated on `until()`; positive assertions
  never follow a fixed tick (CLAUDE.md).
- HelpModal test: `c chat` listed once per context; `: palette` in navigate; no `c commands`.
- The full gate + coverage floors as usual; `App` at ≤ 1913.

## 8. Docs

`docs/dashboard.md` "shortcut bar" section rewritten (two rows, the pill, `c`, the palette on
`:`); the keys tables updated; `CHANGELOG.md` under `[Unreleased]` → Changed (`c` chat
everywhere, `t` transcript only, palette chip retired for `:`, two-row footer, toast reclaimed);
`README.md` mentions `c` where it mentions chat.

## 9. Non-goals

- No change to the header row or its pulse chips.
- No change to the mnemonic derivation algorithm (`mnemonics.ts`).
- No new global chord keys; no configurable keymap.
- No change to the chat view's own bindings beyond the `⏎ send` primary treatment.
- Light-theme palette work beyond the two new tokens.
