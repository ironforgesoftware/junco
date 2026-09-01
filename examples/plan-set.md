# Plan set: string utility helpers

One `junco-plan` document compiles into a dependency-ordered ticket set: each task becomes its
own ticket and pull request, claimed only after every task it depends on has finished and had
its PR merged. Requires `planSets.enabled` in `config.json` (off by default). Submit with:

    junco submit --plan examples/plan-set.md --repo ~/code/your-project

or park it as an unlabeled GitHub issue for a human to label with
`junco submit --as-issue --plan examples/plan-set.md --repo ~/code/your-project`.

The compiler builds every child ticket's frontmatter (`id`, `repo`, `plan`, `depends_on`)
itself, so this file carries none. Only the fence is compiled; prose outside it is ignored.

```junco-plan
version: 1
shared_context: |
  TypeScript strict project: `npm run build` runs `tsc --noEmit`, `npm test` runs `vitest run`.
  `src/utils/index.ts` is the barrel for utilities; new exports go there. No new dependencies.
  Do not push or open a PR — the worker does both.
tasks:
  - id: strings-module
    title: Add truncate and slugify string utilities
    depends_on: []
    description: |
      Create `src/utils/strings.ts` exporting `truncate(s: string, max: number): string`
      (returns `s` unchanged when `s.length <= max`, otherwise `s.slice(0, max - 1) + "…"`)
      and `slugify(s: string): string` (lowercases, replaces non-alphanumeric runs with `-`,
      trims leading and trailing hyphens). Re-export both from `src/utils/index.ts`.
    acceptance:
      - WHEN `truncate("hello world", 8)` is called THE SYSTEM SHALL return `"hello w…"`.
      - WHEN `slugify("Hello, World!")` is called THE SYSTEM SHALL return `"hello-world"`.
      - WHEN `npm run build` is executed THE SYSTEM SHALL exit 0 with no TypeScript errors.
    prohibitions:
      - Do not modify any file outside `src/utils/`.
      - Do not migrate existing callers — that is the `migrate-callers` task.
    verification: |
      npm run build
      test -f src/utils/strings.ts
  - id: strings-tests
    title: Add unit tests for truncate and slugify
    depends_on: [strings-module]
    description: |
      Create `src/utils/strings.test.ts` with Vitest tests for both helpers. For `truncate`,
      cover the no-op under the limit, truncation with the ellipsis over it, and the
      exact-limit edge. For `slugify`, cover lowercasing, space-to-hyphen, special-character
      stripping, and leading/trailing hyphen trimming.
    acceptance:
      - WHEN `npm test` is executed THE SYSTEM SHALL exit 0 with the new tests passing.
    verification: |
      npm test
      test -f src/utils/strings.test.ts
  - id: migrate-callers
    title: Replace ad-hoc string truncation and slug logic with the shared helpers
    depends_on: [strings-module, strings-tests]
    description: |
      Replace the inline truncation in `src/api/format.ts` and the inline slug logic in
      `src/ui/labels.ts` with imports from `src/utils/index.ts`. Behavior must not change,
      so the existing tests for both modules pass unmodified.
    acceptance:
      - WHEN `npm test` is executed THE SYSTEM SHALL exit 0 with no test file modified.
      - WHEN `grep -rn "slice(0, max" src/api src/ui` is executed THE SYSTEM SHALL print nothing.
    prohibitions:
      - Do not edit `src/utils/strings.ts` or its tests in this task — change callers only.
    verification: |
      npm run build
      npm test
```
