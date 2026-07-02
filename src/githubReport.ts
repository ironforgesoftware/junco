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
import { lifecycleLabels } from "./githubInbox.js";
import { gh } from "./git.js";
import { log } from "./logging.js";

/** GitHub's hard cap is 65,536 chars; leave headroom for the truncation note. */
export const COMMENT_LIMIT = 60_000;

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

  return {
    async onStart(t: Ticket): Promise<void> {
      if (!t.github) return;
      const g = t.github;
      await guard("onStart", t.id, () => swap(g, ll.working, ll.queued));
    },
    async onRequeue(t: Ticket): Promise<void> {
      if (!t.github) return;
      const g = t.github;
      await guard("onRequeue", t.id, () => swap(g, ll.queued, ll.working));
    },
    async onFinal(t: Ticket, outcome: TicketOutcome): Promise<void> {
      if (!t.github) return;
      const g = t.github;
      // Comment first — it is the valuable artifact; the label is cosmetic.
      await guard("final comment", t.id, async () => {
        const body = buildFinalComment(t, outcome);
        const dir = mkdtempSync(join(tmpdir(), "junco-ghc-"));
        const file = join(dir, "comment.md");
        writeFileSync(file, body, "utf8");
        try {
          await ghFn(
            cfg,
            ["issue", "comment", String(g.issue), "--repo", g.nwo, "--body-file", file],
            { timeoutMs: GH_TIMEOUT, retryNetwork: true },
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
      const done = TERMINAL_DONE_STATUSES.has(outcome.status);
      await guard("final labels", t.id, () => swap(g, done ? ll.done : ll.failed, ll.working));
    },
  };
}
