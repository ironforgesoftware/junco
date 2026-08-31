/**
 * Nudge templates — structured recovery messages junco sends to the agent
 * when a guard would otherwise trigger a hard kill.
 *
 * Ported from nudges.py. Wording is VERBATIM — do not rephrase, with one
 * exception: 2026-08-31, the tool_call_loop nudge's "mark the current todo
 * task complete" clause was reworded to drop the todo reference — todo_write
 * was removed from the agent layer (see prPrompt.ts) and there is no longer
 * a todo list for the agent to mark against.
 *
 * Used exclusively by Supervisor.decide(). Pure logic, no I/O.
 */

import type { GuardEvent } from "./supervisor.js";

/**
 * Render a structured nudge for one guard trip.
 *
 * kind ∈ {"tool_call_loop", "tool_error_loop", "text_rep", "thinking_rep", "output_budget"}.
 * Other kinds fall back to a generic template that quotes `detail`.
 */
export function buildNudgeMessage(
  kind: string,
  opts: {
    toolName?: string | null;
    count?: number | null;
    detail?: string;
  } = {},
): string {
  const { toolName, count, detail = "" } = opts;

  if (kind === "tool_call_loop") {
    const tn = toolName ?? "?";
    const cn = count ?? 0;
    return (
      `⚠️ JUNCO NOTICE: You've called \`${tn}\` ${cn}× consecutively with ` +
      `identical arguments. The prior result was already returned — ` +
      `calling again will not produce different output.\n\n` +
      `If the prior call's result said \`unchanged\` or \`created\`, the file ` +
      `is on disk and ready. Run \`git commit\` for this step and move on. ` +
      `If the prior call errored, change your ` +
      `approach — different args, different tool, or skip this step. ` +
      `Do NOT call \`${tn}\` with these args again.`
    );
  }

  if (kind === "tool_error_loop") {
    const tn = toolName ?? "?";
    const cn = count ?? 0;
    return (
      `⚠️ JUNCO NOTICE: \`${tn}\` has errored ${cn}× consecutively. Stop ` +
      `retrying — the error pattern is consistent. Either fix the ` +
      `underlying issue (different args, different tool, different ` +
      `approach) or note this step as blocked in your final summary ` +
      `and continue with what you can complete.`
    );
  }

  if (kind === "text_rep" || kind === "thinking_rep") {
    const which = kind === "thinking_rep" ? "thinking" : "text";
    return (
      `⚠️ JUNCO NOTICE: Your ${which} output is repeating the same ` +
      `paragraph. Take a different angle: skip ahead to the next ` +
      `concrete tool call (commit, write, edit) or output a one-line ` +
      `final summary if the work is done. Do not continue the current ` +
      `line of reasoning.`
    );
  }

  if (kind === "output_budget") {
    const cn = count ?? 0;
    return (
      `⚠️ JUNCO NOTICE: This turn produced ${cn.toLocaleString("en-US")} output tokens without ` +
      `a state-changing tool call (commit, write, or edit). The supervisor ` +
      `is killing the session — telling you to 'use fewer tokens' won't ` +
      `unstick a turn already this deep into runaway thinking. The ticket ` +
      `will land in failed/ with this trip as the phase_error; future ` +
      `tickets benefit from your one-line summary about what blocked you.`
    );
  }

  return `⚠️ JUNCO NOTICE: junco's supervisor flagged: ${detail || kind}. Adjust course.`;
}

/**
 * Convenience wrapper that takes a GuardEvent and dispatches to buildNudgeMessage.
 */
export function buildNudgeForGuardEvent(evt: GuardEvent): string {
  return buildNudgeMessage(evt.kind, {
    toolName: evt.trippedGuard.lastName,
    count: evt.trippedGuard.lastCount,
    detail: evt.detail,
  });
}
