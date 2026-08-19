/**
 * tests/helpers/unwatchTree.ts — shared fixture for unwatchCmd tests.
 *
 * Extracted from tests/unwatchCmd.test.ts so tests/unwatchCmd.git.test.ts can
 * reuse the same tmpdir-data-tree + watchlist-registration helpers without
 * duplicating them.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfig } from "./config.js";
import { writeWatchlist, readWatchlist, type WatchlistEntry } from "../../src/watchlist.js";
import { dataTreePaths } from "../../src/dataTree.js";
import type { Config } from "../../src/types.js";

/** Tmpdir data tree + full Config. `configRepos` populates cfg.github.repos. */
export function makeTree(opts: { configRepos?: { nwo: string; path: string }[] } = {}): {
  root: string;
  cfg: Config;
} {
  const root = mkdtempSync(join(tmpdir(), "junco-unwatch-"));
  const cfg = makeConfig(
    {
      dataDir: join(root, "data"),
      queueRoot: join(root, "queue"),
      worktreeRoot: join(root, "worktrees"),
      tools: [],
      criticEnabled: false,
      planLintEnabled: false,
      verifyEnabled: false,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: false,
    },
    {
      github: {
        enabled: true,
        triggerLabel: "junco",
        askLabel: "junco:ask",
        pollIntervalSeconds: 60,
        repos: opts.configRepos ?? [],
        requireApproval: true,
        plannerModelId: null,
        externalReposRoot: join(root, "data", "cache", "clones", "external"),
      },
    },
  );
  mkdirSync(dataTreePaths(cfg).queue.inbox, { recursive: true });
  mkdirSync(dataTreePaths(cfg).queue.processing, { recursive: true });
  mkdirSync(cfg.worktreeRoot, { recursive: true });
  return { root, cfg };
}

/** Register `nwo` in the watchlist pointing at `path` (created on disk unless absent:true). */
export function watch(
  cfg: Config,
  nwo: string,
  path: string,
  o: { external?: boolean; absent?: boolean } = {},
): void {
  if (!o.absent) mkdirSync(path, { recursive: true });
  const entry: WatchlistEntry = { nwo, path, ...(o.external ? { external: true } : {}) };
  const file = dataTreePaths(cfg).watchlistFile;
  writeWatchlist(file, [...readWatchlist(file).entries, entry]);
}

/** Minimal PR-flow ticket file. */
export function writeTicket(dir: string, id: string, repoPath: string): string {
  const p = join(dir, `${id}.md`);
  writeFileSync(p, `---\nid: ${id}\nrepo: ${repoPath}\n---\n\nDo the thing.\n`, "utf8");
  return p;
}
