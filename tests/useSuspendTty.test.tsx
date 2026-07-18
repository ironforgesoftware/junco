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
