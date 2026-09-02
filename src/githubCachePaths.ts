/**
 * File naming for the dashboard's GitHub issue/PR cache under
 * `<dataDir>/github-cache/` — the one place its owner (`tui/ghClient.ts`) and
 * the `junco unwatch` sweep (`unwatchCmd.ts`) both resolve a repo's cache
 * files, so the two can never disagree on a name. Depends on nothing but
 * `node:path` and dataTree.ts on purpose: the CLI graph must stay free of the
 * heavy TUI client module.
 */
import { join } from "node:path";
import type { Config } from "./types.js";
import { dataTreePaths } from "./dataTree.js";

/** `/` in the nwo would otherwise collide with the path separator. */
function cacheKey(nwo: string): string {
  return nwo.replace(/\//g, "__");
}

/** `<dataDir>/github-cache/issues-<owner>__<repo>.json`. */
export function cachePathFor(cfg: Config, nwo: string): string {
  return join(dataTreePaths(cfg).githubCache, `issues-${cacheKey(nwo)}.json`);
}

/** `<dataDir>/github-cache/prs-<owner>__<repo>.json` — a sibling path to
 * `cachePathFor`, kept separate (not a param on it) so issues and PRs never
 * collide in the same file. */
export function prCachePathFor(cfg: Config, nwo: string): string {
  return join(dataTreePaths(cfg).githubCache, `prs-${cacheKey(nwo)}.json`);
}

/** Every cache file one repo owns — what `junco unwatch` sweeps. */
export function githubCacheFilesFor(cfg: Config, nwo: string): string[] {
  return [cachePathFor(cfg, nwo), prCachePathFor(cfg, nwo)];
}
