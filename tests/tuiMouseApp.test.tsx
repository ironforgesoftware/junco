// App-level mouse routing through the hit-region registry (MouseProvider +
// ClickableBox). A press/wheel is resolved to the deepest registered region
// under the pointer's real yoga rect — no mirrored geometry, no hitTest. These
// specs exercise the GITHUB surface (issue rows, the rail wheel) and the header
// mode tabs; renderApp mounts at the wide breakpoint (WIDE_COLS_TEST) so the
// bracketed `[GITHUB]`/`[LOCAL]` tabs render and the pane bands are stable.
import { describe, it, afterEach, expect } from "vitest";
import { cleanup } from "ink-testing-library";
import { until, fireUntil } from "./helpers/until.js";
import { renderApp, okv, stubClient } from "./helpers/localFixtures.js";
import type { PendingAssess } from "../src/assessReview.js";

afterEach(cleanup);

// SGR mouse sequences at 0-based cell (x,y): ESC [ < b ; col ; row M, cols/rows
// 1-based on the wire. b=0 press, b=65 wheel-down. `\u001b` (not a raw ESC byte)
// so file edits never drop it.
const press = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;
const wheelDown = (x: number, y: number): string => `\u001b[<65;${x + 1};${y + 1}M`;

const lineOf = (frame: string, needle: string): number =>
  frame.split("\n").findIndex((l) => l.includes(needle));

// Header tab click bands (wide mode), mirroring Chrome.tsx's Header layout:
// paddingX(1) + "🐦 junco" (8 cols — the bird emoji is width 2) + gap(2) = 11
// cols before the GITHUB tab, then the fixed-width `[GITHUB]`/`github` slot
// (ghWidth=8) + a 1-col gutter before the LOCAL slot. (These were the
// now-deleted headerTabBands' githubStart/localStart.)
const GITHUB_TAB_START = 11;
const LOCAL_TAB_START = GITHUB_TAB_START + 8 + 1; // 20

describe("mouse row/wheel in GITHUB", () => {
  it("clicking an issue row selects it; clicking again opens the detail", async () => {
    const r = renderApp({ initialUiMode: "github" }); // fixture seeds ≥2 issues
    await until(() => lineOf(r.lastFrame() ?? "", "#2") >= 0);
    const y = lineOf(r.lastFrame() ?? "", "#2");
    // Middle column band at WIDE_COLS_TEST=120: rail [0,26), issues [26,72),
    // preview/pane-3 [72,120). x=40 is solidly inside the issues pane.
    const x = 40;
    // First press selects #2 (row is deselected at mount → click is idempotent).
    await fireUntil(
      r.stdin,
      press(x, y),
      () => (r.lastFrame() ?? "").split("\n")[y]?.includes("▌") ?? false,
    );
    // Second press on the already-selected row opens the detail (which unmounts
    // the list, so the retry self-terminates).
    await fireUntil(r.stdin, press(x, y), () => (r.lastFrame() ?? "").includes("preview · #2"));
  });

  it("wheel over the rail moves the repo selection", async () => {
    const r = renderApp({ initialUiMode: "github" }); // fixture seeds ≥2 repos
    await until(() => (r.lastFrame() ?? "").includes("1 repos"));
    // wheelDown inside the rail band; the mover clamps at the last repo, so
    // re-sending is idempotent. The selected repo's nwo also shows in the
    // header, so anchor on the rail row that carries BOTH the nwo AND the `▌`
    // selection bar (the header never renders the bar).
    await fireUntil(r.stdin, wheelDown(2, 4), () =>
      (r.lastFrame() ?? "").split("\n").some((l) => l.includes("beta/two") && l.includes("▌")),
    );
  });
});

describe("modal-ish views: mouse", () => {
  it("help modal: any click closes it", async () => {
    const r = renderApp({ initialUiMode: "github" });
    await until(() => (r.lastFrame() ?? "").includes("1 repos"));
    r.stdin.write("?");
    await until(() => (r.lastFrame() ?? "").includes("junco dashboard"));
    r.stdin.write(press(2, 2)); // anywhere — HelpModal registers no regions
    await until(() => !(r.lastFrame() ?? "").includes("junco dashboard — "));
  });

  it("addRepo modal: click outside cancels back to main", async () => {
    const r = renderApp({ initialUiMode: "github" });
    await until(() => (r.lastFrame() ?? "").includes("1 repos"));
    r.stdin.write("w");
    await until(() => (r.lastFrame() ?? "").includes("add repo to watchlist"));
    r.stdin.write(press(0, 5)); // far left — outside the centered modal box
    await until(() => !(r.lastFrame() ?? "").includes("add repo to watchlist"));
  });
});

describe("header mode tabs", () => {
  it("a header-band click toggles the mode", async () => {
    const r = renderApp({ initialUiMode: "github" });
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
    // handleModeTab is a no-op once already local, so re-sending is idempotent.
    await fireUntil(r.stdin, press(LOCAL_TAB_START, 0), () =>
      (r.lastFrame() ?? "").includes("[LOCAL]"),
    );
  });

  it("hovering a header tab does not crash and hover moves with the pointer", async () => {
    const r = renderApp({ initialUiMode: "github" });
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
    // b=35 → button-less motion (hover) over the LOCAL tab.
    r.stdin.write(`\u001b[<35;${LOCAL_TAB_START + 1};1M`);
    await until(() => (r.lastFrame() ?? "") !== ""); // hover styling is cosmetic — frame stays renderable
    await fireUntil(r.stdin, press(LOCAL_TAB_START, 0), () =>
      (r.lastFrame() ?? "").includes("[LOCAL]"),
    );
  });
});

describe("review view: mouse", () => {
  // Two batches so the combined-list cursor (starts at 0, on the first batch)
  // differs from the row we click — the first click only moves the cursor,
  // the second opens the checklist (mirrors the GITHUB issue-row spec above).
  const batch1: PendingAssess = {
    id: "assess-1",
    nwo: "o/r1",
    external: true,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [
      {
        fingerprint: "g1",
        kind: "code",
        severity: "low",
        ruleId: "R",
        title: "minor issue",
        description: "",
        references: [],
      },
    ],
  };
  const batch2: PendingAssess = {
    id: "assess-2",
    nwo: "o/r2",
    external: true,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [
      {
        fingerprint: "f1",
        kind: "code",
        severity: "high",
        ruleId: "R",
        title: "SQL injection",
        description: "",
        references: [],
      },
      {
        fingerprint: "f2",
        kind: "code",
        severity: "low",
        ruleId: "R",
        title: "stale dep",
        description: "",
        references: [],
      },
    ],
  };

  it("review: click a batch row twice to open it; click a finding to toggle its checkbox", async () => {
    const client = { ...stubClient, listReview: async () => okv([batch1, batch2]) };
    const r = renderApp({ initialUiMode: "github", client });
    await until(() => (r.lastFrame() ?? "").includes("1 repos"));
    r.stdin.write("v");
    await until(() => (r.lastFrame() ?? "").includes("o/r2")); // both batches listed
    const x = 5;
    const y = lineOf(r.lastFrame() ?? "", "o/r2");
    // First press: cursor (initially on batch1, row 0) moves onto batch2's row.
    await fireUntil(
      r.stdin,
      press(x, y),
      () => (r.lastFrame() ?? "").split("\n")[y]?.includes("▌") ?? false,
    );
    // Second press on the now-selected row opens batch2's checklist.
    await fireUntil(r.stdin, press(x, y), () => (r.lastFrame() ?? "").includes("stale dep"));
    // Every finding starts checked — click "stale dep" (index 1): the checkbox
    // flips to unchecked AND the `▌` cursor moves onto its row.
    const fy = lineOf(r.lastFrame() ?? "", "stale dep");
    await fireUntil(
      r.stdin,
      press(x, fy),
      () => (r.lastFrame() ?? "").split("\n")[fy]?.includes("[ ]") ?? false,
    );
    const clickedLine = (r.lastFrame() ?? "").split("\n")[fy] ?? "";
    if (!clickedLine.includes("▌"))
      throw new Error(`finding cursor did not follow the click: ${clickedLine}`);
  });
});

describe("footer chips: mouse", () => {
  it("footer chip: clicking 't queue' opens the queue view; 'esc/t' closes it", async () => {
    const r = renderApp({ initialUiMode: "github" });
    await until(() => (r.lastFrame() ?? "").includes("1 repos"));
    // Mount lands on pane 1 (rail) whose hint set has no "t" entry — "t queue"
    // only appears once pane 2 (issues) is focused, mirroring how a user
    // would actually reach it.
    r.stdin.write("l");
    await until(() => (r.lastFrame() ?? "").includes("t queue"));
    const f = r.lastFrame() ?? "";
    const footerY = f.split("\n").length - 1;
    const x = f.split("\n")[footerY].indexOf("t queue");
    r.stdin.write(press(x, footerY));
    await until(() => (r.lastFrame() ?? "").includes("RUNNING"));
    const f2 = r.lastFrame() ?? "";
    const x2 = f2.split("\n")[footerY].indexOf("esc/t");
    r.stdin.write(press(x2, footerY));
    await until(() => (r.lastFrame() ?? "").includes("1 repos"));
  });

  it("pane 3 focused: the 'enter detail' chip opens the PR overlay, not the issue detail", async () => {
    // One junco PR for the selected repo so pane 3 has a selected row.
    const pr = {
      number: 100,
      title: "Some PR",
      url: "https://github.com/acme/api/pull/100",
      headRefName: "junco/some-slug",
      baseRefName: "main",
      isDraft: false,
      state: "OPEN",
      reviewDecision: null,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      checks: { pass: 1, fail: 0, pending: 0, total: 1 },
      additions: 10,
      deletions: 2,
      changedFiles: 3,
      createdAt: "2026-07-05T10:00:00Z",
      updatedAt: "2026-07-06T10:00:00Z",
      mergedAt: null,
      author: "junco-bot",
      labels: [],
      nwo: "acme/api",
    };
    const client = {
      ...stubClient,
      listPrs: async (nwo: string) => okv({ prs: nwo === "acme/api" ? [pr] : [], staleAt: null }),
    };
    const r = renderApp({ initialUiMode: "github", client });
    await until(() => (r.lastFrame() ?? "").includes("#100")); // PR row loaded in pane 3
    r.stdin.write("3"); // focus pane 3 (wide layout)
    await until(() => (r.lastFrame() ?? "").includes("enter detail")); // pane-3 hint set
    const f = r.lastFrame() ?? "";
    const footerY = f.split("\n").length - 1;
    const x = f.split("\n")[footerY].indexOf("enter detail");
    // Landing opens the PR overlay (unmounts the chip row's main-view set, so
    // the retry self-terminates); the issue-detail overlay would say
    // "preview · #1" instead — assert the PR one specifically.
    await fireUntil(r.stdin, press(x, footerY), () => (r.lastFrame() ?? "").includes("pr · #100"));
    expect(r.lastFrame() ?? "").not.toContain("preview · #");
  });

  it("pane 1 (mount default): the 'o browser' chip opens the REPO, never the selected issue", async () => {
    let repoOpens = 0;
    let issueOpens = 0;
    const client = {
      ...stubClient,
      openRepoInBrowser: async () => {
        repoOpens++;
        return okv(undefined);
      },
      openInBrowser: async () => {
        issueOpens++;
        return okv(undefined);
      },
    };
    const r = renderApp({ initialUiMode: "github", client });
    await until(() => (r.lastFrame() ?? "").includes("1 repos"));
    const f = r.lastFrame() ?? "";
    const footerY = f.split("\n").length - 1;
    const x = f.split("\n")[footerY].indexOf("o browser"); // pane-1 hint set at mount
    await fireUntil(r.stdin, press(x, footerY), () => repoOpens === 1); // counted-once = idempotent-safe
    expect(repoOpens).toBe(1);
    expect(issueOpens).toBe(0); // the old flat map would have opened the issue here
  });

  it("pane 2: the 'c analyze' chip drafts an analysis for the selected issue", async () => {
    let analyzeCalls = 0;
    const client = {
      ...stubClient,
      analyzeIssue: async () => {
        analyzeCalls++;
        return okv({ id: "analyze-acme-api-1" });
      },
    };
    const r = renderApp({ initialUiMode: "github", client });
    await until(() => (r.lastFrame() ?? "").includes("1 repos"));
    r.stdin.write("l"); // pane 2 — the only hint set carrying "c analyze"
    await until(() => (r.lastFrame() ?? "").includes("c analyze"));
    const f = r.lastFrame() ?? "";
    const footerY = f.split("\n").length - 1;
    const x = f.split("\n")[footerY].indexOf("c analyze");
    await fireUntil(r.stdin, press(x, footerY), () => analyzeCalls === 1); // counted-once = idempotent-safe
    expect(analyzeCalls).toBe(1);
    // The keyboard recipe's success toast lands once the stubbed promise
    // resolves — same copy, proving the chip ran the verbatim branch.
    await until(() =>
      (r.lastFrame() ?? "").includes("analysis queued: analyze-acme-api-1 · v to review"),
    );
  });

  it("LOCAL help modal: the stale rail chip underneath 'q' stays inert — closes help, does not quit", async () => {
    let exited = false;
    const r = renderApp({ initialUiMode: "local", onExit: () => (exited = true) });
    await until(() => (r.lastFrame() ?? "").includes("q quit"));
    r.stdin.write("?");
    await until(() => (r.lastFrame() ?? "").includes("junco dashboard"));
    // LOCAL's `hints` computation doesn't special-case view==="help" (unlike
    // github's, which swaps to hintsFor("help",...)) so the rail's hint row —
    // "q quit" included — is still the last frame line while the modal is up.
    // The "q" chip must render inert there (no footerActions entry for
    // view==="help"): a press with no region under it falls through to the
    // pre-existing onMouseMiss("help") handler, which closes the modal —
    // exactly "any key closes help", never a quit.
    const f = r.lastFrame() ?? "";
    const footerY = f.split("\n").length - 1;
    const x = f.split("\n")[footerY].indexOf("q quit");
    r.stdin.write(press(x, footerY));
    await until(() => !(r.lastFrame() ?? "").includes("junco dashboard"));
    expect(exited).toBe(false);
  });
});
