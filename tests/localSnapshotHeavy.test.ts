import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeLocalHeavyFn } from "../src/tui/localSnapshot.js";
import type { Config } from "../src/types.js";

function makeCfg(root: string): Config {
  return {
    stateDir: join(root, "state"),
    worktreeRoot: join(root, "wt"),
    gitBin: "git",
    ghBin: "gh",
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    maxConcurrent: 1,
    github: {
      enabled: true,
      repos: [{ nwo: "owner/repo", path: join(root, "cfgrepo") }],
      externalReposRoot: join(root, "external"),
    },
  } as unknown as Config;
}

describe("makeLocalHeavyFn", () => {
  it("composes repos + worktrees", async () => {
    const cfg = makeCfg(mkdtempSync(join(tmpdir(), "junco-heavy-")));
    const gitFn = async (): Promise<{ code: number; stdout: string }> => ({
      code: 0,
      stdout: "sha\n",
    });
    const heavy = await makeLocalHeavyFn(cfg, { readdirFn: () => [], gitFn })();
    expect(heavy.repos.map((r) => r.nwo)).toEqual(["owner/repo"]);
    expect(heavy.worktrees).toEqual([]);
    expect(heavy.error).toBeNull();
  });

  it("a pre-aborted signal drops the run immediately (gitFn never called)", async () => {
    const cfg = makeCfg(mkdtempSync(join(tmpdir(), "junco-heavy2-")));
    let called = false;
    const gitFn = async (): Promise<{ code: number; stdout: string }> => {
      called = true;
      return { code: 0, stdout: "" };
    };
    const ac = new AbortController();
    ac.abort();
    const heavy = await makeLocalHeavyFn(cfg, { readdirFn: () => [], gitFn })(ac.signal);
    expect(heavy).toEqual({ repos: [], worktrees: [], error: null });
    expect(called).toBe(false);
  });

  it("late-result drop: an abort mid-flight discards the resolved enumerators", async () => {
    const cfg = makeCfg(mkdtempSync(join(tmpdir(), "junco-heavy3-")));
    const ac = new AbortController();
    // gitFn parks until we release it; we abort while it's parked, then release.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gitFn = async (): Promise<{ code: number; stdout: string }> => {
      await gate;
      return { code: 0, stdout: "sha\n" };
    };
    const p = makeLocalHeavyFn(cfg, { readdirFn: () => [], gitFn })(ac.signal);
    ac.abort();
    release();
    const heavy = await p;
    expect(heavy).toEqual({ repos: [], worktrees: [], error: null }); // dropped
  });
});
