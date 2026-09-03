/**
 * useChatInput (spec 2026-09-01 §8.3): the chat view's key cascade, its
 * id-keyed verbs, and the slash router. App wires these into its own cascade
 * (tests/tuiApp.chat.test.tsx covers the wiring through real frames); this
 * suite drives every branch directly against a fake ChatApi so the App-level
 * suite can stay small.
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Text, type Key } from "ink";
import {
  useChatInput,
  type ChatInputApi,
  type ChatInputDeps,
} from "../src/tui/hooks/useChatInput.js";
import type { ChatApi, ChatState } from "../src/tui/hooks/useChat.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { PendingDraft } from "../src/chat/draftStore.js";
import type { View } from "../src/tui/App.js";
import { okv, stubClient } from "./helpers/localFixtures.js";
import { until } from "./helpers/until.js";

const KEY_NAMES = [
  "upArrow",
  "downArrow",
  "leftArrow",
  "rightArrow",
  "pageDown",
  "pageUp",
  "home",
  "end",
  "return",
  "escape",
  "ctrl",
  "shift",
  "tab",
  "backspace",
  "delete",
  "meta",
  "super",
  "hyper",
  "capsLock",
  "numLock",
] as const;
/** A Key with every modifier false, then the caller's overrides. */
const K = (over: Partial<Key> = {}): Key =>
  ({ ...Object.fromEntries(KEY_NAMES.map((n) => [n, false])), ...over }) as Key;

const chatState = (over: Partial<ChatState> = {}): ChatState => ({
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
  composerFocused: false,
  cursor: 0,
  follow: false,
  reveal: false,
  showThinking: false,
  expanded: new Set(),
  lastOffset: null,
  error: null,
  pending: null,
  ...over,
});

const DRAFT: PendingDraft = {
  id: "d1",
  key: "acme/api",
  slug: "acme__api",
  kind: "ticket",
  files: [],
  cwd: "/r",
  nwo: "acme/api",
  createdAt: "t",
  lintFailed: false,
  blocked: null,
  routeOverride: "auto",
  commandArgs: null,
};

/** A parked draft with ONE file — `/submit`'s resolution reads both the draft
 * id and the file stem (draftStore.findChatDraft's rules, spec §3.1). */
const draftFixture = (id: string, file: string): PendingDraft => ({
  ...DRAFT,
  id,
  files: [{ name: file, content: "", lint: [], route: null, droppedKeys: [] }],
});

function mount(
  o: {
    chat?: ChatState | null;
    view?: View;
    currentNwo?: string;
    draft?: PendingDraft | null;
    prContextFails?: boolean;
    visibleRows?: number;
  } = {},
): { readonly api: ChatInputApi; calls: string[]; setChat: (c: ChatState | null) => void } {
  const calls: string[] = [];
  const rec = (s: string) => (): void => {
    calls.push(s);
  };
  const chatApi: ChatApi = {
    chat: o.chat === undefined ? chatState() : o.chat,
    openChat: (k) => void calls.push(`open:${k}`),
    closeChat: rec("closeChat"),
    send: async (t) => void calls.push(`send:${t}`),
    abort: async () => void calls.push("abort"),
    fresh: async () => void calls.push("fresh"),
    clearError: rec("clearError"),
    setComposer: () => {},
    focusComposer: (on) => void calls.push(`focus:${String(on)}`),
    moveCursor: (d) => void calls.push(`cursor:${d}`),
    ackReveal: rec("ackReveal"),
    toggleExpanded: rec("expand"),
    toggleThinking: rec("thinking"),
    setFollow: (on) => void calls.push(`follow:${String(on)}`),
    reloadDrafts: async () => {},
    selectedDraft: () => o.draft ?? null,
    decide: async (d) => void calls.push(`decide:${d}`),
  };
  const client: DashboardClient = {
    ...stubClient,
    prContext: async (nwo, n) =>
      o.prContextFails ? { ok: false, error: "gh boom" } : okv(`PR ${nwo}#${n} body`),
    issueContext: async (nwo, n) => okv(`ISSUE ${nwo}#${n} body`),
  };
  const deps: ChatInputDeps = {
    view: o.view ?? "chat",
    chatApi,
    chatDraftActions: {
      submit: async (d) => void calls.push(`submit:${d.id}`),
      edit: async (d) => void calls.push(`edit:${d.id}`),
      route: async (d) => void calls.push(`route:${d.id}`),
      discard: async (d) => void calls.push(`discard:${d.id}`),
    },
    client,
    aliveRef: { current: true },
    showToast: (kind, text) => void calls.push(`toast:${kind}:${text}`),
    currentNwo: o.currentNwo,
    setView: (v) => void calls.push(`view:${v}`),
    scrollBy: (d) => void calls.push(`scroll:${d}`),
    scrollTo: (o) => void calls.push(`scrollTo:${o}`),
    toEnd: rec("toEnd"),
    // A 10-row body ⇒ a page is 9 rows (visibleRows - 1, one row of overlap).
    visibleRows: o.visibleRows ?? 10,
  };
  const holder: { api: ChatInputApi | null } = { api: null };
  function Probe({ chat }: { chat: ChatState | null }): React.JSX.Element {
    holder.api = useChatInput({ ...deps, chatApi: { ...chatApi, chat } });
    return <Text>probe</Text>;
  }
  const { rerender } = render(<Probe chat={deps.chatApi.chat} />);
  return {
    get api(): ChatInputApi {
      return holder.api!;
    },
    calls,
    setChat: (c) => rerender(<Probe chat={c} />),
  };
}

describe("useChatInput — the cascade (spec §8.3)", () => {
  it("declines every key unless the chat view is open with a session", () => {
    expect(mount({ view: "main" }).api.handleChatKey("j", K())).toBe(false);
    expect(mount({ chat: null }).api.handleChatKey("j", K())).toBe(false);
  });

  it("focused: esc aborts a streaming turn, blurs an idle one, and every other key is the composer's", () => {
    const s = mount({ chat: chatState({ composerFocused: true, streaming: true }) });
    expect(s.api.handleChatKey("", K({ escape: true }))).toBe(true);
    expect(s.calls).toEqual(["abort"]);
    const i = mount({ chat: chatState({ composerFocused: true }) });
    i.api.handleChatKey("", K({ escape: true }));
    expect(i.calls).toEqual(["focus:false"]);
    // Typed prose is swallowed here (the Composer's own hook owns it) — it
    // must never reach the main-view tail of App's cascade.
    const t = mount({ chat: chatState({ composerFocused: true }) });
    expect(t.api.handleChatKey("q", K())).toBe(true);
    expect(t.calls).toEqual([]);
  });

  it("the composer owns the keys whenever it is focused — the pane is not consulted", () => {
    // The chat view is full-screen: ChatView is mounted only while it is the
    // view, and its Composer is live whenever `composerFocused`. The pane the
    // operator came from is not part of the condition (it used to be, which
    // is why every door forced pane 2 and `esc` left you on the issue list).
    const h = mount({ chat: chatState({ composerFocused: true }) });
    expect(h.api.handleChatKey("j", K())).toBe(true);
    h.api.handleChatKey("i", K());
    expect(h.calls).toEqual([]); // swallowed for the Composer's own hook; no pane change
  });

  it("blurred: ↑/↓ (and j/k, [/]) scroll the transcript a row at a time", () => {
    const h = mount();
    const api = h.api;
    api.handleChatKey("i", K());
    api.handleChatKey("j", K());
    api.handleChatKey("k", K());
    api.handleChatKey("", K({ downArrow: true }));
    api.handleChatKey("", K({ upArrow: true }));
    api.handleChatKey("]", K());
    api.handleChatKey("[", K());
    api.handleChatKey("", K({ return: true }));
    api.handleChatKey(" ", K());
    api.handleChatKey("G", K());
    api.handleChatKey("g", K());
    api.handleChatKey("", K({ end: true }));
    api.handleChatKey("", K({ home: true }));
    expect(h.calls).toEqual([
      "focus:true",
      "scroll:1",
      "scroll:-1",
      "scroll:1",
      "scroll:-1",
      "scroll:1",
      "scroll:-1",
      "expand",
      "expand",
      "follow:true",
      "follow:false",
      "scroll:-1000000",
      "follow:true",
      "follow:false",
      "scroll:-1000000",
    ]);
  });

  it("blurred: PgUp/PgDn move a page — visibleRows minus one row of overlap", () => {
    const h = mount();
    h.api.handleChatKey("", K({ pageDown: true }));
    h.api.handleChatKey("", K({ pageUp: true }));
    expect(h.calls).toEqual(["scroll:9", "scroll:-9"]);
    // A one-row body still pages by a row, never by zero.
    const tiny = mount({ visibleRows: 1 });
    tiny.api.handleChatKey("", K({ pageDown: true }));
    expect(tiny.calls).toEqual(["scroll:1"]);
  });

  it("blurred: scrolling up on a followed chat lands at the tail first, then steps", () => {
    for (const key of [K({ upArrow: true }), K({ pageUp: true })]) {
      const h = mount({ chat: chatState({ follow: true }) });
      h.api.handleChatKey("", key);
      expect(h.calls.slice(0, 2)).toEqual(["toEnd", "follow:false"]);
    }
    const h = mount({ chat: chatState({ follow: true }) });
    h.api.handleChatKey("[", K());
    expect(h.calls).toEqual(["toEnd", "follow:false", "scroll:-1"]);
  });

  it("a held k replayed inside one closure pauses once and then steps every press", () => {
    // useGuardedInput replays "kkk" as three calls against the SAME render,
    // where `chat.follow` still reads true: without the latch every pass
    // would land at the tail again and the burst would net one row.
    const h = mount({ chat: chatState({ follow: true }) });
    for (let i = 0; i < 3; i++) h.api.handleChatKey("k", K());
    expect(h.calls).toEqual(["toEnd", "follow:false", "scroll:-1", "scroll:-1", "scroll:-1"]);
    // And a replayed "ff" toggles twice — off (pausing at the tail), then on.
    const f = mount({ chat: chatState({ follow: true }) });
    f.api.chatHandlers["follow"]!();
    f.api.chatHandlers["follow"]!();
    expect(f.calls).toEqual(["toEnd", "follow:false", "follow:true"]);
  });

  it("blurred: tab walks the cards forward, shift+tab back", () => {
    const h = mount();
    h.api.handleChatKey("", K({ tab: true }));
    // Ink reports shift+tab as tab with the shift modifier set.
    h.api.handleChatKey("", K({ tab: true, shift: true }));
    expect(h.calls).toEqual(["cursor:1", "cursor:-1"]);
  });

  it("blurred: tab off a followed chat lands at the tail first, like every other pause", () => {
    // `moveCursor` pauses follow when it actually moves, and a paused window
    // falls back to the stored offset — 0 on a chat nobody has scrolled — so
    // the cursor key needs the same toEnd() recipe the scroll keys use.
    const h = mount({ chat: chatState({ follow: true }) });
    h.api.handleChatKey("", K({ tab: true }));
    expect(h.calls).toEqual(["toEnd", "cursor:1"]);
  });

  it("focused: PgUp/PgDn scroll the transcript — they are keys, not text", () => {
    const h = mount({ chat: chatState({ composerFocused: true }) });
    expect(h.api.handleChatKey("", K({ pageUp: true }))).toBe(true);
    h.api.handleChatKey("", K({ pageDown: true }));
    expect(h.calls).toEqual(["scroll:-9", "scroll:9"]);
    // …pausing follow first, exactly as the blurred recipe does.
    const f = mount({ chat: chatState({ composerFocused: true, follow: true }) });
    f.api.handleChatKey("", K({ pageUp: true }));
    expect(f.calls).toEqual(["toEnd", "follow:false", "scroll:-9"]);
  });

  it("blurred: esc leaves the view, and an unbound key is swallowed", () => {
    const h = mount();
    expect(h.api.handleChatKey("", K({ escape: true }))).toBe(true);
    expect(h.calls).toEqual(["closeChat", "view:main"]);
    // `:` would open the palette from the main-view tail of App's cascade.
    const p = mount();
    expect(p.api.handleChatKey(":", K())).toBe(true);
    expect(p.calls).toEqual([]);
  });

  it("onScrollTo (the scrollbar's jump) pauses follow before moving the window", () => {
    const h = mount({ chat: chatState({ follow: true }) });
    h.api.onScrollTo(12);
    // No `toEnd` here, unlike a step up: the offset IS the destination, so
    // landing at the tail first would only paint a frame nobody asked for.
    expect(h.calls).toEqual(["follow:false", "scrollTo:12"]);
  });

  it("onReveal (a painted cursor nudge) commits the start and acks, leaving follow alone", () => {
    const h = mount({ chat: chatState({ follow: false, reveal: true }) });
    h.api.onReveal(3);
    expect(h.calls).toEqual(["scrollTo:3", "ackReveal"]);
  });

  it("the pane doors are gone: h/l and ←/→ are swallowed, and the rail never moves", () => {
    // The chat view is full-screen with no rail painted, so there is nothing
    // to walk into: these keys are unbound here, and unbound means swallowed
    // (never falling through to the main-view tail of App's cascade).
    for (const [input, key] of [
      ["h", K()],
      ["l", K()],
      ["", K({ leftArrow: true })],
      ["", K({ rightArrow: true })],
    ] as const) {
      const h = mount();
      expect(h.api.handleChatKey(input, key)).toBe(true);
      expect(h.calls, input).toEqual([]);
    }
  });
  // Spec 2026-09-03 §4.3: while a junco_submit card waits, y/n answer it.
  // The draft verbs are unbound meanwhile (chatConfirm's EMPTY keymap, which
  // the cascade layer above this hook derives), so the same draft cannot be
  // submitted twice.
  it("blurred with a pending submit: y runs, n declines; nothing answers without a card", () => {
    const pending = { commandId: "c1", draftId: "d", ids: ["t"], route: "inbox" as const };
    const h = mount({ chat: chatState({ pending }) });
    h.api.handleChatKey("y", K());
    h.api.handleChatKey("n", K());
    expect(h.calls).toEqual(["decide:run", "decide:decline"]);
    // No card ⇒ y/n are unbound chat keys: consumed by the view, no decision.
    const idle = mount();
    expect(idle.api.handleChatKey("y", K())).toBe(true);
    idle.api.handleChatKey("n", K());
    expect(idle.calls).toEqual([]);
  });
});

describe("useChatInput — the verbs (spec §8.6)", () => {
  it("the draft verbs act on the card under the cursor", () => {
    const h = mount({ draft: DRAFT });
    for (const id of ["submit", "edit", "route", "discard"]) h.api.chatHandlers[id]!();
    expect(h.calls).toEqual(["submit:d1", "edit:d1", "route:d1", "discard:d1"]);
  });

  it("every draft verb with no card under the cursor toasts instead", () => {
    for (const id of ["submit", "edit", "route", "discard"]) {
      const h = mount({ draft: null });
      h.api.chatHandlers[id]!();
      expect(h.calls, id).toEqual(["toast:info:no draft under the cursor"]);
    }
  });

  it("a POST failure on the chat state is toasted once and then cleared (R32)", async () => {
    const h = mount();
    expect(h.calls).toEqual([]);
    h.setChat(chatState({ error: "no_checkout" }));
    await until(() => h.calls.includes("toast:error:no_checkout"));
    expect(h.calls).toEqual(["toast:error:no_checkout", "clearError"]);
    // Cleared, so the same message toasts again next time rather than being
    // swallowed as "unchanged".
    h.setChat(chatState({ error: null }));
    h.setChat(chatState({ error: "no_checkout" }));
    await until(() => h.calls.filter((c) => c.startsWith("toast:")).length === 2);
  });

  it("thinking, follow (pausing at the tail), and close", () => {
    const h = mount({ chat: chatState({ follow: true }) });
    h.api.chatHandlers["thinking"]!();
    h.api.chatHandlers["follow"]!();
    h.api.chatHandlers["close"]!();
    expect(h.calls).toEqual(["thinking", "toEnd", "follow:false", "closeChat", "view:main"]);
    // Resuming follow needs no jump — the window re-pins to the tail itself.
    const off = mount();
    off.api.chatHandlers["follow"]!();
    expect(off.calls).toEqual(["follow:true"]);
  });
});

describe("useChatInput — the slash router (spec §8.2)", () => {
  it("plain prose sends as-is; an empty composer — or a bare slash — sends nothing", () => {
    const h = mount();
    h.api.onComposerSubmit("  why is the build slow?  ");
    h.api.onComposerSubmit("   ");
    h.api.onComposerSubmit("/"); // the slash list, dismissed — not a message
    h.api.onComposerSubmit("  /  ");
    // Prose that merely opens with a path is still prose.
    h.api.onComposerSubmit("/usr/bin/env is missing");
    expect(h.calls).toEqual(["send:why is the build slow?", "send:/usr/bin/env is missing"]);
  });

  it("/draft, /audit and /investigate N send their standing requests", () => {
    const h = mount();
    h.api.onComposerSubmit("/draft");
    h.api.onComposerSubmit("/audit");
    h.api.onComposerSubmit("/investigate 7");
    expect(h.calls[0]).toMatch(/^send:Draft a junco ticket/);
    expect(h.calls[1]).toMatch(/junco-ticket fence whose frontmatter has an `audit:` block/);
    expect(h.calls[2]).toMatch(/`investigate:` block with `issue: 7`/);
  });

  it("/investigate without a number is a usage toast", () => {
    const h = mount();
    h.api.onComposerSubmit("/investigate");
    h.api.onComposerSubmit("/investigate soon");
    expect(h.calls).toEqual([
      "toast:error:usage: /investigate N",
      "toast:error:usage: /investigate N",
    ]);
  });

  it("/pr N and /issue N inject the fetched context as a user message", async () => {
    const h = mount({ currentNwo: "acme/api" });
    h.api.onComposerSubmit("/pr 42");
    await until(() => h.calls.length === 1);
    expect(h.calls[0]).toBe("send:Context, PR #42 on acme/api:\n\nPR acme/api#42 body");
    h.api.onComposerSubmit("/issue 9");
    await until(() => h.calls.length === 2);
    expect(h.calls[1]).toBe("send:Context, issue #9 on acme/api:\n\nISSUE acme/api#9 body");
  });

  it("/pr refuses a missing, non-numeric or unwatched target, and relays a fetch failure", async () => {
    const bad = mount({ currentNwo: "acme/api" });
    bad.api.onComposerSubmit("/pr");
    // Strictly digits: parseInt would read "7abc" as 7 and fetch a PR the
    // operator never asked for.
    bad.api.onComposerSubmit("/pr 7abc");
    bad.api.onComposerSubmit("/pr 7 8");
    const unwatched = mount();
    unwatched.api.onComposerSubmit("/pr 42");
    expect(bad.calls).toEqual(
      Array<string>(3).fill("toast:error:usage: /pr N (watched repo only)"),
    );
    expect(unwatched.calls).toEqual(["toast:error:usage: /pr N (watched repo only)"]);
    const boom = mount({ currentNwo: "acme/api", prContextFails: true });
    boom.api.onComposerSubmit("/pr 42");
    await until(() => boom.calls.length === 1);
    expect(boom.calls).toEqual(["toast:error:gh boom"]);
  });

  it("/issue refuses the same way (its own arm of the shared branch)", () => {
    const h = mount({ currentNwo: "acme/api" });
    h.api.onComposerSubmit("/issue");
    h.api.onComposerSubmit("/issue nine");
    const unwatched = mount();
    unwatched.api.onComposerSubmit("/issue 9");
    expect(h.calls).toEqual(
      Array<string>(2).fill("toast:error:usage: /issue N (watched repo only)"),
    );
    expect(unwatched.calls).toEqual(["toast:error:usage: /issue N (watched repo only)"]);
  });

  it("/abort and /new map to their verbs; an unknown command toasts", () => {
    const h = mount();
    h.api.onComposerSubmit("/abort");
    h.api.onComposerSubmit("/new");
    h.api.onComposerSubmit("/nope");
    expect(h.calls).toEqual(["abort", "fresh", "toast:error:unknown command /nope"]);
  });

  it("/submit submits the only parked draft through the card's path; names one by ticket id; refuses while pending", () => {
    const d1 = draftFixture("acme__api-1", "add-readme.md");
    const d2 = draftFixture("acme__api-2", "other.md");
    const one = mount({ chat: chatState({ drafts: [d1] }) });
    one.api.onComposerSubmit("/submit");
    expect(one.calls).toEqual(["submit:acme__api-1"]);
    const two = mount({ chat: chatState({ drafts: [d1, d2] }) });
    two.api.onComposerSubmit("/submit");
    expect(two.calls[0]).toMatch(/^toast:error:several drafts are parked/);
    two.api.onComposerSubmit("/submit other");
    expect(two.calls[1]).toBe("submit:acme__api-2");
    two.api.onComposerSubmit("/submit acme__api-1"); // by draft id too
    expect(two.calls[2]).toBe("submit:acme__api-1");
    two.api.onComposerSubmit("/submit nope");
    expect(two.calls[3]).toBe(
      'toast:error:no parked draft named "nope" — parked: add-readme; other',
    );
    const none = mount({ chat: chatState({ drafts: [] }) });
    none.api.onComposerSubmit("/submit");
    expect(none.calls).toEqual(["toast:error:nothing is parked — /draft first"]);
    const busy = mount({
      chat: chatState({
        drafts: [d1],
        pending: { commandId: "c", draftId: "acme__api-1", ids: ["add-readme"], route: "inbox" },
      }),
    });
    busy.api.onComposerSubmit("/submit");
    expect(busy.calls[0]).toMatch(/^toast:info:a submit is already awaiting/);
  });
});
