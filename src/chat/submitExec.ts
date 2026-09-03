/**
 * Runs the submit the operator just confirmed (spec 2026-09-03 §3.4): the
 * SAME argv the dashboard's `s` builds (submitArgv), the real CLI spawned
 * per file (cliSpawn.ts), first non-zero exit stops the sequence, archive on
 * success. The draft is re-read from disk first — the operator may have
 * pressed `s` in the meantime.
 */
import type { Config } from "../types.js";
import { spawnCli, type CliRunnerDeps } from "../cliSpawn.js";
import type { ReviewStoreDeps } from "../reviewStore.js";
import { archiveChatDraft, draftFilePath, readChatDraft, type PendingDraft } from "./draftStore.js";
import { submitArgv } from "./submitArgv.js";
import type { SubmitRoute } from "./submitTool.js";

export interface SubmitRunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  archived: boolean;
  detail: string | null;
}

export interface SubmitExecDeps extends CliRunnerDeps {
  store?: ReviewStoreDeps;
}

export async function runSubmit(
  cfg: Config,
  draft: PendingDraft,
  route: SubmitRoute,
  deps: SubmitExecDeps = {},
): Promise<SubmitRunResult> {
  const live = readChatDraft(cfg, draft.id, deps.store).entry;
  if (live === null)
    return {
      code: null,
      output: "",
      timedOut: false,
      archived: false,
      detail: "draft no longer parked",
    };
  const argvs = submitArgv({ ...live, routeOverride: route }, (name) =>
    draftFilePath(cfg, live.id, name),
  );
  if (argvs.length === 0)
    return {
      code: null,
      output: "",
      timedOut: false,
      archived: false,
      detail: "nothing to submit",
    };
  const chunks: string[] = [];
  for (const [i, argv] of argvs.entries()) {
    const r = await spawnCli(argv, deps);
    chunks.push(r.output);
    if (r.code !== 0) {
      // A ticket set submits one file per invocation; the earlier ones are
      // already queued and are not rolled back (chat spec §6.4).
      const detail = i > 0 ? `${i} of ${argvs.length} files submitted before a failure` : null;
      return {
        code: r.code,
        output: chunks.join(""),
        timedOut: r.timedOut,
        archived: false,
        detail,
      };
    }
  }
  const archived = archiveChatDraft(cfg, live.id, "submitted", deps.store);
  return {
    code: 0,
    output: chunks.join(""),
    timedOut: false,
    archived,
    detail: archived ? null : "submitted, but the draft did not archive",
  };
}
