import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Rail } from "../src/tui/components/Rail.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";

const QUEUE: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  running: [
    {
      id: "gh-a-b-46",
      github: { nwo: "a/b", issue: 46, kind: "pr" },
      turns: 14,
      lastTool: "bash",
      outputTokens: 900,
      startedAt: null,
      stale: false,
    },
  ],
  waiting: [
    {
      id: "w1",
      github: null,
      kind: "ask",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
    },
    {
      id: "w2",
      github: null,
      kind: "pr",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
    },
  ],
  recent: [],
  error: null,
};

const repos = [
  { nwo: "acme/api", fromConfig: false, counts: { "plan-ready": 2 } },
  { nwo: "acme/web", fromConfig: true, counts: {} },
];

describe("Rail", () => {
  it("numbered title, selection bar, config marker, badges, queue card", () => {
    const f = render(
      <Rail repos={repos} selected={0} focused={true} queue={QUEUE} width={26} height={20} />,
    ).lastFrame()!;
    expect(f).toContain("1 repos");
    expect(f).toContain("▌");
    expect(f).toContain("acme/api");
    expect(f).toContain("2●");
    expect(f).toContain("(cfg)");
    expect(f).toContain("queue");
    expect(f).toContain("#46 exec");
    expect(f).toContain("turn 14");
    expect(f).toContain("2 waiting");
  });
  it("empty repos state and daemon-down warning", () => {
    const down: QueueSnapshot = { ...QUEUE, daemonUp: false, running: [] };
    const f = render(
      <Rail repos={[]} selected={0} focused={false} queue={down} width={26} height={20} />,
    ).lastFrame()!;
    expect(f).toContain("none — press w to add");
    expect(f).toContain("daemon ○ down");
  });
  it("worst-case queue card (2 running, waiting, daemon down) never overflows the pane", () => {
    // Full repo window: with the list windowed to its complete height budget
    // there is no flexGrow slack to absorb a card under-budget — Yoga would
    // squeeze out the selected repo row and corrupt the position line.
    const many = Array.from({ length: 30 }, (_, i) => ({
      nwo: `o/r${i}`,
      fromConfig: false,
      counts: {},
    }));
    const busy: QueueSnapshot = {
      ...QUEUE,
      daemonUp: false,
      running: [
        {
          id: "gh-a-b-46",
          github: { nwo: "a/b", issue: 46, kind: "pr" },
          turns: 14,
          lastTool: "bash",
          outputTokens: 900,
          startedAt: null,
          stale: false,
        },
        {
          id: "gh-a-b-47",
          github: { nwo: "a/b", issue: 47, kind: "pr" },
          turns: 3,
          lastTool: "edit",
          outputTokens: 100,
          startedAt: null,
          stale: false,
        },
      ],
    };
    const f = render(
      <Rail repos={many} selected={29} focused={true} queue={busy} width={26} height={16} />,
    ).lastFrame()!;
    expect(f.split("\n").length).toBeLessThanOrEqual(16);
    expect(f).toContain("▌o/r29"); // the selected row must survive the squeeze
    expect(f).toContain("+1 more running");
    expect(f).toContain("2 waiting");
    expect(f).toContain("daemon ○ down");
  });
  it("error variant renders the unavailable line", () => {
    const errored: QueueSnapshot = { ...QUEUE, error: "clock boom" };
    // width 30: "unavailable: clock boom" (23 chars) needs more than the
    // 22-char content width a 26-wide pane leaves after borders + padding.
    const f = render(
      <Rail repos={repos} selected={0} focused={true} queue={errored} width={30} height={20} />,
    ).lastFrame()!;
    expect(f).toContain("unavailable: clock boom");
  });
  it("windows long repo lists to the height budget with a position line", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      nwo: `o/r${i}`,
      fromConfig: false,
      counts: {},
    }));
    const f = render(
      <Rail repos={many} selected={29} focused={true} queue={null} width={26} height={16} />,
    ).lastFrame()!;
    expect(f).toContain("o/r29"); // cursor stays visible
    expect(f).not.toContain("o/r0"); // top scrolled out
    expect(f).toContain("30/30");
  });
});
