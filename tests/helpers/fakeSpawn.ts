import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

/** A ChildProcess-shaped fake: `script` drives stdout/stderr/close on the
 * next tick. `calls` records each spawn's argv (the cli path first). */
export class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string | null = null;
  kill(sig: string): boolean {
    this.killed = sig;
    this.emit("close", null);
    return true;
  }
}

export function fakeSpawn(script: (child: FakeChild) => void): {
  spawnFn: typeof spawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawnFn = ((_exe: string, args: string[]) => {
    calls.push(args);
    const child = new FakeChild();
    setTimeout(() => script(child), 1);
    return child;
  }) as unknown as typeof spawn;
  return { spawnFn, calls };
}
