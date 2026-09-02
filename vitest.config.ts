import { defineConfig, configDefaults } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // tests/e2e/ is its own project (vitest.e2e.config.ts): it spawns the
    // built CLI and must never ride along with the unit run.
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    // vi.restoreAllMocks() before every test: a vi.spyOn left behind by a
    // failed (or forgetful) test must not leak into the next one.
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Floor = the pre-consolidation baseline (90.70/83.33/87.64/92.86 measured
      // 2026-07-21), rounded down to whole percent. Raising these is a reviewable
      // edit; lowering them is a visible one — a silent drop cannot happen.
      // docs/superpowers/specs/2026-07-21-test-suite-consolidation-design.md §5
      thresholds: { statements: 90, branches: 83, functions: 87, lines: 92 },
    },
  },
});
