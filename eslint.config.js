import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import vitest from "@vitest/eslint-plugin";

/**
 * Structural ceiling for one function in `src/` (#361). Generous on purpose:
 * the rule exists to stop the *next* 900-line function, not to churn the ones
 * already written. Blank lines and comments don't count toward it, so the
 * budget is 400 lines of actual code.
 *
 * 400 also sits in a gap: the largest function under it is 359 lines and the
 * smallest over it is 419, so any ceiling in that range grandfathers exactly
 * the same five entries — tightening below 400 buys nothing until 360.
 */
const MAX_FUNCTION_LINES = 400;

const maxLinesPerFunction = (max) => [
  "error",
  { max, skipComments: true, skipBlankLines: true, IIFEs: true },
];

/**
 * The five functions that already exceed MAX_FUNCTION_LINES, each pinned at the
 * size it measured on 2026-09-01 (main @ 40e65b3, after the sweep extractions
 * landed). These are ratchets, not exemptions: the rule stays enabled for the
 * file, so its worst function can shrink but not grow, and raising a pin is a
 * deliberate line of diff a reviewer sees. An entry retires by being deleted
 * once the work named in its comment lands.
 */
const GRANDFATHERED_FUNCTION_LINES = [
  // `App` (1,890): #350 moved the action handlers out into src/tui/hooks/; what
  // is left is the nav spine plus the render body, whose section-by-section
  // extraction is still open under the sweep tracker #387. −29 from the 1,913
  // the chat VIEW spine left it at: the footer/binding derivation (the
  // binding-context switch, the two buildContextBindings memos and the footer
  // rows) moved to hooks/useFooterBindings.ts (footer redesign 2026-09-02,
  // Task 4), less the one line of `openHelp`'s re-entrancy guard. The cascade,
  // the verbs and the slash router live in hooks/useChatInput.ts. +4 net for the
  // chat verb (Task 5, 1,884 → 1,888): +6 for five props naming the verb's
  // targets to useViewActions (openChat/setView/setPane/prDetail/selectedPr)
  // plus the one `chatTarget` line the footer pill and the overlays' own `c`
  // share, −2 from Ruling R7 collapsing the rail-switch effect's condition onto
  // a `prevRailKey` ref. Net 0 for Ruling R8 (Task 6 batch, stays at 1,888):
  // the `chatTarget` call gains `repoDetailTarget` in its options object,
  // hoisted to a named `chatArgs` local (+1) rather than inlined — an inline
  // 6-field object would have wrapped the call over the printWidth — less 1
  // for dropping `resetPalette` from the now-dead `commands` handler's
  // useMainActions call. +1 for Ruling R10 (Task 2 fix round 2, stays a
  // single line): `useFooterBindings` gains `columns: size.columns` so
  // `buildFooterRows` can fit the navigate row to the terminal width instead
  // of a fixed medium/wide breakpoint (1,888 → 1,889). +2 for Ruling R12 (the
  // final fix wave, 1,889 → 1,891): the footer's row-1 target label is its own
  // reading of the spine, not the header's crumb tail, so App names the
  // overlay/selection sources once (`targetArgs`, reusing `chatArgs` for the
  // overlay half) and calls hooks/useFooterTarget.ts — the derivation itself
  // is entirely in the hook. −10 net for the chat-scroll brief (2026-09-02,
  // 1,891 → 1,881): +1 for `visibleRows: chatVisibleRows(layout.bodyRows)` on
  // the useChatInput call (PgUp/PgDn page by exactly the window ChatView
  // paints), then −11 for the pane doors — −3 hook inputs (moveRail,
  // moveRailTo, railCount), −1 for the `chatKey` local, and −7 for Ruling R7's
  // rail-switch effect (the `prevRailKey` ref plus its six effect lines): with
  // no door there is no in-view rail move to re-subscribe to. That floor was
  // 1,881 — and the clickable scrollbar then spent all 10 lines of it back, so
  // the pin ends exactly where it started rather than lower: `scrollTo` on the
  // useScroll destructure and the useChatInput call (+1), `onScrollTo` passed
  // to ChatView and TranscriptView (+2), and the transcript's own
  // follow-pausing `transcriptScrollTo` useCallback (+7). That last one is the
  // whole trade: a memoized view may only be handed a STABLE callback (perf
  // #259, pinned by tests/renderPerf.test.tsx), so the inline arrow that would
  // have cost 1 line is not an option. +3 for the held-key run fix (2026-09-03,
  // 1,891 → 1,894): `moveSectionCursor` steps from the PENDING cursor inside a
  // functional `setSectionCursor` (a `last` local plus the two-line resolver)
  // so a burst that useGuardedInput replays inside one closure composes. +10
  // for the cursor reveal (same day, 1,894 → 1,904): a cursor move now OWES
  // the window one nudge instead of the body re-nudging every render, and the
  // ack that commits the painted start is App's for the ticket transcript —
  // `ackReveal` on the useTranscript destructure (+1), the stable
  // `transcriptReveal` useCallback (+7, the memoized-view rule again), and
  // `onReveal` on both views (+2). −3 for the chat's pane decoupling (same
  // day, 1,904 → 1,901): the full-screen chat view owns its keys by view, so
  // `pane`/`setPane` leave the useChatInput call and `setPane` leaves the
  // useViewActions call. −21 for that branch's review waves (1,901 → 1,880):
  // the confirm modal's answer latches in `useConfirm.settle` (a replayed "yy"
  // must confirm once), so the key branch and both buttons collapse to one
  // call each (−18); and the follow-pause recipe moved into useFollowLatch —
  // two hook calls in App (+14) against the six by-value pauses they replace
  // (the transcript's `[`, `G` and wheel, the log overlay's `[`, `G` and
  // wheel, and the chat wheel, −17). Lowering this further is the render
  // body's extraction (#387), not shaving these. +2 for the junco_submit card
  // (2026-09-03, 1,880 → 1,882): `chatPending` on the useFooterBindings call
  // (+1) and `decide` in the structuralChipActions dep array (+1) — the card's
  // y/n chip recipe replaces the chat case's `return {}` in place, and the
  // `decide` it dispatches rides the existing chatApi destructure. +2 for the
  // label-switch unification (#443, 1,882 → 1,884): `optimisticLabels` now
  // applies state.ts's shared `labelDelta`, which needs the ask label as well
  // as the trigger — one `askLabel` fallback line and one `labelNames` memo
  // (stable, so `runAction`'s identity does not churn); the dep array trades
  // `trigger` for it and stays a single line. +6 for the two unreachable
  // navigate-row chips (#461, 1,884 → 1,890): `→ issues` is one line, and the
  // `: palette` chip is the `openQueueTranscript` precedent again — the key and
  // the chip must run ONE recipe, so `openPalette` is a stable useCallback (+5
  // net against the three key-handler lines it replaces with two). +1 for the
  // transcript's chat exit (#462, 1,890 → 1,891): `closeTranscript` joins the
  // useViewActions call so `c` releases the transcript's live poll on the way
  // out — the hook owns the recipe, App only names the closer. +1 for the
  // unhandled-rejection net (#455, 1,891 → 1,892): one `useRejectionToast`
  // call; the listener and its message shape live in the hook, and the
  // whole-process half is src/dashboardCmd.ts's.
  // +1 for the empty issue list (#473, 1,892 → 1,893): `issueSelected:
  // currentIssue !== undefined` on the useFooterBindings call — the footer
  // must not advertise the per-issue verbs with no issue under the cursor,
  // and `currentIssue` is App's own state, so the flag can only be read here.
  { file: "src/tui/App.tsx", max: 1893 },
  // `runPrFlow` (552): #353 lifted Phase 9 into postSessionReview.ts; the other
  // phases come out the same way, one PR at a time (#387).
  { file: "src/prFlow.ts", max: 552 },
  // `runDataMigrate` (499): the pre-0.10 layout machinery is deleted wholesale
  // at the 1.0 bump (#360, pinned by tests/dataMigrateSunset.test.ts), so this
  // entry retires with the file rather than by a refactor.
  { file: "src/dataMigrateCmd.ts", max: 499 },
  // `makeGhDashboardClient` (438): one closure factory holding every dashboard
  // `gh` call, splittable along its domains (issues / PRs / repos) — #387.
  { file: "src/tui/ghClient.ts", max: 438 },
  // `run` (419): #351 took `submit` and `start` out into their own modules; the
  // remaining subcommand bodies follow them into the handler table (#387).
  { file: "src/cli.ts", max: 419 },
];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "docs/**", "worktrees/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"],
    languageOptions: {
      parserOptions: { project: "./tsconfig.eslint.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      // #354: `any` in src/ is an enforced invariant, not a convention. The few
      // that remain are Pi-SDK boundary casts, each carrying a disable comment
      // that states why.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // src/ only: a test file's `describe` body is a function too, and capping it
    // would fight the suite's shape rather than the runtime's.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: { "max-lines-per-function": maxLinesPerFunction(MAX_FUNCTION_LINES) },
  },
  {
    // `vitest run` under CI=true already hard-fails on a stray `.only`
    // (vitest's `allowOnly: !isCI` default), so this catches the local-only
    // gap: `npm test` on a dev machine would silently narrow instead.
    //
    // Tests also hand-roll partial SDK shapes as fixtures and cast them at the
    // seam (tests/helpers/fakeSession.ts) — that `any` never reaches the
    // runtime, so the rule stays off here rather than seeding ~170 disables.
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    plugins: { vitest },
    rules: {
      "vitest/no-focused-tests": "error",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["src/tui/**/*.ts", "src/tui/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  // Last so the pins win over the ceiling above them.
  ...GRANDFATHERED_FUNCTION_LINES.map(({ file, max }) => ({
    files: [file],
    rules: { "max-lines-per-function": maxLinesPerFunction(max) },
  })),
);
