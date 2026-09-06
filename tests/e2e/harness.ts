/**
 * tests/e2e/harness.ts — the black-box sandbox every e2e scenario runs in.
 *
 * One `createSandbox()` gives a scenario the four ingredients the spec names
 * (docs/superpowers/specs/2026-09-01-e2e-testing-design.md §4): a sandboxed
 * HOME with a hand-written config.json, a real bare git remote + clone, a
 * fake `gh` that logs every scripted call (the built-in `repo view
 * --json nameWithOwner` answer is not logged — it is answered by `ghCases`
 * itself, ahead of the logged case table), and the scripted model stub — then
 * spawns the binary under test with a SCRUBBED environment so nothing here
 * can reach the maintainer's live ~/.junco. The one exception: the `remote.*`
 * readers below shell out to `git` via `tests/helpers/gitHarness.ts`'s `run`,
 * which spreads the parent `process.env` (so it sees the real `HOME`) rather
 * than the scrubbed child env — but they are read-only queries against the
 * sandbox's own bare repo, so there is no live-runtime risk.
 *
 * Reuses the unit suite's fixtures on purpose: `cloneHarness` (bare remote +
 * seeded clone) and `ghCases` (case-table fake gh with no permissive default —
 * an unscripted subcommand fails loud with `fake-gh: unhandled: <args>`, which
 * is how a scenario discovers the exact table it needs).
 *
 * Sandbox location: NOT under `/tmp` — see `sandboxBaseDir` below. The OS
 * sandbox backend masks that path, which cost PR #435 a red ubuntu leg.
 *
 * Diagnostics ordering (spec §8's "read them before deciding anything"
 * guarantee): every scenario's `afterEach(() => sb.close())` runs BEFORE this
 * module's `onTestFailed` diagnostics handler, not after. Confirmed by
 * reading `node_modules/@vitest/runner/dist/chunk-artifact.js`'s `runTest`
 * (Vitest 4.1.10): it awaits the suite's `afterEach` hook, THEN
 * `test.onFinished`, THEN — only if the test failed — `test.onFailed`, in
 * that fixed order regardless of registration order. So by the time
 * `onTestFailed` fires, `close()` has already `rmSync`'d the sandbox (unless
 * `JUNCO_E2E_KEEP` is set) and the on-disk state is gone. `snapshotDiagnostics`
 * exists to read that state once, at the TOP of `close()` before teardown, and
 * stash it on `sb.diagnostics` so `registerDiagnostics` can still print it.
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
import { dirname, join, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { onTestFailed } from "vitest";
import { cloneHarness, run, type GitHarness } from "../helpers/gitHarness.js";
import { ghCases } from "../helpers/ghScript.js";
import { TICKET_FRONTMATTER_JSON_SCHEMA } from "../../src/ticketSchema.js";
import { parseTranscriptLine, type ParsedLine } from "../../src/agent/transcriptSchema.js";
import { chatSlug } from "../../src/chat/chatKey.js";
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

/**
 * The path the Linux sandbox backend mounts a fresh tmpfs over on every
 * sandboxed bash call (`src/agent/sandbox/backend.ts`'s `bwrapArgs`:
 * `--tmpfs /tmp`, emitted before any policy mount).
 */
export const MASKED_TMP = "/tmp";

/** Where the sandbox goes instead when the platform temp root is masked. */
export const SANDBOX_FALLBACK_BASE = "/var/tmp";

/**
 * Where to `mkdtemp` the sandbox HOME.
 *
 * NOT simply `os.tmpdir()`. On Linux that is `/tmp`, and bwrap masks `/tmp`
 * with a tmpfs, so ONLY the paths the sandbox policy binds explicitly survive
 * inside the agent's bash: the linked worktree's gitdir, `objects`, `refs`,
 * `logs` — but not the repo's own `.git/config`, which in production is
 * readable through bwrap's `--ro-bind / /` and needs no bind of its own.
 * A repo under `/tmp` therefore has no readable config inside the sandbox:
 * `git commit` makes no commit, junco says "no commits but wt dirty", and the
 * PR-flow scenarios fail with no branch on the remote. That is exactly how
 * PR #435 went red on ubuntu while macOS — whose `os.tmpdir()` is
 * `/var/folders/...`, never masked — passed.
 *
 * `/var/tmp` is the fix rather than a policy change because production repos
 * do not live in `/tmp`: the sandbox's masking of it is deliberate hardening,
 * and moving the fixture keeps every assertion intact while testing the path
 * shape real users have. (The narrower product limitation — a repo genuinely
 * under `/tmp` cannot be committed to on Linux — is a real finding, recorded
 * in the spec's risk register, not something this harness should paper over
 * by weakening the sandbox.)
 *
 * Pure and injectable so the Linux behavior is pinned by a unit test that
 * runs on every platform (tests/e2eHarnessBaseDir.test.ts).
 */
export function sandboxBaseDir(
  platformTmp: string = tmpdir(),
  exists: (p: string) => boolean = existsSync,
): string {
  const masked = platformTmp === MASKED_TMP || platformTmp.startsWith(MASKED_TMP + sep);
  if (!masked) return platformTmp;
  // No /var/tmp (unusual, but never guess): keep the caller's root. The e2e
  // run then fails loudly on its assertions rather than silently elsewhere.
  return exists(SANDBOX_FALLBACK_BASE) ? SANDBOX_FALLBACK_BASE : platformTmp;
}

/** argv prefix for the CLI under test: `JUNCO_E2E_BIN` (packaging layer) or the built dist. */
function binaryUnderTest(): string[] {
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

/** The on-disk diagnostic sources `registerDiagnostics` prints — see `snapshotDiagnostics`. */
export interface DiagnosticsSnapshot {
  /** Per queue dir, each file's name and its frontmatter block ("" if none). */
  queue: Record<QueueDir, Array<{ name: string; frontmatter: string }>>;
  ghLog: string;
  workerLogTail: string;
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
  /**
   * On-disk diagnostics (queue listing, gh.log, worker.log tail) captured at
   * the TOP of `close()`, before teardown — `null` until the sandbox has been
   * closed once. `registerDiagnostics` prints this (falling back to a live
   * `snapshotDiagnostics` read if `close()` hasn't run yet) because its own
   * `onTestFailed` handler always fires AFTER `close()` has already deleted
   * the sandbox — see the module header comment.
   */
  diagnostics: DiagnosticsSnapshot | null;
  close(): Promise<void>;
}

/** The gh subcommands the PR flow needs on its happy path. Each body is prefixed with the gh.log line by `createSandbox`. */
function defaultGhCases(nwo: string): Record<string, string> {
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

/** Prefix every line of `s` with `prefix` — used to indent a frontmatter block under its filename in the diagnostics dump. */
function indent(s: string, prefix: string): string {
  return s
    .split("\n")
    .map((l) => `${prefix}${l}`)
    .join("\n");
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

/**
 * Read the three on-disk diagnostic sources for `sb` as they exist RIGHT NOW:
 * the queue listing, `gh.log`, and the v2-then-flat `worker.log` tail (same
 * probe `transcript()` uses, via `firstExisting`).
 *
 * Called once by `close()`, at the top, before any teardown — so the result
 * can be stashed on `sb.diagnostics` and survive the `rmSync` that follows.
 * Also safe to call directly for a live read (e.g. a sandbox never closed).
 */
export function snapshotDiagnostics(sb: Sandbox): DiagnosticsSnapshot {
  const workerLog = firstExisting([
    join(sb.dataDir, "logs", "worker.log"),
    join(sb.dataDir, "worker.log"),
  ]);
  return {
    queue: listQueue(sb),
    ghLog: readIfExists(join(sb.home, "gh.log")),
    workerLogTail: tail(workerLog === null ? "" : readIfExists(workerLog)),
  };
}

/**
 * Register the `onTestFailed` diagnostics dump for `sb`.
 *
 * This handler ALWAYS runs after the scenario's own `afterEach(() =>
 * sb.close())` (see the module header comment for why) — so by the time it
 * fires, the sandbox's on-disk state is normally already gone. It prints
 * `sb.diagnostics` (the snapshot `close()` took before teardown) when
 * present, falling back to a live `snapshotDiagnostics(sb)` read only if
 * `close()` somehow hasn't run yet, and labels which case applied so a reader
 * knows whether the on-disk section reflects a post-run snapshot or a live
 * probe.
 */
function registerDiagnostics(sb: Sandbox): void {
  onTestFailed(() => {
    const out: string[] = [`--- e2e diagnostics (sandbox ${sb.home}) ---`];
    const postClose = sb.diagnostics !== null;
    const snap = sb.diagnostics ?? snapshotDiagnostics(sb);
    out.push(
      postClose
        ? "on-disk state below was snapshotted at sandbox close (post-run)"
        : "on-disk state below is a LIVE read (sandbox not yet closed)",
    );
    out.push("queue:");
    for (const dir of QUEUE_DIRS) {
      for (const f of snap.queue[dir]) {
        out.push(`  ${dir}/${f.name}`);
        if (f.frontmatter) out.push(indent(f.frontmatter, "    "));
      }
    }
    out.push(
      `stub: requests=${sb.stub?.requests.length ?? "n/a"} exhausted=${String(sb.stub?.exhausted ?? "n/a")}`,
    );
    out.push(`gh.log:\n${snap.ghLog || "(empty)"}`);
    if (sb.lastRun) {
      out.push(
        `last run: code=${String(sb.lastRun.code)} signal=${String(sb.lastRun.signal)} timedOut=${String(sb.lastRun.timedOut)}`,
      );
      out.push(`stdout (tail):\n${tail(sb.lastRun.stdout)}`);
      out.push(`stderr (tail):\n${tail(sb.lastRun.stderr)}`);
    }
    out.push(`worker.log (tail):\n${snap.workerLogTail}`);
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
  const home = mkdtempSync(join(sandboxBaseDir(), "junco-e2e-"));
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

  let closed = false;
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
    diagnostics: null,
    close: async () => {
      // Idempotent: a scenario's own afterEach plus createSandbox's own
      // setup-failure path can both call close() on the same sandbox — a
      // second call must be a no-op, never a double-rmSync/double-server-close
      // throw.
      if (closed) return;
      closed = true;
      // Snapshot on-disk diagnostics BEFORE any teardown below, so a failed
      // test's onTestFailed handler (which always runs after this — see the
      // module header comment) can still print real queue/gh.log/worker.log
      // state instead of reading a directory that's already gone.
      sb.diagnostics = snapshotDiagnostics(sb);
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
function spawnCli(sb: Sandbox, args: string[]): DaemonHandle {
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
async function runCli(
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
  // `id: t.id` must win over a caller-supplied `frontmatter.id` — the file is
  // named after `t.id`, so a frontmatter override would desync the two. Strip
  // any `id` from a copy of frontmatter first so `t.id` can neither be
  // shadowed by the spread nor duplicated, and stays first in the emitted YAML.
  const rest = { ...(t.frontmatter ?? {}) };
  delete rest.id;
  const fm = stringifyYaml({ id: t.id, ...rest }).trimEnd();
  writeFileSync(path, `---\n${fm}\n---\n\n${t.body.trimEnd()}\n`);
  return path;
}

export type QueueDir = "inbox" | "processing" | "done" | "failed";
const QUEUE_DIRS: readonly QueueDir[] = ["inbox", "processing", "done", "failed"];

/**
 * Locate a ticket's file within one queue dir. `src/queue.ts` `claim()` renames
 * `<id>.md` to `<UTC-minute-stamp>__<id>.md` on the way into processing/, and
 * `src/finalize.ts` carries that stamped name through into done/ or failed/
 * (`uniqueDestPath(dstDir, basename(ticketPath))`) — only a still-queued inbox
 * ticket keeps the bare name. Match either shape so a scenario can find a
 * ticket regardless of which stage it has reached.
 */
function findTicketFile(queueRoot: string, dir: QueueDir, id: string): string | null {
  const d = join(queueRoot, dir);
  if (!existsSync(d)) return null;
  for (const name of readdirSync(d)) {
    if (name === `${id}.md` || name.endsWith(`__${id}.md`)) return join(d, name);
  }
  return null;
}

export function queueState(
  sb: Sandbox,
  id: string,
): { dir: QueueDir | null; frontmatter: Record<string, unknown>; body: string } {
  for (const dir of QUEUE_DIRS) {
    const p = findTicketFile(sb.queueRoot, dir, id);
    if (p === null) continue;
    const raw = readFileSync(p, "utf8");
    const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
    if (!m) return { dir, frontmatter: {}, body: raw };
    const parsed: unknown = parseYaml(m[1]);
    return { dir, frontmatter: isPlainObject(parsed) ? parsed : {}, body: m[2] };
  }
  return { dir: null, frontmatter: {}, body: "" };
}

/** The text between a ticket file's first `---` pair, or "" if it has no frontmatter block. */
function readFrontmatterBlock(path: string): string {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(readIfExists(path));
  return m ? m[1] : "";
}

/** Every ticket file per queue dir, with its frontmatter — for the diagnostics dump. */
function listQueue(sb: Sandbox): Record<QueueDir, Array<{ name: string; frontmatter: string }>> {
  const out = { inbox: [], processing: [], done: [], failed: [] } as Record<
    QueueDir,
    Array<{ name: string; frontmatter: string }>
  >;
  if (!sb.queueRoot) return out;
  for (const dir of QUEUE_DIRS) {
    const p = join(sb.queueRoot, dir);
    if (existsSync(p))
      out[dir] = readdirSync(p).map((name) => ({
        name,
        frontmatter: readFrontmatterBlock(join(p, name)),
      }));
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

/**
 * One dashboard-chat session's transcript lines, parsed — the daemon-side
 * record of a chat turn (`junco_chat_*`) plus the SDK events it interleaves.
 * Simpler than consuming `/chat/events` from a scenario, and it reads exactly
 * what `junco transcript --chat` reads.
 *
 * The slug comes from the product (`chatSlug`), never guessed, and the
 * directory probe is the same v2-then-flat one `transcript()` uses.
 */
export function chatTranscript(sb: Sandbox, key: string): ParsedLine[] {
  const dir = firstExisting([join(sb.dataDir, "data", "chats"), join(sb.dataDir, "chats")]);
  if (dir === null) return [];
  const p = join(dir, chatSlug(key), "transcript.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map(parseTranscriptLine);
}

/** The chat drafts parked right now (`<chat-drafts>/<id>.json`), by draft id.
 *  Same v2-then-flat probe; `[]` before the first draft parks. */
export function chatDrafts(sb: Sandbox): string[] {
  const dir = firstExisting([
    join(sb.dataDir, "data", "chat-drafts"),
    join(sb.dataDir, "chat-drafts"),
  ]);
  if (dir === null) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.replace(/\.json$/, ""));
}

/** Where `archiveChatDraft` moves a submitted draft's JSON (draftStore.ts). */
export function chatDraftArchivePath(sb: Sandbox, draftId: string): string | null {
  const dir = firstExisting([
    join(sb.dataDir, "data", "chat-drafts"),
    join(sb.dataDir, "chat-drafts"),
  ]);
  return dir === null ? null : join(dir, "submitted", `${draftId}.json`);
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
