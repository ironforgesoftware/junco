import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import vitest from "@vitest/eslint-plugin";

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
);
