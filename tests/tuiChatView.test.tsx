import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ChatView, chatHeaderStatus } from "../src/tui/components/ChatView.js";
import { TranscriptBody } from "../src/tui/components/TranscriptBody.js";
import type { ChatState } from "../src/tui/hooks/useChat.js";
import type { TranscriptRow } from "../src/transcriptRender.js";
import { maxScroll } from "../src/tui/window.js";
import { summarizeTranscript } from "../src/transcriptSummary.js";
import {
  chatDraft,
  chatPrompt,
  chatTurnEnd,
  chatTurnStart,
  metaLine,
  turnEndFull,
  agentStart,
  agentEnd,
} from "./helpers/transcriptFixtures.js";
import { until } from "./helpers/until.js";

const base = (over: Partial<ChatState> = {}): ChatState => ({
  key: "acme/api",
  connection: "live",
  downReason: null,
  endReason: null,
  summary: null,
  liveText: "",
  streaming: false,
  blocked: null,
  degraded: false,
  overflowed: false,
  drafts: [],
  composer: "",
  composerFocused: true,
  cursor: 0,
  follow: true,
  showThinking: false,
  expanded: new Set(),
  lastOffset: null,
  error: null,
  ...over,
});

describe("chatHeaderStatus (pure)", () => {
  it("maps state to the header word, in priority order", () => {
    expect(chatHeaderStatus(base({ connection: "down" }), "m").text).toBe("daemon down");
    expect(
      chatHeaderStatus(
        base({ blocked: { reason: "rate limited", until: "2026-09-01T18:00:00.000Z" } }),
        "m",
      ).text,
    ).toMatch(/^blocked: rate limited until/);
    expect(chatHeaderStatus(base({ streaming: true }), "m")).toEqual({
      text: "◐ streaming",
      tone: "accent",
    });
    expect(chatHeaderStatus(base({ degraded: true }), "m").text).toBe("idle · transcript degraded");
    expect(chatHeaderStatus(base(), "m").text).toBe("idle");
    expect(chatHeaderStatus(base({ endReason: "session_reset" }), "m").text).toBe(
      "session reset — send a message to start fresh",
    );
  });

  // Ruling R21b: useChat resubscribes automatically after an `end`, so
  // `endReason` can still read "daemon_stopped" once the connection is
  // already back to "live" — that stale reason must not keep announcing a
  // reconnect the hook already finished.
  it("daemon_stopped reads 'reconnecting' only while the connection isn't live yet (R21b)", () => {
    expect(
      chatHeaderStatus(base({ endReason: "daemon_stopped", connection: "connecting" }), "m").text,
    ).toBe("daemon stopped — reconnecting");
    expect(
      chatHeaderStatus(base({ endReason: "daemon_stopped", connection: "live" }), "m").text,
    ).toBe("idle");
  });

  it("a down connection says WHY when the daemon told us (R32)", () => {
    for (const [downReason, text] of [
      ["chat_disabled", "chat disabled (chat.enabled)"],
      ["no_checkout", "no checkout — clone the repo first"],
      ["not_a_repo", "checkout is not a git repo"],
      ["unknown_key", "repo not watched"],
      ["something_new", "daemon down"],
      [null, "daemon down"],
    ] as const) {
      expect(chatHeaderStatus(base({ connection: "down", downReason }), "m")).toEqual({
        text,
        tone: "error",
      });
    }
  });

  it("blocked without an until timestamp omits the 'until' suffix", () => {
    expect(
      chatHeaderStatus(base({ blocked: { reason: "rate limited", until: null } }), "m").text,
    ).toBe("blocked: rate limited");
  });

  it("a non-live connection with no other state shows the raw connection word", () => {
    expect(chatHeaderStatus(base({ connection: "reconnecting" }), "m")).toEqual({
      text: "reconnecting",
      tone: "dim",
    });
  });
});

describe("ChatView", () => {
  it("renders header, prompt/turn rows, live text, a draft card with its anchor cursor, and the composer", async () => {
    const summary = summarizeTranscript([
      metaLine({ ticketId: "acme__api" }),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      turnEndFull({
        thinking: null,
        text: "because of X",
        calls: [],
        usage: { input: 3, output: 4 },
      }),
      agentEnd(),
      chatTurnEnd(),
      chatDraft(),
      chatPrompt({ text: "and now?" }),
      chatTurnStart(),
    ]);
    const state = base({
      summary,
      liveText: "thinking about it",
      streaming: true,
      composer: "",
      composerFocused: false,
      cursor: 0,
      follow: false,
    });
    const r = render(
      <ChatView
        state={state}
        modelId="local/m1"
        costUsd={0.42}
        scroll={0}
        height={24}
        width={80}
        focused
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => r.lastFrame()!.includes("acme/api"));
    const f = r.lastFrame()!;
    expect(f).toContain("◐ streaming");
    expect(f).toContain("local/m1");
    expect(f).toContain("chat $0.42");
    // Header segments in order: 2 turns (many), $ cost, model id — all in one
    // contiguous string, which also proves nothing extra snuck in between.
    expect(f).toContain("chat · acme/api · ◐ streaming · 2 turns · chat $0.42 · local/m1");
    expect(f).toContain("you: why is the build slow?");
    expect(f).toContain("because of X");
    expect(f).toContain("▌"); // cursor on the draft card (the only anchor)
    expect(f).toContain("draft parked · ticket · add-cache");
    expect(f).toContain("thinking about it"); // liveText trailing rows
    expect(f).toContain("type a message"); // composer placeholder (blurred still renders)
    expect(f).toContain("i compose"); // footer: composer blurred variant
  });

  it("shows the overflow note and disables the composer when the daemon is down", async () => {
    const r = render(
      <ChatView
        state={base({ connection: "down", overflowed: true })}
        modelId={null}
        costUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => r.lastFrame()!.includes("daemon down"));
    const f = r.lastFrame()!;
    expect(f).toContain("showing last 2000");
    // No turns, no cost, no model — the header collapses to just key + status
    // + the overflow note, contiguous (proves the hidden segments are absent).
    expect(f).toContain("chat · acme/api · daemon down · showing last 2000");
    expect(f).toContain("esc blur/abort"); // footer: composer focused variant (base's default)
    expect(f).toContain("daemon down — chat unavailable"); // composer disabledReason (down)
  });

  it("the composer's disabled line names the daemon's reason too (R32)", async () => {
    const r = render(
      <ChatView
        state={base({ connection: "down", downReason: "chat_disabled" })}
        modelId={null}
        costUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => r.lastFrame()!.includes("chat disabled (chat.enabled)"));
    const f = r.lastFrame()!;
    expect(f).toContain("chat · acme/api · chat disabled (chat.enabled)");
    expect(f).toContain("chat disabled (chat.enabled) — chat unavailable");
  });

  it("turns segment is singular for exactly one turn", async () => {
    const summary = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      turnEndFull({ text: "ok" }),
      agentEnd(),
      chatTurnEnd(),
    ]);
    const r = render(
      <ChatView
        state={base({ summary })}
        modelId={null}
        costUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => r.lastFrame()!.includes("acme/api"));
    const f = r.lastFrame()!;
    expect(f).toContain("1 turn");
    expect(f).not.toContain("1 turns");
  });

  it("turns segment is hidden entirely with no summary", async () => {
    const r = render(
      <ChatView
        state={base()}
        modelId={null}
        costUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => r.lastFrame()!.includes("acme/api"));
    expect(r.lastFrame()).not.toContain("turn");
  });

  it("composer is disabled with a connecting reason while the connection is still connecting", async () => {
    const r = render(
      <ChatView
        state={base({ connection: "connecting" })}
        modelId={null}
        costUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => r.lastFrame()!.includes("connecting…"));
    expect(r.lastFrame()).toContain("connecting…");
  });

  it("empty liveText adds no trailing row", async () => {
    const summary = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      turnEndFull({ text: "done" }),
      agentEnd(),
      chatTurnEnd(),
    ]);
    const r = render(
      <ChatView
        state={base({ summary, liveText: "" })}
        modelId="m"
        costUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => r.lastFrame()!.includes("done"));
    expect(r.lastFrame()).not.toContain("thinking about it");
  });
});

describe("TranscriptBody", () => {
  it("wires onScrollMax (reported during render) and accepts onRowPress", () => {
    const onScrollMax = vi.fn();
    const onRowPress = vi.fn();
    const rows: TranscriptRow[] = [
      { text: "line 1" },
      { text: "tool call", anchor: "c1" },
      { text: "line 3" },
    ];
    render(
      <TranscriptBody
        rows={rows}
        anchors={["c1"]}
        cursor={0}
        follow={false}
        scroll={0}
        visible={2}
        focused
        onScrollMax={onScrollMax}
        onRowPress={onRowPress}
      />,
    );
    expect(onScrollMax).toHaveBeenCalledWith(maxScroll(rows.length, 2));
  });
});
