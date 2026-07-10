import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { Modal, Center } from "../src/tui/components/Modal.js";
import { HelpModal } from "../src/tui/components/HelpModal.js";

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
    const f = render(<HelpModal view="main" pane={2} mode="wide" trigger="junco" />).lastFrame()!;
    const ctx = f.indexOf("this view");
    const nav = f.indexOf("navigate");
    expect(ctx).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(ctx); // context section renders first
    expect(f).toContain("act on issue");
    expect(f).toContain("dispatch (adds `junco`)");
    expect(f).toContain("mouse"); // new mouse section
    expect(f).toContain("↗ line"); // link-line row documented
    expect(f).toContain("1/2/3");
    expect(f).toContain("/"); // filter key documented
    expect(f).toContain("press any key to close");
    expect(f).toContain("unpushed"); // outbox chip documented in the system section
    expect(f).toContain("PR tracking"); // p key documented in panes & views
  });

  it("local-mode help lists the mode swap, section keys, and the action/safety table", () => {
    const f = render(
      <HelpModal
        view="main"
        pane={2}
        mode="wide"
        trigger="junco"
        uiMode="local"
        localSection="worktrees"
      />,
    ).lastFrame()!;
    expect(f).toContain("local mode");
    expect(f).toContain("m"); // mode swap
    expect(f).toContain("Shift+Tab");
    expect(f).toContain("prune"); // worktrees action
    expect(f).toContain("restart"); // daemon action
    expect(f).toContain("[ / ]"); // daemon panel scroll
  });

  it("github help is unchanged when uiMode is absent", () => {
    const f = render(<HelpModal view="main" pane={2} mode="wide" trigger="junco" />).lastFrame()!;
    expect(f).toContain("act on issue");
    expect(f).not.toContain("local mode");
  });
});
