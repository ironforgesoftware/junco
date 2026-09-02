import { describe, expect, it } from "vitest";
import { buildContextBindings, type BindingContext } from "../src/tui/viewActions.js";

const km = (c: BindingContext): Record<string, string> =>
  Object.fromEntries(buildContextBindings(c, 2, "wide").keymap);
// surface-legibility Task 2: `assess`'s label became "audit" and `dispatch`'s
// became "import" (ids unchanged — see viewActions.ts's MAIN_GLOBALS/BODY_VERBS).
// Mnemonics derive from the LABEL, so this rebinds the whole cascade: "audit"
// claims 'a's runner-up 'u' (ahead of "queue"), pushing queue to 'e' and
// review to 'v' — a label edit that re-binds, exactly as this file's own
// docstring warns.
const GLOBALS = {
  a: "addRepo",
  U: "unwatch",
  b: "browser",
  r: "refresh",
  u: "assess",
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
      m: "dispatch",
      o: "approve",
      n: "analyze",
      t: "chat",
      I: "dispatchAsk",
      A: "assessAutoPlan",
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
  it("main:logs is globals-only", () => {
    expect(km({ kind: "main", body: "logs" })).toEqual(GLOBALS);
  });
  it("main:issues and main:repoDetail carry chat on t (a body verb — the queue body keeps t for retry)", () => {
    expect(km({ kind: "main", body: "issues" })).toMatchObject({ t: "chat" });
    expect(km({ kind: "main", body: "repoDetail" })).toEqual({ ...GLOBALS, t: "chat" });
    expect(km({ kind: "main", body: "queue" })).toMatchObject({ t: "retry" });
    expect(km({ kind: "main", body: "logs" })).toEqual(GLOBALS);
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
    });
    expect(km({ kind: "structuralOnly", view: "chatCompose" })).toEqual({});
    const chips = buildContextBindings(
      { kind: "structuralOnly", view: "chatCompose" },
      2,
      "wide",
    ).chips.map((c) => c.label);
    expect(chips).toEqual(["message", "send", "newline", "commands", "blur/abort"]);
  });
  it("review gains submit/edit/route AFTER the existing four, keys unchanged", () => {
    expect(km({ kind: "view", view: "review" })).toEqual({
      a: "all",
      n: "none",
      f: "file",
      D: "discard",
      s: "submit",
      e: "edit",
      r: "route",
      q: "close",
    });
  });
  it("overlay views (each with the hidden reserved q close)", () => {
    for (const view of ["detail", "prDetail", "repoDetail", "prs"] as const) {
      expect(km({ kind: "view", view })).toEqual({ b: "browser", q: "close" });
    }
    expect(km({ kind: "view", view: "cmdOutput" })).toEqual({ r: "reRun", q: "close" });
    expect(km({ kind: "view", view: "review" })).toEqual({
      a: "all",
      n: "none",
      f: "file",
      D: "discard",
      q: "close",
      s: "submit",
      e: "edit",
      r: "route",
    });
    expect(km({ kind: "view", view: "transcript" })).toEqual({
      t: "thinking",
      f: "follow",
      q: "close",
    });
  });
  it("main:queue structural chips offer enter → transcript", () => {
    const chips = buildContextBindings({ kind: "main", body: "queue" }, 2, "wide").chips;
    expect(chips).toContainEqual({ kind: "structural", key: "enter", label: "transcript" });
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

  it("no context ever hits the exhaustion fallback (reserved-out-of-label keys excepted)", () => {
    const contexts: BindingContext[] = [
      ...MAIN_BODIES.map((body) => ({ kind: "main", body }) as BindingContext),
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
      for (const d of buildContextBindings(c, 2, "wide").all) {
        if (d.key === "?" || d.id === "close") continue; // reserved keys not in-label
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

  it("chips: pane 2 issues carries the issue verbs, not the rail-only verbs", () => {
    const b = buildContextBindings({ kind: "main", body: "issues" }, 2, "wide");
    const ids = b.chips.flatMap((ch) => (ch.kind === "mnemonic" ? [ch.id] : []));
    expect(ids).toEqual(expect.arrayContaining(["dispatch", "approve", "analyze", "assess"]));
    expect(ids).not.toContain("addRepo");
  });

  it("structuralOnly contexts derive nothing", () => {
    const b = buildContextBindings({ kind: "structuralOnly", view: "palette" }, 2, "wide");
    expect(b.all).toEqual([]);
    expect(b.chips.every((c) => c.kind === "structural")).toBe(true);
  });
});
