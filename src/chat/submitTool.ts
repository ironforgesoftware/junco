/**
 * `junco_submit` — the chat model's one action tool (spec 2026-09-03 §3). It
 * submits an ALREADY-PARKED draft after the operator confirms in the
 * dashboard, blocking inside the model's turn so the model reports the real
 * outcome. SDK-free: the definition is a plain object with a plain
 * JSON-schema parameter block (the SDK's validator compiles plain JSON schema
 * — pi-ai/dist/utils/validation.js special-cases schemas without the TypeBox
 * Kind symbol), cast at the single SDK boundary (agent/session.ts) like the
 * sandbox tools. Every side effect is a dep the session binds
 * (chatSession.ts): draft lookup, the confirmation wait, the CLI run, the
 * transcript record.
 */
import type { ChatWriteRecord } from "./chatSession.js";
import { draftLookupError, type DraftLookup, type PendingDraft } from "./draftStore.js";
import { draftTicketIds } from "./submitArgv.js";
import { DRAFT_NOT_PARKED, type SubmitRunResult } from "./submitExec.js";

export const SUBMIT_TOOL_NAME = "junco_submit";
export type SubmitRoute = "inbox" | "issue";
export type Decision = "run" | "decline" | "aborted" | "expired";

export interface SubmitProposal {
  commandId: string;
  draftId: string;
  ids: string[];
  route: SubmitRoute;
}

export interface SubmitToolDeps {
  findDraft(ref: string | undefined): DraftLookup;
  /** Blocks until the operator decides, the turn aborts, or the confirm
   *  timeout elapses (chatSession.ts's confirmSubmit). */
  confirm(p: SubmitProposal, signal?: AbortSignal): Promise<Decision>;
  run(draft: PendingDraft, route: SubmitRoute): Promise<SubmitRunResult>;
  record(rec: ChatWriteRecord): void;
  confirmTimeoutMinutes: number;
}

/** The SDK's ToolDefinition, the parts junco fills — see
 * pi-coding-agent/dist/core/extensions/types.d.ts `ToolDefinition`. */
export interface ChatToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

const PARAMETERS = {
  type: "object",
  properties: {
    draft: {
      type: "string",
      description:
        "Which parked draft: its ticket id (the fence's `id:`) or its draft id. Omit when exactly one draft is parked.",
    },
    route: {
      type: "string",
      enum: ["inbox", "issue"],
      description:
        "Where it goes: `inbox` queues it for the worker now; `issue` parks it as an unlabeled GitHub issue for a human to label. Omit to keep the draft's own route.",
    },
  },
  additionalProperties: false,
} as const;

/** The route a submission takes when the model names none — the draft's
 * override, else the route decided at park time, else the inbox. */
function effectiveRoute(d: PendingDraft, requested: SubmitRoute | undefined): SubmitRoute {
  if (requested !== undefined) return requested;
  if (d.routeOverride !== "auto") return d.routeOverride;
  return d.files[0]?.route?.destination === "issue" ? "issue" : "inbox";
}

function resolveDraft(deps: SubmitToolDeps, ref: string | undefined): PendingDraft {
  const got = deps.findDraft(ref);
  // One rule, one wording: `findDraft` is findChatDraft (resolveDraftRef over
  // this chat's parked drafts) and the miss is worded by draftLookupError, the
  // same text the composer's `/submit` toasts (#480).
  if (!got.ok) throw new Error(draftLookupError(got, ref));
  const d = got.draft;
  if (d.lintFailed)
    throw new Error(
      `draft ${d.id} failed lint — the operator must edit it (e) or discard it first`,
    );
  if (d.blocked !== null)
    throw new Error(
      `draft ${d.id} is blocked (${d.blocked.replace(/_/g, " ")}) — it cannot be submitted`,
    );
  return d;
}

const OUTPUT_TAIL = 4096;
const tail = (s: string): string => (s.length <= OUTPUT_TAIL ? s : s.slice(s.length - OUTPUT_TAIL));

/** The clause a queued-but-unarchived submit adds to its result text.
 * `submitExec` phrases the detail as "submitted, but the draft did not
 * archive[: <err>]"; the head already says "submitted", so only the reason
 * is relayed. An unrecognised detail is passed through whole. */
function archiveClause(detail: string | null): string {
  const why = detail?.replace(/^submitted, but the draft did not archive(: )?/, "") ?? "";
  return ` — the draft did not archive${why === "" ? "" : ` (${why})`}; its card will still show as parked`;
}

export function makeSubmitTool(deps: SubmitToolDeps): ChatToolDefinition {
  const text = (
    t: string,
  ): { content: Array<{ type: "text"; text: string }>; details: unknown } => ({
    content: [{ type: "text" as const, text: t }],
    details: null,
  });
  return {
    name: SUBMIT_TOOL_NAME,
    label: "junco submit",
    description:
      "Submit a draft this chat already parked (a `junco-ticket` fence from an earlier turn) — to the inbox, or as a parked GitHub issue. The call BLOCKS until the operator confirms or declines in the dashboard; report exactly what it returns. Only when the operator asks to submit/queue/dispatch/send; never in the turn that drafts.",
    parameters: PARAMETERS,
    async execute(toolCallId, params, signal) {
      const p = (params ?? {}) as { draft?: unknown; route?: unknown };
      const ref = typeof p.draft === "string" && p.draft !== "" ? p.draft : undefined;
      const requested = p.route === "inbox" || p.route === "issue" ? p.route : undefined;
      const draft = resolveDraft(deps, ref);
      if (signal?.aborted)
        return text("aborted before the operator was asked — the draft stays parked");
      const route = effectiveRoute(draft, requested);
      const ids = draftTicketIds(draft);
      const base = {
        type: "junco_chat_command" as const,
        commandId: toolCallId,
        command: "submit" as const,
        draftId: draft.id,
        ids,
        route,
      };
      const settled = (status: "declined" | "expired" | "aborted", detail: string | null): void =>
        deps.record({ ...base, status, exitCode: null, output: null, detail });
      const decision = await deps.confirm(
        { commandId: toolCallId, draftId: draft.id, ids, route },
        signal,
      );
      if (decision === "decline") {
        settled("declined", null);
        return text("the operator declined — the draft stays parked");
      }
      if (decision === "expired") {
        settled("expired", `no decision in ${deps.confirmTimeoutMinutes}m`);
        return text(
          `no decision within ${deps.confirmTimeoutMinutes} minutes — the draft stays parked`,
        );
      }
      if (decision === "aborted") {
        settled("aborted", null);
        return text("the turn was aborted — the draft stays parked");
      }
      let r: SubmitRunResult;
      try {
        r = await deps.run(draft, route);
      } catch (e) {
        // A throw here would leave the proposal with NO terminal record: the
        // dashboard's card stays pending (spec §4.1) until a daemon restart
        // stamps it expired. Every executor failure closes the proposal
        // instead, with the same wording an exit-code failure gets (spec
        // §4.2's `failed` row: the draft stays parked).
        const detail = e instanceof Error ? e.message : String(e);
        deps.record({ ...base, status: "failed", exitCode: null, output: null, detail });
        return text(`submit failed — ${detail} — the draft stays parked`);
      }
      const output = tail(r.output);
      const detail = r.detail ?? (r.timedOut ? "timed out" : null);
      if (r.code === 0) {
        // Exit 0 means the CLI queued every file — the submission RAN even
        // when the ARCHIVE failed afterwards (`submitExec` never raises once
        // the files are queued: `archived: false` plus a detail). Reporting
        // that as `failed` told the model — which relays this text verbatim
        // — that a queued ticket had not been submitted, and the operator
        // then pressed `s` and got the CLI's "already queued" (final review
        // #2a). The draft JSON is still parked on disk in that case, so the
        // `junco_chat_draft{submitted}` note is NOT written: the card must
        // keep saying parked, and the text says so.
        if (r.archived)
          deps.record({
            type: "junco_chat_draft",
            draftId: draft.id,
            kind: draft.kind,
            status: "submitted",
            ids,
            destination: route,
          });
        deps.record({ ...base, status: "ran", exitCode: 0, output, detail });
        const head = `submitted → ${route} · ${ids.join(", ")} (exit 0)`;
        return text(`${r.archived ? head : head + archiveClause(detail)}\n${output}`.trimEnd());
      }
      deps.record({ ...base, status: "failed", exitCode: r.code, output, detail });
      if (r.code === null && r.detail === DRAFT_NOT_PARKED)
        // Nothing was spawned, and "the draft stays parked" would contradict
        // itself: the dashboard submitted or discarded it while the operator
        // was deciding (final review #2b).
        return text(
          "nothing ran — the draft is no longer parked (submitted or discarded from the dashboard meanwhile)",
        );
      return text(
        `submit failed (exit ${r.code ?? "?"})${detail ? ` — ${detail}` : ""} — the draft stays parked\n${output}`.trimEnd(),
      );
    },
  };
}
