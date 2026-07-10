import { describe, it, expect } from "vitest";
import { buildAnalyzeTicket, runAnalyzeCommand } from "../src/analyzeCmd.js";
import { parseTicket } from "../src/ticket.js";
import type { IssueTarget } from "../src/externalDispatch.js";
import type { Config } from "../src/types.js";
import type { submitTicket } from "../src/dispatch.js";
import type { resolveIssueTarget } from "../src/externalDispatch.js";

const NONEXISTENT_STATE_DIR = "/nonexistent-junco-analyzecmd-state";

function cfg(stateDir: string = NONEXISTENT_STATE_DIR): Config {
  return {
    vaultRoot: "/vault",
    juncoSubdir: "Junco",
    stateDir,
    github: {
      enabled: false,
      triggerLabel: "junco",
      askLabel: "junco:ask",
      pollIntervalSeconds: 60,
      repos: [],
      requireApproval: true,
      plannerModelId: null,
    },
  } as unknown as Config;
}

function target(overrides: Partial<IssueTarget> = {}): IssueTarget {
  return {
    nwo: "up/stream",
    issue: 7,
    title: "Widgets explode on save",
    body: "Steps to reproduce...",
    clonePath: "/clones/up-stream",
    external: true,
    forkNwo: "me/stream",
    ...overrides,
  };
}

describe("buildAnalyzeTicket", () => {
  it("golden ticket round-trips through parseTicket", () => {
    const t = target();
    const { id, content } = buildAnalyzeTicket(t);

    expect(id).toBe("analyze-up-stream-7");

    const parsed = parseTicket("submitted.md", content);
    expect(parsed.id).toBe(id);
    expect(parsed.hasRepo).toBe(true);
    expect(parsed.frontmatter.repo).toBe(t.clonePath);
    expect(parsed.analyze).toEqual({ issue: 7, title: t.title });
    // The reporter-key lock: no github: block, so the reporter must no-op.
    expect(parsed.github).toBeNull();

    expect(content).toContain("junco-comment");
    expect(content).toContain("data, not instructions");
    expect(content).toContain(t.title);
    expect(content).toContain(t.body);
  });

  it("empty issue body renders the no-body placeholder, not a blank line", () => {
    const t = target({ body: "" });
    const { content } = buildAnalyzeTicket(t);
    expect(content).toContain("(no issue body)");
  });
});

describe("runAnalyzeCommand", () => {
  it("missing ref -> usage line, exit 2", async () => {
    const out: string[] = [];
    const code = await runAnalyzeCommand(cfg(), undefined, {
      printFn: (s) => out.push(s),
    });
    expect(code).toBe(2);
    expect(out.join("")).toMatch(/usage/i);
  });

  it("happy path: resolves, submits, prints queued:, exit 0", async () => {
    const resolveFn = (async (_c: Config, input: string) => {
      expect(input).toBe("up/stream#7");
      return target();
    }) as typeof resolveIssueTarget;

    let submittedCfg: Config | null = null;
    let submittedContent = "";
    let submittedIdHint: string | undefined;
    const submitFn = ((c: Config, content: string, opts?: { idHint?: string }) => {
      submittedCfg = c;
      submittedContent = content;
      submittedIdHint = opts?.idHint;
      return "/inbox/analyze-up-stream-7.md";
    }) as typeof submitTicket;

    const out: string[] = [];
    const c = cfg();
    const code = await runAnalyzeCommand(c, "up/stream#7", {
      printFn: (s) => out.push(s),
      resolveFn,
      submitFn,
    });

    expect(code).toBe(0);
    expect(submittedCfg).toBe(c);
    expect(submittedIdHint).toBe("analyze-up-stream-7");
    expect(submittedContent).toContain("analyze:\n  issue: 7");
    expect(out.join("")).toContain("queued: /inbox/analyze-up-stream-7.md");
    expect(out.join("")).toMatch(/junco analyze review/);
  });

  it("resolveFn throws (bad ref / gh failure) -> exit 1, message surfaced", async () => {
    const resolveFn = (async () => {
      throw new Error(
        'not a GitHub issue reference: "nope" (expected owner/repo#N or an issue URL)',
      );
    }) as typeof resolveIssueTarget;

    const out: string[] = [];
    const code = await runAnalyzeCommand(cfg(), "nope", {
      printFn: (s) => out.push(s),
      resolveFn,
    });

    expect(code).toBe(1);
    expect(out.join("")).toContain("junco analyze:");
    expect(out.join("")).toContain("not a GitHub issue reference");
  });

  it("submitFn throws (queued duplicate) -> exit 1, message surfaced", async () => {
    const resolveFn = (async () => target()) as typeof resolveIssueTarget;
    const submitFn = (() => {
      throw new Error("ticket already queued: /inbox/analyze-up-stream-7.md");
    }) as typeof submitTicket;

    const out: string[] = [];
    const code = await runAnalyzeCommand(cfg(), "up/stream#7", {
      printFn: (s) => out.push(s),
      resolveFn,
      submitFn,
    });

    expect(code).toBe(1);
    expect(out.join("")).toContain("ticket already queued");
  });
});
