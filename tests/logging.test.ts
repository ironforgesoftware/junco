import { describe, it, expect, vi } from "vitest";
import { log, withTicket } from "../src/logging.js";

function capture(fn: () => void): any[] {
  const lines: any[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { lines.push(JSON.parse(String(s))); return true; });
  try { fn(); } finally { spy.mockRestore(); }
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
});
