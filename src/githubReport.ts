/**
 * GitHub reporter — the feedback side of GitHub-integrated mode.
 *
 * Lifecycle labels are flipped silently; exactly ONE comment lands at
 * finalize (PR link + summary | the Q&A answer | the failure reason).
 * Everything is best-effort: a lost comment or stale label is cosmetic —
 * local done//failed/ and the PR itself are the source of truth.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TERMINAL_DONE_STATUSES, type Config, type Ticket, type TicketGithub } from "./types.js";
import type { TicketReporter, TicketOutcome } from "./reporter.js";
import {
  lifecycleLabels,
  extractPlanBody,
  buildPlanComment,
  COMMENT_LIMIT,
} from "./githubInbox.js";
import { gh } from "./git.js";
import { log } from "./logging.js";

// COMMENT_LIMIT is defined in githubInbox.ts (buildPlanComment shares it);
// re-exported here so existing importers keep working without an import cycle.
export { COMMENT_LIMIT };

const GH_TIMEOUT = 60_000;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function firstParagraph(text: string, cap = 600): string {
  const p =
    text
      .trim()
      .split(/\n\s*\n/)[0]
      ?.trim() ?? "";
  return p.length > cap ? p.slice(0, cap) + "…" : p;
}

export function buildFinalComment(ticket: Ticket, outcome: TicketOutcome): string {
  const parts: string[] = [];
  const done = TERMINAL_DONE_STATUSES.has(outcome.status);
  const transcriptPointer = `_Transcript on the worker host: \`transcripts/${ticket.id}.jsonl\` under the state dir._`;

  if (outcome.kind === "qa") {
    if (done) {
      parts.push(outcome.finalText.trim() || "_(no answer text)_");
    } else {
      parts.push(`**Junco could not answer this ticket** (status: \`${outcome.status}\`).`);
      if (outcome.failureReason) parts.push(`> ${outcome.failureReason.slice(0, 1000)}`);
      parts.push(transcriptPointer);
    }
  } else if (outcome.prUrl) {
    parts.push(`Opened ${outcome.prUrl}`);
    if (outcome.status === "timeout_partial" || outcome.status === "aborted_partial") {
      parts.push(
        "> ⚠️ **Partial run.** The session was cut off mid-work; commits made before the " +
          "cutoff were salvaged into the PR. Review for completeness.",
      );
    }
    const summary = firstParagraph(outcome.finalText);
    if (summary) parts.push(summary);
  } else if (done) {
    parts.push(`Finished with status \`${outcome.status}\` — no pull request was needed.`);
  } else {
    parts.push(`**Junco failed to produce a pull request** (status: \`${outcome.status}\`).`);
    if (outcome.failureReason) parts.push(`> ${outcome.failureReason.slice(0, 1000)}`);
    parts.push(transcriptPointer);
  }

  let text = parts.join("\n\n") + "\n";
  if (text.length > COMMENT_LIMIT) {
    text =
      text.slice(0, COMMENT_LIMIT) +
      "\n\n_… truncated — full text is in the finalized ticket file on the worker host._\n";
  }
  return text;
}

export interface GithubReporterDeps {
  ghFn?: typeof gh;
}

export function makeGithubReporter(cfg: Config, deps: GithubReporterDeps = {}): TicketReporter {
  const ghFn = deps.ghFn ?? gh;
  const ll = lifecycleLabels(cfg.github.triggerLabel);

  const swap = async (g: TicketGithub, add: string, remove: string): Promise<void> => {
    await ghFn(
      cfg,
      [
        "issue",
        "edit",
        String(g.issue),
        "--repo",
        g.nwo,
        "--add-label",
        add,
        "--remove-label",
        remove,
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
  };
  const guard = async (label: string, id: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      // Best-effort by contract: a stale label/lost comment is cosmetic.
      log.warn(`github reporter: ${label} failed (issue state on GitHub may be stale)`, {
        id,
        error: errMsg(e),
      });
    }
  };
  const postComment = async (g: TicketGithub, body: string): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "junco-ghc-"));
    const file = join(dir, "comment.md");
    writeFileSync(file, body, "utf8");
    try {
      await ghFn(cfg, ["issue", "comment", String(g.issue), "--repo", g.nwo, "--body-file", file], {
        timeoutMs: GH_TIMEOUT,
        retryNetwork: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  return {
    async onStart(t: Ticket): Promise<void> {
      if (!t.github || t.github.kind === "plan") return; // planning label persists
      const g = t.github;
      await guard("onStart", t.id, () => swap(g, ll.working, ll.queued));
    },
    async onRequeue(t: Ticket): Promise<void> {
      if (!t.github || t.github.kind === "plan") return;
      const g = t.github;
      await guard("onRequeue", t.id, () => swap(g, ll.queued, ll.working));
    },
    async onFinal(t: Ticket, outcome: TicketOutcome): Promise<void> {
      if (!t.github) return;
      const g = t.github;
      if (g.kind === "plan") {
        const done = TERMINAL_DONE_STATUSES.has(outcome.status);
        const planBody = done ? extractPlanBody(outcome.finalText) : null;
        const comment = planBody
          ? buildPlanComment(planBody, {
              issue: g.issue,
              trigger: cfg.github.triggerLabel,
              requireApproval: cfg.github.requireApproval,
            })
          : null;
        if (comment) {
          await guard("plan comment", t.id, () => postComment(g, comment));
          await guard("plan labels", t.id, () => swap(g, ll.planReady, ll.planning));
        } else {
          const reason = !done
            ? (outcome.failureReason ?? `status ${outcome.status}`)
            : planBody === null
              ? "planner produced no usable plan (missing/empty junco-ticket fence)"
              : "plan too large for an issue comment";
          await guard("plan failure comment", t.id, () =>
            postComment(
              g,
              `**Junco could not produce a plan** for this issue.\n\n> ${reason.slice(0, 1000)}\n\n_Remove the \`${ll.failed}\` label to re-plan._\n`,
            ),
          );
          await guard("plan failure labels", t.id, () => swap(g, ll.failed, ll.planning));
        }
        return;
      }
      // pr/ask: comment first — it is the valuable artifact; the label is cosmetic.
      await guard("final comment", t.id, () => postComment(g, buildFinalComment(t, outcome)));
      const done = TERMINAL_DONE_STATUSES.has(outcome.status);
      await guard("final labels", t.id, () => swap(g, done ? ll.done : ll.failed, ll.working));
    },
  };
}
