import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { Header, Footer } from "../src/tui/components/Chrome.js";
import type { HealthInfo } from "../src/tui/ghClient.js";
import type { FooterRows } from "../src/tui/footerModel.js";
import { MouseProvider } from "../src/tui/MouseProvider.js";
import { until, fireUntil, wait } from "./helpers/until.js";

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
        stats={null}
        runningIds={[]}
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
        stats={null}
        runningIds={[]}
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
        stats={null}
        runningIds={[]}
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
        stats={null}
        runningIds={[]}
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
    stats: null,
    runningIds: [],
  };

  it("renders the full pulse row when healthy: review, last-task, bridge (since-restart task counts and tokens are gone)", () => {
    const f = render(<Header {...base} health={HEALTHY} reviewCount={3} />).lastFrame()!;
    expect(f).toContain("●3 review");
    expect(f).toContain("last ✓ 2m");
    expect(f).toContain("bridge ✗1");
    expect(f).not.toContain("✓8");
    expect(f).not.toContain("tok 45k");
  });

  it("review chip hidden at 0, shown at 3", () => {
    const hidden = render(<Header {...base} health={HEALTHY} reviewCount={0} />).lastFrame()!;
    expect(hidden).not.toContain("review");

    const shown = render(<Header {...base} health={HEALTHY} reviewCount={3} />).lastFrame()!;
    expect(shown).toContain("●3 review");
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

  it("medium mode keeps only the essential chips (record/last/bridge drop by design)", () => {
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
    stats: null,
    runningIds: [],
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
    stats: null,
    runningIds: [],
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

// ── the two-row footer (spec 2026-09-02 §3) ────────────────────────────────
// ink-testing-library's Stdout hardcodes 100 columns (its `render` takes no
// options argument at all), so a narrower terminal is simulated by wrapping
// the component in a fixed-width COLUMN box: a column box stretches its
// children across its full width, which is what FooterLine's flexGrow spacer
// needs in order to push the pinned chips to the right edge.
const renderAt = (columns: number, el: React.JSX.Element) =>
  render(
    <Box width={columns} flexDirection="column">
      {el}
    </Box>,
  );

const rows: FooterRows = {
  actions: {
    label: "issue #46",
    chips: [
      { kind: "pill", id: "chat", key: "c", label: "chat", charIndex: 0, guarded: false },
      { kind: "mnemonic", id: "dispatch", key: "m", label: "import", charIndex: 1, guarded: false },
      { kind: "mnemonic", id: "delete", key: "D", label: "delete", charIndex: 0, guarded: true },
      { kind: "separator", id: "|", key: "", label: "", charIndex: null, guarded: false },
      { kind: "mnemonic", id: "prs", key: "p", label: "PRs", charIndex: 0, guarded: false },
    ],
    pinned: [],
  },
  navigate: {
    label: "navigate",
    chips: [
      { kind: "structural", id: "↑/↓", key: "↑/↓", label: "move", charIndex: null, guarded: false },
      {
        kind: "structural",
        id: "enter",
        key: "enter",
        label: "preview",
        charIndex: null,
        guarded: false,
      },
    ],
    pinned: [
      { kind: "mnemonic", id: "help", key: "?", label: "help", charIndex: null, guarded: false },
      { kind: "mnemonic", id: "quit", key: "q", label: "quit", charIndex: 0, guarded: false },
    ],
  },
};

describe("Footer (two rows, spec 2026-09-02 §3)", () => {
  it("renders the actions row then the navigate row — exactly two lines, labels first", () => {
    const f = render(<Footer rows={rows} toast={null} />).lastFrame()!;
    const lines = f.split("\n");
    expect(lines).toHaveLength(2);
    // Structural chips carry a padded keycap (` ⏎ `, spec §3.4) and the label
    // brings its own leading space, so the stripped frame shows TWO spaces
    // between them — ` +`, never a single literal space.
    expect(lines[0]).toMatch(/^ issue #46 +chat +import +Delete +│ +PRs/);
    expect(lines[1]).toMatch(/^ navigate +↑↓ +move +⏎ +preview/);
  });
  it("pins ? help and quit to the right edge of the navigate row", () => {
    const f = renderAt(80, <Footer rows={rows} toast={null} />).lastFrame()!;
    const nav = f.split("\n")[1]!;
    expect(nav.trimEnd().endsWith("? help  quit")).toBe(true);
    expect(nav.trimEnd().length).toBeGreaterThan(60); // the spacer pushed them right
  });
  it("a toast replaces the actions row only; the navigate row stays", () => {
    const f = render(
      <Footer rows={rows} toast={{ kind: "error", text: "gh boom\nline 2" }} />,
    ).lastFrame()!;
    const lines = f.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("gh boom · line 2");
    expect(lines[0]).not.toContain("import");
    expect(lines[1]).toContain("↑↓");
    expect(lines[1]).toContain("move");
  });
  it("pads both labels to the same width so the chips start in one column", () => {
    const f = render(<Footer rows={rows} toast={null} />).lastFrame()!;
    const [a, n] = f.split("\n");
    expect(a!.indexOf("chat")).toBe(n!.indexOf("↑↓"));
  });
  it("renders a row with no chips and no pinned run at all", () => {
    const bare: FooterRows = {
      actions: { label: "queue", chips: [], pinned: [] },
      navigate: { label: "navigate", chips: rows.navigate.chips, pinned: [] },
    };
    const lines = render(<Footer rows={bare} toast={null} />)
      .lastFrame()!
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.trim()).toBe("queue");
    expect(lines[1]).not.toContain("help");
  });
  it("clips a long row without wrapping", () => {
    const wide = {
      ...rows,
      actions: {
        ...rows.actions,
        chips: Array.from({ length: 30 }, (_, i) => ({
          kind: "mnemonic" as const,
          id: `v${i}`,
          key: "x",
          label: `verb-number-${i}`,
          charIndex: 0,
          guarded: false,
        })),
      },
    };
    const f = renderAt(60, <Footer rows={wide} toast={null} />).lastFrame()!;
    expect(f.split("\n")).toHaveLength(2);
  });
  it("chips with a chipActions entry are clickable by id (pill/mnemonic) or key (structural)", async () => {
    // SGR press at 0-based cell (x, y) — the same wire format tests/tuiMouseApp.test.tsx uses.
    const press = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;
    const hits: string[] = [];
    const r = render(
      <MouseProvider>
        <Footer
          rows={rows}
          toast={null}
          chipActions={{ chat: () => hits.push("chat"), enter: () => hits.push("enter") }}
        />
      </MouseProvider>,
    );
    await until(() => (r.lastFrame() ?? "").includes("chat"));
    const [a, n] = r.lastFrame()!.split("\n");
    await fireUntil(r.stdin, press(a!.indexOf("chat"), 0), () => hits.includes("chat"));
    await fireUntil(r.stdin, press(n!.indexOf("⏎"), 1), () => hits.includes("enter"));
    expect(hits).toEqual(["chat", "enter"]);
    // A chip with NO chipActions entry stays inert: `import` renders as plain
    // text, so a press there registers nothing (and never falls through to a
    // neighbouring chip's handler).
    r.stdin.write(press(a!.indexOf("import"), 0));
    await wait(60);
    expect(hits).toEqual(["chat", "enter"]);
  });
});
