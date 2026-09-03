import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSubmit } from "../src/chat/submitExec.js";
import {
  draftFilePath,
  listChatDrafts,
  writeChatDraft,
  type PendingDraft,
} from "../src/chat/draftStore.js";
import { makeConfig } from "./helpers/config.js";
import { fakeSpawn } from "./helpers/fakeSpawn.js";

function cfgAt(root: string) {
  return makeConfig({
    dataDir: root,
    queueRoot: join(root, "queue"),
    worktreeRoot: join(root, "wt"),
    tools: [],
    criticEnabled: false,
    planLintEnabled: false,
    verifyEnabled: false,
    supervisorEnabled: false,
    healthEnabled: false,
    removeWorktreeOnSuccess: true,
  });
}

const file = (name: string): PendingDraft["files"][number] => ({
  name,
  content: `---\nid: ${name.replace(/\.md$/, "")}\n---\n# T\n`,
  lint: [],
  route: null,
  droppedKeys: [],
});

const draft = (id: string, names: string[], over: Partial<PendingDraft> = {}): PendingDraft => ({
  id,
  key: "acme/api",
  slug: "acme__api",
  kind: "ticket",
  files: names.map(file),
  cwd: "/repo",
  nwo: "acme/api",
  createdAt: "2026-09-03T00:00:00.000Z",
  lintFailed: false,
  blocked: null,
  routeOverride: "auto",
  commandArgs: null,
  ...over,
});

describe("runSubmit (spec 2026-09-03 §3.4)", () => {
  it("spawns `submit <file>` (or --as-issue), archives on exit 0, returns the merged output", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-se-"));
    const cfg = cfgAt(root);
    const one = draft("acme__api-1", ["add-readme.md"]);
    const two = draft("acme__api-2", ["x.md"]);
    writeChatDraft(cfg, one);
    writeChatDraft(cfg, two);
    const { spawnFn, calls } = fakeSpawn((c) => {
      c.stdout.emit("data", Buffer.from("queued\n"));
      c.emit("close", 0);
    });
    const r = await runSubmit(cfg, one, "inbox", { spawnFn, cliPath: "/dist/cli.js" });
    expect(calls[0]).toEqual([
      "/dist/cli.js",
      "submit",
      draftFilePath(cfg, one.id, "add-readme.md"),
    ]);
    expect(r).toMatchObject({ code: 0, archived: true, output: "queued\n", detail: null });
    expect(listChatDrafts(cfg).map((d) => d.id)).toEqual(["acme__api-2"]); // one archived
    const asIssue = await runSubmit(cfg, two, "issue", { spawnFn, cliPath: "/dist/cli.js" });
    expect(calls[1]).toEqual([
      "/dist/cli.js",
      "submit",
      "--as-issue",
      draftFilePath(cfg, two.id, "x.md"),
    ]);
    expect(asIssue).toMatchObject({ code: 0, archived: true });
    expect(listChatDrafts(cfg)).toEqual([]);
  });

  it("a non-zero exit stops the sequence, archives nothing, keeps the output", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-se-"));
    const cfg = cfgAt(root);
    const set = draft("acme__api-3", ["a.md", "b.md", "c.md"]);
    writeChatDraft(cfg, set);
    let n = 0;
    const { spawnFn, calls } = fakeSpawn((c) => {
      c.stdout.emit("data", Buffer.from(`run ${++n}\n`));
      c.emit("close", n === 1 ? 0 : 2);
    });
    const r = await runSubmit(cfg, set, "inbox", { spawnFn, cliPath: "/dist/cli.js" });
    expect(calls).toHaveLength(2); // the third file is never spawned
    expect(r).toMatchObject({
      code: 2,
      archived: false,
      output: "run 1\nrun 2\n",
      detail: "1 of 3 files submitted before a failure",
    });
    expect(listChatDrafts(cfg).map((d) => d.id)).toContain(set.id);
  });

  it("a draft that is no longer parked is refused without spawning", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-se-"));
    const cfg = cfgAt(root);
    const { spawnFn, calls } = fakeSpawn(() => {});
    const r = await runSubmit(cfg, draft("gone", ["a.md"]), "inbox", {
      spawnFn,
      cliPath: "/dist/cli.js",
    });
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ code: null, archived: false, detail: "draft no longer parked" });
  });

  it("a draft with no argv to run is refused without spawning", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-se-"));
    const cfg = cfgAt(root);
    const d = draft("acme__api-4", [], { kind: "audit", commandArgs: null });
    writeChatDraft(cfg, d);
    const { spawnFn, calls } = fakeSpawn(() => {});
    const r = await runSubmit(cfg, d, "inbox", { spawnFn, cliPath: "/dist/cli.js" });
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ code: null, archived: false, detail: "nothing to submit" });
  });
});
