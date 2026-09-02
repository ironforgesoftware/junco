import { useCallback, useMemo } from "react";
import type { MutableRefObject } from "react";
import type { Key } from "ink";
import type { DashboardClient } from "../ghClient.js";
import type { ToastKind } from "../theme.js";
import type { Pane, View } from "../App.js";
import type { ChatApi } from "./useChat.js";
import type { ChatDraftActions } from "./useChatDrafts.js";
import type { PendingDraft } from "../../chat/draftStore.js";

export interface ChatInputDeps {
  /** Nav spine, read-only (App owns it) — the cascade is inert off the view. */
  view: View;
  pane: Pane;
  chatApi: ChatApi;
  chatDraftActions: ChatDraftActions;
  /** For /pr and /issue — prContext/issueContext only. */
  client: DashboardClient;
  aliveRef: MutableRefObject<boolean>;
  showToast: (kind: ToastKind, text: string) => void;
  /** The watched nwo behind the selected row; /pr and /issue need it. */
  currentNwo: string | undefined;
  setView: (v: View) => void;
  setPane: (p: Pane) => void;
  scrollBy: (delta: number) => void;
  toEnd: () => void;
  moveRail: (delta: number) => void;
  moveRailTo: (idx: number) => void;
  /** Rail row count — `G` from pane 1 lands on the last row. */
  railCount: number;
}

export interface ChatInputApi {
  /** True when the chat view consumed the key: App's cascade must return. */
  handleChatKey(input: string, key: Key): boolean;
  /** The `chat` context's slice of the id-keyed action table (viewActions.ts's
   * VIEW_OPTIONS.chat) — the footer chips dispatch here too. */
  chatHandlers: Record<string, () => void>;
  /** ChatView's composer submit: the slash router, or a plain prompt. */
  onComposerSubmit(raw: string): void;
}

/**
 * The chat view's input half (Ruling R15), lifted out of App so the nav spine
 * keeps only the wiring: the esc state machine and the blurred key recipes
 * (spec 2026-09-01 §8.3), the draft-card verbs (§8.6), and the composer's
 * slash router (§8.2).
 *
 * NOT to be confused with `../viewActions.ts`, which derives WHICH key means
 * which verb; this hook is what those verbs do.
 */
export function useChatInput({
  view,
  pane,
  chatApi,
  chatDraftActions,
  client,
  aliveRef,
  showToast,
  currentNwo,
  setView,
  setPane,
  scrollBy,
  toEnd,
  moveRail,
  moveRailTo,
  railCount,
}: ChatInputDeps): ChatInputApi {
  // `chatApi` is a fresh object every render; every memo/callback below closes
  // over these members (each a stable useCallback, or a value that genuinely
  // changed) so their identities track real changes only.
  const {
    chat,
    abort,
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
      if (text === "") return;
      const m = /^\/(\w+)(?:\s+(.*))?$/.exec(text);
      if (!m) return void send(text);
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
          const n = Number.parseInt(arg ?? "", 10);
          if (!Number.isInteger(n)) return void showToast("error", "usage: /investigate N");
          return void send(
            `Request an investigation of issue #${n}: emit a junco-ticket fence whose frontmatter has an \`investigate:\` block with \`issue: ${n}\`.`,
          );
        }
        case "pr":
        case "issue": {
          // Injected as a USER message: the fetch is the dashboard's (the
          // agent's tools are read-only and local), the agent only sees text.
          const n = Number.parseInt(arg ?? "", 10);
          if (!Number.isInteger(n) || currentNwo === undefined)
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

  /** Run one recipe and claim the key — the `return void f()` idiom of App's
   * own cascade, adapted to a handler that reports whether it consumed. */
  const took = (fn: () => void): true => {
    fn();
    return true;
  };

  const handleChatKey = (input: string, key: Key): boolean => {
    if (view !== "chat" || chat === null) return false;
    if (chat.composerFocused) {
      // The Composer's own useGuardedInput handles typing/enter/chords/slash.
      // Only esc is App's: streaming → abort, idle → blur (spec §8.3). Every
      // other key is swallowed so no cascade layer below sees typed prose.
      if (key.escape) {
        if (chat.streaming) void abort();
        else focusComposer(false);
      }
      return true;
    }
    // Blurred. The rail is still the nav spine (spec §8.1), so while pane 1
    // holds focus the movement keys drive the RAIL — App's rail-switch effect
    // then re-subscribes the chat to the newly selected row.
    if (pane === 1) {
      if (input === "j" || key.downArrow) return took(() => moveRail(1));
      if (input === "k" || key.upArrow) return took(() => moveRail(-1));
      if (input === "g") return took(() => moveRailTo(0));
      if (input === "G") return took(() => moveRailTo(railCount - 1));
    }
    if (key.escape) return took(close);
    if (input === "i") return took(() => focusComposer(true));
    // The pane doors: this view swallows ↑/↓ for its own cursor (as every
    // overlay does), so the rail needs an explicit way in and back out.
    if (input === "h" || key.leftArrow) return took(() => setPane(1));
    if (input === "l" || key.rightArrow) return took(() => setPane(2));
    if (input === "j" || key.downArrow) return took(() => moveCursor(1));
    if (input === "k" || key.upArrow) return took(() => moveCursor(-1));
    if (key.return || input === " ") return took(toggleExpanded);
    if (input === "]") return took(() => scrollBy(1));
    if (input === "[")
      return took(() => {
        // Scrolling up pauses follow, landing at the tail first — the log
        // overlay's and the transcript view's shared recipe.
        if (chat.follow) {
          toEnd();
          setFollow(false);
        }
        scrollBy(-1);
      });
    if (input === "G" || key.end) return took(() => setFollow(true));
    if (input === "g")
      return took(() => {
        setFollow(false);
        scrollBy(-1_000_000); // clamps to 0
      });
    // The mnemonics (s/e/D/r/t/f/q) already dispatched at the cascade's
    // derived-keymap layer, ABOVE this call. Anything still here is unbound in
    // the chat view and must not fall through to the main-view tail.
    return true;
  };

  return { handleChatKey, chatHandlers, onComposerSubmit };
}
