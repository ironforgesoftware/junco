import { useCallback, useMemo } from "react";
import type { MutableRefObject } from "react";
import type { DashboardClient } from "../ghClient.js";
import type { CliRunResult } from "../cliRunner.js";
import type { PendingDraft } from "../../chat/draftStore.js";
import type { ToastKind } from "../theme.js";

export type RouteOverride = PendingDraft["routeOverride"];

export function nextRoute(r: RouteOverride): RouteOverride {
  return r === "auto" ? "inbox" : r === "inbox" ? "issue" : "auto";
}

/** One argv per CLI invocation, in order (spec §6.1 table, §6.4 override).
 * audit/investigate replay the argv derived at park time; every other kind
 * submits the file on disk, so the CLI does the routing and identity handling
 * exactly as it does for the skill. */
export function submitArgv(d: PendingDraft, filePath: (name: string) => string): string[][] {
  if (d.kind === "audit" || d.kind === "investigate") return d.commandArgs ? [d.commandArgs] : [];
  const asIssue = (f: PendingDraft["files"][number]): boolean =>
    d.routeOverride === "issue" || (d.routeOverride === "auto" && f.route?.destination === "issue");
  if (d.kind === "planSet") {
    const f = d.files[0]!;
    return [
      [
        "submit",
        ...(asIssue(f) ? ["--as-issue"] : []),
        "--plan",
        filePath(f.name),
        "--repo",
        d.cwd,
      ],
    ];
  }
  return d.files.map((f) => ["submit", ...(asIssue(f) ? ["--as-issue"] : []), filePath(f.name)]);
}

export interface ChatDraftActions {
  submit(d: PendingDraft): Promise<void>;
  edit(d: PendingDraft): Promise<void>;
  route(d: PendingDraft): Promise<void>;
  discard(d: PendingDraft): Promise<void>;
}

/**
 * The four draft verbs (spec 2026-09-01 §6.4, §6.6), shared by the chat
 * pane's card and the review row. Submit spawns the CLI verb — byte-identical
 * file, same routing code and identity handling as the skill — and on success
 * archives the draft and notes the transcript through the daemon.
 */
export function useChatDrafts(opts: {
  client: DashboardClient;
  runCliFn: (name: string, extraArgs: string[]) => Promise<CliRunResult>;
  showCmdResult: (name: string, extraArgs: string[], r: CliRunResult) => void;
  editFileFn: (path: string) => Promise<void>;
  suspend: <T>(fn: () => Promise<T>) => Promise<T>;
  showToast: (kind: ToastKind, text: string) => void;
  aliveRef: MutableRefObject<boolean>;
  onChanged: () => void;
  draftFilePath: (id: string, name: string) => string;
}): ChatDraftActions {
  const {
    client,
    runCliFn,
    showCmdResult,
    editFileFn,
    suspend,
    showToast,
    aliveRef,
    onChanged,
    draftFilePath,
  } = opts;

  const submit = useCallback(
    async (d: PendingDraft): Promise<void> => {
      if (d.lintFailed) return showToast("error", "draft failed lint — edit it first (e)");
      if (d.blocked) return showToast("error", `draft blocked: ${d.blocked.replace(/_/g, " ")}`);
      const argvs = submitArgv(d, (name) => draftFilePath(d.id, name));
      if (argvs.length === 0) return showToast("error", "nothing to submit");
      for (const [i, argv] of argvs.entries()) {
        const [name, ...extra] = argv;
        const r = await runCliFn(name!, extra);
        if (!aliveRef.current) return;
        if (r.code !== 0) {
          // A ticket set submits one file per invocation: the earlier ones are
          // already queued and are NOT rolled back (spec §6.4 — the first
          // non-zero exit stops the sequence, earlier results reported).
          if (i > 0) showToast("error", `${i} of ${argvs.length} submitted before a failure`);
          showCmdResult(name!, extra, r);
          return;
        }
      }
      // A draft still listed after a "submitted" toast invites a second
      // queue of the same work, so an archive failure is the whole story —
      // the transcript note (which says "submitted") waits for a clean one.
      const archived = await client.archiveSubmittedChatDraft(d.id);
      if (!aliveRef.current) return;
      if (!archived.ok)
        return showToast("error", `submitted, but the draft did not archive: ${archived.error}`);
      const destination =
        d.kind === "audit" || d.kind === "investigate"
          ? "command"
          : argvs[0]!.includes("--as-issue")
            ? "issue"
            : "inbox";
      // The submit happened; the draft is archived regardless of whether the
      // transcript note lands (spec §11) — a note failure is a toast, not a rollback.
      const noted = await client.chat.note(d.key, {
        type: "junco_chat_draft",
        draftId: d.id,
        kind: d.kind,
        status: "submitted",
        ids: d.files.map((f) => f.name.replace(/\.md$/, "")),
        destination,
      });
      if (!aliveRef.current) return;
      showToast(
        noted.ok ? "success" : "error",
        noted.ok
          ? `submitted → ${destination}`
          : `submitted → ${destination} (transcript note failed: ${noted.error})`,
      );
      onChanged();
    },
    [client, runCliFn, showCmdResult, showToast, aliveRef, onChanged, draftFilePath],
  );

  const edit = useCallback(
    async (d: PendingDraft): Promise<void> => {
      // Suspended: the editor owns the real terminal until every file is
      // closed; Ink repaints from an empty frame afterwards (useSuspend).
      await suspend(async () => {
        for (const f of d.files) await editFileFn(draftFilePath(d.id, f.name));
      });
      const r = await client.relintChatDraft(d.id);
      if (!aliveRef.current) return;
      if (!r.ok) return showToast("error", r.error);
      showToast(
        r.value.lintFailed ? "error" : "success",
        r.value.lintFailed ? "still failing lint" : "lint ok",
      );
      onChanged();
    },
    [client, editFileFn, suspend, showToast, aliveRef, onChanged, draftFilePath],
  );

  const route = useCallback(
    async (d: PendingDraft): Promise<void> => {
      const r = await client.updateChatDraft({ ...d, routeOverride: nextRoute(d.routeOverride) });
      if (!aliveRef.current) return;
      if (!r.ok) return showToast("error", r.error);
      onChanged();
    },
    [client, showToast, aliveRef, onChanged],
  );

  const discard = useCallback(
    async (d: PendingDraft): Promise<void> => {
      const r = await client.discardChatDraft(d.id);
      if (!aliveRef.current) return;
      if (!r.ok) return showToast("error", r.error);
      await client.chat.note(d.key, {
        type: "junco_chat_draft",
        draftId: d.id,
        kind: d.kind,
        status: "discarded",
        ids: [],
        destination: null,
      });
      showToast("success", "draft discarded");
      onChanged();
    },
    [client, showToast, aliveRef, onChanged],
  );

  return useMemo(() => ({ submit, edit, route, discard }), [submit, edit, route, discard]);
}
