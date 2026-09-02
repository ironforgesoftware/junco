/**
 * Where a chat session runs (spec 2026-09-01 §2.2). Two branches: a watched
 * key resolves through the watchlist (every entry already carries a path —
 * the managed clone or the operator's checkout); a local key is an absolute
 * path the operator's own dashboard named, validated to be a git toplevel
 * outside the data tree. The result is stored in meta.json and re-resolved
 * on every open so a moved clone is picked up.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Config, GithubRepoMapping } from "../types.js";
import { git } from "../git.js";
import { resolveWatchedReposForPrs } from "../watchlist.js";
import { isWatchedKey } from "./chatKey.js";

export type ChatCwdError = "unknown_key" | "no_checkout" | "not_a_repo";

export interface ChatCwdDeps {
  existsFn?: (p: string) => boolean;
  realpathFn?: (p: string) => string;
  gitFn?: typeof git;
  /** The PR-listing set: fork (external:true) entries INCLUDED — chat is
   *  read-only, so the bridge's poll-injection exclusion does not apply. */
  watchedFn?: (cfg: Config) => GithubRepoMapping[];
}

export type ChatCwd =
  | { ok: true; cwd: string; kind: "watched" | "local"; nwo: string | null }
  | { ok: false; error: ChatCwdError };

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export async function resolveChatCwd(
  cfg: Config,
  key: string,
  deps: ChatCwdDeps = {},
): Promise<ChatCwd> {
  const existsFn = deps.existsFn ?? existsSync;
  if (isWatchedKey(key)) {
    const lower = key.toLowerCase();
    const entry = (deps.watchedFn ?? resolveWatchedReposForPrs)(cfg).find(
      (r) => r.nwo.toLowerCase() === lower,
    );
    if (!entry) return { ok: false, error: "unknown_key" };
    if (!existsFn(entry.path)) return { ok: false, error: "no_checkout" };
    return { ok: true, cwd: entry.path, kind: "watched", nwo: entry.nwo };
  }
  if (!existsFn(key)) return { ok: false, error: "not_a_repo" };
  const realpathFn = deps.realpathFn ?? ((p: string) => realpathSync.native(p));
  let real: string;
  try {
    real = realpathFn(key);
  } catch {
    return { ok: false, error: "not_a_repo" };
  }
  let dataRoot = resolve(cfg.dataDir);
  try {
    dataRoot = realpathFn(dataRoot);
  } catch {
    /* data dir absent: compare against the resolved path */
  }
  if (isUnder(real, dataRoot)) return { ok: false, error: "not_a_repo" };
  // check:false — git() throws GitOpError on a non-zero exit by default
  // (src/git.ts RunOpts.check); a non-repo is an answer here, not an error.
  const top = await (deps.gitFn ?? git)(cfg, ["rev-parse", "--show-toplevel"], {
    cwd: real,
    check: false,
  });
  if (top.code !== 0) return { ok: false, error: "not_a_repo" };
  let topReal: string;
  try {
    topReal = realpathFn(top.stdout.trim());
  } catch {
    return { ok: false, error: "not_a_repo" };
  }
  if (topReal !== real) return { ok: false, error: "not_a_repo" };
  return { ok: true, cwd: real, kind: "local", nwo: null };
}
