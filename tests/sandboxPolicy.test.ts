import { describe, it, expect } from "vitest";
import {
  builtinDenyReadPaths,
  buildPolicy,
  readRules,
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

  it("denies reads of the bot gh config dir when provided", () => {
    const p = buildPolicy({
      cfg: {
        enabled: true,
        backend: "none",
        network: "deny",
        extraDenyRead: [],
        extraAllowWrite: [],
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
});
