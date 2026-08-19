# Skill install & runtime skill-link ensure — design

**Date:** 2026-08-19
**Status:** approved (design reviewed in-session)

## Problem

The bundled `junco-dispatch` skill is consumed by agent harnesses (Claude Code, omp, …),
each of which discovers skills only in its own directory. Today the operator hand-creates
symlinks from each harness's skills dir into the junco checkout or npm package. Those
links break whenever the target moves (checkout relocation, package reinstall) — this
happened in practice: both `~/.claude/skills/junco-dispatch` and
`~/.omp/agent/skills/junco-dispatch` silently pointed at a checkout location that no
longer existed.

Goals:

1. **All junco assets addressed through `~/.junco`** (the data dir): a stable
   `<dataDir>/skills` mount point that harness links target, so content moves never
   break more than one link.
2. **Instantiated upon installation:** a fresh `npm i -g` + first run materializes the
   mount and harness links with no manual step.
3. **Self-healing:** broken links repair on every daemon start and `junco update`.

## Decisions (settled with the operator)

- **Runtime ensure, not npm postinstall.** postinstall is widely disabled
  (`--ignore-scripts`), cannot reliably resolve HOME/dataDir at install time, and adds
  supply-chain surface to a provenance-published package. Instead an idempotent ensure
  step runs at daemon start, wizard/config-init, and `junco update` — "installed ⇒
  instantiated on first run".
- **Named harness registry + config list of paths.** Shipped code carries a registry of
  five public harnesses with their default global skills dirs; the operator's config
  stores resolved *paths* (not names). Presence of a path in config is standing consent —
  junco never writes into a harness dir not listed.

## Config surface (additive)

```json
"skills": {
  "harnessDirs": ["~/.claude/skills", "~/.omp/agent/skills"]
}
```

- Optional block; absent ⇒ only the `<dataDir>/skills` mount is ensured, no harness
  links.
- Written by the wizard step and `junco skill install --harness …`; read by the ensure
  step. `~` expands via the existing `expandHome`.

## Harness registry

| Name       | Default skills dir          | Verified                                  |
| ---------- | --------------------------- | ----------------------------------------- |
| `claude`   | `~/.claude/skills`          | yes (operator machine)                    |
| `codex`    | `~/.codex/skills`           | yes (operator machine)                    |
| `pi`       | `~/.pi/agent/skills`        | yes (operator machine)                    |
| `omp`      | `~/.omp/agent/skills`       | yes (operator machine)                    |
| `opencode` | `~/.config/opencode/skills` | **verify against opencode docs in impl.** |

Naming public harnesses is a compatibility matrix, not a personal-setup leak; the
stack-agnostic rule continues to apply to wizard copy about inference endpoints.
`--harness <path>` accepts any literal path, so registry defaults are conveniences,
not limits.

## Module: `src/skillLinks.ts`

Pure, side effects behind a `SkillLinksDeps` seam (lstat/readlink/symlink/mkdir/unlink
injectables). No Pi SDK involvement.

- `HARNESS_REGISTRY: Record<string, string>` — the table above.
- `skillsMountPath(cfg)` — `join(cfg.dataDir, "skills")`. Also surfaced as a new
  `skills` field on `DataTreePaths` (single source of truth for tree shape stays
  `dataTree.ts`).
- `packageSkillsDir()` — `<PACKAGE_ROOT>/skills`, hoisting the `PACKAGE_ROOT` idiom
  from `planPrompt.ts:21` into a shared helper both import.
- `ensureSkillLinks(cfg, deps): SkillLinksReport` — idempotent:
  1. Ensure `<dataDir>/skills → packageSkillsDir()`.
  2. For each `cfg.skills.harnessDirs` entry whose **parent** exists (harness actually
     installed — e.g. `~/.claude` for `~/.claude/skills`): mkdir the skills dir if
     needed, then ensure `<harnessDir>/junco-dispatch → <dataDir>/skills/junco-dispatch`.
  3. Repair policy, applied to both link classes:
     - absent ⇒ create;
     - broken symlink (lstat ok, target stat fails) ⇒ replace;
     - **valid symlink ⇒ leave untouched, even if it points elsewhere** (preserves an
       operator's deliberate checkout-targeted mount when the npm-installed daemon
       runs);
     - real file/dir occupying the name ⇒ never touch; warning.
  4. Symlink syscall failure (permissions, unsupported FS) ⇒ warning, never a thrown
     error — the daemon must not fail to start over skill links.
  5. Returns `{ created: string[], repaired: string[], skipped: string[], warnings: string[] }`
     for logging/CLI output.

## Instantiation points

1. **Daemon start** (`daemon.ts`): call immediately after `ensureDataTree()`; log the
   report at info level (only when non-empty).
2. **`junco update`** (`updateCmd.ts`): re-run ensure after the new package lands, before
   restart.
3. **Wizard** (`wizard/flow.ts` + answers plumbing): new step — detect installed
   harnesses (registry entries whose parent dir exists), offer as multi-select
   defaulting to detected ones, write `skills.harnessDirs`, ensure runs with the rest of
   config-init.
4. **`junco skill install [--harness <name|path>]…`** (new `skill` subcommand in
   `cli.ts`):
   - no args ⇒ ensure from config, print report;
   - `--harness` (repeatable) ⇒ resolve names via registry (unknown name errors listing
     valid names; anything with a path separator or `~` is a literal path), persist new
     entries to `skills.harnessDirs` in the config file, then ensure;
   - exit 1 if an explicitly requested link could not be created (warnings for
     config-driven ensure remain exit 0).
5. **Doctor** (`doctor.ts`): new check — mount present and healthy; each configured
   harness link ok / broken / blocked-by-non-symlink.

## Out of scope (YAGNI)

- `skill uninstall` / `skill list` subcommands.
- Harness auto-detection outside the wizard.
- Copying skill content into `<dataDir>` (the mount stays a symlink; content's source
  of truth is the installed package or checkout).
- Windows symlink fallbacks (CI matrix is ubuntu/macos; ensure degrades to a warning).

## Testing

All via the `SkillLinksDeps` seam — no real HOME, no real harness dirs:

- mount creation / broken-mount repair / valid-foreign-mount preservation;
- harness link create / repair / non-symlink refusal / absent-harness skip;
- registry name resolution incl. unknown-name error and literal-path passthrough;
- config persistence from `skill install --harness`;
- daemon-start invocation ordering (after `ensureDataTree`);
- wizard step detect/offer/write;
- doctor check states;
- `tests/helpers/config.ts` gains the `skills` field (the only full `Config` literal).

## Docs

- `docs/configuration.md`: the `skills` block.
- `docs/tickets.md`: replace the hand-symlink description with `junco skill install`.
- README: one-liner under installation.
