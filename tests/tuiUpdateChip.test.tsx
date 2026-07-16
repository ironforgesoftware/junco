// tests/tuiUpdateChip.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "../src/tui/components/Chrome.js";
import { HelpModal } from "../src/tui/components/HelpModal.js";
import { until } from "./helpers/until.js";

const headerProps = {
  repoNwo: "acme/site",
  health: null,
  reviewCount: 0,
  now: new Date("2026-07-16T12:00:00Z"),
  mode: "wide" as const,
  queueRunning: 0,
  queueWaiting: 0,
  watchlistError: null,
  outboxDepth: 0,
  prAttention: 0,
  prFailing: false,
  refreshedAt: null,
};

describe("Header update chip", () => {
  it("renders ⬆ v<latest> when an update is known", async () => {
    const { lastFrame } = render(<Header {...headerProps} updateLatest="0.8.0" />);
    await until(() => (lastFrame() ?? "").includes("⬆ v0.8.0"));
  });

  it("renders no chip when updateLatest is null/absent", async () => {
    const { lastFrame } = render(<Header {...headerProps} updateLatest={null} />);
    await until(() => (lastFrame() ?? "").includes("acme/site"));
    expect(lastFrame()).not.toContain("⬆");
  });
});

describe("HelpModal update line", () => {
  // Reuse the prop shape from tests/tuiModal.test.tsx's HelpModal render if it
  // differs — the essential contract is the updateLatest line below.
  const modalProps = {
    view: "main" as const,
    pane: 1 as const,
    mode: "wide" as const,
    trigger: "junco",
    uiMode: "local" as const,
    localSection: "queue" as const,
  };

  it("names junco update when an update is available", async () => {
    const { lastFrame } = render(<HelpModal {...modalProps} updateLatest="0.8.0" />);
    await until(() => (lastFrame() ?? "").includes("junco update"));
    expect(lastFrame()).toContain("v0.8.0");
  });

  it("omits the line otherwise", async () => {
    const { lastFrame } = render(<HelpModal {...modalProps} />);
    await until(() => (lastFrame() ?? "").length > 0);
    expect(lastFrame()).not.toContain("v0.8.0 available");
  });
});
