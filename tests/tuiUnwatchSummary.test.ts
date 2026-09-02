import { describe, it, expect } from "vitest";
import { summarizeUnwatchPlan } from "../src/tui/unwatchSummary.js";
import type { UnwatchPlan } from "../src/unwatchCmd.js";

const base: UnwatchPlan = {
  nwo: "acme/api",
  mode: "watched",
  external: false,
  clone: { path: "/c", managed: true },
  items: [
    { kind: "clone", path: "/c" },
    { kind: "inbox-ticket", path: "/q/a.md", detail: "a" },
    { kind: "inbox-ticket", path: "/q/b.md", detail: "b" },
    { kind: "worktrees", path: "/w/ns" },
  ],
  kept: [],
  blocked: null,
};

describe("summarizeUnwatchPlan", () => {
  it("itemizes with counts in kind order", () => {
    expect(summarizeUnwatchPlan(base)).toBe(
      "Will delete: managed clone · 2 queued ticket(s) · worktrees Continue?",
    );
  });

  it("appends keeps and handles the empty plan", () => {
    const kept = {
      ...base,
      clone: { path: "/me", managed: false },
      items: base.items.slice(1),
      kept: ["clone (user-owned): /me"],
    };
    expect(summarizeUnwatchPlan(kept)).toContain("— keeps: clone (user-owned): /me");
    expect(summarizeUnwatchPlan({ ...base, items: [], kept: [] })).toBe(
      "No junco-owned state to delete — just stop watching. Continue?",
    );
  });

  // A user-owned clone with nothing else to delete is the common "just stop
  // watching" case — the keeps line still has to say the clone survives.
  it("keeps ride along with the empty-plan headline", () => {
    expect(summarizeUnwatchPlan({ ...base, items: [], kept: ["clone (user-owned): /me"] })).toBe(
      "No junco-owned state to delete — just stop watching. — keeps: clone (user-owned): /me Continue?",
    );
  });

  // Kind order is the deletion order, not the order items happen to arrive in;
  // the count-less kinds (worktrees / history / mirror / cache) collapse to one
  // chip each however many paths they cover.
  it("orders every kind and collapses the count-less ones", () => {
    const all: UnwatchPlan = {
      ...base,
      items: [
        { kind: "github-cache", path: "/gc/prs.json" },
        { kind: "github-cache", path: "/gc/issues.json" },
        { kind: "mirror", path: "/m" },
        { kind: "assess-history", path: "/h.jsonl" },
        { kind: "comment-review", path: "/cr/1.json" },
        { kind: "assess-review", path: "/ar/1.json" },
        { kind: "assess-review", path: "/ar/2.json" },
        { kind: "outbox-op", path: "/o/1.json" },
        { kind: "worktrees", path: "/w/ns" },
        { kind: "inbox-ticket", path: "/q/a.md" },
        { kind: "clone", path: "/c" },
        { kind: "chat-session", path: "/chats/acme__api" },
        { kind: "chat-draft", path: "/chat-drafts/d1.json", detail: "d1" },
      ],
    };
    expect(summarizeUnwatchPlan(all)).toBe(
      "Will delete: managed clone · 1 queued ticket(s) · worktrees · 1 outbox op(s) · " +
        "2 pending audit batch(es) · 1 pending comment draft(s) · audit history · mirror · " +
        "github cache · chat session · 1 pending chat draft(s) Continue?",
    );
  });
});
