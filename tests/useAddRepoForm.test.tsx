// tests/useAddRepoForm.test.tsx
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useAddRepoForm } from "../src/tui/hooks/useAddRepoForm.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { ConfirmState } from "../src/tui/hooks/useConfirm.js";
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
    botGrantPreflight: async () => okv({ needed: false as const }),
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
  askConfirm,
  onReady,
}: {
  client: DashboardClient;
  clonesDir: string;
  addEntry: (e: WatchlistEntry) => boolean;
  showToast: (kind: ToastKind, text: string) => void;
  setView: (v: View) => void;
  aliveRef: React.MutableRefObject<boolean>;
  watchlistError: string | null;
  askConfirm: (state: ConfirmState) => void;
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
    askConfirm,
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
  confirms: ConfirmState[];
  r: ReturnType<typeof render>;
} {
  const toasts: { kind: ToastKind; text: string }[] = [];
  const views: View[] = [];
  const entries: WatchlistEntry[] = [];
  const confirms: ConfirmState[] = [];
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
      askConfirm={(s) => confirms.push(s)}
      onReady={(a) => (apiRef = a)}
    />,
  );
  return {
    api: () => apiRef!,
    toasts,
    views,
    entries,
    confirms,
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

describe("useAddRepoForm: bot-grant confirm gate", () => {
  const gated = () => okv({ needed: true as const, login: "junco-agent", privatePersonal: true });

  it("private personal repo: opens the confirm gate naming the bot, grant deferred", async () => {
    const ensureBotAccess = vi.fn(async () => okv({ skipped: false, login: "junco-agent" }));
    const client = makeClient({ botGrantPreflight: async () => gated(), ensureBotAccess });
    const { api, confirms, toasts, r } = renderProbe({ client });
    await api().handleAddRepo("acme/api", "/repos/api");
    await until(() => confirms.length > 0);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.title).toBe("invite bot as collaborator?");
    expect(confirms[0]!.body).toContain("acme/api");
    expect(confirms[0]!.body).toContain("junco-agent");
    expect(confirms[0]!.danger).toBe(false);
    expect(ensureBotAccess).not.toHaveBeenCalled();
    expect(toasts).toEqual([{ kind: "success", text: "watching acme/api" }]);

    confirms[0]!.onConfirm();
    await until(() => ensureBotAccess.mock.calls.length > 0);
    await until(() => toasts.length > 1);
    expect(toasts[1]).toEqual({
      kind: "success",
      text: "bot junco-agent granted write on acme/api",
    });
    r.unmount();
  });

  it("cancelling the gate skips the grant and toasts the escape hatch", async () => {
    const ensureBotAccess = vi.fn(async () => okv({ skipped: false, login: "junco-agent" }));
    const client = makeClient({ botGrantPreflight: async () => gated(), ensureBotAccess });
    const { api, confirms, toasts, r } = renderProbe({ client });
    await api().handleAddRepo("acme/api", "/repos/api");
    await until(() => confirms.length > 0);

    confirms[0]!.onCancel!();
    await until(() => toasts.length > 1);
    expect(toasts[1]).toEqual({
      kind: "info",
      text: "bot access skipped — grant later with: junco auth grant acme/api",
    });
    expect(ensureBotAccess).not.toHaveBeenCalled();
    r.unmount();
  });

  it("public or org repo (no gate) grants directly as before", async () => {
    const ensureBotAccess = vi.fn(async () => okv({ skipped: false, login: "junco-agent" }));
    const client = makeClient({
      botGrantPreflight: async () =>
        okv({ needed: true as const, login: "junco-agent", privatePersonal: false }),
      ensureBotAccess,
    });
    const { api, confirms, toasts, r } = renderProbe({ client });
    await api().handleAddRepo("acme/api", "/repos/api");
    await until(() => toasts.length > 1);
    expect(confirms).toEqual([]);
    expect(ensureBotAccess).toHaveBeenCalledTimes(1);
    expect(toasts[1]).toEqual({
      kind: "success",
      text: "bot junco-agent granted write on acme/api",
    });
    r.unmount();
  });

  it("preflight needed:false ends the flow without a gate or a grant call", async () => {
    const ensureBotAccess = vi.fn(async () => okv({ skipped: true }));
    const client = makeClient({ ensureBotAccess });
    const { api, confirms, toasts, entries, r } = renderProbe({ client });
    await api().handleAddRepo("acme/api", "/repos/api");
    await until(() => entries.length > 0);
    // The preflight resolves after the watching toast; give the chain a tick.
    await new Promise((res) => setTimeout(res, 5));
    expect(confirms).toEqual([]);
    expect(ensureBotAccess).not.toHaveBeenCalled();
    expect(toasts).toEqual([{ kind: "success", text: "watching acme/api" }]);
    r.unmount();
  });

  it("preflight failure falls back to the legacy direct grant (its own error surfacing)", async () => {
    const ensureBotAccess = vi.fn(async () => ({
      ok: false as const,
      error: "bot auth is broken — run: junco auth login",
    }));
    const client = makeClient({
      botGrantPreflight: async () => ({ ok: false as const, error: "offline" }),
      ensureBotAccess,
    });
    const { api, confirms, toasts, r } = renderProbe({ client });
    await api().handleAddRepo("acme/api", "/repos/api");
    await until(() => toasts.length > 1);
    expect(confirms).toEqual([]);
    expect(ensureBotAccess).toHaveBeenCalledTimes(1);
    expect(toasts[1]).toEqual({
      kind: "error",
      text: "bot access: bot auth is broken — run: junco auth login",
    });
    r.unmount();
  });

  it("unmount between preflight and gate drops the confirm (aliveRef guard)", async () => {
    const aliveRef = { current: true };
    let releasePreflight: (() => void) | undefined;
    const client = makeClient({
      botGrantPreflight: () =>
        new Promise((res) => {
          releasePreflight = () => res(gated());
        }),
    });
    const { api, confirms, r } = renderProbe({ client, aliveRef });
    const promise = api().handleAddRepo("acme/api", "/repos/api");
    await until(() => releasePreflight !== undefined);
    aliveRef.current = false; // simulate unmount
    releasePreflight!();
    await promise;
    expect(confirms).toEqual([]);
    r.unmount();
  });
});
