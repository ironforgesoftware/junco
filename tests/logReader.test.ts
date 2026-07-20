// tests/logReader.test.ts
import { describe, it, expect } from "vitest";
import { parseLogLine, readTail, makeLogTailer, type LogReaderDeps } from "../src/logReader.js";

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

describe("parseLogLine", () => {
  it("parses a structured JSON line and strips canonical keys into fields", () => {
    const e = parseLogLine(
      line({
        ts: "2026-07-20T05:00:00.000Z",
        level: "warn",
        ticket: "junco-46",
        msg: "guard nudge",
        turn: 14,
      }),
    );
    expect(e).toEqual({
      ts: "2026-07-20T05:00:00.000Z",
      level: "warn",
      ticket: "junco-46",
      msg: "guard nudge",
      fields: { turn: 14 },
      raw: line({
        ts: "2026-07-20T05:00:00.000Z",
        level: "warn",
        ticket: "junco-46",
        msg: "guard nudge",
        turn: 14,
      }),
    });
  });

  it("normalizes ticket '-' to null and defaults a missing level to null", () => {
    const e = parseLogLine(line({ ts: "t", ticket: "-", msg: "x" }));
    expect(e.ticket).toBeNull();
    expect(e.level).toBeNull();
  });

  it("passes a non-JSON line through as raw at level null", () => {
    const e = parseLogLine("Segmentation fault (core dumped)");
    expect(e).toEqual({
      ts: null,
      level: null,
      ticket: null,
      msg: "Segmentation fault (core dumped)",
      fields: {},
      raw: "Segmentation fault (core dumped)",
    });
  });

  it("treats an unknown level string as null (not a fabricated level)", () => {
    expect(parseLogLine(line({ level: "trace", msg: "x" })).level).toBeNull();
  });
});

// A tiny in-memory file backing the fs deps: a mutable string with a byte view.
function fakeFs(initial = "") {
  let content = Buffer.from(initial, "utf8");
  const deps: LogReaderDeps = {
    existsFn: () => content !== null,
    statFn: () => ({ size: content.length }),
    openFn: () => 1,
    closeFn: () => undefined,
    readFn: (_fd, buf, off, len, pos) => {
      const slice = content.subarray(pos, pos + len);
      slice.copy(buf, off);
      return slice.length;
    },
  };
  return {
    deps,
    append: (s: string) => {
      content = Buffer.concat([content, Buffer.from(s, "utf8")]);
    },
    rotate: (s = "") => {
      content = Buffer.from(s, "utf8");
    }, // shrink → rotation
  };
}

describe("readTail", () => {
  it("returns the last n parsed entries, newest last", () => {
    const f = fakeFs([line({ msg: "a" }), line({ msg: "b" }), line({ msg: "c" }), ""].join("\n"));
    expect(readTail("/w.log", 2, f.deps).map((e) => e.msg)).toEqual(["b", "c"]);
  });
  it("returns [] when the file is absent", () => {
    const deps: LogReaderDeps = { existsFn: () => false };
    expect(readTail("/nope.log", 5, deps)).toEqual([]);
  });
});

describe("makeLogTailer", () => {
  it("returns only lines appended after creation (starts at EOF)", () => {
    const f = fakeFs(line({ msg: "old" }) + "\n");
    const t = makeLogTailer("/w.log", f.deps);
    expect(t.poll()).toEqual([]); // nothing new yet
    f.append(line({ msg: "new1" }) + "\n" + line({ msg: "new2" }) + "\n");
    expect(t.poll().map((e) => e.msg)).toEqual(["new1", "new2"]);
    expect(t.poll()).toEqual([]); // no change
  });

  it("carries a partial trailing line across polls", () => {
    const f = fakeFs("");
    const t = makeLogTailer("/w.log", f.deps);
    f.append(line({ msg: "half" }).slice(0, 5)); // no newline yet
    expect(t.poll()).toEqual([]); // partial line withheld
    f.append(line({ msg: "half" }).slice(5) + "\n");
    expect(t.poll().map((e) => e.msg)).toEqual(["half"]);
  });

  it("resets to head and flags rotated on size shrink", () => {
    // "before" (17 bytes incl. newline) must byte-outweigh "fresh" (16 bytes)
    // for this to actually exercise the shrink path; "a" (12 bytes) does not.
    const f = fakeFs(line({ msg: "before" }) + "\n");
    const t = makeLogTailer("/w.log", f.deps);
    t.poll();
    f.rotate(line({ msg: "fresh" }) + "\n"); // smaller file
    const out = t.poll();
    expect(t.rotated).toBe(true);
    expect(out.map((e) => e.msg)).toEqual(["fresh"]);
  });
});
