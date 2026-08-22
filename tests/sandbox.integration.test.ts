import { describe, it, expect, afterEach, type TestContext } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectBackend, defaultExecProbe } from "../src/agent/sandbox/backend.js";
import { buildPolicy } from "../src/agent/sandbox/policy.js";
import { makeSandboxedBashOperations } from "../src/agent/sandbox/bashOps.js";

// Ground-truth enforcement: actually run bash under the real OS sandbox. Skipped
// when the backend binary is unavailable (e.g. bwrap without userns on a CI
// runner) so unit CI stays green everywhere; do NOT weaken the assertions to
// make them pass unsandboxed — a real enforcement failure must fail this suite.
//
// The probe runs at MODULE LOAD (top-level await), not in `beforeAll`, so the
// answer is known at collection time and an unavailable backend produces real
// SKIPPED tests. The previous shape (`if (!available) return;`) reported a
// backend-less run as PASSING — indistinguishable from genuine enforcement
// coverage, which is exactly how a CI leg can read green while testing nothing.
const backend = selectBackend("auto", process.platform);
const available = backend.name !== "none" && (await backend.isAvailable(defaultExecProbe));

/** Why the real-enforcement cases are not running here. Named in every skip so
 *  a skipped leg is never mistaken for a passing one. */
const skipReason =
  backend.name === "none"
    ? `NO OS SANDBOX BACKEND: selectBackend("auto", "${process.platform}") → "none"; real sandbox enforcement was NOT exercised`
    : `SANDBOX BACKEND "${backend.name}" UNAVAILABLE on this host (${
        backend.name === "bwrap"
          ? "bwrap binary missing, or user namespaces disabled"
          : "sandbox-exec probe failed"
      }); real sandbox enforcement was NOT exercised`;

if (!available) {
  console.warn(
    `\n!! sandbox.integration.test.ts — ${skipReason}.\n` +
      `!! Every case in this file is SKIPPED. Install the backend (Linux: bubblewrap) to cover it.\n`,
  );
}

/** Real skip (vitest reports it as skipped, with the reason) — never a silent
 *  early `return`, which would report as a pass. */
function requireBackend(ctx: TestContext): void {
  ctx.skip(!available, skipReason);
}

const dirs: string[] = [];
function tmp(prefix: string): string {
  // realpath: canonicalize() resolves the policy's paths, so macOS collapses
  // /var/folders → /private/var/folders. Without this the shell commands below
  // would name a different path than the profile/mounts were keyed on.
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run one command under the sandbox; return exit code + combined output. */
async function run(
  command: string,
  opts: {
    work: string;
    scratch: string;
    network?: boolean;
    extraDeny?: string[];
    /** dataTree-shaped denied subtrees; defaults to an (absent) scratch state dir. */
    dataDenyDirs?: string[];
    /** Subtrees that allow-back territory inside a broader deny (#277). Passed
     *  explicitly here because `dataTree.sandboxDenyPaths` does not supply one
     *  yet — arming that is Task 7. */
    dataAllowPaths?: string[];
  },
): Promise<{ code: number | null; out: string }> {
  const policy = buildPolicy({
    cfg: {
      enabled: true,
      backend: "auto",
      network: "deny",
      extraDenyRead: opts.extraDeny ?? [],
      extraAllowWrite: [],
    },
    cwd: opts.work,
    scratchDir: opts.scratch,
    home: process.env.HOME ?? "/tmp",
    dataDenyPaths: { dirs: opts.dataDenyDirs ?? [join(opts.scratch, "state")], files: [] },
    dataAllowPaths: opts.dataAllowPaths,
    network: opts.network ?? false,
  });
  // Inject a fake GH_TOKEN into the source env to prove the scrub removes it.
  const ops = makeSandboxedBashOperations(backend, policy, {
    env: () => ({ ...process.env, GH_TOKEN: "SECRET_TOKEN_VALUE" }),
  });
  let out = "";
  const res = await ops.exec(command, opts.work, { onData: (d) => (out += d.toString()) });
  return { code: res.exitCode, out };
}

describe("sandbox integration (real OS enforcement)", () => {
  it("write inside the worktree succeeds", async (ctx) => {
    requireBackend(ctx);
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const r = await run(`echo ok > "${work}/inside.txt"`, { work, scratch });
    expect(r.code).toBe(0);
    expect(existsSync(join(work, "inside.txt"))).toBe(true);
  });

  it("write outside the worktree fails", async (ctx) => {
    requireBackend(ctx);
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const outside = tmp("junco-it-out-");
    const r = await run(`echo no > "${outside}/x.txt" 2>&1; echo "exit=$?"`, { work, scratch });
    expect(r.out).toMatch(/exit=[^0]/);
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
  });

  it("the child env has no GH_TOKEN (credential scrub)", async (ctx) => {
    requireBackend(ctx);
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const r = await run(`echo "TOKEN=[\${GH_TOKEN:-absent}]"`, { work, scratch });
    expect(r.out).toContain("TOKEN=[absent]");
  });

  it("network egress fails when denied", async (ctx) => {
    requireBackend(ctx);
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const r = await run(`exec 3<>/dev/tcp/1.1.1.1/80 2>&1; echo "exit=$?"`, {
      work,
      scratch,
      network: false,
    });
    expect(r.out).toMatch(/exit=[^0]/);
  });

  it("reading a denied secret path fails while an allowed read succeeds", async (ctx) => {
    requireBackend(ctx);
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const secretDir = tmp("junco-it-secret-");
    writeFileSync(join(secretDir, "creds"), "TOPSECRET");
    writeFileSync(join(work, "public.txt"), "PUBLIC");
    const r = await run(`cat "${work}/public.txt"; cat "${secretDir}/creds" 2>&1; echo "exit=$?"`, {
      work,
      scratch,
      extraDeny: [secretDir],
    });
    expect(r.out).toContain("PUBLIC");
    expect(r.out).not.toContain("TOPSECRET");
    expect(r.out).toMatch(/exit=[^0]/);
  });
});

// ---------------------------------------------------------------------------
// #277 allow-over-deny, executed for real.
//
// Everything above proves flat denies. THIS block proves the three-deep shape
// Task 7 will arm: deny the whole data root, allow `cache/` back, re-deny
// `cache/mirror` inside it, with the agent's worktree rw underneath. Only a
// real backend can prove it, because both OS mechanisms are last-match-wins at
// the kernel and the unit tests can only assert the emitted ORDER.
//
// For bwrap it is load-bearing in a second way: the allow-back is `--ro-bind`ed
// at a destination that a `--tmpfs` over its ancestor has just wiped, so bwrap
// must create the missing mountpoint inside that fresh tmpfs, and the nested
// deny must then tmpfs over a path inside a read-only bind. That is the
// documented flatpak idiom, but nothing in this repo had ever executed it.
// ---------------------------------------------------------------------------

interface JuncoTree {
  /** Stand-in for ~/.junco — denied wholesale. */
  root: string;
  /** <root>/cache — allowed back over the root deny. */
  cache: string;
  /** <root>/cache/mirror — re-denied inside the allow-back. */
  mirror: string;
  /** <root>/cache/worktrees/wt-1 — the agent's cwd; readable AND writable. */
  worktree: string;
  scratch: string;
}

describe("sandbox integration: allow-over-deny on a real ~/.junco-shaped tree (#277)", () => {
  function juncoTree(): JuncoTree {
    const root = tmp("junco-it-root-");
    const cache = join(root, "cache");
    const mirror = join(cache, "mirror");
    const worktree = join(cache, "worktrees", "wt-1");
    mkdirSync(join(mirror, "repo.git"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(root, "config.json"), '{"model":{"apiKey":"SECRET_CONFIG_APIKEY"}}');
    writeFileSync(join(mirror, "repo.git", "HEAD"), "SECRET_MIRROR_HEAD");
    writeFileSync(join(worktree, "README.md"), "WORKTREE_README_OK");
    return { root, cache, mirror, worktree, scratch: tmp("junco-it-scratch-") };
  }

  /** The Task-7 rule set, passed explicitly: deny the root, allow cache/ back,
   *  re-deny cache/mirror. The worktree is a writable root, so `readRules`
   *  contributes it as the deepest allow. */
  function runInTree(command: string, t: JuncoTree): Promise<{ code: number | null; out: string }> {
    return run(command, {
      work: t.worktree,
      scratch: t.scratch,
      dataDenyDirs: [t.root, t.mirror],
      dataAllowPaths: [t.cache],
    });
  }

  it("denies the data root's config.json under the wholesale root deny", async (ctx) => {
    requireBackend(ctx);
    const t = juncoTree();
    const r = await runInTree(`cat "${t.root}/config.json" 2>&1; echo "exit=$?"`, t);
    expect(r.out).not.toContain("SECRET_CONFIG_APIKEY");
    expect(r.out).toMatch(/exit=[^0]/);
  });

  it("re-denies cache/mirror nested INSIDE the cache/ allow-back", async (ctx) => {
    requireBackend(ctx);
    const t = juncoTree();
    // The whole point of longest-prefix-wins: cache/ is allowed back over the
    // root deny, but mirror/ sits deeper and must stay denied. A flat
    // "allow beats deny" would leak every mirrored clone here.
    const r = await runInTree(`cat "${t.mirror}/repo.git/HEAD" 2>&1; echo "exit=$?"`, t);
    expect(r.out).not.toContain("SECRET_MIRROR_HEAD");
    expect(r.out).toMatch(/exit=[^0]/);
  });

  it("keeps the worktree READABLE through a denied ancestor", async (ctx) => {
    requireBackend(ctx);
    const t = juncoTree();
    const r = await runInTree(`cat "${t.worktree}/README.md"; echo "exit=$?"`, t);
    expect(r.out).toContain("WORKTREE_README_OK");
    expect(r.out).toContain("exit=0");
  });

  it("keeps the worktree WRITABLE and the write survives on the host", async (ctx) => {
    requireBackend(ctx);
    const t = juncoTree();
    // Survival is the assertion that separates a real rw bind from a tmpfs the
    // write silently landed in: bwrap rw-binds the worktree LAST, on top of the
    // cache/ ro-bind, on top of the root tmpfs.
    const r = await runInTree(
      `echo AGENT_WROTE_THIS > "${t.worktree}/out.txt"; echo "exit=$?"; cat "${t.worktree}/out.txt"`,
      t,
    );
    expect(r.out).toContain("exit=0");
    expect(r.out).toContain("AGENT_WROTE_THIS");
    expect(existsSync(join(t.worktree, "out.txt"))).toBe(true);
    expect(readFileSync(join(t.worktree, "out.txt"), "utf8").trim()).toBe("AGENT_WROTE_THIS");
  });

  it("resolves all four probes correctly in ONE sandboxed process", async (ctx) => {
    requireBackend(ctx);
    const t = juncoTree();
    // One spawn, so the four outcomes are proven to coexist under a single
    // profile/mount set rather than four independently-tuned ones.
    const r = await runInTree(
      [
        `cat "${t.root}/config.json" >/dev/null 2>&1; echo "config=$?"`,
        `cat "${t.mirror}/repo.git/HEAD" >/dev/null 2>&1; echo "mirror=$?"`,
        `cat "${t.worktree}/README.md" >/dev/null 2>&1; echo "worktree=$?"`,
        `echo x > "${t.worktree}/w.txt" 2>/dev/null; echo "write=$?"`,
      ].join("; "),
      t,
    );
    expect(r.out).toMatch(/config=[^0]/);
    expect(r.out).toMatch(/mirror=[^0]/);
    expect(r.out).toContain("worktree=0");
    expect(r.out).toContain("write=0");
  });
});
