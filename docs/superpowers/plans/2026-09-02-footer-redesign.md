# Dashboard Footer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's one-line footer with a two-row bar — actions (with the chat pill on `c`) above, a stable navigation vocabulary below, the toast painting over the actions row — so chat is discoverable on every screen and the structural keys never move.

**Architecture:** The binding tables in `src/tui/viewActions.ts` change (chat becomes the first main global, the palette chip retires to its fixed `:`, overlays gain `chat`); a new pure `src/tui/footerModel.ts` turns one `ContextBindings` plus a target label into two `FooterRow`s (pill promotion, grouping, `│`, medium-width drops, key glyphs); `Footer` in `Chrome.tsx` renders the rows and absorbs the toast; App's binding/footer derivation moves into a hook so the App function does not grow. The mnemonic derivation (`mnemonics.ts`), the mouse chip-click contract (`chipActions`: mnemonic by id, structural by KEY string) and `CHROME_ROWS = 3` are unchanged.

**Tech Stack:** TypeScript (Node ≥22.19, ESM/NodeNext, strict), Ink 7.1 (`Text` `bold`/`underline`/`backgroundColor`), React 19 hooks, vitest + ink-testing-library, prettier 100 cols.

**Spec:** `docs/superpowers/specs/2026-09-02-footer-redesign-design.md` (read §3–§6 before any task).

## Global Constraints

- The chrome is exactly 3 rows: header + 2 footer rows (`CHROME_ROWS = 3` in `src/tui/layout.ts` unchanged); each footer row is one terminal line, `paddingX 1`, overflow clips from the right, never wraps (spec §3).
- `c` is chat in every context that lists the pill; `t` is transcript only; the palette is `:` only — no `commands` mnemonic (spec D5).
- `chipActions` contract unchanged: mnemonic chips are clickable by `id`, structural chips by their `key` STRING (`esc`, `enter`, `←`, `/`, `esc/p`, `enter`, `:` …). The renderer maps key strings to glyphs (`enter` → `⏎`, `↑/↓` → `↑↓`, `←/→` → `←→`, `[/]` → `[ ]`); the strings in `Chip.key` do not change (spec §6).
- `App` in `src/tui/App.tsx` is pinned at **1913** lines by `eslint.config.js` `GRANDFATHERED_FUNCTION_LINES` (`max-lines-per-function`, skipBlankLines/skipComments). Measure with: `npx eslint --no-inline-config --rule '{"max-lines-per-function": ["error", {"max": 1, "skipBlankLines": true, "skipComments": true, "IIFEs": true}]}' src/tui/App.tsx 2>&1 | grep -o "Function 'App' has too many lines ([0-9]*)"`. This plan must not raise the pin (Task 4 lowers the count).
- `src/tui/**` runs `eslint-plugin-react-hooks` `rules-of-hooks` + `exhaustive-deps` at ERROR; never `eslint-disable`.
- Ink test rules (CLAUDE.md): gate every keystroke on `until()`/`fireUntil`; never a positive assertion after a fixed tick; frames strip ANSI, so styling is asserted through the pure segment model, never through colours.
- Every pinned keymap in `tests/tuiViewActions.test.ts` is updated in place — literals, never loosened to `toMatchObject`.
- Conventional commits; **no AI attribution trailers**; `npx prettier --write` on touched files; capture vitest exit codes explicitly (`> /tmp/out 2>&1; echo "exit: $?"`); full gate before each task's commit: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.
- Coverage floors (vitest.config.ts): global 92/85/90/94 — every new branch in `footerModel.ts` / `Chrome.tsx` needs a test.

---

### Task 1: The binding tables — `c` chat everywhere, palette on `:`, `t` transcript only

**Files:**

- Modify: `src/tui/viewActions.ts` (`MAIN_GLOBALS` ~70-82, `BODY_VERBS.issues` ~84-99, `VIEW_OPTIONS` ~131-165, `RAIL_CHIP_ORDER`/`ISSUES_CHIP_ORDER`/`PANE3_CHIP_ORDER` ~268-280, `bodyVerbs` ~289-293)
- Modify: `tests/tuiViewActions.test.ts` (every pin), `tests/tuiApp.chat.test.tsx` (presses `t` to open chat → `c`), `tests/useMainActions.test.tsx` (if it asserts the `commands` id in the main keymap)
- Test: `tests/tuiViewActions.test.ts`

**Interfaces:**

- Consumes: `deriveMnemonics` (unchanged).
- Produces: `buildContextBindings` keymaps with `c: "chat"` in every main context and in the `detail`/`prDetail`/`prs`/`review`/`transcript` overlays; no `commands` id anywhere; `t: "transcript"` only on the issues body (every pane). `Chip.key` strings unchanged. Chip ORDER is not this task's concern (Task 2 re-groups); only the id sets and keymaps are.

- [ ] **Step 1: Rewrite the pins (failing tests)**

In `tests/tuiViewActions.test.ts` replace the `GLOBALS` constant and the pane-scoping tests:

```ts
const GLOBALS = {
  c: "chat",
  a: "addRepo",
  U: "unwatch",
  b: "browser",
  r: "refresh",
  u: "assess",
  e: "queue",
  v: "review",
  p: "prs",
  q: "quit",
  "?": "help",
};
```

Replace the R27 test (`t is pane-scoped in the issues body…`) with:

```ts
it("c is chat on every pane of every main body; t is the transcript on the issue list only (spec 2026-09-02 D5)", () => {
  for (const pane of [1, 2, 3] as const) {
    expect(km(main("issues", pane))).toMatchObject({ c: "chat", t: "transcript" });
    expect(km(main("repoDetail", pane))).toEqual({ ...GLOBALS });
    expect(km(main("queue", pane))).toMatchObject({ c: "chat", t: "retry" });
  }
});
it("the palette has no mnemonic — `:` is structural, `c` belongs to chat", () => {
  for (const body of [
    "issues",
    "repoDetail",
    "queue",
    "outbox",
    "worktrees",
    "daemon",
    "logs",
  ] as const)
    expect(Object.values(km(main(body)))).not.toContain("commands");
});
it("overlays with a repo in context derive c → chat, appended after their existing keys", () => {
  expect(km({ kind: "view", view: "detail" })).toEqual({
    b: "browser",
    q: "close",
    c: "chat",
    t: "transcript",
  });
  expect(km({ kind: "view", view: "prDetail" })).toEqual({ b: "browser", q: "close", c: "chat" });
  expect(km({ kind: "view", view: "prs" })).toEqual({ b: "browser", q: "close", c: "chat" });
  expect(km({ kind: "view", view: "review" })).toEqual({
    a: "all",
    n: "none",
    f: "file",
    D: "discard",
    q: "close",
    s: "submit",
    e: "edit",
    r: "route",
    c: "chat",
  });
  expect(km({ kind: "view", view: "transcript" })).toEqual({
    t: "thinking",
    f: "follow",
    q: "close",
    c: "chat",
  });
  expect(km({ kind: "view", view: "cmdOutput" })).toEqual({ r: "reRun", q: "close" });
  expect(km({ kind: "view", view: "chat" })).not.toHaveProperty("c");
});
```

Update `main:issues` to `{ ...GLOBALS, m: "dispatch", o: "approve", n: "analyze", t: "transcript", I: "dispatchAsk", A: "assessAutoPlan", R: "replan" }` (unchanged apart from `GLOBALS`). Delete the assertions that a chip must NOT advertise chat on the issue list (they were R27's; the pill is now correct there) — keep the "no chip lies" idea as: `expect(chipIds(main("issues", 2))).toContain("chat")`.

In `tests/tuiApp.chat.test.tsx`, every `fireUntil(r.stdin, "t", …)` that opens the chat becomes `"c"`; the test that asserts `t` on the issue LIST opens the transcript stays.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/tuiViewActions.test.ts tests/tuiApp.chat.test.tsx > /tmp/t1 2>&1; echo "exit: $?"` — expected 1 (`c` derives `commands`, overlays have no `c`).

- [ ] **Step 3: Implement**

`src/tui/viewActions.ts`:

```ts
/** Canonical global order — identical prefix in EVERY main context, so the
 * shared verbs derive the same key regardless of body (spec §2). `chat` leads
 * (spec 2026-09-02 D5): it claims `c` before anything else can, so the chat
 * pill's letter is the same on every screen. The palette has no entry — its
 * key is the fixed `:` (App layer 3c), listed on the navigation row. */
const MAIN_GLOBALS: MnemonicOption[] = [
  { id: "chat", label: "chat" },
  { id: "addRepo", label: "add repo" },
  { id: "unwatch", label: "unwatch", guarded: true },
  { id: "browser", label: "browser" },
  { id: "refresh", label: "refresh" },
  { id: "assess", label: "audit" },
  { id: "queue", label: "queue" },
  { id: "review", label: "review" },
  { id: "prs", label: "PRs" },
  { id: "quit", label: "quit" },
  { id: "help", label: "help" },
];
```

`BODY_VERBS.issues`: replace the `chat` entry with `{ id: "transcript", label: "transcript" }` (t derives on every pane; #330's reading is now the only one); `repoDetail: []` (chat is a global now). Delete `bodyVerbs` and use `BODY_VERBS[context.body]` directly — but keep `BindingContext.main.pane` (the chip subset is still pane-scoped, Task 2 reads it).

`VIEW_OPTIONS`: append `{ id: "chat", label: "chat" }` to `detail` (after `browser`, before `CLOSE`, plus `{ id: "transcript", label: "transcript" }` after it — the detail overlay's `t`), `prDetail`, `prs`, `review` (last), `transcript` (last). Not `cmdOutput`, not `chat`.

Chip orders (Task 2 replaces the assembly, but the ids must exist now): `RAIL_CHIP_ORDER = ["chat", "assess", "browser", "refresh", "addRepo", "unwatch", "queue", "review", "prs", "quit", "help"]`; `ISSUES_CHIP_ORDER = ["chat", "dispatch", "approve", "analyze", "transcript", "assess", "browser", "prs", "review", "queue", "quit", "help"]`; `PANE3_CHIP_ORDER = ["chat", "browser", "prs", "review", "quit", "help"]`; the section bodies keep `bodyVerbs`-equivalent (`BODY_VERBS[body]` visible ids) plus `["review", "prs"]`.

Update the file's header comment: the spec pointer gains `2026-09-02-footer-redesign-design.md §4–§5`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/tuiViewActions.test.ts tests/tuiApp.chat.test.tsx tests/tuiApp.test.tsx tests/useMainActions.test.tsx tests/useViewActions.test.tsx tests/tuiModal.test.tsx > /tmp/t1 2>&1; echo "exit: $?"` — expected 0. If `tests/tuiModal.test.tsx` pins the `t on a repo row` help line, leave it failing until Task 6 ONLY if the failure is that line; otherwise fix here.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/viewActions.ts tests/tuiViewActions.test.ts tests/tuiApp.chat.test.tsx
git add src/tui/viewActions.ts tests/tuiViewActions.test.ts tests/tuiApp.chat.test.tsx
git commit -m "feat(tui): c is chat in every context; the palette keeps only its fixed :; t is transcript only"
```

---

### Task 2: `footerModel.ts` — one `ContextBindings` → two `FooterRow`s (pure)

**Files:**

- Create: `src/tui/footerModel.ts`
- Test: `tests/footerModel.test.ts`

**Interfaces:**

- Consumes: `ContextBindings`, `Chip`, `BindingContext` (`src/tui/viewActions.ts`); `LayoutMode` (`src/tui/layout.ts`).
- Produces:

  ```ts
  export type FooterChipKind = "pill" | "mnemonic" | "structural" | "separator";
  export interface FooterChip {
    kind: FooterChipKind;
    /** Dispatch key: mnemonic/pill → derived letter; structural → the Chip.key STRING. */
    key: string;
    label: string;
    charIndex: number | null; // pill/mnemonic: lit-letter index in label
    guarded: boolean;
    /** Mnemonic id (pill/mnemonic) or the structural key — the chipActions lookup key. */
    id: string;
  }
  export interface FooterRow {
    label: string;
    chips: FooterChip[];
    pinned: FooterChip[];
  }
  export interface FooterRows {
    actions: FooterRow;
    navigate: FooterRow;
  }
  export interface FooterInput {
    context: BindingContext;
    bindings: ContextBindings;
    /** Row-1 target label (spec §3.1): "acme/api", "issue #46", "queue", "chat · acme/api"… */
    target: string;
    /** A repo is in context → the chat pill renders; else it is absent. */
    chatReachable: boolean;
    mode: LayoutMode;
  }
  export function buildFooterRows(input: FooterInput): FooterRows;
  /** Key string → display glyph (dispatch keys never change): enter→⏎, ↑/↓→↑↓, ←/→→←→, [/]→[ ], "[ ]"→[ ], esc/p→esc·p; anything else verbatim. */
  export function keyGlyph(key: string): string;
  export interface Segment {
    text: string;
    accent: boolean;
    underline: boolean;
    keycap: boolean;
    pill: boolean;
    dim: boolean;
  }
  /** The one styling model both the renderer and the tests consume (spec §3.4). */
  export function footerSegments(chip: FooterChip): Segment[];
  export const TARGET_WIDTH = 16; // spec §3.1: target label slot
  export const NAV_DROP_MEDIUM = new Set(["g/G", ":", ","]); // spec §3.2
  ```

- [ ] **Step 1: Write the failing tests**

`tests/footerModel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildContextBindings, type BindingContext } from "../src/tui/viewActions.js";
import {
  buildFooterRows,
  footerSegments,
  keyGlyph,
  TARGET_WIDTH,
  type FooterChip,
} from "../src/tui/footerModel.js";

const rows = (
  context: BindingContext,
  over: { target?: string; chatReachable?: boolean; mode?: "wide" | "medium" } = {},
) =>
  buildFooterRows({
    context,
    bindings: buildContextBindings(context, over.mode ?? "wide"),
    target: over.target ?? "acme/api",
    chatReachable: over.chatReachable ?? true,
    mode: over.mode ?? "wide",
  });
const texts = (chips: FooterChip[]): string[] =>
  chips.map((c) => (c.kind === "separator" ? "│" : `${c.kind}:${c.id}:${c.label}`));

describe("buildFooterRows — main view (spec 2026-09-02 §4)", () => {
  it("rail, repo row: pill, repo verbs, │, go-globals; navigate has the stable vocabulary", () => {
    const r = rows({ kind: "main", body: "issues", pane: 1 });
    expect(r.actions.label).toBe("acme/api");
    expect(texts(r.actions.chips)).toEqual([
      "pill:chat:chat",
      "mnemonic:assess:audit",
      "mnemonic:browser:browser",
      "mnemonic:refresh:refresh",
      "mnemonic:addRepo:add repo",
      "mnemonic:unwatch:unwatch",
      "│",
      "mnemonic:queue:queue",
      "mnemonic:review:review",
      "mnemonic:prs:PRs",
    ]);
    expect(r.navigate.label).toBe("navigate");
    expect(texts(r.navigate.chips)).toEqual([
      "structural:↑/↓:move",
      "structural:→:issues",
      "structural:enter:detail",
      "structural:g/G:first/last",
      "structural:::palette",
      "structural:,:config",
    ]);
    expect(texts(r.navigate.pinned)).toEqual(["mnemonic:help:help", "mnemonic:quit:quit"]);
  });
  it("issue list (pane 2): pill first, body verbs, browser, │, go-globals; / filter and ←→ panes on navigate", () => {
    const r = rows({ kind: "main", body: "issues", pane: 2 }, { target: "issue #46" });
    expect(texts(r.actions.chips)).toEqual([
      "pill:chat:chat",
      "mnemonic:dispatch:import",
      "mnemonic:approve:approve",
      "mnemonic:analyze:investigate",
      "mnemonic:transcript:transcript",
      "mnemonic:assess:audit",
      "mnemonic:browser:browser",
      "│",
      "mnemonic:prs:PRs",
      "mnemonic:review:review",
      "mnemonic:queue:queue",
    ]);
    expect(texts(r.navigate.chips)).toEqual([
      "structural:↑/↓:move",
      "structural:←/→:panes",
      "structural:enter:preview",
      "structural:/:filter",
      "structural:g/G:first/last",
      "structural:::palette",
      "structural:,:config",
    ]);
  });
  it("PR pane (pane 3): pill, browser │ PRs, review", () => {
    const r = rows({ kind: "main", body: "issues", pane: 3 }, { target: "PR #12" });
    expect(texts(r.actions.chips)).toEqual([
      "pill:chat:chat",
      "mnemonic:browser:browser",
      "│",
      "mnemonic:prs:PRs",
      "mnemonic:review:review",
    ]);
    expect(texts(r.navigate.chips)).toEqual([
      "structural:↑/↓:move",
      "structural:enter:detail",
      "structural:←:issues",
      "structural:g/G:first/last",
      "structural:::palette",
      "structural:,:config",
    ]);
  });
  it("a system body has no pill (chatReachable false) and lists its own verbs │ review, PRs", () => {
    const r = rows(
      { kind: "main", body: "queue", pane: 2 },
      { target: "queue", chatReachable: false },
    );
    expect(texts(r.actions.chips)).toEqual([
      "mnemonic:retry:retry",
      "mnemonic:delete:delete",
      "│",
      "mnemonic:review:review",
      "mnemonic:prs:PRs",
    ]);
    expect(texts(r.navigate.chips)).toEqual([
      "structural:↑/↓:move",
      "structural:enter:transcript",
      "structural:←:rail",
      "structural:g/G:first/last",
      "structural:::palette",
      "structural:,:config",
    ]);
  });
  it("medium width drops g/G, : and , from navigate and nothing from actions", () => {
    const r = rows({ kind: "main", body: "issues", pane: 2 }, { mode: "medium" });
    expect(texts(r.navigate.chips)).toEqual([
      "structural:↑/↓:move",
      "structural:←:repos",
      "structural:enter:preview",
      "structural:/:filter",
    ]);
    expect(r.actions.chips[0]!.kind).toBe("pill");
  });
  it("the target label is truncated to TARGET_WIDTH", () => {
    const r = rows({ kind: "main", body: "issues", pane: 1 }, { target: "x".repeat(40) });
    expect(r.actions.label).toHaveLength(TARGET_WIDTH);
    expect(r.actions.label.endsWith("…")).toBe(true);
  });
});

describe("buildFooterRows — overlays and text-owning contexts", () => {
  it("issue detail: pill, browser, transcript; navigate scroll + esc; pinned help + close", () => {
    const r = rows({ kind: "view", view: "detail" }, { target: "#46" });
    expect(texts(r.actions.chips)).toEqual([
      "pill:chat:chat",
      "mnemonic:browser:browser",
      "mnemonic:transcript:transcript",
    ]);
    expect(texts(r.navigate.chips)).toEqual(["structural:↑/↓:scroll", "structural:esc:back"]);
    expect(texts(r.navigate.pinned)).toEqual(["mnemonic:help:help", "mnemonic:close:close"]);
  });
  it("review: pill leads when the selected item has a repo, absent otherwise", () => {
    expect(texts(rows({ kind: "view", view: "review" }).actions.chips)[0]).toBe("pill:chat:chat");
    expect(
      texts(rows({ kind: "view", view: "review" }, { chatReachable: false }).actions.chips)[0],
    ).toBe("mnemonic:all:all");
  });
  it("chat view, composer focused: ⏎ send is the pill; navigate is the blurred-keys reminder", () => {
    const r = rows({ kind: "structuralOnly", view: "chatCompose" }, { target: "chat · acme/api" });
    expect(texts(r.actions.chips)).toEqual([
      "pill:enter:send",
      "structural:ctrl+j:newline",
      "structural:/:commands",
      "structural:esc:blur/abort",
    ]);
    expect(r.navigate.label).toBe("");
    expect(r.navigate.chips.map((c) => c.label).join(" ")).toContain("esc, then");
  });
  it("chat view, blurred: draft verbs on actions, i compose + movement on navigate", () => {
    const r = rows({ kind: "view", view: "chat" }, { target: "chat · acme/api" });
    expect(texts(r.actions.chips)).toEqual([
      "mnemonic:submit:submit",
      "mnemonic:edit:edit",
      "mnemonic:discard:discard",
      "mnemonic:route:route",
      "mnemonic:thinking:thinking",
      "mnemonic:follow:follow",
    ]);
    expect(texts(r.navigate.chips)).toEqual([
      "structural:i:compose",
      "structural:↑/↓:move",
      "structural:enter:expand",
      "structural:[/]:scroll",
      "structural:esc:back",
    ]);
  });
  it("palette / filtering / config / help: structural chips on navigate, actions carries only the label", () => {
    const r = rows({ kind: "structuralOnly", view: "palette" }, { target: "palette" });
    expect(r.actions.chips).toEqual([]);
    expect(r.actions.label).toBe("palette");
    expect(texts(r.navigate.chips)).toEqual([
      "structural:type:filter",
      "structural:↑/↓:move",
      "structural:enter:run",
      "structural:esc:close",
    ]);
    expect(r.navigate.pinned).toEqual([]);
  });
  it("log overlay: verbs on actions, search/scroll/bottom/close on navigate", () => {
    const r = rows({ kind: "logOverlay" }, { target: "logs", chatReachable: false });
    expect(texts(r.actions.chips)).toEqual([
      "mnemonic:follow:follow",
      "mnemonic:level:level",
      "mnemonic:ticket:ticket",
    ]);
    expect(texts(r.navigate.chips)).toEqual([
      "structural:/:search",
      "structural:[ ]:scroll",
      "structural:G:bottom",
      "structural:esc:close",
    ]);
  });
});

describe("keyGlyph and footerSegments (spec §3.4)", () => {
  it("maps dispatch key strings to glyphs without changing the strings", () => {
    expect(keyGlyph("enter")).toBe("⏎");
    expect(keyGlyph("↑/↓")).toBe("↑↓");
    expect(keyGlyph("←/→")).toBe("←→");
    expect(keyGlyph("[/]")).toBe("[ ]");
    expect(keyGlyph("esc/p")).toBe("esc·p");
    expect(keyGlyph("g/G")).toBe("g G");
    expect(keyGlyph("esc")).toBe("esc");
  });
  it("a mnemonic lights one letter: accent + underline; the rest plain", () => {
    expect(
      footerSegments({
        kind: "mnemonic",
        id: "refresh",
        key: "r",
        label: "refresh",
        charIndex: 0,
        guarded: false,
      }),
    ).toEqual([
      { text: "r", accent: true, underline: true, keycap: false, pill: false, dim: false },
      { text: "efresh", accent: false, underline: false, keycap: false, pill: false, dim: false },
    ]);
  });
  it("a guarded mnemonic uppercases the lit letter in place", () => {
    const segs = footerSegments({
      kind: "mnemonic",
      id: "unwatch",
      key: "U",
      label: "unwatch",
      charIndex: 0,
      guarded: true,
    });
    expect(segs[0]).toMatchObject({ text: "U", accent: true, underline: true });
  });
  it("a pill is every segment pill-flagged, with the lit letter underlined", () => {
    expect(
      footerSegments({
        kind: "pill",
        id: "chat",
        key: "c",
        label: "chat",
        charIndex: 0,
        guarded: false,
      }),
    ).toEqual([
      { text: " ", accent: false, underline: false, keycap: false, pill: true, dim: false },
      { text: "c", accent: false, underline: true, keycap: false, pill: true, dim: false },
      { text: "hat ", accent: false, underline: false, keycap: false, pill: true, dim: false },
    ]);
  });
  it("a structural chip is a keycap glyph then a plain label", () => {
    expect(
      footerSegments({
        kind: "structural",
        id: "enter",
        key: "enter",
        label: "preview",
        charIndex: null,
        guarded: false,
      }),
    ).toEqual([
      { text: " ⏎ ", accent: false, underline: false, keycap: true, pill: false, dim: false },
      { text: " preview", accent: false, underline: false, keycap: false, pill: false, dim: false },
    ]);
  });
  it("a separator is one dim │", () => {
    expect(
      footerSegments({
        kind: "separator",
        id: "|",
        key: "",
        label: "",
        charIndex: null,
        guarded: false,
      }),
    ).toEqual([
      { text: "│", accent: false, underline: false, keycap: false, pill: false, dim: true },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/footerModel.test.ts > /tmp/t2 2>&1; echo "exit: $?"` — expected 1 (module not found).

- [ ] **Step 3: Implement `src/tui/footerModel.ts`**

```ts
/**
 * The two-row footer model (spec 2026-09-02 §3–§4): ONE ContextBindings plus a
 * target label become an actions row (the chat pill, the context's verbs, │,
 * the go-somewhere globals) and a navigate row (the structural vocabulary,
 * with ? help and q pinned right). Pure — the renderer (Chrome.tsx Footer)
 * and the tests both consume `footerSegments`, so accent placement is
 * asserted here, never from ANSI-stripped frames. Dispatch keys are the
 * Chip.key STRINGS (chipActions maps structural chips by key); `keyGlyph`
 * only changes what is drawn.
 */
import type { BindingContext, Chip, ContextBindings, MainBody } from "./viewActions.js";
import type { LayoutMode } from "./layout.js";

export type FooterChipKind = "pill" | "mnemonic" | "structural" | "separator";
export interface FooterChip {
  kind: FooterChipKind;
  key: string;
  label: string;
  charIndex: number | null;
  guarded: boolean;
  id: string;
}
export interface FooterRow {
  label: string;
  chips: FooterChip[];
  pinned: FooterChip[];
}
export interface FooterRows {
  actions: FooterRow;
  navigate: FooterRow;
}
export interface FooterInput {
  context: BindingContext;
  bindings: ContextBindings;
  target: string;
  chatReachable: boolean;
  mode: LayoutMode;
}

export const TARGET_WIDTH = 16;
/** Navigate chips dropped below WIDE_COLS (they stay in the keymap + help). */
export const NAV_DROP_MEDIUM: ReadonlySet<string> = new Set(["g/G", ":", ","]);
const SEP: FooterChip = {
  kind: "separator",
  id: "|",
  key: "",
  label: "",
  charIndex: null,
  guarded: false,
};
/** Main-view globals that go on the RIGHT of │ (spec §3.1 "go somewhere"). */
const GO_IDS: ReadonlySet<string> = new Set(["queue", "review", "prs"]);
/** Pinned-right ids, in order; `close` is the overlays' q. */
const PINNED_IDS = ["help", "quit", "close"];

const GLYPHS: Record<string, string> = {
  enter: "⏎",
  "↑/↓": "↑↓",
  "←/→": "←→",
  "[/]": "[ ]",
  "esc/p": "esc·p",
  "g/G": "g G",
};
export function keyGlyph(key: string): string {
  return GLYPHS[key] ?? key;
}

const s = (key: string, label: string): FooterChip => ({
  kind: "structural",
  id: key,
  key,
  label,
  charIndex: null,
  guarded: false,
});
function fromChip(c: Chip): FooterChip {
  return c.kind === "structural"
    ? s(c.key, c.label)
    : {
        kind: "mnemonic",
        id: c.id,
        key: c.key,
        label: c.label,
        charIndex: c.charIndex,
        guarded: c.guarded,
      };
}

/** Spec §3.2: one vocabulary; only the ⏎/←/→ labels say what they do here. */
function navigateChips(context: BindingContext, mode: LayoutMode): FooterChip[] {
  const common = [s("g/G", "first/last"), s(":", "palette"), s(",", "config")];
  let out: FooterChip[];
  if (context.kind === "main") {
    const { body, pane } = context;
    if (pane === 1) out = [s("↑/↓", "move"), s("→", "issues"), s("enter", "detail"), ...common];
    else if (pane === 3)
      out = [s("↑/↓", "move"), s("enter", "detail"), s("←", "issues"), ...common];
    else out = [...mainBodyNav(body, mode), ...common];
  } else {
    // Overlays / text-owning contexts: their structural chips ARE the vocabulary
    // (viewStructural / structuralOnly / LOG_OVERLAY_STRUCTURAL), unchanged wording.
    out = [];
  }
  return mode === "medium" ? out.filter((c) => !NAV_DROP_MEDIUM.has(c.key)) : out;
}
function mainBodyNav(body: MainBody, mode: LayoutMode): FooterChip[] {
  switch (body) {
    case "issues":
      return [
        s("↑/↓", "move"),
        mode === "wide" ? s("←/→", "panes") : s("←", "repos"),
        s("enter", "preview"),
        s("/", "filter"),
      ];
    case "repoDetail":
      return [s("[/]", "scroll"), s("←", "rail")];
    case "queue":
      return [s("↑/↓", "move"), s("enter", "transcript"), s("←", "rail")];
    case "outbox":
    case "worktrees":
      return [s("↑/↓", "move"), s("←", "rail")];
    case "daemon":
      return [s("[/]", "scroll"), s("←", "rail")];
    case "logs":
      return [s("enter", "open log"), s("←", "rail")];
  }
}

export function buildFooterRows({
  context,
  bindings,
  target,
  chatReachable,
  mode,
}: FooterInput): FooterRows {
  const label = target.length > TARGET_WIDTH ? `${target.slice(0, TARGET_WIDTH - 1)}…` : target;
  const structural = bindings.chips.filter((c) => c.kind === "structural").map(fromChip);
  const mnemonics = bindings.chips.flatMap((c) => (c.kind === "mnemonic" ? [fromChip(c)] : []));
  const pinned = PINNED_IDS.flatMap((id) => mnemonics.filter((m) => m.id === id));
  const verbs = mnemonics.filter((m) => !PINNED_IDS.includes(m.id));

  if (context.kind === "structuralOnly" && context.view === "chatCompose") {
    // Spec §4: the composer owns the keys; ⏎ send is the view's primary.
    return {
      actions: {
        label,
        chips: [
          {
            kind: "pill",
            id: "enter",
            key: "enter",
            label: "send",
            charIndex: null,
            guarded: false,
          },
          s("ctrl+j", "newline"),
          s("/", "commands"),
          s("esc", "blur/abort"),
        ],
        pinned: [],
      },
      navigate: {
        label: "",
        chips: [
          s(
            "",
            "esc, then ↑↓ move · ⏎ expand · [ ] scroll · s e r D on a draft · t thinking · f follow",
          ),
        ],
        pinned: [],
      },
    };
  }
  if (context.kind === "structuralOnly") {
    return {
      actions: { label, chips: [], pinned: [] },
      navigate: { label: "navigate", chips: structural, pinned: [] },
    };
  }

  const chat = verbs.find((m) => m.id === "chat");
  const rest = verbs.filter((m) => m.id !== "chat");
  const pill = chat !== undefined && chatReachable ? [{ ...chat, kind: "pill" as const }] : [];
  let actions: FooterChip[];
  if (context.kind === "main") {
    const here = rest.filter((m) => !GO_IDS.has(m.id));
    const go = rest.filter((m) => GO_IDS.has(m.id));
    actions = [...pill, ...here, ...(go.length > 0 ? [SEP, ...go] : [])];
  } else {
    actions = [...pill, ...rest];
  }
  const navigate = context.kind === "main" ? navigateChips(context, mode) : structural;
  return {
    actions: { label, chips: actions, pinned: [] },
    navigate: { label: "navigate", chips: navigate, pinned },
  };
}

export interface Segment {
  text: string;
  accent: boolean;
  underline: boolean;
  keycap: boolean;
  pill: boolean;
  dim: boolean;
}
const seg = (text: string, over: Partial<Segment> = {}): Segment => ({
  text,
  accent: false,
  underline: false,
  keycap: false,
  pill: false,
  dim: false,
  ...over,
});
export function footerSegments(chip: FooterChip): Segment[] {
  switch (chip.kind) {
    case "separator":
      return [seg("│", { dim: true })];
    case "structural":
      return [seg(` ${keyGlyph(chip.key)} `, { keycap: true }), seg(` ${chip.label}`)];
    case "pill": {
      if (chip.charIndex === null)
        return [seg(` ${keyGlyph(chip.key)} ${chip.label} `, { pill: true })];
      const i = chip.charIndex;
      const ch = chip.guarded ? chip.label[i]!.toUpperCase() : chip.label[i]!;
      return [
        seg(` ${chip.label.slice(0, i)}`, { pill: true }),
        seg(ch, { pill: true, underline: true }),
        seg(`${chip.label.slice(i + 1)} `, { pill: true }),
      ].filter((x) => x.text !== "");
    }
    case "mnemonic": {
      if (chip.charIndex === null)
        return [seg(chip.key, { accent: true, underline: true }), seg(` ${chip.label}`)];
      const i = chip.charIndex;
      const ch = chip.guarded ? chip.label[i]!.toUpperCase() : chip.label[i]!;
      return [
        ...(i > 0 ? [seg(chip.label.slice(0, i))] : []),
        seg(ch, { accent: true, underline: true }),
        ...(i + 1 < chip.label.length ? [seg(chip.label.slice(i + 1))] : []),
      ];
    }
  }
}
```

Adjust the main-view ORDER inputs so the tests' sequences hold: the actions order comes from `bindings.chips` order, so Task 1's `RAIL_CHIP_ORDER` / `ISSUES_CHIP_ORDER` / `PANE3_CHIP_ORDER` must list `chat` first, then the row verbs in the tests' order, then the go ids in the tests' order (rail: queue, review, prs; issues: prs, review, queue; pane 3: prs, review). Section bodies: `[...BODY_VERBS visible ids, "review", "prs"]`. The `mainStructural` chips in `viewActions.ts` are no longer read by the model for main contexts (navigateChips owns them) — delete `mainStructural` and its call in `buildContextBindings` so there is one source; `viewStructural`/`structuralOnly`/`LOG_OVERLAY_STRUCTURAL` stay (they are the overlays' vocabulary).

The pill test for `chat` expects `" "` + `"c"` + `"hat "` — `charIndex` 0 gives an empty prefix, which the `.filter` above turns into the leading `" "` segment being `" "` (prefix `""` → `" "`); keep the filter so a mid-label lit letter yields `" cha"`, `"t"`, `" "`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/footerModel.test.ts tests/tuiViewActions.test.ts > /tmp/t2 2>&1; echo "exit: $?"` — expected 0. `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/footerModel.ts src/tui/viewActions.ts tests/footerModel.test.ts tests/tuiViewActions.test.ts
git add src/tui/footerModel.ts src/tui/viewActions.ts tests/footerModel.test.ts tests/tuiViewActions.test.ts
git commit -m "feat(tui): footer model — actions/navigate rows, chat pill, key glyphs, medium drops"
```

---

### Task 3: The two-row `Footer` renderer — toast absorbed, `Toast` deleted, `Workspace` takes rows

**Files:**

- Modify: `src/tui/theme.ts` (two tokens), `src/tui/components/Chrome.tsx` (`Footer` ~261-300 rewritten, `Toast` ~216-232 and `chipSegments` ~238-256 deleted), `src/tui/components/Workspace.tsx` (props `chips`→`footer`, drop `<Toast>`), `src/tui/App.tsx` (the ONE `<Workspace … chips={bindings.chips}` prop → `footer={footerRows}`; a temporary `footerRows` memo — Task 4 moves it into a hook)
- Test: `tests/tuiChrome.test.tsx` (replace the `Toast`, `chipSegments` and `Footer (chips)` describes), `tests/tuiWorkspace.test.tsx` (if it exists — grep; else the Workspace assertions go into `tuiChrome.test.tsx`)

**Interfaces:**

- Consumes: `FooterRows`, `FooterChip`, `footerSegments` (Task 2); `ToastKind`, `toastColor` (`theme.ts`).
- Produces:

  ```ts
  // theme.ts
  export const theme = { …existing, keycapBg: "#3b4261", pillFg: "#16161e" } as const;
  // Chrome.tsx
  export function Footer(props: {
    rows: FooterRows;
    toast: { kind: ToastKind; text: string } | null;   // non-null → replaces the ACTIONS row
    chipActions?: Record<string, () => void>;           // unchanged contract: pill/mnemonic by id, structural by key
  }): React.JSX.Element;                                 // exactly 2 rows tall
  // Workspace.tsx
  props: { …, toast, footer: FooterRows, chipActions? }   // `chips` removed; renders <Footer rows toast chipActions/> as its last child
  ```

- [ ] **Step 1: Write the failing tests**

In `tests/tuiChrome.test.tsx` delete `describe("Toast", …)`, `describe("chipSegments …", …)` and `describe("Footer (chips)", …)`; add:

```tsx
import { Footer } from "../src/tui/components/Chrome.js";
import type { FooterRows } from "../src/tui/footerModel.js";

const rows: FooterRows = {
  actions: {
    label: "issue #46",
    chips: [
      { kind: "pill", id: "chat", key: "c", label: "chat", charIndex: 0, guarded: false },
      { kind: "mnemonic", id: "dispatch", key: "m", label: "import", charIndex: 1, guarded: false },
      { kind: "mnemonic", id: "delete", key: "D", label: "delete", charIndex: 0, guarded: true },
      { kind: "separator", id: "|", key: "", label: "", charIndex: null, guarded: false },
      { kind: "mnemonic", id: "prs", key: "p", label: "PRs", charIndex: 0, guarded: false },
    ],
    pinned: [],
  },
  navigate: {
    label: "navigate",
    chips: [
      { kind: "structural", id: "↑/↓", key: "↑/↓", label: "move", charIndex: null, guarded: false },
      {
        kind: "structural",
        id: "enter",
        key: "enter",
        label: "preview",
        charIndex: null,
        guarded: false,
      },
    ],
    pinned: [
      { kind: "mnemonic", id: "help", key: "?", label: "help", charIndex: null, guarded: false },
      { kind: "mnemonic", id: "quit", key: "q", label: "quit", charIndex: 0, guarded: false },
    ],
  },
};

describe("Footer (two rows, spec 2026-09-02 §3)", () => {
  it("renders the actions row then the navigate row — exactly two lines, labels first", () => {
    const f = render(<Footer rows={rows} toast={null} />).lastFrame()!;
    const lines = f.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ issue #46 +chat +import +Delete +│ +PRs/);
    expect(lines[1]).toMatch(/^ navigate +↑↓ move +⏎ preview/);
  });
  it("pins ? help and quit to the right edge of the navigate row", () => {
    const f = render(<Footer rows={rows} toast={null} />, { columns: 80 } as never).lastFrame()!;
    const nav = f.split("\n")[1]!;
    expect(nav.trimEnd().endsWith("? help  quit")).toBe(true);
    expect(nav.trimEnd().length).toBeGreaterThan(60); // the spacer pushed them right
  });
  it("a toast replaces the actions row only; the navigate row stays", () => {
    const f = render(
      <Footer rows={rows} toast={{ kind: "error", text: "gh boom\nline 2" }} />,
    ).lastFrame()!;
    const lines = f.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("gh boom · line 2");
    expect(lines[0]).not.toContain("import");
    expect(lines[1]).toContain("↑↓ move");
  });
  it("pads both labels to the same width so the chips start in one column", () => {
    const f = render(<Footer rows={rows} toast={null} />).lastFrame()!;
    const [a, n] = f.split("\n");
    expect(a!.indexOf("chat")).toBe(n!.indexOf("↑↓"));
  });
  it("clips a long row without wrapping", () => {
    const wide = {
      ...rows,
      actions: {
        ...rows.actions,
        chips: Array.from({ length: 30 }, (_, i) => ({
          kind: "mnemonic" as const,
          id: `v${i}`,
          key: "x",
          label: `verb-number-${i}`,
          charIndex: 0,
          guarded: false,
        })),
      },
    };
    const f = render(<Footer rows={wide} toast={null} />, { columns: 60 } as never).lastFrame()!;
    expect(f.split("\n")).toHaveLength(2);
  });
  it("chips with a chipActions entry are clickable by id (pill/mnemonic) or key (structural)", async () => {
    // SGR press at 0-based cell (x, y) — the same wire format tests/tuiMouseApp.test.tsx uses.
    const press = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;
    const hits: string[] = [];
    const r = render(
      <MouseProvider>
        <Footer
          rows={rows}
          toast={null}
          chipActions={{ chat: () => hits.push("chat"), enter: () => hits.push("enter") }}
        />
      </MouseProvider>,
    );
    await until(() => (r.lastFrame() ?? "").includes("chat"));
    const [a, n] = r.lastFrame()!.split("\n");
    await fireUntil(r.stdin, press(a!.indexOf("chat"), 0), () => hits.includes("chat"));
    await fireUntil(r.stdin, press(n!.indexOf("⏎"), 1), () => hits.includes("enter"));
    expect(hits).toEqual(["chat", "enter"]);
  });
});
```

(`MouseProvider` from `../src/tui/MouseProvider.js`; `until`/`fireUntil` from `./helpers/until.js`. `fireUntil` re-sends the press until the hit-region registration effect has run — a press can race a freshly mounted ClickableBox, see the helper's comment.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/tuiChrome.test.tsx > /tmp/t3 2>&1; echo "exit: $?"` — expected 1 (`rows` prop unknown; `Toast` still exported).

- [ ] **Step 3: Implement**

`src/tui/theme.ts`:

```ts
export const theme = {
  accent: "#eb6f92",
  selectionBg: "#2a2e3a",
  hoverBg: "#20242f",
  border: "gray",
  success: "green",
  warn: "yellow",
  error: "red",
  info: "cyan",
  /** Footer structural keycaps (spec 2026-09-02 §3.4): muted fill, default fg. */
  keycapBg: "#3b4261",
  /** Text on the accent-filled chat pill — the dark terminal ground. */
  pillFg: "#16161e",
} as const;
```

`src/tui/components/Chrome.tsx` — delete `Toast` and `chipSegments`; replace `Footer`:

```tsx
import {
  footerSegments,
  type FooterChip,
  type FooterRow,
  type FooterRows,
} from "../footerModel.js";

function SegmentText({ chip }: { chip: FooterChip }): React.JSX.Element {
  return (
    <Text>
      {footerSegments(chip).map((s, j) => (
        <Text
          key={j}
          color={s.pill ? theme.pillFg : s.accent ? theme.accent : undefined}
          backgroundColor={s.pill ? theme.accent : s.keycap ? theme.keycapBg : undefined}
          bold={s.pill || s.accent}
          underline={s.underline}
          dimColor={s.dim}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

function ChipRun({
  chips,
  chipActions,
}: {
  chips: FooterChip[];
  chipActions?: Record<string, () => void>;
}): React.JSX.Element {
  return (
    <>
      {chips.map((chip, i) => {
        const run = chip.kind === "separator" ? undefined : chipActions?.[chip.id];
        const body = <SegmentText chip={chip} />;
        return (
          <Box key={`${chip.id}-${i}`} flexShrink={0} marginRight={2}>
            {run ? (
              <ClickableBox onPress={run} hoverBg={theme.hoverBg}>
                {body}
              </ClickableBox>
            ) : (
              body
            )}
          </Box>
        );
      })}
    </>
  );
}

/** One footer row: dim label in a fixed-width slot, the chips, a spacer, the
 * pinned chips. `overflow="hidden"` + `flexShrink={0}` chips = clip, never wrap. */
function FooterLine({
  row,
  labelWidth,
  chipActions,
}: {
  row: FooterRow;
  labelWidth: number;
  chipActions?: Record<string, () => void>;
}): React.JSX.Element {
  return (
    <Box paddingX={1} height={1} overflow="hidden">
      <Box width={labelWidth} flexShrink={0} marginRight={2}>
        <Text dimColor wrap="truncate">
          {row.label}
        </Text>
      </Box>
      <ChipRun chips={row.chips} chipActions={chipActions} />
      <Box flexGrow={1} />
      <ChipRun chips={row.pinned} chipActions={chipActions} />
    </Box>
  );
}

/** Rows n-1 and n (spec 2026-09-02 §3): actions above, navigate below. A live
 * toast paints over the ACTIONS row for its lifetime (useToast: 4 s or the
 * next keystroke) — navigation is never hidden. Both labels share one slot
 * width so the two chip runs start in the same column. */
export function Footer({
  rows,
  toast,
  chipActions,
}: {
  rows: FooterRows;
  toast: { kind: ToastKind; text: string } | null;
  chipActions?: Record<string, () => void>;
}): React.JSX.Element {
  const labelWidth = Math.max(rows.actions.label.length, rows.navigate.label.length);
  return (
    <Box flexDirection="column" height={2}>
      {toast ? (
        <Box paddingX={1} height={1} overflow="hidden">
          <Text color={toastColor(toast.kind)} wrap="truncate-end">
            {toast.text.replace(/\s*[\r\n]+\s*/g, " · ")}
          </Text>
        </Box>
      ) : (
        <FooterLine row={rows.actions} labelWidth={labelWidth} chipActions={chipActions} />
      )}
      <FooterLine row={rows.navigate} labelWidth={labelWidth} chipActions={chipActions} />
    </Box>
  );
}
```

`src/tui/components/Workspace.tsx`: replace the `chips: Chip[]` prop with `footer: FooterRows`, delete the `<Toast>` line and its import, render `<Footer rows={footer} toast={toast} chipActions={chipActions} />`; update the doc comment ("header row, body, two footer rows — exactly size.rows tall").

`src/tui/App.tsx` (temporary, Task 4 relocates it): after the `bindings` memo add

```ts
const footerRows = useMemo(
  () =>
    buildFooterRows({
      context: bindingContext,
      bindings,
      target: crumbs[crumbs.length - 1] ?? "",
      chatReachable: currentRepoKey !== null,
      mode: layout.mode,
    }),
  [bindingContext, bindings, crumbs, currentRepoKey, layout.mode],
);
```

and pass `footer={footerRows}` instead of `chips={bindings.chips}`. (`currentRepoKey` already exists — Task 19 of the chat plan added it.) Re-measure App after this task: it grows by ~5 lines; that is allowed ONLY because Task 4 removes ~25 — if Task 4 is not executed, this task's pin bump must be reverted. Prefer to run Task 3 and Task 4 back-to-back.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/tuiChrome.test.tsx tests/tuiApp.test.tsx tests/tuiLocalApp.test.tsx tests/renderPerf.test.tsx tests/tuiMouseApp.test.tsx > /tmp/t3 2>&1; echo "exit: $?"` — expected 0 apart from App tests that assert the OLD footer wording (`" · "` separators, `enter preview`, `? help`) — update those assertions in place to the new glyphs (`⏎ preview`, `↑↓ move`) and the two-row shape. `npm run lint` clean (the temporary App memo lists all its deps).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/theme.ts src/tui/components/Chrome.tsx src/tui/components/Workspace.tsx src/tui/App.tsx tests/tuiChrome.test.tsx tests/tuiApp.test.tsx
git add src/tui/theme.ts src/tui/components/Chrome.tsx src/tui/components/Workspace.tsx src/tui/App.tsx tests/tuiChrome.test.tsx tests/tuiApp.test.tsx tests/tuiLocalApp.test.tsx tests/tuiMouseApp.test.tsx
git commit -m "feat(tui): two-row footer — actions above, navigate below, the toast paints over actions"
```

---

### Task 4: `useFooterBindings` — the footer derivation leaves App (ratchet stays ≤ 1913)

**Files:**

- Create: `src/tui/hooks/useFooterBindings.ts`
- Modify: `src/tui/App.tsx` (delete the `bindingContext` memo ~1331-1365, the `bindings` memo ~1366-1369, the `helpBindings` memo ~1372-1389, and Task 3's temporary `footerRows` memo; replace with one hook call)
- Test: `tests/useFooterBindings.test.tsx`

**Interfaces:**

- Consumes: `buildContextBindings`, `BindingContext` (`viewActions.ts`); `buildFooterRows`, `FooterRows` (Task 2); App's nav spine values (read-only inputs, the `src/tui/hooks/` convention).
- Produces:

  ```ts
  export interface FooterBindingsInput {
    view: View; // App's View union (export it from App.tsx if it is not already — grep `export type View`)
    pane: 1 | 2 | 3;
    body: BodyKind | null; // src/tui/railModel.ts — App's `body` value as-is
    logOverlay: boolean;
    filtering: boolean;
    composerFocused: boolean;
    mode: LayoutMode;
    /** Row-1 target (App's crumbs' last element). */
    target: string;
    /** `currentRepoKey !== null` on the main view; the overlays' own repo on overlays (Task 5 supplies it). */
    chatReachable: boolean;
  }
  export function useFooterBindings(input: FooterBindingsInput): {
    bindingContext: BindingContext;
    bindings: ContextBindings; // the keymap App's layer-3d dispatch reads
    helpBindings: ContextBindings; // the main-body context under the help modal
    footer: FooterRows;
  };
  ```

- [ ] **Step 1: Write the failing test**

`tests/useFooterBindings.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useFooterBindings, type FooterBindingsInput } from "../src/tui/hooks/useFooterBindings.js";

function Probe({
  input,
  onReady,
}: {
  input: FooterBindingsInput;
  onReady: (r: ReturnType<typeof useFooterBindings>) => void;
}) {
  onReady(useFooterBindings(input));
  return <Text>probe</Text>;
}
const base: FooterBindingsInput = {
  view: "main",
  pane: 1,
  body: { kind: "issues", nwo: "acme/api" },
  logOverlay: false,
  filtering: false,
  composerFocused: false,
  mode: "wide",
  target: "acme/api",
  chatReachable: true,
};
const run = (input: FooterBindingsInput) => {
  let out!: ReturnType<typeof useFooterBindings>;
  render(<Probe input={input} onReady={(r) => (out = r)} />);
  return out;
};

describe("useFooterBindings", () => {
  it("main view: context is pane-scoped, keymap carries c → chat, footer rows are built for the target", () => {
    const r = run(base);
    expect(r.bindingContext).toEqual({ kind: "main", body: "issues", pane: 1 });
    expect(r.bindings.keymap.get("c")).toBe("chat");
    expect(r.footer.actions.label).toBe("acme/api");
    expect(r.footer.actions.chips[0]).toMatchObject({ kind: "pill", id: "chat" });
  });
  it("the chat view splits on composer focus; a focused composer derives an empty keymap", () => {
    expect(run({ ...base, view: "chat", composerFocused: true }).bindings.keymap.size).toBe(0);
    expect(run({ ...base, view: "chat", composerFocused: false }).bindingContext).toEqual({
      kind: "view",
      view: "chat",
    });
  });
  it("log overlay and filtering win over the view", () => {
    expect(run({ ...base, logOverlay: true }).bindingContext).toEqual({ kind: "logOverlay" });
    expect(run({ ...base, filtering: true }).bindingContext).toEqual({
      kind: "structuralOnly",
      view: "filtering",
    });
  });
  it("helpBindings is always the main-body context under the modal", () => {
    const r = run({ ...base, view: "help" });
    expect(r.bindingContext).toEqual({ kind: "structuralOnly", view: "help" });
    expect(r.helpBindings.keymap.get("c")).toBe("chat");
  });
  it("no repo in context → no pill", () => {
    const r = run({
      ...base,
      body: { kind: "section", section: "queue" },
      target: "queue",
      chatReachable: false,
    });
    expect(r.footer.actions.chips.some((c) => c.kind === "pill")).toBe(false);
  });
  it("returns referentially stable objects while inputs are unchanged (memo)", () => {
    const seen: unknown[] = [];
    const r = render(<Probe input={base} onReady={(x) => seen.push(x.footer)} />);
    r.rerender(<Probe input={base} onReady={(x) => seen.push(x.footer)} />);
    expect(seen[0]).toBe(seen[1]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/useFooterBindings.test.tsx > /tmp/t4 2>&1; echo "exit: $?"` — expected 1 (module not found).

- [ ] **Step 3: Implement**

`src/tui/hooks/useFooterBindings.ts` — move App's three memos verbatim (the `bindingContext` switch, `bindings`, `helpBindings`) and add the footer:

```ts
/**
 * Derived-mnemonic bindings + the two footer rows (mnemonic spec §2/§4,
 * footer spec 2026-09-02 §6): ONE context table drives the footer, the help
 * modal and App's keyboard dispatch tail — render and input consume the same
 * derivation and cannot drift. App passes its nav spine in read-only (the
 * src/tui/hooks convention) and reads the four results back.
 */
import { useMemo } from "react";
import {
  buildContextBindings,
  type BindingContext,
  type ContextBindings,
  type MainBody,
} from "../viewActions.js";
import { buildFooterRows, type FooterRows } from "../footerModel.js";
import type { LayoutMode } from "../layout.js";
import type { BodyKind } from "../railModel.js";
import type { View } from "../App.js"; // `export type View` exists at App.tsx:183

export interface FooterBindingsInput {
  view: View;
  pane: 1 | 2 | 3;
  /** App's `body` (`bodyKindFor(selectedRow, …)`): `BodyKind` from src/tui/railModel.ts. */
  body: BodyKind | null;
  logOverlay: boolean;
  filtering: boolean;
  composerFocused: boolean;
  mode: LayoutMode;
  /** Row-1 target (App's crumbs' last element). */
  target: string;
  /** A repo is in context → the chat pill renders. */
  chatReachable: boolean;
}

const mainBody = (body: FooterBindingsInput["body"]): MainBody =>
  body?.kind === "issues" ? "issues" : body?.kind === "section" ? body.section : "repoDetail";

export function useFooterBindings(input: FooterBindingsInput) {
  const { view, pane, body, logOverlay, filtering, composerFocused, mode, target, chatReachable } =
    input;
  const bindingContext = useMemo((): BindingContext => {
    if (logOverlay) return { kind: "logOverlay" };
    if (filtering) return { kind: "structuralOnly", view: "filtering" };
    if (view === "chat")
      return composerFocused
        ? { kind: "structuralOnly", view: "chatCompose" }
        : { kind: "view", view: "chat" };
    switch (view) {
      case "help":
      case "palette":
      case "addRepo":
      case "config":
        return { kind: "structuralOnly", view };
      case "detail":
      case "repoDetail":
      case "prs":
      case "prDetail":
      case "review":
      case "cmdOutput":
      case "transcript":
        return { kind: "view", view };
      case "main":
        return { kind: "main", pane, body: mainBody(body) };
    }
  }, [logOverlay, filtering, view, composerFocused, body, pane]);
  const bindings = useMemo(
    () => buildContextBindings(bindingContext, mode),
    [bindingContext, mode],
  );
  const helpBindings = useMemo(
    () => buildContextBindings({ kind: "main", pane, body: mainBody(body) }, mode),
    [body, pane, mode],
  );
  const footer = useMemo(
    () => buildFooterRows({ context: bindingContext, bindings, target, chatReachable, mode }),
    [bindingContext, bindings, target, chatReachable, mode],
  );
  return { bindingContext, bindings, helpBindings, footer };
}
```

(`View` is already exported from App.tsx:183. If importing a type from `App.tsx` into a hook creates an import cycle the linter complains about, move the `View` type to `src/tui/viewActions.ts` next to `OverlayView` and import it from there in both files. The test's `body` literals use `BodyKind` shapes: `{ kind: "issues", nwo: "acme/api" }` and `{ kind: "section", section: "queue" }`.)

`src/tui/App.tsx`: replace the three memos and the temporary `footerRows` with

```ts
const {
  bindingContext,
  bindings,
  helpBindings,
  footer: footerRows,
} = useFooterBindings({
  view,
  pane,
  body,
  logOverlay,
  filtering,
  composerFocused,
  mode: layout.mode,
  target: crumbs[crumbs.length - 1] ?? "",
  chatReachable: currentRepoKey !== null,
});
```

(`crumbs` is declared above this point at ~693, `currentRepoKey` at ~500 — both already exist.) Re-measure `App` with the Global Constraints command: expected ≤ 1913 − 20. Lower the pin in `eslint.config.js` to the measured number and update its comment ("… −N: the footer/bindings derivation moved to hooks/useFooterBindings.ts").

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/useFooterBindings.test.tsx tests/tuiApp.test.tsx tests/tuiApp.chat.test.tsx tests/tuiModal.test.tsx tests/renderPerf.test.tsx > /tmp/t4 2>&1; echo "exit: $?"` — expected 0. `npm run lint` clean (the hook's deps arrays are complete; App's pin lowered, not raised).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/hooks/useFooterBindings.ts src/tui/App.tsx eslint.config.js tests/useFooterBindings.test.tsx
git add src/tui/hooks/useFooterBindings.ts src/tui/App.tsx src/tui/viewActions.ts eslint.config.js tests/useFooterBindings.test.tsx
git commit -m "refactor(tui): footer + binding derivation moves out of App into useFooterBindings"
```

---

### Task 5: The chat verb — prefilled composer, every overlay, no-repo toast

**Files:**

- Modify: `src/tui/hooks/useChat.ts` (`openChat` ~292-301 gains `opts`), `src/tui/hooks/useMainActions.ts` (`chat` handler ~223-231), `src/tui/hooks/useViewActions.ts` (a `chat` handler in `detail`/`prDetail`/`prs`/`transcript`/`review` ~229-262), `src/tui/hooks/useTranscript.ts` (`TranscriptState.repoKey`), `src/tui/App.tsx` (the `chatReachable` input becomes view-aware; `openIssueTranscript`/`openTranscript` pass the repo key)
- Test: `tests/useChat.test.tsx` (prefill), `tests/useMainActions.test.tsx`, `tests/useViewActions.test.tsx`, `tests/tuiApp.chat.test.tsx` (App-level `c` from each context)

**Interfaces:**

- Consumes: `ChatApi.openChat` (Task 15 of the chat plan), `useMainActions`/`useViewActions` inputs, `DetailState.nwo`, `PrDetailState.pr.nwo/number`, `selectedPr` (PRs list), `PendingAssess.nwo` / `PendingComment.nwo` / `PendingDraft.key` (review), `QueueRow.repoPath` (transcript).
- Produces:

  ```ts
  // useChat.ts
  openChat(key: string, opts?: { composer?: string }): void;   // prefills the composer, focused, NOT sent
  // useTranscript.ts
  TranscriptState.repoKey: string | null;                       // set at open: the issue's nwo, or the queue row's repoPath
  openTranscript(id, { expectLive, repoKey?: string | null })
  // useViewActions.ts — new inputs
  openChat: ChatApi["openChat"]; setView: (v: View) => void; setPane: (p: 1|2|3) => void; detail: DetailState | null; prDetail: PrDetailState | null; selectedPr: DashPr | undefined; transcript: TranscriptState | null;
  // pure helper (exported for tests)
  export function chatTargetFor(view, s: { detail; prDetail; selectedPr; transcript; reviewState }): { key: string; composer?: string } | null;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/useChat.test.tsx` — add:

```tsx
it("openChat with a composer prefill lands the text in the composer, focused, and sends nothing", async () => {
  const c = makeClient();
  let api!: ReturnType<typeof useChat>;
  render(<Probe client={c.client} onReady={(a) => (api = a)} />);
  api.openChat("acme/api", { composer: "/issue 46" });
  await until(() => api.chat?.composer === "/issue 46");
  expect(api.chat!.composerFocused).toBe(true);
  expect(c.calls.filter((x) => x.startsWith("prompt:"))).toEqual([]);
});
```

`tests/useViewActions.test.tsx` — add (use the file's existing `renderActions`/probe helper; the names below are the ones its other cases use):

```tsx
describe("chatTargetFor (spec 2026-09-02 §5)", () => {
  it("issue detail → the issue's repo with /issue N prefilled", () => {
    expect(
      chatTargetFor("detail", {
        detail: { nwo: "Acme/API", issue: { number: 46 } } as never,
        prDetail: null,
        selectedPr: undefined,
        transcript: null,
        reviewState: null as never,
      }),
    ).toEqual({ key: "acme/api", composer: "/issue 46" });
  });
  it("PR detail and the PRs list → /pr N", () => {
    expect(
      chatTargetFor("prDetail", {
        detail: null,
        prDetail: { pr: { nwo: "acme/api", number: 12 } } as never,
        selectedPr: undefined,
        transcript: null,
        reviewState: null as never,
      }),
    ).toEqual({ key: "acme/api", composer: "/pr 12" });
    expect(
      chatTargetFor("prs", {
        detail: null,
        prDetail: null,
        selectedPr: { nwo: "acme/api", number: 7 } as never,
        transcript: null,
        reviewState: null as never,
      }),
    ).toEqual({ key: "acme/api", composer: "/pr 7" });
  });
  it("transcript → the ticket's repo key, no prefill; null when the ticket has none", () => {
    expect(
      chatTargetFor("transcript", {
        detail: null,
        prDetail: null,
        selectedPr: undefined,
        transcript: { repoKey: "/w/acme" } as never,
        reviewState: null as never,
      }),
    ).toEqual({ key: "/w/acme" });
    expect(
      chatTargetFor("transcript", {
        detail: null,
        prDetail: null,
        selectedPr: undefined,
        transcript: { repoKey: null } as never,
        reviewState: null as never,
      }),
    ).toBeNull();
  });
  it("review → the selected item's repo (batch nwo, comment nwo, chat draft key); null past the list", () => {
    const rs = {
      batches: [{ nwo: "acme/api" }],
      drafts: [{ nwo: "beta/two" }],
      chatDrafts: [{ key: "/w/c" }],
      cursor: 0,
      open: null,
    } as never;
    expect(
      chatTargetFor("review", {
        detail: null,
        prDetail: null,
        selectedPr: undefined,
        transcript: null,
        reviewState: rs,
      }),
    ).toEqual({ key: "acme/api" });
    expect(
      chatTargetFor("review", {
        detail: null,
        prDetail: null,
        selectedPr: undefined,
        transcript: null,
        reviewState: { ...rs, cursor: 1 },
      }),
    ).toEqual({ key: "beta/two" });
    expect(
      chatTargetFor("review", {
        detail: null,
        prDetail: null,
        selectedPr: undefined,
        transcript: null,
        reviewState: { ...rs, cursor: 2 },
      }),
    ).toEqual({ key: "/w/c" });
    expect(
      chatTargetFor("review", {
        detail: null,
        prDetail: null,
        selectedPr: undefined,
        transcript: null,
        reviewState: { ...rs, cursor: 3 },
      }),
    ).toBeNull();
  });
});
it("the chat handler in an overlay opens the target's chat and switches the view; a null target toasts", () => {
  // `mount()` is this file's harness: it builds the ViewActionsInput with vi.fn spies
  // (`makeSpies`) and returns { actions, spies }. Add three spies to makeSpies():
  // openChat: vi.fn(), setView: vi.fn(), setPane: vi.fn() — and wire them into the
  // input like the others.
  const detail = mount({
    view: "detail",
    detail: { nwo: "Acme/API", issue: { number: 46 } } as never,
  });
  detail.actions.chat!();
  expect(detail.spies.openChat).toHaveBeenCalledWith("acme/api", { composer: "/issue 46" });
  expect(detail.spies.setView).toHaveBeenCalledWith("chat");
  expect(detail.spies.setPane).toHaveBeenCalledWith(2);

  const bare = mount({ view: "transcript", transcript: { ...TRANSCRIPT(false), repoKey: null } });
  bare.actions.chat!();
  expect(bare.spies.openChat).not.toHaveBeenCalled();
  expect(bare.spies.showToast).toHaveBeenCalledWith("info", "select a repo first (←)");
});
```

(`TRANSCRIPT(live)` is the file's existing `TranscriptState` builder — add `repoKey: null` to its literal so every existing case keeps compiling once Task 5 adds the field.)

`tests/useMainActions.test.tsx` — add: on the issues body with an issue selected, `chat` → `openChat(currentRepoKey, { composer: "/issue <n>" })`; on the rail (pane 1) → `openChat(currentRepoKey)` with no composer; with `currentRepoKey === null` → toast `select a repo first (←)` (replace the existing "no repo selected" text).

`tests/tuiApp.chat.test.tsx` — add App-level cases (each keystroke `until`-gated):

- issue list, issue #46 selected, `c` → chat view opens with the composer showing `/issue 46` (frame contains `/issue 46` inside the composer box) and no `prompt:` call recorded.
- `l` `l` to pane 3 (a PR selected) `c` → composer shows `/pr <n>`.
- open issue detail (`enter` on the issue) then `c` → same prefill as the list.
- the queue body (`TO_QUEUE_ROW`, `l`) `c` → toast `select a repo first (←)`, view stays main.
- `t` on the issue list still opens the transcript (regression guard for #330).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/useChat.test.tsx tests/useViewActions.test.tsx tests/useMainActions.test.tsx tests/tuiApp.chat.test.tsx > /tmp/t5 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/tui/hooks/useChat.ts`:

```ts
openChat(key: string, opts?: { composer?: string }): void;   // ChatApi
// …and the implementation:
const openChat = useCallback(
  (key: string, opts?: { composer?: string }): void => {
    closeChat();
    keyRef.current = key;
    const composer = opts?.composer ?? "";
    composerRef.current = composer;                       // the R32 restore ref stays in sync
    setChat({ ...freshState(key), composer });            // composerFocused is already true in freshState
    connect(key, null);
    void reloadDrafts();
  },
  [closeChat, connect, reloadDrafts],
);
```

`src/tui/hooks/useTranscript.ts`: `TranscriptState.repoKey: string | null` (`null` in the initial state); `openTranscript(id, opts: { expectLive: boolean; repoKey?: string | null })` stores `opts.repoKey ?? null`. In App, `openIssueTranscript` passes `repoKey: nwo.toLowerCase()`; the queue-row open passes `repoKey: row.repoPath` (the `QueueRow.repoPath` field — `null` for Q&A tickets).

`src/tui/hooks/useViewActions.ts` — the pure helper and the handler:

```ts
/** What `c` chats about from an overlay (spec 2026-09-02 §5, D6/D7): the
 * overlay's repo, with the issue/PR thread prefilled where one is in view.
 * Null → no repo in context → the caller toasts and the pill is absent. */
export function chatTargetFor(
  view: View,
  s: {
    detail: DetailState | null;
    prDetail: PrDetailState | null;
    selectedPr: DashPr | undefined;
    transcript: TranscriptState | null;
    reviewState: ReviewState;
  },
): { key: string; composer?: string } | null {
  switch (view) {
    case "detail":
      return s.detail
        ? { key: s.detail.nwo.toLowerCase(), composer: `/issue ${s.detail.issue.number}` }
        : null;
    case "prDetail":
      return s.prDetail
        ? { key: s.prDetail.pr.nwo.toLowerCase(), composer: `/pr ${s.prDetail.pr.number}` }
        : null;
    case "prs":
      return s.selectedPr
        ? { key: s.selectedPr.nwo.toLowerCase(), composer: `/pr ${s.selectedPr.number}` }
        : null;
    case "transcript":
      return s.transcript?.repoKey ? { key: s.transcript.repoKey } : null;
    case "review": {
      const { batches, drafts, chatDrafts, cursor } = s.reviewState;
      if (cursor < batches.length) return { key: batches[cursor]!.nwo.toLowerCase() };
      if (cursor < batches.length + drafts.length)
        return { key: drafts[cursor - batches.length]!.nwo.toLowerCase() };
      const d = chatDrafts[cursor - batches.length - drafts.length];
      return d ? { key: d.key } : null;
    }
    default:
      return null;
  }
}
```

In the handlers memo, add to `detail`, `prDetail`, `prs`, `transcript`, `review`:

```ts
chat: () => {
  const t = chatTargetFor(view, { detail, prDetail, selectedPr, transcript, reviewState });
  if (t === null) return void showToast("info", "select a repo first (←)");
  openChat(t.key, t.composer === undefined ? undefined : { composer: t.composer });
  setView("chat");
  setPane(2);
},
```

(`DetailState`/`PrDetailState` are App-local interfaces today — export them from App.tsx as types, or move them to `src/tui/prState.ts`; either adds no App-function lines.)

`src/tui/hooks/useMainActions.ts` `chat`:

```ts
chat: () => {
  if (currentRepoKey === null) return void showToast("info", "select a repo first (←)");
  const issue = pane === 2 && body?.kind === "issues" ? currentIssue : undefined;
  const pr = pane === 3 ? selectedPane3Pr : undefined;
  openChat(currentRepoKey, issue ? { composer: `/issue ${issue.number}` } : pr ? { composer: `/pr ${pr.number}` } : undefined);
  setView("chat");
  setPane(2);
},
```

(`selectedPane3Pr` is already a `useMainActions` input; `openChat`'s type in the inputs widens to `ChatApi["openChat"]`.)

`src/tui/App.tsx`: the `chatReachable` argument to `useFooterBindings` becomes
`view === "main" ? currentRepoKey !== null : chatTargetFor(view, { detail, prDetail, selectedPr, transcript, reviewState }) !== null` — one expression; wrap it in a `useMemo` inside `useFooterBindings`'s input if `exhaustive-deps` needs it stable (it does not: a boolean is compared by value). Pass `openChat`, `setView`, `setPane`, `detail`, `prDetail`, `selectedPr`, `transcript` into `useViewActions` (7 prop lines). Re-measure `App`: must stay under the pin Task 4 set (the 7 lines are covered by Task 4's −20).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/useChat.test.tsx tests/useViewActions.test.tsx tests/useMainActions.test.tsx tests/tuiApp.chat.test.tsx tests/tuiApp.test.tsx tests/useTranscript.test.tsx tests/useReview.test.tsx > /tmp/t5 2>&1; echo "exit: $?"` — expected 0. `npm run lint` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/hooks/useChat.ts src/tui/hooks/useMainActions.ts src/tui/hooks/useViewActions.ts src/tui/hooks/useTranscript.ts src/tui/App.tsx tests/useChat.test.tsx tests/useViewActions.test.tsx tests/useMainActions.test.tsx tests/tuiApp.chat.test.tsx
git add src/tui/hooks/useChat.ts src/tui/hooks/useMainActions.ts src/tui/hooks/useViewActions.ts src/tui/hooks/useTranscript.ts src/tui/App.tsx tests/useChat.test.tsx tests/useViewActions.test.tsx tests/useMainActions.test.tsx tests/tuiApp.chat.test.tsx
git commit -m "feat(tui): c opens the repo chat from every overlay, prefilling /issue N or /pr N"
```

---

### Task 6: HelpModal reads the shared vocabulary — `c chat`, `: palette`, `t` transcript

**Files:**

- Modify: `src/tui/components/HelpModal.tsx` (the `navigate` section ~69-84 and the two intro lines ~57-64), `src/tui/footerModel.ts` (export the navigation vocabulary table the modal reads)
- Test: `tests/tuiModal.test.tsx`

**Interfaces:**

- Consumes: `ContextBindings` (the modal's existing `bindings` prop), Task 2's `keyGlyph`.
- Produces:

  ```ts
  // footerModel.ts
  /** The navigate-row vocabulary in help-modal form, one row per key family (spec §3.2). */
  export const NAV_HELP_ROWS: ReadonlyArray<[key: string, meaning: string]>;
  ```

- [ ] **Step 1: Write the failing tests**

Add to `tests/tuiModal.test.tsx`'s `HelpModal` describe:

```tsx
it("documents c chat once as a verb, the palette on :, and t as the transcript (spec 2026-09-02 D5)", () => {
  const f = render(
    <HelpModal
      pane={2}
      mode="wide"
      trigger="junco"
      bindings={buildContextBindings({ kind: "main", body: "issues", pane: 2 }, "wide")}
    />,
  ).lastFrame()!;
  expect(f).toMatch(/^\s*c\s+chat/m); // the derived verb row
  expect(f).toMatch(/^\s*:\s+command palette/m); // structural, in navigate
  expect(f).not.toContain("commands chip"); // the alias wording is gone
  expect(f).not.toContain("c             commands");
  expect(f).toMatch(/t on an issue\s+transcript/);
  expect(f).not.toContain("t on a repo row"); // the withdrawn reading
  expect(f).toContain("chat with the agent about the repo under the cursor");
});
it("the navigate section is generated from the footer vocabulary, not a second hand-written list", () => {
  const f = render(
    <HelpModal
      pane={1}
      mode="wide"
      trigger="junco"
      bindings={buildContextBindings({ kind: "main", body: "issues", pane: 1 }, "wide")}
    />,
  ).lastFrame()!;
  for (const [key] of NAV_HELP_ROWS) expect(f).toContain(key);
});
```

(import `NAV_HELP_ROWS` from `../src/tui/footerModel.js`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/tuiModal.test.tsx > /tmp/t6 2>&1; echo "exit: $?"` — expected 1 (`NAV_HELP_ROWS` missing; the modal still prints `t on a repo row`).

- [ ] **Step 3: Implement**

`src/tui/footerModel.ts` — append:

```ts
/** The navigate row's vocabulary as help rows (spec 2026-09-02 §3.2). The
 * modal renders THIS list, so the footer and the help cannot disagree about
 * what a structural key does. Keys are shown in their footer glyph form. */
export const NAV_HELP_ROWS: ReadonlyArray<[string, string]> = [
  [`${keyGlyph("↑/↓")} · j/k`, "move selection / scroll"],
  [`${keyGlyph("←/→")} · h/l · tab`, "switch panes (rail ⇄ issues ⇄ PR monitor)"],
  [keyGlyph("[/]"), "scroll (alias of ↑↓ in views)"],
  [keyGlyph("g/G"), "first / last"],
  [keyGlyph("enter"), "open — repo detail (rail), issue preview (list), PR (monitor / PRs view)"],
  ["t on an issue", "transcript of the ticket junco built for it (live while it runs)"],
  ["/", "filter issues (esc clears)"],
  [",", "config editor"],
  [":", "command palette"],
  ["esc", "back / close"],
];
```

`src/tui/components/HelpModal.tsx`:

- Replace the hand-written `navigate` rows with `rows={[...NAV_HELP_ROWS]}`.
- Change the second intro line to: `keys are mnemonics: the underlined letter in each footer chip IS the key; an uppercase letter means shift (guarded/destructive). The filled chip is chat — c on any screen with a repo in context.`
- The `thisView` rows already come from `bindings` (Task 1 made `c → chat` a derived verb), so `c chat` appears there without a hand-written line; add the meaning for the verb row by post-processing: `visible.map((d) => [d.key, d.id === "chat" ? "chat with the agent about the repo under the cursor" : d.label])`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/tuiModal.test.tsx tests/tuiApp.test.tsx tests/footerModel.test.ts > /tmp/t6 2>&1; echo "exit: $?"` — expected 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/HelpModal.tsx src/tui/footerModel.ts tests/tuiModal.test.tsx
git add src/tui/components/HelpModal.tsx src/tui/footerModel.ts tests/tuiModal.test.tsx
git commit -m "feat(tui): help modal reads the footer's navigate vocabulary; c chat, : palette, t transcript"
```

---

### Task 7: Docs, changelog, full gate, frame smoke

**Files:**

- Modify: `docs/dashboard.md` (the "shortcut bar" paragraph ~58, the structural-keys table ~60-70, the per-context keys table ~72-90), `CHANGELOG.md` (`[Unreleased]` → `### Changed`), `README.md` (~160: "Press `t` on a repo row" → `c`)
- Test: `tests/docsReadme.test.ts`, `tests/docsChangelog.test.ts` (existing pins), a throwaway frame probe (not committed)

- [ ] **Step 1: `docs/dashboard.md`**

Replace the "A persistent shortcut bar…" paragraph with:

> The bottom two rows are the shortcut bar. The **actions row** (upper) names what is under the cursor — a repo, `issue #46`, `PR #12`, a system section — and lists what you can do to it: the filled **chat** chip first wherever a repo is in context (`c` — the underlined letter in every chip IS its key; an UPPERCASE letter means shift, reserved for the guarded verbs `Unwatch` / `Delete` / `Prune` / `Restart` / `Discard`, which also keep their confirm modals), then the row's verbs, then `│` and the places you can go (queue, review, PRs). A toast paints over this row for four seconds or until your next key. The **navigate row** (lower) is the same in every view — the structural keys as small keycaps, with `? help` and `q` pinned right — and only its labels change to say what `⏎` or `←` do here. Below 110 columns it drops `g G`, `:` and `,` (they still work, and the help modal lists them).

Update the structural-keys table: `enter` row gains "`c` is not structural — it is the chat verb, derived first so it is `c` everywhere"; add a row `:` → "command palette (there is no `c commands` chip any more)". In the per-context table, every main context gains `c chat` at the front and loses `c commands`; the issues row keeps `t transcript`; add rows for `issue detail / PR detail / PRs / transcript / review` with `c chat` (and `t transcript` on issue detail). Add one sentence after the table: "`c` from an issue or PR opens the repo's chat with `/issue N` (or `/pr N`) already typed into the composer — enter pulls the thread in, esc discards it."

- [ ] **Step 2: `CHANGELOG.md`** under `[Unreleased]`, `### Changed`:

```
- Dashboard shortcut bar redesigned as two rows (spec `docs/superpowers/specs/2026-09-02-footer-redesign-design.md`): the actions row names the thing under the cursor and lists its verbs — the chat chip first, as a filled pill — and a stable navigate row keeps the structural keys in the same place in every view; the toast now paints over the actions row instead of occupying its own line. **Key changes:** `c` is chat on every screen with a repo in context (from an issue or PR it prefills `/issue N` / `/pr N`); `t` is the ticket transcript only (it no longer opens chat from the rail or the PR pane); the `c commands` chip is retired — the palette is `:`.
```

- [ ] **Step 3: `README.md`** — "Press `t` on a repo row" → "Press `c` on any repo, issue or PR" and mention the prefill in the same sentence.

- [ ] **Step 4: Full gate + coverage + e2e**

```bash
npx prettier --write docs/dashboard.md CHANGELOG.md README.md
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/final 2>&1; echo "exit: $?"
npx vitest run --coverage > /tmp/cov 2>&1; echo "exit: $?"
npm run test:e2e > /tmp/e2e 2>&1; echo "exit: $?"
```

All three exit codes must be 0. Re-measure `App` (Global Constraints command) and record the number in the commit body.

- [ ] **Step 5: Frame smoke (not committed)**

Write `tests/zz-footer-smoke.test.tsx` that renders `renderApp()` (from `tests/helpers/localFixtures.tsx`) at the default 120 columns and at 100 (`renderApp({}, { columns: 100 })` if the helper takes a size; else `render(<MouseProvider><App {...makeAppProps({})} /></MouseProvider>, { columns: 100 })`), walks rail → `l` issue list → `c` (composer shows `/issue`) → `esc` `esc` → `?`, and appends the last two lines of every frame to `/tmp/footer-frames.txt`. Read that file: every context must show two footer rows, the pill text `chat` on repo contexts and none on the queue body, `⏎`/`↑↓` glyphs, `? help` at the right edge, and no third footer line. Delete the probe file before committing.

- [ ] **Step 6: Commit**

```bash
git add docs/dashboard.md CHANGELOG.md README.md
git commit -m "docs: two-row shortcut bar, c chat everywhere, palette on :"
```

Then merge `origin/main` if it moved, re-run the gate, and hand off with `superpowers:finishing-a-development-branch` (PR from `feat/footer-redesign`; nothing is pushed without the maintainer's explicit approval).

---

## Task order and dependencies

1 (tables) → 2 (model) → 3 (renderer + Workspace + temporary App memo) → 4 (hook; lowers the App pin) → 5 (chat verb + prefill; overlays) → 6 (help) → 7 (docs + gate). Tasks 3 and 4 should run back-to-back: Task 3 alone leaves App ~5 lines over the pin, which only Task 4 pays back.
