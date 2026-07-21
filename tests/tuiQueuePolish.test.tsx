import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { QueueView } from "../src/tui/components/QueueView.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";

const snap: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  taskTimeoutSeconds: 2700,
  running: [
    {
      id: "fix-login",
      github: null,
      turns: 4,
      lastTool: "bash",
      outputTokens: 1200,
      startedAt: "2026-07-20T11:37:00Z",
      updatedAt: "2026-07-20T11:59:30Z",
      stale: false,
      repoPath: null,
    },
  ],
  waiting: [],
  recent: [],
  stats: null,
  outboxDepth: 0,
} as unknown as QueueSnapshot;

describe("queue polish", () => {
  it("running row shows the time-budget gauge", () => {
    const { lastFrame } = render(
      <QueueView
        snap={snap}
        scroll={0}
        now={new Date("2026-07-20T12:00:00Z")}
        height={20}
        focused
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("▰"); // 23m of 45m elapsed
    expect(f).toContain("23m / 45m budget");
  });
  it("no gauge when timeout unknown", () => {
    const noTo = { ...snap, taskTimeoutSeconds: null } as QueueSnapshot;
    const { lastFrame } = render(
      <QueueView
        snap={noTo}
        scroll={0}
        now={new Date("2026-07-20T12:00:00Z")}
        height={20}
        focused
      />,
    );
    expect(lastFrame()).not.toContain("budget");
  });
});
