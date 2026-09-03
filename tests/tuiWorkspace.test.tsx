import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { Text } from "ink";
import { Workspace } from "../src/tui/components/Workspace.js";
import { computeLayout } from "../src/tui/layout.js";
import type { FooterRows } from "../src/tui/footerModel.js";
import { MouseProvider } from "../src/tui/MouseProvider.js";
import { until } from "./helpers/until.js";

afterEach(cleanup);

const FOOTER: FooterRows = {
  actions: {
    label: "acme/api",
    chips: [
      { kind: "mnemonic", id: "quit", key: "q", label: "quit", charIndex: 0, guarded: false },
    ],
    pinned: [],
  },
  navigate: {
    label: "navigate",
    chips: [
      { kind: "structural", id: "↑/↓", key: "↑/↓", label: "move", charIndex: null, guarded: false },
    ],
    pinned: [],
  },
};
const EMPTY_FOOTER: FooterRows = {
  actions: { label: "", chips: [], pinned: [] },
  navigate: { label: "", chips: [], pinned: [] },
};

const size = { columns: 100, rows: 20 };

describe("Workspace", () => {
  it("stacks header / body / the two footer rows and never exceeds rows", () => {
    const r = render(
      <Workspace
        size={size}
        layout={computeLayout(size.columns, size.rows)}
        header={<Text>HEADER</Text>}
        toast={{ kind: "info", text: "hello toast" }}
        footer={FOOTER}
        modal={null}
      >
        <Text>BODY</Text>
      </Workspace>,
    );
    const f = r.lastFrame()!;
    expect(f).toContain("HEADER");
    expect(f).toContain("BODY");
    expect(f).toContain("hello toast"); // the toast paints over the ACTIONS row
    expect(f).not.toContain("quit"); // …so the actions row's own chips are hidden
    expect(f).toContain("move"); // the navigate row is never hidden

    expect(f.split("\n").length).toBeLessThanOrEqual(size.rows);
  });
  it("tooSmall mode renders guidance instead of the body", () => {
    const f = render(
      <Workspace
        size={{ columns: 40, rows: 10 }}
        layout={computeLayout(40, 10)}
        header={<Text>H</Text>}
        toast={null}
        footer={EMPTY_FOOTER}
        modal={null}
      >
        <Text>NEVER</Text>
      </Workspace>,
    ).lastFrame()!;
    expect(f).toContain("terminal too small");
    expect(f).toContain("60×14");
    expect(f).not.toContain("NEVER");
  });
  it("a modal replaces the body, centered", () => {
    const f = render(
      <Workspace
        size={size}
        layout={computeLayout(size.columns, size.rows)}
        header={<Text>H</Text>}
        toast={null}
        footer={EMPTY_FOOTER}
        modal={<Text>MODAL CONTENT</Text>}
      >
        <Text>HIDDEN BODY</Text>
      </Workspace>,
    ).lastFrame()!;
    expect(f).toContain("MODAL CONTENT");
    expect(f).not.toContain("HIDDEN BODY");
  });
});

// The footer's chips are wired straight through to `chipActions` — the modal
// case is NOT handled here (Ruling R6', fix round 3): under the help modal the
// footer renders help's OWN context, which has no dispatchable chip, so the
// derivation in hooks/useFooterBindings.ts is what keeps a pointer from
// reaching the surface underneath. Disarming every chip at this level instead
// would also disarm the palette's own `⏎ run`, which is a real verb.
describe("Workspace footer chip clicks", () => {
  // SGR press at 0-based cell (x, y) — the suite's wire format.
  const press = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;
  const size = { columns: 100, rows: 20 };

  const mount = (onQuit: () => void) =>
    render(
      <MouseProvider>
        <Workspace
          size={size}
          layout={computeLayout(size.columns, size.rows)}
          header={<Text>H</Text>}
          toast={null}
          footer={FOOTER}
          chipActions={{ quit: onQuit }}
          modal={null}
        >
          <Text>BODY</Text>
        </Workspace>
      </MouseProvider>,
    );

  /** The `quit` chip's cell on the actions row (second-to-last frame line). */
  const quitCell = (frame: string): [number, number] => {
    const lines = frame.split("\n");
    const y = lines.length - 2;
    return [(lines[y] ?? "").indexOf("quit"), y];
  };

  it("dispatches a footer chip through chipActions", async () => {
    let hits = 0;
    const r = mount(() => hits++);
    await until(() => (r.lastFrame() ?? "").includes("quit"));
    const [x, y] = quitCell(r.lastFrame() ?? "");
    expect(x).toBeGreaterThan(0);
    r.stdin.write(press(x, y));
    await until(() => hits === 1);
  });
});
