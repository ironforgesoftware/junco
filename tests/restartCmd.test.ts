import { describe, it, expect } from "vitest";
import { discoverService, runRestartCommand, type RestartDeps } from "../src/restartCmd.js";

const CONFIG = "/Users/u/junco/config.toml";

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
        if (args[1] === "restart") return ok("");
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
    expect(f.calls).toContainEqual(["systemctl", "--user", "restart", "junco.service"]);
    expect(f.prints.join("")).toContain("restarted: pid — → 300");
  });
});
