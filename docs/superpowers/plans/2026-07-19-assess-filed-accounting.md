# Assess Filed Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After filing findings from a `junco assess` review batch, the batch stays in the review list (TUI + CLI) with per-finding filed accounting (how + timestamp + URL); batches leave only via explicit discard.

**Architecture:** `PendingAssess` gains an optional `filed` map (fingerprint → `{at, how, url?}`). `fileFindings` stops auto-archiving and instead stamps filed records and rewrites the batch in place; a renamed `discardPending` (was `removePending`) becomes the only end-of-life, exposed as TUI `x` and a new `junco assess discard <id>`. Spec: `docs/superpowers/specs/2026-07-19-assess-filed-accounting-design.md`.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, ink + ink-testing-library, React.

## Global Constraints

- Suite green at every commit; run `npx prettier --write <touched files>` before each commit (CLAUDE.md).
- `npm run typecheck` covers `tests/` — vitest does not type-check; a shape change to `FileResult`/`DashboardClient` MUST update every test stub in the same commit.
- No `Config` changes anywhere in this plan → no LEVERS/bijection or Config-fixture work.
- Ink/TUI tests: loop-until-condition (`until(...)`) — never assert one fixed `setTimeout` tick.
- No AI attribution in commits.
- Conventional commits; keep existing provenance comments true or update them with the code they describe.
- All paths relative to the worktree root `/Users/alxedelweiss/junco/worktrees-manual/tui-qol`.

---

### Task 1: Store — `FiledRecord`, `filed` field, rename `removePending` → `discardPending`

**Files:**

- Modify: `src/assessReview.ts`
- Modify: `src/assessFiling.ts` (import/call-site rename only — behavior unchanged this task)
- Test: `tests/assessReview.test.ts`

**Interfaces:**

- Consumes: `makeReviewStore` (`src/reviewStore.ts`) — unchanged.
- Produces: `interface FiledRecord { at: string; how: "created" | "queued" | "deduped"; url?: string }`; `PendingAssess.filed?: Record<string, FiledRecord>`; `discardPending(cfg: Config, id: string, deps?: AssessReviewDeps): boolean` (exact former `removePending` semantics). Tasks 2–7 rely on these names.

- [ ] **Step 1: Write the failing tests**

In `tests/assessReview.test.ts`: change the import `removePending` → `discardPending` and rename its usages in the two existing tests that call it (`"writes, lists, reads, and archives a batch"`, `"contains a path-traversal id…"`, and the ENOENT test — retitle that one `"discardPending on an already-archived id is ENOENT-safe: returns false, never throws"`). Then add two tests at the end of the describe:

```ts
it("filed accounting round-trips through the store", () => {
  const dir = mkdtempSync(join(tmpdir(), "arv-"));
  const c = cfg(dir);
  writePending(c, {
    ...batch("assess-x-1"),
    filed: {
      abc123: {
        at: "2026-07-10T00:00:00.000Z",
        how: "created",
        url: "https://github.com/o/r/issues/1",
      },
    },
  });
  const { batch: read } = readPending(c, "assess-x-1");
  expect(read?.filed).toEqual({
    abc123: {
      at: "2026-07-10T00:00:00.000Z",
      how: "created",
      url: "https://github.com/o/r/issues/1",
    },
  });
  expect(listPending(c)[0].filed?.abc123.how).toBe("created");
});

it("a legacy batch without `filed` still loads (field is optional, not required)", () => {
  const dir = mkdtempSync(join(tmpdir(), "arv-"));
  const c = cfg(dir);
  writePending(c, batch("legacy")); // no filed key at all
  const { batch: read, error } = readPending(c, "legacy");
  expect(error).toBeNull();
  expect(read?.filed).toBeUndefined();
  expect(listPending(c).map((b) => b.id)).toEqual(["legacy"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/assessReview.test.ts`
Expected: FAIL — `discardPending` is not exported (import error), before the new tests even run.

- [ ] **Step 3: Implement in `src/assessReview.ts`**

Add above `PendingAssess`:

```ts
/** Per-finding filing accounting, stamped by assessFiling.ts at file time.
 * `deduped` = the marker scan found it already on GitHub during a pass. */
export interface FiledRecord {
  at: string; // ISO, the filing pass's timestamp
  how: "created" | "queued" | "deduped";
  url?: string; // gh-printed issue URL (how: "created" only)
}
```

Add to `PendingAssess` (after `issue?: number;`):

```ts
  filed?: Record<string, FiledRecord>; // fingerprint → accounting; absent = nothing filed yet
```

Update the comment above the `makeReviewStore` call: `issue` and `filed` are the two optional fields (do NOT add `filed` to the required-fields array). Rename the `removePending` function to `discardPending` and update its doc comment:

```ts
/** Explicit end-of-life for a batch: archive to filed/. true → archived;
 * false → already archived/gone (ENOENT-safe: discarding twice is a no-op,
 * not a throw). Filing does NOT archive (assessFiling.ts stamps `filed`
 * records instead) — this is the only way a batch leaves the review list. */
export function discardPending(cfg: Config, id: string, deps: AssessReviewDeps = {}): boolean {
  return store.remove(cfg, id, "filed", deps);
}
```

In `src/assessFiling.ts`, update the import (`removePending` → `discardPending`) and the single call at the archive site (`removePending(cfg, batch.id)` → `discardPending(cfg, batch.id)`). Behavior is unchanged until Task 2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/assessReview.test.ts tests/assessFiling.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
npx prettier --write src/assessReview.ts src/assessFiling.ts tests/assessReview.test.ts
git add -A && git commit -m "refactor(assess): FiledRecord + filed map on PendingAssess; removePending → discardPending"
```

---

### Task 2: Filing core — stamp filed records, keep the batch parked, `FileResult.batch`

**Files:**

- Modify: `src/assessFiling.ts`
- Modify: `tests/assessFiling.test.ts`
- Modify (type-completeness only): `tests/tuiApp.test.tsx`, `tests/tuiMouseApp.test.tsx`, `tests/tuiGhClient.test.ts` — every fake returning a `FileResult` literal gains `batch`
- Test: `tests/assessFiling.test.ts`

**Interfaces:**

- Consumes: `FiledRecord`, `writePending` (Task 1).
- Produces: `FileFindingsDeps.nowFn?: () => Date`; `FileResult.batch: PendingAssess` (the batch as persisted after the pass). Tasks 4–7 rely on `batch` and on filing no longer archiving.

- [ ] **Step 1: Rewrite/extend the tests in `tests/assessFiling.test.ts`**

Add a shared const under `PERM_ERR`:

```ts
const NOW = () => new Date("2026-07-19T12:00:00.000Z");
const AT = "2026-07-19T12:00:00.000Z";
```

(a) Retitle the first test `"files the selected findings, stamps them filed, and keeps the batch parked"`. Pass `nowFn: NOW` in deps and replace the final archived assertion with:

```ts
const { batch } = readPending(c, "assess-x-1");
expect(batch).not.toBeNull();
expect(batch?.filed).toEqual({
  f1: { at: AT, how: "created", url: "https://github.com/o/r/issues/9" },
});
expect(res.batch).toEqual(batch);
```

(b) In `"skips a finding already filed (marker present…)"`, pass `nowFn: NOW` and append:

```ts
const { batch } = readPending(c, "assess-x-1");
expect(batch?.filed?.f1).toEqual({ at: AT, how: "deduped" });
expect(batch?.filed?.f2).toEqual({
  at: AT,
  how: "created",
  url: "https://github.com/o/r/issues/9",
});
```

(c) In `"offline issue create enqueues…"`, pass `nowFn: NOW` and append:

```ts
expect(readPending(c, "assess-x-1").batch?.filed?.f1).toEqual({ at: AT, how: "queued" });
```

(d) In `"does NOT archive the batch when every selected finding fails…"`, append (a fully-failed pass stamps nothing):

```ts
expect(readPending(c, "assess-x-1").batch?.filed).toBeUndefined();
```

(e) Retitle `"still archives when a filing partially succeeds and the rest queue offline"` to `"a partially-queued pass stamps created + queued and keeps the batch parked"`; pass `nowFn: NOW`; replace the final `toBeNull` assertion with:

```ts
const { batch } = readPending(c, "assess-x-1");
expect(batch?.filed?.f1).toEqual({
  at: AT,
  how: "created",
  url: "https://github.com/o/r/issues/9",
});
expect(batch?.filed?.f2).toEqual({ at: AT, how: "queued" });
```

(f) New test after (d):

```ts
it("stamps persist for the successful subset even when another finding fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "afl-"));
  const c = cfg(dir);
  writePending(c, pending(true));
  let n = 0;
  const ghFn = (async (_c: unknown, args: string[]) => {
    if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
    if (args[0] === "issue" && args[1] === "create") {
      n++;
      if (n === 2) throw PERM_ERR; // f2 fails non-offline
      return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  }) as unknown as typeof gh;

  const res = await fileFindings(c, pending(true), new Set(["f1", "f2"]), { ghFn, nowFn: NOW });
  expect(res.created).toBe(1);
  expect(res.failed).toBe(1);
  // The rewrite happened despite the failure: f1's stamp is durable, f2 is retryable.
  const { batch } = readPending(c, "assess-x-1");
  expect(batch?.filed).toEqual({
    f1: { at: AT, how: "created", url: "https://github.com/o/r/issues/9" },
  });
});
```

(g) In the empty-selection test, the `toEqual` literal gains `batch: pending(false)`; same idea in the no-match-selection test (assert `res.batch.id` is `"assess-x-1"` there — it already asserts counts).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/assessFiling.test.ts`
Expected: FAIL — `filed` stamps missing, batches archived, `res.batch` undefined.

- [ ] **Step 3: Implement in `src/assessFiling.ts`**

Imports: replace `discardPending` with `writePending`, and add `type FiledRecord`:

```ts
import { writePending, type FiledRecord, type PendingAssess } from "./assessReview.js";
```

Deps + result types:

```ts
export interface FileFindingsDeps {
  ghFn?: typeof gh;
  nowFn?: () => Date;
}
export interface FileResult {
  created: number;
  queuedOffline: number;
  deduped: number;
  failed: number;
  urls: string[];
  warnings: string[];
  /** The batch as persisted after this pass — filed stamps merged in. The
   * batch STAYS parked; explicit discard is the only end-of-life. */
  batch: PendingAssess;
}
```

In `fileFindings`, type the accumulator `const result: Omit<FileResult, "batch"> = { … }` (same literal). The empty-selection early return becomes `return { ...result, batch };`. After the `labelsFor` definition, add:

```ts
const at = (deps.nowFn ?? (() => new Date()))().toISOString();
const filedMap: Record<string, FiledRecord> = { ...(batch.filed ?? {}) };
let stamped = 0;
```

In the filing loop, stamp each outcome:

```ts
    if (filed.has(f.fingerprint)) {
      result.deduped++;
      filedMap[f.fingerprint] = { at, how: "deduped" };
      stamped++;
      continue;
    }
    …
      if (outcome === "sent") {
        result.created++;
        if (url) result.urls.push(url);
        filedMap[f.fingerprint] = { at, how: "created", ...(url ? { url: url as string } : {}) };
      } else {
        result.queuedOffline++;
        filedMap[f.fingerprint] = { at, how: "queued" };
      }
      stamped++;
```

(the `catch` branch stays stamp-free). Replace the entire `#137` comment block + `if (result.failed === 0) { discardPending(cfg, batch.id); }` with:

```ts
// The batch STAYS parked — explicit discard (`junco assess discard` / TUI x)
// is the only end-of-life. The rewrite runs whenever anything was stamped,
// INCLUDING partial-failure passes: stamps for the successful subset must
// survive so a retry shows what already landed. (supersedes the #137
// archive gate — with no auto-archive, a failed pass can no longer discard
// findings, which was #137's concern.)
const updated: PendingAssess = stamped > 0 ? { ...batch, filed: filedMap } : batch;
if (stamped > 0) writePending(cfg, updated);
return { ...result, batch: updated };
```

Update the module doc comment (line 1–8): "Files a human-confirmed SELECTION … then stamps per-finding `filed` records and keeps the batch parked (explicit discard is the batch's only end-of-life)." Also update the `fileFindings` doc comment ("File the SELECTED findings from a parked batch, then archive the batch." → "…, stamping per-finding filed records; the batch stays parked.").

- [ ] **Step 4: Sweep the type-broken `FileResult` fakes**

`grep -rn "queuedOffline: 0" tests/` — every fake `FileResult` literal needs `batch`. In `tests/tuiApp.test.tsx` add near the top (after the `okv` helper):

```ts
const STUB_FILE_BATCH = {
  id: "stub",
  nwo: "o/r",
  external: true,
  autoPlan: false,
  repoPath: "/x",
  createdAt: "2026-07-09T00:00:00.000Z",
  findings: [],
};
```

and add `batch: STUB_FILE_BATCH` to the `fileReview` stub literals in `makeClient`, `makeSeqClient`, `makePrSeqClient` (≈ lines 141, 194, 250, 728) and to the inline fake in the `"toggling and pressing f…"` test (there use `batch: batches[0]` — Task 7 rewrites that test's assertions; here only make it compile while preserving current behavior expectations… the fake's returned `batch` is unused by the App until Task 7). Do the same for any `fileReview` stub in `tests/tuiMouseApp.test.tsx` (its shared `stubClient`). In `tests/tuiGhClient.test.ts`, the `fileFindingsFn` fakes return `FileResult` literals — add `batch` (reuse the file's existing `batch` const).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/assessFiling.test.ts tests/tuiApp.test.tsx tests/tuiGhClient.test.ts tests/tuiMouseApp.test.tsx && npm run typecheck`
Expected: PASS / clean. (`tuiApp` still passes: the App still optimistically drops the row — its fakes only got a new unused field.)

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/assessFiling.ts tests/assessFiling.test.ts tests/tuiApp.test.tsx tests/tuiMouseApp.test.tsx tests/tuiGhClient.test.ts
git add -A && git commit -m "feat(assess): filing stamps per-finding filed records and keeps the batch parked"
```

---

### Task 3: Audit re-run — carry filed stamps forward on the offline re-park path

**Files:**

- Modify: `src/assessFlow.ts` (phase 7, around line 384–401)
- Test: `tests/assessFlow.test.ts`

**Interfaces:**

- Consumes: `readPending`, `type FiledRecord` (Task 1).
- Produces: nothing new — behavior only.

- [ ] **Step 1: Write the failing test**

In `tests/assessFlow.test.ts`, add `writePending` to the existing `../src/assessReview.js` import. After the `"offline dedup list: a network failure…"` test, add:

```ts
it("offline re-park carries filed stamps forward for still-present findings", async () => {
  const { root, j } = sandbox();
  const repo = mkRepo();
  const { path } = claim(j, ticketContent(repo));
  const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
  const fp = fingerprintFinding({
    kind: "code",
    ruleId: "NET-1",
    location: { path: "src/index.ts" },
    title: "NET-1",
  });
  // A prior filing pass stamped this finding. The re-run happens OFFLINE
  // (dedup list throws → empty marker set), so the finding re-parks — the
  // overwrite must not lose its stamp.
  writePending(cfg(root), {
    id: ticket.id,
    nwo: "o/r",
    external: false,
    autoPlan: false,
    repoPath: repo,
    createdAt: "2026-07-01T00:00:00.000Z",
    findings: [],
    filed: {
      [fp]: {
        at: "2026-07-02T00:00:00.000Z",
        how: "created",
        url: "https://github.com/o/r/issues/1",
      },
    },
  });
  const gh = fakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") throw NET_ERR;
    return undefined;
  });
  const r = await runAssessFlow(cfg(root), ticket, path, {
    ghFn: gh.ghFn,
    gitFn: fakeGit(originHttps),
    runCmdFn: fakeRunCmd("{}"),
    sessionFactoryFor: () => fakeSession(findingsFence([codeFinding("NET-1", "src/index.ts")])),
  });
  expect(r.parked).toBe(1);
  const [b] = listPending(cfg(root));
  expect(b.filed).toEqual({
    [fp]: {
      at: "2026-07-02T00:00:00.000Z",
      how: "created",
      url: "https://github.com/o/r/issues/1",
    },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/assessFlow.test.ts -t "offline re-park"`
Expected: FAIL — `b.filed` is `undefined` (the overwrite dropped it).

- [ ] **Step 3: Implement in `src/assessFlow.ts`**

Extend the assessReview import: `import { writePending, readPending, type PendingAssess, type FiledRecord } from "./assessReview.js";`. In phase 7, between `afterDedup` and the `parked` literal, insert:

```ts
// Carry filed accounting across the overwrite. An ONLINE re-run's marker
// dedup (above) already excluded filed findings, so this matters on the
// OFFLINE path where dedup degraded to an empty set and previously-filed
// findings re-park — their stamps must survive. Corrupt/missing prior
// batch → no merge (readPending never throws).
const priorFiled = readPending(cfg, ticket.id).batch?.filed;
const carried: Record<string, FiledRecord> = {};
if (priorFiled) {
  for (const f of afterDedup) {
    const rec = priorFiled[f.fingerprint];
    if (rec) carried[f.fingerprint] = rec;
  }
}
```

and add to the `parked` literal (after the `issue` spread):

```ts
    ...(Object.keys(carried).length > 0 ? { filed: carried } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/assessFlow.test.ts`
Expected: PASS (all — the online-dedup and plain re-park tests are unaffected: no prior `filed` → no `filed` key).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/assessFlow.ts tests/assessFlow.test.ts
git add -A && git commit -m "fix(assess): offline re-park carries filed stamps forward"
```

---

### Task 4: CLI — filed accounting in `assess review`, new `junco assess discard <id>`

**Files:**

- Modify: `src/assessCmd.ts`
- Modify: `src/cli.ts` (help text ≈ lines 193–195; dispatch ≈ lines 661–684)
- Test: `tests/assessCmd.test.ts`

**Interfaces:**

- Consumes: `discardPending`, `PendingAssess.filed` (Task 1).
- Produces: `runAssessDiscardCommand(cfg: Config, id: string | undefined, deps?: AssessDiscardDeps): Promise<number>`; `interface AssessDiscardDeps { printFn?: (s: string) => void }`.

- [ ] **Step 1: Write the failing tests**

In `tests/assessCmd.test.ts`, add `runAssessDiscardCommand` to the `../src/assessCmd.js` import and `readPending` to the assessReview import (add the import if absent — `writePending` is already used). In the `runAssessReviewCommand` describe, add:

```ts
it("list and detail show filed accounting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arv-filed-"));
  const c = cfg([], dir);
  writePending(c, {
    id: "assess-x-1",
    nwo: "o/r",
    external: true,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [
      {
        fingerprint: "f1",
        kind: "code",
        severity: "high",
        ruleId: "R",
        title: "Bug",
        description: "",
        references: [],
      },
      {
        fingerprint: "f2",
        kind: "code",
        severity: "low",
        ruleId: "R",
        title: "Nit",
        description: "",
        references: [],
      },
    ],
    filed: {
      f1: {
        at: "2026-07-10T00:00:00.000Z",
        how: "created",
        url: "https://github.com/o/r/issues/1",
      },
    },
  });
  let out = "";
  const print = (s: string) => {
    out += s;
  };
  await runAssessReviewCommand(c, undefined, { printFn: print });
  expect(out).toContain("filed 1/2");

  out = "";
  await runAssessReviewCommand(c, "assess-x-1", { printFn: print });
  expect(out).toContain("[filed created 2026-07-10T00:00:00.000Z]");
  expect(out).toMatch(/f2.*Nit\n/); // unfiled row carries no filed note
  expect(out).toContain("discard: junco assess discard assess-x-1");
});
```

New describe at the end of the file:

```ts
describe("runAssessDiscardCommand", () => {
  it("discards a pending batch (exit 0) — it leaves the pending list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adc-"));
    const c = cfg([], dir);
    writePending(c, {
      id: "assess-x-1",
      nwo: "o/r",
      external: true,
      autoPlan: false,
      repoPath: "/x",
      createdAt: "2026-07-09T00:00:00.000Z",
      findings: [
        {
          fingerprint: "f1",
          kind: "code",
          severity: "high",
          ruleId: "R",
          title: "Bug",
          description: "",
          references: [],
        },
      ],
    });
    let out = "";
    const code = await runAssessDiscardCommand(c, "assess-x-1", { printFn: (s) => (out += s) });
    expect(code).toBe(0);
    expect(out).toContain("discarded 'assess-x-1'");
    expect(readPending(c, "assess-x-1").batch).toBeNull();
  });

  it("already-gone id: exit 0 with a note (ENOENT-safe)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adc-"));
    const c = cfg([], dir);
    let out = "";
    const code = await runAssessDiscardCommand(c, "assess-ghost", { printFn: (s) => (out += s) });
    expect(code).toBe(0);
    expect(out).toContain("assess-ghost");
    expect(out).toMatch(/already discarded/);
  });

  it("missing id: usage, exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adc-"));
    const c = cfg([], dir);
    let out = "";
    const code = await runAssessDiscardCommand(c, undefined, { printFn: (s) => (out += s) });
    expect(code).toBe(2);
    expect(out).toContain("Usage: junco assess discard <id>");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/assessCmd.test.ts`
Expected: FAIL — `runAssessDiscardCommand` is not exported.

- [ ] **Step 3: Implement in `src/assessCmd.ts`**

Add `discardPending` to the assessReview import. In `runAssessReviewCommand`'s list loop, replace the print with:

```ts
for (const b of pending) {
  const scope = b.external ? "external" : "owned";
  const filedCount = Object.keys(b.filed ?? {}).length;
  const filedCol = filedCount > 0 ? `  filed ${filedCount}/${b.findings.length}` : "";
  print(`${b.id}  ${b.nwo} (${scope})  ${b.findings.length} findings  ${b.createdAt}${filedCol}\n`);
}
```

In the detail branch, replace the findings loop and append a discard hint after the existing `file some:` hint:

```ts
for (const f of batch.findings) {
  const rec = batch.filed?.[f.fingerprint];
  const note = rec ? `  [filed ${rec.how} ${rec.at}]` : "";
  print(`  ${f.fingerprint}  [${f.severity}]  ${f.title}${note}\n`);
}
```

```ts
print(`discard: junco assess discard ${batch.id}\n`);
```

Update `runAssessFileCommand`'s doc comment ("…as GitHub issues via assessFiling.ts, then archives the batch." → "…as GitHub issues via assessFiling.ts; the batch stays parked with per-finding `filed` stamps — `junco assess discard` is the explicit end-of-life."). Add at the end of the file:

```ts
export interface AssessDiscardDeps {
  printFn?: (s: string) => void;
}

/**
 * `junco assess discard <id>` — the explicit end-of-life for a parked batch:
 * archive to review/assess/filed/ without filing anything further. Filing no
 * longer archives, so this is the only way a batch leaves `assess review`.
 * Discarding an already-gone id is a no-op success (ENOENT-safe).
 */
export async function runAssessDiscardCommand(
  cfg: Config,
  id: string | undefined,
  deps: AssessDiscardDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  if (!id) {
    print("Usage: junco assess discard <id>\n");
    return 2;
  }
  if (discardPending(cfg, id)) {
    print(`discarded '${id}'\n`);
  } else {
    print(`junco assess discard: no pending batch '${id}' (already discarded?)\n`);
  }
  return 0;
}
```

In `src/cli.ts`: in the assess block after the `file` branch, add:

```ts
if (sub === "discard") {
  const { runAssessDiscardCommand } = await import("./assessCmd.js");
  return runAssessDiscardCommand(cfg, positionals[2], { printFn });
}
```

and in the help text after the `assess file` line:

```
  assess discard <id>                     discard a pending batch without filing
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/assessCmd.test.ts tests/cli.test.ts`
Expected: PASS. (`tests/cli.test.ts` asserts nothing about the assess help lines — verified — and has no per-subcommand dispatch tests for assess, so no additions there; it runs here to catch accidental dispatch breakage.)

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/assessCmd.ts src/cli.ts tests/assessCmd.test.ts
git add -A && git commit -m "feat(cli): assess review filed accounting + junco assess discard"
```

---

### Task 5: ghClient — `discardReview` seam (+ `fileReview` passthrough coverage)

**Files:**

- Modify: `src/tui/ghClient.ts`
- Modify (stub sweep): `tests/tuiApp.test.tsx`, `tests/tuiMouseApp.test.tsx` (every object implementing `DashboardClient`)
- Test: `tests/tuiGhClient.test.ts`

**Interfaces:**

- Consumes: `discardPending` (Task 1), `FileResult.batch` (Task 2).
- Produces: `DashboardClient.discardReview(id: string): Promise<Result<null>>`; `GhClientDeps.discardPendingFn?: typeof discardPending`. Task 7's App handler calls `client.discardReview`.

- [ ] **Step 1: Write the failing tests**

In `tests/tuiGhClient.test.ts`: in the `"reads the batch and files the selected fingerprints"` test, add `batch` to the fake's returned literal (`{ created: 1, …, warnings: [], batch }`) and append `if (r.ok) expect(r.value.batch.id).toBe("assess-x-1");`. Then add after the `fileReview` describe:

```ts
describe("discardReview", () => {
  it("discards via discardPendingFn and returns ok(null)", async () => {
    const discardPendingFn = vi.fn((_c: Config, _id: string) => true);
    const client = makeGhDashboardClient(cfg, { ...fakes(), discardPendingFn });
    const r = await client.discardReview("assess-x-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
    expect(discardPendingFn).toHaveBeenCalledWith(cfg, "assess-x-1");
  });

  it("a throwing discard surfaces as ok:false", async () => {
    const discardPendingFn = vi.fn((_c: Config, _id: string): boolean => {
      throw new Error("rename boom");
    });
    const r = await makeGhDashboardClient(cfg, { ...fakes(), discardPendingFn }).discardReview("x");
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tuiGhClient.test.ts`
Expected: FAIL — `discardReview` does not exist on the client.

- [ ] **Step 3: Implement in `src/tui/ghClient.ts`**

Add `discardPending` to the assessReview import (it already imports `listPending`, `readPending`, `fileFindings` types/functions). Interface — after `fileReview`:

```ts
  /** Discard a parked batch without filing — the explicit end-of-life
   * (archives to review/assess/filed/). Already-gone ids are a no-op. */
  discardReview(id: string): Promise<Result<null>>;
```

Also update `fileReview`'s doc comment: "…files the selected findings; the returned `FileResult.batch` is the batch as persisted after the pass (still parked, filed stamps merged)." Deps — after `fileFindingsFn`:

```ts
  discardPendingFn?: typeof discardPending;
```

Implementation — after the `fileReview` method:

```ts
    discardReview(id) {
      return attempt(async () => {
        (deps.discardPendingFn ?? discardPending)(cfg, id);
        return null;
      });
    },
```

- [ ] **Step 4: Sweep the `DashboardClient` stubs**

`grep -rn "discardCommentDraft: async" tests/` — every stub client that satisfies `DashboardClient` needs the new method. Add alongside each `discardCommentDraft` stub:

```ts
    discardReview: async () => okv(null),
```

(in `tests/tuiApp.test.tsx`: `makeClient`, `makeSeqClient`, `makePrSeqClient`, and the fourth stub ≈ line 728; in `tests/tuiMouseApp.test.tsx`: its `stubClient`.)

- [ ] **Step 5: Run tests + typecheck, then commit**

Run: `npx vitest run tests/tuiGhClient.test.ts tests/tuiApp.test.tsx tests/tuiMouseApp.test.tsx && npm run typecheck`
Expected: PASS / clean.

```bash
npx prettier --write src/tui/ghClient.ts tests/tuiGhClient.test.ts tests/tuiApp.test.tsx tests/tuiMouseApp.test.tsx
git add -A && git commit -m "feat(tui): discardReview client seam; fileReview returns the updated batch"
```

---

### Task 6: ReviewView — `now` prop, age column, filed chips, ✓ rows

**Files:**

- Modify: `src/tui/components/ReviewView.tsx`
- Modify: `src/tui/App.tsx` (render site only — pass `now={queueNow}`, ≈ line 2476)
- Test: `tests/reviewView.test.tsx`

**Interfaces:**

- Consumes: `PendingAssess.filed` (Task 1), `fmtAge(iso: string, now: Date): string` (`src/tui/queueFmt.ts`).
- Produces: `ReviewView` requires a new `now: Date` prop. Task 7's App tests rely on the ✓/`[x]` glyph rendering described here.

- [ ] **Step 1: Write the failing tests**

In `tests/reviewView.test.tsx`: add `const NOW = new Date("2026-07-09T02:00:00.000Z");` under the fixtures and add `now={NOW}` to every existing `<ReviewView …/>` render (10 call sites — the suite will not compile without it, which is the point). Add fixtures + tests:

```ts
const FILED_BATCH = {
  ...BATCH,
  filed: {
    f1: {
      at: "2026-07-09T00:00:00.000Z",
      how: "created" as const,
      url: "https://github.com/o/r/issues/1",
    },
  },
};
```

```ts
  it("list row shows the batch age and a filed n/m chip when accounting exists", () => {
    const s = state({ batches: [FILED_BATCH as never] });
    const frame = render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toContain("2h ago"); // createdAt age
    expect(frame).toContain("filed 1/2"); // replaces the bare count column
  });

  it("checklist: a filed, unchecked row renders ✓ + how + age instead of an empty checkbox", () => {
    const s = state({
      batches: [FILED_BATCH as never],
      open: { kind: "batch", batchIdx: 0, findingCursor: 0, checked: new Set<string>() },
    });
    const frame = render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toMatch(/✓.*SQL injection.*created 2h ago/);
    expect(frame).toMatch(/\[ \].*stale dep/); // unfiled row keeps its checkbox
    expect(frame).toContain("1 filed"); // header accounting
  });

  it("checklist: a filed row that is re-checked shows [x] and keeps its accounting note", () => {
    const s = state({
      batches: [FILED_BATCH as never],
      open: { kind: "batch", batchIdx: 0, findingCursor: 0, checked: new Set(["f1"]) },
    });
    const frame = render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toMatch(/\[x\].*SQL injection.*created 2h ago/);
  });

  it("checklist: how 'deduped' renders as 'dup'", () => {
    const s = state({
      batches: [{ ...BATCH, filed: { f1: { at: "2026-07-09T01:00:00.000Z", how: "deduped" as const } } } as never],
      open: { kind: "batch", batchIdx: 0, findingCursor: 0, checked: new Set<string>() },
    });
    const frame = render(<ReviewView state={s} scroll={0} height={20} focused now={NOW} />).lastFrame() ?? "";
    expect(frame).toMatch(/dup 1h ago/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/reviewView.test.tsx`
Expected: FAIL — TS: `now` is not a known prop (and the new assertions would fail anyway).

- [ ] **Step 3: Implement in `src/tui/components/ReviewView.tsx`**

Imports: `import { fmtAge } from "../queueFmt.js";`. Props: add `now: Date;` to the component's props type and destructure `now`. Batch list row — replace the two right-hand cells:

```tsx
          const filedCount = b.filed ? Object.keys(b.filed).length : 0;
          …
              <Text dimColor>{fmtAge(b.createdAt, now)}</Text>
              <Text dimColor>{b.external ? "external" : "owned"}</Text>
              {filedCount > 0 ? (
                <Text color={theme.accent}>{`filed ${filedCount}/${b.findings.length}`}</Text>
              ) : (
                <Text color={theme.accent}>{`${b.findings.length}`}</Text>
              )}
```

Checklist header — compute `const filedCount = batch.filed ? Object.keys(batch.filed).length : 0;` and extend the dim header text:

```tsx
          >{`  ${batch.external ? "external" : "owned"} · ${checked.size}/${batch.findings.length} selected${filedCount > 0 ? ` · ${filedCount} filed` : ""}`}</Text>
```

Checklist row — inside the findings map, look up the record and render:

```tsx
          const rec = batch.filed?.[f.fingerprint];
          …
              <Text>{on ? "[x]" : rec ? " ✓ " : "[ ]"}</Text>
              <Text color={SEV_COLOR[f.severity]}>{f.severity.padEnd(8)}</Text>
              <Box flexGrow={1} minWidth={0}>
                <Text wrap="truncate" dimColor={!sel}>
                  {f.title}
                </Text>
              </Box>
              {rec && (
                <Text dimColor>{`${rec.how === "deduped" ? "dup" : rec.how} ${fmtAge(rec.at, now)}`}</Text>
              )}
```

In `src/tui/App.tsx`, add `now={queueNow}` to the `<ReviewView …/>` render (beside `state`/`scroll`/`height`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/reviewView.test.tsx tests/tuiApp.test.tsx && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/ReviewView.tsx src/tui/App.tsx tests/reviewView.test.tsx
git add -A && git commit -m "feat(tui): review view filed accounting — age column, filed chips, ✓ rows"
```

---

### Task 7: App — pre-check unfiled only, filing keeps the batch open, `x` discards

**Files:**

- Modify: `src/tui/App.tsx` (keyboard open ≈ line 1850–1868; mouse open `reviewRowPress` ≈ line 2095–2117; file handler ≈ line 1808–1837; new `x` handler in batch mode)
- Test: `tests/tuiApp.test.tsx`

**Interfaces:**

- Consumes: `FileResult.batch` (Task 2), `client.discardReview` (Task 5), ✓/`[x]` rendering (Task 6). No hint copy changes: `hintsFor("review")` already shows `["x", "discard"]` (`src/tui/components/Chrome.tsx:298`) — this task makes that chip true for batches.
- Produces: nothing new — behavior only.

- [ ] **Step 1: Rewrite/extend the tests in `tests/tuiApp.test.tsx` (review describe)**

(a) Rewrite `"toggling and pressing f files the selected fingerprints and drops the batch"` as:

```ts
it("f files the selection; the batch row STAYS with filed accounting and unfiled stays checked-out", async () => {
  const batches = [
    {
      id: "assess-x-1",
      nwo: "o/r",
      external: true,
      autoPlan: false,
      repoPath: "/x",
      createdAt: "2026-07-09T00:00:00.000Z",
      findings: [
        {
          fingerprint: "f1",
          kind: "code" as const,
          severity: "high" as const,
          ruleId: "R",
          title: "SQL injection",
          description: "",
          references: [],
        },
        {
          fingerprint: "f2",
          kind: "code" as const,
          severity: "low" as const,
          ruleId: "R",
          title: "stale dep",
          description: "",
          references: [],
        },
      ],
    },
  ];
  const filed: Array<[string, string[]]> = [];
  const { client } = makeClient({ "acme/api": [] });
  (client as { listReview: () => Promise<unknown> }).listReview = async () => okv(batches);
  (client as { fileReview: (id: string, fps: string[]) => Promise<unknown> }).fileReview = async (
    id,
    fps,
  ) => {
    filed.push([id, fps]);
    return okv({
      created: fps.length,
      queuedOffline: 0,
      deduped: 0,
      failed: 0,
      urls: [],
      warnings: [],
      batch: {
        ...batches[0],
        filed: Object.fromEntries(
          fps.map((fp) => [fp, { at: "2026-07-09T01:00:00.000Z", how: "created" as const }]),
        ),
      },
    });
  };
  const r = renderApp(client, wl8());
  await until(() => (r.lastFrame() ?? "").includes("acme/api"));
  r.stdin.write("v");
  await until(() => (r.lastFrame() ?? "").includes("o/r"));
  r.stdin.write("\r"); // open batch (all unfiled → all pre-checked)
  await until(() => (r.lastFrame() ?? "").includes("SQL injection"));
  r.stdin.write("j"); // cursor to f2
  r.stdin.write(" "); // uncheck f2
  await until(() => /\[ \].*stale dep/.test(r.lastFrame() ?? ""));
  r.stdin.write("f"); // file
  await until(() => filed.length === 1);
  expect(filed[0]).toEqual(["assess-x-1", ["f1"]]);
  await until(() => (r.lastFrame() ?? "").includes("filed 1")); // toast
  // The checklist stays open: f1 now shows ✓ accounting, f2 keeps its empty box.
  await until(() => /✓.*SQL injection/.test(r.lastFrame() ?? ""));
  expect(r.lastFrame()).toMatch(/\[ \].*stale dep/);
  // Back in the list, the batch row is still there with a filed chip.
  r.stdin.write(ESC);
  await until(() => (r.lastFrame() ?? "").includes("filed 1/2"));
});
```

(b) New test — enter pre-checks only unfiled:

```ts
it("enter pre-checks only UNFILED findings; f refiles nothing already filed", async () => {
  const batches = [
    {
      id: "assess-x-1",
      nwo: "o/r",
      external: true,
      autoPlan: false,
      repoPath: "/x",
      createdAt: "2026-07-09T00:00:00.000Z",
      findings: [
        {
          fingerprint: "f1",
          kind: "code" as const,
          severity: "high" as const,
          ruleId: "R",
          title: "SQL injection",
          description: "",
          references: [],
        },
        {
          fingerprint: "f2",
          kind: "code" as const,
          severity: "low" as const,
          ruleId: "R",
          title: "stale dep",
          description: "",
          references: [],
        },
      ],
      filed: { f1: { at: "2026-07-09T00:30:00.000Z", how: "created" as const } },
    },
  ];
  const filed: Array<[string, string[]]> = [];
  const { client } = makeClient({ "acme/api": [] });
  (client as { listReview: () => Promise<unknown> }).listReview = async () => okv(batches);
  (client as { fileReview: (id: string, fps: string[]) => Promise<unknown> }).fileReview = async (
    id,
    fps,
  ) => {
    filed.push([id, fps]);
    return okv({
      created: fps.length,
      queuedOffline: 0,
      deduped: 0,
      failed: 0,
      urls: [],
      warnings: [],
      batch: batches[0],
    });
  };
  const r = renderApp(client, wl8());
  await until(() => (r.lastFrame() ?? "").includes("acme/api"));
  r.stdin.write("v");
  await until(() => (r.lastFrame() ?? "").includes("o/r"));
  r.stdin.write("\r");
  // f1 is filed → ✓ (not pre-checked); f2 unfiled → pre-checked [x].
  await until(() => /✓.*SQL injection/.test(r.lastFrame() ?? ""));
  expect(r.lastFrame()).toMatch(/\[x\].*stale dep/);
  r.stdin.write("f");
  await until(() => filed.length === 1);
  expect(filed[0]).toEqual(["assess-x-1", ["f2"]]);
});
```

(c) New test — `x` discards the open batch:

```ts
it("x discards the open batch and drops the row", async () => {
  const discarded: string[] = [];
  const { client } = makeClient({ "acme/api": [] });
  (client as { listReview: () => Promise<unknown> }).listReview = async () => okv([reviewBatch]);
  (client as { discardReview: (id: string) => Promise<unknown> }).discardReview = async (id) => {
    discarded.push(id);
    return okv(null);
  };
  const r = renderApp(client, wl8());
  await until(() => (r.lastFrame() ?? "").includes("acme/api"));
  r.stdin.write("v");
  await until(() => (r.lastFrame() ?? "").includes("o/r"));
  r.stdin.write("\r");
  await until(() => (r.lastFrame() ?? "").includes("SQL injection"));
  r.stdin.write("x");
  await until(() => discarded.length === 1);
  expect(discarded[0]).toBe("assess-x-1");
  await until(() => (r.lastFrame() ?? "").includes("no pending assess reviews"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tuiApp.test.tsx -t "review view"`
Expected: FAIL — (a) row is dropped after filing, (b) f1 is pre-checked, (c) `x` does nothing in batch mode.

- [ ] **Step 3: Implement in `src/tui/App.tsx`**

(a) Keyboard open (`key.return` in combined-list mode, ≈ line 1861) — pre-check only unfiled:

```ts
                checked: new Set(
                  batch.findings.filter((f) => !batch.filed?.[f.fingerprint]).map((f) => f.fingerprint),
                ),
```

(b) Mouse open (`reviewRowPress`, ≈ line 2109) — the comment above it demands key/mouse parity — apply the identical `checked` expression.

(c) File-success handler (≈ lines 1822–1831) — replace the optimistic-removal block with a swap that keeps the row and the open checklist, dropping only now-filed fingerprints from `checked` (failed ones stay checked for retry):

```ts
setReviewState((s) => {
  const batches = s.batches.map((b) => (b.id === id ? v.batch : b));
  const open =
    s.open && s.open.kind === "batch"
      ? {
          ...s.open,
          checked: new Set([...s.open.checked].filter((fp) => !v.batch.filed?.[fp])),
        }
      : s.open;
  return { ...s, batches, open };
});
```

(d) New `x` handler in batch mode — insert between the `"n"` handler and the `"f" || key.return` handler (mirrors the draft-discard recipe):

```ts
if (input === "x") {
  if (!batch) return;
  const id = batch.id;
  void client.discardReview(id).then((res) => {
    if (!aliveRef.current) return;
    if (res.ok) {
      showToast("success", "discarded");
      setReviewState((s) => {
        const batches = s.batches.filter((b) => b.id !== id);
        const total = batches.length + s.drafts.length;
        return {
          ...s,
          batches,
          open: null,
          cursor: Math.min(s.cursor, Math.max(0, total - 1)),
        };
      });
    } else {
      showToast("error", res.error);
    }
  });
  return;
}
```

- [ ] **Step 4: Run the TUI suites + typecheck**

Run: `npx vitest run tests/tuiApp.test.tsx tests/tuiMouseApp.test.tsx tests/reviewView.test.tsx && npm run typecheck`
Expected: PASS / clean. (If a `tuiMouseApp` test clicks a batch open and asserts checked state, update it to the unfiled-only pre-check the same way as (b).)

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/App.tsx tests/tuiApp.test.tsx
git add -A && git commit -m "feat(tui): filing keeps the batch open with accounting; x discards a batch"
```

---

### Task 8: Docs + full gate

**Files:**

- Modify: `ARCHITECTURE.md` (module-map rows: `assessReview.ts`, `assessFiling.ts`, `assessFlow.ts`, `assessCmd.ts`)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)

**Interfaces:** none — documentation truth-keeping (CLAUDE.md: comments/docs must stay true).

- [ ] **Step 1: Update `ARCHITECTURE.md`**

- `assessReview.ts` row: rename `removePending` → `discardPending` in the export list and note "per-finding `filed` accounting (`FiledRecord`: at/how/url) stamped by assessFiling.ts".
- `assessFiling.ts` row: replace any "then archives the batch" phrasing with "stamps per-finding `filed` records and keeps the batch parked — `discardPending` (CLI `junco assess discard`, TUI `x`) is the explicit end-of-life".
- `assessFlow.ts` row: append to the parking sentence: "a re-park carries prior `filed` stamps forward for still-present fingerprints (offline-dedup reruns)".
- `assessCmd.ts` row: add `junco assess discard <id>` to the command list.

- [ ] **Step 2: Update `CHANGELOG.md` under `## [Unreleased]`**

Add (creating the subsections if absent, Keep a Changelog style):

```markdown
### Added

- `junco assess discard <id>` — explicitly archive a pending review batch; filing no longer auto-archives.

### Changed

- `junco assess` filing (CLI `assess file`, TUI `f`) stamps per-finding filed accounting (created/queued/dup + timestamp + URL) and keeps the batch in the review list; the TUI review view shows batch age, `filed n/m` chips, and per-finding ✓ accounting, and `x` discards an open batch.
```

- [ ] **Step 3: Full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npx vitest run > /tmp/junco-gate.out 2>&1; echo "exit: $?"`
Expected: `exit: 0` (inspect `/tmp/junco-gate.out` tail for the vitest summary — never pipe vitest through a filter).

- [ ] **Step 4: Commit**

```bash
npx prettier --write ARCHITECTURE.md CHANGELOG.md
git add -A && git commit -m "docs: filed-accounting lifecycle in ARCHITECTURE + CHANGELOG"
```
