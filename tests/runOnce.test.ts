import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOnce } from "../src/runOnce.js";
import type { Config } from "../src/types.js";

function cfg(root: string): Config {
  return { vaultRoot: root, juncoSubdir: "Junco", omlx: { url: "u", apiKey: "k" },
           modelId: "m", tools: ["read"], defaultTimeoutMinutes: 1 };
}

function fakeFactory() {
  return async () => ({
    subscribe(l: (e: any) => void) {
      queueMicrotask(() => {
        l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "reply!" } });
        l({ type: "turn_end", message: { stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 } } });
        l({ type: "agent_end", messages: [], willRetry: false });
      });
      return () => {};
    },
    async prompt() { await new Promise((r) => setTimeout(r, 5)); },
    dispose() {}, abort: async () => {},
  });
}

describe("runOnce", () => {
  it("processes a Q&A ticket to done/ with the reply", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) => mkdirSync(join(j, d), { recursive: true }));
    writeFileSync(join(j, "inbox", "q1.md"), "---\nid: q1\n---\n# Q\nask\n", "utf8");

    const handled = await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory() });
    expect(handled).toBe(true);
    const doneFiles = readdirSync(join(j, "done"));
    expect(doneFiles).toHaveLength(1);
    expect(readFileSync(join(j, "done", doneFiles[0]), "utf8")).toContain("reply!");
    expect(readdirSync(join(j, "inbox"))).toHaveLength(0);
  });

  it("returns false when the inbox is empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    ["inbox", "processing", "done", "failed"].forEach((d) => mkdirSync(join(root, "Junco", d), { recursive: true }));
    expect(await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory() })).toBe(false);
  });

  it("skips a PR-flow ticket (hasRepo) in M1", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) => mkdirSync(join(j, d), { recursive: true }));
    writeFileSync(join(j, "inbox", "pr.md"), "---\nid: pr\nrepo: /tmp/x\n---\n# PR\n", "utf8");
    const handled = await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory() });
    expect(handled).toBe(false);
    // not claimed — still in inbox
    expect(readdirSync(join(j, "inbox"))).toHaveLength(1);
  });

  it("skips an unreadable ticket but still processes a healthy one", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) => mkdirSync(join(j, d), { recursive: true }));
    // A directory named like a ticket makes readFileSync throw (EISDIR) → must be skipped.
    mkdirSync(join(j, "inbox", "bad.md"));
    writeFileSync(join(j, "inbox", "good.md"), "---\nid: good\n---\n# Q\nask\n", "utf8");

    const handled = await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory() });
    expect(handled).toBe(true);
    const doneFiles = readdirSync(join(j, "done"));
    expect(doneFiles).toHaveLength(1);
    expect(doneFiles[0]).toContain("good.md");
  });

  it("gives the Q&A session a read-only tool subset", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) => mkdirSync(join(j, d), { recursive: true }));
    writeFileSync(join(j, "inbox", "q1.md"), "---\nid: q1\n---\n# Q\nask\n", "utf8");

    let receivedTools: string[] | undefined;
    const c: Config = { ...cfg(root), tools: ["read", "write", "bash", "edit", "grep", "find", "ls"] };
    await runOnce(c, {
      sessionFactoryFor: (passedCfg) => {
        receivedTools = passedCfg.tools;
        return fakeFactory();
      },
    });
    expect(receivedTools).toEqual(["read", "grep", "find", "ls"]);
  });
});
