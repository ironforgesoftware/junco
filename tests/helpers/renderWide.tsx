// A faithful-width Ink renderer for frame assertions past column 100.
//
// WHY THIS EXISTS. ink-testing-library's fake Stdout hardcodes `columns = 100`
// (`get columns() { return 100 }` in its build/index.js — its `render` takes no
// options at all). Ink sizes its frame buffer from that: `Output.get()`
// pre-fills each row with exactly `width` space-cells, and a write landing at
// x >= width assigns PAST the end of that array — leaving real JS holes at the
// skipped columns. The very last step then does
// `line.filter(item => item !== undefined)`, which DELETES those holes instead
// of rendering them as spaces, so every column of whitespace beyond 100
// silently collapses.
//
// The visible result is text that reads glued: a 120-column footer whose
// pinned chips sit at columns 100-116 comes back as `…,  config? helpquit`
// rather than `…,  config     ? help  quit`. Nothing is wrong with the
// component — the frame is simply a lie past column 100. It has now cost two
// separate investigations (footer redesign round 0, and Task 7's frame smoke,
// which reported it as a Footer layout bug), so: if a test asserts on frame
// content that can sit beyond column 100 — anything right-aligned in a wide
// terminal — render it through here, where the buffer matches the layout.
//
// Suites whose assertions all sit left of column 100 do not need this.
import { EventEmitter } from "node:events";
import type { ReactElement } from "react";
import { render as inkRender } from "ink";

class Stdout extends EventEmitter {
  readonly frames: string[] = [];
  private lastOutput?: string;
  constructor(public readonly columns: number) {
    super();
  }
  write = (frame: string): void => {
    this.frames.push(frame);
    this.lastOutput = frame;
  };
  lastFrame = (): string | undefined => this.lastOutput;
}

class Stdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write = (data: string): void => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

export interface WideInstance {
  rerender: (tree: ReactElement) => void;
  unmount: () => void;
  stdout: Stdout;
  stdin: Stdin;
  frames: string[];
  lastFrame: () => string | undefined;
}

const instances: WideInstance[] = [];

/** Render `tree` into a buffer `columns` wide — mirrors ink-testing-library's
 * `render`, minus the hardcoded 100. Pair with `cleanupWide()` in an
 * `afterEach`; ink-testing-library's own `cleanup()` does not know about these
 * instances. */
export function renderWide(tree: ReactElement, columns: number): WideInstance {
  const stdout = new Stdout(columns);
  const stdin = new Stdin();
  const instance = inkRender(tree, {
    stdout: stdout as never,
    stderr: stdout as never,
    stdin: stdin as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const wide: WideInstance = {
    rerender: instance.rerender,
    unmount: instance.unmount,
    stdout,
    stdin,
    frames: stdout.frames,
    lastFrame: stdout.lastFrame,
  };
  instances.push(wide);
  return wide;
}

export function cleanupWide(): void {
  for (const instance of instances.splice(0)) instance.unmount();
}
