import { describe, expect, it } from "vitest";
import {
  buildContextBindings,
  type BindingContext,
  type MainBody,
} from "../src/tui/viewActions.js";

const km = (c: BindingContext): Record<string, string> =>
  Object.fromEntries(buildContextBindings(c, "wide").keymap);
/** The main context is pane-scoped for CHIP rendering only (Ruling R27's
 * pane-scoped `t` KEYMAP swap is withdrawn — spec 2026-09-02 D5): the keymap
 * is the same on every pane of a body, so the other bodies pin at pane 2 and
 * mean the same thing on any pane. */
const main = (body: MainBody, pane: 1 | 2 | 3 = 2): BindingContext => ({
  kind: "main",
  body,
  pane,
});
// surface-legibility Task 2: `assess`'s label became "audit" and `dispatch`'s
// became "import" (ids unchanged — see viewActions.ts's MAIN_GLOBALS/BODY_VERBS).
// Mnemonics derive from the LABEL, so this rebinds the whole cascade: "audit"
// claims 'a's runner-up 'u' (ahead of "queue"), pushing queue to 'e' and
// review to 'v' — a label edit that re-binds, exactly as this file's own
// docstring warns.
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

describe("pinned per-context keymaps (a label edit that re-binds FAILS here)", () => {
  it("main:issues (pane 2 — the issue list)", () => {
    expect(km(main("issues"))).toEqual({
      ...GLOBALS,
      m: "dispatch",
      o: "approve",
      n: "analyze",
      t: "transcript",
      I: "dispatchAsk",
      A: "assessAutoPlan",
      R: "replan",
    });
  });
  it("main:queue", () => {
    expect(km(main("queue"))).toEqual({ ...GLOBALS, t: "retry", D: "delete" });
  });
  it("main:outbox", () => {
    expect(km(main("outbox"))).toEqual({ ...GLOBALS, f: "flush" });
  });
  it("main:worktrees", () => {
    expect(km(main("worktrees"))).toEqual({ ...GLOBALS, P: "prune" });
  });
  it("main:daemon", () => {
    expect(km(main("daemon"))).toEqual({ ...GLOBALS, R: "restart", f: "flush" });
  });
  it("main:logs is globals-only", () => {
    expect(km(main("logs"))).toEqual(GLOBALS);
  });
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
      "?": "help",
      c: "chat",
      t: "transcript",
    });
    expect(km({ kind: "view", view: "prDetail" })).toEqual({
      b: "browser",
      q: "close",
      "?": "help",
      c: "chat",
    });
    expect(km({ kind: "view", view: "prs" })).toEqual({
      b: "browser",
      q: "close",
      "?": "help",
      c: "chat",
    });
    expect(km({ kind: "view", view: "review" })).toEqual({
      a: "all",
      n: "none",
      f: "file",
      D: "discard",
      q: "close",
      "?": "help",
      s: "submit",
      e: "edit",
      r: "route",
      c: "chat",
    });
    expect(km({ kind: "view", view: "transcript" })).toEqual({
      t: "thinking",
      f: "follow",
      q: "close",
      "?": "help",
      c: "chat",
    });
    expect(km({ kind: "view", view: "cmdOutput" })).toEqual({
      r: "reRun",
      q: "close",
      "?": "help",
    });
    expect(km({ kind: "view", view: "chat" })).not.toHaveProperty("c");
  });
  it("chat view (composer blurred) and chatCompose (focused)", () => {
    expect(km({ kind: "view", view: "chat" })).toEqual({
      s: "submit",
      e: "edit",
      D: "discard",
      r: "route",
      t: "thinking",
      f: "follow",
      q: "close",
      "?": "help",
    });
    expect(km({ kind: "structuralOnly", view: "chatCompose" })).toEqual({});
    const chips = buildContextBindings(
      { kind: "structuralOnly", view: "chatCompose" },
      "wide",
    ).chips.map((c) => c.label);
    expect(chips).toEqual(["message", "send", "newline", "commands", "blur/abort"]);
  });
  it("review gains submit/edit/route AFTER the existing four, keys unchanged, chat last (spec 2026-09-02 D7)", () => {
    expect(km({ kind: "view", view: "review" })).toEqual({
      a: "all",
      n: "none",
      f: "file",
      D: "discard",
      s: "submit",
      e: "edit",
      r: "route",
      q: "close",
      "?": "help",
      c: "chat",
    });
  });
  it("overlay views (each with the hidden reserved q close; chat appended where a repo is in context)", () => {
    expect(km({ kind: "view", view: "detail" })).toEqual({
      b: "browser",
      q: "close",
      "?": "help",
      c: "chat",
      t: "transcript",
    });
    expect(km({ kind: "view", view: "prDetail" })).toEqual({
      b: "browser",
      q: "close",
      "?": "help",
      c: "chat",
    });
    // repoDetail is not one of D7's "repo in context" overlays — no pill there.
    expect(km({ kind: "view", view: "repoDetail" })).toEqual({
      b: "browser",
      q: "close",
      "?": "help",
    });
    expect(km({ kind: "view", view: "prs" })).toEqual({
      b: "browser",
      q: "close",
      "?": "help",
      c: "chat",
    });
    expect(km({ kind: "view", view: "cmdOutput" })).toEqual({
      r: "reRun",
      q: "close",
      "?": "help",
    });
    expect(km({ kind: "view", view: "review" })).toEqual({
      a: "all",
      n: "none",
      f: "file",
      D: "discard",
      q: "close",
      "?": "help",
      s: "submit",
      e: "edit",
      r: "route",
      c: "chat",
    });
    expect(km({ kind: "view", view: "transcript" })).toEqual({
      t: "thinking",
      f: "follow",
      q: "close",
      "?": "help",
      c: "chat",
    });
  });
  it("logOverlay", () => {
    expect(km({ kind: "logOverlay" })).toEqual({
      f: "follow",
      l: "level",
      t: "ticket",
      q: "close",
      "?": "help",
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
      for (const pane of [1, 2, 3] as const) {
        const m = km(main(body, pane));
        for (const [k, id] of Object.entries(GLOBALS)) expect(m[k]).toBe(id);
      }
    }
  });

  it("no context ever hits the exhaustion fallback (reserved-out-of-label keys excepted)", () => {
    const contexts: BindingContext[] = [
      ...MAIN_BODIES.flatMap((body) => [main(body, 1), main(body, 2), main(body, 3)]),
      { kind: "view", view: "review" },
      { kind: "view", view: "cmdOutput" },
      { kind: "view", view: "detail" },
      { kind: "view", view: "prs" },
      { kind: "view", view: "prDetail" },
      { kind: "view", view: "repoDetail" },
      { kind: "view", view: "transcript" },
      { kind: "view", view: "chat" },
      { kind: "logOverlay" },
    ];
    for (const c of contexts) {
      for (const d of buildContextBindings(c, "wide").all) {
        if (d.key === "?" || d.id === "close") continue; // reserved keys not in-label
        expect(d.charIndex, `${JSON.stringify(c)} ${d.id}`).not.toBeNull();
      }
    }
  });

  it("chips: hidden options never render; pane 1 chips are the rail set", () => {
    const b = buildContextBindings(main("issues", 1), "wide");
    const ids = b.chips.flatMap((ch) => (ch.kind === "mnemonic" ? [ch.id] : []));
    expect(ids).not.toContain("dispatchAsk");
    expect(ids).toContain("addRepo");
    expect(ids).not.toContain("dispatch"); // pane-2 verb, not a rail chip
    expect(ids).not.toContain("transcript"); // the issue-list verb, not the rail's
  });

  it("chips: pane 2 issues carries the issue verbs, not the rail-only verbs", () => {
    const b = buildContextBindings(main("issues", 2), "wide");
    const ids = b.chips.flatMap((ch) => (ch.kind === "mnemonic" ? [ch.id] : []));
    expect(ids).toEqual(expect.arrayContaining(["dispatch", "approve", "analyze", "assess"]));
    expect(ids).not.toContain("addRepo");
    // R27 is withdrawn (spec 2026-09-02 D5): chat is a global chip everywhere,
    // including the issue list, alongside the list's own `t` transcript chip.
    expect(ids).toContain("chat");
  });

  it("chips: a section body (no verbs of its own) advertises the go-somewhere globals", () => {
    // repoDetail's own body-verb list is now empty — chat moved to the
    // MAIN_GLOBAL chip sets above, so this body's row is just review/PRs
    // (spec 2026-09-02 §3.1's "body verbs │ review · PRs" — no verbs here).
    const b = buildContextBindings(main("repoDetail", 2), "wide");
    const ids = b.chips.flatMap((ch) => (ch.kind === "mnemonic" ? [ch.id] : []));
    expect(ids).toEqual(["review", "prs"]);
  });

  it("structuralOnly contexts derive nothing", () => {
    const b = buildContextBindings({ kind: "structuralOnly", view: "palette" }, "wide");
    expect(b.all).toEqual([]);
    expect(b.chips.every((c) => c.kind === "structural")).toBe(true);
  });
});
