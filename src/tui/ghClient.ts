/**
 * The dashboard's ONLY GitHub-touching module. Every method returns a Result
 * instead of throwing — failures render as status-bar toasts, never crashes.
 * Actions are pure label mutations under the operator's own gh auth, so the
 * bridge's permission gates apply unchanged.
 */

import type { Config } from "../types.js";
import { gh, git } from "../git.js";
import { lifecycleLabels, nwoFromRemoteUrl, PLAN_COMMENT_MARKER } from "../githubInbox.js";
import type { DashIssue, DashAction } from "./state.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface HealthInfo {
  up: boolean;
  uptimeSeconds: number | null;
  lastBridgeSweepAt: string | null;
  ticketsBridged: number | null;
}

export interface DashboardClient {
  listIssues(nwo: string): Promise<Result<DashIssue[]>>;
  issueDetail(
    nwo: string,
    num: number,
  ): Promise<Result<{ body: string; planComment: string | null }>>;
  applyAction(
    nwo: string,
    num: number,
    action: DashAction,
    labels: string[],
  ): Promise<Result<void>>;
  validateAndPrepareRepo(nwo: string, path: string): Promise<Result<void>>;
  openInBrowser(nwo: string, num: number): Promise<Result<void>>;
  health(): Promise<HealthInfo>;
}

export interface GhClientDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
  fetchFn?: typeof fetch;
}

const GH_TIMEOUT = 30_000;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function makeGhDashboardClient(cfg: Config, deps: GhClientDeps = {}): DashboardClient {
  const ghFn = deps.ghFn ?? gh;
  const gitFn = deps.gitFn ?? git;
  const fetchFn = deps.fetchFn ?? fetch;
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

  return {
    listIssues(nwo) {
      return attempt(async () => {
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
        return raw.map((i) => ({
          number: i.number,
          title: i.title,
          labels: i.labels.map((l) => l.name),
          updatedAt: i.updatedAt,
          url: i.url,
        }));
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
        const has = (l: string): boolean => labels.includes(l);
        switch (action) {
          case "dispatch":
            return edit(nwo, num, ["--add-label", trigger]);
          case "dispatchAsk":
            return edit(nwo, num, ["--add-label", trigger, "--add-label", cfg.github.askLabel]);
          case "approve":
            return edit(nwo, num, ["--add-label", ll.approved]);
          case "replan": {
            const args = ["--remove-label", ll.planReady];
            if (has(ll.approved)) args.push("--remove-label", ll.approved);
            return edit(nwo, num, args);
          }
          case "recycle": {
            const terminal = [ll.done, ll.failed, ll.denied].filter(has);
            // Stale labels (someone already recycled): a flag-less `gh issue
            // edit` exits 1, so a no-op recycle succeeds without calling gh.
            if (terminal.length === 0) return;
            return edit(
              nwo,
              num,
              terminal.flatMap((l) => ["--remove-label", l]),
            );
          }
        }
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
          };
        };
        return {
          up: true,
          uptimeSeconds: j.metrics?.uptimeSeconds ?? null,
          lastBridgeSweepAt: j.metrics?.lastBridgeSweepAt ?? null,
          ticketsBridged: j.metrics?.ticketsBridged ?? null,
        };
      } catch {
        return down;
      }
    },
  };
}
