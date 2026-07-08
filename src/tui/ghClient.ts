/**
 * The dashboard's ONLY GitHub-touching module. Every method returns a Result
 * instead of throwing — failures render as status-bar toasts, never crashes.
 * Actions are pure label mutations under the operator's own gh auth, so the
 * bridge's permission gates apply unchanged.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../types.js";
import { gh, git } from "../git.js";
import { lifecycleLabels, nwoFromRemoteUrl, PLAN_COMMENT_MARKER } from "../githubInbox.js";
import { tryOrEnqueue, isOffline, type OutboxOp } from "../githubOutbox.js";
import type { DashIssue, DashAction } from "./state.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

type LabelsOp = Extract<OutboxOp, { kind: "labels" }>;

interface IssueCache {
  fetchedAt: string; // ISO
  issues: DashIssue[];
}

/** `<state_dir>/github-cache/issues-<owner>__<repo>.json` — `/` in the nwo
 * would otherwise collide with the path separator. */
export function cachePathFor(cfg: Config, nwo: string): string {
  return join(cfg.stateDir, "github-cache", `issues-${nwo.replace(/\//g, "__")}.json`);
}

/** Mirrors the applyAction switch's add/remove lists EXACTLY — including the
 * recycle zero-op short-circuit (null return), which the caller must honor
 * BEFORE calling tryOrEnqueue (a no-op recycle must neither call gh nor queue
 * an op). */
function labelsOpFor(
  trigger: string,
  askLabel: string,
  ll: ReturnType<typeof lifecycleLabels>,
  action: DashAction,
  nwo: string,
  num: number,
  labels: string[],
): LabelsOp | null {
  const has = (l: string): boolean => labels.includes(l);
  switch (action) {
    case "dispatch":
      return { kind: "labels", nwo, issue: num, add: [trigger], remove: [] };
    case "dispatchAsk":
      return { kind: "labels", nwo, issue: num, add: [trigger, askLabel], remove: [] };
    case "approve":
      return { kind: "labels", nwo, issue: num, add: [ll.approved], remove: [] };
    case "replan": {
      const remove = [ll.planReady];
      if (has(ll.approved)) remove.push(ll.approved);
      return { kind: "labels", nwo, issue: num, add: [], remove };
    }
    case "recycle": {
      const terminal = [ll.done, ll.failed, ll.denied].filter(has);
      if (terminal.length === 0) return null; // stale labels — clean no-op
      return { kind: "labels", nwo, issue: num, add: [], remove: terminal };
    }
  }
}

/** `--add-label`/`--remove-label` flags for a labels op, in add-then-remove
 * order — every action above populates only one of the two lists, so order
 * between them never matters in practice. */
function ghArgsFor(op: LabelsOp): string[] {
  return [
    ...op.add.flatMap((l) => ["--add-label", l]),
    ...op.remove.flatMap((l) => ["--remove-label", l]),
  ];
}

export interface HealthInfo {
  up: boolean;
  uptimeSeconds: number | null;
  lastBridgeSweepAt: string | null;
  ticketsBridged: number | null;
  tasksProcessed: number | null;
  tasksSucceeded: number | null;
  tasksFailed: number | null;
  lastTaskStatus: string | null;
  lastTaskAt: string | null;
  totalTokensOut: number | null;
  bridgeErrors: number | null;
}

export interface DashboardClient {
  /** Fresh fetch writes the on-disk cache and returns `staleAt: null`; a
   * network failure serves the cache with `staleAt` set to when it was
   * written; a network failure with no cache is `ok: false` as before. */
  listIssues(nwo: string): Promise<Result<{ issues: DashIssue[]; staleAt: string | null }>>;
  /** Clone `nwo` into `dest` via the user's gh auth. An existing dest is
   * reused (validation still gates it). */
  cloneRepo(nwo: string, dest: string): Promise<Result<void>>;
  issueDetail(
    nwo: string,
    num: number,
  ): Promise<Result<{ body: string; planComment: string | null }>>;
  /** `queued: true` when GitHub was unreachable and the label edit was
   * durably queued to the outbox instead of applied live. */
  applyAction(
    nwo: string,
    num: number,
    action: DashAction,
    labels: string[],
  ): Promise<Result<{ queued: boolean }>>;
  validateAndPrepareRepo(nwo: string, path: string): Promise<Result<void>>;
  openInBrowser(nwo: string, num: number): Promise<Result<void>>;
  health(): Promise<HealthInfo>;
}

export interface GhClientDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
  fetchFn?: typeof fetch;
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  renameFn?: (a: string, b: string) => void;
  mkdirFn?: (d: string) => void;
}

const GH_TIMEOUT = 30_000;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function makeGhDashboardClient(cfg: Config, deps: GhClientDeps = {}): DashboardClient {
  const ghFn = deps.ghFn ?? gh;
  const gitFn = deps.gitFn ?? git;
  const fetchFn = deps.fetchFn ?? fetch;
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const renameFn = deps.renameFn ?? renameSync;
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const trigger = cfg.github.triggerLabel;
  const ll = lifecycleLabels(trigger);
  let viewer: string | null = null;

  const attempt = async <T>(fn: () => Promise<T>): Promise<Result<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  };

  const edit = async (nwo: string, num: number, args: string[]): Promise<void> => {
    await ghFn(cfg, ["issue", "edit", String(num), "--repo", nwo, ...args], {
      timeoutMs: GH_TIMEOUT,
      retryNetwork: true,
    });
  };

  const writeCache = (nwo: string, issues: DashIssue[]): void => {
    const path = cachePathFor(cfg, nwo);
    mkdirFn(dirname(path));
    const tmp = `${path}.tmp`;
    const stored: IssueCache = { fetchedAt: new Date().toISOString(), issues };
    writeFileFn(tmp, JSON.stringify(stored));
    renameFn(tmp, path);
  };

  const readCache = (nwo: string): IssueCache | null => {
    try {
      const parsed: unknown = JSON.parse(readFileFn(cachePathFor(cfg, nwo)));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray((parsed as Partial<IssueCache>).issues) ||
        typeof (parsed as Partial<IssueCache>).fetchedAt !== "string"
      ) {
        return null; // wrong shape (e.g. hand-edited or from a future format) — treated as absent
      }
      return parsed as IssueCache;
    } catch {
      return null; // no cache yet, or unreadable/corrupt — treated as absent
    }
  };

  return {
    listIssues(nwo) {
      return attempt(async () => {
        try {
          const r = await ghFn(
            cfg,
            [
              "issue",
              "list",
              "--repo",
              nwo,
              "--state",
              "open",
              "--limit",
              "200",
              "--json",
              "number,title,labels,updatedAt,url",
            ],
            { timeoutMs: GH_TIMEOUT, retryNetwork: true },
          );
          const raw = JSON.parse(r.stdout) as {
            number: number;
            title: string;
            labels: { name: string }[];
            updatedAt: string;
            url: string;
          }[];
          const issues = raw.map((i) => ({
            number: i.number,
            title: i.title,
            labels: i.labels.map((l) => l.name),
            updatedAt: i.updatedAt,
            url: i.url,
          }));
          writeCache(nwo, issues);
          return { issues, staleAt: null };
        } catch (e) {
          // Cache serve is only for network-shaped failures; a permanent
          // error (bad repo, auth) stays ok:false with no cache read.
          if (!isOffline(e)) throw e;
          const cached = readCache(nwo);
          if (cached === null) throw e; // no cache — today's ok:false behavior
          return { issues: cached.issues, staleAt: cached.fetchedAt };
        }
      });
    },

    cloneRepo(nwo, dest) {
      return attempt(async () => {
        if (existsSync(dest)) return; // reuse — validateAndPrepareRepo decides
        mkdirSync(dirname(dest), { recursive: true });
        await ghFn(cfg, ["repo", "clone", nwo, dest], {
          timeoutMs: 300_000, // full clone; big repos take a while
        });
      });
    },

    issueDetail(nwo, num) {
      return attempt(async () => {
        const view = await ghFn(
          cfg,
          ["issue", "view", String(num), "--repo", nwo, "--json", "body"],
          { timeoutMs: GH_TIMEOUT, retryNetwork: true },
        );
        const body = (JSON.parse(view.stdout) as { body?: string }).body ?? "";
        if (viewer === null) {
          const u = await ghFn(cfg, ["api", "user", "--jq", ".login"], {
            timeoutMs: GH_TIMEOUT,
            retryNetwork: true,
          });
          viewer = u.stdout.trim();
        }
        const cm = await ghFn(
          cfg,
          [
            "api",
            "--paginate",
            `repos/${nwo}/issues/${num}/comments`,
            "--jq",
            ".[] | {author: .user.login, body: .body, created_at: .created_at}",
          ],
          { timeoutMs: GH_TIMEOUT, retryNetwork: true },
        );
        let planComment: string | null = null;
        for (const line of cm.stdout.trim().split("\n").filter(Boolean)) {
          const c = JSON.parse(line) as { author: string; body: string };
          if (c.author === viewer && c.body.includes(PLAN_COMMENT_MARKER)) planComment = c.body;
        }
        return { body, planComment };
      });
    },

    applyAction(nwo, num, action, labels) {
      return attempt(async () => {
        const op = labelsOpFor(trigger, cfg.github.askLabel, ll, action, nwo, num, labels);
        // Stale labels (someone already recycled): a flag-less `gh issue edit`
        // exits 1, so the zero-op recycle must short-circuit here — before
        // gh is called and before anything is queued.
        if (op === null) return { queued: false };
        const status = await tryOrEnqueue(cfg, "dashboard", op, () =>
          edit(nwo, num, ghArgsFor(op)),
        );
        return { queued: status === "queued" };
      });
    },

    validateAndPrepareRepo(nwo, path) {
      return attempt(async () => {
        const origin = await gitFn(cfg, ["-C", path, "remote", "get-url", "origin"], {
          check: false,
        });
        const actual = origin.code === 0 ? nwoFromRemoteUrl(origin.stdout.trim()) : null;
        if (actual === null || actual.toLowerCase() !== nwo.toLowerCase()) {
          throw new Error(
            origin.code !== 0
              ? `${path} is not a git clone (or has no origin)`
              : `clone origin is ${actual}, expected ${nwo}`,
          );
        }
        await ghFn(cfg, ["repo", "view", nwo, "--json", "name"], {
          timeoutMs: GH_TIMEOUT,
          retryNetwork: true,
        });
        // Ensure the trigger label exists so dispatch's --add-label can't fail
        // on a fresh repo. list+grep-free: create is idempotent enough via
        // check-first (create without --force must not clobber a custom color).
        const existing = await ghFn(
          cfg,
          [
            "label",
            "list",
            "--repo",
            nwo,
            "--search",
            trigger,
            "--json",
            "name",
            "--jq",
            ".[].name",
          ],
          { timeoutMs: GH_TIMEOUT, retryNetwork: true },
        );
        const names = existing.stdout.trim().split("\n").filter(Boolean);
        if (!names.includes(trigger)) {
          await ghFn(
            cfg,
            [
              "label",
              "create",
              trigger,
              "--repo",
              nwo,
              "--color",
              "0E8A16",
              "--description",
              "dispatch this issue to junco",
            ],
            { timeoutMs: GH_TIMEOUT, retryNetwork: true },
          );
        }
      });
    },

    openInBrowser(nwo, num) {
      return attempt(async () => {
        await ghFn(cfg, ["issue", "view", String(num), "--repo", nwo, "--web"], {
          timeoutMs: GH_TIMEOUT,
        });
      });
    },

    async health() {
      const down: HealthInfo = {
        up: false,
        uptimeSeconds: null,
        lastBridgeSweepAt: null,
        ticketsBridged: null,
        tasksProcessed: null,
        tasksSucceeded: null,
        tasksFailed: null,
        lastTaskStatus: null,
        lastTaskAt: null,
        totalTokensOut: null,
        bridgeErrors: null,
      };
      if (!cfg.healthEnabled) return down;
      try {
        const resp = await fetchFn(`http://${cfg.healthHost}:${cfg.healthPort}/health`);
        if (!resp.ok) return down;
        const j = (await resp.json()) as {
          metrics?: {
            uptimeSeconds?: number;
            lastBridgeSweepAt?: string | null;
            ticketsBridged?: number;
            tasksProcessed?: number;
            tasksSucceeded?: number;
            tasksFailed?: number;
            lastTaskStatus?: string | null;
            lastTaskAt?: string | null;
            totalTokensOut?: number;
            bridgeErrors?: number;
          };
        };
        return {
          up: true,
          uptimeSeconds: j.metrics?.uptimeSeconds ?? null,
          lastBridgeSweepAt: j.metrics?.lastBridgeSweepAt ?? null,
          ticketsBridged: j.metrics?.ticketsBridged ?? null,
          tasksProcessed: j.metrics?.tasksProcessed ?? null,
          tasksSucceeded: j.metrics?.tasksSucceeded ?? null,
          tasksFailed: j.metrics?.tasksFailed ?? null,
          lastTaskStatus: j.metrics?.lastTaskStatus ?? null,
          lastTaskAt: j.metrics?.lastTaskAt ?? null,
          totalTokensOut: j.metrics?.totalTokensOut ?? null,
          bridgeErrors: j.metrics?.bridgeErrors ?? null,
        };
      } catch {
        return down;
      }
    },
  };
}
