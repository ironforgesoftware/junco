/**
 * Per-context mnemonic tables for the dashboard: each context's ordered named
 * options run through deriveMnemonics (mnemonics.ts) and the ONE derived
 * result feeds the footer chips, the help modal, and App's keyboard dispatch
 * — render and input cannot drift. The actual derived letters are pinned by
 * tests/tuiViewActions.test.ts; edit a label here and that pin fails loudly
 * instead of a key silently re-binding.
 * Spec: docs/superpowers/specs/2026-07-20-tui-mnemonic-shortcuts-design.md §2
 * (derivation, unchanged) and
 * docs/superpowers/specs/2026-09-02-footer-redesign-design.md §4–§5 (the
 * per-context tables and the `chat` global that supersede this file's old
 * chip ordering).
 */

import { deriveMnemonics, type DerivedMnemonic, type MnemonicOption } from "./mnemonics.js";
import type { LayoutMode } from "./layout.js";

export type MainBody =
  | "issues"
  | "repoDetail"
  | "queue"
  | "outbox"
  | "worktrees"
  | "daemon"
  | "logs";
export type OverlayView =
  | "detail"
  | "repoDetail"
  | "prs"
  | "prDetail"
  | "review"
  | "cmdOutput"
  | "transcript"
  | "chat";

/** Text-owning contexts: no mnemonic derives, so their chips ARE the keymap. */
export type StructuralOnlyView =
  | "palette"
  | "addRepo"
  | "config"
  | "help"
  | "filtering"
  | "chatCompose"
  | "chatConfirm";

export type BindingContext =
  /** The main view's context is PANE-scoped for CHIP rendering only (Ruling
   * R27's pane-scoped `t` KEYMAP swap is withdrawn — spec 2026-09-02 D5): the
   * focused pane decides which ids render as chips (RAIL/ISSUES/PANE3_CHIP_
   * ORDER below); the keymap carries the same globals + body verbs on every
   * pane of a body. The pane still belongs to the context identity rather
   * than to a second argument that could disagree with it. */
  | { kind: "main"; body: MainBody; pane: 1 | 2 | 3 }
  | { kind: "view"; view: OverlayView }
  | { kind: "logOverlay" }
  /** `pending`: a junco_submit card is waiting while the composer still has
   * focus (#479). It changes ONE label — `esc` blurs there, it does not abort
   * the turn (#476's useChatInput rule) — so it stays optional and only
   * `chatCompose` reads it. */
  | { kind: "structuralOnly"; view: StructuralOnlyView; pending?: boolean };

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
  /** Render order: structural chips (key-first form) + visible mnemonics for
   * overlays/logOverlay/structuralOnly contexts; mnemonics only for `main`
   * contexts (footerModel.ts's `navigateChips` owns the main view's
   * structural vocabulary — a second copy here would drift from it). */
  chips: Chip[];
  /** key → action id — the FULL context map (hidden variants included). */
  keymap: ReadonlyMap<string, string>;
  /** Every derived option (the tests' pin surface; help renders hidden too). */
  all: DerivedMnemonic[];
}

// ── main contexts ──────────────────────────────────────────────────────────

const MAIN_RESERVED: ReadonlyMap<string, string> = new Map([
  ["quit", "q"],
  ["help", "?"],
]);
/** Structural letters in main contexts: vim movement + the pane-2 alias. */
const MAIN_EXCLUDED: ReadonlySet<string> = new Set(["j", "k", "h", "l", "g", "G", "i"]);

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

const BODY_VERBS: Record<MainBody, MnemonicOption[]> = {
  issues: [
    { id: "dispatch", label: "import" },
    { id: "approve", label: "approve" },
    { id: "analyze", label: "investigate" },
    // `chat` is now the MAIN_GLOBAL `c` (spec 2026-09-02 D5); the issue list's
    // own slot is the ticket transcript (#330) on every pane of this body —
    // one honest verb per slot, no more pane-scoped swap (Ruling R27 is
    // withdrawn).
    { id: "transcript", label: "transcript" },
    // Shift variants: bound, help-only (spec §2 hidden set).
    { id: "dispatchAsk", label: "import as ask", guarded: true, hidden: true },
    { id: "assessAutoPlan", label: "audit auto-plan", guarded: true, hidden: true },
    { id: "replan", label: "re-plan", guarded: true, hidden: true },
  ],
  // chat is a global now (spec 2026-09-02 D5) — no body-specific entry needed.
  repoDetail: [],
  queue: [
    // `retry` — the CLI verb this spawns (junco retry), and a label whose
    // letters survive the global claims (spec §2).
    { id: "retry", label: "retry" },
    { id: "delete", label: "delete", guarded: true },
  ],
  outbox: [{ id: "flush", label: "flush" }],
  worktrees: [{ id: "prune", label: "prune", guarded: true }],
  daemon: [
    { id: "restart", label: "restart", guarded: true },
    { id: "flush", label: "flush" },
  ],
  logs: [],
};

// ── overlay contexts ───────────────────────────────────────────────────────

/** Every overlay carries a hidden reserved q → close (esc stays structural)
 * and, per Ruling R5 (spec 2026-09-02 §3.2 — `?` is help everywhere except
 * the help modal itself), a hidden reserved `?` → help. This table entry is
 * what makes the footer's pinned "? help" chip real instead of a
 * footerModel.ts-side fabrication; the handler behind it is `openHelp`, which
 * every arm of hooks/useViewActions.ts exposes under that id. */
const OVERLAY_RESERVED: ReadonlyMap<string, string> = new Map([
  ["close", "q"],
  ["help", "?"],
]);
const CLOSE: MnemonicOption = { id: "close", label: "close", hidden: true };
const HELP: MnemonicOption = { id: "help", label: "help", hidden: true };

const VIEW_OPTIONS: Record<OverlayView, MnemonicOption[]> = {
  // Spec 2026-09-02 D7: every overlay with a repo in context gets the chat
  // pill, appended after the overlay's own keys so those never move; the
  // issue detail overlay also gets `t`, the ticket transcript.
  detail: [
    { id: "browser", label: "browser" },
    { id: "chat", label: "chat" },
    { id: "transcript", label: "transcript" },
    CLOSE,
    HELP,
  ],
  // Ruling R8 (spec 2026-09-02 D7): a repo IS in context here too — the chat
  // pill is appended after `browser`, same as every other repo-scoped overlay.
  repoDetail: [{ id: "browser", label: "browser" }, { id: "chat", label: "chat" }, CLOSE, HELP],
  prs: [{ id: "browser", label: "browser" }, { id: "chat", label: "chat" }, CLOSE, HELP],
  prDetail: [{ id: "browser", label: "browser" }, { id: "chat", label: "chat" }, CLOSE, HELP],
  review: [
    { id: "all", label: "all" },
    { id: "none", label: "none" },
    { id: "file", label: "file" },
    { id: "discard", label: "discard", guarded: true },
    CLOSE,
    HELP,
    // Chat-draft verbs (spec 2026-09-01 §8.6), APPENDED so the four above keep
    // the keys their pinned test asserts; these derive s / e / r. `discard`
    // (D) already exists and serves the chat draft too.
    { id: "submit", label: "submit" },
    { id: "edit", label: "edit" },
    { id: "route", label: "route" },
    // The selected item's repo (spec 2026-09-02 D7) — last, so it never
    // disturbs the keys above.
    { id: "chat", label: "chat" },
  ],
  cmdOutput: [{ id: "reRun", label: "re-run" }, CLOSE, HELP],
  transcript: [
    { id: "thinking", label: "thinking" },
    { id: "follow", label: "follow" },
    CLOSE,
    HELP,
    // The ticket's checkout repo (spec 2026-09-02 D7) — last, same reasoning.
    { id: "chat", label: "chat" },
  ],
  // Spec 2026-09-01 §8.3, in this order: submit → s, edit → e, discard → D,
  // route → r, thinking → t, follow → f, close (hidden) → q. The first four
  // act on the draft card under the cursor, the last two on the view. No
  // `chat` here (spec 2026-09-02 §5) — the chat view has no `c` of its own.
  chat: [
    { id: "submit", label: "submit" },
    { id: "edit", label: "edit" },
    { id: "discard", label: "discard", guarded: true },
    { id: "route", label: "route" },
    { id: "thinking", label: "thinking" },
    { id: "follow", label: "follow" },
    CLOSE,
    HELP,
  ],
};

const LOG_OVERLAY_OPTIONS: MnemonicOption[] = [
  { id: "follow", label: "follow" },
  { id: "level", label: "level" },
  { id: "ticket", label: "ticket" },
  CLOSE,
  HELP,
];
const LOG_OVERLAY_EXCLUDED: ReadonlySet<string> = new Set(["G"]);

// ── structural chip sets (today's key-first hints, unchanged wording) ──────
// Main contexts have no entry here: footerModel.ts's `navigateChips` /
// `mainBodyNav` are the one source for the main view's structural
// vocabulary (spec 2026-09-02 §3.2) — `viewStructural` / `structuralOnly` /
// `LOG_OVERLAY_STRUCTURAL` remain because the model reads THEM verbatim for
// non-main contexts.

function viewStructural(view: OverlayView): Chip[] {
  const s = (key: string, label: string): Chip => ({ kind: "structural", key, label });
  switch (view) {
    case "detail":
    case "repoDetail":
      return [s("↑/↓", "scroll"), s("esc", "back")];
    case "prDetail":
      return [s("esc", "back")];
    case "prs":
      return [s("↑/↓", "move"), s("enter", "detail"), s("esc/p", "back")];
    case "review":
      return [s("↑/↓", "move"), s("enter", "open/file"), s("space", "toggle"), s("esc", "back")];
    case "cmdOutput":
      return [s("↑/↓", "scroll"), s("esc", "back")];
    case "transcript":
      return [s("↑/↓", "tool"), s("enter", "expand"), s("[/]", "scroll"), s("esc", "back")];
    case "chat":
      // The chat-scroll brief (2026-09-02) supersedes spec §8.3's vocabulary:
      // ↑/↓ scroll the transcript, PgUp/PgDn page it, and `tab` is what walks
      // the draft cards. `[/]` is still an alias, but a row this long has no
      // space for aliases — the help modal lists them.
      return [
        s("↑/↓", "scroll"),
        s("pgup/pgdn", "page"),
        s("tab", "card"),
        s("enter", "expand"),
        s("i", "compose"),
        s("esc", "back"),
      ];
  }
}

function structuralOnly(view: StructuralOnlyView): Chip[] {
  const s = (key: string, label: string): Chip => ({ kind: "structural", key, label });
  switch (view) {
    case "filtering":
      return [s("type", "filter"), s("enter", "apply"), s("esc", "clear")];
    case "palette":
      return [s("type", "filter"), s("↑/↓", "move"), s("enter", "run"), s("esc", "close")];
    case "addRepo":
      return [s("enter", "next/submit"), s("esc", "cancel")];
    case "config":
      return [s("↑/↓", "field"), s("←/→", "section"), s("enter", "edit/toggle"), s("esc", "close")];
    case "help":
      return [s("any key", "close")];
    case "chatCompose":
      // The composer owns every key while focused (spec §8.3), so no mnemonic
      // may derive here. Its own keys are the ACTIONS row (footerModel.ts);
      // this is the navigate row, so it lists only what still works WHILE
      // typing — PgUp/PgDn are not text, so they still page the transcript.
      return [s("pgup/pgdn", "scroll"), s("esc", "blur")];
    case "chatConfirm":
      // A junco_submit card is waiting (spec 2026-09-03 §4.3): the answer keys
      // live on the ACTIONS row (footerModel.ts); this navigate row lists what
      // still works meanwhile. Empty keymap on purpose — no draft verb may
      // fire while the daemon holds a submit of that same draft.
      return [s("↑/↓", "scroll"), s("pgup/pgdn", "page"), s("i", "compose"), s("esc", "back")];
  }
}

const LOG_OVERLAY_STRUCTURAL: Chip[] = [
  { kind: "structural", key: "/", label: "search" },
  { kind: "structural", key: "[ ]", label: "scroll" },
  { kind: "structural", key: "G", label: "bottom" },
  { kind: "structural", key: "esc", label: "close" },
];

// ── assembly ───────────────────────────────────────────────────────────────

/** Which mnemonic ids render as chips per main pane, in CHIP ORDER (verbs
 * before globals on pane 2 — the derivation order is globals-first, which
 * reads wrong in the footer). The keymap always carries everything — chips
 * are the pane-relevant subset, like the old pane-filtered hint sets. This is
 * the input footerModel.ts's `buildFooterRows` re-groups into the two-row
 * footer's actions row: pill, then this order's non-go verbs, │, then its
 * go-globals (spec 2026-09-02 §4). */
const RAIL_CHIP_ORDER = [
  "chat",
  "assess",
  "browser",
  "refresh",
  "addRepo",
  "unwatch",
  "queue",
  "review",
  "prs",
  "quit",
  "help",
];
const ISSUES_CHIP_ORDER = [
  "chat",
  "dispatch",
  "approve",
  "analyze",
  "transcript",
  "assess",
  "browser",
  "prs",
  "review",
  "queue",
  "quit",
  "help",
];
const PANE3_CHIP_ORDER = ["chat", "browser", "prs", "review", "quit", "help"];
/** Spec §4 "main · repo detail body" (Ruling R11): a repo IS in context on
 * this body — `useMainActions`' `chat` handler reads `currentRepoKey`, which a
 * repoDetail row supplies — so the pill leads, followed by the repo-scoped
 * verbs a checkout with no issue list can act on. Before R11 this body fell
 * into the section arm below and rendered a bare `│ review PRs`: a live `c`
 * with no chip advertising it. */
const REPO_DETAIL_CHIP_ORDER = ["chat", "browser", "refresh", "assess", "queue", "review", "prs"];
/** Spec §4 "main · rail, system row" and "…queue/outbox/… body" (Ruling R11):
 * the section's own verbs, then the go-somewhere globals. NO repo is in
 * context, so neither the pill nor a repo-scoped verb belongs — on the rail as
 * much as in the body. `quit`/`help` are deliberately absent: footerModel
 * re-homes those to `navigate.pinned` off `bindings.all` regardless. */
const sectionChipOrder = (body: MainBody): string[] => [
  ...BODY_VERBS[body].filter((o) => !o.hidden).map((o) => o.id),
  "review",
  "prs",
];
/** A rail row that names a repo (watched → the issues body, everything else →
 * repoDetail); the other five bodies are the pinned system rows. */
const isRepoBody = (body: MainBody): boolean => body === "issues" || body === "repoDetail";

function mnemonicChip(d: DerivedMnemonic): Chip {
  return {
    kind: "mnemonic",
    id: d.id,
    key: d.key,
    label: d.label,
    charIndex: d.charIndex,
    guarded: d.guarded,
  };
}

function toKeymap(all: DerivedMnemonic[]): ReadonlyMap<string, string> {
  return new Map(all.map((d) => [d.key, d.id]));
}

/** `_mode`: kept for call-site compatibility (App.tsx and the test suite
 * always pass layout mode here); unread now that main contexts carry no
 * structural chips — footerModel.ts's `navigateChips` is what actually
 * varies by mode (spec 2026-09-02 §3.2, the medium-width drops). */
export function buildContextBindings(context: BindingContext, _mode: LayoutMode): ContextBindings {
  switch (context.kind) {
    case "main": {
      // The ONE pane this call knows about (it used to arrive as a second
      // argument that only this branch read, which let the keymap and the
      // chips be built for different panes).
      const pane = context.pane;
      const all = deriveMnemonics([...MAIN_GLOBALS, ...BODY_VERBS[context.body]], {
        reserved: MAIN_RESERVED,
        excluded: MAIN_EXCLUDED,
      });
      const visible = all.filter((d) => !d.hidden);
      // Chip order per §4 row, in the table's own precedence (Ruling R11).
      // Pane 1 is the RAIL, so it asks what the selected ROW is first: a repo
      // row (watched or local-only) keeps the rail's set — `add repo` /
      // `unwatch` are rail verbs and §4's "rail, repo row" lists them — while
      // a system row gets that section's verbs. Only past pane 1 does the
      // BODY decide, which is where `repoDetail` earns its own order.
      const chipOrder =
        pane === 1
          ? isRepoBody(context.body)
            ? RAIL_CHIP_ORDER
            : sectionChipOrder(context.body)
          : pane === 3
            ? PANE3_CHIP_ORDER
            : context.body === "issues"
              ? ISSUES_CHIP_ORDER
              : context.body === "repoDetail"
                ? REPO_DETAIL_CHIP_ORDER
                : sectionChipOrder(context.body);
      const byId = new Map(visible.map((d) => [d.id, d]));
      return {
        // Mnemonics only (spec 2026-09-02 §3.2): footerModel.ts's
        // `navigateChips` is the one source for this context's structural
        // vocabulary now — see the docstring on `chips` above.
        chips: chipOrder.flatMap((id) => {
          const d = byId.get(id);
          return d !== undefined ? [mnemonicChip(d)] : [];
        }),
        keymap: toKeymap(all),
        all,
      };
    }
    case "view": {
      const all = deriveMnemonics(VIEW_OPTIONS[context.view], { reserved: OVERLAY_RESERVED });
      return {
        chips: [
          ...viewStructural(context.view).slice(0, -1),
          ...all.filter((d) => !d.hidden).map(mnemonicChip),
          ...viewStructural(context.view).slice(-1),
        ],
        keymap: toKeymap(all),
        all,
      };
    }
    case "logOverlay": {
      const all = deriveMnemonics(LOG_OVERLAY_OPTIONS, {
        reserved: OVERLAY_RESERVED,
        excluded: LOG_OVERLAY_EXCLUDED,
      });
      return {
        chips: [...all.filter((d) => !d.hidden).map(mnemonicChip), ...LOG_OVERLAY_STRUCTURAL],
        keymap: toKeymap(all),
        all,
      };
    }
    case "structuralOnly":
      return { chips: structuralOnly(context.view), keymap: new Map(), all: [] };
  }
}
