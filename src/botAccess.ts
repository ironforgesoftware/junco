/**
 * Repo access classification + bot grant (spec
 * docs/superpowers/specs/2026-07-15-bot-repo-access-design.md).
 *
 * classifyRepoAccess decides which PR flow an unwatched repo takes under the
 * identity the given cfg carries (bot when `ghAuth` is attached, ambient
 * otherwise): push access → direct branches; public without push → fork mode;
 * private without push → blocked (grant or SSO guidance). A 404 is treated as
 * private-and-invisible: callers reach classification only after an AMBIENT
 * read of the repo succeeded, and GitHub deliberately 404s private repos to
 * non-members.
 */

import type { Config } from "./types.js";
import { gh } from "./git.js";
import { withBotAuth } from "./ghAuth.js";

export type RepoAccess =
  | { mode: "direct" }
  | { mode: "fork" }
  | { mode: "blocked"; reason: "no-access" | "sso" };

export interface BotAccessDeps {
  ghFn?: typeof gh;
  withBotAuthFn?: (cfg: Config) => Promise<Config>;
  /** Backoff between invitation-accept retries (tests pass ~1ms). */
  retryDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

/** Substring gh surfaces when a token lacks SSO authorization for an org. */
export const SAML_MARKER = "SAML enforcement";

const PUSH_LEVELS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);
const GH_TIMEOUT = 30_000;

export async function classifyRepoAccess(
  cfg: Config,
  nwo: string,
  deps: BotAccessDeps = {},
): Promise<RepoAccess> {
  const ghFn = deps.ghFn ?? gh;
  const r = await ghFn(cfg, ["repo", "view", nwo, "--json", "viewerPermission,isPrivate"], {
    check: false,
    timeoutMs: GH_TIMEOUT,
    retryNetwork: true,
  });
  if (r.code !== 0) {
    if (r.stderr.includes(SAML_MARKER)) return { mode: "blocked", reason: "sso" };
    return { mode: "blocked", reason: "no-access" };
  }
  let parsed: { viewerPermission: string | null; isPrivate: boolean };
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed;
  } catch {
    return { mode: "blocked", reason: "no-access" };
  }
  if (parsed.viewerPermission !== null && PUSH_LEVELS.has(parsed.viewerPermission)) {
    return { mode: "direct" };
  }
  return parsed.isPrivate ? { mode: "blocked", reason: "no-access" } : { mode: "fork" };
}

const firstLine = (s: string): string => (s.split("\n")[0] ?? "").slice(0, 200);

const ssoMessage = (nwo: string): string =>
  `the bot's token is blocked by SAML enforcement for ${nwo} — authorize gh for the org in the bot's browser session, then retry`;

/**
 * Grant the bot write access to `nwo` using both identities junco holds:
 * invite as the operator (ambient cfg — needs admin on the repo), accept as
 * the bot (GH_CONFIG_DIR via the attached context), then verify. Idempotent:
 * an already-collaborator invite (HTTP 204, empty body) skips straight to
 * verification. Human-triggered surfaces only — the daemon never calls this.
 */
export async function grantBotAccess(
  cfg: Config,
  nwo: string,
  deps: BotAccessDeps = {},
): Promise<{ login: string }> {
  const ghFn = deps.ghFn ?? gh;
  const sleep = deps.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retryDelayMs = deps.retryDelayMs ?? 1500;

  if (!cfg.botAccount.enabled) {
    throw new Error("junco auth grant needs botAccount.enabled — run: junco auth login first");
  }
  const botCfg = await (deps.withBotAuthFn ?? ((c: Config) => withBotAuth(c)))(cfg);
  // withBotAuth throws when enabled-but-unauthed, so ghAuth is present here.
  const login = botCfg.ghAuth!.login;

  // 1. Invite as the operator. gh api prints the response body: HTTP 201
  //    (invitation created) has a JSON body; HTTP 204 (already a collaborator)
  //    has none — empty stdout is the idempotent-success discriminator.
  const invite = await ghFn(
    cfg,
    ["api", `repos/${nwo}/collaborators/${login}`, "-X", "PUT", "-f", "permission=push"],
    { check: false, timeoutMs: GH_TIMEOUT, retryNetwork: true },
  );
  if (invite.code !== 0) {
    if (invite.stderr.includes(SAML_MARKER)) throw new Error(ssoMessage(nwo));
    if (invite.stderr.includes("HTTP 403")) {
      throw new Error(
        `granting on ${nwo} needs admin — ask an org admin, or org policy forbids outside ` +
          `collaborators (${firstLine(invite.stderr)})`,
      );
    }
    throw new Error(`invite failed for ${nwo}: ${firstLine(invite.stderr)}`);
  }

  // 2. Accept as the bot (invitation propagation can lag — bounded retry).
  if (invite.stdout.trim() !== "") {
    let accepted = false;
    for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs);
      // No --paginate: multi-page output is concatenated JSON arrays (unparseable).
      // per_page=100 covers gh's default 30-item page, which a busy bot account
      // with >30 pending invitations would otherwise blow past.
      const list = await ghFn(botCfg, ["api", "/user/repository_invitations?per_page=100"], {
        check: false,
        timeoutMs: GH_TIMEOUT,
        retryNetwork: true,
      });
      if (list.code !== 0) continue;
      let invitations: Array<{ id: number; repository: { full_name: string } }>;
      try {
        invitations = JSON.parse(list.stdout) as typeof invitations;
      } catch {
        continue;
      }
      const match = invitations.find(
        (i) => i.repository.full_name.toLowerCase() === nwo.toLowerCase(),
      );
      if (!match) continue;
      const accept = await ghFn(
        botCfg,
        ["api", `/user/repository_invitations/${match.id}`, "-X", "PATCH"],
        {
          check: false,
          timeoutMs: GH_TIMEOUT,
          retryNetwork: true,
        },
      );
      accepted = accept.code === 0;
    }
    if (!accepted) {
      throw new Error(
        `invitation for ${nwo} was created but could not be accepted — accept it manually as ` +
          `${login}, or re-run: junco auth grant ${nwo}`,
      );
    }
  }

  // 3. Verify as the bot. The canonical SAML-org case lands here, not at the
  // invite/accept steps above: the operator's PUT and the bot's PATCH both
  // succeed (the accept endpoint is user-scoped), and it's this repo-view
  // call — under the bot's own identity — that first hits the SAML wall.
  const access = await classifyRepoAccess(botCfg, nwo, deps);
  if (access.mode === "blocked" && access.reason === "sso") {
    throw new Error(ssoMessage(nwo));
  }
  if (access.mode !== "direct") {
    throw new Error(
      `grant did not take effect on ${nwo} (bot access: ${access.mode}) — re-run: junco auth grant ${nwo}`,
    );
  }
  return { login };
}
