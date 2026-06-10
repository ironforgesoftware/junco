import { describe, it, expect, vi, afterEach } from "vitest";
import { log, withTicket, setLogLevel } from "../src/logging.js";

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
