/**
 * src/tui/editFile.ts — the dashboard's `$EDITOR` hand-off (spec 2026-09-01
 * §8.6). Lifted out of App.tsx so the argv shape is testable without an
 * editor: a bare `spawn(EDITOR, [path])` cannot run `EDITOR="code --wait"`
 * (or `emacsclient -t`, or `subl -w`), and its ENOENT rejection used to reach
 * Node as an unhandled rejection through `void edit(d)`.
 */
import { describe, it, expect } from "vitest";
import { EDITOR_SH_SCRIPT, makeEditFile } from "../src/tui/editFile.js";

type Child = {
  on(event: string, cb: (arg?: unknown) => void): Child;
};

function fakeSpawn(behaviour: "exit" | "nonzero" | "error") {
  const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
  const spawnFn = (cmd: string, args: string[], opts: unknown): Child => {
    calls.push({ cmd, args, opts });
    const handlers = new Map<string, (arg?: unknown) => void>();
    const child: Child = {
      on(event, cb) {
        handlers.set(event, cb);
        return child;
      },
    };
    queueMicrotask(() => {
      if (behaviour === "error") handlers.get("error")?.(new Error("spawn sh ENOENT"));
      else handlers.get("exit")?.(behaviour === "nonzero" ? 1 : 0);
    });
    return child;
  };
  return { calls, spawnFn: spawnFn as never };
}

describe("makeEditFile (spec §8.6, Ruling R34)", () => {
  it("runs the editor through `sh -c` so EDITOR may carry arguments", async () => {
    const { calls, spawnFn } = fakeSpawn("exit");
    await makeEditFile({ spawnFn })("/drafts/d1/add-cache.md");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("sh");
    // git's own convention: the script word-splits $EDITOR, and the path
    // arrives as "$@" so a name with spaces is never re-split.
    expect(calls[0]!.args).toEqual(["-c", EDITOR_SH_SCRIPT, "sh", "/drafts/d1/add-cache.md"]);
    expect(EDITOR_SH_SCRIPT).toContain("${EDITOR:-vi}");
    expect(EDITOR_SH_SCRIPT).toContain('"$@"');
    expect(calls[0]!.opts).toEqual({ stdio: "inherit" });
  });

  it("a non-zero editor exit still resolves (the operator may have quit deliberately)", async () => {
    const { spawnFn } = fakeSpawn("nonzero");
    await expect(makeEditFile({ spawnFn })("/x.md")).resolves.toBeUndefined();
  });

  it("a spawn error rejects with the message rather than killing the process", async () => {
    const { spawnFn } = fakeSpawn("error");
    await expect(makeEditFile({ spawnFn })("/x.md")).rejects.toThrow(/spawn sh ENOENT/);
  });
});
