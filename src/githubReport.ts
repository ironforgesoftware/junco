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
import { tryOrEnqueue, withCommentMarker, type OutboxOp } from "./githubOutbox.js";

// COMMENT_LIMIT is defined in githubInbox.ts (buildPlanComment shares it);
// re-exported here so existing importers keep working without an import cycle.
export { COMMENT_LIMIT };

const GH_TIMEOUT = 60_000;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A generous excerpt of the agent's final message. First-paragraph-only
 * proved too narrow in practice (models often open with process narration
 * before the real summary), so include up to `cap` chars, cutting at the
 * last paragraph/word boundary. */
function excerpt(text: string, cap = 700): string {
  const t = text.trim();
  if (t.length <= cap) return t;
  const slice = t.slice(0, cap);
  const atPara = slice.lastIndexOf("\n\n");
  const atWord = slice.lastIndexOf(" ");
  const cut = atPara > cap * 0.4 ? atPara : atWord > 0 ? atWord : cap;
  return slice.slice(0, cut).trimEnd() + " …";
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
    const summary = excerpt(outcome.finalText);
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
  // Outbox-aware guard: on a network-shaped failure, fn's side effect is
  // parked in the durable outbox (op) instead of being lost; any other
  // failure keeps the old best-effort contract — warn and swallow, since a
  // stale label/lost comment is cosmetic.
  const guardOrQueue = async (
    label: string,
    id: string,
    op: OutboxOp,
    fn: () => Promise<void>,
  ): Promise<void> => {
    try {
      await tryOrEnqueue(cfg, "reporter", op, fn);
    } catch (e) {
      log.warn(`github reporter: ${label} failed (issue state on GitHub may be stale)`, {
        id,
        error: errMsg(e),
      });
    }
  };
  const postComment = async (g: TicketGithub, body: string): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "junco-ghc-"));
    const file = join(dir, "comment.md");
    // Embed the outbox idempotency marker (withCommentMarker) so a lost-ack
    // replay of the queued comment op is deduped by the next flush and never
    // double-posts this comment (#132).
    writeFileSync(file, withCommentMarker(g.nwo, g.issue, body), "utf8");
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
      // Plan-set children: per-child comments and label flips on the shared parent
      // issue would thrash (N children, one issue) and cascaded children never
      // reach this reporter at all — maintainPlanSets (planSetBridge.ts) recomputes
      // set state from the queue each sweep and owns ALL set-level issue traffic.
      if (t.plan && t.github) return;
      if (!t.github || t.github.external || t.github.kind === "plan") return; // planning label persists
      const g = t.github;
      await guardOrQueue(
        "onStart",
        t.id,
        { kind: "labels", nwo: g.nwo, issue: g.issue, add: [ll.working], remove: [ll.queued] },
        () => swap(g, ll.working, ll.queued),
      );
    },
    async onRequeue(t: Ticket): Promise<void> {
      // Plan-set children: per-child comments and label flips on the shared parent
      // issue would thrash (N children, one issue) and cascaded children never
      // reach this reporter at all — maintainPlanSets (planSetBridge.ts) recomputes
      // set state from the queue each sweep and owns ALL set-level issue traffic.
      if (t.plan && t.github) return;
      if (!t.github || t.github.external || t.github.kind === "plan") return;
      const g = t.github;
      await guardOrQueue(
        "onRequeue",
        t.id,
        { kind: "labels", nwo: g.nwo, issue: g.issue, add: [ll.queued], remove: [ll.working] },
        () => swap(g, ll.queued, ll.working),
      );
    },
    async onFinal(t: Ticket, outcome: TicketOutcome): Promise<void> {
      // Plan-set children: per-child comments and label flips on the shared parent
      // issue would thrash (N children, one issue) and cascaded children never
      // reach this reporter at all — maintainPlanSets (planSetBridge.ts) recomputes
      // set state from the queue each sweep and owns ALL set-level issue traffic.
      if (t.plan && t.github) return;
      if (!t.github || t.github.external) return;
      const g = t.github;
      if (g.kind === "plan") {
        const done = TERMINAL_DONE_STATUSES.has(outcome.status);
        // Prefer allText: the plan fence often precedes a trailing assistant
        // message, which #36 narrowed finalText to — so the fence survives only
        // in the whole-run text (#86, same class as the assess bug #67).
        const planBody = done ? extractPlanBody(outcome.allText ?? outcome.finalText) : null;
        const comment = planBody
          ? buildPlanComment(planBody, {
              issue: g.issue,
              trigger: cfg.github.triggerLabel,
              requireApproval: cfg.github.requireApproval,
            })
          : null;
        if (comment) {
          await guardOrQueue(
            "plan comment",
            t.id,
            { kind: "comment", nwo: g.nwo, issue: g.issue, body: comment },
            () => postComment(g, comment),
          );
          await guardOrQueue(
            "plan labels",
            t.id,
            {
              kind: "labels",
              nwo: g.nwo,
              issue: g.issue,
              add: [ll.planReady],
              remove: [ll.planning],
            },
            () => swap(g, ll.planReady, ll.planning),
          );
        } else {
          const reason = !done
            ? (outcome.failureReason ?? `status ${outcome.status}`)
            : planBody === null
              ? "planner produced no usable plan (missing/empty junco-ticket fence)"
              : "plan too large for an issue comment";
          const failureComment = `**Junco could not produce a plan** for this issue.\n\n> ${reason.slice(0, 1000)}\n\n_Remove the \`${ll.failed}\` label to re-plan._\n`;
          await guardOrQueue(
            "plan failure comment",
            t.id,
            { kind: "comment", nwo: g.nwo, issue: g.issue, body: failureComment },
            () => postComment(g, failureComment),
          );
          await guardOrQueue(
            "plan failure labels",
            t.id,
            { kind: "labels", nwo: g.nwo, issue: g.issue, add: [ll.failed], remove: [ll.planning] },
            () => swap(g, ll.failed, ll.planning),
          );
        }
        return;
      }
      if (outcome.prQueued) return; // composite outbox op owns comment + flip
      // pr/ask: comment first — it is the valuable artifact; the label is cosmetic.
      const finalComment = buildFinalComment(t, outcome);
      await guardOrQueue(
        "final comment",
        t.id,
        { kind: "comment", nwo: g.nwo, issue: g.issue, body: finalComment },
        () => postComment(g, finalComment),
      );
      const done = TERMINAL_DONE_STATUSES.has(outcome.status);
      const finalLabel = done ? ll.done : ll.failed;
      await guardOrQueue(
        "final labels",
        t.id,
        { kind: "labels", nwo: g.nwo, issue: g.issue, add: [finalLabel], remove: [ll.working] },
        () => swap(g, finalLabel, ll.working),
      );
    },
  };
}
