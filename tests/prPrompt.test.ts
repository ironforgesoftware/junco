/**
 * Tests for src/prPrompt.ts — buildPromptWithRepoContext.
 * Written FIRST (TDD). These fail until prPrompt.ts is implemented.
 *
 * Port of worker.py build_prompt_with_repo_context (2084-2126) and
 * _build_amend_preamble (2129-2154).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { buildPromptWithRepoContext } from "../src/prPrompt.js";
import type { RepoContext } from "../src/repoContext.js";
import type { AmendTarget } from "../src/repo.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRESH_CTX: RepoContext = {
  repo: "/tmp/myrepo",
  baseBranch: "main",
  branchName: "junco/T42-add-feature",
  draft: false,
  prTitle: null,
  labels: [],
  reviewers: [],
  amendsPr: null,
  pushRemote: "origin",
  forkNwo: null,
};

const AMEND_CTX: RepoContext = {
  repo: "/tmp/myrepo",
  baseBranch: "main",
  branchName: "junco/T10-existing-feature",
  draft: false,
  prTitle: null,
  labels: [],
  reviewers: [],
  amendsPr: 99,
  pushRemote: "origin",
  forkNwo: null,
};

const AMEND_TARGET: AmendTarget = {
  prNumber: 99,
  prUrl: "https://github.com/acme/myrepo/pull/99",
  headRef: "junco/T10-existing-feature",
  baseRef: "main",
  isDraft: false,
};

const TASK = { id: "T42", body: "## Task\n\nDo the thing.\n" };
const WT_PATH = "/Users/ci/worktrees/T42";
const NWO = "acme/myrepo";

// ---------------------------------------------------------------------------
// Fresh ticket — default opts (commitLeftoversEnabled: false)
// ---------------------------------------------------------------------------

describe("buildPromptWithRepoContext — fresh ticket (Pi-strict default)", () => {
  let output: string;

  beforeEach(() => {
    output = buildPromptWithRepoContext(TASK, FRESH_CTX, WT_PATH, NWO, {});
  });

  it("contains the worktree path", () => {
    expect(output).toContain(WT_PATH);
  });

  it("contains the branch name", () => {
    expect(output).toContain(FRESH_CTX.branchName);
  });

  it("contains the base branch", () => {
    expect(output).toContain(FRESH_CTX.baseBranch);
  });

  it("contains the repo nwo", () => {
    expect(output).toContain(NWO);
  });

  it("contains the Commit rules section heading", () => {
    expect(output).toContain("## Commit rules");
  });

  it("contains the Working discipline section heading", () => {
    expect(output).toContain("## Working discipline");
  });

  it("contains the Repo context section heading", () => {
    expect(output).toContain("## Repo context (worker-provided)");
  });

  it("ends with the task body (after separator)", () => {
    expect(output).toContain("---\n\n" + TASK.body);
    expect(output.endsWith(TASK.body)).toBe(true);
  });

  it("Pi-strict: contains 'must commit your work yourself' wording", () => {
    expect(output).toContain("You must commit your work yourself.");
  });

  it("Pi-strict: does NOT contain 'sweep' wording", () => {
    expect(output).not.toContain("Junco will sweep any uncommitted work");
  });
});

// ---------------------------------------------------------------------------
// Fresh ticket — commitLeftoversEnabled: false (explicit)
// ---------------------------------------------------------------------------

describe("buildPromptWithRepoContext — fresh ticket, commitLeftoversEnabled: false (explicit)", () => {
  it("contains the strict 'must commit' wording", () => {
    const out = buildPromptWithRepoContext(TASK, FRESH_CTX, WT_PATH, NWO, {
      commitLeftoversEnabled: false,
    });
    expect(out).toContain("You must commit your work yourself.");
    expect(out).not.toContain("Junco will sweep any uncommitted work");
  });
});

// ---------------------------------------------------------------------------
// Fresh ticket — commitLeftoversEnabled: true (legacy/omp mode)
// ---------------------------------------------------------------------------

describe("buildPromptWithRepoContext — fresh ticket, commitLeftoversEnabled: true", () => {
  it("contains the sweep wording", () => {
    const out = buildPromptWithRepoContext(TASK, FRESH_CTX, WT_PATH, NWO, {
      commitLeftoversEnabled: true,
    });
    expect(out).toContain("Junco will sweep any uncommitted work");
  });

  it("does NOT contain the strict 'must commit' wording", () => {
    const out = buildPromptWithRepoContext(TASK, FRESH_CTX, WT_PATH, NWO, {
      commitLeftoversEnabled: true,
    });
    expect(out).not.toContain("You must commit your work yourself.");
  });
});

// ---------------------------------------------------------------------------
// Fresh ticket — rule 4 references the branch
// ---------------------------------------------------------------------------

describe("buildPromptWithRepoContext — fresh ticket, rule 4", () => {
  it("rule 4 contains the branch name (stay on branch)", () => {
    const out = buildPromptWithRepoContext(TASK, FRESH_CTX, WT_PATH, NWO, {});
    expect(out).toContain(`Stay on ${FRESH_CTX.branchName}`);
  });
});

// ---------------------------------------------------------------------------
// Fresh ticket — working discipline rules present
// ---------------------------------------------------------------------------

describe("buildPromptWithRepoContext — fresh ticket, working discipline rules", () => {
  let output: string;

  beforeEach(() => {
    output = buildPromptWithRepoContext(TASK, FRESH_CTX, WT_PATH, NWO, {});
  });

  it("rule 5: mentions todo_write once at the very start", () => {
    expect(output).toContain("todo_write");
    expect(output).toContain("phases:");
  });

  it("rule 6: mentions 'unchanged' result signal", () => {
    expect(output).toContain("`unchanged`");
  });

  it("rule 7: mentions not to verify git commit via log/status/diff", () => {
    expect(output).toContain("git log");
    expect(output).toContain("git status");
  });

  it("rule 8: mentions not running the Verification block", () => {
    expect(output).toContain("## Verification");
  });

  it("rule 10: mentions loop guards", () => {
    expect(output).toContain("loop guards");
  });
});

// ---------------------------------------------------------------------------
// Amend ticket
// ---------------------------------------------------------------------------

describe("buildPromptWithRepoContext — amend ticket", () => {
  let output: string;

  beforeEach(() => {
    output = buildPromptWithRepoContext(
      { id: "T10-amend", body: "## Amend instructions\n\nFix the thing.\n" },
      AMEND_CTX,
      WT_PATH,
      NWO,
      { amendTarget: AMEND_TARGET },
    );
  });

  it("contains the AMEND MODE heading", () => {
    expect(output).toContain("## Repo context (worker-provided) — AMEND MODE");
  });

  it("contains the PR number", () => {
    expect(output).toContain("#99");
  });

  it("contains the PR URL", () => {
    expect(output).toContain(AMEND_TARGET.prUrl);
  });

  it("contains the existing branch name", () => {
    expect(output).toContain(AMEND_CTX.branchName);
  });

  it("contains the worktree path", () => {
    expect(output).toContain(WT_PATH);
  });

  it("contains the nwo", () => {
    expect(output).toContain(NWO);
  });

  it("contains the Amendment rules section", () => {
    expect(output).toContain("## Amendment rules");
  });

  it("contains working discipline section", () => {
    expect(output).toContain("## Working discipline");
  });

  it("ends with the task body", () => {
    const body = "## Amend instructions\n\nFix the thing.\n";
    expect(output.endsWith(body)).toBe(true);
  });

  it("instructs 'add commits to the existing PR' (no amend/squash/rebase)", () => {
    expect(output).toContain("Add **new commits**");
  });

  it("mentions not to run Verification block", () => {
    expect(output).toContain("## Verification");
  });
});

// ---------------------------------------------------------------------------
// Amend ticket — isAmend(ctx) is true even without amendTarget passed
// but we should default to fresh path when amendTarget is null/undefined
// ---------------------------------------------------------------------------

describe("buildPromptWithRepoContext — isAmend ctx but no amendTarget => fresh path", () => {
  it("uses fresh preamble when amendTarget is null", () => {
    const out = buildPromptWithRepoContext(TASK, AMEND_CTX, WT_PATH, NWO, {
      amendTarget: null,
    });
    // Should use fresh path (no AMEND MODE heading)
    expect(out).not.toContain("AMEND MODE");
    expect(out).toContain("## Commit rules");
  });
});
