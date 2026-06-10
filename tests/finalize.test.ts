import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalize } from "../src/finalize.js";
import type { RunResult } from "../src/types.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "junco-fin-"));
  const processing = join(root, "processing");
  const done = join(root, "done");
  const failed = join(root, "failed");
  [processing, done, failed].forEach((d) => mkdirSync(d));
  const ticket = join(processing, "2026__q1.md");
  writeFileSync(ticket, "---\nid: q1\n---\n# Q\nask\n", "utf8");
  return { ticket, done, failed };
}
const ok: RunResult = {
  finalText: "the answer",
  toolCalls: [],
  usage: { input: 1, output: 1, cacheRead: 0, total: 2 },
  stopReason: "stop",
  errorMessage: null,
  timedOut: false,
  durationMs: 1000,
  abortedByGuard: false,
};

describe("finalize", () => {
  it("writes reply + status to done/ and leaves no temp file", () => {
    const { ticket, done, failed } = sandbox();
    const dst = finalize(ticket, ok, { done, failed });
    expect(dst.startsWith(done)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: completed");
    expect(text).toContain("the answer");
    expect(existsSync(ticket)).toBe(false);
    expect(readdirSync(done).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("routes timed-out runs to failed/", () => {
    const { ticket, done, failed } = sandbox();
    const dst = finalize(ticket, { ...ok, timedOut: true }, { done, failed });
    expect(dst.startsWith(failed)).toBe(true);
    expect(readFileSync(dst, "utf8")).toContain("status: timeout");
  });

  it("routes errored runs to failed/", () => {
    const { ticket, done, failed } = sandbox();
    const dst = finalize(ticket, { ...ok, errorMessage: "boom" }, { done, failed });
    expect(dst.startsWith(failed)).toBe(true);
    expect(readFileSync(dst, "utf8")).toContain("status: failed");
  });
});
