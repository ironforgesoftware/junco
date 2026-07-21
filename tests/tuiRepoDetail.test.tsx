import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { RepoDetail, repoQueueRows } from "../src/tui/components/RepoDetail.js";
import type { UnifiedRepo } from "../src/tui/railModel.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";

const repo: UnifiedRepo = {
  key: "/dev/scratch",
  nwo: null,
  path: "/dev/scratch",
  fromConfig: false,
  external: false,
  source: "clone",
  watched: false,
  git: { branch: "main", headSha: "a1b2c3d4e5f6", dirty: true, originUrl: null, error: null },
  clones: ["/data/clones/x"],
};
const NOW = new Date("2026-07-20T12:00:00Z");

const emptyQueue: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  taskTimeoutSeconds: null,
  running: [],
  waiting: [],
  recent: [],
  error: null,
  outboxDepth: 0,
  stats: null,
};

describe("RepoDetail", () => {
  it("renders identity, git state, clones, worktrees, and recent tickets", () => {
    const { lastFrame } = render(
      <RepoDetail
        repo={repo}
        worktrees={[
          {
            path: "/wt/s-fix",
            repoPath: "/dev/scratch",
            repoNwo: null,
            slug: "s-fix",
            kind: "stale",
            headSha: "beefcafe0000",
            ageSeconds: 7980,
            error: null,
          },
        ]}
        queue={{
          ...emptyQueue,
          recent: [
            {
              id: "add-readme",
              github: null,
              status: "done",
              repoPath: "/dev/scratch",
              finishedAt: "2026-07-20T11:00:00Z",
              resultStatus: "done",
              durationSeconds: 60,
              prUrl: null,
            },
          ],
        }}
        scroll={0}
        height={24}
        focused
        now={NOW}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("/dev/scratch");
    expect(f).toContain("(clone)");
    expect(f).toContain("main@a1b2c3d");
    expect(f).toContain("✎");
    expect(f).toContain("s-fix");
    expect(f).toContain("add-readme");
    expect(f).toContain("clones/x"); // extra clone line (start-truncated path tail)
  });

  it("filters queue rows by resolved repoPath", () => {
    const rows = repoQueueRows(
      {
        ...emptyQueue,
        waiting: [
          {
            id: "mine",
            github: null,
            kind: "pr",
            priority: "normal",
            retryCount: 0,
            notBefore: null,
            deferred: false,
            queuedAt: null,
            repoPath: "/dev/scratch",
          },
          {
            id: "other",
            github: null,
            kind: "pr",
            priority: "normal",
            retryCount: 0,
            notBefore: null,
            deferred: false,
            queuedAt: null,
            repoPath: "/elsewhere",
          },
          {
            id: "no-repo",
            github: null,
            kind: "ask",
            priority: "normal",
            retryCount: 0,
            notBefore: null,
            deferred: false,
            queuedAt: null,
            repoPath: null,
          },
        ],
      },
      "/dev/scratch",
    );
    expect(rows.waiting.map((w) => w.id)).toEqual(["mine"]);
  });

  it("null enrichment renders loading, not a crash", () => {
    const { lastFrame } = render(
      <RepoDetail
        repo={{ ...repo, git: null, clones: [] }}
        worktrees={null}
        queue={null}
        scroll={0}
        height={12}
        focused={false}
        now={NOW}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("loading");
    expect(f).toContain("none"); // empty worktrees + tickets sections
  });

  it("git error renders the error line instead of branch state", () => {
    const { lastFrame } = render(
      <RepoDetail
        repo={{
          ...repo,
          clones: [],
          git: { branch: null, headSha: null, dirty: null, originUrl: null, error: "boom" },
        }}
        worktrees={[]}
        queue={emptyQueue}
        scroll={0}
        height={16}
        focused
        now={NOW}
      />,
    );
    expect(lastFrame()).toContain("boom");
  });
});
