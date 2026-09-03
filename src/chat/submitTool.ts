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
import type { DraftLookup, PendingDraft } from "./draftStore.js";
import { draftTicketIds } from "./submitArgv.js";
import type { SubmitRunResult } from "./submitExec.js";

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
export function effectiveRoute(d: PendingDraft, requested: SubmitRoute | undefined): SubmitRoute {
  if (requested !== undefined) return requested;
  if (d.routeOverride !== "auto") return d.routeOverride;
  return d.files[0]?.route?.destination === "issue" ? "issue" : "inbox";
}

const list = (ds: PendingDraft[]): string =>
  ds.map((d) => draftTicketIds(d).join(", ") || d.id).join("; ");

function resolveDraft(deps: SubmitToolDeps, ref: string | undefined): PendingDraft {
  const got = deps.findDraft(ref);
  if (!got.ok) {
    if (got.reason === "none")
      throw new Error("nothing is parked for this chat — draft a ticket first");
    if (got.reason === "unknown")
      throw new Error(`no parked draft named "${ref}" — parked: ${list(got.candidates)}`);
    throw new Error(`several drafts are parked — name one: ${list(got.candidates)}`);
  }
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
      const r = await deps.run(draft, route);
      const output = tail(r.output);
      if (r.code === 0 && r.archived) {
        deps.record({
          type: "junco_chat_draft",
          draftId: draft.id,
          kind: draft.kind,
          status: "submitted",
          ids,
          destination: route,
        });
        deps.record({ ...base, status: "ran", exitCode: 0, output, detail: null });
        return text(`submitted → ${route} · ${ids.join(", ")} (exit 0)\n${output}`.trimEnd());
      }
      const detail = r.detail ?? (r.timedOut ? "timed out" : null);
      deps.record({ ...base, status: "failed", exitCode: r.code, output, detail });
      return text(
        `submit failed (exit ${r.code ?? "?"})${detail ? ` — ${detail}` : ""} — the draft stays parked\n${output}`.trimEnd(),
      );
    },
  };
}
