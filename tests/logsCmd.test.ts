import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLogsCommand } from "../src/logsCmd.js";
import type { Config } from "../src/types.js";
import { until } from "./helpers/until.js";

describe("runLogsCommand", () => {
  let dir: string;
  let cfg: Config;
  let out: string[];
  const line = (msg: string): string =>
    JSON.stringify({ ts: "2026-06-10T12:00:00.000Z", level: "info", ticket: "-", msg }) + "\n";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "junco-logs-"));
    cfg = { dataDir: dir } as unknown as Config;
    out = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prints the last N lines, human-formatted when json is off", async () => {
    writeFileSync(join(dir, "worker.log"), line("one") + line("two") + line("three"), "utf8");
    const code = await runLogsCommand(
      cfg,
      { lines: 2, json: false },
      { printFn: (s) => out.push(s) },
    );
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).not.toMatch(/one/);
    expect(text).toMatch(/two/);
    expect(text).toMatch(/three/);
    expect(text).toMatch(/INFO/); // human format
  });

  it("--json passes raw lines through", async () => {
    writeFileSync(join(dir, "worker.log"), line("raw"), "utf8");
    await runLogsCommand(cfg, { lines: 10, json: true }, { printFn: (s) => out.push(s) });
    expect(out.join("")).toContain('"msg":"raw"');
  });

  it("non-JSON lines pass through verbatim", async () => {
    writeFileSync(join(dir, "worker.log"), "plain crash output\n" + line("ok"), "utf8");
    await runLogsCommand(cfg, { json: false }, { printFn: (s) => out.push(s) });
    expect(out.join("")).toContain("plain crash output");
  });

  it("missing log file → message + exit 1", async () => {
    const code = await runLogsCommand(cfg, {}, { printFn: (s) => out.push(s) });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/no log file/i);
  });

  it("--follow streams appended lines until the signal stops it", async () => {
    const p = join(dir, "worker.log");
    writeFileSync(p, line("start"), "utf8");
    const stop = new AbortController();
    const done = runLogsCommand(
      cfg,
      { follow: true, lines: 1 },
      { printFn: (s) => out.push(s), pollMs: 20, signal: stop.signal },
    );
    // The initial tail printing is the observable that the follow loop has
    // recorded its EOF offset (both happen synchronously before the first
    // poll); never wait a fixed tick for either — a loaded runner can miss it.
    await until(() => out.join("").includes("start"));
    appendFileSync(p, line("later"), "utf8");
    await until(() => out.join("").includes("later"));
    stop.abort();
    expect(await done).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/start/);
    expect(text).toMatch(/later/);
  });

  it("--follow resumes from the new head when the log file rotates (shrinks) mid-follow", async () => {
    const p = join(dir, "worker.log");
    // `lines: 1` means the initial tail prints only "pre-rotate-two"; "pre-rotate-one"
    // is never printed by the initial tail, and the follow loop starts at EOF — so it
    // should never appear in output unless rotation-resume logic is broken.
    writeFileSync(p, line("pre-rotate-one") + line("pre-rotate-two"), "utf8");
    const stop = new AbortController();
    const done = runLogsCommand(
      cfg,
      { follow: true, lines: 1 },
      { printFn: (s) => out.push(s), pollMs: 20, signal: stop.signal },
    );
    await until(() => out.join("").includes("pre-rotate-two"));
    // Rotate: replace with a shorter file (simulates log rotation truncating/recreating).
    writeFileSync(p, line("post-rotate"), "utf8");
    await until(() => out.join("").includes("post-rotate"));
    stop.abort();
    expect(await done).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/pre-rotate-two/); // from the initial tail, pre-rotation
    expect(text).not.toMatch(/pre-rotate-one/); // never shown — not in tail, not in follow
    expect(text).toMatch(/post-rotate/); // follow noticed the shrink and read from the new head
  });
});
