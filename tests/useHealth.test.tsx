// tests/useHealth.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useHealth } from "../src/tui/hooks/useHealth.js";
import type { DashboardClient, HealthInfo } from "../src/tui/ghClient.js";
import { until } from "./helpers/until.js";

const MARKER_HEALTH: HealthInfo = {
  up: true,
  uptimeSeconds: 4242,
  lastBridgeSweepAt: null,
  ticketsBridged: null,
  tasksProcessed: null,
  tasksSucceeded: null,
  tasksFailed: null,
  lastTaskStatus: null,
  lastTaskAt: null,
  totalTokensOut: null,
  bridgeErrors: null,
};

function Probe({ client }: { client: DashboardClient }) {
  const health = useHealth(client, 999999);
  return <Text>{health ? `up:${health.uptimeSeconds}` : "none"}</Text>;
}

describe("useHealth", () => {
  it("fetches health once on mount and reflects it in state", async () => {
    const fakeClient = { health: async () => MARKER_HEALTH } as unknown as DashboardClient;
    const r = render(<Probe client={fakeClient} />);
    expect(r.lastFrame()).toBe("none");
    await until(() => r.lastFrame() === "up:4242");
    r.unmount();
  });
});
