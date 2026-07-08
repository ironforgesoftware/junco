import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Header, Toast, Footer, hintsFor } from "../src/tui/components/Chrome.js";

const NOW = new Date("2026-07-07T14:05:00");

describe("Header", () => {
  it("brand chip, repo, daemon up, queue chip, clock", () => {
    const f = render(
      <Header
        repoNwo="acme/api"
        daemonUp={true}
        uptimeSeconds={11040}
        queueRunning={1}
        queueWaiting={2}
        watchlistError={null}
        outboxDepth={0}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("junco");
    expect(f).toContain("acme/api");
    expect(f).toContain("daemon ●");
    expect(f).toContain("3h4m");
    expect(f).toContain("◐1 ⏳2");
    expect(f).toMatch(/\d{2}:\d{2}/);
  });
  it("daemon down and watchlist warn chip", () => {
    const f = render(
      <Header
        repoNwo={null}
        daemonUp={false}
        uptimeSeconds={null}
        queueRunning={0}
        queueWaiting={0}
        watchlistError="corrupt json"
        outboxDepth={0}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("daemon ○");
    expect(f).toContain("watchlist!");
    expect(f).not.toContain("◐0"); // queue chip hidden when empty
  });
  it("shows the unpushed outbox chip when depth > 0, hidden at 0", () => {
    const withDepth = render(
      <Header
        repoNwo="acme/api"
        daemonUp={true}
        uptimeSeconds={60}
        queueRunning={0}
        queueWaiting={0}
        watchlistError={null}
        outboxDepth={3}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(withDepth).toContain("⇡3 unpushed");

    const noDepth = render(
      <Header
        repoNwo="acme/api"
        daemonUp={true}
        uptimeSeconds={60}
        queueRunning={0}
        queueWaiting={0}
        watchlistError={null}
        outboxDepth={0}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(noDepth).not.toContain("unpushed");
  });
});

describe("Toast", () => {
  it("renders the text when live and a blank row when not", () => {
    expect(render(<Toast toast={{ kind: "error", text: "gh boom" }} />).lastFrame()).toContain(
      "gh boom",
    );
    expect(render(<Toast toast={null} />).lastFrame()).not.toContain("gh boom");
  });
});

describe("Footer / hintsFor", () => {
  it("renders key·label pairs", () => {
    const f = render(
      <Footer
        hints={[
          ["↑/↓", "move"],
          ["q", "quit"],
        ]}
      />,
    ).lastFrame()!;
    expect(f).toContain("↑/↓");
    expect(f).toContain("move");
    expect(f).toContain("q");
  });
  it("main pane 2 wide advertises preview enter, filter, panes", () => {
    const keys = hintsFor("main", 2, "wide", false).map(([k]) => k);
    expect(keys).toContain("enter");
    expect(keys).toContain("/");
    expect(keys).toContain("←/→");
    expect(keys).toContain("q");
  });
  it("medium mode enter says detail and the pane hint drops to ←/repos", () => {
    const pairs = hintsFor("main", 2, "medium", false);
    expect(pairs.find(([k]) => k === "enter")?.[1]).toBe("detail");
    expect(pairs.find(([k]) => k === "←")?.[1]).toBe("repos");
  });
  it("filtering mode replaces everything with the filter contract", () => {
    expect(hintsFor("main", 2, "wide", true)).toEqual([
      ["type", "filter"],
      ["enter", "apply"],
      ["esc", "clear"],
    ]);
  });
  it("queue view keeps ↑/↓ scroll and esc/t back", () => {
    const keys = hintsFor("queue", 2, "wide", false).map(([k]) => k);
    expect(keys).toContain("↑/↓");
    expect(keys).toContain("esc/t");
  });
});
