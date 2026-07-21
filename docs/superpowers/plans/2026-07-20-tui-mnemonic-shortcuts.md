# TUI Mnemonic Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive every named option's hotkey from its label per view (guarded cascade) and render the binding as the colored winning character inside the label; one derived table per context drives chips, help, and key dispatch.

**Architecture:** Approach 1 from `docs/superpowers/specs/2026-07-20-tui-mnemonic-shortcuts-design.md` — pure `mnemonics.ts` engine → `viewActions.ts` context tables (pinned by tests) → `Footer`/`HelpModal` render `Chip[]` → App's cascade tail dispatches `keymap.get(input)` against one per-context action-handler table (the generalized `footerActions`).

**Tech Stack:** TypeScript strict/NodeNext, React 18 + Ink, vitest + ink-testing-library. No new dependencies.

## Global Constraints

- Read the spec first (algorithm §1, context tables §2, guarded/hidden sets).
- Suite green at every commit; `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` (never pipe through filters).
- `npm run typecheck` after shared-type changes; conventional commits; **no AI attribution trailers**.
- Prettier: re-read before edit, `npx prettier --write` touched files pre-commit.
- Ink tests: loop-until-condition; frames strip ANSI → assert color placement structurally (charIndex/segments), never via frames.
- Breaking TUI change → CHANGELOG under Unreleased (0.9.0); release actions stay HOLD.
- Branch: `feat/tui-mnemonic-shortcuts` (created off main; spec committed on it).

## The derived maps (hand-run, normative for the pinned tests)

Main-context globals (identical across every `main:*` body): `a` addRepo, `u` unwatch, `b` browser, `r` refresh, `s` assess (charIndex 1), `e` queue (charIndex 2), `v` review (charIndex 2), `p` prs, `c` commands, reserved `q` quit / `?` help. Body additions — issues: `d` dispatch, `o` approve (charIndex 4), `n` analyze (charIndex 1), hidden `D` dispatchAsk / `A` assessAutoPlan (its own label's first letter, uppercased) / `R` replan; queue: `t` retry (charIndex 2), `D` delete; outbox: `f` flush; worktrees: `P` prune; daemon: `R` restart, `f` flush; repoDetail/logs: globals only. Overlay views (no globals; each also carries a hidden reserved `q` close): detail/prDetail/repoDetailView/prs: `b` browser; cmdOutput: `r` reRun; review: `a` all, `n` none, `f` file, `D` discard; logOverlay: `f` follow, `l` level, `t` ticket (reserved `q` close).

---

### Task 1: the derivation engine

**Files:**

- Create: `src/tui/mnemonics.ts`
- Test: `tests/tuiMnemonics.test.ts` (new)

**Interfaces (produces — Tasks 2–4 import these exact names):**

```ts
export interface MnemonicOption {
  id: string;
  label: string;
  guarded?: boolean;
  hidden?: boolean;
}
export interface DerivedMnemonic {
  id: string;
  key: string;
  label: string;
  charIndex: number | null;
  guarded: boolean;
  hidden: boolean;
}
export function deriveMnemonics(
  options: MnemonicOption[],
  ctx: { reserved?: ReadonlyMap<string, string>; excluded?: ReadonlySet<string> },
): DerivedMnemonic[];
```

- [ ] **Step 1: failing tests** (`tests/tuiMnemonics.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { deriveMnemonics, type MnemonicOption } from "../src/tui/mnemonics.js";

const o = (id: string, over: Partial<MnemonicOption> = {}): MnemonicOption => ({
  id,
  label: id,
  ...over,
});
const derive = (opts: MnemonicOption[], ctx: Parameters<typeof deriveMnemonics>[1] = {}) =>
  deriveMnemonics(opts, ctx);
const byId = (r: ReturnType<typeof deriveMnemonics>, id: string) => r.find((d) => d.id === id)!;

describe("deriveMnemonics", () => {
  it("claims first letters in list order; conflicts cascade to remaining letters", () => {
    const r = derive([o("approve"), o("analyze"), o("assess")]);
    expect(byId(r, "approve")).toMatchObject({ key: "a", charIndex: 0 });
    expect(byId(r, "analyze")).toMatchObject({ key: "n", charIndex: 1 });
    // assess: a taken → s (first remaining letter); charIndex = first 's' in label
    expect(byId(r, "assess")).toMatchObject({ key: "s", charIndex: 1 });
  });

  it("word-initials outrank remaining letters for multi-word labels", () => {
    const r = derive([o("add", { label: "add" }), o("addRepo", { label: "add repo" })]);
    expect(byId(r, "addRepo")).toMatchObject({ key: "r", charIndex: 4 }); // 'r' of "repo"
  });

  it("guarded options walk the same sequence UPPERCASED", () => {
    const r = derive([o("delete", { guarded: true }), o("dispatch")]);
    expect(byId(r, "delete")).toMatchObject({ key: "D", charIndex: 0 });
    expect(byId(r, "dispatch")).toMatchObject({ key: "d", charIndex: 0 }); // case-distinct
  });

  it("reserved keys are claimed first and never derivable", () => {
    const r = derive([o("queue"), o("quit")], { reserved: new Map([["quit", "q"]]) });
    expect(byId(r, "quit")).toMatchObject({ key: "q", charIndex: 0 });
    expect(byId(r, "queue")).toMatchObject({ key: "u", charIndex: 1 }); // q reserved → u
  });

  it("a reserved key absent from its label yields charIndex null", () => {
    const r = derive([o("help")], { reserved: new Map([["help", "?"]]) });
    expect(byId(r, "help")).toMatchObject({ key: "?", charIndex: null });
  });

  it("excluded letters are skipped", () => {
    const r = derive([o("level")], { excluded: new Set(["l"]) });
    expect(byId(r, "level")).toMatchObject({ key: "e", charIndex: 1 });
  });

  it("exhaustion falls back to the first unclaimed a–z with charIndex null", () => {
    // "ab" and "ba" claim a,b; "ab" again has nothing left in-label.
    const r = derive([
      o("x1", { label: "ab" }),
      o("x2", { label: "ba" }),
      o("x3", { label: "ab" }),
    ]);
    expect(byId(r, "x3")).toMatchObject({ key: "c", charIndex: null });
  });

  it("charIndex matches case-insensitively (labels may capitalize)", () => {
    const r = derive([o("prs", { label: "PRs" })]);
    expect(byId(r, "prs")).toMatchObject({ key: "p", charIndex: 0 });
  });

  it("is deterministic and side-effect free", () => {
    const opts = [o("one"), o("two"), o("three")];
    expect(derive(opts)).toEqual(derive(opts));
  });
});
```

- [ ] **Step 2: verify fail** — `npx vitest run tests/tuiMnemonics.test.ts` → module not found.
- [ ] **Step 3: implement `src/tui/mnemonics.ts`:**

```ts
/**
 * Pure mnemonic derivation for the dashboard's shortcut overhaul: each named
 * option's hotkey derives from its LABEL (first letter → later word-initials
 * → remaining letters, guarded verbs uppercase), claimed strictly in list
 * order per context. The winning character's index feeds the colored-char
 * rendering; render and dispatch both consume this one output.
 * Spec: docs/superpowers/specs/2026-07-20-tui-mnemonic-shortcuts-design.md §1.
 */

export interface MnemonicOption {
  id: string;
  label: string;
  /** Destructive: claims UPPERCASE candidates (shift = fat-finger guard). */
  guarded?: boolean;
  /** Claims a key but renders only in help (shift variants). */
  hidden?: boolean;
}

export interface DerivedMnemonic {
  id: string;
  key: string;
  label: string;
  /** Index in label of the winning char; null → key not shown in-label. */
  charIndex: number | null;
  guarded: boolean;
  hidden: boolean;
}

const AZ = "abcdefghijklmnopqrstuvwxyz";

/** Candidate letters for a label: first letter, then later word-initials,
 * then remaining letters left-to-right — deduped, letters only, lowercase. */
function candidates(label: string): string[] {
  const words = label
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  const seq: string[] = [];
  const push = (ch: string): void => {
    if (/[a-z]/.test(ch) && !seq.includes(ch)) seq.push(ch);
  };
  if (words.length > 0) push(words[0][0]);
  for (const w of words.slice(1)) push(w[0]);
  for (const w of words) for (const ch of w) push(ch);
  return seq;
}

export function deriveMnemonics(
  options: MnemonicOption[],
  ctx: { reserved?: ReadonlyMap<string, string>; excluded?: ReadonlySet<string> } = {},
): DerivedMnemonic[] {
  const reserved = ctx.reserved ?? new Map<string, string>();
  const excluded = ctx.excluded ?? new Set<string>();
  const claimed = new Set<string>(reserved.values());
  const out: DerivedMnemonic[] = [];
  for (const opt of options) {
    const guarded = opt.guarded === true;
    const hidden = opt.hidden === true;
    const reservedKey = reserved.get(opt.id);
    if (reservedKey !== undefined) {
      const idx = opt.label.toLowerCase().indexOf(reservedKey.toLowerCase());
      out.push({
        id: opt.id,
        key: reservedKey,
        label: opt.label,
        charIndex: idx >= 0 ? idx : null,
        guarded,
        hidden,
      });
      continue;
    }
    const seq = candidates(opt.label).map((c) => (guarded ? c.toUpperCase() : c));
    let key = seq.find((c) => !claimed.has(c) && !excluded.has(c));
    let charIndex: number | null = null;
    if (key !== undefined) {
      charIndex = opt.label.toLowerCase().indexOf(key.toLowerCase());
      if (charIndex < 0) charIndex = null;
    } else {
      // Exhaustion: first unclaimed a–z (uppercased for guarded). Real context
      // tables never reach this (viewActions.test asserts it); kept total so
      // the engine never throws.
      for (const ch of AZ) {
        const cand = guarded ? ch.toUpperCase() : ch;
        if (!claimed.has(cand) && !excluded.has(cand)) {
          key = cand;
          break;
        }
      }
      key = key ?? "?";
    }
    claimed.add(key);
    out.push({ id: opt.id, key, label: opt.label, charIndex, guarded, hidden });
  }
  return out;
}
```

- [ ] **Step 4: verify pass** + full suite + typecheck.
- [ ] **Step 5: Commit** — `feat(tui): mnemonic derivation engine (guarded cascade)`.

---

### Task 2: context tables + pinned keymaps

**Files:**

- Create: `src/tui/viewActions.ts`
- Test: `tests/tuiViewActions.test.ts` (new)

**Interfaces (produces):**

```ts
export type BindingContext =
  | {
      kind: "main";
      body: "issues" | "repoDetail" | "queue" | "outbox" | "worktrees" | "daemon" | "logs";
    }
  | { kind: "view"; view: "detail" | "repoDetail" | "prs" | "prDetail" | "review" | "cmdOutput" }
  | { kind: "logOverlay" }
  | { kind: "structuralOnly"; view: "palette" | "addRepo" | "config" | "help" | "filtering" };
export type Chip =
  | { kind: "structural"; key: string; label: string }
  | {
      kind: "mnemonic";
      id: string;
      key: string;
      label: string;
      charIndex: number | null;
      guarded: boolean;
    };
export interface ContextBindings {
  chips: Chip[];
  keymap: ReadonlyMap<string, string>;
  all: DerivedMnemonic[];
}
export function buildContextBindings(
  context: BindingContext,
  pane: 1 | 2 | 3,
  mode: LayoutMode,
): ContextBindings;
```

Structure: module-level constants — `MAIN_GLOBALS: MnemonicOption[]` (order: addRepo "add repo", unwatch "unwatch", browser "browser", refresh "refresh", assess "assess", queue "queue", review "review", prs "PRs", commands "commands"), per-body verb lists (issues: dispatch/approve/analyze + hidden guarded dispatchAsk "dispatch as ask" / assessAutoPlan "assess auto-plan" / replan "re-plan"; queue: retry "retry" + guarded delete "delete"; outbox: flush; worktrees: guarded prune; daemon: guarded restart + flush; repoDetail/logs: none), overlay lists per view, `MAIN_RESERVED = Map(quit→q, help→?)`, `MAIN_EXCLUDED = Set(j,k,h,l,g,G,i)`, logOverlay reserved close→q + excluded {G}. Structural chips reproduce today's key-first hints per context/pane (movement, panes, enter/esc, symbols, `[ ]`, filter typing sets for structuralOnly views). `keymap` = every derived entry (hidden included) + quit/help/close; chips = structural + non-hidden mnemonics, pane-filtered exactly as `hintsForUnified` filtered today (pane 1 → globals; pane 2 → body verbs + globals-that-render-there; pane 3 → PR-pane structural set + browser).

- [ ] **Step 1: failing pinned tests** (`tests/tuiViewActions.test.ts`) — pin EVERY map from "The derived maps" header verbatim; plus invariants:

```ts
import { describe, expect, it } from "vitest";
import { buildContextBindings, type BindingContext } from "../src/tui/viewActions.js";

const km = (c: BindingContext): Record<string, string> =>
  Object.fromEntries(buildContextBindings(c, 2, "wide").keymap);
const GLOBALS = {
  a: "addRepo",
  u: "unwatch",
  b: "browser",
  r: "refresh",
  s: "assess",
  e: "queue",
  v: "review",
  p: "prs",
  c: "commands",
  q: "quit",
  "?": "help",
};

describe("pinned per-context keymaps (a label edit that re-binds FAILS here)", () => {
  it("main:issues", () => {
    expect(km({ kind: "main", body: "issues" })).toEqual({
      ...GLOBALS,
      d: "dispatch",
      o: "approve",
      n: "analyze",
      D: "dispatchAsk",
      S: "assessAutoPlan",
      R: "replan",
    });
  });
  it("main:queue", () => {
    expect(km({ kind: "main", body: "queue" })).toEqual({ ...GLOBALS, t: "retry", D: "delete" });
  });
  it("main:outbox", () => {
    expect(km({ kind: "main", body: "outbox" })).toEqual({ ...GLOBALS, f: "flush" });
  });
  it("main:worktrees", () => {
    expect(km({ kind: "main", body: "worktrees" })).toEqual({ ...GLOBALS, P: "prune" });
  });
  it("main:daemon", () => {
    expect(km({ kind: "main", body: "daemon" })).toEqual({ ...GLOBALS, R: "restart", f: "flush" });
  });
  it("main:repoDetail and main:logs are globals-only", () => {
    expect(km({ kind: "main", body: "repoDetail" })).toEqual(GLOBALS);
    expect(km({ kind: "main", body: "logs" })).toEqual(GLOBALS);
  });
  it("overlay views", () => {
    for (const view of ["detail", "prDetail", "repoDetail", "prs"] as const) {
      expect(km({ kind: "view", view })).toEqual({ b: "browser" });
    }
    expect(km({ kind: "view", view: "cmdOutput" })).toEqual({ r: "reRun" });
    expect(km({ kind: "view", view: "review" })).toEqual({
      a: "all",
      n: "none",
      f: "file",
      D: "discard",
    });
  });
  it("logOverlay", () => {
    expect(km({ kind: "logOverlay" })).toEqual({
      f: "follow",
      l: "level",
      t: "ticket",
      q: "close",
    });
  });
});

describe("invariants", () => {
  const MAIN_BODIES = [
    "issues",
    "repoDetail",
    "queue",
    "outbox",
    "worktrees",
    "daemon",
    "logs",
  ] as const;
  it("globals share keys across every main context", () => {
    for (const body of MAIN_BODIES) {
      const m = km({ kind: "main", body });
      for (const [k, id] of Object.entries(GLOBALS)) expect(m[k]).toBe(id);
    }
  });
  it("no context ever hits the exhaustion fallback (every key's char is in its label, reserved ? excepted)", () => {
    const contexts: BindingContext[] = [
      ...MAIN_BODIES.map((body) => ({ kind: "main", body }) as BindingContext),
      { kind: "view", view: "review" },
      { kind: "view", view: "cmdOutput" },
      { kind: "view", view: "detail" },
      { kind: "view", view: "prs" },
      { kind: "view", view: "prDetail" },
      { kind: "view", view: "repoDetail" },
      { kind: "logOverlay" },
    ];
    for (const c of contexts) {
      for (const d of buildContextBindings(c, 2, "wide").all) {
        if (d.key === "?") continue; // reserved help
        expect(d.charIndex, `${JSON.stringify(c)} ${d.id}`).not.toBeNull();
      }
    }
  });
  it("chips: hidden options never render; pane 1 chips are the rail set", () => {
    const b = buildContextBindings({ kind: "main", body: "issues" }, 1, "wide");
    const ids = b.chips.flatMap((ch) => (ch.kind === "mnemonic" ? [ch.id] : []));
    expect(ids).not.toContain("dispatchAsk");
    expect(ids).toContain("addRepo");
    expect(ids).not.toContain("dispatch"); // pane-2 verb, not a rail chip
  });
});
```

- [ ] **Step 2: verify fail.**
- [ ] **Step 3: implement `viewActions.ts`** per the Structure block — derive via `deriveMnemonics(MAIN_GLOBALS.concat(bodyVerbs, hidden), { reserved: MAIN_RESERVED, excluded: MAIN_EXCLUDED })`; keymap from `all` + reserved entries; chips = structural set for (context, pane, mode) — copy today's structural hints from `hintsFor`/`hintsForUnified` (movement/panes/enter/esc/symbols per view) — plus non-hidden mnemonics filtered by pane (rail chips: addRepo/unwatch/browser/refresh/assess/queue/commands [+ review/prs render on pane 2 as today's `v`/`p` placement — match today's chip pane placement exactly]).
- [ ] **Step 4: pass + full suite + typecheck.** Review the pinned letters ONCE by eye against the spec's algorithm (they are the product's new keys).
- [ ] **Step 5: Commit** — `feat(tui): per-context mnemonic tables with pinned keymaps`.

---

### Task 3: Chip rendering (Footer + segments)

**Files:**

- Modify: `src/tui/components/Chrome.tsx` (Footer gains Chip mode; keep the legacy `[key,label]` path until Task 6)
- Test: `tests/tuiChrome.test.tsx` (extend)

**Interfaces (produces):** `Footer` accepts `chips?: Chip[]` (takes precedence over `hints`); exported pure helper `chipSegments(chip: Chip): { text: string; accent: boolean }[]` — mnemonic: `[pre(dim), char(accent, uppercased when guarded), post(dim)]`; structural: `[key(accent), " "+label(dim)]`; `charIndex: null` mnemonic: `[key(accent), " "+label(dim)]`.

- [ ] **Step 1: failing tests:**

```ts
describe("chipSegments (#mnemonic rendering)", () => {
  it("splits a mnemonic label around the winning char", () => {
    expect(
      chipSegments({
        kind: "mnemonic",
        id: "analyze",
        key: "n",
        label: "analyze",
        charIndex: 1,
        guarded: false,
      }),
    ).toEqual([
      { text: "a", accent: false },
      { text: "n", accent: true },
      { text: "alyze", accent: false },
    ]);
  });
  it("uppercases the winning char in place for guarded keys", () => {
    expect(
      chipSegments({
        kind: "mnemonic",
        id: "delete",
        key: "D",
        label: "delete",
        charIndex: 0,
        guarded: true,
      })[0],
    ).toEqual({ text: "D", accent: true });
  });
  it("null charIndex and structural chips render key-first", () => {
    expect(chipSegments({ kind: "structural", key: "esc", label: "back" })).toEqual([
      { text: "esc", accent: true },
      { text: " back", accent: false },
    ]);
  });
});
```

Plus one Footer render test: chips render in order, separated by `·`, clickable when `actions[id]` present (reuse the existing footer-actions plumbing keyed by ID for mnemonic chips and by KEY for structural — Footer's `actions` prop becomes `Record<string, () => void>` keyed by chip identity: mnemonic → id, structural → key).

- [ ] **Step 2: fail → Step 3: implement** (`chipSegments` pure; Footer maps chips through it, wrapping accent segments in `<Text color={theme.accent}>`; guarded accent char via `label[charIndex].toUpperCase()`).
- [ ] **Step 4: pass + suite. Step 5: Commit** — `feat(tui): mnemonic chip rendering in the footer`.

---

### Task 4: App swap — one action table drives keys and clicks

**Files:**

- Modify: `src/tui/App.tsx`
- Modify (tests): every suite that presses old letters — `tests/tuiApp.test.tsx`, `tests/tuiLocalActions.test.tsx`, `tests/tuiLocalApp.test.tsx`, `tests/tuiMouseApp.test.tsx`, `tests/tuiLogOverlay.test.tsx`, `tests/tuiLogSection.test.tsx`, `tests/tuiInteractive.test.tsx`, `tests/tuiPalette.test.tsx` (whatever typecheck/suite flags)

**Steps:**

- [ ] **Step 1:** derive the active context in App: `const bindingContext: BindingContext` from (view, body?.kind, logOverlay) — logOverlay wins; then non-main views; then `{kind:"main", body}`; structural-only views map to `{kind:"structuralOnly", …}`. `const bindings = useMemo(() => buildContextBindings(bindingContext, pane, layout.mode), […])`.
- [ ] **Step 2:** build `actionHandlers: Record<string, () => void>` per context — the EXISTING `footerActions` handlers re-keyed by action id (quit, help, refresh, addRepo, unwatch, browser, assess, queue, review, prs, commands, dispatch, approve, analyze, dispatchAsk, assessAutoPlan, replan, retry, delete, flush, prune, restart, reRun, all, none, file, discard, follow, level, ticket, close, browser…), guards moved verbatim from today's keyboard branches. This REPLACES the key-keyed `footerActions` (Footer now takes id-keyed actions + chips).
- [ ] **Step 3:** cascade tail: after all structural branches, before falling through:

```ts
const actionId = bindings.keymap.get(input);
if (actionId !== undefined) {
  actionHandlers[actionId]?.();
  return;
}
```

Delete every hard-coded named-action letter branch: main-view w/r/s/S/t/p/v/x/o + `:`? (`:` palette is a SYMBOL — keep structural), pane-1 x/o, issues d/D/a/R/c/o, section R/x/f/X + overlay f/l/t (its structural search//, scroll, G stay), review a/n/f/x, cmdOutput r, detail/prDetail/prs o. KEEP structural: movement, panes, enter (row-kind enter recipes), esc, tab, filter typing, `,` config, `:` palette, `/` filter, confirm modal, overlay ownership, q where views use esc/q close (now via reserved close/quit ids — route those through the keymap too).

- [ ] **Step 4:** Footer/Workspace wiring: pass `chips={bindings.chips}` + id-keyed actions; hints prop retired from App (Task 6 deletes the legacy path).
- [ ] **Step 5:** retarget tests: every `r.stdin.write("<old letter>")` for a named action moves to the derived key — READ it from viewActions in the test (`const key = [...buildContextBindings(ctx,2,"wide").keymap].find(([,id]) => id==="analyze")![0]`) or use the pinned literal (tests may hard-code the pinned letters — they're already pinned in Task 2; prefer literals for readability: o approve, n analyze, t retry, D delete, P prune, R restart, b browser, u unwatch, a addRepo, e queue-jump, f flush/file/follow, S/D hidden variants unchanged letters). Footer-chip mouse tests: chip labels no longer have `key ` prefixes — click targets locate by label text.
- [ ] **Step 6:** full suite green + typecheck + lint. **Step 7: Commit** — `feat(tui)!: derived mnemonic keys drive dispatch (one action table for keys + clicks)`.

---

### Task 5: HelpModal + docs

**Files:**

- Modify: `src/tui/components/HelpModal.tsx`, `docs/dashboard.md`, `CHANGELOG.md`
- Test: `tests/tuiModal.test.tsx`

- [ ] **Step 1 (failing test):** help renders the ACTIVE context's mnemonics including hidden variants (`dispatch as ask` shows with `D`), and no stale hard-coded letters (`c analyze` gone → `a[n]alyze`).
- [ ] **Step 2:** HelpModal takes `bindings: ContextBindings` (App passes the active one); "this view" section renders chips + hidden mnemonics via `chipSegments`; hand-written sections lose named letters (keep structural + flow prose).
- [ ] **Step 3:** `docs/dashboard.md`: replace the key tables with (a) a short explanation of mnemonic derivation (colored char = the key; uppercase colored char = shift-guarded) and (b) regenerated tables from the pinned maps. CHANGELOG Unreleased: breaking entry (keys re-derived per view; colored-character mnemonics; notable changes: browser o→b, approve a→o, analyze c→n, add-repo w→a, unwatch x→u, queue-jump t→e, requeue R→t retry, delete x→D, prune x→P, restart X→R, review discard x→D).
- [ ] **Step 4:** suite + commit — `feat(tui): mnemonic help + docs`.

---

### Task 6: cleanup + full gate

**Files:**

- Modify: `src/tui/components/Chrome.tsx` (delete `hintsFor`, `hintsForUnified`, `BodyHintKind`, legacy Footer `hints` path), `src/tui/App.tsx` (delete `LOG_OVERLAY_HINTS`, `HintView` usages), `tests/tuiChrome.test.tsx` (drop legacy hint tests)

- [ ] **Step 1:** delete legacy exports; chase typecheck to zero; `grep -rn "hintsFor\|LOG_OVERLAY_HINTS\|BodyHintKind" src/ tests/` → no hits.
- [ ] **Step 2:** full gate: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.
- [ ] **Step 3:** Commit — `refactor(tui): delete the legacy hand-keyed hint system`.

## Self-review notes (applied)

- Spec §1→Task 1, §2→Task 2, §3→Task 3 (+5 help), §4→Task 4, §5→Task 5 docs, §6→Tasks 1–5 tests. Names cross-checked: `deriveMnemonics`/`DerivedMnemonic`/`buildContextBindings`/`Chip`/`chipSegments`/`ContextBindings.all` consistent across tasks.
- The derived letters in the header were hand-run against §1's algorithm; Task 2's pinned tests are their executable form — any engine/table divergence fails there, not silently.
- `q`-close in prDetail/repoDetail views routes through reserved ids so esc stays structural and q stays reserved everywhere.
