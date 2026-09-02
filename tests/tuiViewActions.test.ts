import { describe, expect, it } from "vitest";
import {
  buildContextBindings,
  type BindingContext,
  type MainBody,
} from "../src/tui/viewActions.js";

const km = (c: BindingContext): Record<string, string> =>
  Object.fromEntries(buildContextBindings(c, "wide").keymap);
/** The main context is pane-scoped (Ruling R27): only the issues body reads
 * the pane (t = transcript on the list, chat everywhere else), so the other
 * bodies pin at pane 2 and mean the same thing on any pane. */
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
  it("t is pane-scoped in the issues body: transcript on the list, chat off it (R27)", () => {
    // Same slot, same derived letter, one honest label per pane (#330 owns the
    // issue row; spec 2026-09-01 §8.1 owns the repo row).
    expect(km(main("issues", 2))).toMatchObject({ t: "transcript" });
    expect(km(main("issues", 1))).toMatchObject({ t: "chat" });
    expect(km(main("issues", 3))).toMatchObject({ t: "chat" });
    // Off the issues body the pane changes nothing.
    for (const pane of [1, 2, 3] as const) {
      expect(km(main("repoDetail", pane))).toEqual({ ...GLOBALS, t: "chat" });
      expect(km(main("queue", pane))).toMatchObject({ t: "retry" });
      expect(km(main("logs", pane))).toEqual(GLOBALS);
    }
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
    const chips = buildContextBindings(main("queue"), "wide").chips;
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
    // R27: no chip may advertise `chat` where `t` opens the transcript.
    expect(ids).not.toContain("chat");
  });

  it("chips: the repoDetail body advertises its one verb", () => {
    const b = buildContextBindings(main("repoDetail", 2), "wide");
    const ids = b.chips.flatMap((ch) => (ch.kind === "mnemonic" ? [ch.id] : []));
    expect(ids).toEqual(["chat"]);
  });

  it("structuralOnly contexts derive nothing", () => {
    const b = buildContextBindings({ kind: "structuralOnly", view: "palette" }, "wide");
    expect(b.all).toEqual([]);
    expect(b.chips.every((c) => c.kind === "structural")).toBe(true);
  });
});
