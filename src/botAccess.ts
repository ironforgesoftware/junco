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
