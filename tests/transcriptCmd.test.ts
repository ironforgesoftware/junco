import { describe, it, expect } from "vitest";
import { runTranscriptCmd } from "../src/transcriptCmd.js";
import { transcriptPathFor } from "../src/slug.js";
import { dataTreePaths } from "../src/dataTree.js";
import { makeConfig, type ConfigSeams } from "./helpers/config.js";
import { agentStart, runEnd, runStart, turnEndFull } from "./helpers/transcriptFixtures.js";

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

const FIXTURE = [
  runStart({ flow: "assess", modelId: "m", ts: "2026-08-29T01:02:47.000Z" }),
  agentStart(),
  turnEndFull({
    thinking: "deep thoughts",
    text: "Assessment complete.",
    calls: [{ id: "c1", name: "read", args: { path: "game.js" }, result: "L1\nL2" }],
  }),
  runEnd({ stopReason: "stop", durationMs: 5000 }),
].join("\n");

describe("runTranscriptCmd", () => {
  const deps = (
    files: Record<string, string>,
    cfg: (() => ReturnType<typeof makeConfig>) | null = () => makeConfig(seams),
  ) => {
    const out: string[] = [];
    return {
      out,
      d: {
        loadCfg: () => {
          if (cfg === null) throw new Error("no config");
          return cfg();
        },
        readFile: (p: string) => {
          if (files[p] === undefined) throw new Error("ENOENT");
          return files[p];
        },
        stdout: (l: string) => out.push(l),
        columns: 80,
      },
    };
  };
  const path = transcriptPathFor(dataTreePaths(makeConfig(seams)).transcripts, "t-1");

  it("resolves a bare ticket id through the data tree and renders rows", async () => {
    const { out, d } = deps({ [path]: FIXTURE });
    expect(await runTranscriptCmd(["t-1"], d)).toBe(0);
    expect(out[0]).toContain("── run 1/1 · assess · m · 01:02:47 · stop · 5s");
    expect(out).toContain("  Assessment complete.");
    expect(out).toContain("  ▸ read game.js  → 2 lines");
    expect(out.some((l) => l.includes("deep thoughts"))).toBe(false);
    expect(out.some((l) => l.includes("L2"))).toBe(false);
  });

  it("--thinking and --tools expand thinking and every tool body", async () => {
    const { out, d } = deps({ [path]: FIXTURE });
    expect(await runTranscriptCmd(["t-1", "--thinking", "--tools"], d)).toBe(0);
    expect(out).toContain("  deep thoughts");
    expect(out).toContain("      L2");
  });

  it("a direct .jsonl path needs no config", async () => {
    const { out, d } = deps({ "/tmp/x.jsonl": FIXTURE }, null);
    expect(await runTranscriptCmd(["/tmp/x.jsonl"], d)).toBe(0);
    expect(out[0]).toContain("run 1/1");
  });

  it("bare id without config is exit 1 with guidance", async () => {
    const { out, d } = deps({}, null);
    expect(await runTranscriptCmd(["t-1"], d)).toBe(1);
    expect(out.join("\n")).toContain("no config found");
  });

  it("missing transcript is exit 1 with the path and transcripts dir", async () => {
    const { out, d } = deps({});
    expect(await runTranscriptCmd(["t-1"], d)).toBe(1);
    expect(out.join("\n")).toContain(`no transcript at ${path}`);
    expect(out.join("\n")).toContain("transcripts dir:");
  });

  it("--json prints the summary", async () => {
    const { out, d } = deps({ [path]: FIXTURE });
    expect(await runTranscriptCmd(["t-1", "--json"], d)).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as { runs: { turns: { text: string }[] }[] };
    expect(parsed.runs[0].turns[0].text).toBe("Assessment complete.");
  });

  it("--width bounds every line; bad width and no target are usage errors", async () => {
    const { out, d } = deps({ [path]: FIXTURE });
    expect(await runTranscriptCmd(["t-1", "--width", "30"], d)).toBe(0);
    expect(out.every((l) => l.length <= 30)).toBe(true);
    expect(await runTranscriptCmd(["t-1", "--width", "abc"], deps({}).d)).toBe(2);
    expect(await runTranscriptCmd([], deps({}).d)).toBe(2);
    expect(await runTranscriptCmd(["t-1", "--nope"], deps({}).d)).toBe(2);
  });
});
