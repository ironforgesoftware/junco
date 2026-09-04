import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { Modal, Center } from "../src/tui/components/Modal.js";
import { HelpModal } from "../src/tui/components/HelpModal.js";
import { buildContextBindings } from "../src/tui/viewActions.js";
import { NAV_HELP_ROWS } from "../src/tui/footerModel.js";

describe("Modal / Center", () => {
  it("frames children with an accent double border and title", () => {
    const f = render(
      <Center>
        <Modal title="hello there">
          <Text>content line</Text>
        </Modal>
      </Center>,
    ).lastFrame()!;
    expect(f).toContain("hello there");
    expect(f).toContain("content line");
    expect(f).toContain("═"); // double border
  });
});

describe("HelpModal", () => {
  it("current context first, then categories, action keys present", () => {
    const f = render(
      <HelpModal
        pane={2}
        mode="wide"
        trigger="junco"
        bindings={buildContextBindings({ kind: "main", body: "issues", pane: 2 }, "wide")}
      />,
    ).lastFrame()!;
    const ctx = f.indexOf("this view");
    const nav = f.indexOf("navigate");
    expect(ctx).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(ctx); // context section renders first
    expect(f).toContain("mnemonics"); // the shortcut-system explainer line
    expect(f).toContain("`junco`"); // trigger label named in the flow line
    expect(f).toContain("mouse"); // mouse section
    expect(f).toContain("↗ line"); // link-line row documented
    expect(f).toContain("press any key to close");
    expect(f).toContain("unpushed"); // outbox chip documented in the system section
  });

  it("the system section's q says what q does in THIS context (#468)", () => {
    const help = (bindings: Parameters<typeof HelpModal>[0]["bindings"]) =>
      render(<HelpModal pane={2} mode="wide" trigger="junco" bindings={bindings} />).lastFrame()!;
    // Opened over the main view, `q` quits the dashboard…
    expect(help(buildContextBindings({ kind: "main", body: "issues", pane: 2 }, "wide"))).toContain(
      "quit (terminal restored)",
    );
    // …but `?` opens help from every overlay too (Ruling R5), and there the
    // same key closes the surface underneath instead.
    const overlay = help(buildContextBindings({ kind: "view", view: "detail" }, "wide"));
    expect(overlay).toContain("leave this view");
    expect(overlay).not.toContain("quit (terminal restored)");
  });

  it("renders ONE unified reference: system-row verbs present, no mode toggle", () => {
    const f = render(
      <HelpModal
        pane={2}
        mode="wide"
        trigger="junco"
        bindings={buildContextBindings({ kind: "main", body: "issues", pane: 2 }, "wide")}
      />,
    ).lastFrame()!;
    expect(f).toContain("system rows"); // the section-verbs block
    expect(f).toContain("requeue"); // queue retry row
    expect(f).toContain("Prune"); // worktrees (shift-guarded)
    expect(f).toContain("Restart"); // daemon (shift-guarded)
    expect(f).toContain("full-screen live log"); // logs enter
    expect(f).not.toContain("Shift+Tab"); // the mode toggle stays gone
    expect(f).not.toContain("local mode");
  });

  it("documents c chat once as a verb, the palette on :, and t as the transcript (spec 2026-09-02 D5)", () => {
    const f = render(
      <HelpModal
        pane={2}
        mode="wide"
        trigger="junco"
        bindings={buildContextBindings({ kind: "main", body: "issues", pane: 2 }, "wide")}
      />,
    ).lastFrame()!;
    // Anchored on the modal's ║ border rather than line-start (`^`): the
    // Section rows sit inside the border padding, not at column 0.
    expect(f).toMatch(/║\s*c\s+chat/); // the derived verb row
    expect(f).toMatch(/║\s*:\s+command palette/); // structural, in navigate
    expect(f).not.toContain("commands chip"); // the alias wording is gone
    expect(f).not.toContain("c             commands");
    expect(f).toMatch(/t on an issue\s+transcript/);
    expect(f).not.toContain("t on a repo row"); // the withdrawn reading
    expect(f).toContain("chat with the agent about the repo under the cursor");
  });
  it("an OVERLAY context lists its own keys, with no hidden-variant rows for ? help / q close", () => {
    // Ruling R5 gave every overlay a hidden reserved `?` → help beside the
    // hidden `q` → close, so the footer's pinned "? help" chip is real. The
    // hidden filter excluded only `close`, so `help` fell through the
    // shift-variant arm and every overlay's help listed a bogus
    // `? help (shift variant)` — `?` is neither shifted nor a variant.
    const f = render(
      <HelpModal
        pane={2}
        mode="wide"
        trigger="junco"
        bindings={buildContextBindings({ kind: "view", view: "detail" }, "wide")}
      />,
    ).lastFrame()!;
    const rows = f.split("\n").map((l) => l.replace(/║/g, "").trim());
    expect(rows.filter((l) => /^c\s/.test(l) && l.includes("chat"))).toHaveLength(1);
    expect(f).not.toContain("(shift variant)");
    expect(f).not.toMatch(/║\s*q\s+close/); // hidden: `esc back` is the listed one
    expect(f).toMatch(/║\s*esc\s+back/);
    expect(f).toContain("navigate"); // the shared structural reference still renders
  });

  it("the navigate section is generated from the footer vocabulary, not a second hand-written list", () => {
    const f = render(
      <HelpModal
        pane={1}
        mode="wide"
        trigger="junco"
        bindings={buildContextBindings({ kind: "main", body: "issues", pane: 1 }, "wide")}
      />,
    ).lastFrame()!;
    for (const [key] of NAV_HELP_ROWS) expect(f).toContain(key);
  });
});

describe("HelpModal — derived mnemonics (#shortcut overhaul)", () => {
  it("lists the ACTIVE context's derived keys, hidden shift variants included", () => {
    const f = render(
      <HelpModal
        pane={2}
        mode="wide"
        trigger="junco"
        bindings={buildContextBindings({ kind: "main", body: "issues", pane: 2 }, "wide")}
      />,
    ).lastFrame()!;
    // Derived keys render as key → label rows: investigate (was analyze) is
    // n, approve is o.
    // (Rows sit inside the modal's ║ border — strip it before matching.)
    const rows = f.split("\n").map((l) => l.replace(/║/g, "").trim());
    expect(rows.some((l) => l.startsWith("n") && l.includes("investigate"))).toBe(true);
    expect(rows.some((l) => l.startsWith("o") && l.includes("approve"))).toBe(true);
    // Hidden shift variants surface in help (never in the footer).
    expect(f).toContain("import as ask");
    expect(rows.some((l) => l.startsWith("I") && l.includes("import as ask"))).toBe(true);
    expect(rows.some((l) => l.startsWith("A") && l.includes("audit auto-plan"))).toBe(true);
    // No stale hand-assigned letters.
    expect(f).not.toContain("c analyze");
    expect(f).not.toContain("o browser");
  });

  it("a section context lists its guarded verbs uppercase", () => {
    const f = render(
      <HelpModal
        pane={2}
        mode="wide"
        trigger="junco"
        bindings={buildContextBindings({ kind: "main", body: "queue", pane: 2 }, "wide")}
      />,
    ).lastFrame()!;
    const rows = f.split("\n").map((l) => l.replace(/║/g, "").trim());
    expect(rows.some((l) => l.startsWith("t") && l.includes("retry"))).toBe(true);
    expect(rows.some((l) => l.startsWith("D") && l.includes("delete"))).toBe(true);
  });
});
