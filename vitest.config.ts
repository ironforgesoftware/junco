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
      // Global floor = the whole suite measured 2026-09-01 (92.50/85.45/90.63/
      // 94.39), rounded down to whole percent. The round-down is the slack that
      // absorbs ordinary churn — and ~0.01pt of run-to-run jitter, so never
      // ratchet to the last decimal; raising these is a reviewable edit and
      // lowering them is a visible one, so a silent drop cannot happen. Ratchet
      // them whenever the measured numbers clear the next whole percent.
      // (Previous floor: 90/83/87/92, the 2026-07-21 baseline —
      // docs/superpowers/specs/2026-07-21-test-suite-consolidation-design.md §5.)
      //
      // The glob keys below are per-tree floors for the security-critical code,
      // where the global number is blind: one file falling from 95% to 0% moves
      // 15k statements by a fraction of a percent — that is how sandbox/fsOps.ts
      // reached 0% branch coverage (#362) — but it moves a ~400-statement tree by
      // several points. Each is its own measurement, set ~2 points under, so a
      // few uncovered additions still pass and a collapse fails. A glob does NOT
      // carve its files out of the global set; both checks see every file.
      thresholds: {
        statements: 92,
        branches: 85,
        functions: 90,
        lines: 94,
        // measured 2026-09-01: 96.85 / 92.02 / 99.19 / 98.27
        "src/agent/sandbox/**": { statements: 95, branches: 90, functions: 97, lines: 96 },
        // measured 2026-09-01: 83.61 / 64.75 / 70.27 / 84.52 — low on purpose.
        // This is the one module that reaches the real Pi SDK (the runtime
        // `await import` plus the doctor/wizard helpers around it), so the
        // uncovered remainder is SDK-bound code the unit suite cannot enter.
        // The floor exists to stop that remainder from growing.
        "src/agent/session.ts": { statements: 82, branches: 63, functions: 67, lines: 83 },
      },
    },
  },
});
