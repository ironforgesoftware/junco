<!-- Title: conventional-commit style — feat:/fix:/docs:/test:/chore:/refactor: (optional scope), ≤ 72 chars. -->

## What / why

<!-- A few sentences from the user's perspective. Link the issue: Closes #N -->

## Checklist

- [ ] Full gate green locally:
      `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` — or the change is not user-visible
- [ ] No AI attribution: no `Co-Authored-By:` trailers naming AI tools, no "Generated with …"
      lines, in commits or in this description
- [ ] Conventional title (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:` …), ≤ 72 chars
