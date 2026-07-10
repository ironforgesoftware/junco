import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAssessTicket,
  runAssessCommand,
  runAssessReviewCommand,
  runAssessFileCommand,
} from "../src/assessCmd.js";
import { parseTicket } from "../src/ticket.js";
import { writeWatchlist, watchlistPath } from "../src/watchlist.js";
import { writePending, readPending } from "../src/assessReview.js";
import type { Config, GithubRepoMapping } from "../src/types.js";
import type { submitTicket } from "../src/dispatch.js";
import type { resolveIssueTarget, IssueTarget } from "../src/externalDispatch.js";

const NONEXISTENT_STATE_DIR = "/nonexistent-junco-assesscmd-state";

function cfg(repos: GithubRepoMapping[] = [], stateDir: string = NONEXISTENT_STATE_DIR): Config {
  return {
    vaultRoot: "/vault",
    juncoSubdir: "Junco",
    stateDir,
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

  it("issue-scoped ticket: issue + issue_title land in frontmatter, body carries issue context, no github block", () => {
    const { id, content } = buildAssessTicket(
      "/c/api",
      { autoPlan: false, issueContext: { nwo: "up/stream", issue: 7, title: "Bug", body: "b" } },
      FIXED,
    );
    expect(id).toBe("assess-api-20260706-1234");

    const t = parseTicket("submitted.md", content);
    expect(t.assess?.issue).toBe(7);
    expect(t.assess?.issueTitle).toBe("Bug");
    expect(t.assess?.autoPlan).toBe(false);
    expect(t.github).toBeNull();
    expect(content).toContain("## Issue context (untrusted content)");
  });

  it("issue-scoped ticket with autoPlan: true carries both auto_plan and issue", () => {
    const { content } = buildAssessTicket(
      "/c/api",
      { autoPlan: true, issueContext: { nwo: "up/stream", issue: 7, title: "Bug", body: "b" } },
      FIXED,
    );
    expect(content).toContain("auto_plan: true");
    expect(content).toContain("issue: 7");

    const t = parseTicket("submitted.md", content);
    expect(t.assess?.autoPlan).toBe(true);
    expect(t.assess?.issue).toBe(7);
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

  it("resolves an external watchlist entry to its clone path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acmd-"));
    const c = cfg([], dir); // stateDir = dir
    writeWatchlist(watchlistPath(c), [
      { nwo: "up/stream", path: join(dir, "clone"), external: true },
    ]);
    let submitted = "";
    const submitFn = ((_c: Config, content: string) => {
      submitted = content;
      return "/dst";
    }) as typeof submitTicket;

    const code = await runAssessCommand(
      c,
      "up/stream",
      { autoPlan: false },
      { printFn: () => {}, submitFn },
    );

    expect(code).toBe(0);
    expect(submitted).toContain(JSON.stringify(join(dir, "clone")));
  });

  it("issue-ref target (owner/repo#N): resolveFn result submits with the resolved clonePath, issue frontmatter", async () => {
    const resolveFn = (async () => {
      return {
        nwo: "up/stream",
        issue: 7,
        title: "Bug",
        body: "details",
        clonePath: "/clones/up-stream",
        external: true,
        forkNwo: "me/stream",
      } satisfies IssueTarget;
    }) as typeof resolveIssueTarget;

    let submittedContent = "";
    const submitFn = ((_c: Config, content: string) => {
      submittedContent = content;
      return "/inbox/assess-up-stream-7.md";
    }) as typeof submitTicket;

    const out: string[] = [];
    const code = await runAssessCommand(
      cfg(),
      "up/stream#7",
      { autoPlan: false },
      { printFn: (s) => out.push(s), submitFn, resolveFn },
    );

    expect(code).toBe(0);
    expect(submittedContent).toContain(`repo: ${JSON.stringify("/clones/up-stream")}`);
    expect(submittedContent).toContain("issue: 7");
    expect(submittedContent).toContain(JSON.stringify("Bug"));
    expect(out.join("")).toContain("queued:");
  });

  it("issue-ref target: resolveFn throws -> exit 1, message prefixed `junco assess:`", async () => {
    const resolveFn = (async () => {
      throw new Error("issue not found");
    }) as typeof resolveIssueTarget;

    const out: string[] = [];
    const code = await runAssessCommand(
      cfg(),
      "up/stream#7",
      { autoPlan: false },
      { printFn: (s) => out.push(s), resolveFn },
    );

    expect(code).toBe(1);
    expect(out.join("")).toContain("junco assess: issue not found");
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

describe("runAssessReviewCommand", () => {
  it("assess review lists pending batches and shows one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arv-"));
    const c = cfg([], dir);
    writePending(c, {
      id: "assess-x-1",
      nwo: "o/r",
      external: true,
      autoPlan: false,
      repoPath: "/x",
      createdAt: "2026-07-09T00:00:00.000Z",
      findings: [
        {
          fingerprint: "f1",
          kind: "code",
          severity: "high",
          ruleId: "R",
          title: "Bug",
          description: "",
          references: [],
        },
      ],
    });
    let out = "";
    const print = (s: string) => {
      out += s;
    };
    expect(await runAssessReviewCommand(c, undefined, { printFn: print })).toBe(0);
    expect(out).toContain("assess-x-1");
    expect(out).toContain("o/r");

    out = "";
    expect(await runAssessReviewCommand(c, "assess-x-1", { printFn: print })).toBe(0);
    expect(out).toContain("f1");
    expect(out).toContain("Bug");
  });

  it("no pending batches -> prints a friendly message, exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arv-empty-"));
    const c = cfg([], dir);
    let out = "";
    const code = await runAssessReviewCommand(c, undefined, {
      printFn: (s) => {
        out += s;
      },
    });
    expect(code).toBe(0);
    expect(out).toMatch(/no pending/i);
  });

  it("unknown id -> exit 2, message names the id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arv-missing-"));
    const c = cfg([], dir);
    let out = "";
    const code = await runAssessReviewCommand(c, "assess-ghost", {
      printFn: (s) => {
        out += s;
      },
    });
    expect(code).toBe(2);
    expect(out).toContain("assess-ghost");
  });
});

describe("runAssessFileCommand", () => {
  it("assess file requires a selection and files the chosen findings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afc-"));
    const c = cfg([], dir);
    writePending(c, {
      id: "assess-x-1",
      nwo: "o/r",
      external: true,
      autoPlan: false,
      repoPath: "/x",
      createdAt: "2026-07-09T00:00:00.000Z",
      findings: [
        {
          fingerprint: "f1",
          kind: "code",
          severity: "high",
          ruleId: "R",
          title: "One",
          description: "",
          references: [],
        },
        {
          fingerprint: "f2",
          kind: "code",
          severity: "low",
          ruleId: "R",
          title: "Two",
          description: "",
          references: [],
        },
      ],
    });
    let out = "";
    const print = (s: string) => {
      out += s;
    };

    // no selection -> usage error, files nothing
    expect(
      await runAssessFileCommand(
        c,
        "assess-x-1",
        { all: false, only: undefined },
        { printFn: print },
      ),
    ).toBe(2);

    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      if (args[1] === "create")
        return { stdout: "https://github.com/o/r/issues/1\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as never;

    out = "";
    const code = await runAssessFileCommand(
      c,
      "assess-x-1",
      { all: false, only: "f1" },
      { printFn: print, fileDeps: { ghFn } },
    );
    expect(code).toBe(0);
    expect(out).toContain("filed 1");
  });

  it("--only with an unknown fingerprint -> exit 2, files nothing, preserves the batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afc-badfp-"));
    const c = cfg([], dir);
    writePending(c, {
      id: "assess-x-9",
      nwo: "o/r",
      external: true,
      autoPlan: false,
      repoPath: "/x",
      createdAt: "2026-07-09T00:00:00.000Z",
      findings: [
        {
          fingerprint: "f1",
          kind: "code",
          severity: "high",
          ruleId: "R",
          title: "One",
          description: "",
          references: [],
        },
      ],
    });
    let out = "";
    const calls: string[][] = [];
    const ghFn = (async (_c: unknown, args: string[]) => {
      calls.push(args);
      if (args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      if (args[1] === "create")
        return { stdout: "https://github.com/o/r/issues/1\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as never;

    const code = await runAssessFileCommand(
      c,
      "assess-x-9",
      { all: false, only: "nosuchfp" },
      {
        printFn: (s) => {
          out += s;
        },
        fileDeps: { ghFn },
      },
    );
    expect(code).toBe(2);
    expect(out).toMatch(/unknown fingerprint/i);
    expect(out).toContain("nosuchfp");
    // nothing was filed
    expect(calls.some((a) => a[1] === "create")).toBe(false);
    // and the batch survives — a typo must not discard the review
    expect(readPending(c, "assess-x-9").batch).not.toBeNull();
  });

  it.each([" ", ",,", " , , "])(
    "--only with a whitespace/comma-only value (%j) -> exit 2, files nothing, preserves the batch",
    async (only) => {
      const dir = mkdtempSync(join(tmpdir(), "afc-emptyonly-"));
      const c = cfg([], dir);
      writePending(c, {
        id: "assess-x-empty",
        nwo: "o/r",
        external: true,
        autoPlan: false,
        repoPath: "/x",
        createdAt: "2026-07-09T00:00:00.000Z",
        findings: [
          {
            fingerprint: "f1",
            kind: "code",
            severity: "high",
            ruleId: "R",
            title: "One",
            description: "",
            references: [],
          },
        ],
      });
      let out = "";
      const calls: string[][] = [];
      const ghFn = (async (_c: unknown, args: string[]) => {
        calls.push(args);
        if (args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
        if (args[1] === "create")
          return { stdout: "https://github.com/o/r/issues/1\n", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      }) as never;

      const code = await runAssessFileCommand(
        c,
        "assess-x-empty",
        { all: false, only },
        {
          printFn: (s) => {
            out += s;
          },
          fileDeps: { ghFn },
        },
      );
      // A --only value that resolves to no fingerprints is a usage error, not a
      // silent success — it must not exit 0 or file anything (#138).
      expect(code).toBe(2);
      expect(out).toMatch(/--only/);
      expect(calls.some((a) => a[1] === "create")).toBe(false);
      // batch survives — an empty selection must not discard the review
      expect(readPending(c, "assess-x-empty").batch).not.toBeNull();
    },
  );

  it("no id -> usage line, exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afc-noid-"));
    const c = cfg([], dir);
    let out = "";
    const code = await runAssessFileCommand(
      c,
      undefined,
      { all: true, only: undefined },
      {
        printFn: (s) => {
          out += s;
        },
      },
    );
    expect(code).toBe(2);
    expect(out).toMatch(/usage/i);
  });

  it("unknown id -> exit 2, message names the id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afc-missing-"));
    const c = cfg([], dir);
    let out = "";
    const code = await runAssessFileCommand(
      c,
      "assess-ghost",
      { all: true, only: undefined },
      {
        printFn: (s) => {
          out += s;
        },
      },
    );
    expect(code).toBe(2);
    expect(out).toContain("assess-ghost");
  });

  it("--all files every finding in the batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afc-all-"));
    const c = cfg([], dir);
    writePending(c, {
      id: "assess-x-2",
      nwo: "o/r",
      external: true,
      autoPlan: false,
      repoPath: "/x",
      createdAt: "2026-07-09T00:00:00.000Z",
      findings: [
        {
          fingerprint: "f1",
          kind: "code",
          severity: "high",
          ruleId: "R",
          title: "One",
          description: "",
          references: [],
        },
        {
          fingerprint: "f2",
          kind: "code",
          severity: "low",
          ruleId: "R",
          title: "Two",
          description: "",
          references: [],
        },
      ],
    });
    let out = "";
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      if (args[1] === "create")
        return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as never;

    const code = await runAssessFileCommand(
      c,
      "assess-x-2",
      { all: true, only: undefined },
      {
        printFn: (s) => {
          out += s;
        },
        fileDeps: { ghFn },
      },
    );
    expect(code).toBe(0);
    expect(out).toContain("filed 2");
  });

  it("failed findings surface a nonzero exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afc-fail-"));
    const c = cfg([], dir);
    writePending(c, {
      id: "assess-x-3",
      nwo: "o/r",
      external: true,
      autoPlan: false,
      repoPath: "/x",
      createdAt: "2026-07-09T00:00:00.000Z",
      findings: [
        {
          fingerprint: "f1",
          kind: "code",
          severity: "high",
          ruleId: "R",
          title: "One",
          description: "",
          references: [],
        },
      ],
    });
    let out = "";
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      throw new Error("boom");
    }) as never;

    const code = await runAssessFileCommand(
      c,
      "assess-x-3",
      { all: true, only: undefined },
      {
        printFn: (s) => {
          out += s;
        },
        fileDeps: { ghFn },
      },
    );
    expect(code).toBe(1);
    expect(out).toContain("failed 1");
  });
});
