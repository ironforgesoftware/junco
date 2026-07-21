import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Header, Toast, Footer, chipSegments } from "../src/tui/components/Chrome.js";
import type { HealthInfo } from "../src/tui/ghClient.js";

const NOW = new Date("2026-07-07T10:00:00Z");

const UP_BARE: HealthInfo = {
  up: true,
  uptimeSeconds: 11040,
  lastBridgeSweepAt: null,
  ticketsBridged: null,
  tasksProcessed: null,
  tasksSucceeded: null,
  tasksFailed: null,
  lastTaskStatus: null,
  lastTaskAt: null,
  totalTokensOut: null,
  bridgeErrors: null,
};

const DOWN: HealthInfo = {
  up: false,
  uptimeSeconds: null,
  lastBridgeSweepAt: null,
  ticketsBridged: null,
  tasksProcessed: null,
  tasksSucceeded: null,
  tasksFailed: null,
  lastTaskStatus: null,
  lastTaskAt: null,
  totalTokensOut: null,
  bridgeErrors: null,
};

const HEALTHY: HealthInfo = {
  up: true,
  uptimeSeconds: 11040,
  lastBridgeSweepAt: null,
  ticketsBridged: 0,
  tasksProcessed: 10,
  tasksSucceeded: 8,
  tasksFailed: 2,
  lastTaskStatus: "completed",
  lastTaskAt: "2026-07-07T09:58:00Z", // 2m before NOW
  totalTokensOut: 45_000,
  bridgeErrors: 1,
};

describe("Header", () => {
  it("emoji brand mark, wordmark, repo, daemon up, queue chip", () => {
    const f = render(
      <Header
        crumbs={["acme/api"]}
        health={UP_BARE}
        reviewCount={0}
        now={NOW}
        mode="wide"
        queueRunning={1}
        queueWaiting={2}
        watchlistError={null}
        outboxDepth={0}
        prAttention={0}
        prFailing={false}
      />,
    ).lastFrame()!;
    expect(f).toContain("🐦");
    expect(f).toContain("junco");
    expect(f).toContain("acme/api");
    expect(f).toContain("daemon up");
    expect(f).toContain("3h4m");
    expect(f).toContain("◐1 ⏳2");
    expect(f).not.toMatch(/\d{2}:\d{2}/);
  });
  it("daemon down and watchlist warn chip", () => {
    const f = render(
      <Header
        crumbs={["no repo"]}
        health={DOWN}
        reviewCount={0}
        now={NOW}
        mode="medium"
        queueRunning={0}
        queueWaiting={0}
        watchlistError="corrupt json"
        outboxDepth={0}
        prAttention={0}
        prFailing={false}
      />,
    ).lastFrame()!;
    expect(f).toContain("daemon down");
    expect(f).toContain("watchlist!");
    expect(f).not.toContain("◐0"); // queue chip hidden when empty
  });
  it("shows the unpushed outbox chip when depth > 0, hidden at 0", () => {
    const withDepth = render(
      <Header
        crumbs={["acme/api"]}
        health={{ ...UP_BARE, uptimeSeconds: 60 }}
        reviewCount={0}
        now={NOW}
        mode="wide"
        queueRunning={0}
        queueWaiting={0}
        watchlistError={null}
        outboxDepth={3}
        prAttention={0}
        prFailing={false}
      />,
    ).lastFrame()!;
    expect(withDepth).toContain("⇡3 unpushed");

    const noDepth = render(
      <Header
        crumbs={["acme/api"]}
        health={{ ...UP_BARE, uptimeSeconds: 60 }}
        reviewCount={0}
        now={NOW}
        mode="wide"
        queueRunning={0}
        queueWaiting={0}
        watchlistError={null}
        outboxDepth={0}
        prAttention={0}
        prFailing={false}
      />,
    ).lastFrame()!;
    expect(noDepth).not.toContain("unpushed");
  });
});

describe("Header pulse", () => {
  const base = {
    crumbs: ["acme/api"],
    now: NOW,
    mode: "wide" as const,
    queueRunning: 0,
    queueWaiting: 0,
    watchlistError: null,
    outboxDepth: 0,
    prAttention: 0,
    prFailing: false,
  };

  it("renders the full pulse row when healthy: review, task counts, last-task, tokens, bridge", () => {
    const f = render(<Header {...base} health={HEALTHY} reviewCount={3} />).lastFrame()!;
    expect(f).toContain("●3 review");
    expect(f).toContain("✓8");
    expect(f).toContain("✗2");
    expect(f).toContain("last ✓ 2m");
    expect(f).toContain("tok 45k");
    expect(f).toContain("bridge ✗1");
  });

  it("review chip hidden at 0, shown at 3", () => {
    const hidden = render(<Header {...base} health={HEALTHY} reviewCount={0} />).lastFrame()!;
    expect(hidden).not.toContain("review");

    const shown = render(<Header {...base} health={HEALTHY} reviewCount={3} />).lastFrame()!;
    expect(shown).toContain("●3 review");
  });

  it("hides the ✗ failure segment when tasksFailed is 0", () => {
    const f = render(
      <Header {...base} health={{ ...HEALTHY, tasksFailed: 0, bridgeErrors: 0 }} reviewCount={0} />,
    ).lastFrame()!;
    expect(f).toContain("✓8");
    expect(f).not.toContain("✗");
  });

  it("last-task glyph is ✓ for a terminal-done status, ✗ for anything else", () => {
    const good = render(
      <Header
        {...base}
        health={{ ...HEALTHY, lastTaskStatus: "aborted_partial" }}
        reviewCount={0}
      />,
    ).lastFrame()!;
    expect(good).toContain("last ✓");

    const bad = render(
      <Header {...base} health={{ ...HEALTHY, lastTaskStatus: "failed" }} reviewCount={0} />,
    ).lastFrame()!;
    expect(bad).toContain("last ✗");
  });

  it("tok chip hidden when totalTokensOut is 0 or null", () => {
    const zero = render(
      <Header {...base} health={{ ...HEALTHY, totalTokensOut: 0 }} reviewCount={0} />,
    ).lastFrame()!;
    expect(zero).not.toContain("tok ");

    const nullTok = render(
      <Header {...base} health={{ ...HEALTHY, totalTokensOut: null }} reviewCount={0} />,
    ).lastFrame()!;
    expect(nullTok).not.toContain("tok ");
  });

  it("bridge chip only shown when bridgeErrors > 0", () => {
    const f = render(
      <Header {...base} health={{ ...HEALTHY, bridgeErrors: 0 }} reviewCount={0} />,
    ).lastFrame()!;
    expect(f).not.toContain("bridge");
  });

  it("daemon-down hides every health-dependent chip", () => {
    const f = render(<Header {...base} health={DOWN} reviewCount={0} />).lastFrame()!;
    expect(f).toContain("daemon down");
    expect(f).not.toContain("✓");
    expect(f).not.toContain("✗");
    expect(f).not.toContain("last");
    expect(f).not.toContain("tok ");
    expect(f).not.toContain("bridge");
  });

  it("medium mode keeps only the essential chips (record/last/tok/bridge drop by design)", () => {
    const f = render(
      <Header
        {...base}
        mode="medium"
        health={HEALTHY}
        reviewCount={2}
        queueRunning={1}
        queueWaiting={1}
        outboxDepth={4}
      />,
    ).lastFrame()!;
    expect(f).toContain("●2 review");
    expect(f).toContain("daemon up");
    expect(f).toContain("◐1 ⏳1");
    expect(f).toContain("⇡4 unpushed");
    expect(f).not.toContain("✓8");
    expect(f).not.toContain("last");
    expect(f).not.toContain("tok ");
    expect(f).not.toContain("bridge");
  });
});

describe("Header PR attention chip", () => {
  const base = {
    crumbs: ["acme/api"],
    health: UP_BARE,
    reviewCount: 0,
    now: NOW,
    queueRunning: 0,
    queueWaiting: 0,
    watchlistError: null,
    outboxDepth: 0,
  };

  it("hidden at 0, shown as ⚑N PR at 3", () => {
    const hidden = render(
      <Header {...base} mode="wide" prAttention={0} prFailing={false} />,
    ).lastFrame()!;
    expect(hidden).not.toContain("PR");

    const shown = render(
      <Header {...base} mode="wide" prAttention={3} prFailing={false} />,
    ).lastFrame()!;
    expect(shown).toContain("⚑3 PR");
  });

  it("renders after the ●N review chip", () => {
    const f = render(
      <Header {...base} mode="wide" reviewCount={2} prAttention={3} prFailing={false} />,
    ).lastFrame()!;
    expect(f.indexOf("review")).toBeLessThan(f.indexOf("⚑3 PR"));
  });

  // The actual ANSI color (theme.error vs theme.warn) isn't observable in a
  // captured frame — non-TTY output strips it, same as every other colored
  // chip in this file — so this only proves both prFailing branches render.
  it("renders the chip in both the warn (prFailing=false) and error (prFailing=true) paths", () => {
    const warnPath = render(
      <Header {...base} mode="wide" prAttention={3} prFailing={false} />,
    ).lastFrame()!;
    expect(warnPath).toContain("⚑3 PR");

    const errorPath = render(
      <Header {...base} mode="wide" prAttention={3} prFailing={true} />,
    ).lastFrame()!;
    expect(errorPath).toContain("⚑3 PR");
  });

  it("is essentials tier — present in both wide and medium (non-wide) mode", () => {
    const wide = render(
      <Header {...base} mode="wide" prAttention={5} prFailing={false} />,
    ).lastFrame()!;
    expect(wide).toContain("⚑5 PR");

    const medium = render(
      <Header {...base} mode="medium" prAttention={5} prFailing={false} />,
    ).lastFrame()!;
    expect(medium).toContain("⚑5 PR");
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

describe("Header (no mode tabs)", () => {
  const base = {
    crumbs: ["acme/api"],
    health: UP_BARE,
    reviewCount: 0,
    now: NOW,
    queueRunning: 0,
    queueWaiting: 0,
    watchlistError: null,
    outboxDepth: 0,
    prAttention: 0,
    prFailing: false,
  };

  it("renders no tab segment (the mode toggle is gone)", () => {
    const f = render(<Header {...base} mode="wide" />).lastFrame()!;
    expect(f).not.toContain("[GITHUB]");
    expect(f).not.toContain("[LOCAL]");
    expect(f).toContain("junco");
    expect(f).toContain("acme/api");
  });

  it("columns=60 (medium, narrowest) with a full chip set stays one row (no wrap)", () => {
    const f = render(
      <Header
        {...base}
        mode="medium"
        reviewCount={2}
        queueRunning={1}
        queueWaiting={1}
        outboxDepth={4}
        prAttention={3}
      />,
    ).lastFrame()!;
    const lines = f.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });
});

describe("chipSegments (mnemonic rendering)", () => {
  it("splits a mnemonic label around the winning char", () => {
    expect(
      chipSegments({
        kind: "mnemonic",
        id: "analyze",
        key: "n",
        label: "analyze",
        charIndex: 1,
        guarded: false,
      }),
    ).toEqual([
      { text: "a", accent: false },
      { text: "n", accent: true },
      { text: "alyze", accent: false },
    ]);
  });

  it("uppercases the winning char in place for guarded keys", () => {
    expect(
      chipSegments({
        kind: "mnemonic",
        id: "delete",
        key: "D",
        label: "delete",
        charIndex: 0,
        guarded: true,
      })[0],
    ).toEqual({ text: "D", accent: true });
  });

  it("null charIndex and structural chips render key-first", () => {
    expect(chipSegments({ kind: "structural", key: "esc", label: "back" })).toEqual([
      { text: "esc", accent: true },
      { text: " back", accent: false },
    ]);
    expect(
      chipSegments({
        kind: "mnemonic",
        id: "help",
        key: "?",
        label: "help",
        charIndex: null,
        guarded: false,
      }),
    ).toEqual([
      { text: "?", accent: true },
      { text: " help", accent: false },
    ]);
  });

  it("a winning char mid-label keeps prefix and suffix intact", () => {
    expect(
      chipSegments({
        kind: "mnemonic",
        id: "approve",
        key: "o",
        label: "approve",
        charIndex: 4,
        guarded: false,
      }),
    ).toEqual([
      { text: "appr", accent: false },
      { text: "o", accent: true },
      { text: "ve", accent: false },
    ]);
  });
});

describe("Footer (chips)", () => {
  it("renders mnemonic labels and structural key-first chips, · separated", () => {
    const f = render(
      <Footer
        chips={[
          { kind: "structural", key: "↑/↓", label: "move" },
          { kind: "mnemonic", id: "retry", key: "t", label: "retry", charIndex: 2, guarded: false },
          {
            kind: "mnemonic",
            id: "delete",
            key: "D",
            label: "delete",
            charIndex: 0,
            guarded: true,
          },
        ]}
      />,
    ).lastFrame()!;
    expect(f).toContain("↑/↓ move");
    expect(f).toContain("retry");
    expect(f).toContain("Delete"); // guarded char uppercased in place
    expect(f).toContain(" · ");
  });
});
