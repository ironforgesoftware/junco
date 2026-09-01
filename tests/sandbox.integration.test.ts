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
import { dirname, join, relative, sep } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { selectBackend, defaultExecProbe } from "../src/agent/sandbox/backend.js";
import {
  buildPolicy,
  linkedWorktreeWritePaths,
  type SandboxPolicy,
} from "../src/agent/sandbox/policy.js";
import { resolveGitDirs } from "../src/agent/sandbox/gitDirs.js";
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
const availability =
  backend.name === "none"
    ? { available: false, reason: undefined }
    : await backend.checkAvailability(defaultExecProbe);
const available = backend.name !== "none" && availability.available;

/** Why the real-enforcement cases are not running here. Named in every skip so
 *  a skipped leg is never mistaken for a passing one. The backend's OWN words
 *  come first when it had any (#312) — this is the CI leg where "unavailable"
 *  alone once cost a diagnosis (#308: an installed bwrap refused by
 *  ubuntu-24.04's kernel.apparmor_restrict_unprivileged_userns=1). */
const skipReason =
  backend.name === "none"
    ? `NO OS SANDBOX BACKEND: selectBackend("auto", "${process.platform}") → "none"; real sandbox enforcement was NOT exercised`
    : `SANDBOX BACKEND "${backend.name}" UNAVAILABLE on this host (${
        availability.reason ??
        (backend.name === "bwrap"
          ? "bwrap binary missing, or user namespaces disabled"
          : "sandbox-exec probe failed")
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
      bashTimeoutSeconds: 600,
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

  // #340: Mach lookup is enumerated, not blanket. The one name the toolchain
  // needs (opendirectoryd's libinfo — getpwuid for a Directory Services user)
  // must still answer, and securityd — the login keychain, which is what
  // `git credential-osxkeychain` reads — must not. Under the old blanket allow
  // `security list-keychains` exited 0 from inside the sandbox.
  it("reaches only the enumerated Mach services: user lookup works, the keychain does not (#340)", async (ctx) => {
    requireBackend(ctx);
    ctx.skip(
      backend.name !== "seatbelt",
      "Mach lookup is a Seatbelt concept; bwrap has no securityd",
    );
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const r = await run(
      [
        `echo "user=$(id -un)"`,
        `"${process.execPath}" -e 'console.log("node-user=" + require("os").userInfo().username)'; echo "node=$?"`,
        `security list-keychains >/dev/null 2>&1; echo "keychain=$?"`,
      ].join("; "),
      { work, scratch },
    );
    const me = userInfo().username;
    expect(r.out).toContain(`user=${me}`);
    expect(r.out).toContain(`node-user=${me}`);
    expect(r.out).toContain("node=0");
    expect(r.out).toMatch(/keychain=[^0]/);
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
//
// And one the ubuntu leg of #316 forced, on the first real bwrap run of the
// retargeted block: the denied-root case asserts a CONTENT-and-enumeration
// boundary that both backends can hold, not an exit code only one of them can
// produce. `ls <root>` fails under Seatbelt (a denied permission) and succeeds
// under bwrap (a tmpfs mask is a different directory, and bwrap re-creates a
// mountpoint in it for every deeper mount) — but neither may show a host child
// of that root or read a byte through it, and that is what is asserted. The
// old shape asserted only the exit code, over a directory whose every entry was
// itself a policy path, so it could not tell a mask that held from one that
// never applied. See policy.ts's `traversalMetadataPaths` for the full note.
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
async function shippedTree(layout: "v2" | "flat"): Promise<ShippedTree> {
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

  // #320: the same derivation resolveSandbox performs — real git, real linked
  // worktree, so the writable roots under test are the ones a ticket gets.
  const gitDirs = await resolveGitDirs(cfg, worktree);
  if (!gitDirs) throw new Error("harness: resolveGitDirs returned null for a real linked worktree");
  // mirrors resolveSandbox — a fresh bare clone has no logs/ yet
  const gitWritePaths = linkedWorktreeWritePaths({ cwd: worktree, ...gitDirs });
  for (const p of gitWritePaths) if (!existsSync(p)) mkdirSync(p, { recursive: true });

  const policy = buildPolicy({
    cfg: cfg.sandbox,
    cwd: worktree,
    scratchDir: tmp("junco-it-scratch-"),
    home,
    dataDenyPaths: paths,
    dataAllowPaths: paths.allowDirs,
    network: false,
    gitWritePaths,
  });
  return { root, worktree, mirror, denyFiles, legacyConfig, policy, home };
}

/**
 * The names that may legitimately appear in a listing of `root` — the first path
 * segment under it of every path the policy mounts (deny dirs, deny files,
 * allow-backs, writable roots).
 *
 * Why this is the right upper bound, and why it is backend-agnostic. bwrap
 * renders the wholesale root deny as `--tmpfs <root>` and then has to CREATE a
 * mountpoint inside that fresh tmpfs for every deeper mount the policy asks for
 * — so `ls <root>` under bwrap prints exactly this stub skeleton (empty dirs,
 * /dev/null-masked files, and the ro/rw binds), never the host's own children.
 * Seatbelt prints nothing at all. Neither may ever print a name that is not in
 * here: that would be host content showing through a mask that did not apply.
 *
 * Note the deliberate direction — SUBSET, not equality. `bwrapArgs` skips a deny
 * mount whose target does not exist, so the skeleton is a subset of this set,
 * and a fixture that materializes less than the policy names must not fail.
 */
function policyMountStubs(policy: SandboxPolicy, root: string): Set<string> {
  const names = new Set<string>();
  const mounted = [
    ...policy.readDenyPaths,
    ...policy.readDenyFiles,
    ...policy.readAllowPaths,
    ...policy.writableRoots,
  ];
  for (const p of mounted) {
    if (!p.startsWith(root + sep)) continue;
    names.add(relative(root, p).split(sep)[0]);
  }
  return names;
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

/** Like runShipped, but with a policy whose default bash ceiling is `ms`. */
async function runShippedWithCeiling(command: string, t: ShippedTree, ms: number): Promise<string> {
  const ops = makeSandboxedBashOperations(
    backend,
    { ...t.policy, bashTimeoutMs: ms },
    {
      env: () => ({ ...process.env, HOME: t.home, GH_TOKEN: "SECRET_TOKEN_VALUE" }),
    },
  );
  let out = "";
  await ops.exec(command, t.worktree, { onData: (d) => (out += d.toString()) });
  return out;
}

describe.each(["v2", "flat"] as const)(
  "sandbox integration: the shipped data tree, layout=%s",
  (layout) => {
    it("runs the agent's git inside its own worktree (F1)", async (ctx) => {
      requireBackend(ctx);
      const t = await shippedTree(layout);
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
      const t = await shippedTree(layout);
      // An exit code alone would pass against a tmpfs'd-away worktree. Pin the
      // actual objects: the commit the harness seeded and the untracked file.
      const head = gitRun(["git", "-C", t.worktree, "rev-parse", "HEAD"]).trim();
      const out = await runShipped(`git rev-parse HEAD; git status --porcelain`, t);
      expect(out).toContain(head);
      expect(out).toContain("untracked.txt");
    });

    it("the agent can commit inside its linked worktree (#320)", async (ctx) => {
      requireBackend(ctx);
      const t = await shippedTree(layout);
      const before = gitRun(["git", "-C", t.worktree, "rev-parse", "HEAD"]).trim();
      // A real add + commit. Identity via -c so no global config is consulted;
      // the worktree is detached, so this exercises gitdir/HEAD + objects.
      const out = await runShipped(
        [
          `printf 'hello\\n' > added.txt`,
          `git add added.txt >/dev/null 2>&1; echo "add=$?"`,
          `git -c user.name=t -c user.email=t@example.invalid commit -q -m "c1" >/dev/null 2>&1; echo "commit=$?"`,
          `git checkout -q -b junco/tkt-1 >/dev/null 2>&1; echo "branch=$?"`,
          `printf 'more\\n' >> added.txt; git -c user.name=t -c user.email=t@example.invalid commit -q -am "c2" >/dev/null 2>&1; echo "commit2=$?"`,
          `touch "$(git rev-parse --path-format=absolute --git-common-dir)/hooks/junco-probe" >/dev/null 2>&1; echo "hooks=$?"`,
          `git config user.name probe >/dev/null 2>&1; echo "config=$?"`,
        ].join("; "),
        t,
      );
      expect(out).toContain("add=0");
      expect(out).toContain("commit=0");
      expect(out).toContain("branch=0");
      expect(out).toContain("commit2=0");
      // The common dir itself is not granted: a hook cannot be planted and
      // config cannot be edited from inside the sandbox.
      expect(out).toMatch(/hooks=\d+/);
      expect(out).not.toContain("hooks=0");
      expect(out).toMatch(/config=\d+/);
      expect(out).not.toContain("config=0");
      // The commits are real: HEAD moved, and the branch ref landed in the
      // owning repo's refs (outside the cwd — the whole point of #320).
      const after = gitRun(["git", "-C", t.worktree, "rev-parse", "HEAD"]).trim();
      expect(after).not.toBe(before);
      const ref = gitRun(["git", "-C", t.worktree, "rev-parse", "refs/heads/junco/tkt-1"]).trim();
      expect(ref).toBe(after);
    });

    it("a runaway command is killed at the default ceiling and reported as a timeout", async (ctx) => {
      requireBackend(ctx);
      const t = await shippedTree(layout);
      const started = Date.now();
      await expect(
        runShippedWithCeiling(`echo started; sleep 30; echo finished`, t, 1_000),
      ).rejects.toThrow("timeout:1");
      // Killed at ~1 s, not after the 30 s sleep — and the whole group is gone.
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("never turns the denied root into a window on its real contents", async (ctx) => {
      requireBackend(ctx);
      const t = await shippedTree(layout);
      // A host file inside the denied root that NO policy rule names. It is the
      // discriminator the predecessor of this case lacked: every OTHER entry in
      // that root is a path the policy itself mounts, so a listing of them is
      // ambiguous between "the mask held" and "the mask never applied", while
      // this one can only appear if the root is genuinely unmasked.
      const canary = "canary-not-in-policy.txt";
      writeFileSync(join(t.root, canary), "SECRET_CANARY_VALUE");
      const out = await runShipped(
        `ls -a "${t.root}" 2>/dev/null; echo "ls=$?"; ` +
          `cat "${t.root}/${canary}" 2>/dev/null; echo "cat=$?"`,
        t,
      );

      // 1. Content: denied on every backend, by whichever mechanism.
      expect(out).not.toContain("SECRET_CANARY_VALUE");
      expect(out).toMatch(/cat=[^0]/);

      // 2. Enumeration: whatever `ls` managed to print, every name in it must be
      //    one the policy already mounts. On Seatbelt the listing is empty (the
      //    F1 repair grants file-read-METADATA on the denied path components and
      //    nothing else). On bwrap the deny renders as `--tmpfs <root>`, and
      //    bwrap re-creates a mountpoint inside that fresh tmpfs for every
      //    deeper mount, so the listing is that stub skeleton — names the policy
      //    names, all of them empty dirs, /dev/null files, or the allow-backs.
      //    Either way the canary must not be in it.
      const stubs = policyMountStubs(t.policy, t.root);
      expect(
        [...stubs],
        "the canary must not be a policy path, or this case is vacuous",
      ).not.toContain(canary);
      const lines = out.split("\n");
      const lsEnd = lines.findIndex((l) => l.startsWith("ls="));
      const listed = lines
        .slice(0, lsEnd === -1 ? 0 : lsEnd)
        .map((l) => l.trim())
        .filter((l) => l !== "" && l !== "." && l !== "..");
      for (const entry of listed)
        expect([...stubs], `"${entry}" was listed inside the denied root`).toContain(entry);

      // 3. Seatbelt keeps the stronger property, and this pins it: if the F1
      //    repair ever widened from `file-read-metadata` to `file-read*`,
      //    `ls <root>` would start succeeding on macOS and the whole tree would
      //    be enumerable. bwrap has no such carve-out to widen — its mask is a
      //    replacement directory, not a permission — so requiring a failure
      //    there would be asserting an expectation the mechanism cannot meet.
      if (backend.name === "seatbelt") expect(out).toMatch(/ls=[^0]/);
    });

    it("denies every receipt, the mirror and the legacy config from that same worktree", async (ctx) => {
      requireBackend(ctx);
      const t = await shippedTree(layout);
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
      const t = await shippedTree(layout);
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
