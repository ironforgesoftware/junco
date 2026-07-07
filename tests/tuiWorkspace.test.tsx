import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { Workspace } from "../src/tui/components/Workspace.js";
import { computeLayout } from "../src/tui/layout.js";

const size = { columns: 100, rows: 20 };

describe("Workspace", () => {
  it("stacks header / body / toast / footer and never exceeds rows", () => {
    const r = render(
      <Workspace
        size={size}
        layout={computeLayout(size.columns, size.rows)}
        header={<Text>HEADER</Text>}
        toast={{ kind: "info", text: "hello toast" }}
        hints={[["q", "quit"]]}
        modal={null}
      >
        <Text>BODY</Text>
      </Workspace>,
    );
    const f = r.lastFrame()!;
    expect(f).toContain("HEADER");
    expect(f).toContain("BODY");
    expect(f).toContain("hello toast");
    expect(f).toContain("quit");
    expect(f.split("\n").length).toBeLessThanOrEqual(size.rows);
  });
  it("tooSmall mode renders guidance instead of the body", () => {
    const f = render(
      <Workspace
        size={{ columns: 40, rows: 10 }}
        layout={computeLayout(40, 10)}
        header={<Text>H</Text>}
        toast={null}
        hints={[]}
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
        hints={[]}
        modal={<Text>MODAL CONTENT</Text>}
      >
        <Text>HIDDEN BODY</Text>
      </Workspace>,
    ).lastFrame()!;
    expect(f).toContain("MODAL CONTENT");
    expect(f).not.toContain("HIDDEN BODY");
  });
});
