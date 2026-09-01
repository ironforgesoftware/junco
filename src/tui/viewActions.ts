/**
 * Per-context mnemonic tables for the dashboard: each context's ordered named
 * options run through deriveMnemonics (mnemonics.ts) and the ONE derived
 * result feeds the footer chips, the help modal, and App's keyboard dispatch
 * — render and input cannot drift. The actual derived letters are pinned by
 * tests/tuiViewActions.test.ts; edit a label here and that pin fails loudly
 * instead of a key silently re-binding.
 * Spec: docs/superpowers/specs/2026-07-20-tui-mnemonic-shortcuts-design.md §2.
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
  | "transcript";

export type BindingContext =
  | { kind: "main"; body: MainBody }
  | { kind: "view"; view: OverlayView }
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
  /** Render order: structural chips (key-first form) + visible mnemonics. */
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
 * shared verbs derive the same key regardless of body (spec §2). */
const MAIN_GLOBALS: MnemonicOption[] = [
  { id: "addRepo", label: "add repo" },
  { id: "unwatch", label: "unwatch", guarded: true },
  { id: "browser", label: "browser" },
  { id: "refresh", label: "refresh" },
  { id: "assess", label: "audit" },
  { id: "queue", label: "queue" },
  { id: "review", label: "review" },
  { id: "prs", label: "PRs" },
  { id: "commands", label: "commands" },
  { id: "quit", label: "quit" },
  { id: "help", label: "help" },
];

const BODY_VERBS: Record<MainBody, MnemonicOption[]> = {
  issues: [
    { id: "dispatch", label: "import" },
    { id: "approve", label: "approve" },
    { id: "analyze", label: "investigate" },
    // Shift variants: bound, help-only (spec §2 hidden set).
    { id: "dispatchAsk", label: "import as ask", guarded: true, hidden: true },
    { id: "assessAutoPlan", label: "audit auto-plan", guarded: true, hidden: true },
    { id: "replan", label: "re-plan", guarded: true, hidden: true },
  ],
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

/** Every overlay carries a hidden reserved q → close (esc stays structural). */
const OVERLAY_RESERVED: ReadonlyMap<string, string> = new Map([["close", "q"]]);
const CLOSE: MnemonicOption = { id: "close", label: "close", hidden: true };

const VIEW_OPTIONS: Record<OverlayView, MnemonicOption[]> = {
  detail: [{ id: "browser", label: "browser" }, CLOSE],
  repoDetail: [{ id: "browser", label: "browser" }, CLOSE],
  prs: [{ id: "browser", label: "browser" }, CLOSE],
  prDetail: [{ id: "browser", label: "browser" }, CLOSE],
  review: [
    { id: "all", label: "all" },
    { id: "none", label: "none" },
    { id: "file", label: "file" },
    { id: "discard", label: "discard", guarded: true },
    CLOSE,
  ],
  cmdOutput: [{ id: "reRun", label: "re-run" }, CLOSE],
  transcript: [{ id: "thinking", label: "thinking" }, { id: "follow", label: "follow" }, CLOSE],
};

const LOG_OVERLAY_OPTIONS: MnemonicOption[] = [
  { id: "follow", label: "follow" },
  { id: "level", label: "level" },
  { id: "ticket", label: "ticket" },
  CLOSE,
];
const LOG_OVERLAY_EXCLUDED: ReadonlySet<string> = new Set(["G"]);

// ── structural chip sets (today's key-first hints, unchanged wording) ──────

function mainStructural(body: MainBody, pane: 1 | 2 | 3, mode: LayoutMode): Chip[] {
  const s = (key: string, label: string): Chip => ({ kind: "structural", key, label });
  if (pane === 1) return [s("↑/↓", "move")];
  if (pane === 3) return [s("↑/↓", "move"), s("enter", "detail"), s("←", "issues")];
  switch (body) {
    case "issues":
      // No `,` config chip: the pane-2 row is width-budgeted at 120 cols
      // (Footer clips, never wraps) — config stays on the key + help modal.
      return [
        s("↑/↓", "move"),
        mode === "wide" ? s("←/→", "panes") : s("←", "repos"),
        s("enter", "preview"),
        s("/", "filter"),
      ];
    case "repoDetail":
      return [s("[ ]", "scroll"), s("←", "back")];
    case "queue":
      return [s("↑/↓", "move"), s("enter", "transcript"), s("←", "back")];
    case "outbox":
    case "worktrees":
      return [s("↑/↓", "move"), s("←", "back")];
    case "daemon":
      return [s("[/]", "scroll"), s("←", "back")];
    case "logs":
      return [s("enter", "open log"), s("←", "back")];
  }
}

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
  }
}

function structuralOnly(view: "palette" | "addRepo" | "config" | "help" | "filtering"): Chip[] {
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
 * are the pane-relevant subset, like the old pane-filtered hint sets. */
const RAIL_CHIP_ORDER = [
  "addRepo",
  "unwatch",
  "browser",
  "refresh",
  "assess",
  "queue",
  "commands",
  "quit",
  "help",
];
const ISSUES_CHIP_ORDER = ["dispatch", "approve", "analyze", "assess", "prs", "quit", "help"];
const PANE3_CHIP_ORDER = ["browser", "quit", "help"];

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

export function buildContextBindings(
  context: BindingContext,
  pane: 1 | 2 | 3,
  mode: LayoutMode,
): ContextBindings {
  switch (context.kind) {
    case "main": {
      const all = deriveMnemonics([...MAIN_GLOBALS, ...BODY_VERBS[context.body]], {
        reserved: MAIN_RESERVED,
        excluded: MAIN_EXCLUDED,
      });
      const visible = all.filter((d) => !d.hidden);
      const chipOrder =
        pane === 1
          ? RAIL_CHIP_ORDER
          : pane === 3
            ? PANE3_CHIP_ORDER
            : context.body === "issues"
              ? ISSUES_CHIP_ORDER
              : // Section/RepoDetail bodies: the body's own verbs (globals
                // live on the rail chips; the keymap carries them anyway).
                BODY_VERBS[context.body].filter((o) => !o.hidden).map((o) => o.id);
      const byId = new Map(visible.map((d) => [d.id, d]));
      return {
        chips: [
          ...mainStructural(context.body, pane, mode),
          ...chipOrder.flatMap((id) => {
            const d = byId.get(id);
            return d !== undefined ? [mnemonicChip(d)] : [];
          }),
        ],
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
