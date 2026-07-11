import { spawn as realSpawn } from "node:child_process";
import { scrubEnv } from "../../scrubEnv.js";
import type { SandboxBackend } from "./backend.js";
import type { SandboxPolicy } from "./policy.js";

/** Structural mirror of the SDK's BashOperations.exec options (no SDK import). */
export interface BashExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

/** Structural mirror of the SDK's BashOperations interface. */
export interface BashOperationsLike {
  exec: (
    command: string,
    cwd: string,
    options: BashExecOptions,
  ) => Promise<{ exitCode: number | null }>;
}

export interface BashOpsDeps {
  spawnFn?: typeof realSpawn;
  /** Source env before scrubbing; defaults to process.env. Injectable for tests. */
  env?: () => Record<string, string | undefined>;
}

/**
 * Build a BashOperations that runs the model's command under the OS sandbox
 * backend with a scrubbed env (no GH_TOKEN / API keys) and TMPDIR redirected to
 * the per-session scratch dir. Ignores any caller-supplied env — the scrubbed
 * env is built fresh so credential containment never depends on the caller.
 */
export function makeSandboxedBashOperations(
  backend: SandboxBackend,
  policy: SandboxPolicy,
  deps: BashOpsDeps = {},
): BashOperationsLike {
  const spawnFn = deps.spawnFn ?? realSpawn;
  const envSource = deps.env ?? (() => process.env);

  return {
    exec(command, cwd, options) {
      const [bin, ...args] = backend.spawnArgv(command, policy);
      const env = { ...scrubEnv(envSource()), TMPDIR: policy.scratchDir };

      return new Promise<{ exitCode: number | null }>((resolve) => {
        const proc = spawnFn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
        let settled = false;
        const finish = (exitCode: number | null): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (options.signal) options.signal.removeEventListener("abort", onAbort);
          resolve({ exitCode });
        };

        proc.stdout?.on("data", (c: Buffer) => options.onData(c));
        proc.stderr?.on("data", (c: Buffer) => options.onData(c));

        const timer = options.timeout
          ? setTimeout(() => proc.kill("SIGKILL"), options.timeout)
          : undefined;

        const onAbort = (): void => {
          proc.kill("SIGKILL");
        };
        if (options.signal) {
          if (options.signal.aborted) proc.kill("SIGKILL");
          else options.signal.addEventListener("abort", onAbort);
        }

        proc.on("error", () => finish(null));
        proc.on("close", (code: number | null) => finish(code));
      });
    },
  };
}
