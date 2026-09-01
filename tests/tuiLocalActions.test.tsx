// Section-body spawned actions: each fires the real junco CLI via runCliFn and
// toasts, deduped in-flight. Fixtures/renderApp are shared from ./helpers.
//
// State-dependent keystrokes are separated by `await until(<marker>)`, never
// fired as a synchronous burst: ink runs useInput against the last committed
// render, so a second key issued before React commits would see a stale
// closure. Markers: section-body content for the rail move, the body footer
// ("back") for rail→body focus, and the ▌ selection glyph for the row.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup } from "ink-testing-library";
import type { LocalCheap, LocalHeavy } from "../src/tui/localSnapshot.js";
import { until } from "./helpers/until.js";
import {
  renderApp,
  stubClient,
  okv,
  CHEAP,
  HEAVY,
  TO_QUEUE_ROW,
  TO_OUTBOX_ROW,
  TO_WORKTREES_ROW,
  TO_DAEMON_ROW,
  tap,
} from "./helpers/localFixtures.js";

afterEach(cleanup);

type R = ReturnType<typeof renderApp>;
const frame = (r: R): string => r.lastFrame() ?? "";
/** True when SOME frame line carries both `text` and the ▌ cursor glyph — i.e.
 * the row bearing `text` is the selected one. `.some` (not `.find`) so an
 * unselected header line that also mentions the repo nwo never masks it. */
const selOn = (r: R, text: string): boolean =>
  frame(r)
    .split("\n")
    .some((l) => l.includes(text) && l.includes("▌"));

describe("section actions spawn the real CLI (fire-and-toast)", () => {
  it("R on a failed RECENT row → junco retry <name>", async () => {
    const calls: [string, string[]][] = [];
    const r = renderApp({
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "requeued gh-acme-api-9", timedOut: false };
      },
    });
    await until(() => frame(r).includes("system"));
    await tap(r, TO_QUEUE_ROW); // rail → queue system row
    await until(() => frame(r).includes("sub-fix-typos")); // queue body up
    r.stdin.write("l"); // enter body
    await until(() => frame(r).includes("back")); // body focus (footer)
    // The three selectable queue rows are RUNNING, then WAITING, then failed
    // RECENT. Cursor starts on the RUNNING row (index 0); move down twice onto
    // the failed RECENT row (its label is the github-derived "#9 exec", not the
    // raw ticket id).
    r.stdin.write("j");
    await until(() => selOn(r, "sub-fix-typos"));
    r.stdin.write("j");
    await until(() => selOn(r, "#9"));
    r.stdin.write("y"); // re[t]ry mnemonic now derives to y (t is excluded, #330)
    await until(() => calls.length === 1);
    expect(calls[0]).toEqual(["retry", ["gh-acme-api-9"]]);
  });

  it("x on a WAITING inbox row confirms, then y spawns junco rm <name>", async () => {
    const calls: [string, string[]][] = [];
    const r = renderApp({
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "removed", timedOut: false };
      },
    });
    await until(() => frame(r).includes("system"));
    await tap(r, TO_QUEUE_ROW);
    await until(() => frame(r).includes("sub-fix-typos"));
    r.stdin.write("l"); // enter body — cursor starts on the RUNNING row
    await until(() => selOn(r, "#1 exec"));
    r.stdin.write("j"); // down onto the WAITING row
    await until(() => selOn(r, "sub-fix-typos")); // cursor on the WAITING row
    r.stdin.write("D"); // guarded Delete mnemonic — opens confirm (destructive)
    await until(() => frame(r).toLowerCase().includes("delete"));
    expect(calls).toHaveLength(0); // nothing spawned before confirm
    r.stdin.write("y");
    await until(() => calls.length === 1);
    expect(calls[0]).toEqual(["rm", ["sub-fix-typos"]]);
  });

  it("confirm-cancel (n) spawns nothing", async () => {
    const calls: [string, string[]][] = [];
    const r = renderApp({
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "", timedOut: false };
      },
    });
    await until(() => frame(r).includes("system"));
    await tap(r, TO_QUEUE_ROW);
    await until(() => frame(r).includes("sub-fix-typos"));
    r.stdin.write("l"); // enter body — cursor starts on the RUNNING row
    await until(() => selOn(r, "#1 exec"));
    r.stdin.write("j"); // down onto the WAITING row
    await until(() => selOn(r, "sub-fix-typos"));
    r.stdin.write("D");
    await until(() => frame(r).toLowerCase().includes("delete"));
    r.stdin.write("n");
    await new Promise((res) => setTimeout(res, 20));
    expect(calls).toHaveLength(0);
  });

  it("a RUNNING row is selectable (top of the list) but retry is a guarded toast, not a spawn", async () => {
    const calls: unknown[] = [];
    const r = renderApp({
      runCliFn: async () => {
        calls.push(1);
        return { code: 0, output: "", timedOut: false };
      },
    });
    await until(() => frame(r).includes("system"));
    await tap(r, TO_QUEUE_ROW);
    await until(() => frame(r).includes("sub-fix-typos"));
    r.stdin.write("l");
    await until(() => frame(r).includes("back"));
    r.stdin.write("g"); // top selectable row — now the RUNNING row (running ⧺ waiting ⧺ recent)
    await until(() => selOn(r, "#1 exec"));
    r.stdin.write("y"); // re[t]ry mnemonic now derives to y (t is excluded, #330) — guarded no-op on a running row
    await until(() => frame(r).toLowerCase().includes("enter opens its transcript"));
    expect(calls).toHaveLength(0);
  });

  it("outbox f flushes; daemon f/X flush/restart", async () => {
    const calls: [string, string[]][] = [];
    const r = renderApp({
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "flushed 2", timedOut: false };
      },
    });
    await until(() => frame(r).includes("system"));
    await tap(r, TO_OUTBOX_ROW); // rail → outbox system row
    await until(() => frame(r).includes("acme/api#1")); // outbox body up
    r.stdin.write("l"); // enter body
    await until(() => frame(r).includes("back"));
    r.stdin.write("f");
    await until(() => calls.some(([n]) => n === "outbox"));
    expect(calls.find(([n]) => n === "outbox")![1]).toEqual(["flush"]);
  });

  it("worktree x on a stale row confirms → y → junco worktree prune <path>", async () => {
    const calls: [string, string[]][] = [];
    const r = renderApp({
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "pruned", timedOut: false };
      },
    });
    await until(() => frame(r).includes("system"));
    await tap(r, TO_WORKTREES_ROW); // rail → worktrees system row
    await until(() => frame(r).includes("fix-typos")); // worktrees body up
    r.stdin.write("l"); // enter body
    await until(() => selOn(r, "fix-typos")); // cursor on the stale worktree
    r.stdin.write("P"); // guarded Prune mnemonic
    await until(() => frame(r).includes("prune worktree")); // confirm modal open
    r.stdin.write("y");
    await until(() => calls.some(([n]) => n === "worktree"));
    expect(calls.find(([n]) => n === "worktree")![1]).toEqual(["prune", "/w/acme-api/fix-typos"]);
  });

  it("daemon restart confirm body carries the in-flight ticket count", async () => {
    const r = renderApp();
    await until(() => frame(r).includes("system"));
    await tap(r, TO_DAEMON_ROW); // rail → daemon system row
    await until(() => frame(r).includes("4242")); // daemon body up
    r.stdin.write("l"); // enter the daemon body (X is a body action)
    await until(() => frame(r).includes("back"));
    r.stdin.write("R"); // guarded Restart mnemonic
    await until(() => frame(r).includes("in-flight ticket"));
    expect(frame(r)).toMatch(/1 in-flight ticket/); // currentTickets.length === 1
  });

  it("rail o opens the SELECTED row's repo in the browser", async () => {
    const opens: string[] = [];
    const client = {
      ...stubClient,
      openRepoInBrowser: async (nwo: string) => {
        opens.push(nwo);
        return okv(undefined);
      },
    };
    const r = renderApp({ client });
    await until(() => frame(r).includes("system"));
    r.stdin.write("j"); // → beta/two (rail cursor moves off acme/api)
    await until(() => selOn(r, "beta/two"));
    r.stdin.write("b"); // [b]rowser mnemonic
    await until(() => opens.length === 1);
    expect(opens[0]).toBe("beta/two"); // the rail row under the cursor
  });

  it("rail o on a system row is a safe toast, never a browser open", async () => {
    const opens: string[] = [];
    const client = {
      ...stubClient,
      openRepoInBrowser: async (nwo: string) => {
        opens.push(nwo);
        return okv(undefined);
      },
    };
    const r = renderApp({ client });
    await until(() => frame(r).includes("system"));
    await tap(r, TO_QUEUE_ROW); // park on the queue system row
    await until(() => frame(r).includes("sub-fix-typos"));
    r.stdin.write("b"); // [b]rowser mnemonic — the queue-row tap already focused the rail
    await until(() => frame(r).toLowerCase().includes("no github url"));
    expect(opens).toHaveLength(0);
  });
});

// Regression: the `▌` cursor highlight and the x/R action target must be the
// SAME row for EVERY mix of done/failed recent rows and live/stale worktrees.
// The bug was one cursor integer indexing two different lists (the rendered
// list vs. a pre-filtered action list), so the cursor lit one row while the
// action mutated another, non-highlighted, non-confirmed row.
describe("section cursor highlight is aligned with the x/R action target", () => {
  it("queue: a done RECENT row precedes a failed one — highlight == R target, done never retries the failed row", async () => {
    // recent[0] = done (newer), recent[1] = failed (older). With waiting=[],
    // the done row is visual index 0 (where the cursor starts). Under the bug,
    // R here retried the failed row (the rows fn filtered to failed-only) even
    // though the DONE row was highlighted — and the failed row was unreachable.
    const cheap: LocalCheap = {
      ...CHEAP,
      queue: {
        ...CHEAP.queue,
        running: [],
        waiting: [],
        recent: [
          {
            id: "gh-acme-api-7",
            github: { nwo: "acme/api", issue: 7, kind: "pr", external: false },
            status: "done",
            finishedAt: "2026-07-07T10:06:00Z",
            resultStatus: null,
            durationSeconds: null,
            prUrl: null,
            repoPath: null,
          },
          {
            id: "gh-acme-api-8",
            github: { nwo: "acme/api", issue: 8, kind: "pr", external: false },
            status: "failed",
            finishedAt: "2026-07-07T10:04:00Z",
            resultStatus: null,
            durationSeconds: null,
            prUrl: null,
            repoPath: null,
          },
        ],
      },
    };
    const calls: [string, string[]][] = [];
    const r = renderApp({
      localCheapFn: async () => cheap,
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "requeued gh-acme-api-8", timedOut: false };
      },
    });
    await until(() => frame(r).includes("system"));
    await tap(r, TO_QUEUE_ROW);
    await until(() => frame(r).includes("#7")); // queue body up (recent rows)
    r.stdin.write("l"); // enter body
    await until(() => frame(r).includes("back"));
    // Cursor starts on the DONE row (#7, visual index 0) — highlight lands there.
    await until(() => selOn(r, "#7"));
    expect(selOn(r, "#8")).toBe(false); // the failed row is NOT highlighted yet
    // retry while the DONE row is highlighted is a guarded no-op: a toast, and
    // NO spawn — it must NOT retry the (non-highlighted) failed row.
    r.stdin.write("y"); // re[t]ry mnemonic now derives to y (t is excluded, #330)
    await until(() => frame(r).toLowerCase().includes("can't be requeued"));
    expect(calls).toHaveLength(0);
    // Move down onto the FAILED row: highlight follows, and now it IS reachable.
    r.stdin.write("j");
    await until(() => selOn(r, "#8"));
    expect(selOn(r, "#7")).toBe(false);
    // R now retries exactly the highlighted row (#8), never the done row.
    r.stdin.write("y"); // re[t]ry mnemonic now derives to y (t is excluded, #330)
    await until(() => calls.length === 1);
    expect(calls[0]).toEqual(["retry", ["gh-acme-api-8"]]);
  });

  it("worktrees: a live row precedes stale ones — highlight == prune target, a live worktree is never the prune target", async () => {
    // worktrees[0] = live (cursor starts here), [1] and [2] = stale. Under the
    // bug, the rows fn filtered live out, so the cursor lit the live row while
    // x confirmed a prune of a different (stale) row.
    const heavy: LocalHeavy = {
      ...HEAVY,
      worktrees: [
        {
          path: "/w/acme-api/live-one",
          repoPath: "/c/api",
          repoNwo: "acme/api",
          slug: "live-one",
          kind: "live",
          headSha: "aaa1111",
          ageSeconds: 60,
          error: null,
        },
        {
          path: "/w/acme-api/stale-a",
          repoPath: "/c/api",
          repoNwo: "acme/api",
          slug: "stale-a",
          kind: "stale",
          headSha: "bbb2222",
          ageSeconds: 3600,
          error: null,
        },
        {
          path: "/w/acme-api/stale-b",
          repoPath: "/c/api",
          repoNwo: "acme/api",
          slug: "stale-b",
          kind: "stale",
          headSha: "ccc3333",
          ageSeconds: 7200,
          error: null,
        },
      ],
    };
    const calls: [string, string[]][] = [];
    const r = renderApp({
      localHeavyFn: async () => heavy,
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "pruned", timedOut: false };
      },
    });
    await until(() => frame(r).includes("system"));
    await tap(r, TO_WORKTREES_ROW); // rail → worktrees system row
    await until(() => frame(r).includes("live-one")); // worktrees body up
    r.stdin.write("l"); // enter body
    // Cursor starts on the LIVE worktree — highlight lands there.
    await until(() => selOn(r, "live-one"));
    // Prune while the live row is highlighted must NOT open a confirm for any
    // other row — it's a guarded safe toast.
    r.stdin.write("P");
    await until(() => frame(r).toLowerCase().includes("not prunable"));
    expect(frame(r)).not.toContain("prune worktree"); // no confirm modal opened
    expect(calls).toHaveLength(0);
    // Move down onto a STALE worktree: highlight follows.
    r.stdin.write("j");
    await until(() => selOn(r, "stale-a"));
    // Prune now confirms exactly the highlighted worktree (stale-a).
    r.stdin.write("P");
    await until(() => frame(r).includes("prune worktree"));
    r.stdin.write("y");
    await until(() => calls.some(([n]) => n === "worktree"));
    expect(calls.find(([n]) => n === "worktree")![1]).toEqual(["prune", "/w/acme-api/stale-a"]);
  });
});
