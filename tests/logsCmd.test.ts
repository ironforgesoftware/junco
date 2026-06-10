import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLogsCommand } from "../src/logsCmd.js";
import type { Config } from "../src/types.js";

describe("runLogsCommand", () => {
  let dir: string;
  let cfg: Config;
  let out: string[];
  const line = (msg: string): string =>
    JSON.stringify({ ts: "2026-06-10T12:00:00.000Z", level: "info", ticket: "-", msg }) + "\n";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "junco-logs-"));
    cfg = { stateDir: dir } as unknown as Config;
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
    await new Promise((r) => setTimeout(r, 50));
    appendFileSync(p, line("later"), "utf8");
    await new Promise((r) => setTimeout(r, 80));
    stop.abort();
    expect(await done).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/start/);
    expect(text).toMatch(/later/);
  });
});
