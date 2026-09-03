import { useCallback, useEffect, useMemo } from "react";
import type { MutableRefObject } from "react";
import type { Key } from "ink";
import type { DashboardClient } from "../ghClient.js";
import type { ToastKind } from "../theme.js";
import type { View } from "../App.js";
import type { ChatApi } from "./useChat.js";
import type { ChatDraftActions } from "./useChatDrafts.js";
import type { PendingDraft } from "../../chat/draftStore.js";

export interface ChatInputDeps {
  /** Nav spine, read-only (App owns it) — the cascade is inert off the view.
   * The PANE is deliberately not an input: the chat view is full-screen and
   * owns its keys by view alone, so the pane the operator came from stays
   * untouched for `esc` to return them to (QA 2026-09-03 — every door used
   * to force pane 2 and `close` left it there). */
  view: View;
  chatApi: ChatApi;
  chatDraftActions: ChatDraftActions;
  /** For /pr and /issue — prContext/issueContext only. */
  client: DashboardClient;
  aliveRef: MutableRefObject<boolean>;
  showToast: (kind: ToastKind, text: string) => void;
  /** The watched nwo behind the selected row; /pr and /issue need it. */
  currentNwo: string | undefined;
  setView: (v: View) => void;
  scrollBy: (delta: number) => void;
  scrollTo: (offset: number) => void;
  toEnd: () => void;
  /** Body rows the transcript window shows — `ChatView`'s own
   * `chatVisibleRows(height)`, so PgUp/PgDn move exactly one screen. */
  visibleRows: number;
}

export interface ChatInputApi {
  /** True when the chat view consumed the key: App's cascade must return. */
  handleChatKey(input: string, key: Key): boolean;
  /** The `chat` context's slice of the id-keyed action table (viewActions.ts's
   * VIEW_OPTIONS.chat) — the footer chips dispatch here too. */
  chatHandlers: Record<string, () => void>;
  /** ChatView's composer submit: the slash router, or a plain prompt. */
  onComposerSubmit(raw: string): void;
  /** ChatView's scrollbar click/drag: jump to an absolute row offset. Stable
   * (ChatView is memoized) and follow-pausing — a jump under `follow` would
   * otherwise snap straight back to the tail. */
  onScrollTo(offset: number): void;
  /** ChatView's reveal ack: the window painted a cursor move's nudge at
   * `start` — commit it as the scroll offset and clear the owed reveal, so the
   * next render paints the same window from `scroll` alone. Stable. */
  onReveal(start: number): void;
}

/** A slash command's issue/PR number: digits and nothing else, so `/pr 7abc`
 * (which `parseInt` would happily read as 7) gets the usage toast instead of a
 * fetch for a number the operator never typed. */
function issueNumber(arg: string | undefined): number | null {
  return arg !== undefined && /^\d+$/.test(arg) ? Number.parseInt(arg, 10) : null;
}

/**
 * The chat view's input half (Ruling R15), lifted out of App so the nav spine
 * keeps only the wiring: the esc state machine and the blurred key recipes
 * (spec 2026-09-01 §8.3, whose movement recipe and pane doors the chat-scroll
 * brief of 2026-09-02 supersedes — ↑/↓ scroll, `tab` walks the cards, and
 * there is no door to the rail), the draft-card verbs (§8.6), and the
 * composer's slash router (§8.2).
 *
 * NOT to be confused with `../viewActions.ts`, which derives WHICH key means
 * which verb; this hook is what those verbs do.
 */
export function useChatInput({
  view,
  chatApi,
  chatDraftActions,
  client,
  aliveRef,
  showToast,
  currentNwo,
  setView,
  scrollBy,
  scrollTo,
  toEnd,
  visibleRows,
}: ChatInputDeps): ChatInputApi {
  // `chatApi` is a fresh object every render; every memo/callback below closes
  // over these members (each a stable useCallback, or a value that genuinely
  // changed) so their identities track real changes only.
  const {
    chat,
    abort,
    ackReveal,
    clearError,
    closeChat,
    focusComposer,
    fresh,
    moveCursor,
    selectedDraft,
    send,
    setFollow,
    toggleExpanded,
    toggleThinking,
  } = chatApi;
  const follow = chat?.follow ?? false;

  // Ruling R32: useChat records the last POST failure on `error`, and this
  // hook owns the toast, so this is where it becomes visible — a failed
  // send/abort/new was otherwise silent. Cleared straight after, so the SAME
  // message toasts again on the next failure instead of reading as unchanged.
  const error = chat?.error ?? null;
  useEffect(() => {
    if (error === null) return;
    showToast("error", error);
    clearError();
  }, [error, showToast, clearError]);

  const close = useCallback((): void => {
    closeChat();
    setView("main");
  }, [closeChat, setView]);

  const chatHandlers = useMemo((): Record<string, () => void> => {
    // The four draft verbs act on the card under the cursor; anywhere else in
    // the transcript there is nothing to act on, so they say so rather than
    // silently no-op (the review row's copies guard the same way).
    const onDraft = (fn: (d: PendingDraft) => Promise<void>) => (): void => {
      const d = selectedDraft();
      if (d) void fn(d);
      else showToast("info", "no draft under the cursor");
    };
    return {
      close,
      submit: onDraft(chatDraftActions.submit),
      edit: onDraft(chatDraftActions.edit),
      route: onDraft(chatDraftActions.route),
      discard: onDraft(chatDraftActions.discard),
      thinking: toggleThinking,
      follow: () => {
        // Pausing lands at the tail first (the transcript view's and the log
        // overlay's shared recipe, and `[` below): without it the window would
        // fall back to a stale offset — usually 0, i.e. a jump to the top.
        if (follow) toEnd();
        setFollow(!follow);
      },
    };
  }, [close, selectedDraft, showToast, chatDraftActions, toggleThinking, setFollow, follow, toEnd]);

  const onComposerSubmit = useCallback(
    (raw: string): void => {
      const text = raw.trim();
      // A bare `/` is the slash-list being dismissed, not a message: sending
      // it would spend a turn on a lone slash.
      if (text === "" || text === "/") return;
      const m = /^\/(\w+)(?:\s+(.*))?$/.exec(text);
      if (!m) return void send(text); // prose, including prose that opens with a path
      const [, cmd, arg] = m;
      switch (cmd) {
        case "draft":
          return void send(
            "Draft a junco ticket for what we just discussed. Emit it in a junco-ticket fence.",
          );
        case "audit":
          return void send(
            "Request a read-only audit of this repository: emit a junco-ticket fence whose frontmatter has an `audit:` block.",
          );
        case "investigate": {
          const n = issueNumber(arg);
          if (n === null) return void showToast("error", "usage: /investigate N");
          return void send(
            `Request an investigation of issue #${n}: emit a junco-ticket fence whose frontmatter has an \`investigate:\` block with \`issue: ${n}\`.`,
          );
        }
        case "pr":
        case "issue": {
          // Injected as a USER message: the fetch is the dashboard's (the
          // agent's tools are read-only and local), the agent only sees text.
          const n = issueNumber(arg);
          if (n === null || currentNwo === undefined)
            return void showToast("error", `usage: /${cmd} N (watched repo only)`);
          const nwo = currentNwo;
          void (cmd === "pr" ? client.prContext(nwo, n) : client.issueContext(nwo, n)).then((r) => {
            if (!aliveRef.current) return;
            if (!r.ok) return void showToast("error", r.error);
            void send(`Context, ${cmd === "pr" ? "PR" : "issue"} #${n} on ${nwo}:\n\n${r.value}`);
          });
          return;
        }
        case "abort":
          return void abort();
        case "new":
          return void fresh();
        default:
          showToast("error", `unknown command /${cmd}`);
      }
    },
    [send, abort, fresh, showToast, client, currentNwo, aliveRef],
  );

  const onScrollTo = useCallback(
    (offset: number): void => {
      setFollow(false);
      scrollTo(offset);
    },
    [setFollow, scrollTo],
  );
  // No `setFollow(false)` here: the cursor move that owed the reveal already
  // paused follow, and the ack must not re-touch state it did not change.
  const onReveal = useCallback(
    (start: number): void => {
      scrollTo(start);
      ackReveal();
    },
    [scrollTo, ackReveal],
  );

  /** Run one recipe and claim the key — the `return void f()` idiom of App's
   * own cascade, adapted to a handler that reports whether it consumed. */
  const took = (fn: () => void): true => {
    fn();
    return true;
  };

  const handleChatKey = (input: string, key: Key): boolean => {
    if (view !== "chat" || chat === null) return false;
    // One screen, minus a row of overlap so the line you were reading is
    // still on screen after the jump (`less`'s own page rule).
    const pageRows = Math.max(1, visibleRows - 1);
    /** Scrolling up pauses follow, landing at the tail first — the log
     * overlay's and the transcript view's shared recipe. Without the jump the
     * paused window would fall back to a stale offset, usually 0. */
    const scrollUp = (rows: number): void => {
      if (chat.follow) {
        toEnd();
        setFollow(false);
      }
      scrollBy(-rows);
    };
    // `composerFocused` alone is the condition: App mounts ChatView only
    // while it is the view and hands the Composer `focused` unconditionally,
    // so its useGuardedInput is live exactly when this flag is set. (The pane
    // used to be the other half, back when the rail doors could move it
    // under an open chat; the chat-scroll brief removed those doors.)
    if (chat.composerFocused) {
      // PgUp/PgDn are not text — the Composer ignores them (its typing branch
      // needs a non-empty `input`, and ink reports both as ""), so they stay
      // the transcript's page keys while the composer holds the focus: read
      // back over the conversation without blurring to do it.
      if (key.pageUp) return took(() => scrollUp(pageRows));
      if (key.pageDown) return took(() => scrollBy(pageRows));
      // The Composer's own useGuardedInput handles typing/enter/chords/slash.
      // Only esc is App's: streaming → abort, idle → blur (spec §8.3). Every
      // other key is swallowed so no cascade layer below sees typed prose.
      if (key.escape) {
        if (chat.streaming) void abort();
        else focusComposer(false);
      }
      return true;
    }
    // Blurred. Every key below is the CHAT's — the chat-scroll brief
    // (2026-09-02) removed the pane doors, so spec §8.1's "the rail is still
    // the nav spine" no longer holds here: the view is full-screen, the rail
    // is not painted, and a chat is opened fresh by `c`.
    if (key.escape) return took(close);
    if (input === "i") return took(() => focusComposer(true));
    // `tab` walks the CARDS (this brief supersedes spec §8.3's pane door):
    // ↑/↓ scroll now, so the anchor cursor needs a key of its own. Ink reports
    // shift+tab as `tab` with the shift modifier set. With no anchors
    // `moveCursor` simply has nowhere to go — a silent no-op, not a toast.
    if (key.tab)
      return took(() => {
        // A move that lands pauses follow (useChat.moveCursor), so the window
        // must be AT the tail first — the same recipe every scroll-up key
        // uses, or the paused window falls back to a stale offset. A move that
        // does not land leaves follow alone, and this jump is then a no-op:
        // the followed window is already at the tail.
        if (chat.follow) toEnd();
        moveCursor(key.shift ? -1 : 1);
      });
    if (key.return || input === " ") return took(toggleExpanded);
    // Chat-shaped scrolling (this brief supersedes spec §8.3's cursor
    // movement): the transcript is prose, so ↑/↓ walk it a row at a time —
    // `j`/`k` and `[`/`]` are aliases, and the cards move on `tab`.
    if (input === "j" || key.downArrow || input === "]") return took(() => scrollBy(1));
    if (input === "k" || key.upArrow || input === "[") return took(() => scrollUp(1));
    if (key.pageDown) return took(() => scrollBy(pageRows));
    if (key.pageUp) return took(() => scrollUp(pageRows));
    if (input === "G" || key.end) return took(() => setFollow(true));
    if (input === "g" || key.home)
      return took(() => {
        setFollow(false);
        scrollBy(-1_000_000); // clamps to 0
      });
    // The mnemonics (s/e/D/r/t/f/q) already dispatched at the cascade's
    // derived-keymap layer, ABOVE this call. Anything still here is unbound in
    // the chat view and must not fall through to the main-view tail.
    return true;
  };

  return { handleChatKey, chatHandlers, onComposerSubmit, onScrollTo, onReveal };
}
