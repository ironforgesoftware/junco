// tests/tuiChatPerf.test.tsx — the chat streaming perf gate (spec
// 2026-09-06-chat-streaming-design.md §7, §9; plan Task 18).
//
// A synthetic stream: a 200-turn history, then a live turn fed ~300
// `junco_chat_delta` records/s for ~2 s through a fake client on a REAL
// `setInterval`, into `useChat` rendered through `ChatView`. Two things are
// pinned loosely enough for a loaded CI runner (the spec's tighter numbers
// are measured by hand and recorded in the spec's §9 table):
//
// - `FinishedTurns` never re-runs during the stream (spec §4.1: a flush is
//   O(live turn), the history's rows are memoized on the summary).
// - Event-loop lag p95 (a 10 ms interval's drift) stays ≤ 40 ms.
//
// The measured numbers are printed (`npx vitest run tests/tuiChatPerf.test.tsx
// --reporter=verbose` shows the line) so a run can be recorded. Skipped when
// JUNCO_SKIP_PERF is set (a machine where timing is meaningless).
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ChatView } from "../src/tui/components/ChatView.js";
import { useChat } from "../src/tui/hooks/useChat.js";
import { renderCounts, resetRenderCounts } from "../src/tui/renderCount.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { ChatSubscribeHandlers } from "../src/tui/chatClient.js";
import { stubClient } from "./helpers/localFixtures.js";
import { until } from "./helpers/until.js";
import {
  agentEnd,
  agentStart,
  chatDelta,
  chatPrompt,
  chatTurnEnd,
  chatTurnStart,
  metaLine,
  turnEndFull,
} from "./helpers/transcriptFixtures.js";

const TURNS = 200;
const RATE_PER_S = 300;
const TICK_MS = 10;
const DURATION_MS = 2000;
const TOTAL = (RATE_PER_S * DURATION_MS) / 1000; // 600
const LAG_P95_MAX_MS = 40;

function makeClient() {
  let handlers: ChatSubscribeHandlers | null = null;
  const client: DashboardClient = {
    ...stubClient,
    listChatDrafts: async () => ({ ok: true, value: [] as never }),
    chat: {
      ...stubClient.chat,
      subscribe: (_key, _since, on) => {
        handlers = on;
        on.status("live");
        return () => {};
      },
    },
  };
  return { client, push: (offset: number | null, line: string) => handlers!.record(offset, line) };
}

/** The 200 finished turns, each a prompt → turn → answer → end frame. */
function historyLines(): string[] {
  const lines = [metaLine({ ticketId: "acme__api" })];
  for (let i = 0; i < TURNS; i++) {
    lines.push(
      chatPrompt({ text: `question ${i}` }),
      chatTurnStart({ turn: `h${i}` }),
      agentStart(),
      turnEndFull({ text: `answer ${i} with a few words of prose to wrap` }),
      agentEnd(),
      chatTurnEnd(),
    );
  }
  return lines;
}

function Probe({
  client,
  onReady,
}: {
  client: DashboardClient;
  onReady: (api: ReturnType<typeof useChat>) => void;
}) {
  const aliveRef = React.useRef(true);
  const api = useChat({ client, aliveRef });
  onReady(api);
  if (api.chat === null) return null;
  return (
    <ChatView
      state={api.chat}
      modelId="m"
      chatTodayUsd={null}
      scroll={0}
      height={30}
      width={100}
      focused={true}
      highlight={null}
      onComposerChange={() => {}}
      onComposerSubmit={() => {}}
    />
  );
}

const p95 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0;
};

describe.skipIf(process.env.JUNCO_SKIP_PERF !== undefined)("chat streaming perf (spec §9)", () => {
  const ORIGINAL_FLAG = process.env.JUNCO_RENDER_COUNT;
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.JUNCO_RENDER_COUNT;
    else process.env.JUNCO_RENDER_COUNT = ORIGINAL_FLAG;
    resetRenderCounts();
  });

  it("300 deltas/s over a 200-turn history: FinishedTurns never re-runs, lag p95 ≤ 40 ms", async () => {
    process.env.JUNCO_RENDER_COUNT = "1";
    resetRenderCounts();
    const c = makeClient();
    let api!: ReturnType<typeof useChat>;
    const r = render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");

    let offset = 0;
    for (const line of historyLines()) {
      offset += line.length + 1;
      c.push(offset, line);
    }
    await until(() => api.chat?.summary?.runs.length === TURNS);
    // The live turn's start is a persisted record too; it lands before the
    // first paint we measure from.
    c.push((offset += 40), chatPrompt({ text: "and now?" }));
    c.push((offset += 40), chatTurnStart({ turn: "live" }));
    await until(() => api.chat?.streaming === true && r.lastFrame()!.includes("answer 199"));
    const finishedAfterFirstPaint = renderCounts().FinishedTurns ?? 0;
    expect(finishedAfterFirstPaint).toBeGreaterThan(0);
    const chatViewBefore = renderCounts().ChatView ?? 0;

    // Drive the stream and sample the event loop's drift at the same time.
    const lags: number[] = [];
    let last = performance.now();
    const sampler = setInterval(() => {
      const now = performance.now();
      lags.push(now - last - TICK_MS);
      last = now;
    }, TICK_MS);
    // Wall-clock paced: each tick sends whatever the target rate owes so
    // far, so a stretched tick (a slow frame) is caught up on the next one
    // and the run really delivers RATE_PER_S — a fixed count per tick
    // would silently deliver less on a saturated loop and hide the cost.
    let seq = 0;
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const driver = setInterval(() => {
        const elapsed = performance.now() - t0;
        const due = Math.min(TOTAL, Math.floor((elapsed / 1000) * RATE_PER_S));
        while (seq < due) {
          seq++;
          c.push(
            null,
            chatDelta({ turn: "live", seq, delta: seq === TOTAL ? " STREAM_END" : `w${seq} ` }),
          );
        }
        if (seq >= TOTAL) {
          clearInterval(driver);
          resolve();
        }
      }, TICK_MS);
    });
    const streamMs = performance.now() - t0;
    await until(() => r.lastFrame()!.includes("STREAM_END"));
    clearInterval(sampler);

    const counts = renderCounts();
    const finishedDuringStream = (counts.FinishedTurns ?? 0) - finishedAfterFirstPaint;
    const chatViewRenders = (counts.ChatView ?? 0) - chatViewBefore;
    const rendersPerS = chatViewRenders / (streamMs / 1000);
    const lagP95 = p95(lags);
    const lagMax = Math.max(...lags);
    console.log(
      `[tuiChatPerf] deltas=${seq} over ${streamMs.toFixed(0)} ms (${(
        (seq / streamMs) *
        1000
      ).toFixed(0)}/s) · lag p95=${lagP95.toFixed(1)} ms max=${lagMax.toFixed(1)} ms · ` +
        `ChatView renders=${chatViewRenders} (${rendersPerS.toFixed(1)}/s) · ` +
        `FinishedTurns=${counts.FinishedTurns ?? 0} total, ${finishedDuringStream} during the stream`,
    );

    expect(seq).toBe(TOTAL);
    expect(api.chat!.live!.seq).toBe(seq);
    expect(finishedDuringStream).toBe(0);
    expect(lagP95).toBeLessThanOrEqual(LAG_P95_MAX_MS);
    r.unmount();
  }, 30_000);
});
