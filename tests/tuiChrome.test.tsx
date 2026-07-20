import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import {
  Header,
  Toast,
  Footer,
  hintsFor,
  hintsForUnified,
  localHintsFor,
} from "../src/tui/components/Chrome.js";
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
        repoNwo="acme/api"
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
        refreshedAt={null}
      />,
    ).lastFrame()!;
    expect(f).toContain("🐦");
    expect(f).toContain("junco");
    expect(f).toContain("acme/api");
    expect(f).toContain("daemon ●");
    expect(f).toContain("3h4m");
    expect(f).toContain("◐1 ⏳2");
    expect(f).not.toMatch(/\d{2}:\d{2}/);
  });
  it("daemon down and watchlist warn chip", () => {
    const f = render(
      <Header
        repoNwo={null}
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
        refreshedAt={null}
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
        refreshedAt={null}
      />,
    ).lastFrame()!;
    expect(withDepth).toContain("⇡3 unpushed");

    const noDepth = render(
      <Header
        repoNwo="acme/api"
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
        refreshedAt={null}
      />,
    ).lastFrame()!;
    expect(noDepth).not.toContain("unpushed");
  });
});

describe("Header pulse", () => {
  const base = {
    repoNwo: "acme/api",
    now: NOW,
    mode: "wide" as const,
    queueRunning: 0,
    queueWaiting: 0,
    watchlistError: null,
    outboxDepth: 0,
    prAttention: 0,
    prFailing: false,
    refreshedAt: null,
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
    expect(f).toContain("daemon ○");
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
    expect(f).toContain("daemon ●");
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
    repoNwo: "acme/api",
    health: UP_BARE,
    reviewCount: 0,
    now: NOW,
    queueRunning: 0,
    queueWaiting: 0,
    watchlistError: null,
    outboxDepth: 0,
    refreshedAt: null,
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
  it("main pane 2 advertises the PRs view key, placed next to the queue key", () => {
    const pairs = hintsFor("main", 2, "wide", false);
    const pIdx = pairs.findIndex(([k]) => k === "p");
    const tIdx = pairs.findIndex(([k]) => k === "t");
    expect(pairs.find(([k]) => k === "p")?.[1]).toBe("PRs");
    expect(tIdx).toBeGreaterThanOrEqual(0);
    expect(Math.abs(pIdx - tIdx)).toBe(1);
  });
  it("medium mode: enter says preview (same word as wide) and the pane hint drops to ←/repos", () => {
    const pairs = hintsFor("main", 2, "medium", false);
    expect(pairs.find(([k]) => k === "enter")?.[1]).toBe("preview");
    expect(pairs.find(([k]) => k === "←")?.[1]).toBe("repos");
  });
  it("pane 1 hints: s assess, placed after refresh and before the command palette key", () => {
    const pairs = hintsFor("main", 1, "wide", false);
    const sIdx = pairs.findIndex(([k]) => k === "s");
    const rIdx = pairs.findIndex(([k]) => k === "r");
    const colonIdx = pairs.findIndex(([k]) => k === ":");
    expect(pairs.find(([k]) => k === "s")?.[1]).toBe("assess");
    expect(sIdx).toBeGreaterThan(rIdx);
    expect(sIdx).toBeLessThan(colonIdx);
  });
  it("pane 1 footer row (with the s hint added) still renders as exactly one line", () => {
    // ink-testing-library's stdout is hardcoded to 100 cols (narrower than the
    // 110-col wide breakpoint this pane targets), so this is the tighter of
    // the two cases; Footer's wrap="truncate-end" makes wrapping structurally
    // impossible regardless of hint count — this proves the new hint didn't
    // somehow defeat that.
    const hints = hintsFor("main", 1, "wide", false);
    const f = render(<Footer hints={hints} />).lastFrame()!;
    const lines = f.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("s assess"); // present in full, not truncated away
  });
  it("pane 3 hints: ↑/↓ move, enter detail, o browser", () => {
    const pairs = hintsFor("main", 3, "wide", false);
    expect(pairs.find(([k]) => k === "↑/↓")?.[1]).toBe("move");
    expect(pairs.find(([k]) => k === "enter")?.[1]).toBe("detail");
    expect(pairs.find(([k]) => k === "o")?.[1]).toBe("browser");
  });
  it("prs view: enter detail, o browser (no more combined enter-opens-browser)", () => {
    const pairs = hintsFor("prs", 2, "wide", false);
    expect(pairs.find(([k]) => k === "enter")?.[1]).toBe("detail");
    expect(pairs.find(([k]) => k === "o")?.[1]).toBe("browser");
    expect(pairs.find(([k]) => k === "o/enter")).toBeUndefined();
  });
  it("prDetail hints: esc back, o browser", () => {
    expect(hintsFor("prDetail", 2, "wide", false)).toEqual([
      ["esc", "back"],
      ["o", "browser"],
    ]);
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

describe("Header unified refresh stamp", () => {
  const base = {
    repoNwo: "acme/api",
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

  it("renders ↻ age from refreshedAt", () => {
    const f = render(
      <Header {...base} mode="wide" refreshedAt="2026-07-07T09:59:48Z" />, // 12s before NOW
    ).lastFrame()!;
    expect(f).toContain("↻ 12s");
  });

  it("hidden before the first cycle completes (refreshedAt null)", () => {
    const f = render(<Header {...base} mode="wide" refreshedAt={null} />).lastFrame()!;
    expect(f).not.toContain("↻");
  });

  it("survives narrow modes — the stamp is an essential chip", () => {
    const f = render(
      <Header {...base} mode="medium" refreshedAt="2026-07-07T09:59:48Z" />,
    ).lastFrame()!;
    expect(f).toContain("↻ 12s");
  });
});

describe("Header mode tabs", () => {
  const base = {
    repoNwo: "acme/api",
    health: UP_BARE,
    reviewCount: 0,
    now: NOW,
    queueRunning: 0,
    queueWaiting: 0,
    watchlistError: null,
    outboxDepth: 0,
    prAttention: 0,
    prFailing: false,
    refreshedAt: null,
  } as const;

  it("absent uiMode renders no tab (byte-for-byte legacy header)", () => {
    const f = render(<Header {...base} mode="wide" />).lastFrame()!;
    expect(f).not.toContain("[GITHUB]");
    expect(f).not.toContain("[LOCAL]");
  });

  it("github active: [GITHUB] bracketed, local plain — survives NO_COLOR", () => {
    const f = render(<Header {...base} mode="wide" uiMode="github" githubEnabled />).lastFrame()!;
    expect(f).toContain("[GITHUB]");
    expect(f).toContain("local");
    expect(f).not.toContain("[LOCAL]");
  });

  it("local active: github plain, [LOCAL] bracketed", () => {
    const f = render(<Header {...base} mode="wide" uiMode="local" githubEnabled />).lastFrame()!;
    expect(f).toContain("[LOCAL]");
    expect(f).toContain("github");
    expect(f).not.toContain("[GITHUB]");
  });

  it("compact form below the wide breakpoint: single-letter tabs", () => {
    const f = render(<Header {...base} mode="medium" uiMode="github" githubEnabled />).lastFrame()!;
    expect(f).toContain("[G]");
    expect(f).toContain("l");
    expect(f).not.toContain("[GITHUB]");
  });

  it("columns=60 (medium, narrowest) with a full chip set stays one row (no wrap)", () => {
    const f = render(
      <Header
        {...base}
        mode="medium"
        uiMode="local"
        githubEnabled
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

  it("renders the tabs after the brand, GITHUB before LOCAL", () => {
    // Presentational ordering only — clicks resolve against each tab's own
    // ClickableBox region now (headerTabBands is gone), so this just pins the
    // draw order the region rects inherit: brand < GITHUB < LOCAL.
    const f = render(<Header {...base} mode="wide" uiMode="github" githubEnabled />).lastFrame()!;
    const brandAt = f.indexOf("junco");
    const ghAt = f.indexOf("[GITHUB]");
    const loAt = f.indexOf("local");
    expect(brandAt).toBeGreaterThanOrEqual(0);
    expect(ghAt).toBeGreaterThan(brandAt);
    expect(loAt).toBeGreaterThan(ghAt);
  });
});

describe("localHintsFor", () => {
  it("rail focus advertises the global mode + section keys", () => {
    const keys = localHintsFor("queue", "rail").map(([k]) => k);
    expect(keys).toContain("↑/↓");
    expect(keys).toContain("m");
    expect(keys).toContain("q");
  });
  it("queue body advertises R requeue and x delete", () => {
    const pairs = localHintsFor("queue", "body");
    expect(pairs.find(([k]) => k === "R")?.[1]).toBe("requeue");
    expect(pairs.find(([k]) => k === "x")?.[1]).toBe("delete");
  });
  it("worktrees body advertises x prune; daemon advertises X restart and [/] scroll", () => {
    expect(localHintsFor("worktrees", "body").find(([k]) => k === "x")?.[1]).toBe("prune");
    const daemon = localHintsFor("daemon", "body").map(([k]) => k);
    expect(daemon).toContain("X");
    expect(daemon).toContain("[/]");
  });
});

describe("hintsFor github main still discovers the mode key", () => {
  it("main pane 2 wide includes m local", () => {
    const pairs = hintsFor("main", 2, "wide", false);
    expect(pairs.find(([k]) => k === "m")?.[1]).toBe("local");
  });
});

describe("hintsForUnified", () => {
  it("delegates non-main views to the existing sets", () => {
    expect(hintsForUnified("detail", "issues", 2, "wide", false)).toEqual(
      hintsFor("detail", 2, "wide", false),
    );
  });

  it("main + pane 1 has no mode toggle and keeps rail verbs", () => {
    const keys = hintsForUnified("main", "issues", 1, "wide", false).map(([k]) => k);
    expect(keys).not.toContain("m");
    for (const k of ["↑/↓", "w", "x", "o", "r", "s", "t", ":", "?", "q"]) {
      expect(keys).toContain(k);
    }
  });

  it("main + pane 2 varies by body kind", () => {
    const q = hintsForUnified("main", "queue", 2, "wide", false).map(([k]) => k);
    expect(q).toEqual(expect.arrayContaining(["↑/↓", "R", "x", "←"]));
    const d = hintsForUnified("main", "daemon", 2, "wide", false).map(([k]) => k);
    expect(d).toEqual(expect.arrayContaining(["[/]", "X", "f"]));
    const issue = hintsForUnified("main", "issues", 2, "wide", false).map(([k]) => k);
    expect(issue).toEqual(expect.arrayContaining(["d", "a", "/", "p"]));
    expect(issue).not.toContain("m");
    const r = hintsForUnified("main", "repoDetail", 2, "wide", false).map(([k]) => k);
    expect(r).toEqual(expect.arrayContaining(["[ ]", "←"]));
  });

  it("pane 3 delegates to the existing PR-pane set", () => {
    expect(hintsForUnified("main", "issues", 3, "wide", false)).toEqual(
      hintsFor("main", 3, "wide", false),
    );
  });

  it("filtering short-circuits like hintsFor", () => {
    expect(hintsForUnified("main", "issues", 2, "wide", true)).toEqual(
      hintsFor("main", 2, "wide", true),
    );
  });
});
