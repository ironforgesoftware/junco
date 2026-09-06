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
import {
  renderApp,
  makeAppProps,
  okv,
  stubClient,
  tap,
  ESC,
  TO_QUEUE_ROW,
  WIDE_COLS_TEST,
} from "./helpers/localFixtures.js";
import type { LogReaderDeps } from "../src/logReader.js";
import { App } from "../src/tui/App.js";
import { MouseContext, MouseProvider } from "../src/tui/MouseProvider.js";
import type { MouseStore } from "../src/tui/mouseRegions.js";
import type { PendingAssess } from "../src/assessReview.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { ChatSubscribeHandlers } from "../src/tui/chatClient.js";
import { summarizeTranscript } from "../src/transcriptSummary.js";
import {
  chatCommand,
  chatPrompt,
  chatTurnEnd,
  chatTurnStart,
  runEnd,
  runStart,
  turnEndFull,
} from "./helpers/transcriptFixtures.js";

afterEach(cleanup);

// SGR mouse sequences at 0-based cell (x,y): ESC [ < b ; col ; row M, cols/rows
// 1-based on the wire. b=0 press, b=35 button-less motion (hover), b=65
// wheel-down. `\u001b` (not a raw ESC byte) so file edits never drop it.
const press = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;
const move = (x: number, y: number): string => `\u001b[<35;${x + 1};${y + 1}M`;
const wheelDown = (x: number, y: number): string => `\u001b[<65;${x + 1};${y + 1}M`;
const wheelUp = (x: number, y: number): string => `\u001b[<64;${x + 1};${y + 1}M`;
// b=32 is left-button motion (a drag); the lowercase `m` terminator is release.
const drag = (x: number, y: number): string => `\u001b[<32;${x + 1};${y + 1}M`;
const release = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}m`;

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

// The scrollbar is a mouse target on both transcript surfaces (chat + ticket
// transcript): press a track row to jump there, hold and drag to keep
// scrolling. Geometry, at the fixture's 120×30: the view is full-screen, so
// its content spans x 2..117 after the border + paddingX — the 1-column bar is
// the LAST content column, x=117. Vertically, row 0 is the header, the view's
// top border is row 1, its own header row 2, and the body (hence the track)
// starts at row 3.
const BAR_X = WIDE_COLS_TEST - 3;
const TRACK_TOP = 3;
/** Chat: height 27 − borders 2 − header 1 − composer 6 = 18 rows. (#471 took
 *  the in-pane hint row out; chatVisibleRows reserves 3 + composer now.) */
const CHAT_TRACK_BOTTOM = TRACK_TOP + 18 - 1;

/** A chat client whose subscribe handler is kept so a test can feed records. */
function chatClient(): { client: DashboardClient; push: (offset: number, line: string) => void } {
  let h: ChatSubscribeHandlers | null = null;
  return {
    client: {
      ...stubClient,
      chat: {
        ...stubClient.chat,
        subscribe: (_k, _s, on) => ((h = on), on.status("live"), () => {}),
      },
    },
    push: (o, l) => h!.record(o, l),
  };
}

/** `n` chat turns, each one prompt row (`you: L07`) plus its run header. */
function pushTurns(push: (offset: number, line: string) => void, n: number): void {
  let offset = 10;
  for (let i = 1; i <= n; i++) {
    push(offset++, chatPrompt({ text: `L${String(i).padStart(2, "0")}` }));
    push(offset++, chatTurnStart());
    push(offset++, chatTurnEnd());
  }
}

/** The open chat view, already scrolled to the tail by `follow`. */
async function openChatWithTurns(): Promise<ReturnType<typeof renderApp>> {
  const c = chatClient();
  const r = renderApp({ client: c.client });
  await until(() => (r.lastFrame() ?? "").includes("repos"));
  await fireUntil(r.stdin, "c", () => (r.lastFrame() ?? "").includes("chat · acme/api"));
  pushTurns(c.push, 20); // ~60 rows in a 17-row window
  await until(() => (r.lastFrame() ?? "").includes("you: L20"));
  return r;
}

describe("scrollbar: click and drag", () => {
  it("chat: a press on the track jumps the window (pausing follow); a drag keeps scrolling", async () => {
    const r = await openChatWithTurns();
    // Top of the track = offset 0. It only sticks because the jump pauses
    // follow: still following, the window would snap back to the tail.
    await fireUntil(r.stdin, press(BAR_X, TRACK_TOP), () =>
      (r.lastFrame() ?? "").includes("you: L01"),
    );
    // Still holding, drag to the bottom of the track: the window follows the
    // pointer down to the end of the transcript.
    await fireUntil(r.stdin, drag(BAR_X, CHAT_TRACK_BOTTOM), () =>
      (r.lastFrame() ?? "").includes("you: L20"),
    );
  });

  // MouseProvider dispatches every event in a chunk synchronously, so a fast
  // two-notch wheel-up from the tail runs the pause recipe twice against the
  // same render: without the latch each notch landed at the tail again and
  // the burst netted one row.
  it("chat: a two-notch wheel-up in one chunk pauses once and scrolls two rows", async () => {
    const r = await openChatWithTurns();
    const range = (): RegExpExecArray | null => /(\d+)–(\d+)\/(\d+)/.exec(r.lastFrame() ?? "");
    await until(() => range() !== null);
    const total = range()![3]!;
    expect(range()![2]).toBe(total); // at the tail
    r.stdin.write(wheelUp(40, 8) + wheelUp(40, 8));
    await until(() => range()?.[2] === String(Number(total) - 2));
  });

  it("chat: a drag that never pressed the bar scrolls nothing", async () => {
    const r = await openChatWithTurns();
    await fireUntil(r.stdin, press(BAR_X, TRACK_TOP), () =>
      (r.lastFrame() ?? "").includes("you: L01"),
    );
    r.stdin.write(release(BAR_X, TRACK_TOP));
    // Motion with the button held but no press of our own: no capture, so the
    // window must not move. Negative assertion ⇒ a bounded window to misbehave.
    r.stdin.write(drag(BAR_X, CHAT_TRACK_BOTTOM));
    await new Promise((res) => setTimeout(res, 60));
    expect(r.lastFrame() ?? "").toContain("you: L01");
  });

  it("transcript: a press on the track jumps the window", async () => {
    const summary = summarizeTranscript(
      Array.from({ length: 20 }, (_, i) => [
        runStart({ flow: "assess", modelId: "m" }),
        turnEndFull({ text: `T${String(i + 1).padStart(2, "0")}` }),
        runEnd({ stopReason: "stop", durationMs: 1000 }),
      ]).flat(),
    );
    const client: DashboardClient = {
      ...stubClient,
      readTranscript: async () => okv({ kind: "read" as const, size: 1, summary }),
    };
    const r = renderApp({ client });
    await until(() => (r.lastFrame() ?? "").includes("repos"));
    await tap(r, TO_QUEUE_ROW); // rail → the queue system row
    await until(() => (r.lastFrame() ?? "").includes("sub-fix-typos"));
    await fireUntil(r.stdin, "l", () => (r.lastFrame() ?? "").includes("retry"));
    await fireUntil(r.stdin, "\r", () => (r.lastFrame() ?? "").includes("transcript ▸"));
    // A queue row's transcript opens live-and-following, i.e. at the tail.
    await until(() => (r.lastFrame() ?? "").includes("T20"));
    // The track's top row is offset 0 — and it sticks, so the jump paused
    // follow here too (the transcript's own wheel-up recipe).
    await fireUntil(r.stdin, press(BAR_X, TRACK_TOP), () => {
      const f = r.lastFrame() ?? "";
      return f.includes("T01") && !f.includes("T20");
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
  // Spec 2026-09-03 §4.3: the junco_submit card's y/n are the ONE structural
  // chip recipe the chat view has (App's structuralChipActions) — a mouse
  // user has no other way to answer a waiting confirmation.
  it("chat: clicking the 'n keep parked' chip POSTs the decline", async () => {
    const decisions: string[] = [];
    const c = chatClient();
    c.client.chat.decide = async (_k, id, d) => (
      decisions.push(`${id}:${d}`),
      okv({ settled: true })
    );
    const r = renderApp({ client: c.client });
    await until(() => (r.lastFrame() ?? "").includes("repos"));
    await fireUntil(r.stdin, "c", () => (r.lastFrame() ?? "").includes("chat · acme/api"));
    c.push(10, chatPrompt({ text: "submit it" }));
    c.push(20, chatTurnStart());
    c.push(30, chatCommand({ status: "proposed" }));
    // The footer's actions row is the chatConfirm one once the card lands.
    await until(() => rowAt(r.lastFrame() ?? "", actionsY(r.lastFrame() ?? "")).includes("parked"));
    const f = r.lastFrame() ?? "";
    const y = actionsY(f);
    const x = rowAt(f, y).indexOf("keep parked");
    await fireUntil(r.stdin, press(x, y), () => decisions.length > 0);
    expect(decisions[0]).toBe("call_1:decline");
  });

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

  it("pane 1 (mount default): the 'b browser' chip opens the REPO, never the selected issue", async () => {
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

  /** The log overlay open with the help modal over it. Mounted at 100 columns
   * exactly, because ink-testing-library's stdout is fixed at 100 and on a
   * wider frame the right edge — where the pinned chips live — no longer lines
   * up with the real yoga columns the hit-test resolves against; and at 60
   * rows, because HelpModal is ~45 rows tall and on the suite's usual 30-row
   * terminal it pushes the footer clean off the frame entirely (nothing to
   * click, and nothing to prove). Returns the overlay's OWN navigate row as it
   * read before `?` — the columns its chips occupied, which is what the
   * "click where a chip used to be" probes need. */
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
    const overlayNav = rowAt(r.lastFrame() ?? "", navigateY(r.lastFrame() ?? ""));
    r.stdin.write("?"); // the overlay's own arm dispatches help (Ruling R5)
    await until(() => (r.lastFrame() ?? "").includes(HELP_TITLE));
    return { r, overlayNav };
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

  // Regression (fix round 1, re-pointed by Ruling R6' in round 3). The trap:
  // help opened from the LOG OVERLAY used to derive the OVERLAY's binding
  // context — `logOverlay` won over `view` in useFooterBindings — so the footer
  // under the modal rendered the overlay's live chips, `? help` among them.
  // Clicking that called openHelp with view === "help", re-arming the origin to
  // "help" itself, after which any-key close and onMouseMiss both re-opened
  // help: stuck until Ctrl-C. R6' fixes it at the root — under the modal the
  // footer is HELP's own context (`any key close`, empty keymap) — and
  // openHelp's guard stays as defence in depth.
  it("help over the log overlay: the footer is help's own, and a press on it closes back to the overlay", async () => {
    const { r } = await helpOverLogOverlay();
    const f = r.lastFrame() ?? "";
    const y = navigateY(f);
    const nav = rowAt(f, y);
    // The overlay's chips are gone with its context — nothing here dispatches.
    expect(nav).toContain("any key");
    expect(nav).not.toContain("? help");
    expect(nav).not.toContain("q close");
    // So a press anywhere on the footer is a MISS, which onMouseMiss turns
    // into a close back to the ORIGIN: the log overlay, still open behind it.
    await pressUntilHelpCloses(r, 4, y);
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

  // The same guarantee aimed at the sharpest cell on the row: where the
  // overlay's OWN close verb sat a moment ago. If anything of the overlay's
  // context survived under the modal, this press would shut the overlay behind
  // it and `following` would be gone the moment help closed.
  it("help over the log overlay: pressing where 'q close' used to be is a miss, not a close", async () => {
    const { r, overlayNav } = await helpOverLogOverlay();
    const x = overlayNav.indexOf("q close");
    expect(x).toBeGreaterThan(0);
    await pressUntilHelpCloses(r, x, navigateY(r.lastFrame() ?? ""));
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

  // #461: the navigate row renders `:  palette` and `→  issues` as keycaps,
  // but App's structuralChipActions `main` recipe only mapped `,`, `←`, `/`
  // and `enter` — so both were inert to the mouse. The palette in particular
  // had mouse reach through the `c commands` mnemonic chip until #457 retired
  // it, so this is a regression, not a gap.
  it("navigate row: the ':  palette' chip opens the palette, filter reset", async () => {
    const r = renderApp();
    await until(() =>
      /: {2}palette/.test(rowAt(r.lastFrame() ?? "", navigateY(r.lastFrame() ?? ""))),
    );
    // Leave a stale filter behind first: the chip must run the KEY's whole
    // recipe (resetPalette included), not just the view switch.
    r.stdin.write(":");
    await until(() => (r.lastFrame() ?? "").includes("run a junco command"));
    await tap(r, "doctor");
    await until(() => !(r.lastFrame() ?? "").includes("status"));
    r.stdin.write(ESC);
    await until(() => !(r.lastFrame() ?? "").includes("run a junco command"));

    const f = r.lastFrame() ?? "";
    const y = navigateY(f);
    const x = rowAt(f, y).search(/: {2}palette/);
    expect(x).toBeGreaterThan(0);
    // Opening swaps the footer to the palette's own structuralOnly vocabulary,
    // so a retried press lands nowhere — self-terminating.
    await fireUntil(r.stdin, press(x, y), () =>
      (r.lastFrame() ?? "").includes("run a junco command"),
    );
    expect(r.lastFrame() ?? "").toContain("status"); // unfiltered list
  });

  // #488: on pane 2 the wide layout renders ONE combined cap for both
  // directions (`s("←/→", "panes")`, footerModel's mainBodyNav) instead of the
  // separate `←`/`→` caps #461 wired up. Its dispatch id is `←/→` — which
  // structuralChipActions never mapped — while the FRAME shows the glyph
  // `←→` (footerModel's GLYPHS), hence the two spellings here. One cap, one
  // direction: forward with wrap, the recipe `tab` already runs, so the chip
  // and the key cannot drift.
  it("pane 2: the '←→  panes' chip advances a pane, wrapping like tab", async () => {
    const r = renderApp();
    await until(() =>
      /→ {2}issues/.test(rowAt(r.lastFrame() ?? "", navigateY(r.lastFrame() ?? ""))),
    );
    r.stdin.write("l"); // pane 2 — the only pane drawing the combined cap
    await until(() =>
      /←→ {2}panes/.test(rowAt(r.lastFrame() ?? "", navigateY(r.lastFrame() ?? ""))),
    );

    const f = r.lastFrame() ?? "";
    const y = navigateY(f);
    const x = rowAt(f, y).search(/←→ {2}panes/);
    expect(x).toBeGreaterThan(0);
    // Pane 3's navigate row is its own vocabulary (`← issues`, no `panes`
    // cap), so the landing unmounts the chip at that x — the retry
    // self-terminates rather than cycling on to pane 1.
    await fireUntil(r.stdin, press(x, y), () =>
      /← {2}issues/.test(rowAt(r.lastFrame() ?? "", navigateY(r.lastFrame() ?? ""))),
    );
  });

  it("pane 1: the '→  issues' chip focuses the issues pane", async () => {
    const r = renderApp();
    await until(() =>
      /→ {2}issues/.test(rowAt(r.lastFrame() ?? "", navigateY(r.lastFrame() ?? ""))),
    );
    const f = r.lastFrame() ?? "";
    const y = navigateY(f);
    const x = rowAt(f, y).search(/→ {2}issues/);
    expect(x).toBeGreaterThan(0);
    // Pane 2's navigate row says `⏎ preview` where pane 1 says `⏎ detail`, so
    // the vocabulary swap IS the focus move. Idempotent once focus has landed:
    // the chip at that x is gone, so a retried press hits nothing.
    await fireUntil(r.stdin, press(x, y), () =>
      /⏎ {2}preview/.test(rowAt(r.lastFrame() ?? "", navigateY(r.lastFrame() ?? ""))),
    );
  });
});
