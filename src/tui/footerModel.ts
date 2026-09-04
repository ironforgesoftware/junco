/**
 * The two-row footer model (spec 2026-09-02 §3–§4): ONE ContextBindings plus a
 * target label become an actions row (the chat pill, the context's verbs, │,
 * the go-somewhere globals) and a navigate row (the structural vocabulary,
 * with ? help and q pinned right). Pure — the renderer (Chrome.tsx Footer)
 * and the tests both consume `footerSegments`, so accent placement is
 * asserted here, never from ANSI-stripped frames. Dispatch keys are the
 * Chip.key STRINGS (chipActions maps structural chips by key); `keyGlyph`
 * only changes what is drawn.
 *
 * Ruling R10 (fix round 2): spec §3.2's "below 110 columns, drop g G / : / ,"
 * is superseded — the navigate row fits ITSELF to `columns` (`rowWidth` +
 * `NAV_DROP_ORDER`), because the row can overflow the terminal above 110
 * columns too (its content depends on the context, not just the breakpoint).
 * `mode` stays in `FooterInput` only for the `←/→ panes` vs `← repos` label.
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
  /** Terminal width — the navigate row fits itself to this (Ruling R10). */
  columns: number;
}

/** Row-1 target label slot. 24, not spec §3.1's 16: the chat view's label is
 * the bare session key now (hooks/useFooterTarget.ts dropped the `chat · `
 * prefix the header crumb already carries), and a real `owner/name` has to
 * fit it whole — a truncated repo name is the one label nobody can read, so
 * `fitTarget` below spends the overflow on the OWNER half instead (#472). */
export const TARGET_WIDTH = 24;
/** Navigate chips dropped, in this order, one at a time, until the row fits
 * `columns` (Ruling R10) — they stay in the keymap + help regardless. Keyed
 * on dispatch key, not id: every chip here is structural. */
export const NAV_DROP_ORDER: readonly string[] = [",", ":", "g/G", "[/]"];
/** The fit step that gives up the two rows' shared label slot — not a key, so
 * it can never collide with a chip's. */
export const NAV_DROP_LABEL = "label slot";
/** The full fit order (#464). After the four keys above, a main row could
 * still need ~72 columns (~88 behind a full-width target) and what got
 * clipped between MIN_COLS and there was the pinned `? help  quit` — the one
 * run spec §3.2 says never moves. So the row sheds two more things: the label
 * slot (the header crumb already names the target), then `/ filter`. The
 * issue's third candidate, shortening `first/last`, is unreachable — `g/G`
 * leaves at step 3. */
export const NAV_FIT_ORDER: readonly string[] = [...NAV_DROP_ORDER, NAV_DROP_LABEL, "/"];
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
 * synthesis needed. Dispatch for `?` in overlays lands in every arm of
 * hooks/useViewActions.ts + useLogOverlayActions.ts (App's `openHelp`), so
 * the pinned chip is live — by key and by click — everywhere it renders. */
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
  "pgup/pgdn": "⇞ ⇟",
  tab: "⇥",
};
/** Key string → display glyph (dispatch keys never change). */
export function keyGlyph(key: string): string {
  return GLYPHS[key] ?? key;
}

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
  return pane === 1
    ? [s("↑/↓", "move"), ...railOpen(body), ...common]
    : pane === 3
      ? [s("↑/↓", "move"), s("enter", "detail"), s("←", "issues"), ...common]
      : [...mainBodyNav(body, mode), ...common];
}
/** Pane 1's `→`/`⏎` labels, per the kind of row the rail cursor is on (#470).
 * `→` always focuses that row's body (App's pane-1 arm: `setPane(2)`), so only
 * a WATCHED repo row can honestly say `issues`; `⏎` opens the repo-detail
 * overlay on a repo row and the full-screen log on the logs row, and is the
 * same "focus the body" everywhere else. Spec §4's "main · rail, system row"
 * row said `→ open` all along — the code rendered the repo labels for every
 * pane-1 row. */
function railOpen(body: MainBody): FooterChip[] {
  if (body === "issues") return [s("→", "issues"), s("enter", "detail")];
  if (body === "repoDetail") return [s("→", "open"), s("enter", "detail")];
  return [s("→", "open"), s("enter", body === "logs" ? "log" : "open")];
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

/** Fits a target into `TARGET_WIDTH`. An `owner/repo` that overflows loses
 * OWNER characters, never repo ones (#472): on a rail full of one owner's
 * checkouts the owner is the redundant half and the name is the whole
 * message, and `alxedelweiss/arkanoid_o…` named nothing. Sizing the slot to
 * the widest loaded target was the alternative; a fixed slot keeps the fit
 * rules (`rowWidth`, Ruling R10) reading one constant instead of a value that
 * moves with every poll. Anything without an owner half — `issue #46`,
 * `queue`, a ticket id — keeps the plain tail cut. */
function fitTarget(target: string): string {
  if (target.length <= TARGET_WIDTH) return target;
  const slash = target.indexOf("/");
  if (slash > 0) {
    const name = target.slice(slash); // "/repo", the half that must survive
    const owner = TARGET_WIDTH - name.length - 1; // -1 for the ellipsis
    if (owner >= 1) return `${target.slice(0, owner)}…${name}`;
  }
  return `${target.slice(0, TARGET_WIDTH - 1)}…`;
}

export function buildFooterRows({
  context,
  bindings,
  target,
  chatReachable,
  mode,
  columns,
}: FooterInput): FooterRows {
  const label = fitTarget(target);
  const structural = bindings.chips.filter((c) => c.kind === "structural").map(fromChip);
  const mnemonics = bindings.chips.flatMap((c) => (c.kind === "mnemonic" ? [fromChip(c)] : []));
  // bindings.all is [] for structuralOnly contexts, so this is naturally []
  // there too — no per-context-kind branching needed (see the PINNED_IDS
  // docstring above).
  const pinned = PINNED_IDS.flatMap((id) =>
    bindings.all.filter((d) => d.id === id).map(fromMnemonic),
  );
  const verbs = mnemonics.filter((m) => !PINNED_IDS.includes(m.id));

  if (context.kind === "structuralOnly") {
    // Spec §4: the composer owns the keys; ⏎ send is the view's primary. The
    // chat-scroll brief (2026-09-02) supersedes §4's second row here: it was a
    // dim "esc, then …" reminder listing keys the composer swallows, and is
    // now the ordinary navigate row of what genuinely works while typing
    // (viewActions' `structuralOnly("chatCompose")` — PgUp/PgDn and esc).
    const chatCompose =
      context.view === "chatCompose"
        ? [
            {
              kind: "pill" as const,
              id: "enter",
              key: "enter",
              label: "send",
              charIndex: null,
              guarded: false,
            },
            s("ctrl+j", "newline"),
            s("/", "commands"),
            // While a junco_submit card waits, `esc` only blurs — #476 made
            // the abort conditional on `streaming && pending === null`
            // (useChatInput.ts), and an inert chip may not claim otherwise
            // (#479). The chip is the only place this is said now — #471 took
            // the duplicate key text out of ChatView's own header strip.
            s("esc", context.pending === true ? "blur" : "blur/abort"),
          ]
        : [];
    // Spec 2026-09-03 §4.3: the y/n of a waiting junco_submit card. `y` is the
    // primary (the pill), and these two are the whole actions row — the draft
    // verbs are off the keymap while the daemon holds that draft.
    const chatConfirm =
      context.view === "chatConfirm"
        ? [
            {
              kind: "pill" as const,
              id: "y",
              key: "y",
              label: "submit",
              charIndex: null,
              guarded: false,
            },
            s("n", "keep parked"),
          ]
        : [];
    return {
      actions: {
        label,
        chips: context.view === "chatConfirm" ? chatConfirm : chatCompose,
        pinned: [],
      },
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
    // The separator only earns its column when something precedes it: the
    // logs body has no verbs of its own, so its row is the go-globals alone
    // and used to open with a dangling `│` (#458).
    const lead = pill.length + here.length > 0;
    actions = [...pill, ...here, ...(go.length > 0 ? [...(lead ? [SEP] : []), ...go] : [])];
  } else {
    actions = [...pill, ...rest];
  }
  const navRaw = context.kind === "main" ? navigateChips(context, mode) : structural;
  const fit = fitNavigate(navRaw, pinned, label, columns);
  return {
    actions: { label: fit.label, chips: actions, pinned: [] },
    navigate: { label: fit.label === "" ? "" : "navigate", chips: fit.chips, pinned },
  };
}

/** Chrome.tsx's Footer sizes ONE label slot from both rows' labels, and every
 * navigate row's label is the literal "navigate" — so this is the width the
 * renderer will use, and `""` means no slot at all. */
const slotWidth = (label: string): number =>
  label === "" ? 0 : Math.max(label.length, "navigate".length);

/** Ruling R10 + #464: walks `NAV_FIT_ORDER` one step at a time — a no-op for a
 * key absent from `chips` (an overlay's own vocabulary rarely has one) — until
 * the row fits `columns`, or the list is exhausted (the renderer clips the
 * rest from the right; it never wraps). The label step returns `""`, which
 * takes the slot off BOTH rows, since they share its width. */
function fitNavigate(
  chips: FooterChip[],
  pinned: FooterChip[],
  label: string,
  columns: number,
): { chips: FooterChip[]; label: string } {
  let out = chips;
  let lbl = label;
  const fits = (): boolean =>
    rowWidth({ label: lbl, chips: out, pinned }, slotWidth(lbl)) <= columns;
  for (const step of NAV_FIT_ORDER) {
    if (fits()) break;
    if (step === NAV_DROP_LABEL) lbl = "";
    else out = out.filter((c) => c.key !== step);
  }
  return { chips: out, label: lbl };
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

/** Estimates one footer row's rendered width exactly as Chrome.tsx's
 * `FooterLine`/`ChipRun` lay it out (Ruling R10): `paddingX={1}` (both
 * sides), the label slot (`labelWidth`, `marginRight={2}` — absent entirely
 * at width 0, #464), then each run's
 * chips — `footerSegments` text length summed (keycap/pill padding spaces
 * are already part of those strings) plus the run's `gap={2}` BETWEEN its
 * chips (#460: no trailing margin on the last one), and the pinned run's own
 * `marginLeft={2}` when it has any chips. The `flexGrow`
 * spacer between the two runs contributes nothing: with no content of its
 * own it shrinks to 0 whenever the row is tight, which is exactly the case
 * this function exists to detect. A test pins this against a `renderWide`
 * frame's real line length so the estimate cannot drift from the renderer. */
export function rowWidth(row: FooterRow, labelWidth: number): number {
  const runWidth = (chips: FooterChip[]): number =>
    chips.reduce((n, c) => n + chipWidth(c), 0) + 2 * Math.max(0, chips.length - 1);
  return (
    2 +
    (labelWidth > 0 ? labelWidth + 2 : 0) +
    runWidth(row.chips) +
    (row.pinned.length > 0 ? 2 + runWidth(row.pinned) : 0)
  );
}
function chipWidth(chip: FooterChip): number {
  return footerSegments(chip).reduce((n, seg2) => n + seg2.text.length, 0);
}
