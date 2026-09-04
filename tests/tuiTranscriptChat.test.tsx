// #462: `c` from the transcript overlay opened the chat and switched the view
// WITHOUT closing the transcript, so its state — and its live poll — stayed
// alive underneath. The chat's own close returns to `main`, never to the
// transcript, so nothing ever released it: a leaked poller for as long as the
// ticket kept running.
import { describe, it, afterEach, expect } from "vitest";
import { cleanup } from "ink-testing-library";
import { until, wait } from "./helpers/until.js";
import { CHEAP, renderApp, okv, stubClient, tap, TO_QUEUE_ROW } from "./helpers/localFixtures.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { LocalCheap } from "../src/tui/localSnapshot.js";
import { summarizeTranscript } from "../src/transcriptSummary.js";
import { runStart, turnEndFull } from "./helpers/transcriptFixtures.js";

afterEach(cleanup);

// No `run_end`: summarizeTranscript reports `live: true`, which is exactly
// what keeps useTranscript's interval alive — the leak's precondition.
const LIVE = summarizeTranscript([
  runStart({ flow: "pr", modelId: "m" }),
  turnEndFull({ text: "still working" }),
]);

/** Open the RUNNING queue row's transcript (`gh-acme-api-1` in the CHEAP
 * fixture). `repo: false` strips the row's `github`/`repoPath` so the opened
 * transcript has no `repoKey` — the case where `c` has nothing to chat about.
 * Returns a live read counter. */
async function openLiveTranscript(opts: { repo: boolean } = { repo: true }): Promise<{
  r: ReturnType<typeof renderApp>;
  reads: () => number;
}> {
  let reads = 0;
  const client: DashboardClient = {
    ...stubClient,
    readTranscript: async () => {
      reads++;
      return okv({ kind: "read" as const, size: 1, summary: LIVE });
    },
  };
  const cheap: LocalCheap = opts.repo
    ? CHEAP
    : {
        ...CHEAP,
        queue: {
          ...CHEAP.queue,
          running: CHEAP.queue.running.map((q) => ({ ...q, github: null, repoPath: null })),
        },
      };
  const r = renderApp({ client, localCheapFn: async () => cheap, transcriptPollMs: 10 });
  await until(() => (r.lastFrame() ?? "").includes("repos"));
  await tap(r, TO_QUEUE_ROW); // rail → the queue system row
  await until(() => (r.lastFrame() ?? "").includes("gh-acme-api-1"));
  await tap(r, "l"); // focus its body; the cursor lands on the running row
  await until(() => (r.lastFrame() ?? "").includes("gh-acme-api-1"));
  await tap(r, "\r");
  await until(() => (r.lastFrame() ?? "").includes("transcript ▸"));
  await until(() => reads >= 3); // the poll is genuinely ticking
  return { r, reads: () => reads };
}

describe("transcript → chat (#462)", () => {
  it("`c` closes the transcript, releasing its live poll", async () => {
    const { r, reads } = await openLiveTranscript();
    await tap(r, "c");
    await until(() => (r.lastFrame() ?? "").includes("chat · acme/api"));

    // A read already in flight when the view switched may still land, so take
    // the baseline a few poll periods in and then prove it does not move:
    // a still-scheduled 10ms interval would add ~15 reads over this window.
    await wait(150);
    const settled = reads();
    await wait(150);
    expect(reads()).toBe(settled);
  });

  it("`c` with no repo in context toasts and leaves the transcript alone", async () => {
    const { r, reads } = await openLiveTranscript({ repo: false });
    await tap(r, "c");
    await until(() => (r.lastFrame() ?? "").includes("select a repo first"));
    // No chat, so no exit — the transcript is still on screen and still live.
    expect(r.lastFrame() ?? "").toContain("transcript ▸");
    const before = reads();
    await until(() => reads() > before);
  });
});
