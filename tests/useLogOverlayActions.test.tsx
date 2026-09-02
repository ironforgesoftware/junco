// tests/useLogOverlayActions.test.tsx
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import {
  useLogOverlayActions,
  type LogOverlayActionsInput,
} from "../src/tui/hooks/useLogOverlayActions.js";
import type { LogEntry } from "../src/logReader.js";
import type { LogFilters } from "../src/tui/logFilter.js";

const entry = (ticket: string | null): LogEntry => ({
  ts: null,
  level: "info",
  ticket,
  msg: "m",
  fields: {},
  raw: "m",
});

const FILTERS: LogFilters = { minLevel: "info", ticket: null, search: "" };

function Probe({
  input,
  onReady,
}: {
  input: LogOverlayActionsInput;
  onReady: (a: Record<string, () => void>) => void;
}) {
  onReady(useLogOverlayActions(input));
  return <Text>probe</Text>;
}

function mount(overrides: Partial<LogOverlayActionsInput> = {}) {
  const close = vi.fn();
  const setLogFilters = vi.fn();
  const setLogFollow = vi.fn();
  const toEnd = vi.fn();
  const openHelp = vi.fn();
  const input: LogOverlayActionsInput = {
    close,
    openHelp,
    logEntries: [],
    logFilters: FILTERS,
    logFollow: true,
    setLogFilters,
    setLogFollow,
    toEnd,
    ...overrides,
  };
  let api!: Record<string, () => void>;
  const r = render(<Probe input={input} onReady={(a) => (api = a)} />);
  return {
    api,
    spies: { close, setLogFilters, setLogFollow, toEnd, openHelp },
    unmount: r.unmount,
  };
}

describe("useLogOverlayActions", () => {
  it("exposes exactly the overlay's action ids, help included", () => {
    const { api, unmount } = mount();
    expect(Object.keys(api).sort()).toEqual(["close", "follow", "help", "level", "ticket"]);
    unmount();
  });

  // Ruling R5: `?` opens help from the log overlay too — the overlay owns all
  // input while open (App's layer 3b), so its own arm has to carry the verb.
  it("help defers to App's openHelp", () => {
    const { api, spies, unmount } = mount();
    api["help"]?.();
    expect(spies.openHelp).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("close delegates to the shared close recipe", () => {
    const { api, spies, unmount } = mount();
    api["close"]?.();
    expect(spies.close).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("follow: pausing lands at the tail first, then clears follow", () => {
    const { api, spies, unmount } = mount({ logFollow: true });
    api["follow"]?.();
    expect(spies.setLogFollow).toHaveBeenCalledWith(false);
    expect(spies.toEnd).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("follow: resuming only sets follow (no jump to the tail)", () => {
    const { api, spies, unmount } = mount({ logFollow: false });
    api["follow"]?.();
    expect(spies.setLogFollow).toHaveBeenCalledWith(true);
    expect(spies.toEnd).not.toHaveBeenCalled();
    unmount();
  });

  it("level cycles minLevel through the level order", () => {
    const { api, spies, unmount } = mount();
    api["level"]?.();
    const updater = spies.setLogFilters.mock.calls[0]?.[0] as (f: LogFilters) => LogFilters;
    expect(updater(FILTERS)).toEqual({ ...FILTERS, minLevel: "warn" });
    unmount();
  });

  it("ticket cycles null → each ticket in the buffer → back to null", () => {
    const entries = [entry("t-b"), entry(null), entry("t-a"), entry("t-b")];
    const step = (cur: string | null): string | null => {
      const { api, spies, unmount } = mount({
        logEntries: entries,
        logFilters: { ...FILTERS, ticket: cur },
      });
      api["ticket"]?.();
      const updater = spies.setLogFilters.mock.calls[0]?.[0] as (f: LogFilters) => LogFilters;
      const next = updater({ ...FILTERS, ticket: cur }).ticket;
      unmount();
      return next;
    };
    expect(step(null)).toBe("t-a"); // distinctTickets sorts
    expect(step("t-a")).toBe("t-b");
    expect(step("t-b")).toBe(null);
  });
});
