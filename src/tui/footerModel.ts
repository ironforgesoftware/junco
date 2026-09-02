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
import type { DerivedMnemonic } from "./mnemonics.js";
import type { LayoutMode } from "./layout.js";

export type FooterChipKind = "pill" | "mnemonic" | "structural" | "separator";
export interface FooterChip {
  kind: FooterChipKind;
  /** Dispatch key: mnemonic/pill → derived letter; structural → the Chip.key STRING. */
  key: string;
  label: string;
  charIndex: number | null;
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
/** Pinned-right ids, in order; `close` is the overlays' q. Read off
 * `bindings.all` (hidden included — Ruling R5, spec 2026-09-02 §3.2): every
 * overlay's `VIEW_OPTIONS`/`LOG_OVERLAY_OPTIONS` table carries a hidden
 * reserved `help` (`?`) alongside `close` (`q`) now, so `main` naturally
 * yields [help, quit] (no `close` entry there) and overlays naturally yield
 * [help, close] (no `quit` entry there) from the SAME filter — no
 * synthesis needed. `?` has no dispatch handler in overlays yet (Tasks 3+4
 * carry it), so the pinned chip renders but is inert there for now. */
const PINNED_IDS = ["help", "quit", "close"];
function fromMnemonic(d: DerivedMnemonic): FooterChip {
  return {
    kind: "mnemonic",
    id: d.id,
    key: d.key,
    label: d.label,
    charIndex: d.charIndex,
    guarded: d.guarded,
  };
}

const GLYPHS: Record<string, string> = {
  enter: "⏎",
  "↑/↓": "↑↓",
  "←/→": "←→",
  "[/]": "[ ]",
  "esc/p": "esc·p",
  "g/G": "g G",
};
/** Key string → display glyph (dispatch keys never change). */
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

/** Spec §3.2: one vocabulary; only the ⏎/←/→ labels say what they do here.
 * `main` contexts only — overlays' structural chips ARE their own vocabulary
 * (viewStructural / structuralOnly / LOG_OVERLAY_STRUCTURAL, unchanged
 * wording), so `buildFooterRows` never calls this for them. */
function navigateChips(
  context: Extract<BindingContext, { kind: "main" }>,
  mode: LayoutMode,
): FooterChip[] {
  const { body, pane } = context;
  const common = [s("g/G", "first/last"), s(":", "palette"), s(",", "config")];
  const out =
    pane === 1
      ? [s("↑/↓", "move"), s("→", "issues"), s("enter", "detail"), ...common]
      : pane === 3
        ? [s("↑/↓", "move"), s("enter", "detail"), s("←", "issues"), ...common]
        : [...mainBodyNav(body, mode), ...common];
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
  // bindings.all is [] for structuralOnly contexts, so this is naturally []
  // there too — no per-context-kind branching needed (see the PINNED_IDS
  // docstring above).
  const pinned = PINNED_IDS.flatMap((id) =>
    bindings.all.filter((d) => d.id === id).map(fromMnemonic),
  );
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
/** The one styling model both the renderer and the tests consume (spec §3.4). */
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
      // Every pill segment carries a literal padding space (leading on the
      // prefix, trailing on the suffix), so none can ever be empty — unlike
      // the mnemonic branch below, there is nothing here to filter out.
      return [
        seg(` ${chip.label.slice(0, i)}`, { pill: true }),
        seg(ch, { pill: true, underline: true }),
        seg(`${chip.label.slice(i + 1)} `, { pill: true }),
      ];
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
