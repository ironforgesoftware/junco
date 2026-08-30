/**
 * Where a checkout keeps its git metadata (#320). junco runs the agent in a
 * LINKED worktree, so the index/HEAD/logs live in `<repo>/.git/worktrees/<name>`
 * and objects/refs in `<repo>/.git` — neither under the cwd the sandbox makes
 * writable. resolveSandbox asks git once, at session start, and threads the
 * answer through `linkedWorktreeWritePaths` into the policy.
 *
 * Best-effort by design: a cwd that is not a git checkout (Q&A `workdir:`
 * tickets can point anywhere), a missing binary, or malformed output all
 * resolve to null — the session then runs with the cwd-only write policy it
 * had before #320, never fails to start.
 */
import { git } from "../../git.js";
import { log } from "../../logging.js";
import type { GitDirs } from "./policy.js";

const REV_PARSE_TIMEOUT_MS = 10_000;

export async function resolveGitDirs(
  cfg: { gitBin: string },
  cwd: string,
  gitFn: typeof git = git,
): Promise<GitDirs | null> {
  try {
    const r = await gitFn(
      cfg,
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      {
        cwd,
        timeoutMs: REV_PARSE_TIMEOUT_MS,
        check: false,
      },
    );
    if (r.code !== 0) return null;
    const [gitDir, commonDir] = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (!gitDir || !commonDir) return null;
    return { gitDir, commonDir };
  } catch (e) {
    log.debug("sandbox: could not resolve git dirs; cwd-only write policy", {
      cwd,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
