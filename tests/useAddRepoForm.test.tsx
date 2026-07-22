// tests/useAddRepoForm.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useAddRepoForm } from "../src/tui/hooks/useAddRepoForm.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { WatchlistEntry } from "../src/watchlist.js";
import type { ToastKind } from "../src/tui/theme.js";
import type { View } from "../src/tui/App.js";
import { until } from "./helpers/until.js";

const okv = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value });

function makeClient(overrides: Partial<DashboardClient> = {}): DashboardClient {
  return {
    repoPermission: async () => okv({ canPush: true }),
    prepareExternalRepo: async () => okv({ path: "/managed/fork", forkNwo: "me/fork" }),
    cloneRepo: async () => okv(undefined),
    validateAndPrepareRepo: async () => okv(undefined),
    ensureBotAccess: async () => okv({ skipped: true }),
    ...overrides,
  } as unknown as DashboardClient;
}

function Probe({
  client,
  clonesDir,
  addEntry,
  showToast,
  setView,
  aliveRef,
  watchlistError,
  onReady,
}: {
  client: DashboardClient;
  clonesDir: string;
  addEntry: (e: WatchlistEntry) => boolean;
  showToast: (kind: ToastKind, text: string) => void;
  setView: (v: View) => void;
  aliveRef: React.MutableRefObject<boolean>;
  watchlistError: string | null;
  onReady: (api: ReturnType<typeof useAddRepoForm>) => void;
}) {
  const api = useAddRepoForm({
    client,
    clonesDir,
    addEntry,
    showToast,
    setView,
    aliveRef,
    watchlistError,
  });
  onReady(api);
  return <Text>{`error:${api.addRepoError ?? "none"}:busy:${api.addRepoBusy ?? "none"}`}</Text>;
}

function renderProbe(opts: {
  client: DashboardClient;
  clonesDir?: string;
  addEntry?: (e: WatchlistEntry) => boolean;
  showToast?: (kind: ToastKind, text: string) => void;
  setView?: (v: View) => void;
  aliveRef?: React.MutableRefObject<boolean>;
  watchlistError?: string | null;
}): {
  api: () => ReturnType<typeof useAddRepoForm>;
  toasts: { kind: ToastKind; text: string }[];
  views: View[];
  entries: WatchlistEntry[];
  r: ReturnType<typeof render>;
} {
  const toasts: { kind: ToastKind; text: string }[] = [];
  const views: View[] = [];
  const entries: WatchlistEntry[] = [];
  let apiRef: ReturnType<typeof useAddRepoForm> | undefined;
  const showToast =
    opts.showToast ?? ((kind: ToastKind, text: string) => toasts.push({ kind, text }));
  const setView = opts.setView ?? ((v: View) => views.push(v));
  const addEntry =
    opts.addEntry ??
    ((e: WatchlistEntry) => {
      entries.push(e);
      return true;
    });
  const aliveRef = opts.aliveRef ?? { current: true };
  const r = render(
    <Probe
      client={opts.client}
      clonesDir={opts.clonesDir ?? "/clones"}
      addEntry={addEntry}
      showToast={showToast}
      setView={setView}
      aliveRef={aliveRef}
      watchlistError={opts.watchlistError ?? null}
      onReady={(a) => (apiRef = a)}
    />,
  );
  return {
    api: () => apiRef!,
    toasts,
    views,
    entries,
    r,
  };
}

describe("useAddRepoForm", () => {
  it("starts with null addRepoError and addRepoBusy", () => {
    const { r } = renderProbe({ client: makeClient() });
    expect(r.lastFrame()).toBe("error:none:busy:none");
    r.unmount();
  });

  it("a valid owned repo with an explicit path validates, persists, navigates, and toasts success", async () => {
    const { api, entries, views, toasts, r } = renderProbe({ client: makeClient() });
    await api().handleAddRepo("acme/api", "/repos/api");
    await until(() => entries.length > 0);
    expect(entries).toEqual([{ nwo: "acme/api", path: "/repos/api" }]);
    expect(views).toEqual(["main"]);
    expect(toasts).toEqual([{ kind: "success", text: "watching acme/api" }]);
    r.unmount();
  });

  it("parse failure sets addRepoError and never calls addEntry", async () => {
    const { api, entries, r } = renderProbe({ client: makeClient() });
    await api().handleAddRepo("not a valid nwo!!", "");
    await until(() => api().addRepoError !== null);
    expect(entries).toEqual([]);
    expect(api().addRepoError).toBe(
      "enter owner/repo or a github.com URL (e.g. https://github.com/acme/api)",
    );
    r.unmount();
  });

  it("unmounting mid-permission-probe (aliveRef flips false) drops the continuation before addEntry", async () => {
    const aliveRef = { current: true };
    let releaseProbe: (() => void) | undefined;
    const client = makeClient({
      repoPermission: () =>
        new Promise((res) => {
          releaseProbe = () => res(okv({ canPush: true }));
        }),
    });
    const { api, entries, r } = renderProbe({ client, aliveRef });
    const promise = api().handleAddRepo("acme/api", "/repos/api");
    await until(() => releaseProbe !== undefined);
    aliveRef.current = false; // simulate unmount
    releaseProbe!();
    await promise;
    expect(entries).toEqual([]);
    r.unmount();
  });

  it("watchlistError pre-check toasts and returns without probing", async () => {
    const client = makeClient();
    const { api, entries, toasts, r } = renderProbe({ client, watchlistError: "corrupt" });
    await api().handleAddRepo("acme/api", "/repos/api");
    expect(entries).toEqual([]);
    expect(toasts).toEqual([
      { kind: "error", text: "watchlist unreadable — fix it before writing" },
    ]);
    r.unmount();
  });

  it("no-push repo with an empty path routes to fork provisioning and persists an external entry", async () => {
    const client = makeClient({ repoPermission: async () => okv({ canPush: false }) });
    const { api, entries, views, toasts, r } = renderProbe({ client });
    await api().handleAddRepo("acme/api", "");
    await until(() => entries.length > 0);
    expect(entries).toEqual([{ nwo: "acme/api", path: "/managed/fork", external: true }]);
    expect(views).toEqual(["main"]);
    expect(toasts).toEqual([
      { kind: "success", text: "watching acme/api (fork-PR mode via me/fork)" },
    ]);
    r.unmount();
  });
});
