import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAnalyzeTicket,
  runAnalyzeCommand,
  runAnalyzeReviewCommand,
  runAnalyzeEditCommand,
  runAnalyzePostCommand,
} from "../src/analyzeCmd.js";
import { parseTicket } from "../src/ticket.js";
import {
  writeDraft,
  readDraft,
  commentReviewPaths,
  ANALYSIS_FOOTER,
} from "../src/commentReview.js";
import type { PendingComment } from "../src/commentReview.js";
import type { IssueTarget } from "../src/externalDispatch.js";
import type { Config } from "../src/types.js";
import type { submitTicket } from "../src/dispatch.js";
import type { resolveIssueTarget } from "../src/externalDispatch.js";
import { GitOpError, type gh } from "../src/git.js";
import { listOps, flushOutbox } from "../src/githubOutbox.js";

/** Network-shaped GitOpError → isOffline()/isNetworkError() true. */
const NET_ERR = new GitOpError("gh failed", "connect: network is unreachable", 1);
/** Non-network (permission) GitOpError → isOffline() false. */
const PERM_ERR = new GitOpError("gh failed", "HTTP 403: Forbidden", 1);

const NONEXISTENT_STATE_DIR = "/nonexistent-junco-analyzecmd-state";

function cfg(stateDir: string = NONEXISTENT_STATE_DIR): Config {
  return {
    dataDir: stateDir,
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

function comment(id: string, overrides: Partial<PendingComment> = {}): PendingComment {
  return {
    id,
    nwo: "o/r",
    issue: 42,
    issueTitle: "Something broke",
    external: true,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    draft: "Here's my analysis of the issue.",
    footer: true,
    ...overrides,
  };
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

describe("runAnalyzeReviewCommand", () => {
  it("no id: lists pending drafts (id, nwo#issue, first draft line); empty -> friendly message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arev-empty-"));
    const c = cfg(dir);
    let out = "";
    const print = (s: string) => {
      out += s;
    };
    expect(await runAnalyzeReviewCommand(c, undefined, { printFn: print })).toBe(0);
    expect(out).toMatch(/no pending comment drafts/);

    writeDraft(c, comment("analyze-o-r-42"));
    out = "";
    expect(await runAnalyzeReviewCommand(c, undefined, { printFn: print })).toBe(0);
    expect(out).toContain("analyze-o-r-42");
    expect(out).toContain("o/r#42");
    expect(out).toContain("Here's my analysis of the issue.");
  });

  it("with id: prints the full draft, includes the footer line when footer:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arev-show-"));
    const c = cfg(dir);
    writeDraft(c, comment("analyze-o-r-42", { draft: "Full analysis body here." }));

    let out = "";
    const code = await runAnalyzeReviewCommand(c, "analyze-o-r-42", {
      printFn: (s) => {
        out += s;
      },
    });
    expect(code).toBe(0);
    expect(out).toContain("Full analysis body here.");
    expect(out).toContain(ANALYSIS_FOOTER);
    expect(out).toContain("post: junco analyze post analyze-o-r-42");
  });

  it("with id: footer:false omits the footer line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arev-nofooter-"));
    const c = cfg(dir);
    writeDraft(c, comment("analyze-o-r-42", { draft: "Body only.", footer: false }));

    let out = "";
    await runAnalyzeReviewCommand(c, "analyze-o-r-42", {
      printFn: (s) => {
        out += s;
      },
    });
    expect(out).toContain("Body only.");
    expect(out).not.toContain(ANALYSIS_FOOTER);
  });

  it("unknown id -> exit 2, message names the id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arev-missing-"));
    const c = cfg(dir);
    let out = "";
    const code = await runAnalyzeReviewCommand(c, "analyze-ghost", {
      printFn: (s) => {
        out += s;
      },
    });
    expect(code).toBe(2);
    expect(out).toContain("analyze-ghost");
  });
});

describe("runAnalyzeEditCommand", () => {
  it("round-trip: spawnFn rewrites the temp file, store now holds the sanitized replacement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aedit-ok-"));
    const c = cfg(dir);
    writeDraft(c, comment("analyze-o-r-42", { draft: "Original body." }));

    let capturedFile = "";
    const code = await runAnalyzeEditCommand(c, "analyze-o-r-42", {
      env: { EDITOR: "vim" },
      spawnFn: (cmd, args) => {
        expect(cmd).toBe("vim");
        capturedFile = args[0] ?? "";
        writeFileSync(capturedFile, "EDITED body");
        return { status: 0 };
      },
    });

    expect(code).toBe(0);
    expect(capturedFile).toMatch(/draft\.md$/);
    const { draft } = readDraft(c, "analyze-o-r-42");
    expect(draft?.draft).toBe("EDITED body");
    // Other fields preserved.
    expect(draft?.nwo).toBe("o/r");
    expect(draft?.issue).toBe(42);
    expect(draft?.footer).toBe(true);
  });

  it("$EDITOR and $VISUAL both unset -> exit 2, prints the real draft file path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aedit-noeditor-"));
    const c = cfg(dir);
    writeDraft(c, comment("analyze-o-r-42"));

    let out = "";
    const code = await runAnalyzeEditCommand(c, "analyze-o-r-42", {
      env: {},
      printFn: (s) => {
        out += s;
      },
    });

    expect(code).toBe(2);
    expect(out).toMatch(/EDITOR/);
    const path = join(commentReviewPaths(c).dir, "analyze-o-r-42.json");
    expect(existsSync(path)).toBe(true);
    expect(out).toContain(path);
  });

  it("editor exits nonzero -> exit 1, store unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aedit-nonzero-"));
    const c = cfg(dir);
    writeDraft(c, comment("analyze-o-r-42", { draft: "Original body." }));

    let out = "";
    const code = await runAnalyzeEditCommand(c, "analyze-o-r-42", {
      env: { EDITOR: "vim" },
      spawnFn: () => ({ status: 1 }),
      printFn: (s) => {
        out += s;
      },
    });

    expect(code).toBe(1);
    expect(out).toMatch(/unchanged/);
    const { draft } = readDraft(c, "analyze-o-r-42");
    expect(draft?.draft).toBe("Original body.");
  });

  it("sanitizes on write: an outbox-marker HTML comment is stripped from the stored draft", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aedit-sanitize-"));
    const c = cfg(dir);
    writeDraft(c, comment("analyze-o-r-42", { draft: "Original body." }));

    const code = await runAnalyzeEditCommand(c, "analyze-o-r-42", {
      env: { EDITOR: "vim" },
      spawnFn: (_cmd, args) => {
        writeFileSync(args[0] ?? "", "Edited <!-- junco:outbox:x --> body");
        return { status: 0 };
      },
    });

    expect(code).toBe(0);
    const { draft } = readDraft(c, "analyze-o-r-42");
    expect(draft?.draft).toBe("Edited  body");
    expect(draft?.draft).not.toContain("junco:outbox");
  });

  it("edited text that sanitizes to empty -> exit 1, store unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aedit-empty-"));
    const c = cfg(dir);
    writeDraft(c, comment("analyze-o-r-42", { draft: "Original body." }));

    let out = "";
    const code = await runAnalyzeEditCommand(c, "analyze-o-r-42", {
      env: { EDITOR: "vim" },
      spawnFn: (_cmd, args) => {
        // An HTML comment plus whitespace: sanitizeFindingText strips both,
        // leaving an empty string — the guard must refuse to store it.
        writeFileSync(args[0] ?? "", "<!-- only a comment -->\n\n  ");
        return { status: 0 };
      },
      printFn: (s) => {
        out += s;
      },
    });

    expect(code).toBe(1);
    expect(out).toMatch(/empty after sanitize — unchanged/);
    const { draft } = readDraft(c, "analyze-o-r-42");
    expect(draft?.draft).toBe("Original body.");
  });

  it("missing id -> exit 2; store read error -> exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aedit-missing-"));
    const c = cfg(dir);
    let out = "";
    const code = await runAnalyzeEditCommand(c, "analyze-ghost", {
      env: { EDITOR: "vim" },
      printFn: (s) => {
        out += s;
      },
    });
    expect(code).toBe(2);
    expect(out).toContain("analyze-ghost");

    mkdirSync(commentReviewPaths(c).dir, { recursive: true });
    writeFileSync(join(commentReviewPaths(c).dir, "analyze-bad.json"), "{not json");
    out = "";
    const code2 = await runAnalyzeEditCommand(c, "analyze-bad", {
      env: { EDITOR: "vim" },
      printFn: (s) => {
        out += s;
      },
    });
    expect(code2).toBe(1);
  });
});

describe("runAnalyzePostCommand", () => {
  it("happy post: body ends with footer, prints posted url, draft archived to posted/", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apost-happy-"));
    const c = cfg(dir);
    writeDraft(c, comment("analyze-o-r-42", { draft: "Here's my analysis of the issue." }));

    let capturedBody = "";
    const ghFn = (async (_c: Config, args: string[]) => {
      expect(args[0]).toBe("issue");
      expect(args[1]).toBe("comment");
      expect(args[2]).toBe("42");
      expect(args).toContain("--repo");
      expect(args[args.indexOf("--repo") + 1]).toBe("o/r");
      const file = args[args.indexOf("--body-file") + 1];
      capturedBody = readFileSync(file, "utf8"); // read INSIDE the fake, before cleanup
      return {
        stdout: "https://github.com/o/r/issues/42#issuecomment-1\n",
        stderr: "",
        code: 0,
      };
    }) as unknown as typeof gh;

    let out = "";
    const code = await runAnalyzePostCommand(
      c,
      "analyze-o-r-42",
      { noFooter: false },
      { printFn: (s) => (out += s), ghFn },
    );

    expect(code).toBe(0);
    expect(out).toContain("posted: https://github.com/o/r/issues/42#issuecomment-1");
    expect(capturedBody).toContain(ANALYSIS_FOOTER);
    expect(capturedBody).toContain("<!-- junco:outbox:"); // idempotency marker embedded (#132)
    // archived: gone from the pending store, present under posted/
    expect(readDraft(c, "analyze-o-r-42").draft).toBeNull();
    expect(existsSync(join(commentReviewPaths(c).posted, "analyze-o-r-42.json"))).toBe(true);
  });

  it("--no-footer: body handed to gh equals the bare draft", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apost-nofooter-"));
    const c = cfg(dir);
    writeDraft(c, comment("analyze-o-r-42", { draft: "Bare draft body." }));

    let capturedBody = "";
    const ghFn = (async (_c: Config, args: string[]) => {
      const file = args[args.indexOf("--body-file") + 1];
      capturedBody = readFileSync(file, "utf8");
      return { stdout: "https://github.com/o/r/issues/42#issuecomment-2\n", stderr: "", code: 0 };
    }) as unknown as typeof gh;

    const code = await runAnalyzePostCommand(c, "analyze-o-r-42", { noFooter: true }, { ghFn });

    expect(code).toBe(0);
    expect(capturedBody).toContain("Bare draft body.");
    expect(capturedBody).not.toContain(ANALYSIS_FOOTER);
    expect(capturedBody).toContain("<!-- junco:outbox:"); // marker embedded, no footer (#132)
  });

  it("offline: network-shaped GitOpError -> queued message, durable op, draft archived", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apost-offline-"));
    const c = cfg(dir);
    writeDraft(c, comment("analyze-o-r-42"));

    const ghFn = (async () => {
      throw NET_ERR;
    }) as unknown as typeof gh;

    let out = "";
    const code = await runAnalyzePostCommand(
      c,
      "analyze-o-r-42",
      { noFooter: false },
      { printFn: (s) => (out += s), ghFn },
    );

    expect(code).toBe(0);
    expect(out).toMatch(/offline .* queued to the outbox/);
    const ops = listOps(c);
    expect(ops).toHaveLength(1);
    expect(ops[0].op.kind).toBe("comment");
    expect(ops[0].origin).toBe("analyze");
    if (ops[0].op.kind === "comment") {
      expect(ops[0].op.body.endsWith(ANALYSIS_FOOTER)).toBe(true);
    }
    // archived — a queued op is durable, the draft's job is done
    expect(readDraft(c, "analyze-o-r-42").draft).toBeNull();
    expect(existsSync(join(commentReviewPaths(c).posted, "analyze-o-r-42.json"))).toBe(true);
  });

  it("non-network failure -> exit 1, message printed, draft still pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apost-forbidden-"));
    const c = cfg(dir);
    writeDraft(c, comment("analyze-o-r-42"));

    const ghFn = (async () => {
      throw PERM_ERR;
    }) as unknown as typeof gh;

    let out = "";
    const code = await runAnalyzePostCommand(
      c,
      "analyze-o-r-42",
      { noFooter: false },
      { printFn: (s) => (out += s), ghFn },
    );

    expect(code).toBe(1);
    expect(out).toContain("junco analyze post:");
    expect(out).toMatch(/403/);
    const { draft } = readDraft(c, "analyze-o-r-42");
    expect(draft).not.toBeNull();
    expect(existsSync(join(commentReviewPaths(c).posted, "analyze-o-r-42.json"))).toBe(false);
  });

  it("missing id -> exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apost-missingid-"));
    const c = cfg(dir);
    let out = "";
    const code = await runAnalyzePostCommand(
      c,
      undefined,
      { noFooter: false },
      {
        printFn: (s) => (out += s),
      },
    );
    expect(code).toBe(2);
    expect(out).toMatch(/usage/i);
  });

  it("unknown id -> exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apost-unknown-"));
    const c = cfg(dir);
    let out = "";
    const code = await runAnalyzePostCommand(
      c,
      "analyze-ghost",
      { noFooter: false },
      {
        printFn: (s) => (out += s),
      },
    );
    expect(code).toBe(2);
    expect(out).toContain("analyze-ghost");
  });

  it("lost-ack: a live post that succeeded but lost its ack is NOT double-posted on the next flush (#132)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apost-lostack-"));
    const c = cfg(dir);
    writeDraft(c, comment("analyze-o-r-42", { draft: "Here's my analysis." }));

    const ME = "junco-bot";
    const upstream: { login: string; body: string }[] = [];
    let posts = 0;
    const ghFn = (async (_c: Config, args: string[]) => {
      if (args[0] === "issue" && args[1] === "comment") {
        // The server DID create the comment ...
        const file = args[args.indexOf("--body-file") + 1];
        upstream.push({ login: ME, body: readFileSync(file, "utf8") });
        posts++;
        // ... but the ack never arrived → surfaces as a network error.
        throw NET_ERR;
      }
      if (args[0] === "api" && args[1] === "user")
        return { stdout: `${ME}\n`, stderr: "", code: 0 };
      if (args[0] === "api")
        return { stdout: upstream.map((u) => JSON.stringify(u)).join("\n"), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;

    // Live post: comment created server-side, ack lost → op enqueued, draft archived.
    const code = await runAnalyzePostCommand(c, "analyze-o-r-42", { noFooter: false }, { ghFn });
    expect(code).toBe(0);
    expect(posts).toBe(1);
    expect(listOps(c)).toHaveLength(1);

    // Flush: the scan recognizes junco's own already-delivered comment → no re-post.
    const r = await flushOutbox(c, { ghFn });
    expect(r).toMatchObject({ sent: 1, remaining: 0, offline: false });
    expect(posts).toBe(1); // NOT double-posted
  });
});
