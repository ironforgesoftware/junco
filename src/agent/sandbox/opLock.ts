/**
 * Readers-writer lock guarding the sandbox's in-process fs tools against a
 * concurrent bash-planted symlink swap (#159). fs-ops run SHARED (they cannot
 * create symlinks, so they are safe to run concurrently with each other); the
 * bash tool runs EXCLUSIVE for its whole subprocess lifetime, so no bash
 * execution ever overlaps an fs-op's check→syscall window. Writer-priority
 * keeps a stream of fs-ops from starving a pending bash.
 */
export interface OpLock {
  runShared<T>(fn: () => Promise<T>): Promise<T>;
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export function makeOpLock(): OpLock {
  let sharedCount = 0;
  let exclusiveActive = false;
  const queue: Array<{ exclusive: boolean; grant: () => void }> = [];

  function dispatch(): void {
    while (queue.length > 0) {
      const head = queue[0];
      if (head.exclusive) {
        if (sharedCount === 0 && !exclusiveActive) {
          queue.shift();
          exclusiveActive = true;
          head.grant();
        }
        return; // writer-priority: nothing behind an ungranted writer proceeds
      }
      if (exclusiveActive) return;
      queue.shift();
      sharedCount++;
      head.grant();
      // keep granting consecutive shared waiters at the head
    }
  }

  function acquire(exclusive: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      queue.push({ exclusive, grant: resolve });
      dispatch();
    });
  }

  return {
    async runShared<T>(fn: () => Promise<T>): Promise<T> {
      await acquire(false);
      try {
        return await fn();
      } finally {
        sharedCount--;
        dispatch();
      }
    },
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      await acquire(true);
      try {
        return await fn();
      } finally {
        exclusiveActive = false;
        dispatch();
      }
    },
  };
}

/** Wrap an operations object so every function-valued property runs under
 * `lock` in the given mode. Non-function properties pass through. */
export function lockOps<T extends object>(ops: T, lock: OpLock, mode: "shared" | "exclusive"): T {
  const run = mode === "shared" ? lock.runShared.bind(lock) : lock.runExclusive.bind(lock);
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(ops) as (keyof T)[]) {
    const v = ops[key];
    out[key as string] =
      typeof v === "function"
        ? (...args: unknown[]): Promise<unknown> =>
            run(() => (v as (...a: unknown[]) => Promise<unknown>)(...args))
        : v;
  }
  return out as T;
}
