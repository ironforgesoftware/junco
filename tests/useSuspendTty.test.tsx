/** useSuspend against real ink render() on fake TTY streams (#216): with a
 * mounted useInput consumer holding Ink's reference-counted raw mode, the
 * suspension must still restore cooked mode on the actual tty — bypassing the
 * counted wrapper — before the child runs, and re-raw it afterwards. */
import { describe, it, expect, afterEach } from "vitest";
import React, { useEffect } from "react";
import { EventEmitter } from "node:events";
import { render, Text, useInput } from "ink";
import { until } from "./helpers/until.js";
import { useSuspend, SuspendProvider } from "../src/tui/useSuspend.js";

type Ev = string;

function fakeTtyStreams(log: Ev[]): {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
} {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: (v: boolean) => {
      log.push(v ? "raw:true" : "raw:false");
      return stdin;
    },
    setEncoding: () => stdin,
    read: () => null,
    unref: () => stdin,
    ref: () => stdin,
    pause: () => {
      log.push("pause");
      return stdin;
    },
    resume: () => {
      log.push("resume");
      return stdin;
    },
  });
  const stdout = new EventEmitter() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (chunk: string) => {
      if (chunk.includes("\x1b[?1049l")) log.push("alt:leave");
      if (chunk.includes("\x1b[?1049h")) log.push("alt:enter");
      return true;
    },
  });
  return { stdin, stdout };
}

/** Like fakeTtyStreams, but stdout keeps every chunk so the bytes written
 * after the alt-screen re-entry can be inspected. */
function recordingTtyStreams(chunks: string[]): {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
} {
  const { stdin } = fakeTtyStreams([]);
  const stdout = new EventEmitter() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
  });
  return { stdin, stdout };
}

function lastAltEnter(chunks: string[]): number {
  let idx = -1;
  chunks.forEach((c, i) => {
    if (c.includes("\x1b[?1049h")) idx = i;
  });
  return idx;
}

let unmountFn: (() => void) | null = null;
afterEach(() => {
  unmountFn?.();
  unmountFn = null;
});

describe("useSuspend on a real tty with a mounted useInput holder", () => {
  it("drops raw mode on the actual stream before the child runs, restores after", async () => {
    const log: Ev[] = [];
    let done = false;
    function Probe(): React.JSX.Element {
      useInput(() => {}); // the raw-mode holder — mirrors the wizard's chapters
      const suspend = useSuspend();
      useEffect(() => {
        void suspend(async () => {
          log.push("child:runs");
        }).then(() => {
          done = true;
        });
      }, []);
      return <Text>probe</Text>;
    }
    const { stdin, stdout } = fakeTtyStreams(log);
    const app = render(
      <SuspendProvider>
        <Probe />
      </SuspendProvider>,
      { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
    );
    unmountFn = () => app.unmount();
    await until(() => done);

    const child = log.indexOf("child:runs");
    expect(child).toBeGreaterThan(-1);
    const before = log.slice(0, child);
    const after = log.slice(child + 1);
    // Cooked mode must be REAL before gh runs: the last raw-mode call on the
    // actual stream is false. Ink's counted wrapper never crosses zero here
    // (useInput holds it), so on the broken code this stays "raw:true".
    expect(before.filter((e) => e.startsWith("raw:")).at(-1)).toBe("raw:false");
    expect(before).toContain("alt:leave");
    expect(before).toContain("pause");
    // …and the terminal is handed back exactly as Ink believes it to be.
    expect(after.filter((e) => e.startsWith("raw:")).at(-1)).toBe("raw:true");
    expect(after).toContain("alt:enter");
    expect(after).toContain("resume");
  });
});

describe("useSuspend under incrementalRendering", () => {
  it("repaints the whole UI after resume, not a diff against the pre-suspend frame", async () => {
    const chunks: string[] = [];
    let done = false;
    function Probe(): React.JSX.Element {
      const suspend = useSuspend();
      useEffect(() => {
        // Realistic timing, deliberately: Ink throttles frames to one per
        // ~33 ms window (maxFps 30). Suspending inside the MOUNT frame's
        // window and resuming from an instant child lets the blank frame and
        // the resume frame coalesce into one trailing render whose output
        // equals the last written one — so nothing is written at all, in
        // either mode. A real handoff (gh's device flow) is seconds long; a
        // throttle-window gap on both sides reproduces that shape.
        const t = setTimeout(() => {
          void suspend(async () => {
            await new Promise((r) => setTimeout(r, 100));
          }).then(() => {
            done = true;
          });
        }, 100);
        return () => clearTimeout(t);
      }, []);
      return (
        <>
          <Text>line-alpha</Text>
          <Text>line-bravo</Text>
          <Text>line-charlie</Text>
        </>
      );
    }
    const { stdin, stdout } = recordingTtyStreams(chunks);
    const app = render(
      <SuspendProvider>
        <Probe />
      </SuspendProvider>,
      { stdin, stdout, exitOnCtrlC: false, patchConsole: false, incrementalRendering: true },
    );
    unmountFn = () => app.unmount();
    await until(() => done);
    // Let the post-resume commit land (bounded): the resumed frame must be on the wire.
    await until(() =>
      chunks
        .slice(lastAltEnter(chunks) + 1)
        .join("")
        .includes("line-charlie"),
    );

    const after = chunks.slice(lastAltEnter(chunks) + 1).join("");
    // Incremental log-update diffs against the EMPTY frame written during
    // suspension (the erase sequence lands BEFORE the alt-screen leave), so
    // every line is rewritten on resume — the cleared alt screen shows
    // nothing to diff against. All three lines must be present after re-entry.
    const leave = chunks.findIndex((c) => c.includes("\x1b[?1049l"));
    expect(leave).toBeGreaterThan(-1);
    expect(chunks.slice(0, leave).join("")).toContain("\x1b[2K"); // the blank frame's erase
    expect(after).toContain("line-alpha");
    expect(after).toContain("line-bravo");
    expect(after).toContain("line-charlie");
  });
});
