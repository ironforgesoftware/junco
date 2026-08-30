/**
 * Where a checkout keeps its git metadata (#320). junco runs the agent in a
 * LINKED worktree, so the index/HEAD/logs live in `<repo>/.git/worktrees/<name>`
 * and objects/refs in `<repo>/.git` — neither under the cwd the sandbox makes
 * writable. resolveSandbox asks git once, at session start, and threads the
 * answer through `linkedWorktreeWritePaths` into the policy.
 *
 * Best-effort by design: a cwd that is not a git checkout (Q&A `workdir:`
 * tickets can point anywhere), a missing binary, malformed output, or an
 * older git that echoes the unknown `--path-format` flag all resolve to
 * null — the session then runs with the cwd-only write policy it had before
 * #320, never fails to start.
 */
import { isAbsolute } from "node:path";
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
    const lines = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    // git < 2.31 does not know `--path-format` — and `rev-parse` does not
    // error on an unknown flag: it ECHOES it as a stdout line and exits 0.
    // A lenient "first two lines" parse would then read the flag text as the
    // gitdir, canonicalize it into a nonexistent writable root, and bwrap's
    // `--bind` of a missing source would abort every sandboxed bash call.
    // Exactly two absolute paths, or nothing (the cwd-only policy as before).
    if (lines.length !== 2 || !lines.every((l) => isAbsolute(l))) {
      log.debug("sandbox: unexpected rev-parse output; cwd-only write policy", {
        cwd,
        lines: lines.length,
      });
      return null;
    }
    const [gitDir, commonDir] = lines as [string, string];
    return { gitDir, commonDir };
  } catch (e) {
    log.debug("sandbox: could not resolve git dirs; cwd-only write policy", {
      cwd,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
