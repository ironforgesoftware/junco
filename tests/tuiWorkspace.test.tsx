import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { Text } from "ink";
import { Workspace } from "../src/tui/components/Workspace.js";
import { computeLayout } from "../src/tui/layout.js";
import type { FooterRows } from "../src/tui/footerModel.js";
import { MouseProvider } from "../src/tui/MouseProvider.js";
import { until, tick } from "./helpers/until.js";

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

// Ruling R6 (fix round 2): a modal owns the pointer. Workspace renders the
// footer OUTSIDE the modal — deliberately, so navigation stays readable — but
// a chip that still dispatched under an open modal is a surprise at best and,
// for `? help` over the log overlay, was a trap (fix round 1). Passing
// `chipActions` through only when `modal === null` is the whole mechanism, so
// it is pinned here, at the component that owns the decision.
describe("Workspace footer chips under a modal (R6)", () => {
  // SGR press at 0-based cell (x, y) — the suite's wire format.
  const press = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;
  const size = { columns: 100, rows: 20 };

  const mount = (modal: React.ReactNode | null, onQuit: () => void) =>
    render(
      <MouseProvider>
        <Workspace
          size={size}
          layout={computeLayout(size.columns, size.rows)}
          header={<Text>H</Text>}
          toast={null}
          footer={FOOTER}
          chipActions={{ quit: onQuit }}
          modal={modal}
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

  it("dispatches a footer chip when no modal is open", async () => {
    let hits = 0;
    const r = mount(null, () => hits++);
    await until(() => (r.lastFrame() ?? "").includes("quit"));
    const [x, y] = quitCell(r.lastFrame() ?? "");
    expect(x).toBeGreaterThan(0);
    r.stdin.write(press(x, y));
    await until(() => hits === 1);
  });

  it("makes every footer chip inert while a modal is open", async () => {
    let hits = 0;
    const r = mount(<Text>MODAL CONTENT</Text>, () => hits++);
    await until(() => (r.lastFrame() ?? "").includes("MODAL CONTENT"));
    // The chip still RENDERS (navigation stays readable under the modal) …
    const [x, y] = quitCell(r.lastFrame() ?? "");
    expect(x).toBeGreaterThan(0);
    // … it just no longer resolves to a handler: the press hits no region.
    r.stdin.write(press(x, y));
    await tick();
    await tick();
    expect(hits).toBe(0);
  });
});
