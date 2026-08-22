import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { detectSplitQueue } from "../src/splitQueue.js";

// Synthetic paths only — no real filesystem. `listInbox` is injected so every
// test controls exactly what "pending tickets" means per root.

describe("detectSplitQueue (split-queue startup guards, #274)", () => {
  it("returns null when every known root is empty (a fresh install must stay silent)", () => {
    const listInbox = vi.fn().mockReturnValue([]);
    const finding = detectSplitQueue(
      { queueRoot: "/h/.junco/queue" },
      { HOME: "/h" },
      { listInbox },
    );
    expect(finding).toBeNull();
  });

  it("returns null when the resolved root has pending tickets", () => {
    const listInbox = vi.fn((dir: string) =>
      dir === join("/h/.junco/queue", "inbox") ? ["a.md"] : [],
    );
    const finding = detectSplitQueue(
      { queueRoot: "/h/.junco/queue" },
      { HOME: "/h" },
      { listInbox },
    );
    expect(finding).toBeNull();
  });

  it("reports the other root when the resolved one is empty and another holds tickets", () => {
    const legacyInbox = join("/h/.local/state/junco/queue", "inbox");
    const listInbox = vi.fn((dir: string) => (dir === legacyInbox ? ["a.md", "b.md"] : []));
    const finding = detectSplitQueue(
      { queueRoot: "/h/.junco/queue" },
      { HOME: "/h" },
      { listInbox },
    );
    expect(finding).not.toBeNull();
    expect(finding?.resolvedRoot).toBe("/h/.junco/queue");
    expect(finding?.others).toEqual([
      { root: "/h/.local/state/junco/queue", label: "legacy data root", pending: 2 },
    ]);
  });

  it("ignores done/ and failed/ — a completed migrate leaves those populated forever", () => {
    const legacyInbox = join("/h/.local/state/junco/queue", "inbox");
    const listInbox = vi.fn((dir: string) => (dir === legacyInbox ? ["a.md"] : []));
    detectSplitQueue({ queueRoot: "/h/.junco/queue" }, { HOME: "/h" }, { listInbox });
    for (const call of listInbox.mock.calls) {
      const dir = call[0] as string;
      expect(dir.endsWith(`${"/"}done`)).toBe(false);
      expect(dir.endsWith(`${"/"}failed`)).toBe(false);
    }
    // Every call must target an inbox/ leaf specifically.
    expect(listInbox.mock.calls.every((call) => (call[0] as string).endsWith("/inbox"))).toBe(true);
  });

  it("tolerates a missing directory (ENOENT) without throwing", () => {
    // No injected listInbox — exercises the default seam (`discoverTasks`,
    // itself ENOENT-tolerant) against synthetic, definitely-nonexistent
    // paths. discoverTasks does the real readdir call, but every path here
    // is a synthetic path guaranteed absent, so there is no fixture setup
    // and nothing is ever actually read.
    expect(() =>
      detectSplitQueue({ queueRoot: "/nope/does-not-exist/queue" }, { HOME: "/also-nope-home" }),
    ).not.toThrow();
    expect(
      detectSplitQueue({ queueRoot: "/nope/does-not-exist/queue" }, { HOME: "/also-nope-home" }),
    ).toBeNull();
  });

  // Strengthening test pinning the `processing/` decision (see splitQueue.ts
  // doc comment): a stale processing/ entry on another, possibly-abandoned
  // root is excluded from the signal on purpose — only inbox/ counts.
  it("never reads processing/ on either root — only inbox/ counts as pending", () => {
    const listInbox = vi.fn().mockReturnValue([]);
    const finding = detectSplitQueue(
      { queueRoot: "/h/.junco/queue" },
      { HOME: "/h" },
      { listInbox },
    );
    expect(finding).toBeNull();
    for (const call of listInbox.mock.calls) {
      expect((call[0] as string).endsWith("/processing")).toBe(false);
    }
  });
});
