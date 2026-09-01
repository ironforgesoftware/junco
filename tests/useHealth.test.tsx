// tests/useHealth.test.tsx
import { describe, it, expect } from "vitest";
import React, { useRef } from "react";
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

  it("keeps the previous health reference while uptime stays in the same minute", async () => {
    let uptime = 4242; // minute 70
    let calls = 0;
    const client = {
      health: async () => {
        calls++;
        return { ...MARKER_HEALTH, uptimeSeconds: uptime };
      },
    } as unknown as DashboardClient;
    function RefProbe(): React.JSX.Element {
      const health = useHealth(client, 15);
      const seen = useRef(new Set<HealthInfo>());
      if (health) seen.current.add(health);
      return <Text>{`refs:${seen.current.size}:up:${health?.uptimeSeconds ?? "-"}`}</Text>;
    }
    const r = render(<RefProbe />);
    await until(() => calls >= 4);
    uptime = 4250; // still minute 70 → equal key → same reference, raw seconds NOT updated
    await until(() => calls >= 8);
    expect(r.lastFrame()).toBe("refs:1:up:4242");
    uptime = 4320; // minute 72 → new reference carrying the raw seconds
    await until(() => r.lastFrame() === "refs:2:up:4320");
    r.unmount();
  });
});
