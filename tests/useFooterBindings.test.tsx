// tests/useFooterBindings.test.tsx — the footer/binding derivation that used
// to live inline in App (spec 2026-09-02 footer redesign §6, Task 4).
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { Text } from "ink";
import { useFooterBindings, type FooterBindingsInput } from "../src/tui/hooks/useFooterBindings.js";

afterEach(cleanup);

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
  helpContext: null,
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
    // The navigate row is the main body's structural vocabulary, ? help and
    // q quit pinned right (footerModel's PINNED_IDS off `bindings.all`).
    expect(r.footer.navigate.pinned.map((c) => c.id)).toEqual(["help", "quit"]);
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
  it("every overlay view maps to its own binding context", () => {
    for (const view of [
      "detail",
      "repoDetail",
      "prs",
      "prDetail",
      "review",
      "cmdOutput",
      "transcript",
    ] as const) {
      expect(run({ ...base, view }).bindingContext).toEqual({ kind: "view", view });
    }
    for (const view of ["help", "palette", "addRepo", "config"] as const) {
      expect(run({ ...base, view }).bindingContext).toEqual({ kind: "structuralOnly", view });
    }
  });
  it("the main body kind picks the mnemonic table (section / repoDetail / issues)", () => {
    expect(run({ ...base, body: { kind: "section", section: "queue" } }).bindingContext).toEqual({
      kind: "main",
      body: "queue",
      pane: 1,
    });
    expect(run({ ...base, body: null }).bindingContext).toEqual({
      kind: "main",
      body: "repoDetail",
      pane: 1,
    });
  });
  it("helpBindings defaults to the main-body context under the modal", () => {
    const r = run({ ...base, view: "help" });
    expect(r.bindingContext).toEqual({ kind: "structuralOnly", view: "help" });
    expect(r.helpBindings.keymap.get("c")).toBe("chat");
  });
  it("helpContext (the surface help was opened FROM) wins over the main body — spec §3.2/R5", () => {
    const r = run({ ...base, view: "help", helpContext: { kind: "view", view: "detail" } });
    // The issue-detail overlay's OWN keys, not the main view's.
    expect(r.helpBindings.keymap.get("b")).toBe("browser");
    expect(r.helpBindings.keymap.get("t")).toBe("transcript");
    expect(r.helpBindings.keymap.get("m")).toBeUndefined(); // main's `import`
    const log = run({ ...base, view: "help", helpContext: { kind: "logOverlay" } });
    expect(log.helpBindings.keymap.get("l")).toBe("level");
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
