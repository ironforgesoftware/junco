/**
 * tests/helpers/gitHarness.ts — the shared real-git harness (bare remote + seeded clone).
 *
 * Six near-identical copies of `run()` and the bare-remote-plus-clone setup
 * predated tests/helpers/ and were never retrofitted (repo, pr, worktree,
 * critic, prFlow, and forkHarness itself). This is the single source.
 *
 * `cloneHarness` exists for cost: building the tree runs 10 git subprocesses
 * (~142ms measured), while cpSync-ing a prebuilt one is ~7ms. The template is
 * built lazily, at most once per worker process. tests/gitHarness.test.ts pins
 * the property that makes this legal — a COPIED bare remote still accepts a
 * push, and two clones stay independent.
 */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** execFileSync with a deterministic git identity, so tests never depend on ~/.gitconfig. */
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

export interface GitHarness {
  /** The directory containing both `remote` and `work`. */
  root: string;
  /** Bare repo that `work`'s origin points at. */
  remote: string;
  /** Seeded clone with one commit ("seed") on main. */
  work: string;
}

/** Build the harness from scratch under `root` (~142ms: 10 git subprocesses). */
export function setupGitHarness(root: string): GitHarness {
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  mkdirSync(root, { recursive: true });

  run(["git", "init", "--bare", "-b", "main", remote]);
  run(["git", "init", "-b", "main", work]);
  run(["git", "-C", work, "config", "user.email", "ci@example.com"]);
  run(["git", "-C", work, "config", "user.name", "CI"]);
  run(["git", "-C", work, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(work, "README.md"), "seed\n");
  run(["git", "-C", work, "add", "README.md"]);
  run(["git", "-C", work, "commit", "-m", "seed"]);
  run(["git", "-C", work, "remote", "add", "origin", remote]);
  run(["git", "-C", work, "push", "-u", "origin", "main"]);
  return { root, remote, work };
}

let template: string | null = null;

/** The once-per-process seeded tree that `cloneHarness` copies from. */
function harnessTemplate(): string {
  if (template === null) {
    const dir = mkdtempSync(join(tmpdir(), "junco-harness-tpl-"));
    setupGitHarness(dir);
    template = dir;
  }
  return template;
}

/**
 * Copy the template into `dest` (~7ms). `origin` is an absolute path baked into
 * work/.git/config, so it is rewritten to point at the COPY — otherwise every
 * clone would push into the shared template and the copies would not be
 * independent.
 */
export function cloneHarness(dest: string): GitHarness {
  mkdirSync(dest, { recursive: true });
  cpSync(harnessTemplate(), dest, { recursive: true });
  const remote = join(dest, "remote.git");
  const work = join(dest, "work");
  run(["git", "-C", work, "remote", "set-url", "origin", remote]);
  return { root: dest, remote, work };
}
