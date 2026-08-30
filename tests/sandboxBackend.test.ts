import { describe, it, expect } from "vitest";
import {
  seatbeltProfile,
  bwrapArgs,
  seatbeltBackend,
  bwrapBackend,
  noneBackend,
  selectBackend,
  classifyAvailability,
  defaultExecProbe,
  PROBE_STDERR_LIMIT,
} from "../src/agent/sandbox/backend.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const denyNet: SandboxPolicy = {
  writableRoots: ["/work/tree", "/tmp/scratch"],
  readDenyPaths: ["/home/x/.ssh"],
  readDenyFiles: [],
  readAllowPaths: [],
  network: false,
  scratchDir: "/tmp/scratch",
  bashTimeoutMs: undefined,
};
const allowNet: SandboxPolicy = { ...denyNet, network: true };

// The #277 three-deep shape: deny the root wholesale, allow cache/ back,
// re-deny a sensitive subtree nested inside that allow-back. Deliberately
// listed root-then-mirror (not depth order) — emission order must come from
// orderRules, not list position.
const nestedPolicy: SandboxPolicy = {
  writableRoots: ["/sbxroot/work/tree"],
  readDenyPaths: ["/sbxroot/.junco", "/sbxroot/.junco/cache/mirror"],
  readDenyFiles: [],
  readAllowPaths: ["/sbxroot/.junco/cache"],
  network: false,
  scratchDir: "/sbxroot/scratch",
  bashTimeoutMs: undefined,
};

// The C1 regression shape: the worktree (cwd) and clones live UNDER the data
// root; only the sensitive subtrees/files are denied — never the root itself.
const dataDir = "/sbxroot/home/x/.local/state/junco";
const dataPolicy: SandboxPolicy = {
  writableRoots: [`${dataDir}/worktrees/tkt-1`, "/sbxroot/scratch"],
  readDenyPaths: [`${dataDir}/queue`, `${dataDir}/review`, `${dataDir}/transcripts`],
  readDenyFiles: [`${dataDir}/watchlist.json`],
  readAllowPaths: [],
  network: false,
  scratchDir: "/sbxroot/scratch",
  bashTimeoutMs: undefined,
};

// The armed #277 shape (Task 7): the worktree lives UNDER a wholesale-denied
// data root, with cache/ allowed back and mirror/ re-denied inside it.
const armedPolicy: SandboxPolicy = {
  writableRoots: ["/sbxroot/.junco/cache/worktrees/tkt-1", "/sbxroot/scratch"],
  readDenyPaths: ["/sbxroot/.junco", "/sbxroot/.junco/cache/mirror"],
  readDenyFiles: ["/sbxroot/.junco/watchlist.json"],
  readAllowPaths: ["/sbxroot/.junco/cache"],
  network: false,
  scratchDir: "/sbxroot/scratch",
  bashTimeoutMs: undefined,
};

// An operator's extra_deny_read INSIDE their own worktree: a deny deeper than
// a writable root still wins (policy.ts's readRules pins that deliberately).
const denyInsideWorktree: SandboxPolicy = {
  writableRoots: ["/sbxroot/wt"],
  readDenyPaths: ["/sbxroot/wt/secrets"],
  readDenyFiles: ["/sbxroot/wt/.env"],
  readAllowPaths: [],
  network: false,
  scratchDir: "/sbxroot/scratch",
  bashTimeoutMs: undefined,
};

/** argv index where the mount op `tokens` starts, or -1. bwrap mounts apply in
 *  argv order and later mounts are destructive, so index IS meaning here. */
function opAt(args: string[], tokens: string[]): number {
  return args.findIndex((_, i) => tokens.every((t, k) => args[i + k] === t));
}

/** Start index of every read-deny mount the policy asks for (tmpfs for a
 *  subtree, /dev/null ro-bind for a file). */
function denyMountIndices(args: string[], policy: SandboxPolicy): number[] {
  return [
    ...policy.readDenyPaths.map((d) => opAt(args, ["--tmpfs", d])),
    ...policy.readDenyFiles.map((f) => opAt(args, ["--ro-bind", "/dev/null", f])),
  ];
}

describe("seatbeltProfile", () => {
  it("denies default, allows writes only under the roots, and denies network", () => {
    const p = seatbeltProfile(denyNet);
    expect(p).toContain("(version 1)");
    expect(p).toContain("(deny default)");
    expect(p).toContain('(subpath "/work/tree")');
    expect(p).toContain('(subpath "/tmp/scratch")');
    expect(p).toContain('(deny file-read* (subpath "/home/x/.ssh"))');
    expect(p).toContain("(deny network*)");
  });
  it("allows network when policy.network is true", () => {
    const p = seatbeltProfile(allowNet);
    expect(p).toContain("(allow network*)");
    expect(p).not.toContain("(deny network*)");
  });
  it("denies the sensitive data subtrees (subpath) + files (literal), never the data root", () => {
    const p = seatbeltProfile(dataPolicy);
    expect(p).toContain(`(deny file-read* (subpath "${dataDir}/queue"))`);
    expect(p).toContain(`(deny file-read* (subpath "${dataDir}/review"))`);
    expect(p).toContain(`(deny file-read* (literal "${dataDir}/watchlist.json"))`);
    // The root itself is NOT denied — the worktree the agent runs in and the
    // clone gitdirs live under it, and a subpath deny overrides the broad allow.
    expect(p).not.toContain(`(deny file-read* (subpath "${dataDir}"))`);
  });

  // Every prior assertion in this describe block is `toContain` — order-blind
  // by construction. SBPL is last-match-wins, so *meaning* depends entirely on
  // line order; only an indexOf-based assertion can catch a reordering bug.
  describe("precedence order (allow-over-deny, #277)", () => {
    it("emits the cache allow AFTER the junco deny and BEFORE the mirror deny", () => {
      const p = seatbeltProfile(nestedPolicy);
      const denyRoot = p.indexOf(`(deny file-read* (subpath "/sbxroot/.junco"))`);
      const allowCache = p.indexOf(`(allow file-read* (subpath "/sbxroot/.junco/cache"))`);
      const denyMirror = p.indexOf(`(deny file-read* (subpath "/sbxroot/.junco/cache/mirror"))`);
      expect(denyRoot).toBeGreaterThanOrEqual(0);
      expect(allowCache).toBeGreaterThan(denyRoot);
      expect(denyMirror).toBeGreaterThan(allowCache);
    });

    it("keeps the broad catch-all allow before every read deny/allow-back rule", () => {
      const p = seatbeltProfile(nestedPolicy);
      const broadAllow = p.indexOf("(allow file-read*)");
      const denyRoot = p.indexOf(`(deny file-read* (subpath "/sbxroot/.junco"))`);
      const allowCache = p.indexOf(`(allow file-read* (subpath "/sbxroot/.junco/cache"))`);
      const denyMirror = p.indexOf(`(deny file-read* (subpath "/sbxroot/.junco/cache/mirror"))`);
      expect(broadAllow).toBeGreaterThanOrEqual(0);
      expect(denyRoot).toBeGreaterThan(broadAllow);
      expect(allowCache).toBeGreaterThan(broadAllow);
      expect(denyMirror).toBeGreaterThan(broadAllow);
    });
  });

  // F1 (final review 2026-08-22). The wholesale root deny EPERMs lstat() on
  // <root>, and git realpaths every component of the linked worktree's gitdir
  // on the way in — so `git rev-parse`/`status`/`diff` aborted with
  // "fatal: Invalid path '<root>': Operation not permitted" while `cat` kept
  // working. The repair is metadata-only access to the denied components.
  describe("traversal metadata for denied ancestors (F1)", () => {
    it("allows file-read-metadata on the denied ancestors of an allow-back", () => {
      const p = seatbeltProfile(armedPolicy);
      expect(p).toContain('(allow file-read-metadata (literal "/sbxroot/.junco"))');
      // …and nothing wider: the node's CONTENTS stay denied, so no listing and
      // no file under it becomes readable.
      expect(p).toContain('(deny file-read* (subpath "/sbxroot/.junco"))');
      expect(p).not.toContain('(allow file-read* (subpath "/sbxroot/.junco"))');
    });

    it("emits them AFTER every deny — the profile is last-match-wins", () => {
      // `(deny file-read* (subpath <root>))` covers the metadata operation too,
      // so a metadata allow emitted before it would be overridden and the fix
      // would silently do nothing.
      const p = seatbeltProfile(armedPolicy);
      const denyRoot = p.indexOf('(deny file-read* (subpath "/sbxroot/.junco"))');
      const denyMirror = p.indexOf('(deny file-read* (subpath "/sbxroot/.junco/cache/mirror"))');
      const denyReceipt = p.indexOf('(deny file-read* (literal "/sbxroot/.junco/watchlist.json"))');
      const meta = p.indexOf('(allow file-read-metadata (literal "/sbxroot/.junco"))');
      expect(denyRoot).toBeGreaterThanOrEqual(0);
      expect(meta).toBeGreaterThan(denyRoot);
      expect(meta).toBeGreaterThan(denyMirror);
      expect(meta).toBeGreaterThan(denyReceipt);
    });

    it("emits nothing when no denied directory sits above an allow", () => {
      expect(seatbeltProfile(dataPolicy)).not.toContain("file-read-metadata");
    });
  });
});

describe("seatbeltBackend.spawnArgv", () => {
  it("passes the profile inline and runs bash -c", () => {
    const argv = seatbeltBackend.spawnArgv("echo hi", denyNet);
    expect(argv[0]).toBe("sandbox-exec");
    expect(argv[1]).toBe("-p");
    expect(argv[2]).toContain("(deny default)");
    expect(argv.slice(3)).toEqual(["/bin/bash", "-c", "echo hi"]);
  });
});

describe("bwrapArgs", () => {
  it("ro-binds root, rw-binds writable roots, masks denials, unshares net when denied", () => {
    const a = bwrapArgs(denyNet, () => true).join(" ");
    expect(a).toContain("--ro-bind / /");
    expect(a).toContain("--bind /work/tree /work/tree");
    expect(a).toContain("--bind /tmp/scratch /tmp/scratch");
    expect(a).toContain("--tmpfs /home/x/.ssh");
    expect(a).toContain("--unshare-net");
  });
  it("does not unshare net when network is allowed", () => {
    expect(bwrapArgs(allowNet, () => true).join(" ")).not.toContain("--unshare-net");
  });
  it("masks only the sensitive data subtrees, never the data root, for today's policy", () => {
    const args = bwrapArgs(dataPolicy, () => true);
    const a = args.join(" ");
    // Today's dataTree policy denies SUBTREES of the data root, not the root
    // itself (#277 Task 7 changes that), so no tmpfs targets the root or any
    // ancestor of the worktree. The worktree stays rw-bound either way: its
    // bind is emitted after every deny mount it does not contain.
    expect(a).toContain(`--bind ${dataDir}/worktrees/tkt-1 ${dataDir}/worktrees/tkt-1`);
    const tmpfsTargets = args.flatMap((v, i) => (args[i - 1] === "--tmpfs" ? [v] : []));
    expect(tmpfsTargets).not.toContain(dataDir);
    for (const t of tmpfsTargets) {
      expect(`${dataDir}/worktrees/tkt-1/`.startsWith(`${t}/`)).toBe(false);
    }
    // The sensitive subtrees are still masked.
    expect(tmpfsTargets).toContain(`${dataDir}/queue`);
    expect(tmpfsTargets).toContain(`${dataDir}/review`);
  });
  it("masks denied files that exist with a /dev/null ro-bind; skips missing paths", () => {
    const exists = (p: string): boolean => p !== `${dataDir}/review`;
    const a = bwrapArgs(dataPolicy, exists).join(" ");
    expect(a).toContain(`--ro-bind /dev/null ${dataDir}/watchlist.json`);
    // A missing deny target gets no mount: bwrap cannot create mountpoints
    // under the read-only root bind, and a path that does not exist cannot
    // be read anyway (the JS jail still denies it by name).
    expect(a).not.toContain(`--tmpfs ${dataDir}/review`);
    expect(a).toContain(`--tmpfs ${dataDir}/queue`);
  });

  // Every assertion above is `toContain` on a joined string — order-blind by
  // construction. bwrap mounts apply in argv ORDER and later mounts are
  // destructive, so only indexOf-style assertions can catch a reordering bug,
  // and a reordering bug here reads as harmless while widening access.
  describe("mount order (allow-over-deny, #277)", () => {
    it("binds the cache allow-back AFTER the junco deny and BEFORE the nested mirror deny", () => {
      const args = bwrapArgs(nestedPolicy, () => true);
      const denyRoot = opAt(args, ["--tmpfs", "/sbxroot/.junco"]);
      const allowCache = opAt(args, [
        "--ro-bind",
        "/sbxroot/.junco/cache",
        "/sbxroot/.junco/cache",
      ]);
      const denyMirror = opAt(args, ["--tmpfs", "/sbxroot/.junco/cache/mirror"]);
      expect(denyRoot).toBeGreaterThanOrEqual(0);
      // The allow-back must land after the tmpfs that masks its ancestor,
      // otherwise the tmpfs shadows it and cache/ is invisible...
      expect(allowCache).toBeGreaterThan(denyRoot);
      // ...and the nested deny must land after the allow-back, otherwise the
      // allow-back re-exposes mirror/. This is the #277 over-permission bug.
      expect(denyMirror).toBeGreaterThan(allowCache);
    });

    it("keeps the base mounts first, with the least-specific deny right after", () => {
      const args = bwrapArgs(nestedPolicy, () => true);
      expect(args.slice(0, 9)).toEqual([
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
      ]);
      expect(opAt(args, ["--tmpfs", "/sbxroot/.junco"])).toBe(9);
    });

    for (const [name, policy] of [
      ["the #277 nested shape", nestedPolicy],
      ["the armed shape (worktree under a denied root)", armedPolicy],
      ["today's data-tree shape", dataPolicy],
      ["a plain policy", denyNet],
    ] as const) {
      it(`binds every writable root after every deny mount — ${name}`, () => {
        const args = bwrapArgs(policy, () => true);
        const denies = denyMountIndices(args, policy);
        const writes = policy.writableRoots.map((w) => opAt(args, ["--bind", w, w]));
        for (const i of [...denies, ...writes]) expect(i).toBeGreaterThanOrEqual(0);
        expect(Math.min(...writes)).toBeGreaterThan(Math.max(...denies));
      });
    }

    it("rw-binds a worktree nested under a wholesale-denied root, after the tmpfs", () => {
      // The full armed (#277 Task 7) chain, in one strictly increasing run:
      // mask the root → re-expose cache/ → re-mask mirror/ → bind the worktree.
      const args = bwrapArgs(armedPolicy, () => true);
      const wt = "/sbxroot/.junco/cache/worktrees/tkt-1";
      const chain = [
        opAt(args, ["--tmpfs", "/sbxroot/.junco"]),
        opAt(args, ["--ro-bind", "/sbxroot/.junco/cache", "/sbxroot/.junco/cache"]),
        opAt(args, ["--tmpfs", "/sbxroot/.junco/cache/mirror"]),
        opAt(args, ["--bind", wt, wt]),
      ];
      for (const i of chain) expect(i).toBeGreaterThanOrEqual(0);
      expect(chain).toEqual([...chain].sort((a, b) => a - b));
      // A writable root is bound rw, never merely ro-bound back.
      expect(opAt(args, ["--ro-bind", wt, wt])).toBe(-1);
    });

    it("keeps a deny nested INSIDE a writable root after that root's bind", () => {
      // A writable bind emitted after this deny would restore the pristine
      // host subtree over the mask and un-deny it — the OS layer would then
      // disagree with resolveRead and with the seatbelt profile.
      const args = bwrapArgs(denyInsideWorktree, () => true);
      const bind = opAt(args, ["--bind", "/sbxroot/wt", "/sbxroot/wt"]);
      expect(bind).toBeGreaterThanOrEqual(0);
      expect(opAt(args, ["--tmpfs", "/sbxroot/wt/secrets"])).toBeGreaterThan(bind);
      expect(opAt(args, ["--ro-bind", "/dev/null", "/sbxroot/wt/.env"])).toBeGreaterThan(bind);
    });
  });

  describe("existence guard", () => {
    it("skips an allow-back whose source is missing (a bind needs its source)", () => {
      const missingCache = (p: string): boolean => p !== "/sbxroot/.junco/cache";
      const args = bwrapArgs(nestedPolicy, missingCache);
      expect(opAt(args, ["--ro-bind", "/sbxroot/.junco/cache", "/sbxroot/.junco/cache"])).toBe(-1);
      // The deny it would have overridden still applies.
      expect(opAt(args, ["--tmpfs", "/sbxroot/.junco"])).toBeGreaterThanOrEqual(0);
    });

    it("never guards a writable-root bind: a missing worktree must fail loudly", () => {
      const args = bwrapArgs(denyNet, () => false).join(" ");
      expect(args).toContain("--bind /work/tree /work/tree");
      expect(args).toContain("--bind /tmp/scratch /tmp/scratch");
      expect(args).not.toContain("--tmpfs /home/x/.ssh");
    });
  });
});

describe("bwrapBackend.spawnArgv", () => {
  it("prefixes bwrap args and runs bash -c", () => {
    const argv = bwrapBackend.spawnArgv("echo hi", denyNet);
    expect(argv[0]).toBe("bwrap");
    expect(argv.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
  });
});

describe("noneBackend", () => {
  it("runs bash -c directly and is always available", async () => {
    expect(noneBackend.spawnArgv("echo hi", denyNet)).toEqual(["/bin/bash", "-c", "echo hi"]);
    expect((await noneBackend.checkAvailability(async () => ({ code: 127 }))).available).toBe(true);
  });
});

describe("selectBackend", () => {
  it("auto → seatbelt on darwin, bwrap on linux", () => {
    expect(selectBackend("auto", "darwin").name).toBe("seatbelt");
    expect(selectBackend("auto", "linux").name).toBe("bwrap");
  });
  it("explicit backends win regardless of platform", () => {
    expect(selectBackend("bwrap", "darwin").name).toBe("bwrap");
    expect(selectBackend("seatbelt", "linux").name).toBe("seatbelt");
    expect(selectBackend("none", "darwin").name).toBe("none");
  });
  it("auto on an unsupported platform yields none", () => {
    expect(selectBackend("auto", "win32").name).toBe("none");
  });
});

describe("checkAvailability", () => {
  it("seatbelt available when probe exits 0", async () => {
    expect((await seatbeltBackend.checkAvailability(async () => ({ code: 0 }))).available).toBe(
      true,
    );
    expect((await seatbeltBackend.checkAvailability(async () => ({ code: 127 }))).available).toBe(
      false,
    );
  });

  // #312: the exit code stays the decision input, but a refusal the child
  // EXPLAINED must not be thrown away — "unavailable" alone sent a CI diagnosis
  // through the runner's image version instead of through bwrap's own words.
  it("carries the child's stderr as the failure reason", async () => {
    const r = await bwrapBackend.checkAvailability(async () => ({
      code: 1,
      stderr: "bwrap: Creating new namespace failed: Operation not permitted\n",
    }));
    expect(r.available).toBe(false);
    expect(r.reason).toContain("Creating new namespace failed: Operation not permitted");
  });

  it("a passing probe carries no reason", async () => {
    const r = await bwrapBackend.checkAvailability(async () => ({ code: 0, stderr: "noise\n" }));
    expect(r).toEqual({ available: true });
  });

  it("a silent failure yields no reason (nothing to report is not an empty string)", async () => {
    const r = await bwrapBackend.checkAvailability(async () => ({ code: 127, stderr: "   \n" }));
    expect(r.available).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it("bounds a runaway stderr and collapses it to one line", async () => {
    const r = await bwrapBackend.checkAvailability(async () => ({
      code: 1,
      stderr: `bwrap: boom\n${"x".repeat(500_000)}`,
    }));
    expect(r.reason?.length).toBeLessThanOrEqual(PROBE_STDERR_LIMIT + 1); // + the ellipsis
    expect(r.reason).toMatch(/^bwrap: boom /);
    expect(r.reason).not.toContain("\n");
  });
});

describe("defaultExecProbe", () => {
  // A real child, but a harmless one: `bwrap` is unavailable on the macOS dev
  // host and the point is the plumbing, not the backend.
  it("captures the child's stderr alongside the exit code", async () => {
    const r = await defaultExecProbe(process.execPath, [
      "-e",
      "process.stderr.write('bwrap: Creating new namespace failed'); process.exit(1)",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("bwrap: Creating new namespace failed");
  });

  it("a missing binary is 127 with the spawn failure as the reason", async () => {
    const r = await defaultExecProbe("/nonexistent/junco-probe-binary", []);
    expect(r.code).toBe(127);
    expect(r.stderr ?? "").toMatch(/ENOENT/);
  });

  it("a clean run reports code 0 and nothing to explain", async () => {
    const r = await defaultExecProbe(process.execPath, ["-e", ""]);
    expect(r).toEqual({ code: 0 });
  });
});

describe("classifyAvailability", () => {
  it("none is always ok (no OS isolation by design)", () => {
    expect(classifyAvailability("none", "none", false)).toBe("ok");
    expect(classifyAvailability("auto", "none", false)).toBe("ok"); // auto on an unsupported platform
  });
  it("available backend is ok", () => {
    expect(classifyAvailability("bwrap", "bwrap", true)).toBe("ok");
    expect(classifyAvailability("auto", "seatbelt", true)).toBe("ok");
  });
  it("auto + unavailable degrades (best-available → none)", () => {
    expect(classifyAvailability("auto", "bwrap", false)).toBe("degrade");
    expect(classifyAvailability("auto", "seatbelt", false)).toBe("degrade");
  });
  it("an explicit backend + unavailable fails closed", () => {
    expect(classifyAvailability("bwrap", "bwrap", false)).toBe("fail-closed");
    expect(classifyAvailability("seatbelt", "seatbelt", false)).toBe("fail-closed");
  });
});
