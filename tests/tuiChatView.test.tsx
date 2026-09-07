import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ChatView, chatHeaderStatus } from "../src/tui/components/ChatView.js";
import {
  TranscriptBody,
  arrayRows,
  bodyWindow,
  concatRows,
} from "../src/tui/components/TranscriptBody.js";
import { renderCounts, resetRenderCounts } from "../src/tui/renderCount.js";
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
  live: null,
  streaming: false,
  blocked: null,
  degraded: false,
  overflowed: false,
  drafts: [],
  composer: "",
  composerFocused: true,
  cursor: 0,
  follow: true,
  reveal: false,
  thinking: { pinned: false },
  frame: 0,
  expanded: new Set(),
  lastOffset: null,
  error: null,
  pending: null,
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

  // Spec 2026-09-03 §4.3: a waiting junco_submit card outranks `streaming` —
  // the turn IS still streaming while the tool blocks on the operator, and
  // "◐ streaming" would say nothing about what it is waiting for.
  it("a pending submit reads 'awaiting your confirmation', ahead of streaming", () => {
    const pending = {
      commandId: "call_1",
      draftId: "acme__api-20260901-120000-1",
      ids: ["add-readme"],
      route: "inbox" as const,
      running: false,
    };
    expect(chatHeaderStatus(base({ pending, streaming: true }), "m")).toEqual({
      text: "◐ awaiting your confirmation",
      tone: "accent",
    });
    // #478: once the operator answered `y` the wait is the daemon's spawned
    // CLI, not them — the header must stop asking for a confirmation it has.
    expect(
      chatHeaderStatus(base({ pending: { ...pending, running: true }, streaming: true }), "m"),
    ).toEqual({ text: "▸ submitting…", tone: "accent" });
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
      live: {
        turn: "t1",
        seq: 1,
        blocks: [{ kind: "text", contentIndex: 0, text: "thinking about it" }],
        expanded: new Set(),
        dropped: 0,
      },
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
        chatTodayUsd={0.42}
        scroll={0}
        height={24}
        width={80}
        focused
        highlight={null}
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => r.lastFrame()!.includes("acme/api"));
    const f = r.lastFrame()!;
    expect(f).toContain("◐ streaming");
    expect(f).toContain("local/m1");
    // #456: the figure is ChatHealth.chatTodayUsd — the chat's spend for the
    // ledger's current day, which is the window spec §8.2 asks for. The label
    // says "today" because the value finally is today's.
    expect(f).toContain("chat $0.42 today");
    // Header segments in order: 2 turns (many), $ cost, model id — all in one
    // contiguous string, which also proves nothing extra snuck in between.
    expect(f).toContain("chat · acme/api · ◐ streaming · 2 turns · chat $0.42 today · local/m1");
    expect(f).toContain("you: why is the build slow?");
    expect(f).toContain("junco: because of X"); // the answer carries the other label
    expect(f).toContain("▌"); // cursor on the draft card (the only anchor)
    expect(f).toContain("draft parked · ticket · add-cache");
    // live-turn trailing rows — labelled like a finished answer, so the label
    // does not appear out of nowhere when the turn ends.
    expect(f).toContain("junco: thinking about it");
    expect(f).toContain("type a message"); // composer placeholder (blurred still renders)
    // #471: the in-pane hint row is gone — the two-row footer says the keys
    // with keycaps — and its one non-duplicate, the scroll status, moved to
    // the header's right edge.
    expect(f).not.toContain("i compose");
    expect(f).not.toContain("↑/↓ scroll · ⇞⇟ page");
    expect(f).toMatch(/paused · \d+–\d+\/\d+/);
  });

  // The window indicator is the view's only live scroll feedback; #471 keeps
  // it (and the follow state) on EVERY frame, composing or not.
  it("the header's scroll status shows on both follow states and while composing", async () => {
    const summary = summarizeTranscript([
      metaLine({ ticketId: "acme__api" }),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      turnEndFull({ thinking: null, text: "because of X", calls: [] }),
      agentEnd(),
      chatTurnEnd(),
    ]);
    const frameOf = (over: Parameters<typeof base>[0]) => {
      const r = render(
        <ChatView
          state={base({ summary, ...over })}
          modelId={null}
          chatTodayUsd={null}
          scroll={0}
          height={20}
          width={100}
          focused
          highlight={null}
          onComposerChange={() => {}}
          onComposerSubmit={() => {}}
        />,
      );
      return r;
    };
    const composing = frameOf({ composerFocused: true, follow: true });
    await until(() => /following · \d+–\d+\/\d+/.test(composing.lastFrame() ?? ""));
    const blurred = frameOf({ composerFocused: false, follow: false });
    await until(() => /paused · \d+–\d+\/\d+/.test(blurred.lastFrame() ?? ""));
    // Nothing else is left of the old hint row. (`ctrl+j newline` is not a
    // marker for it: the Composer's own placeholder says that too.)
    expect(blurred.lastFrame()).not.toContain("↑/↓ scroll · ⇞⇟ page");
    expect(composing.lastFrame()).not.toContain("esc blur");
  });

  // Spec 2026-09-03 §4.3 + #471: the hint row that used to carry the card's
  // keys is gone (the footer's chatConfirm row carries them), so what the view
  // itself must still say about a waiting card is the header word.
  it("a pending submit says so in the header and advertises no draft verbs", async () => {
    const r = render(
      <ChatView
        state={base({
          composerFocused: false,
          pending: {
            commandId: "call_1",
            draftId: "acme__api-20260901-120000-1",
            ids: ["add-readme"],
            route: "inbox",
            running: false,
          },
        })}
        modelId={null}
        chatTodayUsd={null}
        scroll={0}
        height={20}
        width={100}
        focused
        highlight={null}
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => (r.lastFrame() ?? "").includes("◐ awaiting your confirmation"));
    const f = r.lastFrame()!;
    expect(f).not.toContain("s submit · e edit");
    expect(f).not.toContain("y submit · n keep parked"); // the footer's row now
  });

  it("shows the overflow note and disables the composer when the daemon is down", async () => {
    const r = render(
      <ChatView
        state={base({ connection: "down", overflowed: true })}
        modelId={null}
        chatTodayUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        highlight={null}
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
    // #471: the key text moved out of the pane entirely — the footer says it.
    expect(f).not.toContain("esc blur/abort");
    expect(f).toContain("daemon down — chat unavailable"); // composer disabledReason (down)
  });

  it("the composer's disabled line names the daemon's reason too (R32)", async () => {
    const r = render(
      <ChatView
        state={base({ connection: "down", downReason: "chat_disabled" })}
        modelId={null}
        chatTodayUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        highlight={null}
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
        chatTodayUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        highlight={null}
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
        chatTodayUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        highlight={null}
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
        chatTodayUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        highlight={null}
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => r.lastFrame()!.includes("connecting…"));
    expect(r.lastFrame()).toContain("connecting…");
  });

  it("no live turn adds no trailing row", async () => {
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
        state={base({ summary, live: null })}
        modelId="m"
        chatTodayUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        highlight={null}
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => r.lastFrame()!.includes("done"));
    expect(r.lastFrame()).not.toContain("thinking about it");
  });

  // Spec 2026-09-06 §4.1: a flush re-renders only the live rows. The finished
  // rows memo is keyed on [summary, pinned, expanded, width] — `live` and
  // `frame` are NOT inputs — so pushing a second live frame re-renders
  // TranscriptBody (the window changed) but never re-runs renderTranscriptRows
  // over the history.
  describe("with JUNCO_RENDER_COUNT=1", () => {
    const ORIGINAL_FLAG = process.env.JUNCO_RENDER_COUNT;
    afterEach(() => {
      if (ORIGINAL_FLAG === undefined) delete process.env.JUNCO_RENDER_COUNT;
      else process.env.JUNCO_RENDER_COUNT = ORIGINAL_FLAG;
      resetRenderCounts();
    });

    it("a second live frame re-renders TranscriptBody but not the finished rows", async () => {
      process.env.JUNCO_RENDER_COUNT = "1";
      resetRenderCounts();
      const summary = summarizeTranscript([
        metaLine(),
        chatPrompt(),
        chatTurnStart(),
        agentStart(),
        turnEndFull({ text: "done" }),
        agentEnd(),
        chatTurnEnd(),
        chatPrompt({ text: "more?" }),
        chatTurnStart(),
      ]);
      const expanded = new Set<string>();
      const live = (text: string, seq: number) => ({
        turn: "t1",
        seq,
        blocks: [{ kind: "text" as const, contentIndex: 0, text }],
        expanded: new Set<string>(),
        dropped: 0,
      });
      const props = {
        modelId: "m",
        chatTodayUsd: null,
        scroll: 0,
        height: 20,
        width: 80,
        focused: true,
        highlight: null,
        onComposerChange: () => {},
        onComposerSubmit: () => {},
      };
      const r = render(
        <ChatView
          {...props}
          state={base({ summary, expanded, streaming: true, live: live("first", 1), frame: 1 })}
        />,
      );
      await until(() => r.lastFrame()!.includes("junco: first"));
      const bodyBefore = renderCounts().TranscriptBody ?? 0;
      expect(bodyBefore).toBeGreaterThan(0);
      expect(renderCounts().FinishedTurns).toBe(1);
      r.rerender(
        <ChatView
          {...props}
          state={base({
            summary,
            expanded,
            streaming: true,
            live: live("first and then some more", 2),
            frame: 2,
          })}
        />,
      );
      await until(() => r.lastFrame()!.includes("junco: first and then some more"));
      expect(renderCounts().TranscriptBody).toBeGreaterThan(bodyBefore);
      expect(renderCounts().FinishedTurns).toBe(1);
      expect(r.lastFrame()).toContain("junco: done"); // the history is still there
    });

    it("a streaming thinking block and a tool block render their header rows", async () => {
      const summary = summarizeTranscript([metaLine(), chatPrompt(), chatTurnStart()]);
      const r = render(
        <ChatView
          state={base({
            summary,
            streaming: true,
            live: {
              turn: "t1",
              seq: 3,
              blocks: [
                {
                  kind: "thinking",
                  contentIndex: 0,
                  text: "let me see",
                  done: false,
                  startedAt: "2026-09-06T00:00:00.000Z",
                },
                {
                  kind: "tool",
                  id: "c1",
                  name: "read",
                  args: { path: "x" },
                  output: "",
                  result: null,
                  isError: false,
                  truncated: false,
                  done: false,
                },
                { kind: "text", contentIndex: 1, text: "so far" },
              ],
              expanded: new Set(),
              dropped: 0,
            },
          })}
          modelId="m"
          chatTodayUsd={null}
          scroll={0}
          height={20}
          width={80}
          focused
          highlight={null}
          onComposerChange={() => {}}
          onComposerSubmit={() => {}}
        />,
      );
      await until(() => r.lastFrame()!.includes("junco: so far"));
      const f = r.lastFrame()!;
      // A fixed, day-old startedAt: the elapsed prints through fmtDuration.
      expect(f).toMatch(/· thinking · \d+h\d+m/);
      expect(f).toContain("▸ read x");
    });
  });

  // Spec 2026-09-06 §4.4 (D6): one card per tool block — header with the
  // call, a spinner while it runs and the streamed tail under it; `✓`/`✗`
  // when done with a summary row, or the capped body when expanded.
  describe("tool cards", () => {
    const props = {
      modelId: "m",
      chatTodayUsd: null,
      scroll: 0,
      height: 24,
      width: 80,
      focused: true,
      highlight: null,
      onComposerChange: () => {},
      onComposerSubmit: () => {},
    };
    const summary = () => summarizeTranscript([metaLine(), chatPrompt(), chatTurnStart()]);
    type Tool = Extract<NonNullable<ChatState["live"]>["blocks"][number], { kind: "tool" }>;
    const tool = (over: Partial<Tool> = {}): Tool => ({
      kind: "tool",
      id: "c1",
      name: "bash",
      args: { command: "npm test" },
      output: "",
      result: null,
      isError: false,
      truncated: false,
      done: false,
      ...over,
    });
    const liveWith = (blocks: Tool[], expanded: string[] = []): NonNullable<ChatState["live"]> => ({
      turn: "t1",
      seq: 3,
      blocks,
      expanded: new Set(expanded),
      dropped: 0,
    });
    const view = (state: ChatState) => render(<ChatView {...props} state={state} />);
    const SPIN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

    it("running: header with a spinner and the last six output lines, dim and indented", async () => {
      const out = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n");
      const r = view(
        base({
          summary: summary(),
          streaming: true,
          composerFocused: false,
          follow: false,
          live: liveWith([tool({ output: out })]),
        }),
      );
      await until(() => SPIN.test(r.lastFrame() ?? ""));
      const f = r.lastFrame()!;
      const head = f.split("\n").find((l) => l.includes("▸ bash npm test"))!;
      expect(head).toMatch(SPIN);
      expect(f).toContain("▌"); // the live card is the cursor's anchor
      expect(f).not.toContain("line 3");
      expect(f).toContain("    line 4");
      expect(f).toContain("    line 9");
      expect(f).not.toContain("→ ");
    });

    it("done and collapsed: ✓ in the header and one summary row, no body", async () => {
      const r = view(
        base({
          summary: summary(),
          streaming: true,
          live: liveWith([tool({ done: true, result: "a\nb\nc", output: "a\nb\nc" })]),
        }),
      );
      await until(() => r.lastFrame()!.includes("▸ bash npm test  ✓"));
      const f = r.lastFrame()!;
      expect(f).toContain("→ 3 lines");
      expect(f).not.toMatch(SPIN);
      expect(f).not.toMatch(/^\s+a$/m);
    });

    it("done and expanded: the result body under the header, with a … row when truncated", async () => {
      const r = view(
        base({
          summary: summary(),
          streaming: true,
          live: liveWith(
            [tool({ done: true, result: "a\nb", output: "", truncated: true })],
            ["c1"],
          ),
        }),
      );
      await until(() => r.lastFrame()!.includes("▸ bash npm test  ✓"));
      const f = r.lastFrame()!;
      expect(f).toContain("      a");
      expect(f).toContain("      b");
      expect(f).toContain("… (truncated)");
      expect(f).not.toContain("→ 2 lines");
    });

    it("an error: ✗ header and the body open by default; the toggle collapses it", async () => {
      const err = tool({ id: "e1", done: true, isError: true, result: "boom: bad\nmore" });
      const r = view(base({ summary: summary(), streaming: true, live: liveWith([err]) }));
      await until(() => r.lastFrame()!.includes("▸ bash npm test  ✗"));
      expect(r.lastFrame()!).toContain("      boom: bad");
      expect(r.lastFrame()!).toContain("      more");
      const folded = view(
        base({ summary: summary(), streaming: true, live: liveWith([err], ["e1"]) }),
      );
      await until(() => folded.lastFrame()!.includes("▸ bash npm test  ✗"));
      expect(folded.lastFrame()!).toContain("→ ✗ boom: bad");
      expect(folded.lastFrame()!).not.toContain("      more");
    });
  });

  // Spec 2026-09-06 §4.3 (D4): the four live states, then a finished turn
  // whose text still carries the tags.
  describe("thinking block", () => {
    const props = {
      modelId: "m",
      chatTodayUsd: null,
      scroll: 0,
      height: 20,
      width: 80,
      focused: true,
      highlight: null,
      onComposerChange: () => {},
      onComposerSubmit: () => {},
    };
    const summary = () => summarizeTranscript([metaLine(), chatPrompt(), chatTurnStart()]);
    const liveWith = (
      blocks: NonNullable<ChatState["live"]>["blocks"],
    ): NonNullable<ChatState["live"]> => ({
      turn: "t1",
      seq: 3,
      blocks,
      expanded: new Set(),
      dropped: 0,
    });
    const think = (done: boolean, ageMs = 3000) =>
      ({
        kind: "thinking" as const,
        contentIndex: 0,
        text: "let me see\nwhat this does",
        done,
        startedAt: new Date(Date.now() - ageMs).toISOString(),
      }) as const;
    const answer = { kind: "text" as const, contentIndex: 1, text: "so far" };
    const view = (state: ChatState) => render(<ChatView {...props} state={state} />);

    it("streaming: `· thinking · <elapsed>s` header plus the body, wrapped plain and indented", async () => {
      const r = view(
        base({ summary: summary(), streaming: true, live: liveWith([think(false), answer]) }),
      );
      await until(() => r.lastFrame()!.includes("junco: so far"));
      const f = r.lastFrame()!;
      // 3 s old at mount; the clock may tick once before the frame is read.
      expect(f).toMatch(/· thinking · [34]s/);
      expect(f).toContain("  let me see");
      expect(f).toContain("  what this does");
      expect(f).not.toContain("▸ thinking");
    });

    it("done and unpinned: one collapsed `▸ thinking · <dur>s` row, no body", async () => {
      const r = view(
        base({ summary: summary(), streaming: true, live: liveWith([think(true), answer]) }),
      );
      await until(() => r.lastFrame()!.includes("junco: so far"));
      const f = r.lastFrame()!;
      expect(f).toMatch(/▸ thinking · [34]s/);
      expect(f).not.toContain("let me see");
      expect(f).not.toContain("· thinking ·");
    });

    it("done and pinned: `▾ thinking · <dur>s` with the body kept", async () => {
      const r = view(
        base({
          summary: summary(),
          streaming: true,
          thinking: { pinned: true },
          live: liveWith([think(true), answer]),
        }),
      );
      await until(() => r.lastFrame()!.includes("junco: so far"));
      const f = r.lastFrame()!;
      expect(f).toMatch(/▾ thinking · [34]s/);
      expect(f).toContain("  let me see");
    });

    it("no thinking block: no header at all (D2)", async () => {
      const r = view(
        base({
          summary: summary(),
          streaming: true,
          thinking: { pinned: true },
          live: liveWith([answer]),
        }),
      );
      await until(() => r.lastFrame()!.includes("junco: so far"));
      expect(r.lastFrame()).not.toContain("thinking");
    });

    it("a finished turn with <think> in its text is split at render time; t pins the body", async () => {
      const done = summarizeTranscript([
        metaLine(),
        chatPrompt(),
        chatTurnStart(),
        agentStart(),
        turnEndFull({ thinking: null, text: "<think>weighing it</think>\nThe answer", calls: [] }),
        agentEnd(),
        chatTurnEnd(),
      ]);
      const r = view(base({ summary: done }));
      await until(() => r.lastFrame()!.includes("junco: The answer"));
      let f = r.lastFrame()!;
      expect(f).toContain("▸ thinking");
      expect(f).not.toContain("weighing it");
      expect(f).not.toContain("<think>");
      r.rerender(
        <ChatView {...props} state={base({ summary: done, thinking: { pinned: true } })} />,
      );
      await until(() => r.lastFrame()!.includes("weighing it"));
      f = r.lastFrame()!;
      expect(f).toContain("▾ thinking");
      expect(f).toContain("junco: The answer");
    });
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
        rows={arrayRows(rows)}
        anchors={["c1"]}
        cursor={0}
        follow={false}
        reveal={false}
        scroll={0}
        visible={2}
        focused
        onScrollMax={onScrollMax}
        onRowPress={onRowPress}
      />,
    );
    expect(onScrollMax).toHaveBeenCalledWith(maxScroll(rows.length, 2));
  });

  // The window used to nudge itself onto the cursor's anchor on EVERY render,
  // which was right while ↑/↓ moved the cursor and wrong once they scrolled
  // rows: any scroll that took the anchor off screen snapped straight back
  // to it (PgUp from the tail landed on the first card; ↓ then did nothing).
  const FORTY: TranscriptRow[] = Array.from({ length: 40 }, (_, i) =>
    i === 3 ? { text: "card", anchor: "d1" } : { text: `row ${i}` },
  );
  const base = {
    rows: arrayRows(FORTY),
    anchors: ["d1"],
    cursor: 0,
    follow: false,
    visible: 10,
  };

  it("bodyWindow nudges onto the cursor's anchor only while a reveal is owed", () => {
    expect(bodyWindow({ ...base, scroll: 20, reveal: false }).start).toBe(20);
    expect(bodyWindow({ ...base, scroll: 20, reveal: true }).start).toBe(3);
    // Following ignores the reveal: the tail is the tail.
    expect(bodyWindow({ ...base, scroll: 20, reveal: true, follow: true }).start).toBe(30);
    // An anchor already in view needs no nudge either way.
    expect(bodyWindow({ ...base, scroll: 2, reveal: true }).start).toBe(2);
  });

  it("TranscriptBody hands the revealed start to onReveal once, after painting it", async () => {
    const onReveal = vi.fn();
    const r = render(
      <TranscriptBody {...base} scroll={20} reveal={true} focused onReveal={onReveal} />,
    );
    await until(() => onReveal.mock.calls.length === 1);
    expect(onReveal).toHaveBeenCalledWith(3);
    expect(r.lastFrame()).toContain("card"); // the nudged window, not row 20
    // The parent commits the start and clears the flag. That render paints the
    // SAME window from `scroll` alone — by design there is nothing to see —
    // so what proves the flag is off is the next scroll: the card's row
    // leaves the window instead of being snapped back onto, and no second
    // ack ever fired.
    r.rerender(<TranscriptBody {...base} scroll={3} reveal={false} focused onReveal={onReveal} />);
    r.rerender(<TranscriptBody {...base} scroll={25} reveal={false} focused onReveal={onReveal} />);
    await until(() => r.lastFrame()!.includes("row 25"));
    expect(r.lastFrame()).not.toContain("card");
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  // Spec 2026-09-06 §4.1: the finished rows and the live rows reach the body
  // as ONE lazy source — no per-frame copy of a thousand finished rows.
  it("concatRows exposes both halves without copying and finds anchors across the boundary", () => {
    const a: TranscriptRow[] = [{ text: "a0" }, { text: "a1", anchor: "x" }, { text: "a2" }];
    const b: TranscriptRow[] = [{ text: "b0", anchor: "y" }, { text: "b1" }];
    const src = concatRows(a, b);
    expect(src.length).toBe(5);
    expect(src.at(0)).toBe(a[0]);
    expect(src.at(2)).toBe(a[2]);
    expect(src.at(3)).toBe(b[0]);
    expect(src.at(4)).toBe(b[1]);
    expect(src.anchorRow("x")).toBe(1);
    expect(src.anchorRow("y")).toBe(3);
    expect(src.anchorRow("nope")).toBe(-1);
    // The first row carrying an anchor wins, as findIndex did.
    const dup = concatRows(
      [
        { text: "p", anchor: "z" },
        { text: "q", anchor: "z" },
      ],
      [],
    );
    expect(dup.anchorRow("z")).toBe(0);
    // The anchor index is memoized by the finished array's identity: a second
    // source over the same `a` reuses it (observable only as "still right"
    // after the live half changes — the index never covers `b`).
    const src2 = concatRows(a, [{ text: "live", anchor: "w" }]);
    expect(src2.anchorRow("x")).toBe(1);
    expect(src2.anchorRow("y")).toBe(-1);
    expect(src2.anchorRow("w")).toBe(3);
    expect(src2.length).toBe(4);
    // arrayRows is the single-array adapter for the other callers.
    const one = arrayRows(b);
    expect(one.length).toBe(2);
    expect(one.at(1)).toBe(b[1]);
    expect(one.anchorRow("y")).toBe(0);
  });

  it("bodyWindow reveals an anchor that lives in the live half", () => {
    const finished: TranscriptRow[] = Array.from({ length: 30 }, (_, i) => ({ text: `f${i}` }));
    const live: TranscriptRow[] = [{ text: "card", anchor: "d9" }, { text: "tail" }];
    const rows = concatRows(finished, live);
    const w = bodyWindow({
      rows,
      anchors: ["d9"],
      cursor: 0,
      follow: false,
      reveal: true,
      scroll: 0,
      visible: 10,
    });
    expect(w.start).toBe(21); // anchor row 30, window of 10 → 21..31
    expect(w.end).toBe(31);
    expect(w.anchorId).toBe("d9");
  });
});

// Task 14 (spec 2026-09-06 §4.2): chat answers — finished and live — are
// typeset as markdown, code fences through the injected highlighter. The
// fake marks every line so the frame proves it ran; the ANSI it emits is
// stripped before asserting (ink-testing-library's lastFrame keeps escapes).
describe("ChatView markdown answers (spec 2026-09-06 §4.2)", () => {
  const MD = "# Title\n\nSome **bold** text\n\n- a\n- b\n\n```ts\nconst x = 1;\n```";
  const fake = (code: string, lang: string | null) =>
    lang === null ? null : code.split("\n").map((l) => `\x1b[1m«${l}»\x1b[0m`);
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
  const props = {
    modelId: "m",
    chatTodayUsd: null,
    scroll: 0,
    height: 30,
    width: 80,
    focused: true,
    highlight: null,
    onComposerChange: () => {},
    onComposerSubmit: () => {},
  };
  const finished = () =>
    summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      turnEndFull({ thinking: null, text: MD, calls: [] }),
      agentEnd(),
      chatTurnEnd(),
    ]);
  const live = (text: string, seq: number) => ({
    turn: "t1",
    seq,
    blocks: [{ kind: "text" as const, contentIndex: 0, text }],
    expanded: new Set<string>(),
    dropped: 0,
  });

  it("a finished turn: heading row, bullets, and fence lines through the highlighter", async () => {
    const r = render(
      <ChatView {...props} state={base({ summary: finished() })} highlight={fake} />,
    );
    await until(() => strip(r.lastFrame() ?? "").includes("«const x = 1;»"));
    const f = strip(r.lastFrame()!);
    expect(f).toContain("junco:");
    expect(f).toContain("  Title");
    expect(f).not.toContain("# Title");
    expect(f).toContain("Some bold text");
    expect(f).not.toContain("**");
    expect(f).toContain("• a");
    expect(f).toContain("• b");
  });

  it("a live text block renders the same way, and a null highlighter shows the raw fence", async () => {
    const summary = summarizeTranscript([metaLine(), chatPrompt(), chatTurnStart()]);
    const r = render(
      <ChatView
        {...props}
        state={base({ summary, streaming: true, live: live(MD, 1), frame: 1 })}
        highlight={fake}
      />,
    );
    await until(() => strip(r.lastFrame() ?? "").includes("«const x = 1;»"));
    const f = strip(r.lastFrame()!);
    expect(f).toContain("  Title");
    expect(f).not.toContain("# Title");
    expect(f).toContain("• a");
    const plain = render(
      <ChatView
        {...props}
        state={base({ summary, streaming: true, live: live(MD, 1), frame: 1 })}
        highlight={null}
      />,
    );
    await until(() => (plain.lastFrame() ?? "").includes("const x = 1;"));
    expect(strip(plain.lastFrame()!)).not.toContain("«");
  });

  describe("with JUNCO_RENDER_COUNT=1", () => {
    const ORIGINAL_FLAG = process.env.JUNCO_RENDER_COUNT;
    afterEach(() => {
      if (ORIGINAL_FLAG === undefined) delete process.env.JUNCO_RENDER_COUNT;
      else process.env.JUNCO_RENDER_COUNT = ORIGINAL_FLAG;
      resetRenderCounts();
    });

    it("FinishedTurns renders once across two live markdown frames", async () => {
      process.env.JUNCO_RENDER_COUNT = "1";
      resetRenderCounts();
      const summary = finished();
      const expanded = new Set<string>();
      const r = render(
        <ChatView
          {...props}
          state={base({
            summary,
            expanded,
            streaming: true,
            live: live("# Live\n\nfirst", 1),
            frame: 1,
          })}
          highlight={fake}
        />,
      );
      await until(() => strip(r.lastFrame() ?? "").includes("  first"));
      expect(renderCounts().FinishedTurns).toBe(1);
      r.rerender(
        <ChatView
          {...props}
          state={base({
            summary,
            expanded,
            streaming: true,
            live: live("# Live\n\nfirst and then\n\n```ts\nlet y;\n```", 2),
            frame: 2,
          })}
          highlight={fake}
        />,
      );
      await until(() => strip(r.lastFrame() ?? "").includes("«let y;»"));
      expect(strip(r.lastFrame()!)).toContain("first and then");
      expect(renderCounts().FinishedTurns).toBe(1);
    });
  });
});
