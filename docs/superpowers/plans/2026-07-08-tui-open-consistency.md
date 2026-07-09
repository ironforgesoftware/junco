# `o` Consistency + Clickable Detail Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uniform `o browser` hint label across all five dashboard contexts, and a clickable `↗` metadata line in the issue detail view and the fullscreen PR overlay.

**Architecture:** Label edits in `Chrome.tsx`/`HelpModal.tsx`/docs plus test re-anchoring; `hitTest.ts` extends its `view` union with `"detail" | "prDetail"` (only the `↗` line resolves — everything else `none`); `App.tsx` extracts the two snapshot-anchored browser-open callbacks and routes `linkLine` presses to them.

**Tech Stack:** TypeScript strict / NodeNext, Ink 7, vitest + ink-testing-library.

**Spec:** `docs/superpowers/specs/2026-07-08-tui-open-consistency-design.md` (approved).

## Global Constraints

- **No new dependencies, no `Config` changes.**
- **TDD:** failing test first; suite green at every commit.
- **Conventional commits; no AI attribution** — after each commit check `git log -1 --format='%B'` and amend away any `Co-Authored-By`/"Generated with" lines.
- **Prettier 100 cols** on touched files before each commit; re-read files if prettier reformatted.
- **Vitest exit-code trap:** never pipe vitest through a filter — `npx vitest run <files> > /tmp/vit.out 2>&1; echo "exit: $?"` then read the file.
- **Ink async tests:** bounded `until(cond)` loops (helper at `tests/tuiApp.test.tsx` ~line 276), never one fixed tick.
- **Escape text:** any new SGR sequences in tests are written as `` escape text, never literal ESC bytes — after editing run `grep -c $'\033' <file>` and expect 0. (The `click(x,y)` helper and `ESC` const already exist in `tests/tuiApp.test.tsx` — reuse them.)
- **Full gate before done:** `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.
- Worktree: `/Users/alxedelweiss/junco/.claude/worktrees/tui_nits`, branch `feat/tui-open-consistency` (off main). `node_modules` freshly installed.

**Verified geometry:** the issue detail view and the PR overlay render in the middle slot at ANY width; the rail stays left and no right pane renders in those views, so the middle band is `[railWidth, columns)`. Both cards carry the `↗` line at pane-relative `LINK_LINE_ROW` (3) → absolute 0-based screen row 4 → 1-based click row 5.

---

### Task 1: Uniform `o browser` label + test re-anchoring

**Files:**
- Modify: `src/tui/components/Chrome.tsx` (four `hintsFor` sites), `src/tui/components/HelpModal.tsx` (one row), `docs/dashboard.md` (`o` table row)
- Test: `tests/tuiApp.test.tsx` (label waits + markers), `tests/tuiChrome.test.tsx`, `tests/tuiModal.test.tsx` (only if they assert the old labels — grep first)

**Interfaces:**
- Produces: footer label `browser` for `o` in: `case "prs"`, `case "prDetail"`, the pane-1 list, the pane-3 list (the `case "detail"` site already reads `browser`). Task 3's tests rely on the prDetail footer reading exactly `esc back · o browser`.

**The marker subtlety (do this carefully):** several `tuiApp` tests use `"o open"` as a UNIQUE pane-3-footer marker. After the rename, `o browser` appears in MANY footers, so it cannot serve as a discriminator. Re-anchor those assertions on `"← issues"` — the hint that exists ONLY in the pane-3 footer (`["←", "issues"]`; pane 2's is `←/→ panes` wide / `← repos` medium).

- [ ] **Step 1: Write the failing tests** (adapt the existing ones):

In `tests/tuiApp.test.tsx`, by current line region:
- ~729 and ~773: `includes("esc back · o open")` → `includes("esc back · o browser")` (prDetail footer waits).
- ~1577 and ~1590: `expect(r.lastFrame()).not.toContain("o open")` (pane-3 leak negatives) → `expect(r.lastFrame()).not.toContain("← issues")`, keeping each comment.
- ~1761, ~1780, ~1789, ~1897: `includes("o open")` pane-3-footer waits → `includes("← issues")`.
- ~1902: `not.toContain("o open")` → `not.toContain("← issues")`.

In `tests/tuiChrome.test.tsx` / `tests/tuiModal.test.tsx`: `grep -n '"o", "open"\|o open\|"o", "repo"\|o repo\|open in browser' tests/tuiChrome.test.tsx tests/tuiModal.test.tsx` — update any hit to the new labels (footer `browser`; help-modal row text from Step 3).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiApp.test.tsx > /tmp/vit.out 2>&1; echo "exit: $?"`
Expected: exit 1 — the two prDetail-footer waits fail (footer still says `o open`). (The `← issues` re-anchors pass already — that hint exists today; that's fine, they are not the RED signal.)

- [ ] **Step 3: Implement the label changes**

`src/tui/components/Chrome.tsx` — in `hintsFor`: change `["o", "open"]` → `["o", "browser"]` in `case "prs"`, `case "prDetail"`, and the `pane === 3` list; change `["o", "repo"]` → `["o", "browser"]` in the `pane === 1` list. (`case "detail"` already has `["o", "browser"]` — leave it.)

`src/tui/components/HelpModal.tsx` — the "act on issue" row:

```tsx
["o", "open in browser (repo from pane 1, PR from PR views)"],
```

`docs/dashboard.md` — the `o` keys-table row becomes:

```
| `o`                             | open the selection in your browser — the repo's GitHub page from the repos pane (1), the issue from panes 2 / issue detail, the PR from the PR monitor, PRs view, and PR overlay                                                                                             |
```

- [ ] **Step 4: Run the suites**

Run: `npx vitest run tests/tuiApp.test.tsx tests/tuiChrome.test.tsx tests/tuiModal.test.tsx > /tmp/vit.out 2>&1; echo "exit: $?"`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/Chrome.tsx src/tui/components/HelpModal.tsx tests/tuiApp.test.tsx tests/tuiChrome.test.tsx tests/tuiModal.test.tsx
git add -A && git commit -m "feat(tui): one label for o — browser, in every footer context"
```

---

### Task 2: `hitTest` learns the detail and prDetail views

**Files:**
- Modify: `src/tui/hitTest.ts`
- Test: `tests/tuiHitTest.test.ts`

**Interfaces:**
- Consumes: existing `LINK_LINE_ROW` (= 3) from `src/tui/geometry.ts`.
- Produces: `HitContext["view"]` widens to `"main" | "prs" | "detail" | "prDetail"`; in the two new views `hitTest` returns `{ type: "linkLine" }` for the middle-band `↗` row and `{ type: "none" }` everywhere else. Task 3 builds on exactly this contract.

- [ ] **Step 1: Write the failing tests** (append to `tests/tuiHitTest.test.ts`):

```ts
describe("hitTest — detail and prDetail views", () => {
  // Both views render in the middle slot at any width; the rail stays visible
  // but is keyboard-dead while an overlay is open. Only the ↗ metadata line
  // (absolute row 1 + LINK_LINE_ROW = 4) is a mouse target.
  for (const view of ["detail", "prDetail"] as const) {
    it(`${view}: the ↗ row in the middle band resolves linkLine; all else is none`, () => {
      expect(hitTest(medium({ view }), 30, 4)).toEqual({ type: "linkLine" });
      expect(hitTest(medium({ view }), 99, 4)).toEqual({ type: "linkLine" }); // band runs to the edge
      expect(hitTest(medium({ view }), 5, 4)).toEqual({ type: "none" }); // rail band is dead
      expect(hitTest(medium({ view }), 30, 3)).toEqual({ type: "none" }); // heading row
      expect(hitTest(medium({ view }), 30, 5)).toEqual({ type: "none" }); // body row
      expect(hitTest(medium({ view }), 30, 0)).toEqual({ type: "none" }); // header
    });
    it(`${view}: wide terminals — no preview band exists, the whole width is the card`, () => {
      expect(hitTest(wide({ view }), 80, 4)).toEqual({ type: "linkLine" }); // x=80 would be pane-3 band in main
      expect(hitTest(wide({ view }), 80, 6)).toEqual({ type: "none" });
    });
  }
});
```

(The `medium`/`wide` fixture helpers already exist in this file and accept `Partial<HitContext>` overrides.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiHitTest.test.ts > /tmp/vit.out 2>&1; echo "exit: $?"`
Expected: exit 1 — TS narrows `view` to `"main" | "prs"` today, so the suite fails to build (or the assertions fail if vitest transpiles without checking).

- [ ] **Step 3: Implement**

In `src/tui/hitTest.ts`:

1. Widen the context field and its doc:

```ts
  /** The row-bearing views resolve rows; the two detail views resolve only
   * their ↗ metadata line. Other views never call this. */
  view: "main" | "prs" | "detail" | "prDetail";
```

2. Directly after the body-bounds check (`if (r < 0 || r >= layout.bodyRows) return { type: "none" };`) and BEFORE the rail-band block, add:

```ts
  if (view === "detail" || view === "prDetail") {
    // Keyboard-owned overlays: only the ↗ metadata line is a mouse target.
    // The card fills the middle slot to the screen edge — no right pane
    // renders in these views, at any width.
    if (x >= layout.railWidth && r === LINK_LINE_ROW) return { type: "linkLine" };
    return { type: "none" };
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/tuiHitTest.test.ts > /tmp/vit.out 2>&1; echo "exit: $?"`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/hitTest.ts tests/tuiHitTest.test.ts
git add -A && git commit -m "feat(tui): hitTest resolves the ↗ line in the detail and prDetail views"
```

---

### Task 3: App wiring — clickable ↗ in both detail views, then the full gate

**Files:**
- Modify: `src/tui/App.tsx`, `docs/dashboard.md` (one sentence in the Mouse paragraph)
- Test: `tests/tuiApp.test.tsx`

**Interfaces:**
- Consumes: Task 2's `hitTest` contract; Task 1's `esc back · o browser` prDetail footer (used as a test wait); existing `click(x,y)` helper and `until` in the test file.
- Produces: `openDetailIssueInBrowser()` and `openPrDetailInBrowser()` callbacks in App — the ONE code path shared by keyboard `o` and the `↗` click in each view.

- [ ] **Step 1: Write the failing tests** (append inside the `describe("mouse")` block of `tests/tuiApp.test.tsx`, where `click`, `until`, `wl`, `makeClient`, `makePr`, `okv`, `rawIssue` are in scope):

```tsx
  it("clicking the ↗ metadata line in the issue detail opens the browser (snapshot number)", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const issueOpens: number[] = [];
    client.openInBrowser = async (_nwo, num) => {
      issueOpens.push(num);
      return okv(undefined);
    };
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("2");
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    r.stdin.write("\r"); // open the issue detail
    await until(() => (r.lastFrame() ?? "").includes("the body"));
    r.stdin.write(click(30, 5)); // ↗ metadata row: 1-based y=5, middle band
    await until(() => issueOpens.length === 1);
    expect(issueOpens).toEqual([7]);
  });

  it("clicking the ↗ metadata line in the PR overlay opens the browser", async () => {
    const { client, prCalls } = makeClient(
      { "acme/api": [] },
      { prsByRepo: { "acme/api": [makePr()] } },
    );
    const r = renderApp(client, wl());
    r.stdin.write("p");
    await until(() => (r.lastFrame() ?? "").includes("Some PR"));
    r.stdin.write("\r"); // open the fullscreen PR overlay from the prs view
    await until(() => (r.lastFrame() ?? "").includes("esc back · o browser"));
    r.stdin.write(click(30, 5)); // ↗ metadata row of the overlay card
    await until(() => prCalls.length === 1);
    expect(prCalls[0]).toEqual(["acme/api", 100]);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiApp.test.tsx > /tmp/vit.out 2>&1; echo "exit: $?"`
Expected: exit 1 — both new tests time out in `until` (clicks in these views are ignored today).

- [ ] **Step 3: Implement in `src/tui/App.tsx`**

(a) Extract the two shared open callbacks, placed beside `openBrowser`/`openRepoBrowser` (their bodies come verbatim from the keyboard branches that currently inline them):

```ts
  // Snapshot-anchored browser opens for the two detail views — shared by the
  // keyboard `o` and the ↗ line's mouse click, so the two can never diverge
  // on WHICH resource they open (always the one frozen on screen).
  const openDetailIssueInBrowser = useCallback(() => {
    if (!currentNwo || !detail) return;
    void client.openInBrowser(currentNwo, detail.issue.number).then((res) => {
      if (!res.ok) showToast("error", res.error);
    });
  }, [client, currentNwo, detail, showToast]);
  const openPrDetailInBrowser = useCallback(() => {
    if (!prDetail) return;
    const { nwo, number } = prDetail.pr;
    void client.openPrInBrowser(nwo, number).then((res) => {
      if (!res.ok) showToast("error", res.error);
    });
  }, [client, prDetail, showToast]);
```

(b) The keyboard branches delegate: in the `view === "detail"` block, the `o` case body becomes `return void openDetailIssueInBrowser();`; in the `view === "prDetail"` block, the `o` case body becomes `return void openPrDetailInBrowser();` (delete the inlined `client.openInBrowser(...)`/`client.openPrInBrowser(...)` bodies they replace).

(c) Rework `onMouseEvent`'s view routing. Replace this current block:

```ts
    if (view === "help" || view === "palette" || view === "addRepo" || view === "prDetail") return;
    if (ev.kind === "release") return; // presses act on press, not release
    if (ev.kind === "press") dismissToast();

    // Full-body scroll views: wheel scrolls, clicks have no targets (v1).
    if (view === "detail" || view === "queue" || view === "cmdOutput") {
      if (ev.kind === "wheelDown") setScroll((s) => s + 1);
      if (ev.kind === "wheelUp") setScroll((s) => Math.max(0, s - 1));
      return;
    }
```

with:

```ts
    if (view === "help" || view === "palette" || view === "addRepo") return;
    if (ev.kind === "release") return; // presses act on press, not release
    if (ev.kind === "press") dismissToast();

    // Full-body scroll views with no click targets: wheel scrolls only.
    if (view === "queue" || view === "cmdOutput") {
      if (ev.kind === "wheelDown") setScroll((s) => s + 1);
      if (ev.kind === "wheelUp") setScroll((s) => Math.max(0, s - 1));
      return;
    }

    // The two detail views: wheel scrolls the issue detail (the PR overlay has
    // nothing to scroll); a press on the ↗ metadata line opens the browser.
    if (view === "detail" || view === "prDetail") {
      if (view === "detail") {
        if (ev.kind === "wheelDown") setScroll((s) => s + 1);
        if (ev.kind === "wheelUp") setScroll((s) => Math.max(0, s - 1));
      }
      if (ev.kind === "press") {
        const hit = hitTest(
          {
            layout,
            columns: size.columns,
            view,
            repoCount: repoMappings.length,
            listCount: 0,
            railStart: 0,
            listStart: 0,
            pane3Count: 0,
            pane3Start: 0,
            hasPreviewTarget: false,
          },
          ev.x,
          ev.y,
        );
        if (hit.type === "linkLine") {
          if (view === "detail") openDetailIssueInBrowser();
          else openPrDetailInBrowser();
        }
      }
      return;
    }
```

(The zeroed list fields are never read on the detail/prDetail path — Task 2's contract.)

(d) `docs/dashboard.md`, in the Mouse paragraph, change "click it on the PRs-view card (or cmd+click …, or press `o` anywhere)" to "click it — on the PRs-view card, the issue detail, or the PR overlay (or cmd+click in terminals that support OSC 8 hyperlinks, or press `o`)".

- [ ] **Step 4: Run the suite, then the full gate**

Run: `npx vitest run tests/tuiApp.test.tsx tests/tuiHitTest.test.ts > /tmp/vit.out 2>&1; echo "exit: $?"` — expect 0.
Run: `npm run lint && npm run format:check && npm run typecheck && npm run build` — all clean.
Run: `npx vitest run > /tmp/vit.out 2>&1; echo "exit: $?"` — expect 0; grep /tmp/vit.out for `MaxListeners` (must be absent).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/App.tsx tests/tuiApp.test.tsx
git add -A && git commit -m "feat(tui): ↗ metadata line is clickable in the issue detail and PR overlay"
```

---

## Verification checklist (post-plan)

- Full gate green (lint, format:check, typecheck, build, test) — CI parity.
- `git log --format='%(trailers)'` clean of AI attribution across the branch.
- Grep sanity: `grep -rn '"o", "open"\|"o", "repo"' src/` returns nothing.
