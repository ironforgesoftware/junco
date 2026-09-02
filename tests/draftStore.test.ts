import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveChatDraft,
  chatDraftsDir,
  draftFilePath,
  draftFilesDir,
  draftJsonPath,
  draftsParkedFor,
  listChatDrafts,
  readChatDraft,
  removeChatDraft,
  writeChatDraft,
  type PendingDraft,
} from "../src/chat/draftStore.js";
import { makeConfig } from "./helpers/config.js";

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
const draft = (id: string, slug = "acme__api"): PendingDraft => ({
  id,
  key: "acme/api",
  slug,
  kind: "ticket",
  files: [
    { name: "t.md", content: "---\nid: t\n---\n# T\n", lint: [], route: null, droppedKeys: [] },
  ],
  cwd: "/repo",
  nwo: "acme/api",
  createdAt: "2026-09-01T00:00:00.000Z",
  lintFailed: false,
  blocked: null,
  routeOverride: "auto",
  commandArgs: null,
});

describe("chat draft store (spec 2026-09-01 §6.2)", () => {
  it("write puts the JSON in chat-drafts/ and the files under <draftId>/; list/read round-trip", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-ds-"));
    const cfg = cfgAt(root);
    writeChatDraft(cfg, draft("acme__api-1"));
    expect(existsSync(draftFilePath(cfg, "acme__api-1", "t.md"))).toBe(true);
    expect(readFileSync(draftFilePath(cfg, "acme__api-1", "t.md"), "utf8")).toBe(
      "---\nid: t\n---\n# T\n",
    );
    expect(listChatDrafts(cfg).map((d) => d.id)).toEqual(["acme__api-1"]);
    expect(readChatDraft(cfg, "acme__api-1").entry?.kind).toBe("ticket");
    expect(draftsParkedFor(cfg, "acme__api")).toBe(1);
    expect(draftsParkedFor(cfg, "other")).toBe(0);
  });
  it("archive moves the JSON to submitted/ or discarded/; remove deletes JSON + files", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-ds-"));
    const cfg = cfgAt(root);
    writeChatDraft(cfg, draft("d1"));
    writeChatDraft(cfg, draft("d2"));
    expect(archiveChatDraft(cfg, "d1", "submitted")).toBe(true);
    expect(existsSync(join(root, "data", "chat-drafts", "submitted", "d1.json"))).toBe(true);
    expect(listChatDrafts(cfg).map((d) => d.id)).toEqual(["d2"]);
    removeChatDraft(cfg, "d2");
    expect(listChatDrafts(cfg)).toEqual([]);
    expect(existsSync(draftFilePath(cfg, "d2", "t.md"))).toBe(false);
  });

  it("an id or name that slugifies to a directory link throws instead of resolving upward", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-ds-"));
    const cfg = cfgAt(root);
    // slugifyId KEEPS dots, so ".." survives it intact: without this guard
    // draftFilesDir(cfg, "..") is the chat-drafts dir's PARENT, and
    // removeChatDraft would rm -rf the whole data tree branch.
    for (const bad of ["..", "."]) {
      expect(() => draftFilesDir(cfg, bad)).toThrow(/draft id/i);
      expect(() => draftJsonPath(cfg, bad)).toThrow(/draft id/i);
      expect(() => draftFilePath(cfg, "d1", bad)).toThrow(/draft file/i);
    }
    // The ordinary shapes are untouched, traversal attempts included — those
    // slugify to inert one-component names.
    expect(draftFilesDir(cfg, "../../x")).toBe(join(chatDraftsDir(cfg), "..-..-x"));
    expect(draftFilePath(cfg, "d1", "t.md")).toBe(join(chatDraftsDir(cfg), "d1", "t.md"));
  });

  it("draftJsonPath is the exact path removeChatDraft removes (R29: one exported helper)", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-ds-"));
    const cfg = cfgAt(root);
    expect(draftJsonPath(cfg, "d1")).toBe(join(chatDraftsDir(cfg), "d1.json"));
    writeChatDraft(cfg, draft("d1"));
    expect(existsSync(draftJsonPath(cfg, "d1"))).toBe(true);
    removeChatDraft(cfg, "d1");
    expect(existsSync(draftJsonPath(cfg, "d1"))).toBe(false);
  });
});
