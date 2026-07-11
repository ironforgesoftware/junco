import { join } from "node:path";
import type { SandboxBackend } from "./backend.js";
import type { SandboxPolicy } from "./policy.js";
import { makeSandboxedBashOperations, type BashOpsDeps } from "./bashOps.js";
import {
  makeJailedReadOperations,
  makeJailedWriteOperations,
  makeJailedEditOperations,
  makeJailedLsOperations,
  makeJailedFindOperations,
  makeJailedGrepOperations,
} from "./fsOps.js";

/** Thrown (fail-closed) when a sandbox backend is required but unavailable. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** The seven built-in Pi tool names we know how to sandbox. */
const KNOWN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface SdkToolFactories {
  createToolDefinition: (name: string, cwd: string, options: unknown) => unknown;
  DefaultResourceLoader: new (o: {
    cwd: string;
    agentDir: string;
    noExtensions?: boolean;
  }) => unknown;
}

export interface BuildSandboxOpts {
  cwd: string;
  toolNames: string[];
  backend: SandboxBackend;
  policy: SandboxPolicy;
  home: string;
  bashDeps?: BashOpsDeps;
}

export interface BuildSandboxResult {
  customTools: unknown[];
  resourceLoader: unknown;
}

/** Build the ToolsOptions object that gives one tool its sandboxed operations. */
export function toolsOptionsFor(
  name: string,
  cwd: string,
  backend: SandboxBackend,
  policy: SandboxPolicy,
  bashDeps?: BashOpsDeps,
): Record<string, unknown> {
  switch (name) {
    case "bash":
      return { bash: { operations: makeSandboxedBashOperations(backend, policy, bashDeps) } };
    case "read":
      return { read: { operations: makeJailedReadOperations(cwd, policy) } };
    case "write":
      return { write: { operations: makeJailedWriteOperations(cwd, policy) } };
    case "edit":
      return { edit: { operations: makeJailedEditOperations(cwd, policy) } };
    case "ls":
      return { ls: { operations: makeJailedLsOperations(cwd, policy) } };
    case "find":
      return { find: { operations: makeJailedFindOperations(cwd, policy) } };
    case "grep":
      return { grep: { operations: makeJailedGrepOperations(cwd, policy) } };
    default:
      return {};
  }
}

/**
 * Build sandboxed custom tools + a no-extensions resource loader. `factories`
 * are the SDK functions (passed in from makePiSessionFactory's dynamic import)
 * so this module stays SDK-free and unit-testable with fakes.
 */
export function buildSandbox(
  factories: SdkToolFactories,
  opts: BuildSandboxOpts,
): BuildSandboxResult {
  const { cwd, toolNames, backend, policy, home, bashDeps } = opts;
  const customTools = toolNames
    .filter((n) => KNOWN_TOOLS.has(n))
    .map((n) =>
      factories.createToolDefinition(n, cwd, toolsOptionsFor(n, cwd, backend, policy, bashDeps)),
    );
  const resourceLoader = new factories.DefaultResourceLoader({
    cwd,
    agentDir: join(home, ".pi", "agent"),
    noExtensions: true,
  });
  return { customTools, resourceLoader };
}
