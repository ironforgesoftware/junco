// tests/useGithubData.test.tsx
import { describe, it, expect } from "vitest";
import React, { useCallback, useRef } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useGithubData } from "../src/tui/hooks/useGithubData.js";
import type { UseGithubDataResult } from "../src/tui/hooks/useGithubData.js";
import type { DashboardClient, Result } from "../src/tui/ghClient.js";
import type { WatchedMapping } from "../src/tui/railModel.js";
import type { View } from "../src/tui/App.js";
import type { ToastKind } from "../src/tui/theme.js";
import { makeDashIssue, makeDashPr } from "./helpers/dashFixtures.js";
import { until } from "./helpers/until.js";

const okv = <T,>(value: T): Result<T> => ({ ok: true, value });
// Module-scope, so its identity is stable across renders without a useCallback
// wrapper — same requirement as the Probe's own memoized showToast below.
const noopToast = (): void => {};

function mapping(nwo: string): WatchedMapping {
  return { nwo, path: `/c/${nwo}`, fromConfig: false, external: false };
}

/** A fake DashboardClient exposing only the two members useGithubData calls —
 * cast to the full interface (mirrors useReview.test.tsx's own fake client). */
function makeClient(opts: {
  issuesByRepo?: Record<string, ReturnType<typeof makeDashIssue>[]>;
  prsByRepo?: Record<string, ReturnType<typeof makeDashPr>[]>;
  failIssues?: Set<string>;
  failPrs?: Set<string>;
}): DashboardClient {
  const { issuesByRepo = {}, prsByRepo = {}, failIssues, failPrs } = opts;
  return {
    listIssues: async (nwo: string) => {
      if (failIssues?.has(nwo)) return { ok: false, error: `boom ${nwo}` };
      return okv({ issues: issuesByRepo[nwo] ?? [], staleAt: null });
    },
    listPrs: async (nwo: string) => {
      if (failPrs?.has(nwo)) return { ok: false, error: `boom ${nwo}` };
      return okv({ prs: prsByRepo[nwo] ?? [], staleAt: null });
    },
  } as unknown as DashboardClient;
}

function Probe({
  client,
  repoMappings,
  currentNwo,
  view = "main",
  bodyKind = "issues",
  filter = "",
  onReady,
}: {
  client: DashboardClient;
  repoMappings: WatchedMapping[];
  currentNwo: string | undefined;
  view?: View;
  bodyKind?: "issues" | "repoDetail" | "section" | null;
  filter?: string;
  onReady: (api: UseGithubDataResult) => void;
}) {
  // A STABLE showToast, matching real usage (App's own useToast wraps it in
  // useCallback([])). An inline arrow here would re-identify every render,
  // which cascades: loadIssues -> refreshAll -> the mount-refresh/poll/sweep
  // effects would all see a "changed" dependency on every render and refire
  // forever — exactly the dep-identity hazard useGithubData's own contract
  // warns callers about.
  const toastsRef = useRef<[ToastKind, string][]>([]);
  const showToast = useCallback((kind: ToastKind, text: string) => {
    toastsRef.current.push([kind, text]);
  }, []);
  const api = useGithubData({
    client,
    trigger: "junco",
    githubEnabled: true,
    repoMappings,
    showToast,
    // Large enough that the unified poll interval never fires mid-test — the
    // mount-refresh + watchlist-sweep effects still fire once on mount/change,
    // exactly like App's own render-count-independent behavior.
    refreshPollMs: 999_999,
    filter,
    nav: { currentNwo, view, bodyKind },
  });
  onReady(api);
  return (
    <Text>{`issues:${Object.keys(api.issues).length}:prs:${api.prs.length}:refreshedAt:${api.refreshedAt ?? "none"}`}</Text>
  );
}

describe("useGithubData", () => {
  it("loadIssues populates issues[nwo] and stamps staleAt", async () => {
    const client = makeClient({ issuesByRepo: { "acme/api": [makeDashIssue({ number: 7 })] } });
    let api!: UseGithubDataResult;
    const r = render(
      <Probe
        client={client}
        repoMappings={[mapping("acme/api")]}
        currentNwo="acme/api"
        onReady={(a) => (api = a)}
      />,
    );
    const delivery = await api.loadIssues("acme/api");
    expect(delivery).toEqual({ delivered: true, staleAt: null });
    await until(() => (api.issues["acme/api"]?.length ?? 0) === 1);
    expect(api.issues["acme/api"][0].number).toBe(7);
    expect(api.staleAt["acme/api"]).toBeNull();
    r.unmount();
  });

  it("loadPrs aggregates across every repoMappings entry", async () => {
    const client = makeClient({
      prsByRepo: {
        "acme/api": [makeDashPr({ number: 1, nwo: "acme/api" })],
        "alx/coral": [makeDashPr({ number: 2, nwo: "alx/coral" })],
      },
    });
    let api!: UseGithubDataResult;
    const r = render(
      <Probe
        client={client}
        repoMappings={[mapping("acme/api"), mapping("alx/coral")]}
        currentNwo="acme/api"
        onReady={(a) => (api = a)}
      />,
    );
    const delivery = await api.loadPrs();
    expect(delivery.delivered).toBe(true);
    await until(() => api.prs.length === 2);
    expect(api.prs.map((p) => p.nwo).sort()).toEqual(["acme/api", "alx/coral"]);
    r.unmount();
  });

  it("refreshAll (main scope) loads issues + PRs for the current repo and stamps refreshedAt", async () => {
    const client = makeClient({
      issuesByRepo: { "acme/api": [makeDashIssue({ number: 3 })] },
      prsByRepo: { "acme/api": [makeDashPr({ number: 9, nwo: "acme/api" })] },
    });
    let api!: UseGithubDataResult;
    const r = render(
      <Probe
        client={client}
        repoMappings={[mapping("acme/api")]}
        currentNwo="acme/api"
        onReady={(a) => (api = a)}
      />,
    );
    await api.refreshAll();
    await until(() => api.refreshedAt !== null);
    expect(api.issues["acme/api"]?.[0]?.number).toBe(3);
    expect(api.prs.map((p) => p.number)).toEqual([9]);
    r.unmount();
  });

  it("refreshAll (monitor scope) sweeps PRs for every watched repo, not just the current one", async () => {
    const client = makeClient({
      prsByRepo: {
        "acme/api": [makeDashPr({ number: 1, nwo: "acme/api" })],
        "alx/coral": [makeDashPr({ number: 2, nwo: "alx/coral" })],
      },
    });
    let api!: UseGithubDataResult;
    const r = render(
      <Probe
        client={client}
        repoMappings={[mapping("acme/api"), mapping("alx/coral")]}
        currentNwo="acme/api"
        onReady={(a) => (api = a)}
      />,
    );
    await api.refreshAll({ scope: "monitor" });
    await until(() => api.prs.length === 2);
    expect(api.prs.map((p) => p.nwo).sort()).toEqual(["acme/api", "alx/coral"]);
    r.unmount();
  });

  it("refreshAll does nothing when githubEnabled is false", async () => {
    // Regression seam: the hook must not fire ANY gh cycle when disabled —
    // exercised directly via a second Probe render with githubEnabled hard-wired.
    let calls = 0;
    const client = {
      listIssues: async () => {
        calls++;
        return okv({ issues: [], staleAt: null });
      },
      listPrs: async () => {
        calls++;
        return okv({ prs: [], staleAt: null });
      },
    } as unknown as DashboardClient;
    function DisabledProbe({ onReady }: { onReady: (api: UseGithubDataResult) => void }) {
      const api = useGithubData({
        client,
        trigger: "junco",
        githubEnabled: false,
        repoMappings: [mapping("acme/api")],
        showToast: noopToast,
        refreshPollMs: 999_999,
        filter: "",
        nav: { currentNwo: "acme/api", view: "main", bodyKind: "issues" },
      });
      onReady(api);
      return <Text>ready</Text>;
    }
    let api!: UseGithubDataResult;
    const r = render(<DisabledProbe onReady={(a) => (api = a)} />);
    await api.refreshAll();
    expect(calls).toBe(0);
    r.unmount();
  });

  it("setIssueLabels rewrites just the one issue's labels in place", async () => {
    const client = makeClient({
      issuesByRepo: { "acme/api": [makeDashIssue({ number: 5, labels: ["junco"] })] },
    });
    let api!: UseGithubDataResult;
    const r = render(
      <Probe
        client={client}
        repoMappings={[mapping("acme/api")]}
        currentNwo="acme/api"
        onReady={(a) => (api = a)}
      />,
    );
    await api.loadIssues("acme/api");
    await until(() => (api.issues["acme/api"]?.length ?? 0) === 1);
    api.setIssueLabels("acme/api", 5, ["junco", "junco:plan-ready"]);
    await until(() => (api.issues["acme/api"]?.[0]?.labels ?? []).includes("junco:plan-ready"));
    r.unmount();
  });

  it("the issue-anchor effect assigns the top issue as the selection once issues load", async () => {
    const client = makeClient({ issuesByRepo: { "acme/api": [makeDashIssue({ number: 42 })] } });
    let api!: UseGithubDataResult;
    const r = render(
      <Probe
        client={client}
        repoMappings={[mapping("acme/api")]}
        currentNwo="acme/api"
        onReady={(a) => (api = a)}
      />,
    );
    await api.loadIssues("acme/api");
    await until(() => api.selectedNum["acme/api"] === 42);
    expect(api.issueIdxSafe).toBe(0);
    expect(api.currentIssue?.number).toBe(42);
    r.unmount();
  });

  it("the pane-3 anchor resets to the top PR on a repo change, never carrying over the old repo's slot", async () => {
    const client = makeClient({
      prsByRepo: {
        "acme/api": [makeDashPr({ number: 1, nwo: "acme/api" })],
        "alx/coral": [
          makeDashPr({ number: 2, nwo: "alx/coral" }),
          makeDashPr({ number: 3, nwo: "alx/coral" }),
        ],
      },
    });
    let api!: UseGithubDataResult;
    const repoMappings = [mapping("acme/api"), mapping("alx/coral")];
    const r = render(
      <Probe
        client={client}
        repoMappings={repoMappings}
        currentNwo="acme/api"
        onReady={(a) => (api = a)}
      />,
    );
    await api.loadPrs();
    await until(() => api.pane3SelNum === 1); // scoped to acme/api, the only PR there
    expect(api.repoPrs.map((p) => p.number)).toEqual([1]);

    r.rerender(
      <Probe
        client={client}
        repoMappings={repoMappings}
        currentNwo="alx/coral"
        onReady={(a) => (api = a)}
      />,
    );
    await until(() => api.repoPrs.length === 2);
    // The repo swap must reset pane3SelNum to alx/coral's own top row, not
    // leave the stale acme/api anchor (number 1, absent from this repo) in
    // place waiting for a coincidental number match.
    await until(() => api.pane3SelNum !== null && api.pane3SelNum !== 1);
    expect(api.selectedPane3Pr?.nwo).toBe("alx/coral");
    r.unmount();
  });

  it("evictRepo drops a repo's issues, staleAt, and PRs from the aggregate", async () => {
    const client = makeClient({
      issuesByRepo: { "acme/api": [makeDashIssue({ number: 1 })] },
      prsByRepo: {
        "acme/api": [makeDashPr({ number: 1, nwo: "acme/api" })],
        "alx/coral": [makeDashPr({ number: 2, nwo: "alx/coral" })],
      },
    });
    let api!: UseGithubDataResult;
    const r = render(
      <Probe
        client={client}
        repoMappings={[mapping("acme/api"), mapping("alx/coral")]}
        currentNwo="acme/api"
        onReady={(a) => (api = a)}
      />,
    );
    await api.loadIssues("acme/api");
    await api.loadPrs();
    await until(() => (api.issues["acme/api"]?.length ?? 0) === 1 && api.prs.length === 2);
    api.evictRepo("acme/api");
    await until(() => !("acme/api" in api.issues) && api.prs.length === 1);
    expect(api.issues["acme/api"]).toBeUndefined();
    expect(api.staleAt["acme/api"]).toBeUndefined();
    expect(api.prs.map((p) => p.nwo)).toEqual(["alx/coral"]);
    r.unmount();
  });

  it("moveIssue/movePr/movePane3 move the anchored selection by one slot", async () => {
    const client = makeClient({
      issuesByRepo: {
        "acme/api": [makeDashIssue({ number: 1 }), makeDashIssue({ number: 2 })],
      },
      prsByRepo: {
        "acme/api": [
          makeDashPr({ number: 10, nwo: "acme/api" }),
          makeDashPr({ number: 11, nwo: "acme/api" }),
        ],
      },
    });
    let api!: UseGithubDataResult;
    const r = render(
      <Probe
        client={client}
        repoMappings={[mapping("acme/api")]}
        currentNwo="acme/api"
        onReady={(a) => (api = a)}
      />,
    );
    await api.loadIssues("acme/api");
    await api.loadPrs();
    await until(() => api.filteredIssues.length === 2 && api.repoPrs.length === 2);
    await until(() => api.issueIdxSafe === 0 && api.pane3IdxSafe === 0);

    api.moveIssue(1);
    await until(() => api.issueIdxSafe === 1);
    expect(api.currentIssue?.number).toBe(2);

    api.movePr(1);
    await until(() => api.prIdxSafe === 1);
    expect(api.selectedPr?.number).toBe(11);

    api.movePane3(1);
    await until(() => api.pane3IdxSafe === 1);
    expect(api.selectedPane3Pr?.number).toBe(11);
    r.unmount();
  });

  // The crux invariant of the whole extraction, otherwise only verified by
  // inspection: `loadPrs` closes over `repoMappings` (deps [client, repoMappings]),
  // so `refreshAll` re-identifies when the watchlist changes, and the
  // watchlist-sweep effect (deps [refreshAll]) re-fires a monitor sweep. If a
  // future change stabilizes `refreshAll` (a ref wrapper) or drops `repoMappings`
  // from `loadPrs`'s deps, adding a repo would silently never load its PRs — and
  // this test goes red. `alx/coral`'s PR can only appear via that re-fired sweep,
  // since the test never calls refreshAll/loadPrs itself.
  it("dep-identity chain: adding a repo re-fires the sweep with no explicit refresh", async () => {
    const client = makeClient({
      prsByRepo: {
        "acme/api": [makeDashPr({ number: 1, nwo: "acme/api" })],
        "alx/coral": [makeDashPr({ number: 2, nwo: "alx/coral" })],
      },
    });
    let api!: UseGithubDataResult;
    const r = render(
      <Probe
        client={client}
        repoMappings={[mapping("acme/api")]}
        currentNwo="acme/api"
        onReady={(a) => (api = a)}
      />,
    );
    // The mount sweep loads only the one watched repo.
    await until(() => api.prs.some((p) => p.nwo === "acme/api"));
    expect(api.prs.some((p) => p.nwo === "alx/coral")).toBe(false);
    // Add a repo to the watchlist — NO explicit refresh. The identity chain
    // alone must re-fire the sweep and pull in the new repo's PRs.
    r.rerender(
      <Probe
        client={client}
        repoMappings={[mapping("acme/api"), mapping("alx/coral")]}
        currentNwo="acme/api"
        onReady={(a) => (api = a)}
      />,
    );
    await until(() => api.prs.some((p) => p.nwo === "alx/coral"));
    r.unmount();
  });
});
