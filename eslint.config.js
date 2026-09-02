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
  // `App` (1,796): #350 moved the action handlers out into src/tui/hooks/; what
  // is left is the nav spine plus the render body, whose section-by-section
  // extraction is still open under the sweep tracker #387.
  { file: "src/tui/App.tsx", max: 1796 },
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
