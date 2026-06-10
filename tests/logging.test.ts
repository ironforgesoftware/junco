import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  log,
  withTicket,
  setLogLevel,
  setLogSink,
  setLogFormat,
  formatHumanLine,
  rotateLogIfLarge,
} from "../src/logging.js";

function capture(fn: () => void): any[] {
  const lines: any[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
    lines.push(JSON.parse(String(s)));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe("logging", () => {
  it("emits one JSON object per line with level/msg and ticket '-' by default", () => {
    const [entry] = capture(() => log.info("hello", { k: 1 }));
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("hello");
    expect(entry.ticket).toBe("-");
    expect(entry.k).toBe(1);
    expect(typeof entry.ts).toBe("string");
  });

  it("tags lines with the current ticket inside withTicket()", () => {
    const lines = capture(() => withTicket("T7", () => log.warn("inside")));
    expect(lines[0].ticket).toBe("T7");
  });

  it("canonical keys win over caller fields with the same name", () => {
    const [entry] = capture(() =>
      log.info("real", { level: "CRIT", ticket: "bogus", msg: "evil", ts: "x" }),
    );
    expect(entry.level).toBe("info");
    expect(entry.ticket).toBe("-");
    expect(entry.msg).toBe("real");
    expect(entry.ts).not.toBe("x");
  });
});

describe("setLogLevel", () => {
  // Restore the default threshold so the level change can't leak into other
  // tests (the level is process-wide module state).
  afterEach(() => setLogLevel("info"));

  it("default 'info' suppresses debug but emits info/warn/error", () => {
    const lines = capture(() => {
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    });
    expect(lines.map((l) => l.level)).toEqual(["info", "warn", "error"]);
  });

  it("'warn' suppresses debug + info, emits warn + error", () => {
    setLogLevel("warn");
    const lines = capture(() => {
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    });
    expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("'error' emits only error", () => {
    setLogLevel("error");
    const lines = capture(() => {
      log.warn("w");
      log.error("e");
    });
    expect(lines.map((l) => l.level)).toEqual(["error"]);
  });

  it("'debug' emits every level", () => {
    setLogLevel("debug");
    const lines = capture(() => {
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    });
    expect(lines.map((l) => l.level)).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("log sink + human format", () => {
  afterEach(() => {
    setLogSink(null);
    setLogFormat("json");
  });

  it("setLogSink tees the JSON line to the sink regardless of format", () => {
    const sunk: string[] = [];
    setLogSink((l) => sunk.push(l));
    setLogFormat("human");
    capture(() => {}); // no-op; just proving capture still works
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      log.info("hello", { a: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(sunk).toHaveLength(1);
    const entry = JSON.parse(sunk[0]);
    expect(entry.msg).toBe("hello");
    expect(entry.a).toBe(1);
  });

  it("human format renders a colorized line, not JSON", () => {
    setLogFormat("human");
    const raw: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      raw.push(String(s));
      return true;
    });
    try {
      log.warn("careful");
    } finally {
      spy.mockRestore();
    }
    expect(raw[0]).toContain("WARN");
    expect(raw[0]).toContain("careful");
    expect(() => JSON.parse(raw[0])).toThrow(); // not a JSON line
  });

  it("formatHumanLine renders ts/level/ticket/msg and leftover fields", () => {
    const line = formatHumanLine({
      ts: "2026-06-10T12:34:56.789Z",
      level: "warn",
      ticket: "t-1",
      msg: "careful",
      extra: 7,
    });
    expect(line).toContain("12:34:56");
    expect(line).toContain("WARN");
    expect(line).toContain("[t-1]");
    expect(line).toContain("careful");
    expect(line).toContain('"extra":7');
  });

  it("rotateLogIfLarge renames an oversized file to .1 and leaves small files alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-log-"));
    const p = join(dir, "worker.log");
    writeFileSync(p, "x".repeat(64), "utf8");
    rotateLogIfLarge(p, 10);
    expect(existsSync(p)).toBe(false);
    expect(existsSync(p + ".1")).toBe(true);
    writeFileSync(p, "small", "utf8");
    rotateLogIfLarge(p, 1024);
    expect(existsSync(p)).toBe(true);
    rotateLogIfLarge(join(dir, "missing.log"), 10); // no throw on missing
    rmSync(dir, { recursive: true, force: true });
  });
});
