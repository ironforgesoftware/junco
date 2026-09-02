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
      "@typescript-eslint/no-explicit-any": "off",
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
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    plugins: { vitest },
    rules: {
      "vitest/no-focused-tests": "error",
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
