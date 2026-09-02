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
import { makeOpLock, lockOps } from "./opLock.js";

/** Thrown (fail-closed) when a sandbox backend is required but unavailable. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** The other fail-closed sandbox-setup refusal: an unenforceable POLICY (#311).
 *  Re-exported here alongside `SandboxUnavailableError` so callers that must
 *  tell a sandbox-setup refusal apart from a ticket failure — `doctor`'s
 *  preflight is the one that matters — have a single import site for both. */
export { SandboxPolicyError } from "./policy.js";

/** The seven built-in Pi tool names we know how to sandbox. */
const KNOWN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** A per-tool `create<X>ToolDefinition(cwd, options)` factory from the SDK. */
export type ToolDefFactory = (cwd: string, options: unknown) => unknown;

/**
 * SDK factories the sandbox wiring needs. These are the exact symbols the Pi
 * package root exports (verified in tests/sdkImportSurface.test.ts): the seven
 * per-tool definition factories + DefaultResourceLoader. Passed in from
 * makePiSessionFactory's dynamic import so this module stays SDK-free and
 * unit-testable with fakes.
 */
export interface SdkToolFactories {
  createBashToolDefinition: ToolDefFactory;
  createReadToolDefinition: ToolDefFactory;
  createWriteToolDefinition: ToolDefFactory;
  createEditToolDefinition: ToolDefFactory;
  createGrepToolDefinition: ToolDefFactory;
  createFindToolDefinition: ToolDefFactory;
  createLsToolDefinition: ToolDefFactory;
  DefaultResourceLoader: new (o: {
    cwd: string;
    agentDir: string;
    noExtensions?: boolean;
    noSkills?: boolean;
    noPromptTemplates?: boolean;
    noThemes?: boolean;
    noContextFiles?: boolean;
    appendSystemPromptOverride?: (base: string[]) => string[];
  }) => unknown;
}

export interface BuildSandboxOpts {
  cwd: string;
  toolNames: string[];
  backend: SandboxBackend;
  policy: SandboxPolicy;
  home: string;
  bashDeps?: BashOpsDeps;
  /** Chat (spec 2026-09-01 §6.5): appended to pi's default system prompt via
   *  the loader's `appendSystemPromptOverride`. When set, the loader also
   *  freezes skills/prompt-templates/themes/context-files (noExtensions is
   *  already unconditional) — a reload then does nothing but resolve the
   *  prompt, so the SDK's normal ambient discovery never runs. */
  appendSystemPrompt?: string;
}

export interface BuildSandboxResult {
  customTools: unknown[];
  resourceLoader: unknown;
}

/** The sandboxed operations object passed to a tool's `create<X>ToolDefinition`
 *  factory (the direct per-tool options, e.g. `{ operations }`). */
export function toolOptionsFor(
  name: string,
  cwd: string,
  backend: SandboxBackend,
  policy: SandboxPolicy,
  bashDeps?: BashOpsDeps,
): { operations: unknown } {
  switch (name) {
    case "bash":
      return { operations: makeSandboxedBashOperations(backend, policy, bashDeps) };
    case "read":
      return { operations: makeJailedReadOperations(cwd, policy) };
    case "write":
      return { operations: makeJailedWriteOperations(cwd, policy) };
    case "edit":
      return { operations: makeJailedEditOperations(cwd, policy) };
    case "ls":
      return { operations: makeJailedLsOperations(cwd, policy) };
    case "find":
      return { operations: makeJailedFindOperations(cwd, policy) };
    case "grep":
      return { operations: makeJailedGrepOperations(cwd, policy) };
    default:
      return { operations: undefined };
  }
}

function factoryFor(f: SdkToolFactories, name: string): ToolDefFactory | undefined {
  switch (name) {
    case "bash":
      return f.createBashToolDefinition;
    case "read":
      return f.createReadToolDefinition;
    case "write":
      return f.createWriteToolDefinition;
    case "edit":
      return f.createEditToolDefinition;
    case "ls":
      return f.createLsToolDefinition;
    case "find":
      return f.createFindToolDefinition;
    case "grep":
      return f.createGrepToolDefinition;
    default:
      return undefined;
  }
}

/**
 * Build sandboxed custom tools (one per allowlisted, known tool name) + a
 * no-extensions resource loader that freezes ambient ~/.pi extension loading.
 */
export function buildSandbox(
  factories: SdkToolFactories,
  opts: BuildSandboxOpts,
): BuildSandboxResult {
  const { cwd, toolNames, backend, policy, home, bashDeps, appendSystemPrompt } = opts;
  // One lock per session: bash runs exclusive, fs-ops shared, so no bash
  // execution ever overlaps an fs-op's check→syscall window and a compromised
  // agent cannot win a symlink-swap race against the in-process path jail (#159).
  const lock = makeOpLock();
  const customTools: unknown[] = [];
  for (const name of toolNames) {
    if (!KNOWN_TOOLS.has(name)) continue;
    const factory = factoryFor(factories, name);
    if (!factory) continue;
    const raw = toolOptionsFor(name, cwd, backend, policy, bashDeps).operations;
    const operations =
      raw && typeof raw === "object"
        ? lockOps(raw as object, lock, name === "bash" ? "exclusive" : "shared")
        : raw;
    customTools.push(factory(cwd, { operations }));
  }
  const resourceLoader = new factories.DefaultResourceLoader({
    cwd,
    agentDir: join(home, ".pi", "agent"),
    noExtensions: true,
    ...(appendSystemPrompt
      ? {
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          appendSystemPromptOverride: () => [appendSystemPrompt],
        }
      : {}),
  });
  return { customTools, resourceLoader };
}
