/**
 * A held navigation key under load reaches ink as ONE stdin chunk ("jjj").
 * useGuardedInput replays the run press by press, and every list mover
 * resolves from the PENDING state, so the presses compose instead of all
 * landing on the same pre-press index (the "one step per chunk" tail of the
 * same bug). Each write below is a single chunk on purpose — the opposite of
 * localFixtures' `tap`, which spaces keys out to avoid exactly this.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup } from "ink-testing-library";
import { renderApp, ISSUES, okv, stubClient, HEAVY, tap } from "./helpers/localFixtures.js";
import { until, fireUntil } from "./helpers/until.js";
import { summarizeTranscript } from "../src/transcriptSummary.js";
import { runEnd, runStart, turnEndFull } from "./helpers/transcriptFixtures.js";

afterEach(cleanup);

type R = ReturnType<typeof renderApp>;
const frame = (r: R): string => r.lastFrame() ?? "";
const selOn = (r: R, text: string): boolean =>
  frame(r)
    .split("\n")
    .some((l) => l.includes(text) && l.includes("▌"));

describe("held navigation keys (one stdin chunk)", () => {
  it("jj on the rail as one chunk lands on the queue row", async () => {
    const r = renderApp();
    await until(() => frame(r).includes("system"));
    r.stdin.write("jj"); // acme/api → beta/two → queue, in one chunk
    await until(() => frame(r).includes("sub-fix-typos")); // the queue body is up
    expect(selOn(r, "queue")).toBe(true);
  });

  it("jj on the issue list as one chunk moves two rows, not one", async () => {
    const issues = [
      ...ISSUES,
      {
        number: 3,
        title: "Third issue",
        labels: ["junco"],
        updatedAt: "2026-07-06T08:00:00Z",
        url: "https://github.com/acme/api/issues/3",
        author: null,
      },
    ];
    const r = renderApp({
      client: { ...stubClient, listIssues: async () => okv({ issues, staleAt: null }) },
    });
    await until(() => frame(r).includes("Third issue"));
    r.stdin.write("l"); // pane 2 — the issue list
    await until(() => selOn(r, "First issue"));
    r.stdin.write("jj");
    await until(() => selOn(r, "Third issue"));
    expect(selOn(r, "Second issue")).toBe(false);
  });

  // The replay's one hazard: a confirm answered by a run. `confirm` is the same
  // open modal for every replay of the closure, so without a latch "yy" would
  // fire onConfirm twice — here that second call would surface as the
  // in-flight guard's "already running" toast; elsewhere (the bot-grant
  // confirm) it would simply run twice.
  it("yy on a destructive confirm as one chunk confirms exactly once", async () => {
    const calls: [string, string[]][] = [];
    const r = renderApp({
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        await new Promise((res) => setTimeout(res, 50)); // stays in flight past the second y
        return { code: 0, output: "removed", timedOut: false };
      },
    });
    await until(() => frame(r).includes("system"));
    await tap(r, "jj"); // rail → queue
    await until(() => frame(r).includes("sub-fix-typos"));
    r.stdin.write("l");
    await until(() => selOn(r, "#1 exec"));
    r.stdin.write("j");
    await until(() => selOn(r, "sub-fix-typos"));
    r.stdin.write("D");
    await until(() => frame(r).toLowerCase().includes("delete"));
    r.stdin.write("yy");
    await until(() => calls.length === 1);
    await until(() => !frame(r).toLowerCase().includes("delete"));
    expect(frame(r)).not.toContain("already running");
    expect(calls).toEqual([["rm", ["sub-fix-typos"]]]);
  });

  // The follow-pausing scroll key: `[` on a followed transcript lands at the
  // tail (an absolute offset) before stepping, so a replayed "[[" must pause
  // ONCE and then step twice — not land at the tail twice and net one row.
  it("[[ on a followed transcript as one chunk pauses once and scrolls two rows", async () => {
    const summary = summarizeTranscript(
      Array.from({ length: 20 }, (_, i) => [
        runStart({ flow: "assess", modelId: "m" }),
        turnEndFull({ text: `T${String(i + 1).padStart(2, "0")}` }),
        runEnd({ stopReason: "stop", durationMs: 1000 }),
      ]).flat(),
    );
    const r = renderApp({
      client: {
        ...stubClient,
        readTranscript: async () => okv({ kind: "read" as const, size: 1, summary }),
      },
    });
    await until(() => frame(r).includes("system"));
    await tap(r, "jj"); // rail → queue
    await until(() => frame(r).includes("sub-fix-typos"));
    await fireUntil(r.stdin, "l", () => frame(r).includes("retry"));
    await fireUntil(r.stdin, "\r", () => frame(r).includes("transcript ▸"));
    const range = (): RegExpExecArray | null => /(\d+)–(\d+)\/(\d+)/.exec(frame(r));
    await until(() => range() !== null && range()![2] === range()![3]); // following the tail
    const total = range()![3]!;
    r.stdin.write("[[");
    await until(() => range()?.[2] === String(Number(total) - 2));
  });

  it("jj in a system body as one chunk moves two rows", async () => {
    const wt = HEAVY.worktrees[0];
    const r = renderApp({
      localHeavyFn: async () => ({
        ...HEAVY,
        worktrees: ["wt-alpha", "wt-bravo", "wt-charlie"].map((slug) => ({
          ...wt,
          path: `/w/acme-api/${slug}`,
          slug,
        })),
      }),
    });
    await until(() => frame(r).includes("system"));
    await tap(r, "jjjj"); // rail → worktrees
    await until(() => frame(r).includes("wt-charlie"));
    r.stdin.write("l"); // enter the body
    await until(() => selOn(r, "wt-alpha"));
    r.stdin.write("jj");
    await until(() => selOn(r, "wt-charlie"));
  });
});
