/**
 * tests/e2e/harness.ts — the black-box sandbox every e2e scenario runs in.
 *
 * One `createSandbox()` gives a scenario the four ingredients the spec names
 * (docs/superpowers/specs/2026-09-01-e2e-testing-design.md §4): a sandboxed
 * HOME with a hand-written config.json, a real bare git remote + clone, a
 * fake `gh` that logs every call, and the scripted model stub — then spawns
 * the binary under test with a SCRUBBED environment so nothing here can reach
 * the maintainer's live ~/.junco.
 *
 * Reuses the unit suite's fixtures on purpose: `cloneHarness` (bare remote +
 * seeded clone) and `ghCases` (case-table fake gh with no permissive default —
 * an unscripted subcommand fails loud with `fake-gh: unhandled: <args>`, which
 * is how a scenario discovers the exact table it needs).
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { onTestFailed } from "vitest";
import { cloneHarness, run, type GitHarness } from "../helpers/gitHarness.js";
import { ghCases } from "../helpers/ghScript.js";
import { TICKET_FRONTMATTER_JSON_SCHEMA } from "../../src/ticketSchema.js";
import { parseTranscriptLine, type ParsedLine } from "../../src/agent/transcriptSchema.js";
import { startStubModel, type RecordedRequest, type StubModel, type Turn } from "./stubModel.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** The only inherited vars a child gets: the toolchain needs PATH; git/node need a locale. */
const PASSTHROUGH = ["PATH", "LANG", "LC_ALL", "LC_CTYPE"] as const;

/**
 * A scrubbed environment for the binary under test. Everything is anchored in
 * the sandbox; nothing else is inherited — no `JUNCO_*`, no real HOME, no API
 * keys — so even a harness bug cannot reach the maintainer's live runtime.
 * Git identity is fixed so the agent's `git commit` never depends on ~/.gitconfig.
 */
export function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: join(home, "tmp"),
    GIT_AUTHOR_NAME: "e2e",
    GIT_AUTHOR_EMAIL: "e2e@example.invalid",
    GIT_COMMITTER_NAME: "e2e",
    GIT_COMMITTER_EMAIL: "e2e@example.invalid",
  };
  for (const k of PASSTHROUGH) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** argv prefix for the CLI under test: `JUNCO_E2E_BIN` (packaging layer) or the built dist. */
export function binaryUnderTest(): string[] {
  const override = process.env.JUNCO_E2E_BIN;
  if (override) return [override];
  return [process.execPath, resolve(process.cwd(), "dist/cli.js")];
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export interface SandboxOptions {
  /** Turns for the stub model. Exactly one of `script` / `model` is required. */
  script?: Turn[];
  /** Explicit model config — the live layer. */
  model?: { id: string; baseUrl: string; apiKey: string };
  /** Deep-merged over the baseline config literal; state only what the scenario changes. */
  config?: Record<string, unknown>;
  /** Extra fake-gh cases (`"glob"*` → sh body), merged over `defaultGhCases`. */
  ghCases?: Record<string, string>;
  /** nameWithOwner the fake gh reports. */
  nwo?: string;
}

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Sandbox {
  home: string;
  configPath: string;
  dataDir: string;
  queueRoot: string;
  git: GitHarness;
  stub: StubModel | null;
  ghBin: string;
  healthPort: number;
  nwo: string;
  bin: string[];
  env: Record<string, string>;
  /** The most recent `runCli` / daemon result — dumped by the failure diagnostics. */
  lastRun: CliResult | null;
  close(): Promise<void>;
}

/** The gh subcommands the PR flow needs on its happy path. Each body is prefixed with the gh.log line by `createSandbox`. */
export function defaultGhCases(nwo: string): Record<string, string> {
  return {
    '"pr list "*': 'echo "[]"',
    '"pr create "*': `echo "https://github.com/${nwo}/pull/1"`,
  };
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => res(port));
    });
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out;
}

function tail(s: string, lines = 80): string {
  const all = s.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function readIfExists(p: string): string {
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** The first path in `paths` that exists, or null. Shared by `transcript()` and the worker.log diagnostic — both probe v2-then-flat data layouts (src/dataTree.ts). */
function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function registerDiagnostics(sb: Sandbox): void {
  onTestFailed(() => {
    const out: string[] = [`--- e2e diagnostics (sandbox ${sb.home}) ---`];
    const q = listQueue(sb);
    out.push(`queue: ${JSON.stringify(q)}`);
    out.push(
      `stub: requests=${sb.stub?.requests.length ?? "n/a"} exhausted=${String(sb.stub?.exhausted ?? "n/a")}`,
    );
    out.push(`gh.log:\n${readIfExists(join(sb.home, "gh.log")) || "(empty)"}`);
    if (sb.lastRun) {
      out.push(
        `last run: code=${String(sb.lastRun.code)} signal=${String(sb.lastRun.signal)} timedOut=${String(sb.lastRun.timedOut)}`,
      );
      out.push(`stdout (tail):\n${tail(sb.lastRun.stdout)}`);
      out.push(`stderr (tail):\n${tail(sb.lastRun.stderr)}`);
    }
    const workerLog = firstExisting([
      join(sb.dataDir, "logs", "worker.log"),
      join(sb.dataDir, "worker.log"),
    ]);
    out.push(`worker.log (tail):\n${tail(workerLog === null ? "" : readIfExists(workerLog))}`);
    out.push(
      process.env.JUNCO_E2E_KEEP
        ? `sandbox retained at ${sb.home}`
        : "set JUNCO_E2E_KEEP=1 to retain the sandbox",
    );
    console.error(out.join("\n"));
  });
}

/**
 * Build a sandbox. Async because the stub must be listening before its URL
 * can go into config.json, and because the queue root is asked of the product
 * (`junco inbox-path`) rather than hard-coded.
 */
export async function createSandbox(opts: SandboxOptions = {}): Promise<Sandbox> {
  if ((opts.script === undefined) === (opts.model === undefined)) {
    throw new Error("createSandbox: pass exactly one of `script` (stub) or `model` (live)");
  }
  const home = mkdtempSync(join(tmpdir(), "junco-e2e-"));
  for (const d of [".config", "tmp", "bin", "git", ".junco"])
    mkdirSync(join(home, d), { recursive: true });

  const git = cloneHarness(join(home, "git"));
  const nwo = opts.nwo ?? "e2e/repo";
  const stubModel = opts.script ? await startStubModel(opts.script) : null;
  const healthPort = await freePort();

  const logLine = `printf '%s\\n' "$args" >> "${join(home, "gh.log")}";`;
  const cases = Object.fromEntries(
    Object.entries({ ...defaultGhCases(nwo), ...(opts.ghCases ?? {}) }).map(([glob, body]) => [
      glob,
      `${logLine} ${body}`,
    ]),
  );
  const ghBin = ghCases(join(home, "bin"), "gh", cases, nwo);

  const model = opts.model ?? {
    id: "e2e/stub",
    baseUrl: (stubModel as StubModel).url,
    apiKey: "e2e",
  };
  const config = deepMerge(
    {
      model: {
        id: model.id,
        api: "openai-completions",
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
      },
      git: { ghBin },
      observability: { healthPort },
    },
    opts.config ?? {},
  );
  const dataDir = join(home, ".junco");
  const configPath = join(dataDir, "config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const sb: Sandbox = {
    home,
    configPath,
    dataDir,
    queueRoot: "",
    git,
    stub: stubModel,
    ghBin,
    healthPort,
    nwo,
    bin: binaryUnderTest(),
    env: childEnv(home),
    lastRun: null,
    close: async () => {
      await stubModel?.close();
      if (process.env.JUNCO_E2E_KEEP)
        console.error(`JUNCO_E2E_KEEP set — sandbox retained at ${home}`);
      else rmSync(home, { recursive: true, force: true });
    },
  };

  try {
    const r = await runCli(sb, ["inbox-path"], { timeoutMs: 30_000 });
    if (r.code !== 0)
      throw new Error(`junco inbox-path failed (exit ${String(r.code)}):\n${r.stderr}`);
    sb.queueRoot = dirname(r.stdout.trim());
  } catch (e) {
    await sb.close();
    throw e;
  }
  registerDiagnostics(sb);
  return sb;
}

// ---------------------------------------------------------------------------
// Running the binary
// ---------------------------------------------------------------------------

export interface DaemonHandle {
  child: ChildProcess;
  /** Resolves on process close; `sb.lastRun` is set at the same moment. */
  exited: Promise<CliResult>;
  /** Set by `runCli` before it signals the child on timeout. */
  timedOut: boolean;
}

/** Spawn the binary under test with `args`, collecting stdout/stderr until it closes. */
export function spawnCli(sb: Sandbox, args: string[]): DaemonHandle {
  const [cmd, ...pre] = sb.bin;
  const child = spawn(cmd, [...pre, ...args], {
    cwd: sb.home,
    env: sb.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => {
    stdout += c.toString();
  });
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  const handle: DaemonHandle = {
    child,
    timedOut: false,
    exited: Promise.resolve(null as unknown as CliResult),
  };
  handle.exited = new Promise<CliResult>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result: CliResult = { code, signal, stdout, stderr, timedOut: handle.timedOut };
      sb.lastRun = result;
      resolvePromise(result);
    });
  });
  return handle;
}

/** Run to completion; SIGTERM then SIGKILL on timeout so a hang fails the test instead of wedging CI. */
export async function runCli(
  sb: Sandbox,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<CliResult> {
  const h = spawnCli(sb, args);
  const timer = setTimeout(() => {
    h.timedOut = true;
    h.child.kill("SIGTERM");
    setTimeout(() => h.child.kill("SIGKILL"), 5_000).unref();
  }, opts.timeoutMs ?? 90_000);
  try {
    return await h.exited;
  } finally {
    clearTimeout(timer);
  }
}

export const runOnce = (sb: Sandbox, opts: { timeoutMs?: number } = {}): Promise<CliResult> =>
  runCli(sb, ["run-once"], opts);

/** `junco start` in the foreground. The caller signals it (SIGTERM) and awaits `exited`. */
export const spawnDaemon = (sb: Sandbox): DaemonHandle => spawnCli(sb, ["start"]);

/** Poll `cond` until true or the deadline passes (then throw with `label`). Never a fixed single tick. */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 250));
  }
  throw new Error(`waitFor: "${opts.label}" not satisfied within ${opts.timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tickets and readers
// ---------------------------------------------------------------------------

/**
 * Write a ticket into inbox/. Frontmatter keys must be public `ticketSchema`
 * fields — a harness that used a private key would be testing a contract the
 * dispatchers cannot rely on. (Checked at write time: the schema is a runtime
 * object typed `Record<string, unknown>`, so there is no static key type.)
 */
export function writeTicket(
  sb: Sandbox,
  t: { id: string; frontmatter?: Record<string, unknown>; body: string },
): string {
  const known = Object.keys(
    (TICKET_FRONTMATTER_JSON_SCHEMA as { properties: Record<string, unknown> }).properties,
  );
  for (const k of Object.keys(t.frontmatter ?? {})) {
    if (!known.includes(k))
      throw new Error(`writeTicket: "${k}" is not a public ticketSchema field`);
  }
  const inbox = join(sb.queueRoot, "inbox");
  mkdirSync(inbox, { recursive: true });
  const path = join(inbox, `${t.id}.md`);
  const fm = stringifyYaml({ id: t.id, ...t.frontmatter }).trimEnd();
  writeFileSync(path, `---\n${fm}\n---\n\n${t.body.trimEnd()}\n`);
  return path;
}

export type QueueDir = "inbox" | "processing" | "done" | "failed";
const QUEUE_DIRS: readonly QueueDir[] = ["inbox", "processing", "done", "failed"];

export function queueState(
  sb: Sandbox,
  id: string,
): { dir: QueueDir | null; frontmatter: Record<string, unknown>; body: string } {
  for (const dir of QUEUE_DIRS) {
    const p = join(sb.queueRoot, dir, `${id}.md`);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
    if (!m) return { dir, frontmatter: {}, body: raw };
    const parsed: unknown = parseYaml(m[1]);
    return { dir, frontmatter: isPlainObject(parsed) ? parsed : {}, body: m[2] };
  }
  return { dir: null, frontmatter: {}, body: "" };
}

/** Every ticket file per queue dir — for the diagnostics dump. */
function listQueue(sb: Sandbox): Record<QueueDir, string[]> {
  const out = { inbox: [], processing: [], done: [], failed: [] } as Record<QueueDir, string[]>;
  if (!sb.queueRoot) return out;
  for (const dir of QUEUE_DIRS) {
    const p = join(sb.queueRoot, dir);
    if (existsSync(p)) out[dir] = readdirSync(p);
  }
  return out;
}

/** Parsed transcript lines. Checks both data layouts (nested `data/transcripts`, legacy flat `transcripts`). */
export function transcript(sb: Sandbox, id: string): ParsedLine[] {
  const p = firstExisting([
    join(sb.dataDir, "data", "transcripts", `${id}.jsonl`),
    join(sb.dataDir, "transcripts", `${id}.jsonl`),
  ]);
  if (p === null) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map(parseTranscriptLine);
}

export function ghLog(sb: Sandbox): string[] {
  return readIfExists(join(sb.home, "gh.log")).split("\n").filter(Boolean);
}

export function stub(sb: Sandbox): StubModel {
  if (sb.stub === null) throw new Error("this sandbox has no stub model (live layer)");
  return sb.stub;
}

export function chatRequests(sb: Sandbox): RecordedRequest[] {
  return stub(sb).requests.filter(
    (q) => q.method === "POST" && q.path.endsWith("/chat/completions"),
  );
}

export const remote = {
  branches: (sb: Sandbox): string[] =>
    run(["git", "-C", sb.git.remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .split("\n")
      .filter(Boolean),
  log: (sb: Sandbox, branch: string): string[] =>
    run(["git", "-C", sb.git.remote, "log", "--format=%s", branch]).split("\n").filter(Boolean),
  show: (sb: Sandbox, branch: string, path: string): string =>
    run(["git", "-C", sb.git.remote, "show", `${branch}:${path}`]),
  ahead: (sb: Sandbox, branch: string): number =>
    Number(run(["git", "-C", sb.git.remote, "rev-list", "--count", `main..${branch}`]).trim()),
};
