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
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { selectBackend, defaultExecProbe } from "../src/agent/sandbox/backend.js";
import { buildPolicy, type SandboxPolicy } from "../src/agent/sandbox/policy.js";
import { makeSandboxedBashOperations } from "../src/agent/sandbox/bashOps.js";
import { dataTreePaths, sandboxDenyPaths } from "../src/dataTree.js";
import { makeConfig } from "./helpers/config.js";
import { cloneHarness, run as gitRun } from "./helpers/gitHarness.js";

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
    /** Subtrees that allow-back territory inside a broader deny (#277). Stated
     *  literally here rather than derived from `dataTree.sandboxDenyPaths`, so
     *  these cases pin the BACKENDS' enforcement of the shape (root deny >
     *  cache allow > mirror re-deny) independently of which paths dataTree
     *  currently feeds it. */
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
// The SHIPPED data-tree shape, executed for real, in BOTH layouts.
//
// Everything above proves flat denies. THIS block proves the layered shape:
// deny the whole data root, allow the agent's execution roots back inside it,
// re-deny `mirror`/`github-cache` under them, with the agent's worktree rw
// underneath. Only a real backend can prove it — both OS mechanisms are
// last-match-wins at the kernel and the unit tests can only assert the emitted
// ORDER.
//
// Two things this block does that its predecessor did not, both of them
// findings from the 2026-08-22 final review:
//
//  - **It derives the rule set from `sandboxDenyPaths(cfg)`, not by hand** (F6).
//    The old block hard-coded `dataAllowPaths: [<root>/cache]`, a shape #311
//    retired: v2's allow-back is now `cache/clones`, so bwrap must create a
//    TWO-level mountpoint inside the fresh `--tmpfs <root>` where one level
//    used to do. CI installs bubblewrap and runs this file, so deriving from
//    the real function is what puts the shipped shape under a real bwrap.
//
//  - **It runs `git`, not `cat`** (F1). The predecessor exercised only
//    `cat`/`echo`/`ls` and therefore reported green through a total outage of
//    the agent's git: `<root>` is a denied path COMPONENT of the linked
//    worktree's gitdir, git lstats every component via `strbuf_realpath`, and
//    under Seatbelt that lstat was EPERM — `git rev-parse`, `git status` and
//    `git diff` all died with "fatal: Invalid path '<root>': Operation not
//    permitted" while `cat` kept working. Reading files is not enough to prove
//    the agent can work in there.
// ---------------------------------------------------------------------------

interface ShippedTree {
  /** Stand-in for ~/.junco — denied wholesale. */
  root: string;
  /** The agent's cwd: a LINKED worktree (its `.git` is a file pointing at a
   *  gitdir under the clones tier), exactly what worktree.ts produces. */
  worktree: string;
  /** <root>/…/mirror — re-denied under the allow-backs. */
  mirror: string;
  /** The receipt files, all under the denied root, all written lazily. */
  denyFiles: string[];
  /** The legacy XDG config path — denied BY NAME from outside the root. */
  legacyConfig: string;
  policy: SandboxPolicy;
  home: string;
}

/** Build one layout's tree for real: materialize what `ensureDataTree` would,
 *  clone a real repo into the clones tier, add a LINKED worktree, then write
 *  the receipts — in that order, because a receipt written after the profile
 *  is generated is the exact bwrap failure mode #311 is about. The policy
 *  comes back through the production path (`sandboxDenyPaths` → `buildPolicy`,
 *  as agent/session.ts's `resolveSandbox` wires it), never hand-built. */
function shippedTree(layout: "v2" | "flat"): ShippedTree {
  // A private HOME: the data root, the canonical config and the legacy XDG
  // config all resolve under it, so nothing here can touch a real ~/.junco.
  const home = tmp("junco-it-home-");
  const root = join(home, ".junco");
  const sub = (v2Path: string, flatPath: string): string =>
    join(root, layout === "v2" ? v2Path : flatPath);
  const cfg = makeConfig(
    {
      dataDir: root,
      queueRoot: join(root, "queue"),
      worktreeRoot: sub("cache/worktrees", "worktrees"),
      tools: [],
      criticEnabled: false,
      planLintEnabled: false,
      verifyEnabled: false,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: false,
    },
    {
      dataLayout: layout,
      github: {
        enabled: false,
        triggerLabel: "junco",
        askLabel: "junco:ask",
        pollIntervalSeconds: 60,
        repos: [],
        requireApproval: true,
        plannerModelId: null,
        externalReposRoot: sub("cache/clones/external", "clones/external"),
      },
    },
  );
  const paths = sandboxDenyPaths(cfg, { HOME: home });
  for (const d of [...paths.dirs, ...paths.allowDirs]) mkdirSync(d, { recursive: true });

  // A real remote → a real bare clone in the clones tier → a real linked
  // worktree. `git worktree add` writes `<worktree>/.git` as a FILE holding an
  // absolute `gitdir:` path under the denied root; that indirection is the
  // whole reason git has to traverse denied components.
  const harness = cloneHarness(tmp("junco-it-remote-"));
  const clone = join(dirname(dataTreePaths(cfg).clonesWatched), "watched", "o__r.git");
  gitRun(["git", "clone", "--quiet", "--bare", harness.remote, clone]);
  const worktree = join(cfg.worktreeRoot, "tkt-1");
  gitRun(["git", "-C", clone, "worktree", "add", "--quiet", "--detach", worktree, "main"]);
  writeFileSync(join(worktree, "untracked.txt"), "dirty\n");

  // Receipts + the mirror content, written AFTER the tree exists.
  const mirror = dataTreePaths(cfg).mirror;
  mkdirSync(join(mirror, "repo.git"), { recursive: true });
  writeFileSync(join(mirror, "repo.git", "HEAD"), "SECRET_MIRROR_HEAD");
  const denyFiles = paths.files.filter((f) => f.startsWith(root + sep));
  for (const f of denyFiles) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '{"model":{"apiKey":"SECRET_RECEIPT_VALUE"}}');
  }
  const legacyConfig = join(home, ".config", "junco", "config.json");
  mkdirSync(dirname(legacyConfig), { recursive: true });
  writeFileSync(legacyConfig, '{"model":{"apiKey":"SECRET_LEGACY_APIKEY"}}');

  const policy = buildPolicy({
    cfg: cfg.sandbox,
    cwd: worktree,
    scratchDir: tmp("junco-it-scratch-"),
    home,
    dataDenyPaths: paths,
    dataAllowPaths: paths.allowDirs,
    network: false,
  });
  return { root, worktree, mirror, denyFiles, legacyConfig, policy, home };
}

/** Run one command under the real backend with an already-built policy. HOME is
 *  the tree's private home (it survives `scrubEnv`'s allowlist), so the git
 *  inside the sandbox reads no global config of the developer's. */
async function runShipped(command: string, t: ShippedTree): Promise<string> {
  const ops = makeSandboxedBashOperations(backend, t.policy, {
    env: () => ({ ...process.env, HOME: t.home, GH_TOKEN: "SECRET_TOKEN_VALUE" }),
  });
  let out = "";
  await ops.exec(command, t.worktree, { onData: (d) => (out += d.toString()) });
  return out;
}

describe.each(["v2", "flat"] as const)(
  "sandbox integration: the shipped data tree, layout=%s",
  (layout) => {
    it("runs the agent's git inside its own worktree (F1)", async (ctx) => {
      requireBackend(ctx);
      const t = shippedTree(layout);
      // The three commands the review reproduced the outage with. They fail
      // with "fatal: Invalid path '<root>': Operation not permitted" the moment
      // a denied path component of the gitdir cannot be lstat'd — which is
      // every git command, i.e. the agent cannot do its job at all.
      const out = await runShipped(
        [
          `git rev-parse HEAD >/dev/null 2>&1; echo "rev-parse=$?"`,
          `git status --porcelain >/dev/null 2>&1; echo "status=$?"`,
          `git diff --stat >/dev/null 2>&1; echo "diff=$?"`,
        ].join("; "),
        t,
      );
      expect(out).toContain("rev-parse=0");
      expect(out).toContain("status=0");
      expect(out).toContain("diff=0");
    });

    it("git still reports the worktree's real content, not an empty mask", async (ctx) => {
      requireBackend(ctx);
      const t = shippedTree(layout);
      // An exit code alone would pass against a tmpfs'd-away worktree. Pin the
      // actual objects: the commit the harness seeded and the untracked file.
      const head = gitRun(["git", "-C", t.worktree, "rev-parse", "HEAD"]).trim();
      const out = await runShipped(`git rev-parse HEAD; git status --porcelain`, t);
      expect(out).toContain(head);
      expect(out).toContain("untracked.txt");
    });

    it("keeps stat() on the denied ancestors from becoming a listing", async (ctx) => {
      requireBackend(ctx);
      const t = shippedTree(layout);
      // The F1 repair grants file-read-metadata on the denied path components,
      // and nothing else. If it ever widened to file-read*, `ls <root>` would
      // start working and the whole tree would be enumerable.
      const out = await runShipped(`ls -a "${t.root}" 2>&1; echo "ls=$?"`, t);
      expect(out).toMatch(/ls=[^0]/);
    });

    it("denies every receipt, the mirror and the legacy config from that same worktree", async (ctx) => {
      requireBackend(ctx);
      const t = shippedTree(layout);
      // One spawn, so these outcomes are proven to coexist with a working git
      // under a single profile/mount set rather than separately-tuned ones.
      const probes = [...t.denyFiles, t.legacyConfig, join(t.mirror, "repo.git", "HEAD")];
      const out = await runShipped(
        probes.map((p, i) => `cat "${p}" 2>/dev/null; echo "p${i}=$?"`).join("; ") +
          `; git rev-parse HEAD >/dev/null 2>&1; echo "git=$?"`,
        t,
      );
      expect(out).not.toContain("SECRET_RECEIPT_VALUE");
      expect(out).not.toContain("SECRET_LEGACY_APIKEY");
      expect(out).not.toContain("SECRET_MIRROR_HEAD");
      for (let i = 0; i < probes.length; i++) expect(out).toMatch(new RegExp(`p${i}=[^0]`));
      expect(out).toContain("git=0");
    });

    it("keeps the worktree WRITABLE and the write survives on the host", async (ctx) => {
      requireBackend(ctx);
      const t = shippedTree(layout);
      // Survival is the assertion that separates a real rw bind from a tmpfs
      // the write silently landed in: bwrap rw-binds the worktree LAST, on top
      // of the clones/worktrees ro-binds, on top of the root tmpfs.
      const out = await runShipped(
        `echo AGENT_WROTE_THIS > "${t.worktree}/out.txt"; echo "exit=$?"`,
        t,
      );
      expect(out).toContain("exit=0");
      expect(existsSync(join(t.worktree, "out.txt"))).toBe(true);
      expect(readFileSync(join(t.worktree, "out.txt"), "utf8").trim()).toBe("AGENT_WROTE_THIS");
    });
  },
);
