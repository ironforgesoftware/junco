import { readFile, mkdir, access, stat, readdir, glob, open } from "node:fs/promises";
import { constants } from "node:fs";
import { assertReadAllowed, assertWriteAllowed } from "./pathJail.js";
import type { SandboxPolicy } from "./policy.js";

// Every method is async so a synchronous jail violation (SandboxViolation
// thrown by assertRead/WriteAllowed) surfaces as a promise rejection — which is
// what the SDK's tool layer and the Operations contract expect.

// O_NOFOLLOW backstops the canonicalize-based jail (#158): even if a
// final-component symlink is swapped in between the jail check and the open()
// (TOCTOU), the kernel refuses to follow it. `abs` is already a fully-resolved,
// symlink-free path from assertWriteAllowed, so this never bites a legit write.
const WRITE_NOFOLLOW =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

async function writeFileNoFollow(abs: string, content: string): Promise<void> {
  const fh = await open(abs, WRITE_NOFOLLOW);
  try {
    await fh.writeFile(content);
  } finally {
    await fh.close();
  }
}

export interface ReadOperationsLike {
  readFile: (abs: string) => Promise<Buffer>;
  access: (abs: string) => Promise<void>;
  detectImageMimeType?: (abs: string) => Promise<string | null | undefined>;
}
export interface WriteOperationsLike {
  writeFile: (abs: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}
export interface EditOperationsLike {
  readFile: (abs: string) => Promise<Buffer>;
  writeFile: (abs: string, content: string) => Promise<void>;
  access: (abs: string) => Promise<void>;
}
export interface LsOperationsLike {
  exists: (abs: string) => Promise<boolean>;
  stat: (abs: string) => Promise<{ isDirectory: () => boolean }>;
  readdir: (abs: string) => Promise<string[]>;
}
export interface FindOperationsLike {
  exists: (abs: string) => Promise<boolean>;
  glob: (
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ) => Promise<string[]>;
}
export interface GrepOperationsLike {
  isDirectory: (abs: string) => Promise<boolean>;
  readFile: (abs: string) => Promise<string>;
}

export function makeJailedReadOperations(cwd: string, policy: SandboxPolicy): ReadOperationsLike {
  const R = (p: string): string => assertReadAllowed(p, cwd, policy);
  return {
    readFile: async (p) => readFile(R(p)),
    access: async (p) => access(R(p), constants.R_OK),
  };
}

export function makeJailedWriteOperations(cwd: string, policy: SandboxPolicy): WriteOperationsLike {
  const W = (p: string): string => assertWriteAllowed(p, cwd, policy);
  return {
    writeFile: async (p, content) => writeFileNoFollow(W(p), content),
    mkdir: async (dir) => {
      await mkdir(W(dir), { recursive: true });
    },
  };
}

export function makeJailedEditOperations(cwd: string, policy: SandboxPolicy): EditOperationsLike {
  const R = (p: string): string => assertReadAllowed(p, cwd, policy);
  const W = (p: string): string => assertWriteAllowed(p, cwd, policy);
  return {
    readFile: async (p) => readFile(R(p)),
    writeFile: async (p, content) => writeFileNoFollow(W(p), content),
    // Editing requires write scope; assert write (also normalizes traversal).
    access: async (p) => {
      W(p);
      await access(R(p), constants.R_OK);
    },
  };
}

export function makeJailedLsOperations(cwd: string, policy: SandboxPolicy): LsOperationsLike {
  const R = (p: string): string => assertReadAllowed(p, cwd, policy);
  return {
    exists: async (p) => {
      try {
        await access(R(p));
        return true;
      } catch {
        return false;
      }
    },
    stat: async (p) => stat(R(p)),
    readdir: async (p) => readdir(R(p)),
  };
}

export function makeJailedFindOperations(cwd: string, policy: SandboxPolicy): FindOperationsLike {
  const R = (p: string): string => assertReadAllowed(p, cwd, policy);
  return {
    exists: async (p) => {
      try {
        await access(R(p));
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, gcwd, options) => {
      // Confine the search root; the SDK passes an absolute cwd here.
      const root = R(gcwd);
      const out: string[] = [];
      for await (const entry of glob(pattern, { cwd: root, exclude: options.ignore } as never)) {
        out.push(String(entry));
        if (out.length >= options.limit) break;
      }
      return out;
    },
  };
}

export function makeJailedGrepOperations(cwd: string, policy: SandboxPolicy): GrepOperationsLike {
  const R = (p: string): string => assertReadAllowed(p, cwd, policy);
  return {
    isDirectory: async (p) => (await stat(R(p))).isDirectory(),
    readFile: async (p) => (await readFile(R(p))).toString(),
  };
}
