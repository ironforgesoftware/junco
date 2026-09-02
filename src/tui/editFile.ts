/**
 * The dashboard's `$EDITOR` hand-off for the chat draft `e` verb (spec
 * 2026-09-01 §8.6). Its own module so the argv shape sits behind a `spawnFn`
 * seam instead of inside App.tsx.
 *
 * Ruling R34: `spawn(process.env.EDITOR ?? "vi", [path])` treats the whole
 * variable as one program name, so the perfectly ordinary `EDITOR="code
 * --wait"` (or `emacsclient -t`, or `subl -w`) is an ENOENT — as is a host
 * with no `vi`. Running it through `sh -c` is git's own convention: the
 * shell word-splits `$EDITOR` and the file arrives as `"$@"`, so a path with
 * spaces is not re-split.
 */
import { spawn } from "node:child_process";

/** `sh -c <script> sh <path>`: `$0` is the throwaway "sh", `"$@"` is the
 *  file. `$EDITOR` is deliberately unquoted — that word-splitting is what
 *  makes `EDITOR="code --wait"` work — and falls back to vi. */
export const EDITOR_SH_SCRIPT = 'exec ${EDITOR:-vi} "$@"';

export interface EditFileDeps {
  /** node:child_process spawn, injected in tests so no editor ever runs. */
  spawnFn?: typeof spawn;
}

/**
 * Hand the terminal to `$EDITOR` for one file and resolve when it exits.
 * Always called from inside useSuspend, which has already blanked Ink and
 * dropped raw mode.
 *
 * A non-zero editor exit is still a resolve — the operator may have quit
 * deliberately, and the re-lint that follows reads whatever is on disk either
 * way. A spawn FAILURE rejects: `useChatDrafts` catches it and toasts, which
 * is the contract every `editFileFn` must honour.
 */
export function makeEditFile(deps: EditFileDeps = {}): (path: string) => Promise<void> {
  const spawnFn = deps.spawnFn ?? spawn;
  return (path: string) =>
    new Promise<void>((resolve_, reject) => {
      const child = spawnFn("sh", ["-c", EDITOR_SH_SCRIPT, "sh", path], { stdio: "inherit" });
      child.on("exit", () => resolve_());
      child.on("error", reject);
    });
}

/** The default `editFileFn` (AppProps). */
export const defaultEditFile = makeEditFile();
