import { describe, it, expect, vi } from "vitest";
import { resolveSandbox } from "../src/agent/session.js";
import { log } from "../src/logging.js";
import { SandboxUnavailableError } from "../src/agent/sandbox/index.js";
import { readRules } from "../src/agent/sandbox/policy.js";
import { resolveRead } from "../src/agent/sandbox/precedence.js";
import { assertWriteAllowed } from "../src/agent/sandbox/pathJail.js";
import type { Config } from "../src/types.js";

function cfgWith(sandbox: Partial<Config["sandbox"]>): Config {
  // resolveSandbox reads cfg.sandbox, cfg.botAccount.configDir, and the data
  // tree fields consumed by dataTree.sandboxDenyPaths (dataDir, queueRoot,
  // worktreeRoot, github.externalReposRoot, legacy).
  return {
    dataDir: "/sbxroot/state",
    queueRoot: "/sbxroot/state/queue",
    worktreeRoot: "/sbxroot/state/worktrees",
    legacy: {
      vaultRoot: false,
      stateDir: false,
      worktreeRoot: false,
      externalReposRoot: false,
      dataRoot: false,
    },
    github: { externalReposRoot: "/sbxroot/state/clones/external" },
    botAccount: {
      enabled: false,
      configDir: "/sbxroot/junco-gh",
    },
    sandbox: {
      enabled: true,
      backend: "none",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
      bashTimeoutSeconds: 600,
      ...sandbox,
    },
  } as unknown as Config;
}

// Synthetic, guaranteed-nonexistent paths so canonicalize() (real fs) is a
// deterministic no-op — /tmp is a symlink on macOS.
const okDeps = {
  probe: async () => ({ code: 0 }),
  makeScratch: () => "/sbxroot/scratch",
  platform: "linux" as NodeJS.Platform,
  home: "/sbxroot/home/x",
  gitDirs: async () => null,
  pathExists: () => true,
  ensureDir: () => {},
};

describe("resolveSandbox", () => {
  it("returns null when disabled (no-op path)", async () => {
    const r = await resolveSandbox(cfgWith({ enabled: false }), "/work", undefined, okDeps);
    expect(r).toBeNull();
  });

  it("builds policy + backend when enabled and available", async () => {
    const r = await resolveSandbox(
      cfgWith({ backend: "none" }),
      "/sbxroot/work",
      undefined,
      okDeps,
    );
    expect(r?.backend.name).toBe("none");
    expect(r?.policy.writableRoots).toContain("/sbxroot/work");
    expect(r?.policy.scratchDir).toBe("/sbxroot/scratch");
    expect(r?.policy.network).toBe(false);
    // The bot gh config dir is denied even with botAccount.enabled=false in the
    // fixture — a token may sit in the dir while the feature is off, so the
    // pass-through must stay unconditional.
    expect(r?.policy.readDenyPaths).toContain("/sbxroot/junco-gh");
  });

  // #277: session.ts must thread BOTH halves of dataTree's answer into
  // buildPolicy — the wholesale root deny AND the allow-backs. Passing only the
  // denies would wall the agent out of its own worktree; passing only the
  // allows would leave the queue readable.
  it("denies the data root wholesale and threads the allow-backs into the policy", async () => {
    const r = await resolveSandbox(
      cfgWith({ backend: "none" }),
      "/sbxroot/state/worktrees/tkt-1",
      undefined,
      okDeps,
    );
    const policy = r?.policy;
    if (!policy) throw new Error("expected a sandbox policy");
    expect(policy.readDenyPaths).toContain("/sbxroot/state");
    expect(policy.readDenyPaths).toContain("/sbxroot/state/queue");
    expect(policy.readDenyFiles).toContain("/sbxroot/state/watchlist.json");
    expect(policy.readAllowPaths).toContain("/sbxroot/state/worktrees");
    expect(policy.readAllowPaths).toContain("/sbxroot/state/clones");
    // …and they resolve the way the agent experiences them (flat layout).
    const rules = readRules(policy);
    expect(resolveRead("/sbxroot/state/transcripts/tkt-1.jsonl", rules)).toBe("deny");
    expect(resolveRead("/sbxroot/state/review/assess/o__r.json", rules)).toBe("deny");
    expect(resolveRead("/sbxroot/state/worktrees/tkt-1/src/a.ts", rules)).toBe("allow");
    expect(resolveRead("/sbxroot/state/clones/watched/o__r.git/HEAD", rules)).toBe("allow");
  });

  // #320: a LINKED worktree's git metadata lives under the owning repo's
  // .git, not under the cwd. resolveSandbox must ask git where that is and
  // thread the answer into the writable roots — or the very first
  // `git commit` fails with "Unable to create '…/index.lock'".
  it("threads the linked worktree's git metadata — not the common dir — into the writable roots (#320)", async () => {
    const cwd = "/sbxroot/state/worktrees/tkt-1";
    const common = "/sbxroot/state/clones/watched/o__r.git";
    const r = await resolveSandbox(cfgWith({ backend: "none" }), cwd, undefined, {
      ...okDeps,
      gitDirs: async (c) => {
        expect(c).toBe(cwd);
        return { gitDir: `${common}/worktrees/tkt-1`, commonDir: common };
      },
    });
    const policy = r?.policy;
    if (!policy) throw new Error("expected a sandbox policy");
    for (const p of [
      `${common}/worktrees/tkt-1`,
      `${common}/objects`,
      `${common}/refs`,
      `${common}/logs`,
    ]) {
      expect(policy.writableRoots).toContain(p);
    }
    expect(policy.writableRoots).not.toContain(common);
    const lock = `${common}/worktrees/tkt-1/index.lock`;
    expect(assertWriteAllowed(lock, cwd, policy)).toBe(lock);
    expect(() => assertWriteAllowed(`${common}/hooks/pre-commit`, cwd, policy)).toThrow();
    expect(() => assertWriteAllowed(`${common}/config`, cwd, policy)).toThrow();
    // The clones tier sits inside the wholesale-denied data root; the writable
    // root out-specifies that deny for reads too.
    expect(resolveRead(lock, readRules(policy))).toBe("allow");
  });

  it("creates a missing git write root (a fresh clone's logs/) and keeps it (#320)", async () => {
    const cwd = "/sbxroot/state/worktrees/tkt-1";
    const common = "/sbxroot/state/clones/watched/o__r.git";
    const created: string[] = [];
    const r = await resolveSandbox(cfgWith({ backend: "none" }), cwd, undefined, {
      ...okDeps,
      gitDirs: async () => ({ gitDir: `${common}/worktrees/tkt-1`, commonDir: common }),
      pathExists: (p) => !p.endsWith("/logs"),
      ensureDir: (p) => created.push(p),
    });
    const roots = r?.policy.writableRoots ?? [];
    expect(roots).toContain(`${common}/logs`);
    expect(created).toEqual([`${common}/logs`]);
  });

  it("drops a git write root it cannot create (bwrap must never bind a missing source)", async () => {
    const cwd = "/sbxroot/state/worktrees/tkt-1";
    const common = "/sbxroot/state/clones/watched/o__r.git";
    const r = await resolveSandbox(cfgWith({ backend: "none" }), cwd, undefined, {
      ...okDeps,
      gitDirs: async () => ({ gitDir: `${common}/worktrees/tkt-1`, commonDir: common }),
      pathExists: (p) => !p.endsWith("/logs"),
      ensureDir: () => {
        throw new Error("EACCES");
      },
    });
    const roots = r?.policy.writableRoots ?? [];
    expect(roots).toContain(`${common}/objects`);
    expect(roots).toContain(`${common}/refs`);
    expect(roots).toContain(`${common}/worktrees/tkt-1`);
    expect(roots).not.toContain(`${common}/logs`);
  });

  it("adds no git roots when the cwd is not a git checkout (#320)", async () => {
    const r = await resolveSandbox(cfgWith({ backend: "none" }), "/sbxroot/work", undefined, {
      ...okDeps,
      gitDirs: async () => null,
    });
    expect(r?.policy.writableRoots).toEqual(["/sbxroot/work", "/sbxroot/scratch"]);
  });

  // #346: the read-only flows (Q&A, audit, investigate) hand resolveSandbox the
  // operator's LIVE checkout as cwd. It must come out with scratch as the only
  // writable root, and the git-metadata lookup — which mkdir's a missing
  // logs/ under the owning repo's .git — must not run at all.
  it("readOnly: scratch is the only writable root and the checkout's git metadata is never looked up or created (#346)", async () => {
    const cwd = "/sbxroot/home/x/dev/repo";
    const gitDirs = vi.fn(async () => ({
      gitDir: "/sbxroot/home/x/dev/repo.git/worktrees/repo",
      commonDir: "/sbxroot/home/x/dev/repo.git",
    }));
    const ensureDir = vi.fn();
    const r = await resolveSandbox(
      cfgWith({ backend: "none" }),
      cwd,
      { readOnly: true },
      {
        ...okDeps,
        gitDirs,
        pathExists: () => false,
        ensureDir,
      },
    );
    const policy = r?.policy;
    if (!policy) throw new Error("expected a sandbox policy");
    expect(policy.writableRoots).toEqual(["/sbxroot/scratch"]);
    expect(gitDirs).not.toHaveBeenCalled();
    expect(ensureDir).not.toHaveBeenCalled();
    expect(() => assertWriteAllowed(`${cwd}/.git/HEAD`, cwd, policy)).toThrow();
    expect(() => assertWriteAllowed("src/a.ts", cwd, policy)).toThrow();
    expect(resolveRead(`${cwd}/src/a.ts`, readRules(policy))).toBe("allow");
  });

  it("per-ticket network override widens egress", async () => {
    const r = await resolveSandbox(cfgWith({}), "/work", { network: true }, okDeps);
    expect(r?.policy.network).toBe(true);
  });

  it("config network=allow widens egress without a per-ticket flag", async () => {
    const r = await resolveSandbox(cfgWith({ network: "allow" }), "/work", undefined, okDeps);
    expect(r?.policy.network).toBe(true);
  });

  it("fails closed when an EXPLICIT backend is unavailable", async () => {
    await expect(
      resolveSandbox(cfgWith({ backend: "bwrap" }), "/work", undefined, {
        ...okDeps,
        probe: async () => ({ code: 127 }),
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("backend=auto degrades to none (not fail-closed) when no OS backend is available", async () => {
    const r = await resolveSandbox(cfgWith({ backend: "auto" }), "/sbxroot/work", undefined, {
      ...okDeps,
      platform: "linux", // auto → bwrap
      probe: async () => ({ code: 127 }), // bwrap unavailable
    });
    // Degraded, not thrown: still returns a sandbox, but with the none backend.
    expect(r).not.toBeNull();
    expect(r?.backend.name).toBe("none");
    // The policy (env scrub + fs jail) is still built.
    expect(r?.policy.writableRoots).toContain("/sbxroot/work");
  });

  // #312: both refusal paths used to say only THAT the backend was unavailable.
  // "Install bubblewrap" is actively wrong when bubblewrap is installed and the
  // kernel is what refused (ubuntu-24.04's
  // kernel.apparmor_restrict_unprivileged_userns=1), so the probe's own words
  // have to reach the operator.
  it("the degrade warning names WHY the backend refused", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await resolveSandbox(cfgWith({ backend: "auto" }), "/sbxroot/work", undefined, {
        ...okDeps,
        platform: "linux",
        probe: async () => ({
          code: 1,
          stderr: "bwrap: Creating new namespace failed: Operation not permitted",
        }),
      });
      const said = warnSpy.mock.calls.map((c) => JSON.stringify(c)).join("\n");
      expect(said).toMatch(/Creating new namespace failed: Operation not permitted/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("the fail-closed error names WHY the backend refused", async () => {
    await expect(
      resolveSandbox(cfgWith({ backend: "bwrap" }), "/work", undefined, {
        ...okDeps,
        probe: async () => ({
          code: 1,
          stderr: "bwrap: Creating new namespace failed: Operation not permitted",
        }),
      }),
    ).rejects.toThrow(/Creating new namespace failed: Operation not permitted/);
  });

  it("a silent refusal still degrades cleanly, with no empty reason clause", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const r = await resolveSandbox(cfgWith({ backend: "auto" }), "/sbxroot/work", undefined, {
        ...okDeps,
        platform: "linux",
        probe: async () => ({ code: 127 }),
      });
      expect(r?.backend.name).toBe("none");
      const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(msg).toMatch(/no OS backend available/);
      expect(msg).not.toMatch(/probe said/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("backend=none never fails closed even if a probe would fail", async () => {
    const r = await resolveSandbox(cfgWith({ backend: "none" }), "/work", undefined, {
      ...okDeps,
      probe: async () => ({ code: 127 }),
    });
    expect(r?.backend.name).toBe("none");
  });
});
