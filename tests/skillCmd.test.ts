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

  // HARNESS_REGISTRY is a plain object literal — a bare `[arg]` lookup falls
  // through to Object.prototype for names like "constructor"/"toString", and
  // downstream code (join(fromRegistry, ...) etc.) throws a TypeError on the
  // inherited function value instead of ever reaching the unknown-harness
  // error path. Object.hasOwn guards the lookup.
  it("does not resolve a prototype-chain property name (e.g. 'constructor') — unknown-harness error, not a throw", () => {
    expect(() => resolveHarnessArg("constructor")).not.toThrow();
    const r = resolveHarnessArg("constructor");
    expect("error" in r && r.error).toMatch(/unknown harness 'constructor'/);
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
      ensureFn: (): SkillLinksReport => ({ entries: [] }),
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
      return { entries: [] };
    };
    const code = await runSkillInstallCommand(
      "/sbxroot/config.json",
      { harness: ["cursor"] },
      h.deps,
    );
    expect(code).toBe(2);
    expect(ensured).toBe(0);
  });

  // "ok" and "harness-not-installed" are the two "nothing to do" kinds
  // (skillLinks.ts): a genuine already-valid link (nothing to do, truly "ok")
  // and a harness whose parent dir doesn't exist here — never linked at all.
  // Printing both under "ok:" misleads for the latter. Regression guard for
  // a real historical decision: the old code drew this same "ok" vs
  // "skipped" line by suffix-matching `s.endsWith("(harness not
  // installed)")` on the rendered warning string — content-dependent in
  // exactly the way structured entries now replace.
  it("prints a genuine valid link as 'ok:' but an uninstalled-harness skip as 'skipped:' — exit code unchanged", async () => {
    const h = harness({});
    h.deps.ensureFn = () => ({
      entries: [
        { path: "/sbxroot/home/.claude/skills/junco-dispatch", kind: "ok" },
        { path: "/sbxroot/home/.codex/skills", kind: "harness-not-installed" },
      ],
    });
    const code = await runSkillInstallCommand("/sbxroot/config.json", { harness: [] }, h.deps);
    expect(code).toBe(0); // roaming consent: uninstalled harness stays exit 0 by design
    expect(h.out).toContain("ok:       /sbxroot/home/.claude/skills/junco-dispatch\n");
    expect(h.out).toContain("skipped:  /sbxroot/home/.codex/skills (harness not installed)\n");
    expect(h.out.some((l) => l.startsWith("ok:") && l.includes("harness not installed"))).toBe(
      false,
    );
  });

  it("exit 1 when an explicitly requested harness's link fails", async () => {
    const dir = "/sbxroot/home/.claude/skills";
    const h = harness({}, [dir]);
    h.deps.ensureFn = () => ({
      entries: [
        {
          path: join(dir, "junco-dispatch"),
          kind: "symlink-failed",
          harnessDir: dir,
          detail: "EPERM",
        },
      ],
    });
    const code = await runSkillInstallCommand("/sbxroot/config.json", { harness: [dir] }, h.deps);
    expect(code).toBe(1);
  });

  // The old exit-code decision prefix-matched the rendered warning string
  // against the requested link path AND its dirname (the dirname arm existed
  // only because mkdir-failed is keyed on the harness dir, not the link
  // path). Structured entries replace both with one rule: does the entry's
  // own `harnessDir` match a requested harness (sameHarnessDir)? A failure on
  // some OTHER harness the user never asked about must stay exit 0.
  it("exit 0 when a failing entry's harnessDir does not match any requested harness", async () => {
    const requested = "/sbxroot/home/.claude/skills";
    const otherHarness = "/sbxroot/home/.codex/skills";
    const h = harness({}, [requested]);
    h.deps.ensureFn = () => ({
      entries: [
        {
          path: join(otherHarness, "junco-dispatch"),
          kind: "symlink-failed",
          harnessDir: otherHarness,
          detail: "EPERM",
        },
      ],
    });
    const code = await runSkillInstallCommand(
      "/sbxroot/config.json",
      { harness: [requested] },
      h.deps,
    );
    expect(code).toBe(0);
  });

  // mkdir-failed is keyed on the harness DIR itself, not a link path — this
  // is exactly the case the old `dirname` arm existed to catch. A structured
  // `harnessDir` matches it directly, no path arithmetic required.
  // Regression guard for that pre-refactor branch (the old exit-code check
  // was `w.startsWith(p) || w.startsWith(dirname(p))`; this test pins the
  // `dirname(p)` half).
  it("exit 1 on a mkdir-failed entry for a requested harness (the old dirname-arm case)", async () => {
    const dir = "/sbxroot/home/.claude/skills";
    const h = harness({}, [dir]);
    h.deps.ensureFn = () => ({
      entries: [{ path: dir, kind: "mkdir-failed", harnessDir: dir, detail: "EACCES" }],
    });
    const code = await runSkillInstallCommand("/sbxroot/config.json", { harness: [dir] }, h.deps);
    expect(code).toBe(1);
  });

  // Property of the new design, not a reproduction of the old fragility:
  // rewording a failing entry's `detail` text must change neither the exit
  // code nor the printed prefix ("warning:") — only structured fields (kind,
  // harnessDir) may drive those decisions now. This does NOT falsify the
  // pre-refactor code: its exit-code check matched only the warning
  // string's leading path (`w.startsWith(p) || w.startsWith(dirname(p))`),
  // and its print loop printed "warning:" unconditionally for every
  // warning — neither decision depended on trailing detail text, so this
  // same reword would not have changed either outcome under the old
  // implementation either. The tests that DO reproduce the old code's
  // actual content-dependent decisions are above: "prints a genuine valid
  // link as 'ok:' but an uninstalled-harness skip as 'skipped:' ..." (the
  // old `endsWith("(harness not installed)")` check) and "exit 1 on a
  // mkdir-failed entry ... (the old dirname-arm case)".
  it("rewording an entry's detail text changes neither the exit code nor the print prefix", async () => {
    const dir = "/sbxroot/home/.claude/skills";
    const runWithDetail = async (detail: string) => {
      const h = harness({}, [dir]);
      h.deps.ensureFn = () => ({
        entries: [
          { path: join(dir, "junco-dispatch"), kind: "symlink-failed", harnessDir: dir, detail },
        ],
      });
      const code = await runSkillInstallCommand("/sbxroot/config.json", { harness: [dir] }, h.deps);
      return { code, out: h.out };
    };
    const original = await runWithDetail("EPERM: operation not permitted");
    const reworded = await runWithDetail("permission denied by the OS");
    expect(original.code).toBe(1);
    expect(reworded.code).toBe(1);
    const originalWarning = original.out.find((l) => l.startsWith("warning:  "));
    const rewordedWarning = reworded.out.find((l) => l.startsWith("warning:  "));
    expect(originalWarning).toBeDefined();
    expect(rewordedWarning).toBeDefined();
    // The rendered detail text itself DOES change — only the decisions don't.
    expect(originalWarning).not.toBe(rewordedWarning);
  });
});
