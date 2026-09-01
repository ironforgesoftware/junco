import { describe, it, expect } from "vitest";
import {
  builtinDenyReadPaths,
  buildPolicy,
  linkedWorktreeWritePaths,
  readRules,
  traversalMetadataPaths,
  SandboxPolicyError,
  type SandboxPolicy,
} from "../src/agent/sandbox/policy.js";
import { bwrapArgs } from "../src/agent/sandbox/backend.js";
import { resolveRead } from "../src/agent/sandbox/precedence.js";
import {
  assertReadAllowed,
  assertWriteAllowed,
  SandboxViolation,
} from "../src/agent/sandbox/pathJail.js";

describe("builtinDenyReadPaths", () => {
  it("covers the standard secret locations under home", () => {
    const p = builtinDenyReadPaths("/sbxroot/home/x");
    expect(p).toContain("/sbxroot/home/x/.ssh");
    expect(p).toContain("/sbxroot/home/x/.aws");
    expect(p).toContain("/sbxroot/home/x/.config/gh");
    expect(p).toContain("/sbxroot/home/x/.gnupg");
    expect(p).toContain("/sbxroot/home/x/.pi");
  });

  it("covers the credential files and dirs other toolchains keep under home (#336)", () => {
    const p = builtinDenyReadPaths("/sbxroot/home/x");
    for (const rel of [
      ".npmrc",
      ".git-credentials",
      ".netrc",
      ".docker/config.json",
      ".kube",
      ".config/gcloud",
      ".cargo/credentials.toml",
      ".pypirc",
      ".gem/credentials",
      ".claude",
    ]) {
      expect(p).toContain(`/sbxroot/home/x/${rel}`);
    }
    // Only the credential FILE is denied where the parent dir is a toolchain the
    // agent legitimately needs (cargo's bin/ and registry/, docker's cli-plugins/).
    expect(p).not.toContain("/sbxroot/home/x/.cargo");
    expect(p).not.toContain("/sbxroot/home/x/.docker");
  });
});

describe("linkedWorktreeWritePaths (#320)", () => {
  const cwd = "/sbxroot/work/tree";

  it("a linked worktree gets its gitdir plus the common dir's objects/refs/logs — never the common dir", () => {
    const roots = linkedWorktreeWritePaths({
      cwd,
      gitDir: "/sbxroot/repo/.git/worktrees/tree",
      commonDir: "/sbxroot/repo/.git",
    });
    expect(roots).toEqual([
      "/sbxroot/repo/.git/worktrees/tree",
      "/sbxroot/repo/.git/objects",
      "/sbxroot/repo/.git/refs",
      "/sbxroot/repo/.git/logs",
    ]);
    expect(roots).not.toContain("/sbxroot/repo/.git");
  });

  it("a standalone repo (common dir inside the cwd) adds nothing — the cwd already covers it", () => {
    expect(
      linkedWorktreeWritePaths({
        cwd,
        gitDir: "/sbxroot/work/tree/.git",
        commonDir: "/sbxroot/work/tree/.git",
      }),
    ).toEqual([]);
  });

  it("a gitdir outside both the common dir and the cwd is granted alongside the common dir's subdirs", () => {
    expect(
      linkedWorktreeWritePaths({
        cwd,
        gitDir: "/sbxroot/elsewhere/gitdir",
        commonDir: "/sbxroot/repo/.git",
      }),
    ).toEqual([
      "/sbxroot/elsewhere/gitdir",
      "/sbxroot/repo/.git/objects",
      "/sbxroot/repo/.git/refs",
      "/sbxroot/repo/.git/logs",
    ]);
  });

  it("is prefix-safe: /sbxroot/work/tree-2 is not inside /sbxroot/work/tree (gitdir === common dir → that dir)", () => {
    expect(
      linkedWorktreeWritePaths({
        cwd,
        gitDir: "/sbxroot/work/tree-2/.git",
        commonDir: "/sbxroot/work/tree-2/.git",
      }),
    ).toEqual(["/sbxroot/work/tree-2/.git"]);
  });
});

// Synthetic, guaranteed-nonexistent paths so canonicalize() is a deterministic
// no-op (real system paths like /home, /tmp resolve differently per machine).
describe("buildPolicy", () => {
  const base = {
    cfg: {
      enabled: true,
      backend: "auto" as const,
      network: "deny" as const,
      extraDenyRead: ["/sbxroot/extra/secret"],
      extraAllowWrite: ["/sbxroot/extra/writable"],
      bashTimeoutSeconds: 600,
    },
    cwd: "/sbxroot/work/tree",
    scratchDir: "/sbxroot/nowhere/scratch1",
    home: "/sbxroot/home/x",
    dataDenyPaths: {
      dirs: ["/sbxroot/data/queue", "/sbxroot/data/review"],
      files: ["/sbxroot/data/watchlist.json"],
    },
    network: false,
  };

  it("writable roots = cwd + scratch + extras", () => {
    const pol = buildPolicy(base);
    expect(pol.writableRoots).toEqual([
      "/sbxroot/work/tree",
      "/sbxroot/nowhere/scratch1",
      "/sbxroot/extra/writable",
    ]);
  });

  it("gitWritePaths land after cwd/scratch and before the operator's extras (#320)", () => {
    const pol = buildPolicy({ ...base, gitWritePaths: ["/sbxroot/repo/.git"] });
    expect(pol.writableRoots).toEqual([
      "/sbxroot/work/tree",
      "/sbxroot/nowhere/scratch1",
      "/sbxroot/repo/.git",
      "/sbxroot/extra/writable",
    ]);
  });

  // #346: the read-only flows run in the operator's LIVE checkout, and the
  // read-only guarantee must not rest on the tool allowlist alone — the policy
  // itself has to refuse writes there, .git included.
  it("readOnly: scratch is the only writable root — cwd, git metadata and the extras are dropped (#346)", () => {
    const pol = buildPolicy({ ...base, readOnly: true, gitWritePaths: ["/sbxroot/repo/.git"] });
    expect(pol.writableRoots).toEqual(["/sbxroot/nowhere/scratch1"]);
    const cwd = "/sbxroot/work/tree";
    expect(() => assertWriteAllowed("src/a.ts", cwd, pol)).toThrow(SandboxViolation);
    expect(() => assertWriteAllowed(`${cwd}/.git/HEAD`, cwd, pol)).toThrow(SandboxViolation);
    expect(() => assertWriteAllowed("/sbxroot/extra/writable/x", cwd, pol)).toThrow(
      SandboxViolation,
    );
    expect(assertWriteAllowed("/sbxroot/nowhere/scratch1/note", cwd, pol)).toBe(
      "/sbxroot/nowhere/scratch1/note",
    );
    // Reads of the checkout are unaffected.
    expect(assertReadAllowed("src/a.ts", cwd, pol)).toBe(`${cwd}/src/a.ts`);
  });

  it("read denials = builtins + sensitive data subtrees + extras; data files land in readDenyFiles", () => {
    const pol = buildPolicy(base);
    expect(pol.readDenyPaths).toContain("/sbxroot/home/x/.ssh");
    expect(pol.readDenyPaths).toContain("/sbxroot/data/queue");
    expect(pol.readDenyPaths).toContain("/sbxroot/data/review");
    expect(pol.readDenyPaths).toContain("/sbxroot/extra/secret");
    expect(pol.readDenyFiles).toEqual(["/sbxroot/data/watchlist.json"]);
    // Callers still never pass the data root itself as a deny — that hasn't
    // changed. But this is no longer a correctness REQUIREMENT: readRules()
    // makes an ancestor deny safe by construction (longest-prefix-wins), so
    // this is now just documenting what today's caller happens to do, not
    // the thing standing between the agent and a walled-out worktree.
    expect(pol.readDenyPaths).not.toContain("/sbxroot/data");
    // Proof of the mechanism: even if a deny DID sit above the writable
    // root, the writable-root allow rule out-specifies it and the worktree
    // still resolves readable.
    const withAncestorDeny = { ...pol, readDenyPaths: [...pol.readDenyPaths, "/sbxroot/work"] };
    expect(resolveRead(pol.writableRoots[0]!, readRules(withAncestorDeny))).toBe("allow");
  });

  it("threads the network flag through", () => {
    expect(buildPolicy({ ...base, network: true }).network).toBe(true);
    expect(buildPolicy({ ...base, network: false }).network).toBe(false);
  });

  it("resolves relative/.. inputs to absolute", () => {
    const pol = buildPolicy({ ...base, cwd: "/sbxroot/work/../work/tree" });
    expect(pol.writableRoots[0]).toBe("/sbxroot/work/tree");
  });

  it("threads sandbox.bashTimeoutSeconds into the policy as milliseconds; 0 means no ceiling", () => {
    expect(
      buildPolicy({ ...base, cfg: { ...base.cfg, bashTimeoutSeconds: 600 } }).bashTimeoutMs,
    ).toBe(600_000);
    expect(
      buildPolicy({ ...base, cfg: { ...base.cfg, bashTimeoutSeconds: 0 } }).bashTimeoutMs,
    ).toBeUndefined();
  });

  it("denies reads of the bot gh config dir when provided", () => {
    const p = buildPolicy({
      cfg: {
        enabled: true,
        backend: "none",
        network: "deny",
        extraDenyRead: [],
        extraAllowWrite: [],
        bashTimeoutSeconds: 600,
      },
      cwd: "/sbxroot/wt",
      scratchDir: "/sbxroot/scratch",
      home: "/sbxroot/home",
      dataDenyPaths: { dirs: [], files: [] },
      network: false,
      botGhConfigDir: "/sbxroot/home/.config/junco/gh",
    });
    expect(p.readDenyPaths).toContain("/sbxroot/home/.config/junco/gh");
  });
});

// The C1 regression (default unified layout): the worktree the agent runs in
// and the watched-clone gitdirs live UNDER dataDir — a policy that denied the
// whole root made every in-worktree read a SandboxViolation. Sensitive
// subtrees stay denied; the execution roots must stay readable/writable.
//
// pathJail's assertReadAllowed consumes readRules()'s precedence directly
// (see pathJail.ts) — these assertions exercise that same longest-prefix
// resolution through the real buildPolicy() output.
describe("buildPolicy — default <dataDir>-rooted layout (JS jail)", () => {
  const dataDir = "/sbxroot/home/x/.local/state/junco";
  const cwd = `${dataDir}/worktrees/tkt-1`;
  const policy = buildPolicy({
    cfg: {
      enabled: true,
      backend: "auto" as const,
      network: "deny" as const,
      extraDenyRead: [],
      extraAllowWrite: [],
      bashTimeoutSeconds: 600,
    },
    cwd,
    scratchDir: "/sbxroot/nowhere/scratch1",
    home: "/sbxroot/home/x",
    dataDenyPaths: {
      dirs: [
        `${dataDir}/queue`,
        `${dataDir}/review`,
        `${dataDir}/outbox`,
        `${dataDir}/mirror`,
        `${dataDir}/transcripts`,
        `${dataDir}/github-cache`,
      ],
      files: [`${dataDir}/watchlist.json`],
    },
    network: false,
  });

  it("allows reads and writes inside the agent's own worktree under <dataDir>/worktrees", () => {
    expect(assertReadAllowed(`${cwd}/src/a.ts`, cwd, policy)).toBe(`${cwd}/src/a.ts`);
    expect(assertWriteAllowed(`${cwd}/src/a.ts`, cwd, policy)).toBe(`${cwd}/src/a.ts`);
  });

  it("allows reads of the watched-clone gitdirs under <dataDir>/clones", () => {
    expect(assertReadAllowed(`${dataDir}/clones/watched/o/r/.git/HEAD`, cwd, policy)).toBe(
      `${dataDir}/clones/watched/o/r/.git/HEAD`,
    );
    expect(assertReadAllowed(`${dataDir}/clones/external/o2/r2/.git/HEAD`, cwd, policy)).toBe(
      `${dataDir}/clones/external/o2/r2/.git/HEAD`,
    );
  });

  it("a linked worktree's git metadata under the denied clones tier is writable once threaded in (#320)", () => {
    const withGit = buildPolicy({
      cfg: {
        enabled: true,
        backend: "auto" as const,
        network: "deny" as const,
        extraDenyRead: [],
        extraAllowWrite: [],
        bashTimeoutSeconds: 600,
      },
      cwd,
      scratchDir: "/sbxroot/nowhere/scratch1",
      home: "/sbxroot/home/x",
      dataDenyPaths: {
        dirs: [`${dataDir}/queue`, `${dataDir}/review`],
        files: [`${dataDir}/watchlist.json`],
      },
      gitWritePaths: [
        `${dataDir}/clones/watched/o/r/.git/worktrees/tkt-1`,
        `${dataDir}/clones/watched/o/r/.git/objects`,
        `${dataDir}/clones/watched/o/r/.git/refs`,
        `${dataDir}/clones/watched/o/r/.git/logs`,
      ],
      network: false,
    });
    const lock = `${dataDir}/clones/watched/o/r/.git/worktrees/tkt-1/index.lock`;
    expect(assertWriteAllowed(lock, cwd, withGit)).toBe(lock);
    expect(
      assertWriteAllowed(`${dataDir}/clones/watched/o/r/.git/objects/ab/cd`, cwd, withGit),
    ).toBe(`${dataDir}/clones/watched/o/r/.git/objects/ab/cd`);
    // The common dir itself is NOT granted: hooks and config stay unwritable.
    expect(() =>
      assertWriteAllowed(`${dataDir}/clones/watched/o/r/.git/hooks/pre-commit`, cwd, withGit),
    ).toThrow();
    expect(() =>
      assertWriteAllowed(`${dataDir}/clones/watched/o/r/.git/config`, cwd, withGit),
    ).toThrow();
    // Without the threading, the same write is refused — the #320 symptom.
    expect(() => assertWriteAllowed(lock, cwd, policy)).toThrow();
  });

  it("still denies the sensitive subtrees and root receipt files", () => {
    expect(() => assertReadAllowed(`${dataDir}/queue/inbox/x.md`, cwd, policy)).toThrow(
      SandboxViolation,
    );
    expect(() => assertReadAllowed(`${dataDir}/review/assess/y.json`, cwd, policy)).toThrow(
      SandboxViolation,
    );
    expect(() => assertReadAllowed(`${dataDir}/watchlist.json`, cwd, policy)).toThrow(
      SandboxViolation,
    );
  });

  // The mechanism this whole plan (#277) is building toward: denying dataDir
  // WHOLESALE (Task 7 arms this for real, in dataTree.ts — out of scope
  // here) is only safe because the writable root is an allow rule that
  // out-specifies the ancestor deny. Proven here directly at the
  // readRules/resolveRead level, independent of pathJail's and the OS
  // backends' respective consumption of that same resolver.
  it("would survive a wholesale dataDir deny: the worktree stays allowed, siblings stay denied", () => {
    const wholesale = { ...policy, readDenyPaths: [...policy.readDenyPaths, dataDir] };
    const rules = readRules(wholesale);
    // The writable root (the worktree) out-specifies the root-level deny.
    expect(resolveRead(cwd, rules)).toBe("allow");
    // Territory under the same root that ISN'T a writable root or an
    // explicit allow-back stays denied — the override is not unconditional.
    expect(resolveRead(`${dataDir}/queue/inbox/x.md`, rules)).toBe("deny");
    expect(resolveRead(`${dataDir}/mirror/repo.git`, rules)).toBe("deny");
  });
});

describe("readRules — allow-over-deny precedence (#277)", () => {
  it("exposes writable roots as read-allow rules so a denied ancestor cannot wall the agent out", () => {
    const p = buildPolicy({
      cfg: {
        enabled: true,
        backend: "auto" as const,
        network: "deny" as const,
        extraDenyRead: [],
        extraAllowWrite: [],
        bashTimeoutSeconds: 600,
      },
      cwd: "/sbxroot/root/worktrees/wt1",
      scratchDir: "/sbxroot/nowhere/scratch1",
      home: "/sbxroot/home/x",
      // Ancestor of the writable root is denied wholesale.
      dataDenyPaths: { dirs: ["/sbxroot/root"], files: [] },
      network: false,
    });
    expect(resolveRead(p.writableRoots[0]!, readRules(p))).toBe("allow");
    // Sibling territory under the same denied ancestor stays denied — this
    // is not an unconditional "writable wins" rule.
    expect(resolveRead("/sbxroot/root/queue/x.md", readRules(p))).toBe("deny");
  });

  it("lets an operator deny a path INSIDE a writable root", () => {
    const p = buildPolicy({
      cfg: {
        enabled: true,
        backend: "auto" as const,
        network: "deny" as const,
        extraDenyRead: ["/sbxroot/wt/.env"],
        extraAllowWrite: [],
        bashTimeoutSeconds: 600,
      },
      cwd: "/sbxroot/wt",
      scratchDir: "/sbxroot/nowhere/scratch1",
      home: "/sbxroot/home/x",
      dataDenyPaths: { dirs: [], files: [] },
      network: false,
    });
    expect(resolveRead("/sbxroot/wt/src/a.ts", readRules(p))).toBe("allow");
    // A deny deeper than the writable root still wins: the writable-root
    // allow is not an unconditional override.
    expect(resolveRead("/sbxroot/wt/.env", readRules(p))).toBe("deny");
  });

  it("canonicalizes allow paths the same way as deny paths", () => {
    const p = buildPolicy({
      cfg: {
        enabled: true,
        backend: "auto" as const,
        network: "deny" as const,
        extraDenyRead: [],
        extraAllowWrite: [],
        bashTimeoutSeconds: 600,
      },
      cwd: "/sbxroot/wt",
      scratchDir: "/sbxroot/nowhere/scratch1",
      home: "/sbxroot/home/x",
      dataDenyPaths: { dirs: [], files: [] },
      // A raw, un-normalized allow path (mirrors how deny paths are passed
      // un-normalized too, e.g. extraDenyRead) — canonicalize() must resolve
      // the `..` the same way it does for readDenyPaths, or precedence would
      // compare a canonicalized deny against a raw allow and silently
      // disagree on a /tmp-vs-/private/tmp-style mismatch.
      dataAllowPaths: ["/sbxroot/data/../data/cache"],
      network: false,
    });
    expect(p.readAllowPaths).toEqual(["/sbxroot/data/cache"]);
    expect(resolveRead("/sbxroot/data/cache/worktrees/t1", readRules(p))).toBe("allow");
  });
});

// #311. #308 closed the DIRECTORY half of the allow-back surface: a sensitive
// subtree denied at its own depth out-specifies a shallower allow-back on all
// three backends. The FILE half stayed open on bwrap, which must skip a deny
// mount whose target does not exist (it cannot create a mountpoint under a
// read-only bind), so a lazily-written receipt inside an allow-back had no
// surviving deny there. Pre-creating the receipts was rejected (a placeholder
// update-check.json blocks what `junco data migrate` must MOVE; an empty
// spend.json/metrics.json hands their readers "" to JSON.parse), so the shape
// is refused one layer up instead — at policy construction, once, for every
// backend.
describe("buildPolicy — an allow above a deny FILE is refused (#311)", () => {
  const root = "/sbxroot/home/.junco";
  const tier = `${root}/data`; // the v2 daemon-state tier
  const spend = `${tier}/spend.json`; // lazily written; absent until first spend
  const base = {
    cfg: {
      enabled: true,
      backend: "auto" as const,
      network: "deny" as const,
      extraDenyRead: [],
      extraAllowWrite: [],
      bashTimeoutSeconds: 600,
    },
    cwd: `${root}/cache/worktrees/tkt-1`,
    scratchDir: "/sbxroot/nowhere/scratch1",
    home: "/sbxroot/home",
    dataDenyPaths: { dirs: [root, `${tier}/transcripts`], files: [spend] },
    network: false,
  };

  it("refuses a read allow-back that is a strict ancestor of a denied file", () => {
    expect(() => buildPolicy({ ...base, dataAllowPaths: [tier] })).toThrow(
      /is an ancestor of denied file/,
    );
  });

  it("names the allow, the file and the reason, as a SandboxPolicyError", () => {
    let caught: unknown;
    try {
      buildPolicy({ ...base, dataAllowPaths: [tier] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxPolicyError);
    const err = caught as Error;
    expect(err?.name).toBe("SandboxPolicyError");
    expect(err.message).toContain(tier);
    expect(err.message).toContain(spend);
    expect(err.message).toMatch(/bwrap/);
  });

  it("refuses a WRITABLE root that is a strict ancestor of a denied file", () => {
    // readRules() maps writable roots to allow/subtree rules exactly like
    // allow-backs, and bwrap binds them READ-WRITE and never existence-guards
    // them — so the same shape is strictly worse there. One rule for both.
    expect(() => buildPolicy({ ...base, cfg: { ...base.cfg, extraAllowWrite: [tier] } })).toThrow(
      /is an ancestor of denied file/,
    );
  });

  it("matches on path boundaries, not string prefixes", () => {
    expect(() =>
      buildPolicy({
        ...base,
        dataDenyPaths: { dirs: [root], files: [`${root}/data-archive/spend.json`] },
        dataAllowPaths: [tier],
      }),
    ).not.toThrow();
  });

  it("permits an exact-path tie — precedence already resolves it to deny", () => {
    // Not an ancestor: `orderRules` breaks a same-depth tie in favour of the
    // narrower "file" rule, so the deny wins in the resolver, in the SBPL
    // profile and in bwrap's mount order alike. Nothing to refuse.
    const p = buildPolicy({ ...base, dataAllowPaths: [spend] });
    expect(resolveRead(spend, readRules(p))).toBe("deny");
  });

  it("does NOT fire for a deny DIRECTORY inside an allow-back", () => {
    // The directory half is already sound: ensureDataTree materializes every
    // deny dir before any spawn, so bwrap never skips one, and a deny at its
    // own depth out-specifies the shallower allow. Firing here would outlaw
    // #308's whole design.
    const p = buildPolicy({
      cfg: base.cfg,
      cwd: `${root}/cache/worktrees/tkt-1`,
      scratchDir: base.scratchDir,
      home: base.home,
      dataDenyPaths: { dirs: [root, `${root}/cache/mirror`], files: [] },
      dataAllowPaths: [`${root}/cache`],
      network: false,
    });
    expect(resolveRead(`${root}/cache/mirror/repo.git/HEAD`, readRules(p))).toBe("deny");
  });

  it("leaves the ordinary three-deep shape resolving exactly as before", () => {
    // deny <root> → allow <root>/cache → deny <root>/cache/mirror, with the
    // agent's worktree writable inside the allow-back. Pinned literally so a
    // future guard cannot quietly change what longest-prefix-wins answers.
    const p = buildPolicy({
      cfg: base.cfg,
      cwd: `${root}/cache/worktrees/tkt-1`,
      scratchDir: base.scratchDir,
      home: base.home,
      dataDenyPaths: { dirs: [root, `${root}/cache/mirror`], files: [`${root}/watchlist.json`] },
      dataAllowPaths: [`${root}/cache`],
      network: false,
    });
    const rules = readRules(p);
    expect(resolveRead(`${root}/queue/inbox/t.md`, rules)).toBe("deny");
    expect(resolveRead(`${root}/cache/clones/watched/o__r.git/HEAD`, rules)).toBe("allow");
    expect(resolveRead(`${root}/cache/mirror/o__r.git/HEAD`, rules)).toBe("deny");
    expect(resolveRead(`${root}/cache/worktrees/tkt-1/src/a.ts`, rules)).toBe("allow");
    expect(resolveRead(`${root}/watchlist.json`, rules)).toBe("deny");
  });

  it("refuses exactly the shape bwrap cannot enforce", () => {
    // Hand-built, because buildPolicy now refuses to produce it. This is the
    // hole itself: the receipt is not written yet, so bwrap's existence guard
    // drops its /dev/null mask while the tier stays ro-bound — and the moment
    // the daemon writes the receipt it is readable through that bind.
    const leaky: SandboxPolicy = {
      writableRoots: [`${root}/cache/worktrees/tkt-1`],
      readDenyPaths: [root],
      readDenyFiles: [spend],
      readAllowPaths: [tier],
      network: false,
      scratchDir: "/sbxroot/nowhere/scratch1",
      bashTimeoutMs: undefined,
    };
    const args = bwrapArgs(leaky, (p) => p !== spend); // receipt absent at spawn
    const at = (tokens: string[]): number =>
      args.findIndex((_, i) => tokens.every((t, k) => args[i + k] === t));
    expect(at(["--ro-bind", tier, tier])).toBeGreaterThanOrEqual(0);
    expect(at(["--ro-bind", "/dev/null", spend])).toBe(-1);
    // …which is why the policy is refused before any backend sees it.
    expect(() => buildPolicy({ ...base, dataAllowPaths: [tier] })).toThrow(
      /is an ancestor of denied file/,
    );
  });

  // F4 (final review 2026-08-22): `allow.path + sep` is "//" at the filesystem
  // root, which nothing starts with, so an allow at "/" slipped past the guard
  // entirely — and on bwrap that allow is emitted as `--bind / /` AFTER every
  // deny, re-exposing ~/.ssh and the whole data tree read-WRITE.
  it("fires for an allow at the filesystem root — the boundary test's root hole", () => {
    expect(() => buildPolicy({ ...base, cfg: { ...base.cfg, extraAllowWrite: ["/"] } })).toThrow(
      SandboxPolicyError,
    );
    expect(() => buildPolicy({ ...base, dataAllowPaths: ["/"] })).toThrow(
      /is an ancestor of denied file/,
    );
  });

  it("names JUNCO_CONFIG among the settings to check", () => {
    // Every verified trigger must be in the operator's list. `JUNCO_CONFIG`
    // names the ACTIVE config, which is denied by name wherever it points, so
    // an allow above that location trips the guard — the final review verified
    // it and the message omitted it.
    let message = "";
    try {
      buildPolicy({ ...base, dataAllowPaths: [tier] });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("JUNCO_CONFIG");
    expect(message).toContain("git.worktreeRoot");
    expect(message).toContain("github.externalReposRoot");
    expect(message).toContain("sandbox.extra_allow_write");
    // …and that it is a sandbox-SETUP refusal, not something the ticket did.
    expect(message).toMatch(/sandbox-setup refusal/);
  });
});

// F5 (final review 2026-08-22): `extra_deny_read` used to land in
// readDenyPaths unconditionally, so an operator denying a FILE got the
// subtree kind — which bwrap renders as `--tmpfs <file>`, a mount tmpfs
// cannot perform at all, and which never reached the #311 guard.
describe("buildPolicy — extra_deny_read is classified by observation (#311/F5)", () => {
  const base = {
    cfg: {
      enabled: true,
      backend: "auto" as const,
      network: "deny" as const,
      extraDenyRead: [] as string[],
      extraAllowWrite: [] as string[],
      bashTimeoutSeconds: 600,
    },
    cwd: "/sbxroot/work/tree",
    scratchDir: "/sbxroot/nowhere/scratch1",
    home: "/sbxroot/home/x",
    dataDenyPaths: { dirs: ["/sbxroot/data/queue"], files: ["/sbxroot/data/watchlist.json"] },
    network: false,
  };

  it("routes an observed regular file to readDenyFiles, not readDenyPaths", () => {
    const p = buildPolicy({
      ...base,
      cfg: { ...base.cfg, extraDenyRead: ["/sbxroot/elsewhere/.netrc"] },
      isFile: (q) => q === "/sbxroot/elsewhere/.netrc",
    });
    expect(p.readDenyFiles).toContain("/sbxroot/elsewhere/.netrc");
    expect(p.readDenyPaths).not.toContain("/sbxroot/elsewhere/.netrc");
    // The point of the reclassification: bwrap gets a mount it can actually
    // perform. `--tmpfs <regular file>` cannot be mounted (tmpfs needs a
    // directory), so the old shape aborted the whole spawn on Linux.
    const args = bwrapArgs(p, () => true);
    const at = (tokens: string[]): number =>
      args.findIndex((_, i) => tokens.every((t, k) => args[i + k] === t));
    expect(at(["--ro-bind", "/dev/null", "/sbxroot/elsewhere/.netrc"])).toBeGreaterThanOrEqual(0);
    expect(at(["--tmpfs", "/sbxroot/elsewhere/.netrc"])).toBe(-1);
  });

  it("keeps a directory — and a path that does not exist yet — as a SUBTREE deny", () => {
    // The absent case has no observation to go on, and a subtree rule is the
    // strictly stronger of the two on the name-based backends: it denies the
    // path AND anything under it, so it is right whichever kind it turns out
    // to be. Guessing "file" would expose the contents of a directory created
    // later, and buys nothing on bwrap (a mount at a missing target is skipped
    // either way).
    const p = buildPolicy({
      ...base,
      cfg: { ...base.cfg, extraDenyRead: ["/sbxroot/wt/secrets", "/sbxroot/wt/not-yet"] },
      isFile: () => false, // a dir, and a path that does not exist
    });
    expect(p.readDenyPaths).toContain("/sbxroot/wt/secrets");
    expect(p.readDenyPaths).toContain("/sbxroot/wt/not-yet");
    expect(p.readDenyFiles).toEqual(["/sbxroot/data/watchlist.json"]);
    const rules = readRules(p);
    expect(resolveRead("/sbxroot/wt/secrets/inner/key.pem", rules)).toBe("deny");
    expect(resolveRead("/sbxroot/wt/not-yet/created/later", rules)).toBe("deny");
  });

  it("does NOT put an operator's file-deny through the #311 guard", () => {
    // Denying a `.env` that exists inside the agent's own worktree is the
    // documented, supported use case (docs/superpowers/plans/
    // 2026-08-22-sandbox-allow-over-deny.md) — and unlike a lazily-written
    // data-tree receipt it is OBSERVED to exist, which is the guard's whole
    // premise. Refusing it would outlaw a configuration all three backends
    // already agree on, so the guard sees only the data-tree deny files.
    const p = buildPolicy({
      ...base,
      cwd: "/sbxroot/wt",
      cfg: { ...base.cfg, extraDenyRead: ["/sbxroot/wt/.env"] },
      isFile: (q) => q === "/sbxroot/wt/.env",
    });
    expect(p.readDenyFiles).toContain("/sbxroot/wt/.env");
    expect(resolveRead("/sbxroot/wt/.env", readRules(p))).toBe("deny");
    expect(resolveRead("/sbxroot/wt/src/a.ts", readRules(p))).toBe("allow");
    // …and the agreement is real on bwrap: the /dev/null mask is deeper than
    // the worktree's rw bind, so `mountOrder` emits it AFTER and it survives.
    const args = bwrapArgs(p, () => true);
    const at = (tokens: string[]): number =>
      args.findIndex((_, i) => tokens.every((t, k) => args[i + k] === t));
    expect(at(["--ro-bind", "/dev/null", "/sbxroot/wt/.env"])).toBeGreaterThan(
      at(["--bind", "/sbxroot/wt", "/sbxroot/wt"]),
    );
  });

  it("defaults the observation to the real filesystem", () => {
    // No `isFile` injected: the synthetic paths do not exist, so the default
    // statSync-based probe answers "not a file" and nothing is reclassified.
    const p = buildPolicy({ ...base, cfg: { ...base.cfg, extraDenyRead: ["/sbxroot/nope"] } });
    expect(p.readDenyPaths).toContain("/sbxroot/nope");
    expect(p.readDenyFiles).toEqual(["/sbxroot/data/watchlist.json"]);
  });
});

// #336 widened the builtins with FILE-shaped entries (~/.npmrc, ~/.netrc, …).
// Left as subtree denies, an existing one would render on bwrap as
// `--tmpfs <file>` — a mount tmpfs cannot perform — and abort every spawn on
// Linux, exactly the F5 shape above. So the builtins go through the same
// observation-based split as `extra_deny_read`.
describe("buildPolicy — builtin credential files are classified by observation (#336)", () => {
  const home = "/sbxroot/home/x";
  const cwd = "/sbxroot/work/tree";
  const base = {
    cfg: {
      enabled: true,
      backend: "auto" as const,
      network: "deny" as const,
      extraDenyRead: [] as string[],
      extraAllowWrite: [] as string[],
      bashTimeoutSeconds: 600,
    },
    cwd,
    scratchDir: "/sbxroot/nowhere/scratch1",
    home,
    dataDenyPaths: { dirs: ["/sbxroot/data/queue"], files: ["/sbxroot/data/watchlist.json"] },
    network: false,
  };
  const at = (args: string[], tokens: string[]): number =>
    args.findIndex((_, i) => tokens.every((t, k) => args[i + k] === t));

  it("routes a builtin observed to be a regular file to readDenyFiles, never readDenyPaths", () => {
    const npmrc = `${home}/.npmrc`;
    const p = buildPolicy({ ...base, isFile: (q) => q === npmrc });
    expect(p.readDenyFiles).toContain(npmrc);
    expect(p.readDenyPaths).not.toContain(npmrc);
    // The other builtins are unaffected by one observation.
    expect(p.readDenyPaths).toContain(`${home}/.ssh`);
    expect(p.readDenyPaths).toContain(`${home}/.netrc`);
    const args = bwrapArgs(p, () => true);
    expect(at(args, ["--ro-bind", "/dev/null", npmrc])).toBeGreaterThanOrEqual(0);
    expect(at(args, ["--tmpfs", npmrc])).toBe(-1);
    expect(resolveRead(npmrc, readRules(p))).toBe("deny");
  });

  it("keeps an absent builtin as a SUBTREE deny, denied by name on the path-jail", () => {
    // No `isFile` injected: the synthetic home does not exist, so nothing is
    // reclassified and every builtin stays the name-based, stronger kind.
    const p = buildPolicy(base);
    expect(p.readDenyFiles).toEqual(["/sbxroot/data/watchlist.json"]);
    for (const rel of [".npmrc", ".git-credentials", ".docker/config.json", ".kube", ".claude"]) {
      expect(p.readDenyPaths).toContain(`${home}/${rel}`);
    }
    const rules = readRules(p);
    expect(resolveRead(`${home}/.npmrc`, rules)).toBe("deny");
    expect(resolveRead(`${home}/.kube/config`, rules)).toBe("deny");
    expect(resolveRead(`${home}/.config/gcloud/credentials.db`, rules)).toBe("deny");
    expect(resolveRead(`${home}/.cargo/credentials.toml`, rules)).toBe("deny");
    // …while the toolchain dirs around the denied files stay readable.
    expect(resolveRead(`${home}/.cargo/bin/cargo`, rules)).toBe("allow");
    expect(resolveRead(`${home}/.docker/cli-plugins/docker-compose`, rules)).toBe("allow");
    expect(() => assertReadAllowed(`${home}/.git-credentials`, cwd, p)).toThrow(SandboxViolation);
    expect(() => assertReadAllowed(`${home}/.claude/settings.json`, cwd, p)).toThrow(
      SandboxViolation,
    );
  });
});

// F1 (final review 2026-08-22), the policy half. The execution half — the one
// that actually caught this, and the one that matters — is the real-backend
// `git` case in tests/sandbox.integration.test.ts.
describe("traversalMetadataPaths — the denied ancestors of every allow", () => {
  const root = "/sbxroot/home/.junco";
  const base = {
    cfg: {
      enabled: true,
      backend: "auto" as const,
      network: "deny" as const,
      extraDenyRead: [] as string[],
      extraAllowWrite: [] as string[],
      bashTimeoutSeconds: 600,
    },
    cwd: `${root}/cache/worktrees/tkt-1`,
    scratchDir: "/sbxroot/scratch",
    home: "/sbxroot/home",
    dataDenyPaths: { dirs: [root], files: [`${root}/cache/update-check.json`] },
    dataAllowPaths: [`${root}/cache/clones`, `${root}/cache/worktrees`],
    network: false,
  };

  it("names exactly the denied path components between the root and an allow", () => {
    // v2's shape: the wholesale root deny plus the narrowed cache/clones
    // allow-back leave TWO denied components in front of the clone gitdir.
    expect(traversalMetadataPaths(buildPolicy(base))).toEqual([root, `${root}/cache`]);
  });

  it("stops at the allow itself and never names an allowed ancestor", () => {
    // flat: the allow-backs sit directly at the root, so only <root> is denied.
    const p = buildPolicy({
      ...base,
      cwd: `${root}/worktrees/tkt-1`,
      dataAllowPaths: [`${root}/clones`, `${root}/worktrees`],
      dataDenyPaths: { dirs: [root], files: [`${root}/watchlist.json`] },
    });
    expect(traversalMetadataPaths(p)).toEqual([root]);
  });

  it("is empty when nothing denied sits above an allow", () => {
    const p = buildPolicy({
      ...base,
      dataDenyPaths: { dirs: [`${root}/queue`], files: [] },
      dataAllowPaths: [],
    });
    expect(traversalMetadataPaths(p)).toEqual([]);
  });

  it("never names a denied FILE, only denied directories", () => {
    // An allow nested under a deny file is a self-contradictory config; opening
    // stat() on the receipt would still leak its size and mtime.
    const p: SandboxPolicy = {
      writableRoots: [`${root}/spend.json/inner`],
      readDenyPaths: [root],
      readDenyFiles: [`${root}/spend.json`],
      readAllowPaths: [],
      network: false,
      scratchDir: "/sbxroot/scratch",
      bashTimeoutMs: undefined,
    };
    expect(traversalMetadataPaths(p)).toEqual([root]);
  });
});
