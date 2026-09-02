/**
 * DashboardClient method bodies for /chat/* + the chat-draft review surface
 * (spec 2026-09-01 §7). Split out of ghClient.ts's makeGhDashboardClient
 * because that factory is pinned at 438 lines by eslint.config.js's
 * GRANDFATHERED_FUNCTION_LINES (#387) — every method here is spread into the
 * client object with one line at the call site instead of growing the
 * factory body. `attempt`, `ghFn`, `readFileFn`, `fetchFn`, and the computed
 * `healthBase` all belong to makeGhDashboardClient's closure and are passed
 * in rather than re-derived here.
 */
import type { gh } from "../git.js";
import type { Config, Result } from "../types.js";
import type { DashboardClient } from "./ghClient.js";
import { subscribeChat, postChat, type ChatSubscribeHandlers } from "./chatClient.js";
import {
  listChatDrafts,
  writeChatDraft,
  archiveChatDraft,
  draftFilePath,
  type PendingDraft,
} from "../chat/draftStore.js";
import type { ChatDraftRecord } from "../agent/transcriptSchema.js";

export interface ChatClientMethodDeps {
  attempt: <T>(fn: () => Promise<T>) => Promise<Result<T>>;
  ghFn: typeof gh;
  readFileFn: (p: string) => string;
  fetchFn: typeof fetch;
  healthBase: string;
  /** Deliberately shorter than git.ts's GH_TIMEOUT_MS — see ghClient.ts's own
   *  GH_TIMEOUT docstring; passed in rather than re-exported so ghClient.ts's
   *  public surface is unchanged (Ruling R15). */
  ghTimeoutMs: number;
}

const chatErr = (r: { status: number; body: unknown }): string => {
  const e = r.body && typeof r.body === "object" ? (r.body as { error?: string }).error : undefined;
  return e ?? `chat request failed (${r.status})`;
};

export function chatClientMethods(
  cfg: Config,
  deps: ChatClientMethodDeps,
): Pick<
  DashboardClient,
  | "chat"
  | "listChatDrafts"
  | "readChatDraftFile"
  | "updateChatDraft"
  | "discardChatDraft"
  | "archiveSubmittedChatDraft"
  | "prContext"
  | "issueContext"
> {
  const { attempt, ghFn, readFileFn, fetchFn, healthBase, ghTimeoutMs } = deps;

  return {
    chat: {
      subscribe(key: string, since: number | null, on: ChatSubscribeHandlers) {
        return subscribeChat(key, since, on, { fetchFn, baseUrl: healthBase });
      },
      prompt(key: string, text: string) {
        return attempt(async () => {
          const r = await postChat("prompt", { key, text }, { fetchFn, baseUrl: healthBase });
          if (r.status !== 202 && r.status !== 200) throw new Error(chatErr(r));
          return r.body as { mode: "prompt" | "steer" | "rejected" };
        });
      },
      abort(key: string) {
        return attempt(async () => {
          const r = await postChat("abort", { key }, { fetchFn, baseUrl: healthBase });
          if (r.status !== 202 && r.status !== 204) throw new Error(chatErr(r));
          return { aborted: r.status === 202 };
        });
      },
      fresh(key: string) {
        return attempt(async () => {
          const r = await postChat("new", { key }, { fetchFn, baseUrl: healthBase });
          if (r.status !== 202) throw new Error(chatErr(r));
          return null;
        });
      },
      note(key: string, record: Omit<ChatDraftRecord, "ts">) {
        return attempt(async () => {
          const r = await postChat("note", { key, record }, { fetchFn, baseUrl: healthBase });
          if (r.status !== 202) throw new Error(chatErr(r));
          return null;
        });
      },
    },
    listChatDrafts() {
      return attempt(async () => listChatDrafts(cfg));
    },
    readChatDraftFile(id: string, name: string) {
      return attempt(async () => readFileFn(draftFilePath(cfg, id, name)));
    },
    updateChatDraft(draft: PendingDraft) {
      return attempt(async () => {
        writeChatDraft(cfg, draft);
        return null;
      });
    },
    discardChatDraft(id: string) {
      return attempt(async () => {
        archiveChatDraft(cfg, id, "discarded");
        return null;
      });
    },
    archiveSubmittedChatDraft(id: string) {
      return attempt(async () => {
        archiveChatDraft(cfg, id, "submitted");
        return null;
      });
    },
    prContext(nwo: string, num: number) {
      return attempt(async () => {
        const v = await ghFn(
          cfg,
          ["pr", "view", String(num), "--repo", nwo, "--json", "title,body,reviews,comments"],
          { timeoutMs: ghTimeoutMs, retryNetwork: true },
        );
        const j = JSON.parse(v.stdout) as {
          title?: string;
          body?: string;
          reviews?: Array<{ author?: { login?: string }; state?: string; body?: string }>;
          comments?: Array<{ author?: { login?: string }; body?: string }>;
        };
        const lines = [`PR #${num}: ${j.title ?? ""}`, "", j.body ?? "", ""];
        for (const r of j.reviews ?? [])
          if (r.body)
            lines.push(`${r.author?.login ?? "?"} (${r.state ?? "COMMENTED"}): ${r.body}`);
        for (const c of j.comments ?? [])
          if (c.body) lines.push(`${c.author?.login ?? "?"}: ${c.body}`);
        return lines.join("\n").trim();
      });
    },
    issueContext(nwo: string, num: number) {
      return attempt(async () => {
        const v = await ghFn(
          cfg,
          ["issue", "view", String(num), "--repo", nwo, "--json", "title,body,comments"],
          { timeoutMs: ghTimeoutMs, retryNetwork: true },
        );
        const j = JSON.parse(v.stdout) as {
          title?: string;
          body?: string;
          comments?: Array<{ author?: { login?: string }; body?: string }>;
        };
        const lines = [`Issue #${num}: ${j.title ?? ""}`, "", j.body ?? "", ""];
        for (const c of j.comments ?? [])
          if (c.body) lines.push(`${c.author?.login ?? "?"}: ${c.body}`);
        return lines.join("\n").trim();
      });
    },
  };
}
