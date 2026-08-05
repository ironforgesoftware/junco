import { describe, it, expect, vi } from "vitest";
import {
  discoverService,
  kickstartService,
  runRestartCommand,
  type RestartDeps,
  type ServiceRef,
} from "../src/restartCmd.js";

const CONFIG = "/Users/u/junco/config.json";

type Exec = { code: number; stdout: string; stderr: string };
const ok = (stdout: string): Exec => ({ code: 0, stdout, stderr: "" });

/** Fake launchd host: a LaunchAgents dir with named plists whose plutil-JSON
 * we script per filename; launchctl/systemctl calls are recorded. */
function makeFakes(opts: {
  plists?: Record<string, { Label: string; ProgramArguments: string[] } | "unreadable">;
  units?: Record<string, string>; // unit name → `systemctl --user cat` stdout
  lockPids?: (number | null)[]; // successive lockHolderFn answers
  platform?: NodeJS.Platform;
  kickFails?: boolean;
  restartBlocks?: boolean; // model a BLOCKING `systemctl restart` (no --no-block)
}) {
  const calls: string[][] = [];
  const prints: string[] = [];
  const lockSeq = [...(opts.lockPids ?? [])];
  const deps: RestartDeps = {
    platform: opts.platform ?? "darwin",
    uid: 501,
    homedirFn: () => "/Users/u",
    readdirFn: () => Object.keys(opts.plists ?? {}),
    execFn: async (cmd, args) => {
      calls.push([cmd, ...args]);
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
