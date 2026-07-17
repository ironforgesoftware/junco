/**
 * Dispatcher-requested issue linkage (`github_request:` frontmatter).
 *
 * A trusted local dispatcher (e.g. the junco-dispatch skill) may ask the
 * worker to create a tracking issue for a PR-flow ticket:
 *
 *   github_request:
 *     create_issue: true
 *
 * executeClaimed calls fulfillIssueRequest() after deriving the repo context
 * and BEFORE runPrFlow: the worker — under its own gh identity (the bot
 * account when configured; git.ts injects ghAuthEnv) — creates the issue on
 * the clone's origin repo, then stamps the regular worker-managed `github:`
 * provenance block into the claimed ticket file. Downstream needs no changes:
 * makePrBody adds `Closes nwo#N` (prFlow.ts) and the reporter posts lifecycle
 * feedback (githubReport.ts) off the stamped block. The on-disk stamp makes a
 * crash/requeue re-parse the link instead of double-creating.
 *
 * Everything here is BEST-EFFORT: every failure logs a warning and returns
 * null — the ticket still runs, just without issue linkage. Fork-push tickets
 * are skipped outright: repos the operator does not control get no
 * outward-facing writes beyond the PR itself (reporter `external` parity).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { git, gh } from "./git.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import { createIssueLive } from "./assessFiling.js";
import { upsertFrontmatterKey } from "./requeue.js";
import { parseTicket } from "./ticket.js";
import { log } from "./logging.js";
import type { Config, Ticket, TicketGithub } from "./types.js";
import type { RepoContext } from "./repoContext.js";

/** GitHub caps issue bodies at 65,536 chars; stay under with margin. */
const MAX_ISSUE_BODY = 60_000;

export interface IssueRequestDeps {
  gitFn?: typeof git;
  ghFn?: typeof gh;
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, content: string) => void;
}

/** First `# ` heading, for the issue title when pr_title is absent. */
function firstHeading(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

export async function fulfillIssueRequest(
  cfg: Config,
  ticket: Ticket,
  ctx: RepoContext,
  claimedPath: string,
  deps: IssueRequestDeps = {},
): Promise<TicketGithub | null> {
  const gitFn = deps.gitFn ?? git;
  const ghFn = deps.ghFn ?? gh;
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFileFn = deps.writeFileFn ?? ((p: string, c: string) => writeFileSync(p, c, "utf8"));

  if (!ticket.githubRequest?.createIssue) return null;
  // Already linked: a bridge/dispatch ticket, or a requeue after a prior
  // successful fulfillment (the stamp below survives on disk).
  if (ticket.github) return null;
  if (ctx.pushRemote !== "origin") {
    log.warn("github_request: fork-push ticket — skipping issue creation", { id: ticket.id });
    return null;
  }
  if (ctx.amendsPr !== null) {
    // Amend tickets never rebuild the PR body, so the Closes line — and with
    // it any hope of the issue auto-closing — can never land. Don't create
    // an issue nothing will ever close.
    log.warn("github_request: amend ticket — skipping issue creation", { id: ticket.id });
    return null;
  }

  let nwo: string | null = null;
  try {
    const remote = await gitFn(cfg, ["remote", "get-url", "origin"], { cwd: ctx.repo });
    nwo = remote.code === 0 ? nwoFromRemoteUrl(remote.stdout.trim()) : null;
  } catch (e) {
    log.warn("github_request: could not read origin remote — ticket runs unlinked", {
      id: ticket.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  if (!nwo) {
    log.warn("github_request: origin is not a parseable GitHub repo — skipping", { id: ticket.id });
    return null;
  }

  const title = ctx.prTitle ?? firstHeading(ticket.body) ?? ticket.id;
  const intro =
    "_Tracking issue created by junco for ticket `" +
    ticket.id +
    "`. A pull request will follow and close this issue on merge._";
  const body = intro + "\n\n" + ticket.body.trim().slice(0, MAX_ISSUE_BODY);

  let url: string | null = null;
  try {
    url = await createIssueLive(cfg, nwo, title, body, [], ghFn);
  } catch (e) {
    log.warn("github_request: issue creation failed — ticket runs unlinked", {
      id: ticket.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  const m = url ? /\/issues\/(\d+)(?:[/?#].*)?$/.exec(url.trim()) : null;
  if (!m) {
    log.warn("github_request: could not parse created issue URL — ticket runs unlinked", {
      id: ticket.id,
      url,
    });
    return null;
  }
  const meta: TicketGithub = { nwo, issue: Number(m[1]), kind: "pr", external: false };

  // Persist provenance so a crash/requeue never double-creates (requeueTicket
  // carries the claimed file's content back to inbox/). Defensive re-parse
  // mirrors requeueTicket (#108): malformed frontmatter accepts the textual
  // upsert but re-parses github: null — keep the in-memory link for THIS run
  // and leave the file untouched.
  try {
    const stampValue = `{nwo: ${JSON.stringify(meta.nwo)}, issue: ${meta.issue}, kind: pr}`;
    const stamped = upsertFrontmatterKey(readFileFn(claimedPath), "github", stampValue);
    if (parseTicket(claimedPath, stamped).github) writeFileFn(claimedPath, stamped);
    else
      log.warn(
        "github_request: malformed frontmatter — provenance not persisted (a requeue may double-create)",
        { id: ticket.id },
      );
  } catch (e) {
    log.warn("github_request: could not stamp provenance into the claimed ticket", {
      id: ticket.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  log.info("github_request: created tracking issue", {
    id: ticket.id,
    nwo,
    issue: meta.issue,
    url,
  });
  return meta;
}
