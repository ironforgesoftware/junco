import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runSkillInstallCommand, resolveHarnessArg } from "../src/skillCmd.js";
import type { SkillLinksReport } from "../src/skillLinks.js";
import { makeConfig, READ_ONLY_TOOLS } from "./helpers/config.js";

const seams = {
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/data/queue",
  worktreeRoot: "/sbxroot/data/worktrees",
  tools: READ_ONLY_TOOLS,
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: false,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
};

describe("resolveHarnessArg", () => {
  it("resolves registry names and passes paths through", () => {
    expect(resolveHarnessArg("claude")).toEqual({ dir: "~/.claude/skills" });
    expect(resolveHarnessArg("~/custom/skills")).toEqual({ dir: "~/custom/skills" });
    expect(resolveHarnessArg("/abs/skills")).toEqual({ dir: "/abs/skills" });
  });
  it("rejects an unknown bare name, listing the registry", () => {
    const r = resolveHarnessArg("cursor");
    expect("error" in r && r.error).toMatch(/unknown harness 'cursor'.*claude.*codex.*omp/s);
  });
});

describe("runSkillInstallCommand", () => {
  function harness(rawConfig: object, harnessDirs: string[] = []) {
    const out: string[] = [];
    const writes: Record<string, string> = {};
    let renamed: [string, string] | null = null;
    const deps = {
      printFn: (s: string) => out.push(s),
      readFileFn: () => JSON.stringify(rawConfig),
      writeFileFn: (p: string, s: string) => {
        writes[p] = s;
      },
      renameFn: (a: string, b: string) => {
        renamed = [a, b];
      },
      loadConfigFn: () => makeConfig(seams, { skills: { harnessDirs } }),
      ensureFn: (): SkillLinksReport => ({ created: [], repaired: [], skipped: [], warnings: [] }),
    };
    return { out, writes, deps, renamedRef: () => renamed };
  }

  it("no args: ensures from config without touching the config file", async () => {
    const h = harness({});
    const code = await runSkillInstallCommand("/sbxroot/config.json", { harness: [] }, h.deps);
    expect(code).toBe(0);
    expect(Object.keys(h.writes)).toEqual([]);
  });

  it("--harness claude persists the registry dir and ensures", async () => {
    const h = harness({ model: { id: "m" } });
    const code = await runSkillInstallCommand(
      "/sbxroot/config.json",
      { harness: ["claude"] },
      h.deps,
    );
    expect(code).toBe(0);
    const [tmpPath, written] = Object.entries(h.writes)[0];
    expect(tmpPath).toContain(".config.json.tmp-");
    expect(JSON.parse(written).skills.harnessDirs).toEqual(["~/.claude/skills"]);
    expect(JSON.parse(written).model.id).toBe("m"); // untouched keys preserved
    expect(h.renamedRef()).toEqual([tmpPath, "/sbxroot/config.json"]);
  });

  it("does not duplicate an already-configured dir", async () => {
    const h = harness({ skills: { harnessDirs: ["~/.claude/skills"] } }, ["~/.claude/skills"]);
    const code = await runSkillInstallCommand(
      "/sbxroot/config.json",
      { harness: ["claude"] },
      h.deps,
    );
    expect(code).toBe(0);
    expect(Object.keys(h.writes)).toEqual([]); // no-op write skipped
  });

  it("unknown name: usage error, nothing written or ensured", async () => {
    let ensured = 0;
    const h = harness({});
    h.deps.ensureFn = () => {
      ensured++;
      return { created: [], repaired: [], skipped: [], warnings: [] };
    };
    const code = await runSkillInstallCommand(
      "/sbxroot/config.json",
      { harness: ["cursor"] },
      h.deps,
    );
    expect(code).toBe(2);
    expect(ensured).toBe(0);
  });

  it("exit 1 when an explicitly requested link ends in a warning", async () => {
    const h = harness({}, ["/sbxroot/home/.claude/skills"]);
    h.deps.ensureFn = () => ({
      created: [],
      repaired: [],
      skipped: [],
      warnings: [
        join("/sbxroot/home/.claude/skills", "junco-dispatch") + ": symlink failed (EPERM)",
      ],
    });
    const code = await runSkillInstallCommand(
      "/sbxroot/config.json",
      { harness: ["/sbxroot/home/.claude/skills"] },
      h.deps,
    );
    expect(code).toBe(1);
  });
});
