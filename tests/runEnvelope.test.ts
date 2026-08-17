import { describe, it, expect } from "vitest";
import {
  guardOptionsFromConfig,
  buildGuardManager,
  runEnveloped,
} from "../src/agent/runEnvelope.js";
import { fakeSession } from "./helpers/fakeSession.js";
import { parseTranscriptLine } from "../src/agent/transcriptSchema.js";
import { makeConfig, type ConfigSeams } from "./helpers/config.js";

// makeConfig requires the ten ConfigSeams explicitly (see tests/helpers/config.ts) —
// supervisorEnabled is a seam, the other four supervisor knobs are ballast overrides.
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

describe("guardOptionsFromConfig", () => {
  it("threads the four supervisor knobs verbatim", () => {
    const cfg = makeConfig(seams, {
      supervisorBudgetPerKind: 2,
      supervisorEscalationWindow: 5,
      supervisorOutputBudgetPerTurn: 9000,
      supervisorOutputBudgetPostCommit: 18000,
    });
    expect(guardOptionsFromConfig(cfg)).toEqual({
      supervisorConfig: { budgetPerKind: 2, escalationWindowTurns: 5 },
      outputBudgetPerTurn: 9000,
      outputBudgetPostCommit: 18000,
    });
  });
});

describe("buildGuardManager", () => {
  it("returns undefined when the supervisor is disabled", () => {
    expect(buildGuardManager(makeConfig({ ...seams, supervisorEnabled: false }))).toBeUndefined();
  });
  it("returns a GuardManager when enabled", () => {
    const gm = buildGuardManager(makeConfig({ ...seams, supervisorEnabled: true }));
    expect(gm).toBeDefined();
    expect(gm!.supervisorSummary).toBe("no nudges issued");
  });
});

function memorySink(lines: string[]) {
  let ended = false;
  return {
    factory: () => ({
      write: (l: string) => lines.push(l),
      end: () => {
        ended = true;
      },
    }),
    wasEnded: () => ended,
  };
}

describe("runEnveloped", () => {
  // makeConfig(seams, overrides) — cfg() adapts the brief's `{ ...makeConfig() }`
  // spread to the real two-arg signature: seams above (supervisorEnabled: true is
  // already a seam there), transcriptsEnabled is an override.
  const cfg = () => makeConfig(seams, { transcriptsEnabled: true });

  it("frames the run: meta (new file) + run_start, events, run_end; ends the sink; records spend", async () => {
    const lines: string[] = [];
    const sink = memorySink(lines);
    const spent: number[] = [];
    const result = await runEnveloped(
      cfg(),
      { ticketId: "t-1", flow: "qa", body: "answer me", cwd: "/w", timeoutMs: 5000 },
      {
        createSession: fakeSession("hi", 0.25),
        spend: { recordUsd: (n) => spent.push(n) },
        transcriptSink: sink.factory,
        fileExists: () => false,
      },
    );
    expect(result.finalText).toBe("hi");
    const parsed = lines.map((l) => parseTranscriptLine(l.trimEnd()));
    const types = parsed.map((p) => (p.kind === "junco" ? p.record.type : (p as any).event?.type));
    expect(types[0]).toBe("junco_meta");
    expect(types[1]).toBe("junco_run_start");
    expect(types[types.length - 1]).toBe("junco_run_end");
    expect(types).toContain("turn_end");
    const start = parsed[1] as any;
    expect(start.record.body).toBe("answer me");
    expect(start.record.flow).toBe("qa");
    expect(spent).toEqual([0.25]);
    expect(sink.wasEnded()).toBe(true);
  });

  it("skips the meta record when the file already exists (corrective appends)", async () => {
    const lines: string[] = [];
    await runEnveloped(
      cfg(),
      { ticketId: "t-1", flow: "pr_corrective", body: "fix", cwd: "/w", timeoutMs: 5000 },
      {
        createSession: fakeSession("ok"),
        transcriptSink: memorySink(lines).factory,
        fileExists: () => true,
      },
    );
    expect(lines[0]).toContain("junco_run_start");
  });

  it("never leaks the api key into any transcript line", async () => {
    const lines: string[] = [];
    const c = { ...cfg(), model: { ...cfg().model, apiKey: "sk-SUPER-SECRET" } };
    await runEnveloped(
      c,
      { ticketId: "t-1", flow: "qa", body: "q", cwd: "/w", timeoutMs: 5000 },
      {
        createSession: fakeSession("a"),
        transcriptSink: memorySink(lines).factory,
        fileExists: () => false,
      },
    );
    expect(lines.join("")).not.toContain("sk-SUPER-SECRET");
  });

  it("writes no records when transcripts are disabled, but still runs and records spend", async () => {
    const lines: string[] = [];
    const spent: number[] = [];
    const r = await runEnveloped(
      makeConfig(seams, { transcriptsEnabled: false }),
      { ticketId: "t-1", flow: "qa", body: "q", cwd: "/w", timeoutMs: 5000 },
      {
        createSession: fakeSession("a", 0.1),
        spend: { recordUsd: (n) => spent.push(n) },
        transcriptSink: memorySink(lines).factory,
        fileExists: () => false,
      },
    );
    expect(r.finalText).toBe("a");
    expect(lines).toEqual([]);
    expect(spent).toEqual([0.1]);
  });
});
