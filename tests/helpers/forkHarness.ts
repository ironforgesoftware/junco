/**
 * Two-bare-remote git harness for fork-PR tests: `origin` -> upstream.git
 * (plain local path), `fork` -> a github.com URL that git REWRITES to the
 * local fork.git via url.<path>.insteadOf. The github URL keeps
 * nwoFromRemoteUrl-based forkNwo derivation working while ls-remote/push hit
 * the local bare repo. Worktrees share the clone's config, so pushes from a
 * junco worktree get the same rewrite.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const FORK_NWO = "me/stream";

export function run(args: string[], cwd?: string): string {
  return execFileSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CI",
      GIT_AUTHOR_EMAIL: "ci@example.com",
      GIT_COMMITTER_NAME: "CI",
      GIT_COMMITTER_EMAIL: "ci@example.com",
    },
  });
}

export function setupForkHarness(tmpRoot: string): {
  upstream: string; // bare, what `origin` points at
  forkRemote: string; // bare, what `fork` resolves to via insteadOf
  work: string; // the "managed clone" (origin=upstream, fork=github URL)
} {
  const upstream = join(tmpRoot, "upstream.git");
  const forkRemote = join(tmpRoot, "fork.git");
  const work = join(tmpRoot, "work");

  run(["git", "init", "--bare", "-b", "main", upstream]);
  run(["git", "init", "--bare", "-b", "main", forkRemote]);
  run(["git", "init", "-b", "main", work]);
  run(["git", "-C", work, "config", "user.email", "ci@example.com"]);
  run(["git", "-C", work, "config", "user.name", "CI"]);
  run(["git", "-C", work, "config", "commit.gpgsign", "false"]);

  writeFileSync(join(work, "README.md"), "seed\n");
  run(["git", "-C", work, "add", "README.md"]);
  run(["git", "-C", work, "commit", "-m", "seed"]);
  run(["git", "-C", work, "remote", "add", "origin", upstream]);
  run(["git", "-C", work, "push", "-u", "origin", "main"]);

  const forkUrl = `https://github.com/${FORK_NWO}.git`;
  run(["git", "-C", work, "remote", "add", "fork", forkUrl]);
  run(["git", "-C", work, "config", `url.${forkRemote}.insteadOf`, forkUrl]);
  return { upstream, forkRemote, work };
}
