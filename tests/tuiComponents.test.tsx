import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { RepoList } from "../src/tui/components/RepoList.js";
import { IssueTable } from "../src/tui/components/IssueTable.js";
import { StatusBar } from "../src/tui/components/StatusBar.js";
import { HelpOverlay } from "../src/tui/components/HelpOverlay.js";

describe("RepoList", () => {
  it("marks the selected repo, config entries, and per-state counts", () => {
    const { lastFrame } = render(
      <RepoList
        repos={[
          { nwo: "acme/api", fromConfig: true, counts: { "plan-ready": 2, working: 1 } },
          { nwo: "alx/coral", fromConfig: false, counts: {} },
        ]}
        selected={1}
        focused={true}
      />,
    );
    const f = lastFrame()!;
    expect(f).toContain("acme/api");
    expect(f).toContain("(cfg)"); // config entries are read-only
    expect(f).toContain("2●"); // plan-ready count
    expect(f).toContain("▸ alx/coral"); // selection cursor
  });
});

describe("IssueTable", () => {
  const issues = [
    {
      number: 42,
      title: "Add rate limiting",
      labels: ["junco", "junco:plan-ready"],
      updatedAt: "2026-07-06T10:00:00Z",
      url: "https://github.com/acme/api/issues/42",
    },
  ];

  it("renders number, title, badge, and glyph", () => {
    const { lastFrame } = render(
      <IssueTable issues={issues} trigger="junco" selected={0} focused={true} />,
    );
    const f = lastFrame()!;
    expect(f).toContain("#42");
    expect(f).toContain("Add rate limiting");
    expect(f).toContain("plan-ready");
    expect(f).toContain("●");
  });

  it("empty repo shows an empty-state hint", () => {
    const { lastFrame } = render(
      <IssueTable issues={[]} trigger="junco" selected={0} focused={true} />,
    );
    expect(lastFrame()).toContain("no open issues");
  });
});

describe("StatusBar", () => {
  it("renders daemon-up state and toast", () => {
    const { lastFrame } = render(
      <StatusBar
        health={{ up: true, uptimeSeconds: 7200, lastBridgeSweepAt: null, ticketsBridged: 2 }}
        toast="dispatched #42"
        hints="d dispatch · ? help"
      />,
    );
    const f = lastFrame()!;
    expect(f).toContain("daemon ●");
    expect(f).toContain("dispatched #42");
    expect(f).toContain("? help");
  });

  it("renders daemon-down state", () => {
    const { lastFrame } = render(
      <StatusBar
        health={{ up: false, uptimeSeconds: null, lastBridgeSweepAt: null, ticketsBridged: null }}
        toast={null}
        hints=""
      />,
    );
    expect(lastFrame()).toContain("daemon ○ not running");
  });
});

describe("HelpOverlay", () => {
  it("documents every key with the configured trigger", () => {
    const { lastFrame } = render(<HelpOverlay trigger="junco" />);
    const f = lastFrame()!;
    for (const k of [
      "dispatch",
      "approve",
      "re-plan",
      "re-cycle",
      "add repo",
      "browser",
      "refresh",
      "quit",
    ]) {
      expect(f.toLowerCase()).toContain(k);
    }
  });
});
