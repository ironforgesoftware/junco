import { describe, it, expect, vi } from "vitest";
import {
  discoverService,
  inspectCheckout,
  kickstartService,
  runRestartCommand,
  type RestartDeps,
  type ServiceRef,
} from "../src/restartCmd.js";
import { join, isAbsolute } from "node:path";
import { workerLockPath } from "../src/lock.js";

const CONFIG = "/Users/u/junco/config.json";
/** Where the running dist "lives" — a git checkout when `checkout` is scripted,
 * a plain npm package dir otherwise. */
const PKG = "/sbx/pkg";

type Exec = { code: number; stdout: string; stderr: string };
const ok = (stdout: string): Exec => ({ code: 0, stdout, stderr: "" });

/** The git state of the checkout the dist resolves inside; `originMain: null`
 * models a checkout with no `origin/main` ref, `gitMissing` a host without git. */
interface FakeCheckout {
  dirty?: string[]; // `git status --porcelain` lines
  head?: string;
  branch?: string;
  originMain?: string | null;
  gitMissing?: boolean;
}

/** Fake launchd host: a LaunchAgents dir with named plists whose plutil-JSON
 * we script per filename; launchctl/systemctl calls are recorded. */
function makeFakes(opts: {
  plists?: Record<string, { Label: string; ProgramArguments: string[] } | "unreadable">;
  units?: Record<string, string>; // unit name → `systemctl --user cat` stdout
  lockPids?: (number | null)[]; // successive lockHolderFn answers
  platform?: NodeJS.Platform;
  kickFails?: boolean;
  restartBlocks?: boolean; // model a BLOCKING `systemctl restart` (no --no-block)
  checkout?: FakeCheckout; // absent → the dist is an npm install (no `.git` beside it)
}) {
  const calls: string[][] = [];
  const prints: string[] = [];
  const lockSeq = [...(opts.lockPids ?? [])];
  const co = opts.checkout;
  const deps: RestartDeps = {
    platform: opts.platform ?? "darwin",
    uid: 501,
    homedirFn: () => "/Users/u",
    packageRoot: PKG,
    readdirFn: (dir) =>
      dir === PKG
        ? co
          ? [".git", "dist", "package.json"]
          : ["dist", "package.json"]
        : Object.keys(opts.plists ?? {}),
    execFn: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "git") {
        if (co?.gitMissing) return { code: 127, stdout: "", stderr: "" };
        expect(args.slice(0, 2)).toEqual(["-C", PKG]);
        const sub = args.slice(2).join(" ");
        if (sub === "status --porcelain")
          return ok((co?.dirty ?? []).map((l) => `${l}\n`).join(""));
        if (sub === "rev-parse --abbrev-ref HEAD") return ok(`${co?.branch ?? "main"}\n`);
        if (sub === "rev-parse HEAD") return ok(`${co?.head ?? "aaaaaaa"}\n`);
        if (sub === "rev-parse origin/main") {
          const om = co?.originMain === undefined ? "aaaaaaa" : co.originMain;
          return om === null
            ? { code: 128, stdout: "", stderr: "fatal: bad revision" }
            : ok(`${om}\n`);
        }
        throw new Error(`unhandled git: ${sub}`);
      }
      if (cmd === "plutil") {
        const file = args[args.length - 1];
        const name = file.split("/").pop()!;
        const spec = opts.plists?.[name];
        if (!spec || spec === "unreadable") return { code: 1, stdout: "", stderr: "bad plist" };
        return ok(JSON.stringify(spec));
      }
      if (cmd === "launchctl") {
        return opts.kickFails ? { code: 1, stdout: "", stderr: "kick boom" } : ok("");
      }
      if (cmd === "systemctl") {
        if (args.includes("list-unit-files")) return ok(Object.keys(opts.units ?? {}).join("\n"));
        if (args[1] === "cat") return ok(opts.units?.[args[2]] ?? "");
        if (args.includes("restart")) {
          // A BLOCKING `systemctl restart` waits out TimeoutStopSec (minutes)
          // and is killed by defaultExec's 15s budget → err.code=null → exit 1.
          // Only the `--no-block` form returns promptly. (#117)
          if (opts.restartBlocks && !args.includes("--no-block")) {
            return { code: 1, stdout: "", stderr: "" };
          }
          return ok("");
        }
      }
      throw new Error(`unhandled exec: ${cmd} ${args.join(" ")}`);
    },
    lockHolderFn: () => (lockSeq.length > 1 ? lockSeq.shift()! : (lockSeq[0] ?? null)),
    sleepFn: async () => {
      await new Promise((r) => setTimeout(r, 1));
    },
    printFn: (s) => prints.push(s),
    timeoutMs: 50,
  };
  return { deps, calls, prints };
}

const juncoPlist = {
  Label: "com.edelweiss.junco-worker",
  ProgramArguments: ["/opt/homebrew/bin/junco", "start", "--config", CONFIG],
};
const decoyPlist = {
  Label: "com.example.other",
  ProgramArguments: ["/usr/bin/true"],
};
const flaglessPlist = {
  Label: "com.junco.worker",
  ProgramArguments: ["/usr/local/bin/node", "/opt/junco/dist/cli.js", "start"],
};

describe("discoverService (launchd)", () => {
  it("finds the plist whose ProgramArguments contain the config path among decoys", async () => {
    const f = makeFakes({
      plists: { "a-decoy.plist": decoyPlist, "junco.plist": juncoPlist, "z.plist": decoyPlist },
    });
    expect(await discoverService(CONFIG, f.deps)).toEqual({
      platform: "launchd",
      id: "com.edelweiss.junco-worker",
    });
  });

  it("skips unreadable plists and still matches a later one", async () => {
    const f = makeFakes({
      plists: { "broken.plist": "unreadable", "junco.plist": juncoPlist },
    });
    expect((await discoverService(CONFIG, f.deps))?.id).toBe("com.edelweiss.junco-worker");
  });

  it("returns null when nothing references the config", async () => {
    const f = makeFakes({ plists: { "a.plist": decoyPlist } });
    expect(await discoverService(CONFIG, f.deps)).toBeNull();
  });

  it("falls back to a flagless junco unit when no plist references the config path", async () => {
    const f = makeFakes({ plists: { "a-decoy.plist": decoyPlist, "j.plist": flaglessPlist } });
    expect(await discoverService(CONFIG, f.deps)).toEqual({
      platform: "launchd",
      id: "com.junco.worker",
    });
  });

  it("an exact config-path match beats a flagless junco unit", async () => {
    const f = makeFakes({
      plists: { "flagless.plist": flaglessPlist, "legacy.plist": juncoPlist },
    });
    expect((await discoverService(CONFIG, f.deps))?.id).toBe(juncoPlist.Label);
  });

  it("a flagless unit that is not junco-ish does not match", async () => {
    const f = makeFakes({
      plists: { "x.plist": { Label: "com.x.thing", ProgramArguments: ["/usr/bin/foo", "start"] } },
    });
    expect(await discoverService(CONFIG, f.deps)).toBeNull();
  });
});

describe("discoverService (systemd)", () => {
  it("matches a junco unit whose ExecStart references the config", async () => {
    const f = makeFakes({
      platform: "linux",
      units: {
        "junco.service": `[Service]\nExecStart=/usr/bin/junco start --config ${CONFIG}\n`,
      },
    });
    expect(await discoverService(CONFIG, f.deps)).toEqual({
      platform: "systemd",
      id: "junco.service",
    });
  });
});

describe("runRestartCommand", () => {
  it("polls the ONE derived lock path, absolute even for a relative config (#310)", async () => {
    // The path `junco update` → `junco restart` waits on must be the path the
    // restarted daemon actually writes; a second spelling here reports
    // "the lock holder did not change" on a SUCCESSFUL restart.
    const REL = join("sbx-rel", "config.json");
    const seen: string[] = [];
    const f = makeFakes({ plists: { "junco.plist": juncoPlist } });
    f.deps.lockHolderFn = (p) => {
      seen.push(p);
      return seen.length === 1 ? 100 : 200;
    };
    expect(await runRestartCommand(REL, f.deps)).toBe(0);
    expect(new Set(seen)).toEqual(new Set([workerLockPath(REL)]));
    expect(isAbsolute(seen[0])).toBe(true);
  });

  it("no service found → guidance mentioning `junco service`, exit 1, no kick", async () => {
    const f = makeFakes({ plists: { "a.plist": decoyPlist }, lockPids: [null] });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(1);
    expect(f.prints.join("")).toContain("junco service");
    expect(f.calls.find((c) => c[0] === "launchctl")).toBeUndefined();
  });

  it("kickstarts the right target and reports the pid change", async () => {
    const f = makeFakes({
      plists: { "junco.plist": juncoPlist },
      lockPids: [100, 100, 200],
    });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(0);
    expect(f.calls).toContainEqual([
      "launchctl",
      "kickstart",
      "-k",
      "gui/501/com.edelweiss.junco-worker",
    ]);
    expect(f.prints.join("")).toContain("restarted: pid 100 → 200");
  });

  it("kick failure surfaces stderr and exits 1", async () => {
    const f = makeFakes({
      plists: { "junco.plist": juncoPlist },
      lockPids: [100],
      kickFails: true,
    });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(1);
    expect(f.prints.join("")).toContain("kick boom");
  });

  it("pid never changes → drain warning, exit 1", async () => {
    const f = makeFakes({ plists: { "junco.plist": juncoPlist }, lockPids: [100] });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(1);
    expect(f.prints.join("").toLowerCase()).toContain("drain");
  });

  it("systemd path restarts the unit", async () => {
    const f = makeFakes({
      platform: "linux",
      units: {
        "junco.service": `ExecStart=/usr/bin/junco start --config ${CONFIG}`,
      },
      lockPids: [null, 300],
    });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(0);
    expect(f.calls).toContainEqual([
      "systemctl",
      "--user",
      "--no-block",
      "restart",
      "junco.service",
    ]);
    expect(f.prints.join("")).toContain("restarted: pid — → 300");
  });

  it("systemd restart is non-blocking → an async restart is not misreported as failed (#117)", async () => {
    const f = makeFakes({
      platform: "linux",
      units: {
        "junco.service": `ExecStart=/usr/bin/junco start --config ${CONFIG}`,
      },
      // Old holder lingers while it drains the in-flight ticket, then the new
      // pid appears — i.e. the restart succeeds ASYNCHRONOUSLY.
      lockPids: [100, 100, 400],
      // A blocking `systemctl restart` would outlive the 15s exec budget → exit 1.
      restartBlocks: true,
    });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(0);
    expect(f.calls).toContainEqual([
      "systemctl",
      "--user",
      "--no-block",
      "restart",
      "junco.service",
    ]);
    expect(f.prints.join("")).toContain("restarted: pid 100 → 400");
  });
});

describe("inspectCheckout", () => {
  it("an npm install (no `.git` beside dist/) is not a checkout — no git is run", async () => {
    const f = makeFakes({});
    expect(await inspectCheckout(f.deps)).toBeNull();
    expect(f.calls.find((c) => c[0] === "git")).toBeUndefined();
  });

  it("a host without git cannot be inspected → null, never a refusal", async () => {
    const f = makeFakes({ checkout: { gitMissing: true } });
    expect(await inspectCheckout(f.deps)).toBeNull();
  });

  it("reports the checkout root, dirty paths, branch, HEAD and origin/main", async () => {
    const f = makeFakes({
      checkout: {
        dirty: [" M src/restartCmd.ts", "?? tests/new.test.ts"],
        head: "bbbbbbb",
        branch: "feat/x",
        originMain: "aaaaaaa",
      },
    });
    expect(await inspectCheckout(f.deps)).toEqual({
      root: PKG,
      dirty: [" M src/restartCmd.ts", "?? tests/new.test.ts"],
      head: "bbbbbbb",
      branch: "feat/x",
      originMain: "aaaaaaa",
    });
  });

  it("a missing origin/main ref reads as null (the guard treats it as a mismatch)", async () => {
    const f = makeFakes({ checkout: { originMain: null } });
    expect((await inspectCheckout(f.deps))?.originMain).toBeNull();
  });
});

describe("runRestartCommand — checkout preflight (#384)", () => {
  const plists = { "junco.plist": juncoPlist };
  const noKick = (f: ReturnType<typeof makeFakes>) =>
    expect(f.calls.find((c) => c[0] === "launchctl")).toBeUndefined();

  it("a clean checkout parked on origin/main restarts as usual", async () => {
    const f = makeFakes({ plists, lockPids: [100, 200], checkout: {} });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(0);
    expect(f.prints.join("")).toContain("restarted: pid 100 → 200");
    expect(f.prints.join("")).not.toContain("not restarting");
  });

  it("an npm install skips the preflight entirely", async () => {
    const f = makeFakes({ plists, lockPids: [100, 200] });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(0);
    expect(f.calls.find((c) => c[0] === "git")).toBeUndefined();
  });

  it("a dirty checkout refuses: exit 1, no kick, the dirty paths and --force are printed", async () => {
    const f = makeFakes({
      plists,
      lockPids: [100],
      checkout: { dirty: [" M src/restartCmd.ts", "?? tests/new.test.ts"] },
    });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(1);
    noKick(f);
    const out = f.prints.join("");
    expect(out).toContain("not restarting");
    expect(out).toContain(PKG);
    expect(out).toContain(" M src/restartCmd.ts");
    expect(out).toContain("?? tests/new.test.ts");
    expect(out).toContain("--force");
  });

  it("HEAD off origin/main refuses and names the branch and both commits", async () => {
    const f = makeFakes({
      plists,
      lockPids: [100],
      checkout: { head: "bbbbbbb", branch: "feat/x", originMain: "aaaaaaa" },
    });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(1);
    noKick(f);
    const out = f.prints.join("");
    expect(out).toContain("feat/x");
    expect(out).toContain("bbbbbbb");
    expect(out).toContain("aaaaaaa");
  });

  it("a checkout with no origin/main ref refuses (the code cannot be shown to be on main)", async () => {
    const f = makeFakes({ plists, lockPids: [100], checkout: { originMain: null } });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(1);
    noKick(f);
    expect(f.prints.join("")).toContain("origin/main");
  });

  it("the dirty listing is capped at 10 paths with a count of the rest", async () => {
    const dirty = Array.from({ length: 14 }, (_, i) => ` M src/file${i}.ts`);
    const f = makeFakes({ plists, lockPids: [100], checkout: { dirty } });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(1);
    const out = f.prints.join("");
    expect(out).toContain(" M src/file9.ts");
    expect(out).not.toContain(" M src/file10.ts");
    expect(out).toContain("4 more");
  });

  it("--force restarts a dirty, off-main checkout anyway, with a warning", async () => {
    const f = makeFakes({
      plists,
      lockPids: [100, 200],
      checkout: { dirty: [" M src/x.ts"], head: "bbbbbbb", branch: "feat/x" },
    });
    expect(await runRestartCommand(CONFIG, f.deps, { force: true })).toBe(0);
    expect(f.calls.find((c) => c[0] === "launchctl")).toBeDefined();
    const out = f.prints.join("");
    expect(out).toContain("--force");
    expect(out).toContain("restarted: pid 100 → 200");
  });

  it("--force on a clean checkout prints no warning", async () => {
    const f = makeFakes({ plists, lockPids: [100, 200], checkout: {} });
    expect(await runRestartCommand(CONFIG, f.deps, { force: true })).toBe(0);
    expect(f.prints.join("")).not.toContain("--force");
  });

  it("the preflight runs before service discovery — a refusal never scans units", async () => {
    const f = makeFakes({ plists, lockPids: [100], checkout: { dirty: ["?? x"] } });
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(1);
    expect(f.calls.find((c) => c[0] === "plutil")).toBeUndefined();
  });
});

describe("discoverService — reviewer findings", () => {
  it("multiple launchd matches: first wins AND the warn line reaches the default print path", async () => {
    const second = { Label: "com.other.junco-copy", ProgramArguments: ["x", "--config", CONFIG] };
    const f = makeFakes({
      plists: { "a-junco.plist": juncoPlist, "b-copy.plist": second },
      lockPids: [100, 200],
    });
    // Drive through runRestartCommand WITHOUT overriding printFn on the inner
    // call path — the warn must surface via the same deps the command defaults.
    expect(await runRestartCommand(CONFIG, f.deps)).toBe(0);
    expect(f.prints.join("")).toContain("multiple launchd jobs");
    expect(f.prints.join("")).toContain("com.other.junco-copy");
    expect(f.calls).toContainEqual([
      "launchctl",
      "kickstart",
      "-k",
      "gui/501/com.edelweiss.junco-worker",
    ]);
  });

  it("systemd: single junco unit wins when no ExecStart references the config", async () => {
    const f = makeFakes({
      platform: "linux",
      units: { "junco.service": "ExecStart=/usr/bin/junco start" }, // no config path
    });
    expect(await discoverService(CONFIG, f.deps)).toEqual({
      platform: "systemd",
      id: "junco.service",
    });
  });

  it("systemd: multiple junco units with no config match → null (never guess)", async () => {
    const f = makeFakes({
      platform: "linux",
      units: {
        "junco.service": "ExecStart=/usr/bin/junco start",
        "junco-alt.service": "ExecStart=/usr/bin/junco start --config /elsewhere.json",
      },
    });
    expect(await discoverService(CONFIG, f.deps)).toBeNull();
  });

  it("multi-match warn survives when the CALLER injects no printFn (default stdout path)", async () => {
    const second = { Label: "com.other.junco-copy", ProgramArguments: ["x", "--config", CONFIG] };
    const f = makeFakes({
      plists: { "a-junco.plist": juncoPlist, "b-copy.plist": second },
      lockPids: [100, 200],
    });
    const bare: RestartDeps = { ...f.deps };
    delete bare.printFn; // simulate the real CLI call path
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await runRestartCommand(CONFIG, bare)).toBe(0);
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("multiple launchd jobs");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("kickstartService", () => {
  it("launchd → launchctl kickstart -k gui/<uid>/<label>", async () => {
    const calls: string[][] = [];
    const deps: RestartDeps = {
      uid: 501,
      execFn: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const svc: ServiceRef = { platform: "launchd", id: "com.edelweiss.junco-worker" };
    const r = await kickstartService(svc, deps);
    expect(r.code).toBe(0);
    expect(calls).toEqual([["launchctl", "kickstart", "-k", "gui/501/com.edelweiss.junco-worker"]]);
  });

  it("systemd → systemctl --user --no-block restart <unit>", async () => {
    const calls: string[][] = [];
    const deps: RestartDeps = {
      execFn: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const svc: ServiceRef = { platform: "systemd", id: "junco.service" };
    await kickstartService(svc, deps);
    expect(calls).toEqual([["systemctl", "--user", "--no-block", "restart", "junco.service"]]);
  });

  it("propagates a non-zero exit + stderr", async () => {
    const deps: RestartDeps = {
      execFn: async () => ({ code: 1, stdout: "", stderr: "kick boom" }),
    };
    const r = await kickstartService({ platform: "launchd", id: "x" }, deps);
    expect(r).toMatchObject({ code: 1, stderr: "kick boom" });
  });
});
