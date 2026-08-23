// tests/updateCmd.test.ts
import { describe, it, expect } from "vitest";
import { runUpdateCommand, type UpdateCmdDeps } from "../src/updateCmd.js";
import { join, isAbsolute } from "node:path";
import { workerLockPath } from "../src/lock.js";
import type { Config } from "../src/types.js";
import type { UpdateInfo } from "../src/updateCheck.js";

const CONFIG_PATH = "/sbxroot/cfg/config.json";

interface Rec {
  runs: Array<{ cmd: string; args: string[] }>;
  execs: Array<{ cmd: string; args: string[] }>;
  restarts: string[];
  out: string[];
  err: string[];
}

const harness = (o: {
  sourceCheckout?: boolean;
  check?: UpdateInfo | null;
  npmExit?: number;
  lockHolder?: number | null;
  restartCode?: number;
  verify?: { code: number; stdout: string };
  discovered?: boolean;
}): { deps: UpdateCmdDeps; rec: Rec } => {
  const rec: Rec = { runs: [], execs: [], restarts: [], out: [], err: [] };
  return {
    rec,
    deps: {
      printFn: (s) => rec.out.push(s),
      errPrintFn: (s) => rec.err.push(s),
      selfPkgFn: () => ({ name: "@x/junco", version: "0.7.0", rootDir: "/sbxroot/app/" }),
      existsFn: (p) => (o.sourceCheckout ?? false) && p === "/sbxroot/app/.git",
      loadConfigFn: () => ({ dataDir: "/sbxroot/data", updateCheck: true }) as unknown as Config,
      checkUpdateFn: async () => o.check ?? null,
      runFn: async (cmd, args) => {
        rec.runs.push({ cmd, args });
        return o.npmExit ?? 0;
      },
      execFn: async (cmd, args) => {
        rec.execs.push({ cmd, args });
        return { code: o.verify?.code ?? 0, stdout: o.verify?.stdout ?? "0.8.0\n", stderr: "" };
      },
      lockHolderFn: () => o.lockHolder ?? null,
      restartFn: async (p) => {
        rec.restarts.push(p);
        return o.restartCode ?? 0;
      },
      discoverServiceFn: async () => ((o.discovered ?? true) ? {} : null),
      // No-op by default — the stub Config above omits `skills`, so letting
      // this fall through to the real ensureSkillLinks would crash on
      // `cfg.skills.harnessDirs`. Tests exercising the skill-link wiring
      // itself override this.
      ensureSkillLinksFn: () => ({ entries: [] }),
    },
  };
};

const UPD: UpdateInfo = { current: "0.7.0", latest: "0.8.0", available: true };

describe("runUpdateCommand", () => {
  it("refuses a source checkout before doing ANYTHING", async () => {
    const { deps, rec } = harness({ sourceCheckout: true, check: UPD });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(1);
    expect(rec.runs).toEqual([]);
    expect(rec.restarts).toEqual([]);
    expect(rec.out.join("")).toContain("git pull && npm run build");
  });

  it("exits 0 pre-install when already current", async () => {
    const { deps, rec } = harness({
      check: { current: "0.7.0", latest: "0.7.0", available: false },
    });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(0);
    expect(rec.runs).toEqual([]);
    expect(rec.out.join("")).toContain("already up to date (v0.7.0)");
  });

  it("a failed check is loud (unlike the passive surfaces)", async () => {
    const { deps, rec } = harness({ check: null });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(1);
    expect(rec.runs).toEqual([]);
    expect(rec.err.join("")).toContain("update check failed");
  });

  it("installs via npm -g and skips restart when no daemon lock is held", async () => {
    const { deps, rec } = harness({ check: UPD, lockHolder: null });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(0);
    expect(rec.runs).toEqual([{ cmd: "npm", args: ["install", "-g", "@x/junco@latest"] }]);
    expect(rec.restarts).toEqual([]);
    expect(rec.out.join("")).toContain("updated v0.7.0 → v0.8.0");
  });

  it("npm failure aborts BEFORE any restart, exit 1", async () => {
    const { deps, rec } = harness({ check: UPD, npmExit: 1, lockHolder: 42 });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(1);
    expect(rec.restarts).toEqual([]);
    expect(rec.err.join("")).toContain("npm install failed");
  });

  it("lock held → drain-restart via runRestartCommand; its exit code propagates", async () => {
    const ok = harness({ check: UPD, lockHolder: 42, restartCode: 0 });
    expect(await runUpdateCommand(CONFIG_PATH, ok.deps)).toBe(0);
    expect(ok.rec.restarts).toEqual([CONFIG_PATH]);

    const bad = harness({ check: UPD, lockHolder: 42, restartCode: 1 });
    expect(await runUpdateCommand(CONFIG_PATH, bad.deps)).toBe(1);
  });

  it("reads the ONE derived lock path, absolute even for a relative config (#310)", async () => {
    // `update`'s drain-restart decision hangs on this read: a second spelling
    // makes a live daemon look down and skips the restart entirely, leaving
    // the old binary running after a "successful" update.
    const REL = join("sbx-rel", "config.json");
    const seen: string[] = [];
    const { deps } = harness({ check: UPD, lockHolder: 42 });
    deps.lockHolderFn = (p) => {
      seen.push(p);
      return 42;
    };
    expect(await runUpdateCommand(REL, deps)).toBe(0);
    expect(seen).toEqual([workerLockPath(REL)]);
    expect(isAbsolute(seen[0])).toBe(true);
  });

  it("lock held + no service unit → manual-restart guidance, exit 0, no restart invoked", async () => {
    const { deps, rec } = harness({ check: UPD, lockHolder: 42, discovered: false });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(0);
    expect(rec.restarts).toEqual([]);
    expect(rec.out.join("")).toContain("restart it manually");
  });

  it("verify failure is a warning, not a rollback", async () => {
    const { deps, rec } = harness({ check: UPD, verify: { code: 1, stdout: "" } });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(0);
    expect(rec.out.join("")).toContain("could not verify");
  });

  it("verify reports a stale/shadowed PATH install as a warning, not a false success", async () => {
    const { deps, rec } = harness({ check: UPD, verify: { code: 0, stdout: "0.7.0\n" } });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(0);
    const out = rec.out.join("");
    expect(out).toContain("may be shadowing");
    expect(out).not.toContain("updated v0.7.0 → v0.7.0");
  });

  it("re-ensures skill links after a successful install", async () => {
    let ensured = 0;
    const { deps } = harness({ check: UPD, lockHolder: null });
    const code = await runUpdateCommand(CONFIG_PATH, {
      ...deps,
      ensureSkillLinksFn: () => {
        ensured++;
        return { entries: [{ path: "/sbxroot/data/skills", kind: "created" }] };
      },
    });
    expect(code).toBe(0);
    expect(ensured).toBe(1);
  });

  it("does not ensure links when npm install fails", async () => {
    let ensured = 0;
    const { deps } = harness({ check: UPD, npmExit: 1, lockHolder: 42 });
    const code = await runUpdateCommand(CONFIG_PATH, {
      ...deps,
      ensureSkillLinksFn: () => {
        ensured++;
        return { entries: [] };
      },
    });
    expect(code).toBe(1);
    expect(ensured).toBe(0);
  });

  it("prints created/repaired via print and warnings via errPrint", async () => {
    const { deps, rec } = harness({ check: UPD, lockHolder: null });
    const code = await runUpdateCommand(CONFIG_PATH, {
      ...deps,
      ensureSkillLinksFn: () => ({
        entries: [
          { path: "/sbxroot/data/skills/claude/junco-dispatch", kind: "created" },
          { path: "/sbxroot/data/skills/pi/junco-dispatch", kind: "repaired" },
          {
            path: "/sbxroot/data/skills",
            kind: "target-missing",
            detail: "/pkg/skills",
          },
        ],
      }),
    });
    expect(code).toBe(0);
    expect(rec.out.join("")).toContain(
      "skill link created: /sbxroot/data/skills/claude/junco-dispatch",
    );
    expect(rec.out.join("")).toContain(
      "skill link repaired: /sbxroot/data/skills/pi/junco-dispatch",
    );
    expect(rec.err.join("")).toContain("skill link warning: /sbxroot/data/skills: target missing");
  });
});
