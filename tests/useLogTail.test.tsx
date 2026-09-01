// tests/useLogTail.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { Text } from "ink";
import {
  useLogTail,
  appendBounded,
  LOG_BUFFER_CAP,
  ROTATED_MARKER,
  type UseLogTailOpts,
} from "../src/tui/useLogTail.js";
import type { LogEntry, LogReaderDeps } from "../src/logReader.js";
import { until, wait } from "./helpers/until.js";

afterEach(cleanup);

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

const entry = (msg: string): LogEntry => ({
  ts: null,
  level: "info",
  ticket: null,
  msg,
  fields: {},
  raw: "",
});

// Copied from tests/logReader.test.ts (Task 1): a tiny in-memory file backing
// the fs deps, mutable via append/rotate.
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

/** Wraps a fakeFs's deps with call counters on statFn/readFn — used to prove
 * the visibility gate does zero I/O while `active` is false. */
function withSpies(deps: LogReaderDeps): {
  deps: LogReaderDeps;
  calls: { stat: number; read: number };
} {
  const calls = { stat: 0, read: 0 };
  const wrapped: LogReaderDeps = {
    ...deps,
    statFn: deps.statFn
      ? (p: string) => {
          calls.stat++;
          return deps.statFn!(p);
        }
      : undefined,
    readFn: deps.readFn
      ? (fd, buf, off, len, pos) => {
          calls.read++;
          return deps.readFn!(fd, buf, off, len, pos);
        }
      : undefined,
  };
  return { deps: wrapped, calls };
}

function Probe({ path, active, opts }: { path: string; active: boolean; opts?: UseLogTailOpts }) {
  const entries = useLogTail(path, active, opts);
  return (
    <Text>
      count={entries.length}|{entries.map((e) => e.msg).join(",")}
    </Text>
  );
}

describe("appendBounded", () => {
  it("appends and caps to the last `cap` entries", () => {
    const out = appendBounded([entry("a"), entry("b")], [entry("c")], 2);
    expect(out.map((e) => e.msg)).toEqual(["b", "c"]);
  });
  it("cap default is 2000", () => expect(LOG_BUFFER_CAP).toBe(2000));
  it("returns the same buffer reference when there is nothing to add", () => {
    const buf = [entry("a")];
    expect(appendBounded(buf, [], 10)).toBe(buf);
  });
});

describe("useLogTail", () => {
  it("behavior 1: active=true seeds the last seedN lines immediately", async () => {
    const f = fakeFs(
      [line({ msg: "a" }), line({ msg: "b" }), line({ msg: "c" }), line({ msg: "d" }), ""].join(
        "\n",
      ),
    );
    const r = render(
      <Probe path="/w.log" active={true} opts={{ readerDeps: f.deps, seedN: 3, pollMs: 15 }} />,
    );
    await until(() => (r.lastFrame() ?? "").includes("count=3"));
    expect(r.lastFrame()).toContain("count=3|b,c,d");
  });

  it("behavior 2: new appends to the file appear on the next poll", async () => {
    const f = fakeFs(line({ msg: "old" }) + "\n");
    const r = render(
      <Probe path="/w.log" active={true} opts={{ readerDeps: f.deps, seedN: 10, pollMs: 15 }} />,
    );
    await until(() => (r.lastFrame() ?? "").includes("count=1"));
    f.append(line({ msg: "new1" }) + "\n" + line({ msg: "new2" }) + "\n");
    await until(() => (r.lastFrame() ?? "").includes("count=3"));
    expect(r.lastFrame()).toContain("count=3|old,new1,new2");
  });

  it("behavior 3: active=false from the start never touches the fs and returns []", async () => {
    const f = fakeFs(line({ msg: "a" }) + "\n" + line({ msg: "b" }) + "\n");
    const { deps, calls } = withSpies(f.deps);
    const r = render(
      <Probe path="/w.log" active={false} opts={{ readerDeps: deps, seedN: 10, pollMs: 15 }} />,
    );
    // Negative assertion: give several poll intervals' worth of time for a
    // violation to show up, then assert the counters never moved.
    await wait(100);
    expect(calls.stat).toBe(0);
    expect(calls.read).toBe(0);
    expect(r.lastFrame()).toContain("count=0|");
  });

  it("behavior 4: active true→false clears the buffer; flipping back re-seeds", async () => {
    const f = fakeFs(line({ msg: "a" }) + "\n" + line({ msg: "b" }) + "\n");
    const opts: UseLogTailOpts = { readerDeps: f.deps, seedN: 10, pollMs: 15 };
    const r = render(<Probe path="/w.log" active={true} opts={opts} />);
    await until(() => (r.lastFrame() ?? "").includes("count=2"));

    r.rerender(<Probe path="/w.log" active={false} opts={opts} />);
    await until(() => (r.lastFrame() ?? "").includes("count=0|"));

    r.rerender(<Probe path="/w.log" active={true} opts={opts} />);
    await until(() => (r.lastFrame() ?? "").includes("count=2"));
    expect(r.lastFrame()).toContain("count=2|a,b");
  });

  it("behavior 5: a rotation inserts one ROTATED_MARKER row before the fresh lines", async () => {
    // "before" (17 bytes incl. newline) must byte-outweigh "fresh" (16 bytes)
    // for this to actually exercise the shrink path — mirrors the logReader
    // rotation test's byte-size comment.
    const f = fakeFs(line({ msg: "before" }) + "\n");
    const r = render(
      <Probe path="/w.log" active={true} opts={{ readerDeps: f.deps, seedN: 10, pollMs: 15 }} />,
    );
    await until(() => (r.lastFrame() ?? "").includes("count=1"));

    f.rotate(line({ msg: "fresh" }) + "\n");
    await until(() => (r.lastFrame() ?? "").includes(ROTATED_MARKER.msg));

    // The seeded "before" row is still in the buffer — appendBounded appends,
    // it doesn't replace — so the marker lands between the seed and "fresh".
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain(`count=3|before,${ROTATED_MARKER.msg},fresh`);
  });
});
