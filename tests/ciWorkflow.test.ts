import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// The node-version rails (#382). The engines floor is stated in three places
// that nothing else ties together — package.json, the workflow's floor leg,
// and .nvmrc — and the node 26 canary is only useful while it stays OUT of the
// aggregate gate: wired into `needs`, one flaky canary run blocks every merge.
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}
interface Job {
  "runs-on"?: string;
  needs?: string[];
  "continue-on-error"?: boolean;
  steps: Step[];
}
interface Workflow {
  jobs: Record<string, Job>;
}

const workflow = parseYaml(read(".github/workflows/quality-gate.yml")) as Workflow;
const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
const floor = pkg.engines.node.replace(/^>=/, "");

const usesOf = (job: Job, action: string) =>
  job.steps.filter((s) => s.uses?.startsWith(`${action}@`)).map((s) => s.uses);

describe("quality-gate.yml node 26 canary", () => {
  const canary = workflow.jobs.node26_canary;
  const envGate = workflow.jobs.env_gate;

  it("is a single ubuntu leg that builds and tests on node 26", () => {
    expect(canary).toBeDefined();
    expect(canary["runs-on"]).toBe("ubuntu-latest");
    const setupNode = canary.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
    expect(setupNode?.with?.["node-version"]).toBe("26");
    const runs = canary.steps.map((s) => s.run?.trim());
    expect(runs).toContain("npm ci");
    expect(runs).toContain("npm run build");
    expect(runs).toContain("npm test");
  });

  it("is non-blocking: continue-on-error, and absent from the aggregate gate's needs", () => {
    expect(canary["continue-on-error"]).toBe(true);
    expect(workflow.jobs.gate.needs).not.toContain("node26_canary");
    expect(workflow.jobs.gate.needs).toEqual(["env_gate"]);
  });

  it("reuses the blocking legs' SHA pins for checkout and setup-node", () => {
    for (const action of ["actions/checkout", "actions/setup-node"]) {
      const pins = new Set(usesOf(envGate, action));
      expect(pins.size).toBe(1);
      expect(usesOf(canary, action)).toEqual([...pins]);
    }
  });
});

describe(".nvmrc", () => {
  it("pins the exact engines floor, which is also the workflow's floor leg", () => {
    expect(floor).toMatch(/^\d+\.\d+\.\d+$/);
    expect(read(".nvmrc").trim()).toBe(floor);
    const floorStep = workflow.jobs.env_gate.steps.find(
      (s) => s.uses?.startsWith("actions/setup-node@") && s.with?.["node-version"] === floor,
    );
    expect(floorStep).toBeDefined();
  });
});
