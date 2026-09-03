import { describe, it, expect } from "vitest";
import { buildContextBindings, type BindingContext } from "../src/tui/viewActions.js";
import {
  buildFooterRows,
  footerSegments,
  keyGlyph,
  TARGET_WIDTH,
  type FooterChip,
  type FooterInput,
} from "../src/tui/footerModel.js";

const rows = (
  context: BindingContext,
  over: {
    target?: string;
    chatReachable?: boolean;
    mode?: "wide" | "medium";
    /** Default 200: wide enough that Ruling R10's fitting never engages
     * unless a test deliberately narrows it. */
    columns?: number;
  } = {},
) =>
  buildFooterRows({
    context,
    bindings: buildContextBindings(context, over.mode ?? "wide"),
    target: over.target ?? "acme/api",
    chatReachable: over.chatReachable ?? true,
    mode: over.mode ?? "wide",
    columns: over.columns ?? 200,
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
    // The main view pins [help, quit] — no `close` option exists there, so the
    // one bindings.all-derived formula yields the main pair (Ruling R5).
    expect(texts(r.navigate.pinned)).toEqual(["mnemonic:help:help", "mnemonic:quit:quit"]);
  });
  it("rail on a SYSTEM row: that section's verbs │ review, PRs — no pill, no repo verbs (R11)", () => {
    // The undelivered §4 row: pane 1 used to hand a queue row the RAIL order,
    // so the bar read `audit browser refresh add repo Unwatch │ queue review
    // PRs` against the target `queue` — five verbs that only toast there.
    const r = rows(
      { kind: "main", body: "queue", pane: 1 },
      { target: "queue", chatReachable: false },
    );
    expect(texts(r.actions.chips)).toEqual([
      "mnemonic:retry:retry",
      "mnemonic:delete:delete",
      "│",
      "mnemonic:review:review",
      "mnemonic:prs:PRs",
    ]);
    expect(r.actions.chips.some((c) => c.kind === "pill")).toBe(false);
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
  it("repo detail body: pill · browser · refresh · audit │ queue · review · PRs (R11)", () => {
    // The other undelivered §4 row: this body used to render a bare `│ review
    // PRs` with NO pill, while `c` was live on it — pill ⇔ handler, broken.
    const r = rows({ kind: "main", body: "repoDetail", pane: 2 }, { target: "junco" });
    expect(texts(r.actions.chips)).toEqual([
      "pill:chat:chat",
      "mnemonic:browser:browser",
      "mnemonic:refresh:refresh",
      "mnemonic:assess:audit",
      "│",
      "mnemonic:queue:queue",
      "mnemonic:review:review",
      "mnemonic:prs:PRs",
    ]);
  });
  it("medium width (100 cols) drops , and : from navigate and nothing from actions", () => {
    // Ruling R10: NAV_DROP_MEDIUM/mode-gated dropping is gone — `columns`
    // drives it now. `mode: "medium"` here is only for the `← repos` label
    // (spec: `←/→ panes` in wide, `← repos` otherwise). At 100 columns the
    // fit needs only the first two NAV_DROP_ORDER entries ("," then ":") to
    // get under budget — "g/G" stays, unlike the old fixed mode-gated drop
    // (always all three) this test pinned before R10. Verified by computing
    // `rows(...)` at columns 60..200 in 1-column steps and reading off the
    // exact threshold where each entry drops (fix round 2 report).
    const r = rows({ kind: "main", body: "issues", pane: 2 }, { mode: "medium", columns: 100 });
    expect(texts(r.navigate.chips)).toEqual([
      "structural:↑/↓:move",
      "structural:←:repos",
      "structural:enter:preview",
      "structural:/:filter",
      "structural:g/G:first/last",
    ]);
    expect(r.actions.chips[0]!.kind).toBe("pill");
  });
  it("Ruling R10: 112 columns (wide, issues pane 2) drops exactly ,", () => {
    const r = rows({ kind: "main", body: "issues", pane: 2 }, { columns: 112 });
    expect(texts(r.navigate.chips)).toEqual([
      "structural:↑/↓:move",
      "structural:←/→:panes",
      "structural:enter:preview",
      "structural:/:filter",
      "structural:g/G:first/last",
      "structural:::palette",
    ]);
  });
  it("Ruling R10: 200 columns (wide, issues pane 2) drops nothing", () => {
    const r = rows({ kind: "main", body: "issues", pane: 2 }, { columns: 200 });
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
  it("Ruling R10: a row that cannot fit even after all four drops overflows untouched (review overlay, 60 cols)", () => {
    // review's own structural vocabulary (↑/↓ move, ⏎ open/file, space
    // toggle, esc back) shares no key with NAV_DROP_ORDER, so all four
    // attempted drops are no-ops — the row is left exactly as derived, and
    // Chrome.tsx's overflow="hidden" clips it visually (never wraps).
    const r = rows({ kind: "view", view: "review" }, { columns: 60 });
    expect(texts(r.navigate.chips)).toEqual([
      "structural:↑/↓:move",
      "structural:enter:open/file",
      "structural:space:toggle",
      "structural:esc:back",
    ]);
  });
  it("the target label is truncated to TARGET_WIDTH", () => {
    const r = rows({ kind: "main", body: "issues", pane: 1 }, { target: "x".repeat(40) });
    expect(r.actions.label).toHaveLength(TARGET_WIDTH);
    expect(r.actions.label.endsWith("…")).toBe(true);
    // 24 columns: wide enough for a real owner/name, which the chat view's
    // label now is in full (the header crumb already says "chat").
    expect(TARGET_WIDTH).toBe(24);
    expect(
      rows({ kind: "view", view: "chat" }, { target: "alxedelweiss/junco" }).actions.label,
    ).toBe("alxedelweiss/junco");
  });

  // Compact coverage: the remaining main body arms of mainBodyNav, each on
  // pane 2 so the generic (non-rail/pane3/issues) path is exercised.
  it("repoDetail body: [ ] scroll, ← rail", () => {
    const r = rows({ kind: "main", body: "repoDetail", pane: 2 });
    expect(texts(r.navigate.chips)).toEqual([
      "structural:[/]:scroll",
      "structural:←:rail",
      "structural:g/G:first/last",
      "structural:::palette",
      "structural:,:config",
    ]);
  });
  it("outbox body: ↑/↓ move, ← rail", () => {
    const r = rows({ kind: "main", body: "outbox", pane: 2 });
    expect(texts(r.navigate.chips)).toEqual([
      "structural:↑/↓:move",
      "structural:←:rail",
      "structural:g/G:first/last",
      "structural:::palette",
      "structural:,:config",
    ]);
  });
  it("worktrees body: ↑/↓ move, ← rail", () => {
    const r = rows({ kind: "main", body: "worktrees", pane: 2 });
    expect(texts(r.navigate.chips)).toEqual([
      "structural:↑/↓:move",
      "structural:←:rail",
      "structural:g/G:first/last",
      "structural:::palette",
      "structural:,:config",
    ]);
  });
  it("daemon body: [ ] scroll, ← rail", () => {
    const r = rows({ kind: "main", body: "daemon", pane: 2 });
    expect(texts(r.navigate.chips)).toEqual([
      "structural:[/]:scroll",
      "structural:←:rail",
      "structural:g/G:first/last",
      "structural:::palette",
      "structural:,:config",
    ]);
  });
  it("logs body: enter open log, ← rail", () => {
    const r = rows({ kind: "main", body: "logs", pane: 2 });
    expect(texts(r.navigate.chips)).toEqual([
      "structural:enter:open log",
      "structural:←:rail",
      "structural:g/G:first/last",
      "structural:::palette",
      "structural:,:config",
    ]);
  });

  it("the empty-go case: a hand-rolled main body with no go-globals in its chips", () => {
    const context: BindingContext = { kind: "main", body: "logs", pane: 2 };
    const r = buildFooterRows({
      context,
      bindings: {
        chips: [
          { kind: "mnemonic", id: "flush", key: "f", label: "flush", charIndex: 0, guarded: false },
        ],
        keymap: new Map(),
        all: [],
      },
      target: "logs",
      chatReachable: false,
      mode: "wide",
      columns: 200,
    });
    expect(texts(r.actions.chips)).toEqual(["mnemonic:flush:flush"]);
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
  it("chat view, composer focused: ⏎ send is the pill; navigate lists what still works while typing", () => {
    const r = rows({ kind: "structuralOnly", view: "chatCompose" }, { target: "acme/api" });
    expect(texts(r.actions.chips)).toEqual([
      "pill:enter:send",
      "structural:ctrl+j:newline",
      "structural:/:commands",
      "structural:esc:blur/abort",
    ]);
    // The chat-scroll brief replaced spec §4's "esc, then …" prose reminder
    // (which listed keys the composer swallows) with the two that are really
    // live here: PgUp/PgDn scroll the transcript under it, esc blurs.
    expect(texts(r.navigate.chips)).toEqual(["structural:pgup/pgdn:scroll", "structural:esc:blur"]);
    expect(r.navigate.pinned).toEqual([]);
    // Real keycaps, not prose: the glyph pair sits in a keycap segment.
    expect(footerSegments(r.navigate.chips[0]!)[0]).toMatchObject({
      text: " ⇞ ⇟ ",
      keycap: true,
    });
  });
  it("chat view, blurred: draft verbs on actions, the chat's own scrolling on navigate", () => {
    const r = rows({ kind: "view", view: "chat" }, { target: "acme/api" });
    expect(texts(r.actions.chips)).toEqual([
      "mnemonic:submit:submit",
      "mnemonic:edit:edit",
      "mnemonic:discard:discard",
      "mnemonic:route:route",
      "mnemonic:thinking:thinking",
      "mnemonic:follow:follow",
    ]);
    expect(texts(r.navigate.chips)).toEqual([
      "structural:↑/↓:scroll",
      "structural:pgup/pgdn:page",
      "structural:tab:card",
      "structural:enter:expand",
      "structural:i:compose",
      "structural:esc:back",
    ]);
    // Verified: useViewActions' "chat" case returns chatHandlers directly,
    // and useChatInput.ts's chatHandlers already includes `close` (Task-19
    // chat plan) — real dispatch exists, not just a table entry.
    expect(texts(r.navigate.pinned)).toEqual(["mnemonic:help:help", "mnemonic:close:close"]);
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
    // Ruling R5: LOG_OVERLAY_OPTIONS now carries a hidden reserved `help`
    // alongside `close`, so the same bindings.all-derived pinned formula
    // naturally yields [help, close] here too — `esc` above is still the
    // clickable close (its own structural chip); this is the "? help"
    // reminder pinned right, same as every other overlay.
    expect(texts(r.navigate.pinned)).toEqual(["mnemonic:help:help", "mnemonic:close:close"]);
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
    expect(keyGlyph("pgup/pgdn")).toBe("⇞ ⇟");
    expect(keyGlyph("tab")).toBe("⇥");
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
  it("a mnemonic with a mid-label lit letter splits both prefix and suffix", () => {
    // qu[e]ue: charIndex 2 is neither first nor last, so both the `i > 0`
    // prefix branch and the `i + 1 < label.length` suffix branch fire.
    expect(
      footerSegments({
        kind: "mnemonic",
        id: "queue",
        key: "e",
        label: "queue",
        charIndex: 2,
        guarded: false,
      }),
    ).toEqual([
      { text: "qu", accent: false, underline: false, keycap: false, pill: false, dim: false },
      { text: "e", accent: true, underline: true, keycap: false, pill: false, dim: false },
      { text: "ue", accent: false, underline: false, keycap: false, pill: false, dim: false },
    ]);
  });
  it("a mnemonic with the lit letter LAST has a prefix but no suffix segment", () => {
    // cha[t]: charIndex 3 is the last letter of "chat", so `i + 1 <
    // label.length` (4 < 4) is false — no trailing plain segment.
    expect(
      footerSegments({
        kind: "mnemonic",
        id: "chat",
        key: "t",
        label: "chat",
        charIndex: 3,
        guarded: false,
      }),
    ).toEqual([
      { text: "cha", accent: false, underline: false, keycap: false, pill: false, dim: false },
      { text: "t", accent: true, underline: true, keycap: false, pill: false, dim: false },
    ]);
  });
  it("a mnemonic with charIndex null renders the key then the label plain", () => {
    expect(
      footerSegments({
        kind: "mnemonic",
        id: "reRun",
        key: "r",
        label: "re-run",
        charIndex: null,
        guarded: false,
      }),
    ).toEqual([
      { text: "r", accent: true, underline: true, keycap: false, pill: false, dim: false },
      { text: " re-run", accent: false, underline: false, keycap: false, pill: false, dim: false },
    ]);
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
  it("a guarded pill uppercases the lit letter in place", () => {
    expect(
      footerSegments({
        kind: "pill",
        id: "discard",
        key: "D",
        label: "discard",
        charIndex: 0,
        guarded: true,
      }),
    ).toEqual([
      { text: " ", accent: false, underline: false, keycap: false, pill: true, dim: false },
      { text: "D", accent: false, underline: true, keycap: false, pill: true, dim: false },
      { text: "iscard ", accent: false, underline: false, keycap: false, pill: true, dim: false },
    ]);
  });
  it("a pill with a mid-label lit letter yields the split prefix/suffix segments", () => {
    expect(
      footerSegments({
        kind: "pill",
        id: "send",
        key: "t",
        label: "chat",
        charIndex: 3,
        guarded: false,
      }),
    ).toEqual([
      { text: " cha", accent: false, underline: false, keycap: false, pill: true, dim: false },
      { text: "t", accent: false, underline: true, keycap: false, pill: true, dim: false },
      { text: " ", accent: false, underline: false, keycap: false, pill: true, dim: false },
    ]);
  });
  it("a pill with charIndex null renders one pill-flagged segment: key, label, padding", () => {
    expect(
      footerSegments({
        kind: "pill",
        id: "enter",
        key: "enter",
        label: "send",
        charIndex: null,
        guarded: false,
      }),
    ).toEqual([
      { text: " ⏎ send ", accent: false, underline: false, keycap: false, pill: true, dim: false },
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

// Type-only smoke: FooterInput must accept exactly this shape.
const _typeCheck: FooterInput = {
  context: { kind: "logOverlay" },
  bindings: { chips: [], keymap: new Map(), all: [] },
  target: "logs",
  chatReachable: false,
  mode: "wide",
  columns: 200,
};
void _typeCheck;
