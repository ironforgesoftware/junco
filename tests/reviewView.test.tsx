import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { ReviewView, type ReviewState } from "../src/tui/components/ReviewView.js";
import type { PendingComment } from "../src/commentReview.js";
import type { PendingDraft } from "../src/chat/draftStore.js";

const BATCH = {
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
      title: "SQL injection",
      description: "",
      references: [],
    },
    {
      fingerprint: "f2",
      kind: "code",
      severity: "low",
      ruleId: "R",
      title: "stale dep",
      description: "",
      references: [],
    },
  ],
};

const NOW = new Date("2026-07-09T02:00:00.000Z");

const FILED_BATCH = {
  ...BATCH,
  filed: {
    f1: {
      at: "2026-07-09T00:00:00.000Z",
      how: "created" as const,
      url: "https://github.com/o/r/issues/1",
    },
  },
};

const DRAFT: PendingComment = {
  id: "analyze-o-r-5",
  nwo: "o/r",
  issue: 5,
  issueTitle: "Broken build",
  external: false,
  repoPath: "/x",
  createdAt: "2026-07-09T00:00:00.000Z",
  draft: "This is the analysis.\nSecond line.",
  footer: true,
};

// 10 distinct lines, no footer — long enough that the preview window (rows -
// 2 = 6 lines at height 10) can't show it all, so scrolling is observable.
const LONG_DRAFT: PendingComment = {
  ...DRAFT,
  footer: false,
  draft: Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n"),
};

// A parked chat draft (spec 2026-09-01 §6.2) — the review view's third list.
const CHAT_DRAFT: PendingDraft = {
  id: "acme__api-20260901-1",
  key: "acme/api",
  slug: "acme__api",
  kind: "ticket",
  files: [
    {
      name: "add-cache.md",
      content: "---\nid: add-cache\n---\nCache the index.",
      lint: [],
      route: {
        destination: "inbox",
        reasons: ["repo is not bridge-watched"],
        watchedNwo: null,
        carriedTimeout: 45,
        discarded: ["tools"],
      },
      droppedKeys: ["tools", "network"],
    },
  ],
  cwd: "/repos/acme/api",
  nwo: "acme/api",
  createdAt: "2026-07-09T00:00:00.000Z",
  lintFailed: false,
  blocked: null,
  routeOverride: "auto",
  commandArgs: null,
};

function state(over: Partial<ReviewState>): ReviewState {
  return {
    loading: false,
    error: null,
    batches: [BATCH as never],
    drafts: [],
    chatDrafts: [],
    cursor: 0,
    open: null,
    ...over,
  };
}

describe("ReviewView", () => {
  it("batch-list mode lists batches with nwo + count", () => {
    const { lastFrame } = render(
      <ReviewView state={state({})} scroll={0} height={20} focused now={NOW} />,
    );
    expect(lastFrame()).toContain("o/r");
    expect(lastFrame()).toContain("2"); // finding count
  });
  it("checklist mode shows findings with check glyphs and severity", () => {
    const s = state({
      open: { kind: "batch", batchIdx: 0, findingCursor: 0, checked: new Set(["f1"]) },
    });
    const frame =
      render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toContain("SQL injection");
    expect(frame).toContain("stale dep");
    expect(frame).toMatch(/\[x\].*SQL injection/); // f1 checked
    expect(frame).toMatch(/\[ \].*stale dep/); // f2 unchecked
  });
  it("empty state renders a hint", () => {
    expect(
      render(
        <ReviewView
          state={state({ batches: [], drafts: [], cursor: 0 })}
          scroll={0}
          height={20}
          focused
          now={NOW}
        />,
      ).lastFrame(),
    ).toContain("no pending");
  });

  it("list mode renders a draft row with a comment badge and nwo#issue", () => {
    const s = state({ batches: [], drafts: [DRAFT], cursor: 0 });
    const frame =
      render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toContain("o/r#5");
    expect(frame).toContain("comment"); // badge column
    expect(frame).toContain("This is the analysis."); // first non-empty draft line
  });

  it("draft-row comment badge is right-aligned, after the flexing preview text — matching the batch rows' far-right count column", () => {
    const s = state({ batches: [], drafts: [DRAFT], cursor: 0 });
    const frame =
      render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    const previewIdx = frame.indexOf("This is the analysis.");
    const badgeIdx = frame.indexOf("comment");
    expect(previewIdx).toBeGreaterThan(-1);
    expect(badgeIdx).toBeGreaterThan(previewIdx);
  });

  it("draft preview renders the header, body, and dimmed footer line when footer:true", () => {
    const s = state({
      batches: [],
      drafts: [DRAFT],
      cursor: 0,
      open: { kind: "draft", draftIdx: 0 },
    });
    const frame =
      render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toContain("o/r#5");
    expect(frame).toContain("Broken build"); // issueTitle in header
    expect(frame).toContain("owned"); // external|owned in header
    expect(frame).toContain("This is the analysis.");
    expect(frame).toContain("Second line.");
    expect(frame).toContain("Analysis drafted with"); // ANALYSIS_FOOTER
    expect(frame).toContain("post"); // hint row
  });

  it("draft preview scroll is top-anchored: one keypress (scroll+1) moves the window by exactly one line", () => {
    const base = { batches: [], drafts: [LONG_DRAFT], cursor: 0 };
    const atZero =
      render(
        <ReviewView
          state={state({ ...base, open: { kind: "draft", draftIdx: 0 } })}
          scroll={0}
          height={10}
          focused
          now={NOW}
        />,
      ).lastFrame() ?? "";
    const atOne =
      render(
        <ReviewView
          state={state({ ...base, open: { kind: "draft", draftIdx: 0 } })}
          scroll={1}
          height={10}
          focused
          now={NOW}
        />,
      ).lastFrame() ?? "";
    // height=10 → rows=8, no footer → bodyRows=6: scroll=0 shows line-0..line-5.
    expect(atZero).toContain("line-0");
    expect(atZero).not.toContain("line-6");
    // A cursor-centering window would leave this unchanged (dead-zone) until
    // scroll passed rows/2; top-anchored moves it after a single keypress.
    expect(atOne).not.toContain("line-0");
    expect(atOne).toContain("line-6");
  });

  it("a past-the-end scroll clamps to the bottom instead of blanking the pane", () => {
    // LONG_DRAFT is 10 lines (line-0..line-9), footer:false. height 10 → rows 8 →
    // bodyRows 6 → max 4, so the bottom window is line-4..line-9.
    const base = { batches: [], drafts: [LONG_DRAFT], cursor: 0 };
    const f = render(
      <ReviewView
        state={state({ ...base, open: { kind: "draft", draftIdx: 0 } })}
        scroll={999}
        height={10}
        focused
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("line-9"); // the last line is on screen…
    expect(f).not.toContain("line-0"); // …and the window stopped at the bottom
  });

  it("draft preview omits the footer line when footer:false", () => {
    const s = state({
      batches: [],
      drafts: [{ ...DRAFT, footer: false }],
      cursor: 0,
      open: { kind: "draft", draftIdx: 0 },
    });
    const frame =
      render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toContain("This is the analysis.");
    expect(frame).not.toContain("Analysis drafted with");
  });

  it("combined empty state hints at drafting a comment", () => {
    const frame =
      render(
        <ReviewView
          state={state({ batches: [], drafts: [], cursor: 0 })}
          scroll={0}
          height={20}
          focused
          now={NOW}
        />,
      ).lastFrame() ?? "";
    expect(frame).toContain("draft a comment");
  });

  it("list row shows the batch age and a filed n/m chip when accounting exists", () => {
    const s = state({ batches: [FILED_BATCH as never] });
    const frame =
      render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toContain("2h ago"); // createdAt age
    expect(frame).toContain("filed 1/2"); // replaces the bare count column
  });

  it("checklist: a filed, unchecked row renders ✓ + how + age instead of an empty checkbox", () => {
    const s = state({
      batches: [FILED_BATCH as never],
      open: { kind: "batch", batchIdx: 0, findingCursor: 0, checked: new Set<string>() },
    });
    const frame =
      render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toMatch(/✓.*SQL injection.*created 2h ago/);
    expect(frame).toMatch(/\[ \].*stale dep/); // unfiled row keeps its checkbox
    expect(frame).toContain("1 filed"); // header accounting
  });

  it("checklist: a filed row that is re-checked shows [x] and keeps its accounting note", () => {
    const s = state({
      batches: [FILED_BATCH as never],
      open: { kind: "batch", batchIdx: 0, findingCursor: 0, checked: new Set(["f1"]) },
    });
    const frame =
      render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toMatch(/\[x\].*SQL injection.*created 2h ago/);
  });

  it("checklist: how 'deduped' renders as 'dup'", () => {
    const s = state({
      batches: [
        {
          ...BATCH,
          filed: { f1: { at: "2026-07-09T01:00:00.000Z", how: "deduped" as const } },
        } as never,
      ],
      open: { kind: "batch", batchIdx: 0, findingCursor: 0, checked: new Set<string>() },
    });
    const frame =
      render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toMatch(/dup 1h ago/);
  });
});

describe("ReviewView — chat drafts (spec 2026-09-01 §8.6)", () => {
  it("lists a chat draft row after the batches and comment drafts, with its route verdict", () => {
    const s = state({ batches: [BATCH as never], drafts: [DRAFT], chatDrafts: [CHAT_DRAFT] });
    const frame =
      render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(lines[0]).toContain("o/r"); // batch first
    expect(lines[1]).toContain("o/r#5"); // then the comment draft
    expect(lines[2]).toContain("acme/api");
    expect(lines[2]).toContain("ticket");
    expect(lines[2]).toContain("add-cache");
    expect(lines[2]).toContain("inbox"); // the route verdict, not a badge
  });

  it("a lintFailed row shows lint ✗ in place of the verdict; an override shows itself", () => {
    const failed = { ...CHAT_DRAFT, lintFailed: true };
    const f1 =
      render(
        <ReviewView
          state={state({ batches: [], chatDrafts: [failed] })}
          scroll={0}
          height={20}
          focused
          now={NOW}
        />,
      ).lastFrame() ?? "";
    expect(f1).toContain("lint ✗");
    expect(f1).not.toContain("inbox");

    const forced = { ...CHAT_DRAFT, routeOverride: "issue" as const };
    const f2 =
      render(
        <ReviewView
          state={state({ batches: [], chatDrafts: [forced] })}
          scroll={0}
          height={20}
          focused
          now={NOW}
        />,
      ).lastFrame() ?? "";
    expect(f2).toContain("issue!");
  });

  it("a command draft's row reads 'command' (audit/investigate never route)", () => {
    const audit: PendingDraft = {
      ...CHAT_DRAFT,
      kind: "audit",
      commandArgs: ["audit", "acme/api"],
      files: [{ name: "audit.md", content: "", lint: [], route: null, droppedKeys: [] }],
    };
    const frame =
      render(
        <ReviewView
          state={state({ batches: [], chatDrafts: [audit] })}
          scroll={0}
          height={20}
          focused
          now={NOW}
        />,
      ).lastFrame() ?? "";
    expect(frame).toContain("command");
  });

  it("preview mode renders the header, verdict, dropped keys, lint rows, content and footer", () => {
    const withLint: PendingDraft = {
      ...CHAT_DRAFT,
      files: [
        {
          ...CHAT_DRAFT.files[0],
          lint: [{ rule: "no_repo", severity: "error", message: "repo: is required" }],
        },
      ],
    };
    const s = state({ batches: [], chatDrafts: [withLint], open: { kind: "chatDraft", idx: 0 } });
    const frame =
      render(<ReviewView state={s} scroll={0} height={30} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toContain("acme/api");
    expect(frame).toContain("· ticket · route: inbox");
    expect(frame).toContain("── add-cache.md ──");
    expect(frame).toContain("destination: inbox");
    expect(frame).toContain("reason: repo is not bridge-watched");
    expect(frame).toContain("carried: timeout_minutes=45");
    expect(frame).toContain("would discard: tools");
    expect(frame).toContain("dropped: tools, network");
    expect(frame).toContain("[error] no_repo: repo: is required");
    expect(frame).toContain("Cache the index.");
    expect(frame).toContain("s submit · e edit · r route · D discard · esc back");
  });

  it("preview mode omits the verdict block for a command draft, which ignores an override", () => {
    const audit: PendingDraft = {
      ...CHAT_DRAFT,
      kind: "audit",
      routeOverride: "issue",
      commandArgs: ["audit", "acme/api"],
      files: [{ name: "audit.md", content: "sweep it", lint: [], route: null, droppedKeys: [] }],
    };
    const s = state({ batches: [], chatDrafts: [audit], open: { kind: "chatDraft", idx: 0 } });
    const frame =
      render(<ReviewView state={s} scroll={0} height={30} focused now={NOW} />).lastFrame() ?? "";
    // routeOverride: "issue" on an audit is meaningless — submitArgv runs the
    // parked commandArgs — so the header keeps saying "command".
    expect(frame).toContain("· audit · route: command");
    expect(frame).toContain("sweep it");
    expect(frame).not.toContain("destination:");
  });

  it("preview scroll is top-anchored, and a vanished draft says so instead of blanking", () => {
    const long: PendingDraft = {
      ...CHAT_DRAFT,
      files: [
        {
          ...CHAT_DRAFT.files[0],
          content: Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n"),
        },
      ],
    };
    const s = state({ batches: [], chatDrafts: [long], open: { kind: "chatDraft", idx: 0 } });
    const first =
      render(<ReviewView state={s} scroll={0} height={10} focused now={NOW} />).lastFrame() ?? "";
    const scrolled =
      render(<ReviewView state={s} scroll={1} height={10} focused now={NOW} />).lastFrame() ?? "";
    expect(first).not.toBe(scrolled);
    const gone = state({ batches: [], chatDrafts: [], open: { kind: "chatDraft", idx: 0 } });
    expect(
      render(<ReviewView state={gone} scroll={0} height={10} focused now={NOW} />).lastFrame(),
    ).toContain("draft gone");
  });
});

describe("trailing columns never wrap under long titles (#233)", () => {
  const LONG_TITLE =
    "an extremely long finding title that should truncate rather than push the trailing " +
    "accounting columns onto a second visual line no matter how verbose the rule happens to be";
  const LONG_BATCH = {
    ...FILED_BATCH,
    nwo: "very-long-organization-name/an-equally-long-repository-name-that-flexes",
    findings: [{ ...FILED_BATCH.findings[0], title: LONG_TITLE }],
  };

  it("checklist row: the filed accounting stays on the finding's own line", () => {
    const frame = render(
      <ReviewView
        state={state({
          batches: [LONG_BATCH as never],
          open: { kind: "batch", batchIdx: 0, findingCursor: 0, checked: new Set() },
        })}
        scroll={0}
        height={14}
        focused
        now={NOW}
      />,
    ).lastFrame()!;
    const lines = frame.split("\n");
    // The severity cell and the accounting share ONE line — the long title
    // truncates instead of pushing `created <age>` onto a wrapped second line.
    expect(lines.some((l) => l.includes("high") && l.includes("created"))).toBe(true);
    // No orphaned wrap tail: any line mentioning the age also carries the verb.
    for (const l of lines) {
      if (l.trim().endsWith("ago") || l.trim() === "ago") {
        expect(l).toContain("created");
      }
    }
  });

  it("list row: age + ownership + count stay on the batch's own line under a long nwo", () => {
    const frame = render(
      <ReviewView
        state={state({ batches: [LONG_BATCH as never], open: null })}
        scroll={0}
        height={14}
        focused
        now={NOW}
      />,
    ).lastFrame()!;
    const lines = frame.split("\n");
    const rowLine = lines.find((l) => l.includes("very-long-organization-name"));
    expect(rowLine).toBeDefined();
    // The trailing columns render on the SAME line, ungarbled (space-separated
    // — the "external3" merge was the pre-existing symptom).
    expect(rowLine).toContain("external");
    expect(rowLine).toContain("filed 1/1");
    expect(rowLine).not.toContain("external filed".replace(" ", "")); // no glued columns
  });
});
