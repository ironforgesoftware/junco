// App-level mouse routing through the hit-region registry (MouseProvider +
// ClickableBox). A press/wheel is resolved to the deepest registered region
// under the pointer's real yoga rect — no mirrored geometry, no hitTest. These
// specs exercise the unified surface (issue rows, rail rows — repo AND system
// — plus footer chips); renderApp mounts at the wide breakpoint
// (WIDE_COLS_TEST) so the pane bands are stable.
import React, { useContext } from "react";
import { describe, it, afterEach, expect } from "vitest";
import { render, cleanup } from "ink-testing-library";
import { until, fireUntil, tick } from "./helpers/until.js";
import { renderApp, makeAppProps, okv, stubClient, ESC } from "./helpers/localFixtures.js";
import type { LogReaderDeps } from "../src/logReader.js";
import { App } from "../src/tui/App.js";
import { MouseContext, MouseProvider } from "../src/tui/MouseProvider.js";
import type { MouseStore } from "../src/tui/mouseRegions.js";
import type { PendingAssess } from "../src/assessReview.js";

afterEach(cleanup);

// SGR mouse sequences at 0-based cell (x,y): ESC [ < b ; col ; row M, cols/rows
// 1-based on the wire. b=0 press, b=35 button-less motion (hover), b=65
// wheel-down. `\u001b` (not a raw ESC byte) so file edits never drop it.
const press = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;
const move = (x: number, y: number): string => `\u001b[<35;${x + 1};${y + 1}M`;
const wheelDown = (x: number, y: number): string => `\u001b[<65;${x + 1};${y + 1}M`;

/** Exposes the provider's hit-region store. Hover is a background color —
 * invisible in a colorless frame (chalk emits no ANSI off a TTY, so frames
 * carry hoverBg on GitHub Actions but not locally) — so the store is the only
 * environment-independent place a test can see a motion event resolve. */
function StoreTap({ tap }: { tap: { store: MouseStore | null } }): null {
  tap.store = useContext(MouseContext)?.store ?? null;
  return null;
}

const lineOf = (frame: string, needle: string): number =>
  frame.split("\n").findIndex((l) => l.includes(needle));

// The footer is two rows now (spec 2026-09-02 §3): mnemonic chips (the verbs)
// live on the ACTIONS row, structural ones (⏎ / ← / ↑↓ …) on the NAVIGATE row
// below it. Both are always the frame's last two lines — layout.ts still
// budgets CHROME_ROWS=3, the toast having moved into the actions row.
const actionsY = (frame: string): number => frame.split("\n").length - 2;
const navigateY = (frame: string): number => frame.split("\n").length - 1;
const rowAt = (frame: string, y: number): string => frame.split("\n")[y] ?? "";

describe("mouse row/wheel on the issues surface", () => {
  it("clicking an issue row selects it; clicking again opens the detail", async () => {
    const r = renderApp(); // fixture seeds ≥2 issues
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

  it("wheel over the rail moves the selection down the row union", async () => {
    const r = renderApp(); // fixture seeds ≥2 repos
    await until(() => (r.lastFrame() ?? "").includes("repos"));
    // wheelDown inside the rail band. The unified rail wheels over the WHOLE
    // row union (repos then system rows), so a re-sent wheel keeps walking —
    // the cond must be "moved OFF the first repo", which stays true however
    // far the retries walk (unlike anchoring on one specific row, which a
    // slow-runner retry walks straight past — the pre-unified flake).
    await fireUntil(r.stdin, wheelDown(2, 4), () => {
      const lines = (r.lastFrame() ?? "").split("\n");
      const onFirstRepo = lines.some((l) => l.includes("▌") && l.includes("acme/api"));
      return !onFirstRepo && lines.some((l) => l.includes("▌"));
    });
  });
});

describe("modal-ish views: mouse", () => {
  it("help modal: any click closes it", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("repos"));
    r.stdin.write("?");
    await until(() => (r.lastFrame() ?? "").includes("junco dashboard"));
    r.stdin.write(press(2, 2)); // anywhere — HelpModal registers no regions
    await until(() => !(r.lastFrame() ?? "").includes("junco dashboard — "));
  });

  it("addRepo modal: click outside cancels back to main", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("repos"));
    r.stdin.write("a"); // [a]dd repo mnemonic
    await until(() => (r.lastFrame() ?? "").includes("add repo to watchlist"));
    r.stdin.write(press(0, 5)); // far left — outside the centered modal box
    await until(() => !(r.lastFrame() ?? "").includes("add repo to watchlist"));
  });
});

describe("rail system rows: mouse", () => {
  it("clicking a system row selects it; click-again focuses the body", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("system"));
    // Pre-click, the only "queue" line on screen is the rail's system row
    // (the issues body says nothing about queues).
    const y = lineOf(r.lastFrame() ?? "", "queue");
    // Click selects the row (idempotent once selected — re-send is safe).
    await fireUntil(r.stdin, press(3, y), () =>
      (r.lastFrame() ?? "").split("\n").some((l) => l.includes("▌") && l.includes("queue")),
    );
    await until(() => (r.lastFrame() ?? "").includes("sub-fix-typos")); // queue body up
    // Click-again = enter: body focus — the queue body's chips replace the rail's.
    await fireUntil(r.stdin, press(3, y), () => (r.lastFrame() ?? "").includes("retry"));
  });

  it("hovering a rail row lands the hover on that row; a click then selects it", async () => {
    const tap: { store: MouseStore | null } = { store: null };
    const r = render(
      <MouseProvider>
        <StoreTap tap={tap} />
        <App {...makeAppProps()} />
      </MouseProvider>,
    );
    await until(() => (r.lastFrame() ?? "").includes("beta/two"));
    const y = lineOf(r.lastFrame() ?? "", "beta/two");
    const x = 3;
    // Landed ⇔ the store's hovered region is the one under the pointer AND it
    // carries an onPress — the row does, the rail's wheel-only wrapper (which
    // a motion racing the row's registration would resolve to) does not.
    // Motion is idempotent, so re-sending it is safe.
    await fireUntil(r.stdin, move(x, y), () => {
      const hit = tap.store?.resolve(x, y);
      return hit?.handlers.onPress !== undefined && tap.store?.hoveredId() === hit.id;
    });
    await fireUntil(r.stdin, press(x, y), () =>
      (r.lastFrame() ?? "").split("\n").some((l) => l.includes("▌") && l.includes("beta/two")),
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
    const r = renderApp({ client });
    await until(() => (r.lastFrame() ?? "").includes("repos"));
    r.stdin.write("v"); // review mnemonic (surface-legibility Task 2 shifted it off `e`)
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

  // The chat-draft row is the third list (spec 2026-09-01 §8.6); the mouse
  // recipe must stay identical to the key one (App's reviewRowPress).
  it("review: click a chat draft row twice to open its preview", async () => {
    const chatDraft = {
      id: "acme__api-20260901-1",
      key: "acme/api",
      slug: "acme__api",
      kind: "ticket" as const,
      files: [
        {
          name: "add-cache.md",
          content: "Cache the index.",
          lint: [],
          route: null,
          droppedKeys: [],
        },
      ],
      cwd: "/repos/acme/api",
      nwo: "acme/api",
      createdAt: "2026-07-09T00:00:00.000Z",
      lintFailed: false,
      blocked: null,
      routeOverride: "auto" as const,
      commandArgs: null,
    };
    const client = {
      ...stubClient,
      listReview: async () => okv([batch1]),
      listChatDrafts: async () => okv([chatDraft]),
    };
    const r = renderApp({ client });
    await until(() => (r.lastFrame() ?? "").includes("repos"));
    r.stdin.write("v");
    await until(() => (r.lastFrame() ?? "").includes("add-cache"));
    const x = 5;
    const y = lineOf(r.lastFrame() ?? "", "add-cache");
    // First press moves the cursor off the batch onto the chat draft row.
    await fireUntil(
      r.stdin,
      press(x, y),
      () => (r.lastFrame() ?? "").split("\n")[y]?.includes("▌") ?? false,
    );
    // Second press opens the preview (which unmounts the list — self-terminating).
    await fireUntil(r.stdin, press(x, y), () =>
      (r.lastFrame() ?? "").includes("s submit · e edit · r route"),
    );
    expect(r.lastFrame()).toContain("Cache the index.");
  });
});

describe("footer chips: mouse", () => {
  it("footer chip: clicking the 'queue' mnemonic jumps to the queue row and focuses its body", async () => {
    const r = renderApp();
    // Mount lands on pane 1 (rail), whose ACTIONS row carries the bare "queue"
    // label (mnemonic char colored — invisible in stripped frames).
    await until(() => rowAt(r.lastFrame() ?? "", actionsY(r.lastFrame() ?? "")).includes("queue"));
    const f = r.lastFrame() ?? "";
    const y = actionsY(f);
    const x = rowAt(f, y).indexOf("queue");
    // fireUntil: a press racing the region registry re-sends; the action is
    // idempotent (re-selecting the queue row is a no-op).
    await fireUntil(r.stdin, press(x, y), () => (r.lastFrame() ?? "").includes("running"));
    // The chip parked the cursor on the queue system row + focused its body,
    // whose navigate row is the queue vocabulary (⏎ transcript · ← rail).
    await until(() =>
      /⏎ {2}transcript/.test(rowAt(r.lastFrame() ?? "", navigateY(r.lastFrame() ?? ""))),
    );
  });

  // Restored with Task 3's two-row Footer (Ruling R4): the navigate row
  // renders pane 3's structural `⏎ detail` again, and App's
  // structuralChipActions keys structural chips by their KEY string — which IS
  // FooterChip.id — so the click runs the very recipe enter does.
  it("pane 3 focused: the '⏎ detail' chip opens the PR overlay, not the issue detail", async () => {
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
    const r = renderApp({ client });
    await until(() => (r.lastFrame() ?? "").includes("#100")); // PR row loaded in pane 3
    r.stdin.write("\u001b[C"); // → pane 2
    r.stdin.write("\u001b[C"); // → pane 3 (wide layout)
    // Pane 3's rows: `⏎ detail` on the navigate row (pane 1 has it too, but
    // pane 1's ACTIONS row carries "add repo" and pane 3's never does; pane 2
    // says `⏎ preview` instead), so the pair identifies pane 3 exactly.
    await until(() => {
      const f = r.lastFrame() ?? "";
      return (
        !rowAt(f, actionsY(f)).includes("add repo") && /⏎ {2}detail/.test(rowAt(f, navigateY(f)))
      );
    });
    const f = r.lastFrame() ?? "";
    const y = navigateY(f);
    const x = rowAt(f, y).search(/⏎ {2}detail/);
    // Landing opens the PR overlay (unmounts the chip row's main-view set, so
    // the retry self-terminates); the issue-detail overlay would say
    // "preview · #1" instead — assert the PR one specifically.
    await fireUntil(r.stdin, press(x, y), () => (r.lastFrame() ?? "").includes("pr · #100"));
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
    const r = renderApp({ client });
    await until(() => (r.lastFrame() ?? "").includes("repos"));
    const f = r.lastFrame() ?? "";
    const y = actionsY(f);
    const x = rowAt(f, y).indexOf("browser"); // pane-1 actions row at mount
    await fireUntil(r.stdin, press(x, y), () => repoOpens === 1); // counted-once = idempotent-safe
    expect(repoOpens).toBe(1);
    expect(issueOpens).toBe(0); // the old flat map would have opened the issue here
  });

  it("pane 2: the 'n investigate' chip drafts an analysis for the selected issue", async () => {
    let analyzeCalls = 0;
    const client = {
      ...stubClient,
      analyzeIssue: async () => {
        analyzeCalls++;
        return okv({ id: "analyze-acme-api-1" });
      },
    };
    const r = renderApp({ client });
    await until(() => (r.lastFrame() ?? "").includes("repos"));
    r.stdin.write("l"); // pane 2 — the only chip row carrying "investigate"
    await until(() => (r.lastFrame() ?? "").includes("investigate"));
    const f = r.lastFrame() ?? "";
    const y = actionsY(f);
    const x = rowAt(f, y).indexOf("investigate");
    await fireUntil(r.stdin, press(x, y), () => analyzeCalls === 1); // counted-once = idempotent-safe
    expect(analyzeCalls).toBe(1);
    // The keyboard recipe's success toast lands once the stubbed promise
    // resolves — same copy, proving the chip ran the verbatim branch.
    await until(() =>
      (r.lastFrame() ?? "").includes("investigation queued: analyze-acme-api-1 · v to review"),
    );
  });

  // In-memory log source (tuiLogOverlay's fixture, inlined): the overlay only
  // needs one line to prove it mounted.
  const oneLineLogFs = (): LogReaderDeps => {
    const content = Buffer.from(
      JSON.stringify({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "seed-h" }) + "\n",
      "utf8",
    );
    return {
      existsFn: () => true,
      statFn: () => ({ size: content.length }),
      openFn: () => 1,
      closeFn: () => undefined,
      readFn: (_fd: number, buf: Buffer, _off: number, len: number, pos: number) => {
        const slice = content.subarray(pos, pos + len);
        slice.copy(buf, 0);
        return slice.length;
      },
    };
  };

  const HELP_TITLE = "junco dashboard — keys";

  /** The log overlay open with the help modal over it — the one state where a
   * modal is up AND the footer below it still renders the OVERLAY's rows
   * (`logOverlay` wins over `view` in both useFooterBindings and App's
   * actionHandlers). Mounted at 100 columns exactly, because
   * ink-testing-library's stdout is fixed at 100 and on a wider frame the right
   * edge — where the pinned chips live — no longer lines up with the real yoga
   * columns the hit-test resolves against; and at 60 rows, because HelpModal is
   * ~45 rows tall and on the suite's usual 30-row terminal it pushes the footer
   * clean off the frame entirely (nothing to click, and nothing to prove). */
  const helpOverLogOverlay = async () => {
    const r = renderApp({
      sizeOverride: { columns: 100, rows: 60 },
      logReaderDeps: oneLineLogFs(),
      logsPollMs: 15,
    });
    await until(() => (r.lastFrame() ?? "").includes("repos"));
    // G parks the rail cursor on the last row (logs); resend is idempotent.
    await fireUntil(r.stdin, "G", () => (r.lastFrame() ?? "").includes("seed-h"));
    // Enter opens the full-screen overlay; Enter is unbound inside it.
    await fireUntil(r.stdin, "\r", () => (r.lastFrame() ?? "").includes("following"));
    r.stdin.write("?"); // the overlay's own arm dispatches help (Ruling R5)
    await until(() => (r.lastFrame() ?? "").includes(HELP_TITLE));
    return r;
  };

  /** Press a footer cell repeatedly, but ONLY while the help modal is still up
   * — pressUntilAdvanced's rationale in mouse form. A press can race a region
   * registration and be dropped for good, so it must be resendable; but under
   * R6 the landing press is a MISS that closes the modal, after which the very
   * same cell is a LIVE chip again, so a stray retry would dispatch for real.
   * Gating each resend on the modal still showing makes both safe. */
  const pressUntilHelpCloses = async (
    r: { stdin: { write: (s: string) => void }; lastFrame: () => string | undefined },
    x: number,
    y: number,
  ) => {
    for (let i = 0; i < 50 && (r.lastFrame() ?? "").includes(HELP_TITLE); i++) {
      r.stdin.write(press(x, y));
      await tick();
    }
    await until(() => !(r.lastFrame() ?? "").includes(HELP_TITLE));
  };

  /** Column of `needle` on the footer's navigate row (last frame line). */
  const navCell = (frame: string, needle: string): [number, number] => {
    const y = navigateY(frame);
    return [rowAt(frame, y).indexOf(needle), y];
  };

  // Regression (fix round 1, re-pointed by Ruling R6 in round 2): help opened
  // from the LOG OVERLAY is the one state where the modal is up and the footer
  // below it still renders a live-looking `? help` chip. Clicking it used to
  // call openHelp with view === "help", re-arming the origin to "help" itself —
  // after which any-key close and onMouseMiss both re-opened help and the
  // dashboard was stuck until Ctrl-C. Two independent things now prevent that:
  // R6 makes every footer chip inert while a modal is open (so the press is a
  // plain MISS, which onMouseMiss turns into a close-back-to-origin), and
  // openHelp refuses to run at all while view === "help".
  it("help over the log overlay: clicking its own '? help' chip closes help, never traps", async () => {
    const r = await helpOverLogOverlay();
    const [x, y] = navCell(r.lastFrame() ?? "", "? help");
    expect(x).toBeGreaterThan(0);
    await pressUntilHelpCloses(r, x, y);
    // Closed back to its ORIGIN: the log overlay, still open behind it.
    await until(() => (r.lastFrame() ?? "").includes("following"));
    // And the origin was never re-armed to "help": re-open, close by key, and
    // it is the overlay again rather than the modal re-appearing.
    r.stdin.write("?");
    await until(() => (r.lastFrame() ?? "").includes(HELP_TITLE));
    r.stdin.write("x"); // any key closes
    await until(() => !(r.lastFrame() ?? "").includes(HELP_TITLE));
    await until(() => (r.lastFrame() ?? "").includes("following"));
    r.stdin.write(ESC); // and the overlay still closes normally
    await until(() => !(r.lastFrame() ?? "").includes("following"));
  });

  // Ruling R6, the general case: a modal owns the pointer. `q close` is the
  // sharpest probe — it is the log overlay's OWN close verb, so if the chip
  // still dispatched under the modal the overlay would shut behind it and
  // `following` would be gone the moment help closed.
  it("help over the log overlay: a footer chip press under the modal never dispatches", async () => {
    const r = await helpOverLogOverlay();
    const [x, y] = navCell(r.lastFrame() ?? "", "q close");
    expect(x).toBeGreaterThan(0);
    await pressUntilHelpCloses(r, x, y);
    // The press reached onMouseMiss, not logOverlayActions.close: the overlay
    // is still open. (Pre-R6 this closed it — `following` would be absent.)
    await until(() => (r.lastFrame() ?? "").includes("following"));
    expect(r.lastFrame() ?? "").toContain("level ≥ info"); // overlay state intact
    r.stdin.write(ESC); // and the overlay still closes on its own key
    await until(() => !(r.lastFrame() ?? "").includes("following"));
  });

  it("help modal: a footer press underneath is a miss — closes help, never quits", async () => {
    let exited = false;
    const r = renderApp({ onExit: () => (exited = true) });
    await until(() => ((r.lastFrame() ?? "").split("\n").at(-1) ?? "").includes("quit"));
    r.stdin.write("?");
    await until(() => (r.lastFrame() ?? "").includes("junco dashboard"));
    // While help is open the hints swap to the modal's own set ("any key
    // close") with NO live chips: a press on the footer band hits no region
    // and falls through to onMouseMiss("help"), which closes the modal —
    // exactly "any key closes help", never a quit.
    const f = r.lastFrame() ?? "";
    const footerY = f.split("\n").length - 1;
    r.stdin.write(press(4, footerY));
    await until(() => !(r.lastFrame() ?? "").includes("junco dashboard"));
    expect(exited).toBe(false);
  });
});
