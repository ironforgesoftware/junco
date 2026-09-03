/**
 * The footer's two rows as the REAL App renders them, at the terminal width
 * the dashboard actually runs at (spec 2026-09-02 §3/§4).
 *
 * Why `renderWide` rather than ink-testing-library's `render`: its fake Stdout
 * hardcodes `columns = 100`, and everything the footer right-pins lands past
 * that (see tests/helpers/renderWide.tsx). These assertions read the whole
 * bar, pinned chips included, so they must render into a 120-column buffer —
 * the same width `makeAppProps`' `sizeOverride` tells App it has.
 *
 * What this pins that the pure model cannot: that App feeds the model the
 * right TARGET (Ruling R12 — `issue #46`, `PR #12`, a local checkout's
 * basename) and the right CONTEXT (Ruling R11 — a system row on the rail is
 * not a repo row). Keystroke discipline per CLAUDE.md: every write is gated on
 * an `until` proving the previous one committed.
 */
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { App } from "../src/tui/App.js";
import { MouseProvider } from "../src/tui/MouseProvider.js";
import { makeAppProps, okv, stubClient, HEAVY, WIDE_COLS_TEST } from "./helpers/localFixtures.js";
import { makeDashPr } from "./helpers/dashFixtures.js";
import { renderWide, cleanupWide, type WideInstance } from "./helpers/renderWide.js";
import { until } from "./helpers/until.js";
import type { AppProps } from "../src/tui/App.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { LocalHeavy } from "../src/tui/localSnapshot.js";

afterEach(cleanupWide);

/** One unwatched checkout with no GitHub side — the rail's local-only row.
 * `nwo: null` is exactly what used to make the target label say "no repo"
 * while the row still rendered a live chat pill. */
const WITH_LOCAL_ONLY: LocalHeavy = {
  ...HEAVY,
  repos: [
    ...HEAVY.repos,
    {
      nwo: null,
      path: "/c/scratchpad",
      source: "clone",
      originUrl: null,
      forkUrl: null,
      githubUrl: null,
      branch: "main",
      headSha: "aaa1111",
      dirty: false,
      error: null,
    },
  ],
};

const PR_12 = makeDashPr({ number: 12, nwo: "acme/api" });
const client: DashboardClient = {
  ...stubClient,
  listPrs: async (nwo) => okv({ prs: nwo === "acme/api" ? [PR_12] : [], staleAt: null }),
};

function mount(over: Partial<AppProps> = {}): WideInstance {
  const props = makeAppProps({ client, localHeavyFn: async () => WITH_LOCAL_ONLY, ...over });
  return renderWide(
    <MouseProvider>
      <App {...props} />
    </MouseProvider>,
    WIDE_COLS_TEST,
  );
}

const frame = (r: WideInstance): string => r.lastFrame() ?? "";
/** The last two lines of the frame ARE the footer (`CHROME_ROWS` = header + 2). */
const footer = (r: WideInstance): { actions: string; navigate: string } => {
  const lines = frame(r).split("\n");
  return { actions: lines[lines.length - 2] ?? "", navigate: lines[lines.length - 1] ?? "" };
};
/** The chat pill is the only chip drawn as ` c hat ` — frames carry no ANSI,
 * so the pill's PRESENCE is read as its padded label, exactly where §3.1 puts
 * it: immediately after the target slot. */
const hasPill = (actions: string): boolean => / chat {2}/.test(actions);
const LOADED = "First issue";

describe("the App footer at 120 columns (spec §3/§4, Rulings R11/R12)", () => {
  it("rail, repo row: the nwo, the pill, the rail verbs │ the go-globals", async () => {
    const r = mount();
    await until(() => frame(r).includes(LOADED));
    const f = footer(r);
    expect(f.actions).toContain("acme/api");
    expect(hasPill(f.actions)).toBe(true);
    for (const verb of ["audit", "browser", "refresh", "add repo", "Unwatch"]) {
      expect(f.actions, verb).toContain(verb);
    }
    expect(f.actions).toMatch(/│\s+queue\s+review\s+PRs/);
    expect(f.navigate).toContain("? help");
    expect(f.navigate).toContain("quit");
  });

  it("rail, LOCAL-ONLY repo row: the checkout's basename, never 'no repo', with the pill (R12)", async () => {
    const r = mount();
    await until(() => frame(r).includes(LOADED));
    r.stdin.write("j");
    await until(() => footer(r).actions.includes("beta/two"));
    r.stdin.write("j"); // the unwatched /c/scratchpad row
    await until(() => footer(r).actions.includes("scratchpad"));
    const f = footer(r);
    expect(f.actions).not.toContain("no repo");
    expect(hasPill(f.actions)).toBe(true);
  });

  it("rail, SYSTEM row: that section's verbs against its own name — no pill, no repo verbs (R11)", async () => {
    const r = mount();
    await until(() => frame(r).includes(LOADED));
    // acme/api → beta/two → /c/scratchpad → queue (this suite's rail carries a
    // third repo row, so localFixtures' TO_QUEUE_ROW is one `j` short).
    r.stdin.write("j");
    await until(() => footer(r).actions.includes("beta/two"));
    r.stdin.write("j");
    await until(() => footer(r).actions.includes("scratchpad"));
    r.stdin.write("j");
    await until(() => footer(r).actions.trimStart().startsWith("queue"));
    const f = footer(r);
    expect(f.actions).toMatch(/retry\s+Delete\s+│\s+review\s+PRs/);
    expect(hasPill(f.actions)).toBe(false);
    for (const verb of ["audit", "browser", "refresh", "add repo", "Unwatch"]) {
      expect(f.actions, verb).not.toContain(verb);
    }
    // Spec §4: the main view pins [help, quit] on a system row too.
    expect(f.navigate).toContain("? help");
    expect(f.navigate).toContain("quit");
  });

  it("issue list (pane 2): the target is the ISSUE, not the repo (R12)", async () => {
    const r = mount();
    await until(() => frame(r).includes(LOADED));
    r.stdin.write("l");
    await until(() => footer(r).actions.includes("investigate"));
    const f = footer(r);
    expect(f.actions.trimStart().startsWith("issue #1")).toBe(true);
    expect(f.actions).not.toContain("acme/api");
    expect(hasPill(f.actions)).toBe(true);
  });

  it("PR monitor (pane 3): the target is the PR, not the repo (R12)", async () => {
    const r = mount();
    await until(() => frame(r).includes(LOADED));
    r.stdin.write("l");
    await until(() => footer(r).actions.includes("investigate"));
    r.stdin.write("l");
    await until(() => !footer(r).actions.includes("investigate"));
    const f = footer(r);
    expect(f.actions.trimStart().startsWith("PR #12")).toBe(true);
    expect(hasPill(f.actions)).toBe(true);
  });

  it("repo detail BODY: the checkout's name, the pill and its repo verbs (R11 + R12)", async () => {
    const r = mount();
    await until(() => frame(r).includes(LOADED));
    r.stdin.write("j");
    await until(() => footer(r).actions.includes("beta/two"));
    r.stdin.write("j");
    await until(() => footer(r).actions.includes("scratchpad"));
    r.stdin.write("l"); // into the repo-detail body
    await until(() => footer(r).navigate.includes("rail"));
    const f = footer(r);
    expect(f.actions).toContain("scratchpad");
    expect(hasPill(f.actions)).toBe(true);
    expect(f.actions).toMatch(/browser\s+refresh\s+audit\s+│\s+queue\s+review\s+PRs/);
  });

  it("issue detail overlay: #N, and the chat view: the bare session key (R12)", async () => {
    const r = mount();
    await until(() => frame(r).includes(LOADED));
    r.stdin.write("l");
    await until(() => footer(r).actions.includes("investigate"));
    r.stdin.write("\r");
    await until(() => footer(r).navigate.includes("back"));
    expect(footer(r).actions.trimStart().startsWith("#1")).toBe(true);
    r.stdin.write("c");
    // The chat view's label is the session key alone — the header crumb
    // already says "chat" (chat-scroll brief).
    await until(() => footer(r).actions.trimStart().startsWith("acme/api"));
    // The composer owns the keyboard, so row 2 lists only what still works
    // while typing: real keycaps, no prose reminder, nothing pinned.
    const nav = footer(r).navigate;
    expect(nav).toContain("⇞ ⇟");
    expect(nav).toContain("scroll");
    expect(nav).toContain("blur");
    expect(nav).not.toContain("esc, then");
    expect(nav).not.toContain("? help");
  });
});
