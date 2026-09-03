/**
 * The footer's row-1 target label (spec 2026-09-02 §3.1/§6, Ruling R12): what
 * the actions row's verbs act on. App used to pass `crumbs.at(-1)`, which is
 * the HEADER's vocabulary — the issue list read `acme/api` instead of
 * `issue #46`, pane 3 read `acme/api` instead of `PR #12`, and a local-only
 * checkout read `no repo` beside a live chat pill. Every case below is one
 * row of that table.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useFooterTarget, type FooterTargetSources } from "../src/tui/hooks/useFooterTarget.js";
import type { View } from "../src/tui/App.js";
import type { BodyKind, UnifiedRepo } from "../src/tui/railModel.js";
import type { TranscriptState } from "../src/tui/hooks/useTranscript.js";
import type { CmdState } from "../src/tui/hooks/useCmdOutput.js";
import type { ChatState } from "../src/tui/hooks/useChat.js";
import { makeDashIssue, makeDashPr } from "./helpers/dashFixtures.js";

const WATCHED: UnifiedRepo = {
  key: "acme/api",
  nwo: "acme/api",
  path: "/c/api",
  fromConfig: true,
  external: false,
  source: "config",
  watched: true,
  git: null,
  clones: [],
};
/** A discovered checkout with no GitHub side — `nwo` is null, which is what
 * made the old crumb tail fall through to "no repo". */
const LOCAL_ONLY: UnifiedRepo = {
  ...WATCHED,
  key: "/home/me/dev/scratchpad",
  nwo: null,
  path: "/home/me/dev/scratchpad",
  fromConfig: false,
  source: "clone",
  watched: false,
};

const CMD: CmdState = {
  title: "junco status",
  running: false,
  output: "",
  exitCode: 0,
  timedOut: false,
  name: "status",
  extraArgs: [],
  token: 1,
};
const TRANSCRIPT = { id: "gh-acme-api-46" } as unknown as TranscriptState;
const CHAT = { key: "acme/api" } as unknown as ChatState;

const EMPTY: FooterTargetSources = {
  currentIssue: undefined,
  selectedPane3Pr: undefined,
  selectedPr: undefined,
  detail: null,
  prDetail: null,
  transcript: null,
  chatState: null,
  repoDetailTarget: null,
  cmd: null,
};

function Probe({
  view,
  pane,
  body,
  sources,
}: {
  view: View;
  pane: 1 | 2 | 3;
  body: BodyKind | null;
  sources: FooterTargetSources;
}): React.JSX.Element {
  return <Text>[{useFooterTarget(view, pane, body, sources)}]</Text>;
}

const target = (
  view: View,
  pane: 1 | 2 | 3,
  body: BodyKind | null,
  over: Partial<FooterTargetSources> = {},
): string => {
  const f = render(
    <Probe view={view} pane={pane} body={body} sources={{ ...EMPTY, ...over }} />,
  ).lastFrame()!;
  return f.slice(f.indexOf("[") + 1, f.lastIndexOf("]"));
};

const ISSUES: BodyKind = { kind: "issues", nwo: "acme/api" };
const REPO_DETAIL: BodyKind = { kind: "repoDetail", repo: LOCAL_ONLY };
const SECTION: BodyKind = { kind: "section", section: "worktrees" };

describe("useFooterTarget — the main view (spec §3.1)", () => {
  it("rail repo row: the nwo", () => {
    expect(target("main", 1, ISSUES)).toBe("acme/api");
  });
  it("rail repo row, local-only checkout: the path's basename, never 'no repo'", () => {
    expect(target("main", 1, REPO_DETAIL)).toBe("scratchpad");
  });
  it("rail system row: the section name", () => {
    expect(target("main", 1, SECTION)).toBe("worktrees");
  });
  it("issues body (pane 2) with an issue selected: issue #N", () => {
    expect(target("main", 2, ISSUES, { currentIssue: makeDashIssue({ number: 46 }) })).toBe(
      "issue #46",
    );
  });
  it("issues body (pane 2) with no issue selected falls back to the repo", () => {
    expect(target("main", 2, ISSUES)).toBe("acme/api");
  });
  it("pane 3 with a PR selected: PR #N", () => {
    expect(target("main", 3, ISSUES, { selectedPane3Pr: makeDashPr({ number: 12 }) })).toBe(
      "PR #12",
    );
  });
  it("pane 3 with an empty PR list falls back to the repo", () => {
    expect(target("main", 3, ISSUES)).toBe("acme/api");
  });
  it("repoDetail body (pane 2) with a watched repo: the nwo", () => {
    expect(target("main", 2, { kind: "repoDetail", repo: WATCHED })).toBe("acme/api");
  });
  it("repoDetail body (pane 2), local-only: the basename", () => {
    expect(target("main", 2, REPO_DETAIL)).toBe("scratchpad");
  });
  it("a system BODY (pane 2): the section name, and an issue in hand never leaks in", () => {
    expect(target("main", 2, SECTION, { currentIssue: makeDashIssue({ number: 46 }) })).toBe(
      "worktrees",
    );
  });
  it("no rail row at all (empty watchlist): no repo", () => {
    expect(target("main", 1, null)).toBe("no repo");
  });
});

describe("useFooterTarget — overlays (spec §3.1)", () => {
  it("issue detail: #N", () => {
    expect(
      target("detail", 2, ISSUES, {
        detail: {
          issue: makeDashIssue({ number: 46 }),
          nwo: "acme/api",
          body: null,
          planComment: null,
          loading: false,
        },
      }),
    ).toBe("#46");
  });
  it("PR detail: PR #N", () => {
    expect(
      target("prDetail", 2, ISSUES, {
        prDetail: { pr: makeDashPr({ number: 12 }), from: "main" },
      }),
    ).toBe("PR #12");
  });
  it("PRs list: PR #N of the selected row, or the view's own name when empty", () => {
    expect(target("prs", 2, ISSUES, { selectedPr: makeDashPr({ number: 7 }) })).toBe("PR #7");
    expect(target("prs", 2, ISSUES)).toBe("pull requests");
  });
  it("transcript: the ticket id", () => {
    expect(target("transcript", 2, ISSUES, { transcript: TRANSCRIPT })).toBe("gh-acme-api-46");
  });
  it("review: review", () => {
    expect(target("review", 2, ISSUES)).toBe("review");
  });
  it("command output: the command's title", () => {
    expect(target("cmdOutput", 2, ISSUES, { cmd: CMD })).toBe("junco status");
  });
  it("chat: chat · <session key>", () => {
    expect(target("chat", 2, ISSUES, { chatState: CHAT })).toBe("chat · acme/api");
  });
  it("repo detail overlay: the nwo, or the basename for a local-only checkout", () => {
    expect(target("repoDetail", 2, ISSUES, { repoDetailTarget: WATCHED })).toBe("acme/api");
    expect(target("repoDetail", 2, ISSUES, { repoDetailTarget: LOCAL_ONLY })).toBe("scratchpad");
  });
  it("the chromeless views name themselves", () => {
    expect(target("palette", 2, ISSUES)).toBe("palette");
    expect(target("config", 2, ISSUES)).toBe("config");
    expect(target("addRepo", 2, ISSUES)).toBe("add repo");
    expect(target("help", 2, ISSUES)).toBe("help");
  });
  it("an overlay whose state has not landed yet names the view, never the rail", () => {
    expect(target("detail", 2, ISSUES)).toBe("issue");
    expect(target("prDetail", 2, ISSUES)).toBe("pull request");
    expect(target("transcript", 2, ISSUES)).toBe("transcript");
    expect(target("cmdOutput", 2, ISSUES)).toBe("command");
    expect(target("chat", 2, ISSUES)).toBe("chat");
    expect(target("repoDetail", 2, ISSUES)).toBe("repo");
  });
});
