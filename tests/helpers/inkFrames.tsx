// tests/helpers/inkFrames.tsx — mount the real App under Ink's own render()
// so committed FRAMES are observable. ink-testing-library cannot see a frame
// whose output is identical to the previous one (Ink skips the write), but
// Ink still paid the layout + compositor cost — `onRender` reports every one.
import React from "react";
import { render as inkRender } from "ink";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { App, type AppProps } from "../../src/tui/App.js";
import { MouseProvider } from "../../src/tui/MouseProvider.js";
import { makeAppProps } from "./localFixtures.js";

export interface FrameMount {
  /** Ink's own `renderTime` (ms) for every frame committed since `reset()`. */
  frames: number[];
  /** Bytes written to the fake stdout since `reset()`. */
  bytes: () => number;
  reset: () => void;
  unmount: () => void;
}

export interface FrameMountOpts {
  columns?: number; // default 120 (wide layout, like localFixtures)
  rows?: number; // default 30
  incrementalRendering?: boolean; // default false (Ink's default)
}

interface CountingStdout extends NodeJS.WriteStream {
  bytesCounted: () => number;
  resetBytes: () => void;
}

function fakeStdout(columns: number, rows: number): CountingStdout {
  let bytes = 0;
  const s = new Writable({
    write(chunk, _enc, cb) {
      bytes += chunk.length;
      cb();
    },
  }) as unknown as CountingStdout;
  Object.assign(s, {
    columns,
    rows,
    isTTY: true,
    bytesCounted: () => bytes,
    resetBytes: () => {
      bytes = 0;
    },
  });
  return s;
}

function fakeStdin(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(s, {
    isTTY: true,
    setRawMode: () => s,
    setEncoding: () => s,
    read: () => null,
    ref: () => s,
    unref: () => s,
    pause: () => s,
    resume: () => s,
  });
  return s;
}

export function mountForFrames(
  over: Partial<AppProps> = {},
  opts: FrameMountOpts = {},
): FrameMount {
  const columns = opts.columns ?? 120;
  const rows = opts.rows ?? 30;
  const stdout = fakeStdout(columns, rows);
  const frames: number[] = [];
  const inst = inkRender(
    <MouseProvider>
      <App {...makeAppProps({ sizeOverride: { columns, rows }, ...over })} />
    </MouseProvider>,
    {
      stdout,
      stdin: fakeStdin(),
      stderr: fakeStdout(columns, rows),
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: true,
      incrementalRendering: opts.incrementalRendering ?? false,
      // Ink defaults `interactive` to `!isInCi && stdout.isTTY`; under CI=true
      // it would count frames (onRender still fires) but write no bytes, so
      // `bytes()` would silently read 0 there. Force the production mode.
      interactive: true,
      onRender: (m) => {
        frames.push(m.renderTime);
      },
    },
  );
  return {
    frames,
    bytes: () => stdout.bytesCounted(),
    reset: () => {
      frames.length = 0;
      stdout.resetBytes();
    },
    unmount: () => inst.unmount(),
  };
}
