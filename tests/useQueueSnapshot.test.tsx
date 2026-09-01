// tests/useQueueSnapshot.test.tsx
import { describe, it, expect } from "vitest";
import React, { useRef } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useQueueSnapshot } from "../src/tui/hooks/useQueueSnapshot.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";
import { until } from "./helpers/until.js";

const MARKER_QUEUE: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  taskTimeoutSeconds: null,
  running: [],
  waiting: [],
  recent: [],
  error: null,
  outboxDepth: 4242,
  stats: null,
};

function Probe({ queueFn }: { queueFn: () => Promise<QueueSnapshot> }) {
  const { queueSnap } = useQueueSnapshot(queueFn, 999999);
  return <Text>{queueSnap ? `depth:${queueSnap.outboxDepth}` : "none"}</Text>;
}

describe("useQueueSnapshot", () => {
  it("fetches the queue snapshot once on mount and reflects it in state", async () => {
    const fakeQueueFn = async () => MARKER_QUEUE;
    const r = render(<Probe queueFn={fakeQueueFn} />);
    expect(r.lastFrame()).toBe("none");
    await until(() => r.lastFrame() === "depth:4242");
    r.unmount();
  });

  it("an equal poll keeps the previous snapshot reference; a changed one replaces it", async () => {
    let depth = 1;
    // A FRESH but structurally equal object on every call — the gate must see through it.
    const queueFn = async (): Promise<QueueSnapshot> => ({ ...MARKER_QUEUE, outboxDepth: depth });
    let calls = 0;
    const counting = async (): Promise<QueueSnapshot> => {
      calls++;
      return queueFn();
    };
    function RefProbe(): React.JSX.Element {
      const { queueSnap } = useQueueSnapshot(counting, 15);
      const seen = useRef(new Set<QueueSnapshot>());
      if (queueSnap) seen.current.add(queueSnap);
      return <Text>{`refs:${seen.current.size}:calls:${calls}`}</Text>;
    }
    const r = render(<RefProbe />);
    await until(() => calls >= 6);
    expect(r.lastFrame()).toMatch(/^refs:1:/);
    depth = 2;
    await until(() => r.lastFrame()?.startsWith("refs:2:") ?? false);
    r.unmount();
  });
});
