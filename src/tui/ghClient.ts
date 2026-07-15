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
import type { DashPr } from "./prState.js";
import { fetchJuncoPrs } from "../githubPrs.js";
import { ensureExternalClone } from "../externalRepo.js";
import { dispatchIssue } from "../externalDispatch.js";
import { withBotAuth } from "../ghAuth.js";
import { listPending, readPending, type PendingAssess } from "../assessReview.js";
import { fileFindings, type FileResult } from "../assessFiling.js";
import { listDrafts, removeDraft, type PendingComment } from "../commentReview.js";
import { postDraftCore, analyzeIssueCore } from "../analyzeCmd.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

type LabelsOp = Extract<OutboxOp, { kind: "labels" }>;

interface IssueCache {
  fetchedAt: string; // ISO
  issues: DashIssue[];
}

interface PrCache {
  fetchedAt: string; // ISO
  prs: DashPr[];
}

/** `<state_dir>/github-cache/issues-<owner>__<repo>.json` — `/` in the nwo
 * would otherwise collide with the path separator. */
export function cachePathFor(cfg: Config, nwo: string): string {
  return join(cfg.stateDir, "github-cache", `issues-${nwo.replace(/\//g, "__")}.json`);
}

/** `<state_dir>/github-cache/prs-<owner>__<repo>.json` — a sibling path to
 * `cachePathFor`, kept separate (not a param on it) so issues and PRs never
 * collide in the same file. Not exported: nothing outside this module needs
 * to address the PR cache directly. */
function prCachePathFor(cfg: Config, nwo: string): string {
  return join(cfg.stateDir, "github-cache", `prs-${nwo.replace(/\//g, "__")}.json`);
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
  /** Junco-authored PRs only: kept iff the head branch is under
   * `cfg.branchPrefix` (the filter that recovers the free ticket linkage —
   * see `ticketSlugFromBranch`). Same fresh/cache-serve/offline contract as
   * `listIssues`, mirrored against its own `prs-` cache file. */
  listPrs(nwo: string): Promise<Result<{ prs: DashPr[]; staleAt: string | null }>>;
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
  openPrInBrowser(nwo: string, num: number): Promise<Result<void>>;
  /** Repository home page — the rail's o. */
  openRepoInBrowser(nwo: string): Promise<Result<void>>;
  /** ADMIN/MAINTAIN/WRITE → `canPush: true`; everything else (READ/TRIAGE/null) → false. */
  repoPermission(nwo: string): Promise<Result<{ canPush: boolean }>>;
  /** Idempotently provision the managed clone (+fork +fork remote) for an unowned `nwo`. */
  prepareExternalRepo(nwo: string): Promise<Result<{ path: string; forkNwo: string }>>;
  /** Build + submit a ticket for `nwo#num` via the shared dispatch core. */
  dispatchTicket(nwo: string, num: number): Promise<Result<{ id: string; destPath: string }>>;
  /** Parked `junco assess` batches awaiting human confirmation. */
  listReview(): Promise<Result<PendingAssess[]>>;
  /** File the selected findings (by fingerprint) from a parked batch; throws
   * (surfacing as an error `Result`) if the batch is missing or corrupt. */
  fileReview(id: string, fingerprints: string[]): Promise<Result<FileResult>>;
  /** Parked `junco analyze` comment drafts awaiting human confirmation. */
  listCommentDrafts(): Promise<Result<PendingComment[]>>;
  /** Post (or, offline, durably enqueue) a parked draft with its footer
   * intact, archiving it on either outcome — mirrors `junco analyze post`'s
   * default (non `--no-footer`) behavior. */
  postCommentDraft(id: string): Promise<Result<{ outcome: "sent" | "queued"; url: string | null }>>;
  /** Discard a parked draft without posting it. */
  discardCommentDraft(id: string): Promise<Result<null>>;
  /** Build + submit a `junco analyze` ticket for `nwo#num` via the shared
   * analyze core. */
  analyzeIssue(nwo: string, num: number): Promise<Result<{ id: string }>>;
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
  ensureCloneFn?: typeof ensureExternalClone;
  /** Attach the daemon's bot-account GitHub auth context before
   * prepareExternalRepo's fork/clone provisioning (Task 6, gh-bot-account
   * spec) — same rule and monomorphic-over-Config typing as
   * ExternalDispatchDeps.withBotAuthFn (see externalDispatch.ts). */
  withBotAuthFn?: (cfg: Config) => Promise<Config>;
  dispatchIssueFn?: typeof dispatchIssue;
  listPendingFn?: typeof listPending;
  readPendingFn?: typeof readPending;
  fileFindingsFn?: typeof fileFindings;
  listDraftsFn?: typeof listDrafts;
  postDraftFn?: typeof postDraftCore;
  discardDraftFn?: typeof removeDraft;
  analyzeCoreFn?: typeof analyzeIssueCore;
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

  const writePrCache = (nwo: string, prs: DashPr[]): void => {
    const path = prCachePathFor(cfg, nwo);
    mkdirFn(dirname(path));
    const tmp = `${path}.tmp`;
    const stored: PrCache = { fetchedAt: new Date().toISOString(), prs };
    writeFileFn(tmp, JSON.stringify(stored));
    renameFn(tmp, path);
  };

  const readPrCache = (nwo: string): PrCache | null => {
    try {
      const parsed: unknown = JSON.parse(readFileFn(prCachePathFor(cfg, nwo)));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray((parsed as Partial<PrCache>).prs) ||
        typeof (parsed as Partial<PrCache>).fetchedAt !== "string"
      ) {
        return null; // wrong shape (e.g. hand-edited or from a future format) — treated as absent
      }
      return parsed as PrCache;
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

    listPrs(nwo) {
      return attempt(async () => {
        try {
          // Fetch+map+filter is shared with `junco prs` via src/githubPrs.ts
          // (the ONLY definition of the gh argv + DashPr mapping) — this
          // method contributes only the disk-cache/offline-serve wrapper.
          const prs = await fetchJuncoPrs(cfg, nwo, { ghFn });
          writePrCache(nwo, prs);
          return { prs, staleAt: null };
        } catch (e) {
          // Cache serve is only for network-shaped failures; a permanent
          // error (bad repo, auth) stays ok:false with no cache read.
          if (!isOffline(e)) throw e;
          const cached = readPrCache(nwo);
          if (cached === null) throw e; // no cache — today's ok:false behavior
          return { prs: cached.prs, staleAt: cached.fetchedAt };
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

    openPrInBrowser(nwo, num) {
      return attempt(async () => {
        await ghFn(cfg, ["pr", "view", String(num), "--repo", nwo, "--web"], {
          timeoutMs: GH_TIMEOUT,
        });
      });
    },

    openRepoInBrowser(nwo) {
      return attempt(async () => {
        await ghFn(cfg, ["repo", "view", nwo, "--web"], { timeoutMs: GH_TIMEOUT });
      });
    },

    repoPermission(nwo) {
      return attempt(async () => {
        const r = await ghFn(
          cfg,
          ["repo", "view", nwo, "--json", "viewerPermission", "--jq", ".viewerPermission"],
          { timeoutMs: GH_TIMEOUT, retryNetwork: true },
        );
        const perm = r.stdout.trim();
        return { canPush: ["ADMIN", "MAINTAIN", "WRITE"].includes(perm) };
      });
    },

    prepareExternalRepo(nwo) {
      return attempt(async () => {
        // The fork this provisions is the DAEMON's future push target — it
        // must live on the bot's account even though this runs human-triggered
        // (spec: boundary exception; same rule as resolveIssueTarget's
        // provisioning branch). A withBotAuth throw (enabled but unauthed)
        // surfaces as an error Result via attempt(), never a crash.
        const botCfg = await (deps.withBotAuthFn ?? ((c: Config) => withBotAuth(c)))(cfg);
        // This call never opts out of forking (unlike assess's read-only path,
        // #105) — the dashboard's watch flow always needs a push target, so a
        // null forkNwo here means ensureExternalClone's fork step was skipped
        // unexpectedly. Fail loud rather than silently widen the return type.
        const r = await (deps.ensureCloneFn ?? ensureExternalClone)(botCfg, nwo, { ghFn, gitFn });
        if (r.forkNwo === null) {
          throw new Error(`${nwo}: expected a fork to be provisioned but got none`);
        }
        return { path: r.path, forkNwo: r.forkNwo };
      });
    },

    dispatchTicket(nwo, num) {
      return attempt(async () => {
        const r = await (deps.dispatchIssueFn ?? dispatchIssue)(cfg, `${nwo}#${num}`, {
          ghFn,
          gitFn,
        });
        return { id: r.id, destPath: r.destPath };
      });
    },

    listReview() {
      return attempt(async () => (deps.listPendingFn ?? listPending)(cfg));
    },

    fileReview(id, fingerprints) {
      return attempt(async () => {
        const { batch, error } = (deps.readPendingFn ?? readPending)(cfg, id);
        if (error) throw new Error(error);
        if (!batch) throw new Error(`no pending review '${id}'`);
        return (deps.fileFindingsFn ?? fileFindings)(cfg, batch, new Set(fingerprints), { ghFn });
      });
    },

    listCommentDrafts() {
      return attempt(async () => (deps.listDraftsFn ?? listDrafts)(cfg));
    },

    postCommentDraft(id) {
      return attempt(() =>
        (deps.postDraftFn ?? postDraftCore)(cfg, id, { noFooter: false }, { ghFn }),
      );
    },

    discardCommentDraft(id) {
      return attempt(async () => {
        (deps.discardDraftFn ?? removeDraft)(cfg, id, "discarded");
        return null;
      });
    },

    analyzeIssue(nwo, num) {
      return attempt(async () => {
        const r = await (deps.analyzeCoreFn ?? analyzeIssueCore)(cfg, `${nwo}#${num}`, {
          resolveDeps: { ghFn, gitFn },
        });
        return { id: r.id };
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
