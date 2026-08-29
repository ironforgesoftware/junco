import { describe, it, expect } from "vitest";
import React, { useRef } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useTranscript, type TranscriptApi } from "../src/tui/hooks/useTranscript.js";
import type { DashboardClient, Result, TranscriptRead } from "../src/tui/ghClient.js";
import { summarizeTranscript } from "../src/transcriptSummary.js";
import { runEnd, runStart, toolStartId, turnEndFull } from "./helpers/transcriptFixtures.js";
import { until } from "./helpers/until.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const okv = <T,>(value: T): Result<T> => ({ ok: true, value });

const DONE = summarizeTranscript([
  runStart(),
  turnEndFull({
    text: "x",
    calls: [
      { id: "c1", name: "read", args: { path: "a" }, result: "r" },
      { id: "c2", name: "read", args: { path: "b" }, result: "r" },
    ],
  }),
  runEnd(),
]);
const LIVE = summarizeTranscript([runStart(), toolStartId("c1", "read", { path: "a" })]);

/** A client whose readTranscript answers from `seq` in order (last one repeats). */
function client(seq: TranscriptRead[]) {
  const calls: (number | null)[] = [];
  const c = {
    readTranscript: async (_id: string, prev: number | null) => {
      calls.push(prev);
      return okv(seq[Math.min(calls.length - 1, seq.length - 1)]);
    },
  } as unknown as DashboardClient;
  return { c, calls };
}

function Probe({
  client: c,
  onReady,
}: {
  client: DashboardClient;
  onReady: (api: TranscriptApi) => void;
}) {
  const aliveRef = useRef(true);
  const api = useTranscript({ client: c, aliveRef, pollMs: 10 });
  onReady(api);
  const t = api.transcript;
  return (
    <Text>
      {t === null
        ? "closed"
        : `id:${t.id}:loading:${t.loading}:live:${t.summary?.live ?? "none"}:err:${t.error ?? "none"}:cursor:${t.cursor}:follow:${t.follow}:exp:${[...t.expanded].join(",")}`}
    </Text>
  );
}

function mount(c: DashboardClient) {
  let api!: TranscriptApi;
  const r = render(<Probe client={c} onReady={(a) => (api = a)} />);
  return { r, api: () => api, frame: () => r.lastFrame() ?? "" };
}

describe("useTranscript", () => {
  it("starts closed; open performs the first read", async () => {
    const { c, calls } = client([{ kind: "read", size: 1, summary: DONE }]);
    const m = mount(c);
    expect(m.frame()).toBe("closed");
    m.api().openTranscript("t-1", { expectLive: false });
    await until(() => m.frame().includes("loading:false:live:false"));
    expect(calls).toEqual([null]);
    await wait(40); // finished transcript → no polling
    expect(calls).toEqual([null]);
  });

  it("polls while live and stops on the first read that is not live", async () => {
    const { c, calls } = client([
      { kind: "read", size: 5, summary: LIVE },
      { kind: "read", size: 9, summary: DONE },
    ]);
    const m = mount(c);
    m.api().openTranscript("t-1", { expectLive: true });
    await until(() => m.frame().includes("live:false"));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]).toBe(5); // prevSize threaded from the last read
    const n = calls.length;
    await wait(40);
    expect(calls.length).toBe(n);
  });

  it("opened with expectLive:false on a live transcript still polls", async () => {
    const { c, calls } = client([
      { kind: "read", size: 5, summary: LIVE },
      { kind: "read", size: 9, summary: DONE },
    ]);
    const m = mount(c);
    m.api().openTranscript("t-1", { expectLive: false });
    await until(() => m.frame().includes("live:false"));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const n = calls.length;
    await wait(40);
    expect(calls.length).toBe(n);
  });

  it("missing + expectLive keeps waiting (no error, keeps polling)", async () => {
    const { c, calls } = client([{ kind: "missing", path: "/p" }]);
    const m = mount(c);
    m.api().openTranscript("t-1", { expectLive: true });
    await until(() => calls.length >= 3);
    expect(m.frame()).toContain("err:none");
    expect(m.frame()).toContain("live:none");
  });

  it("missing without expectLive is terminal", async () => {
    const { c, calls } = client([{ kind: "missing", path: "/p" }]);
    const m = mount(c);
    m.api().openTranscript("t-1", { expectLive: false });
    await until(() => m.frame().includes("err:no transcript for t-1"));
    await wait(40);
    expect(calls).toEqual([null]);
  });

  it("unchanged keeps the previous summary object", async () => {
    const { c } = client([
      { kind: "read", size: 5, summary: LIVE },
      { kind: "unchanged", size: 5 },
    ]);
    const m = mount(c);
    m.api().openTranscript("t-1", { expectLive: true });
    await until(() => m.frame().includes("live:true"));
    await wait(40);
    expect(m.api().transcript?.summary).toBe(LIVE);
  });

  it("cursor clamps and pauses follow; expand toggles by id; close resets", async () => {
    const { c } = client([{ kind: "read", size: 1, summary: DONE }]);
    const m = mount(c);
    m.api().openTranscript("t-1", { expectLive: true });
    await until(() => m.frame().includes("loading:false"));
    expect(m.frame()).toContain("follow:true");
    m.api().moveCursor(5);
    await until(() => m.frame().includes("cursor:1:follow:false"));
    m.api().toggleExpanded();
    await until(() => m.frame().includes("exp:c2"));
    m.api().toggleExpanded();
    await until(() => m.frame().endsWith("exp:"));
    m.api().setCursor(0);
    m.api().toggleExpanded();
    await until(() => m.frame().includes("cursor:0") && m.frame().includes("exp:c1"));
    m.api().closeTranscript();
    await until(() => m.frame() === "closed");
  });
});
