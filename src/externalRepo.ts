/**
 * External-repo provisioning (fork-PR mode): a managed clone of an UNOWNED
 * upstream under cfg.github.externalReposRoot, with origin = upstream (so the
 * worktree carve-off builds on upstream's latest base) and a `fork` remote =
 * the operator's fork (the only push target). Spec:
 * docs/superpowers/specs/2026-07-08-external-repo-dispatch-design.md
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { gh, git, GitOpError } from "./git.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import { log } from "./logging.js";
import type { Config } from "./types.js";

const GH_TIMEOUT = 60_000;
const CLONE_TIMEOUT = 300_000; // full clone; big repos take a while

export interface ExternalRepoDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
  existsFn?: (p: string) => boolean;
  mkdirFn?: (d: string) => void;
}

export function externalClonePath(cfg: Config, nwo: string): string {
  const [owner, name] = nwo.split("/");
  return join(cfg.github.externalReposRoot, owner, name);
}

/** Ensure the operator has a fork of `nwo`; return the fork's nwo.
 * `gh repo fork --clone=false` is a no-op when the fork already exists. The
 * candidate name <viewer>/<repo> is then VERIFIED via its parent — a renamed
 * fork fails loud here (the fork remote URL on an existing clone is the real
 * source of truth; see ensureExternalClone). */
export async function ensureFork(
  cfg: Config,
  nwo: string,
  deps: ExternalRepoDeps = {},
): Promise<string> {
  const ghFn = deps.ghFn ?? gh;
  await ghFn(cfg, ["repo", "fork", nwo, "--clone=false"], {
    timeoutMs: GH_TIMEOUT,
    retryNetwork: true,
  });
  const viewer = (
    await ghFn(cfg, ["api", "user", "--jq", ".login"], {
      timeoutMs: GH_TIMEOUT,
      retryNetwork: true,
    })
  ).stdout.trim();
  const candidate = `${viewer}/${nwo.split("/")[1]}`;
  const stdout = (
    await ghFn(cfg, ["repo", "view", candidate, "--json", "parent"], {
      timeoutMs: GH_TIMEOUT,
      retryNetwork: true,
    })
  ).stdout;
  // Plain --json (no --jq): jq's `null + "/" + .name` degrades to the string
  // "/" for an un-forked repo, which defeated the `parent || "none"` fallback
  // below. Parse in TS instead so a null parent reads as null, not "/".
  const parsed = JSON.parse(stdout) as {
    parent: { name?: string; owner?: { login?: string } } | null;
  };
  const parentNwo =
    parsed.parent?.owner?.login && parsed.parent?.name
      ? `${parsed.parent.owner.login}/${parsed.parent.name}`
      : null;
  if (parentNwo === null || parentNwo.toLowerCase() !== nwo.toLowerCase()) {
    throw new GitOpError(
      `${candidate} exists but is not a fork of ${nwo} (parent: ${parentNwo ?? "none"}) — ` +
        `if your fork has a different name, clone manually and add it as the 'fork' remote`,
    );
  }
  return candidate;
}

/** Idempotently ensure the managed clone (+fork +fork remote) for `nwo`. */
export async function ensureExternalClone(
  cfg: Config,
  nwo: string,
  deps: ExternalRepoDeps = {},
): Promise<{ path: string; forkNwo: string }> {
  const ghFn = deps.ghFn ?? gh;
  const gitFn = deps.gitFn ?? git;
  const existsFn = deps.existsFn ?? existsSync;
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const path = externalClonePath(cfg, nwo);

  if (existsFn(path)) {
    const origin = await gitFn(cfg, ["-C", path, "remote", "get-url", "origin"], { check: false });
    const originNwo = origin.code === 0 ? nwoFromRemoteUrl(origin.stdout.trim()) : null;
    if (originNwo === null || originNwo.toLowerCase() !== nwo.toLowerCase()) {
      throw new GitOpError(
        `${path} exists but its origin is ${originNwo ?? "not a github remote"}, expected ${nwo}`,
      );
    }
    const fr = await gitFn(cfg, ["-C", path, "remote", "get-url", "fork"], { check: false });
    if (fr.code === 0) {
      // The fork remote is the source of truth once it exists — never guess
      // past it. An unparseable URL fails loud instead of silently falling
      // through to ensureFork + `remote add` (which would no-op via
      // check:false since the remote already exists, leaving a returned
      // forkNwo that doesn't match what's actually on disk).
      const forkUrl = fr.stdout.trim();
      const forkNwo = nwoFromRemoteUrl(forkUrl);
      if (forkNwo !== null) return { path, forkNwo }; // fully provisioned — zero gh calls
      throw new GitOpError(
        `${path} has a 'fork' remote that is not a github.com URL: ${forkUrl} — fix or remove the fork remote`,
      );
    }
    // fr.code !== 0: fork remote is absent — fall through to provision it.
  } else {
    mkdirFn(dirname(path));
    await ghFn(cfg, ["repo", "clone", nwo, path], { timeoutMs: CLONE_TIMEOUT });
    log.info(`cloned external repo ${nwo} -> ${path}`);
  }

  const forkNwo = await ensureFork(cfg, nwo, deps);
  await gitFn(cfg, ["-C", path, "remote", "add", "fork", `https://github.com/${forkNwo}.git`], {
    // This point is only reached when the fork remote was confirmed ABSENT
    // (or the clone is brand new): check:false covers races only — a
    // concurrent run that added it between our get-url probe and here. The
    // get-url probe above is the arbiter on next call, not this add.
    check: false,
  });
  return { path, forkNwo };
}
