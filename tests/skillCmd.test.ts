import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runSkillInstallCommand, resolveHarnessArg } from "../src/skillCmd.js";
import type { SkillLinksReport } from "../src/skillLinks.js";
import { expandHome } from "../src/config.js";
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

  // The dedupe compares expandHome-NORMALIZED forms, not raw strings: a config
  // that already stores the registry entry's *expanded* (absolute) form must
  // still be recognized as covering a bare `--harness claude` request, even
  // though "~/.claude/skills" !== the stored absolute path as literal text.
  it("dedupes against an existing entry stored in already-expanded (absolute) form", async () => {
    const already = expandHome("~/.claude/skills");
    const h = harness({ skills: { harnessDirs: [already] } }, [already]);
    const code = await runSkillInstallCommand(
      "/sbxroot/config.json",
      { harness: ["claude"] },
      h.deps,
    );
    expect(code).toBe(0);
    expect(Object.keys(h.writes)).toEqual([]); // no-op write skipped
  });

  // Within-invocation repeats must collapse too — the dedupe set built from
  // the existing config alone would let `--harness claude --harness claude`
  // through twice (two identical "configured:" lines, a duplicate config
  // entry). First occurrence wins; the config gains exactly one entry.
  it("collapses a repeated --harness flag to a single addition", async () => {
    const h = harness({});
    const code = await runSkillInstallCommand(
      "/sbxroot/config.json",
      { harness: ["claude", "claude"] },
      h.deps,
    );
    expect(code).toBe(0);
    const [, written] = Object.entries(h.writes)[0];
    expect(JSON.parse(written).skills.harnessDirs).toEqual(["~/.claude/skills"]);
    expect(h.out.filter((l) => l.startsWith("configured:"))).toEqual([
      "configured: ~/.claude/skills\n",
    ]);
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
