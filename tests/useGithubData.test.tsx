// tests/useGithubData.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useGithubData } from "../src/tui/hooks/useGithubData.js";
import type { UseGithubDataResult } from "../src/tui/hooks/useGithubData.js";
import type { DashboardClient, Result } from "../src/tui/ghClient.js";
import type { WatchedMapping } from "../src/tui/railModel.js";
import type { View } from "../src/tui/App.js";
import { makeDashIssue, makeDashPr } from "./helpers/dashFixtures.js";
import { until } from "./helpers/until.js";

const okv = <T,>(value: T): Result<T> => ({ ok: true, value });

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
  onReady,
}: {
  client: DashboardClient;
  repoMappings: WatchedMapping[];
  currentNwo: string | undefined;
  view?: View;
  bodyKind?: "issues" | "repoDetail" | "section" | null;
  onReady: (api: UseGithubDataResult) => void;
}) {
  const toasts: [string, string][] = [];
  const api = useGithubData({
    client,
    trigger: "junco",
    githubEnabled: true,
    repoMappings,
    showToast: (kind, text) => toasts.push([kind, text]),
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
        showToast: () => {},
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
});
