import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, statSync } from "node:fs";
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
  openRotatingLogSink,
  openAppendLogSink,
} from "../src/logging.js";
import { until } from "./helpers/until.js";

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

// ---------------------------------------------------------------------------
// openRotatingLogSink (#42) — mid-run rotation, not just at startup
// ---------------------------------------------------------------------------

describe("openRotatingLogSink", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rotates mid-run when writes cross maxBytes", async () => {
    dir = mkdtempSync(join(tmpdir(), "junco-rotsink-"));
    const p = join(dir, "worker.log");
    const sink = openRotatingLogSink(p, 100);
    // Each write is 19 chars + newline = 20 bytes; the 6th crosses 100.
    for (let i = 0; i < 6; i++) sink.write("x".repeat(19));
    sink.close();
    await until(
      () => existsSync(p + ".1") && statSync(p + ".1").size === 100 && statSync(p).size === 20,
    );
    expect(
      readFileSync(p + ".1", "utf8")
        .trimEnd()
        .split("\n"),
    ).toHaveLength(5);
    expect(readFileSync(p, "utf8").trimEnd().split("\n")).toHaveLength(1);
  });

  it("initializes the byte counter from the file's existing size", async () => {
    dir = mkdtempSync(join(tmpdir(), "junco-rotsink-"));
    const p = join(dir, "worker.log");
    // 90 bytes already on disk — under maxBytes, so startup rotation skips it,
    // but the very first 20-byte write must trigger a mid-run rotation.
    writeFileSync(p, "y".repeat(90), "utf8");
    const sink = openRotatingLogSink(p, 100);
    sink.write("x".repeat(19));
    sink.close();
    await until(() => existsSync(p + ".1") && statSync(p).size === 20);
    expect(readFileSync(p + ".1", "utf8")).toBe("y".repeat(90));
  });

  it("still rotates an oversized file at open (startup behavior preserved)", async () => {
    dir = mkdtempSync(join(tmpdir(), "junco-rotsink-"));
    const p = join(dir, "worker.log");
    writeFileSync(p, "z".repeat(200), "utf8");
    const sink = openRotatingLogSink(p, 100);
    sink.write("a");
    sink.close();
    await until(() => statSync(p).size === 2);
    expect(readFileSync(p + ".1", "utf8")).toBe("z".repeat(200));
  });
});

// ---------------------------------------------------------------------------
// openAppendLogSink (#76) — non-daemon commands must NEVER rotate worker.log
// ---------------------------------------------------------------------------

describe("openAppendLogSink", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("appends without ever rotating, preserving the live daemon's log", async () => {
    // A second (non-lock-holding) sink on the daemon's worker.log must not
    // rename it aside — that clobbers the daemon's file and loses lines (#76).
    dir = mkdtempSync(join(tmpdir(), "junco-appendsink-"));
    const p = join(dir, "worker.log");
    writeFileSync(p, "y".repeat(200), "utf8"); // already over any rotation cap
    const sink = openAppendLogSink(p);
    sink.write("x".repeat(19)); // 19 + newline = 20 bytes
    sink.close();
    await until(() => statSync(p).size === 220);
    // No sibling generation was ever created — nothing was rotated away.
    expect(existsSync(p + ".1")).toBe(false);
    // The pre-existing content survives intact, with the new line appended.
    expect(readFileSync(p, "utf8")).toBe("y".repeat(200) + "x".repeat(19) + "\n");
  });
});
