/**
 * tests/replayCmd.test.ts — `junco replay` CLI contracts.
 *
 * `runReplayCmd(argv, deps)` never touches real fs/config: `deps.loadCfg`,
 * `deps.readFile`, `deps.stdout` are the whole seam (mirrors src/statusCmd.ts
 * / src/retryCmd.ts's `*Deps` pattern). Fixture transcript lines come from
 * the shared builders in tests/helpers/transcriptFixtures.ts — see that
 * file's header comment for the guard thresholds they're built against.
 */
import { describe, it, expect } from "vitest";
import { runReplayCmd } from "../src/replayCmd.js";
import { transcriptPathFor } from "../src/slug.js";
import { dataTreePaths } from "../src/dataTree.js";
import { makeConfig, type ConfigSeams } from "./helpers/config.js";
import {
  agentEnd,
  runStart,
  toolLoopStream,
  toolStart,
  turnEnd,
  TOOL_LOOP_TRIP_TURN,
} from "./helpers/transcriptFixtures.js";

const seams: ConfigSeams = {
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/queue",
  worktreeRoot: "/sbxroot/wts",
  tools: [],
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: true,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
};

describe("runReplayCmd", () => {
  const deps = (files: Record<string, string>, cfg = makeConfig(seams)) => {
    const out: string[] = [];
    return {
      out,
      d: {
        loadCfg: () => cfg,
        readFile: (p: string) => {
          if (files[p] === undefined) throw new Error("ENOENT");
          return files[p];
        },
        stdout: (l: string) => out.push(l),
      },
    };
  };

  it("resolves a bare ticket id through the data tree", async () => {
    const cfg = makeConfig(seams);
    const path = transcriptPathFor(dataTreePaths(cfg).transcripts, "t-1");
    const fixture = [
      runStart({ flow: "qa" }),
      toolStart("bash", { command: "ls" }),
      turnEnd(),
      agentEnd(),
    ].join("\n");
    const { out, d } = deps({ [path]: fixture }, cfg);
    const code = await runReplayCmd(["t-1"], d);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("run 1");
  });

  it("accepts a direct .jsonl path", async () => {
    const fixture = [
      runStart({ flow: "qa" }),
      toolStart("bash", { command: "ls" }),
      turnEnd(),
      agentEnd(),
    ].join("\n");
    const out: string[] = [];
    const d = {
      loadCfg: () => {
        throw new Error("no config on disk");
      },
      readFile: (p: string) => {
        if (p !== "/x/y.jsonl") throw new Error("ENOENT");
        return fixture;
      },
      stdout: (l: string) => out.push(l),
    };
    const code = await runReplayCmd(["/x/y.jsonl"], d);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("run 1");
    // No config reachable → the bottom of the precedence chain fires.
    expect(text).toContain("GuardManager defaults");
  });

  it("applies policy flags over config", async () => {
    const cfg = makeConfig(seams);
    const path = transcriptPathFor(dataTreePaths(cfg).transcripts, "t-2");
    const fixture = toolLoopStream().join("\n");
    const { out, d } = deps({ [path]: fixture }, cfg);
    const code = await runReplayCmd(["t-2", "--budget-per-kind=0"], d);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("policy: budgetPerKind=0");
    expect(text).toContain("(source: flag)");
    expect(text).toContain(`kill(tool_call_loop@t${TOOL_LOOP_TRIP_TURN})`);
  });

  it("emits machine-readable JSON with --json", async () => {
    const cfg = makeConfig(seams);
    const path = transcriptPathFor(dataTreePaths(cfg).transcripts, "t-3");
    const fixture = [
      runStart({ flow: "qa" }),
      toolStart("bash", { command: "ls" }),
      turnEnd(),
      agentEnd(),
    ].join("\n");
    const { out, d } = deps({ [path]: fixture }, cfg);
    const code = await runReplayCmd(["t-3", "--json"], d);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed).toHaveProperty("runs");
    expect(parsed).toHaveProperty("identical");
    expect(parsed).toHaveProperty("caveats");
  });

  it("exits 1 with a hint when the transcript is missing", async () => {
    const cfg = makeConfig(seams);
    const { out, d } = deps({}, cfg);
    const code = await runReplayCmd(["nonexistent-id"], d);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("transcripts");
  });
});
