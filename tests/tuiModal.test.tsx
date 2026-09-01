import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { Modal, Center } from "../src/tui/components/Modal.js";
import { HelpModal } from "../src/tui/components/HelpModal.js";
import { buildContextBindings } from "../src/tui/viewActions.js";

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
        bindings={buildContextBindings({ kind: "main", body: "issues" }, 2, "wide")}
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

  it("renders ONE unified reference: system-row verbs present, no mode toggle", () => {
    const f = render(
      <HelpModal
        pane={2}
        mode="wide"
        trigger="junco"
        bindings={buildContextBindings({ kind: "main", body: "issues" }, 2, "wide")}
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
});

describe("HelpModal — derived mnemonics (#shortcut overhaul)", () => {
  it("lists the ACTIVE context's derived keys, hidden shift variants included", () => {
    const f = render(
      <HelpModal
        pane={2}
        mode="wide"
        trigger="junco"
        bindings={buildContextBindings({ kind: "main", body: "issues" }, 2, "wide")}
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
        bindings={buildContextBindings({ kind: "main", body: "queue" }, 2, "wide")}
      />,
    ).lastFrame()!;
    const rows = f.split("\n").map((l) => l.replace(/║/g, "").trim());
    expect(rows.some((l) => l.startsWith("t") && l.includes("retry"))).toBe(true);
    expect(rows.some((l) => l.startsWith("D") && l.includes("delete"))).toBe(true);
  });
});
