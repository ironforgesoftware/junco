import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { SandboxPolicy } from "./policy.js";

/** Thrown when a tool operation targets a path outside its allowed scope. */
export class SandboxViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxViolation";
  }
}

/** Resolve a tool-supplied path (relative, absolute, or ~-prefixed) to an
 *  absolute, normalized path. Traversal (`..`) is normalized away by resolve. */
export function resolveWithin(target: string, cwd: string): string {
  let t = target;
  if (t === "~") t = homedir();
  else if (t.startsWith("~/")) t = resolve(homedir(), t.slice(2));
  return resolve(cwd, t);
}

function isUnder(abs: string, root: string): boolean {
  const r = resolve(root);
  return abs === r || abs.startsWith(r + sep);
}

export function isUnderAnyRoot(abs: string, roots: string[]): boolean {
  return roots.some((r) => isUnder(abs, r));
}

export function isUnderAnyDeny(abs: string, denies: string[]): boolean {
  return denies.some((d) => isUnder(abs, d));
}

export function assertWriteAllowed(target: string, cwd: string, policy: SandboxPolicy): string {
  const abs = resolveWithin(target, cwd);
  if (!isUnderAnyRoot(abs, policy.writableRoots)) {
    throw new SandboxViolation(`sandbox: write denied outside worktree/scratch: ${abs}`);
  }
  return abs;
}

export function assertReadAllowed(target: string, cwd: string, policy: SandboxPolicy): string {
  const abs = resolveWithin(target, cwd);
  if (isUnderAnyDeny(abs, policy.readDenyPaths)) {
    throw new SandboxViolation(`sandbox: read denied (protected path): ${abs}`);
  }
  return abs;
}
