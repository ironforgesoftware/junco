import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAssessTicket, runAssessCommand } from "../src/assessCmd.js";
import { parseTicket } from "../src/ticket.js";
import type { Config, GithubRepoMapping } from "../src/types.js";
import type { submitTicket } from "../src/dispatch.js";

function cfg(repos: GithubRepoMapping[] = []): Config {
  return {
    vaultRoot: "/vault",
    juncoSubdir: "Junco",
    stateDir: "/nonexistent-junco-assesscmd-state",
    github: {
      enabled: false,
      triggerLabel: "junco",
      askLabel: "junco:ask",
      pollIntervalSeconds: 60,
      repos,
      requireApproval: true,
      plannerModelId: null,
    },
  } as unknown as Config;
}

const FIXED = new Date("2026-07-06T12:34:00Z");

describe("buildAssessTicket", () => {
  it("golden ticket (autoPlan: true) round-trips through parseTicket", () => {
    const { id, content } = buildAssessTicket("/tmp/x/my-repo", { autoPlan: true }, FIXED);
    expect(id).toBe("assess-my-repo-20260706-1234");

    const t = parseTicket("submitted.md", content);
    expect(t.id).toBe(id);
    expect(t.hasRepo).toBe(true);
    expect(t.frontmatter.repo).toBe("/tmp/x/my-repo");
    expect(t.assess).toEqual({ autoPlan: true });
    expect(content).toContain("junco-findings");
  });

  it("autoPlan: false emits `assess: {}` and parses to autoPlan: false", () => {
    const { content } = buildAssessTicket("/tmp/x/my-repo", { autoPlan: false }, FIXED);
    expect(content).toContain("assess: {}");

    const t = parseTicket("submitted.md", content);
    expect(t.assess).toEqual({ autoPlan: false });
  });
});

describe("runAssessCommand", () => {
  it("no target -> usage line, exit 2", async () => {
    const out: string[] = [];
    const code = await runAssessCommand(
      cfg(),
      undefined,
      { autoPlan: false },
      {
        printFn: (s) => out.push(s),
      },
    );
    expect(code).toBe(2);
    expect(out.join("")).toMatch(/usage/i);
  });

  it("path target: existing tmpdir -> submitFn called with the resolved repo, prints the destination, exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-assesscmd-path-"));
    let submittedContent = "";
    let submittedCfg: Config | null = null;
    const submitFn = ((c: Config, content: string) => {
      submittedCfg = c;
      submittedContent = content;
      return "/inbox/assess-my-repo.md";
    }) as typeof submitTicket;

    const out: string[] = [];
    const c = cfg();
    const code = await runAssessCommand(
      c,
      dir,
      { autoPlan: false },
      {
        printFn: (s) => out.push(s),
        submitFn,
      },
    );

    expect(code).toBe(0);
    expect(submittedCfg).toBe(c);
    expect(submittedContent).toContain(`repo: ${JSON.stringify(dir)}`);
    expect(out.join("")).toContain("/inbox/assess-my-repo.md");
  });

  it("--auto-plan is threaded into the queued ticket and noted in the output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-assesscmd-autoplan-"));
    let submittedContent = "";
    const submitFn = ((_c: Config, content: string) => {
      submittedContent = content;
      return "/inbox/assess-my-repo.md";
    }) as typeof submitTicket;

    const out: string[] = [];
    const code = await runAssessCommand(
      cfg(),
      dir,
      { autoPlan: true },
      {
        printFn: (s) => out.push(s),
        submitFn,
      },
    );

    expect(code).toBe(0);
    expect(submittedContent).toContain("auto_plan: true");
    expect(out.join("")).toMatch(/auto-plan/i);
  });

  it("nwo target (case-insensitive) resolves via the watched repos", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-assesscmd-nwo-"));
    const c = cfg([{ nwo: "Acme/Demo", path: dir }]);
    let submittedContent = "";
    const submitFn = ((_c: Config, content: string) => {
      submittedContent = content;
      return "/inbox/assess-demo.md";
    }) as typeof submitTicket;

    const out: string[] = [];
    const code = await runAssessCommand(
      c,
      "acme/demo",
      { autoPlan: false },
      {
        printFn: (s) => out.push(s),
        submitFn,
      },
    );

    expect(code).toBe(0);
    expect(submittedContent).toContain(`repo: ${JSON.stringify(dir)}`);
  });

  it("unknown nwo -> exit 2, message mentions the repo isn't watched", async () => {
    const out: string[] = [];
    const code = await runAssessCommand(
      cfg(),
      "acme/ghost",
      { autoPlan: false },
      {
        printFn: (s) => out.push(s),
      },
    );
    expect(code).toBe(2);
    expect(out.join("")).toMatch(/not watched/i);
  });

  it("missing target -> exit 2 usage", async () => {
    const out: string[] = [];
    const code = await runAssessCommand(
      cfg(),
      undefined,
      { autoPlan: false },
      {
        printFn: (s) => out.push(s),
      },
    );
    expect(code).toBe(2);
    expect(out.join("")).toMatch(/usage/i);
  });

  it("nonexistent path target -> exit 2", async () => {
    const out: string[] = [];
    const code = await runAssessCommand(
      cfg(),
      "/no/such/junco-assesscmd-dir-xyz",
      { autoPlan: false },
      { printFn: (s) => out.push(s) },
    );
    expect(code).toBe(2);
  });

  it("duplicate submit: submitFn throws -> exit 1, message surfaced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-assesscmd-dup-"));
    const submitFn = (() => {
      throw new Error("ticket already queued: /inbox/assess-my-repo.md");
    }) as typeof submitTicket;

    const out: string[] = [];
    const code = await runAssessCommand(
      cfg(),
      dir,
      { autoPlan: false },
      {
        printFn: (s) => out.push(s),
        submitFn,
      },
    );

    expect(code).toBe(1);
    expect(out.join("")).toContain("ticket already queued");
  });
});
