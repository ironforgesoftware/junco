// tests/useQueueSnapshot.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
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
  const { queueSnap, queueNow } = useQueueSnapshot(queueFn, 999999);
  const clockOk = queueNow instanceof Date;
  return <Text>{queueSnap ? `depth:${queueSnap.outboxDepth}:${clockOk}` : "none"}</Text>;
}

describe("useQueueSnapshot", () => {
  it("fetches the queue snapshot once on mount and reflects it in state", async () => {
    const fakeQueueFn = async () => MARKER_QUEUE;
    const r = render(<Probe queueFn={fakeQueueFn} />);
    expect(r.lastFrame()).toBe("none");
    await until(() => r.lastFrame() === "depth:4242:true");
    r.unmount();
  });
});
