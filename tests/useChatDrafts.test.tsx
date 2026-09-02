// tests/useChatDrafts.test.tsx — the four draft verbs (spec 2026-09-01 §6.4,
// §6.6) plus the two pure helpers they build on.
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { nextRoute, submitArgv, useChatDrafts } from "../src/tui/hooks/useChatDrafts.js";
import type { PendingDraft } from "../src/chat/draftStore.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import { okv, stubClient } from "./helpers/localFixtures.js";

const file = (name: string, route: "inbox" | "issue" | null = "inbox") => ({
  name,
  content: "",
  lint: [],
  droppedKeys: [],
  route:
    route === null
      ? null
      : {
          destination: route,
          reasons: [],
          watchedNwo: route === "issue" ? "acme/api" : null,
          carriedTimeout: null,
          discarded: [],
        },
});
const draft = (over: Partial<PendingDraft> = {}): PendingDraft => ({
  id: "acme__api-1",
  key: "acme/api",
  slug: "acme__api",
  kind: "ticket",
  files: [file("t.md")],
  cwd: "/repo",
  nwo: "acme/api",
  createdAt: "t",
  lintFailed: false,
  blocked: null,
  routeOverride: "auto",
  commandArgs: null,
  ...over,
});
const fp = (name: string) => `/drafts/acme__api-1/${name}`;

describe("submitArgv (pure, spec 2026-09-01 §6.1, §6.4)", () => {
  it("maps kind × route override onto the CLI verbs", () => {
    expect(submitArgv(draft(), fp)).toEqual([["submit", "/drafts/acme__api-1/t.md"]]);
    expect(submitArgv(draft({ files: [file("t.md", "issue")] }), fp)).toEqual([
      ["submit", "--as-issue", "/drafts/acme__api-1/t.md"],
    ]);
    expect(
      submitArgv(draft({ routeOverride: "inbox", files: [file("t.md", "issue")] }), fp),
    ).toEqual([["submit", "/drafts/acme__api-1/t.md"]]);
    expect(submitArgv(draft({ routeOverride: "issue" }), fp)).toEqual([
      ["submit", "--as-issue", "/drafts/acme__api-1/t.md"],
    ]);
    expect(
      submitArgv(draft({ kind: "ticketSet", files: [file("a.md"), file("b.md")] }), fp),
    ).toEqual([
      ["submit", "/drafts/acme__api-1/a.md"],
      ["submit", "/drafts/acme__api-1/b.md"],
    ]);
    expect(submitArgv(draft({ kind: "planSet", files: [file("plan.md", null)] }), fp)).toEqual([
      ["submit", "--plan", "/drafts/acme__api-1/plan.md", "--repo", "/repo"],
    ]);
    expect(
      submitArgv(
        draft({ kind: "planSet", routeOverride: "issue", files: [file("plan.md", null)] }),
        fp,
      ),
    ).toEqual([
      ["submit", "--as-issue", "--plan", "/drafts/acme__api-1/plan.md", "--repo", "/repo"],
    ]);
    expect(
      submitArgv(
        draft({
          kind: "audit",
          commandArgs: ["audit", "acme/api", "--auto-plan"],
          files: [file("a.md", null)],
        }),
        fp,
      ),
    ).toEqual([["audit", "acme/api", "--auto-plan"]]);
    expect(
      submitArgv(
        draft({
          kind: "investigate",
          commandArgs: ["investigate", "acme/api#7"],
          files: [file("z.md", null)],
        }),
        fp,
      ),
    ).toEqual([["investigate", "acme/api#7"]]);
  });
  it("a command draft with no commandArgs yields nothing to run", () => {
    expect(submitArgv(draft({ kind: "audit", commandArgs: null }), fp)).toEqual([]);
    expect(submitArgv(draft({ kind: "investigate", commandArgs: null }), fp)).toEqual([]);
  });
  it("nextRoute cycles auto → inbox → issue → auto", () => {
    expect(nextRoute("auto")).toBe("inbox");
    expect(nextRoute("inbox")).toBe("issue");
    expect(nextRoute("issue")).toBe("auto");
  });
});

function Probe({
  client,
  runCliFn,
  showCmdResult,
  editFileFn,
  onReady,
  changed,
  toasts,
  alive = true,
}: {
  client: DashboardClient;
  runCliFn: (
    n: string,
    a: string[],
  ) => Promise<{ code: number | null; output: string; timedOut: boolean }>;
  showCmdResult: (n: string, a: string[], r: unknown) => void;
  editFileFn: (p: string) => Promise<void>;
  onReady: (a: ReturnType<typeof useChatDrafts>) => void;
  changed: () => void;
  toasts: string[];
  alive?: boolean;
}) {
  const aliveRef = React.useRef(alive);
  const api = useChatDrafts({
    client,
    runCliFn,
    showCmdResult: showCmdResult as never,
    editFileFn,
    suspend: async (fn) => fn(),
    showToast: (k, t) => void toasts.push(`${k}:${t}`),
    aliveRef,
    onChanged: changed,
    draftFilePath: (_id, name) => fp(name),
  });
  onReady(api);
  return <Text>probe</Text>;
}

/** Mount the hook with per-test seams; every field has a silent default. */
function mount(
  over: {
    client?: DashboardClient;
    runCliFn?: (
      n: string,
      a: string[],
    ) => Promise<{ code: number | null; output: string; timedOut: boolean }>;
    showCmdResult?: (n: string, a: string[], r: unknown) => void;
    editFileFn?: (p: string) => Promise<void>;
    changed?: () => void;
    alive?: boolean;
  } = {},
) {
  const toasts: string[] = [];
  let api!: ReturnType<typeof useChatDrafts>;
  const r = render(
    <Probe
      client={over.client ?? stubClient}
      runCliFn={over.runCliFn ?? (async () => ({ code: 0, output: "", timedOut: false }))}
      showCmdResult={over.showCmdResult ?? (() => {})}
      editFileFn={over.editFileFn ?? (async () => {})}
      onReady={(a) => (api = a)}
      changed={over.changed ?? (() => {})}
      toasts={toasts}
      alive={over.alive ?? true}
    />,
  );
  return { api, toasts, unmount: r.unmount };
}

describe("useChatDrafts", () => {
  it("submit: runs every argv in order, archives, notes the transcript, toasts, and reloads", async () => {
    const ran: string[][] = [];
    const notes: unknown[] = [];
    const archived: string[] = [];
    const client: DashboardClient = {
      ...stubClient,
      archiveSubmittedChatDraft: async (id) => (archived.push(id), { ok: true, value: null }),
      chat: {
        ...stubClient.chat,
        note: async (_k, rec) => (notes.push(rec), { ok: true, value: null }),
      },
    };
    let changed = 0;
    const { api, toasts, unmount } = mount({
      client,
      runCliFn: async (n, a) => (
        ran.push([n, ...a]),
        { code: 0, output: "queued: /inbox/a.md\n", timedOut: false }
      ),
      changed: () => changed++,
    });
    await api.submit(draft({ kind: "ticketSet", files: [file("a.md"), file("b.md")] }));
    expect(ran).toEqual([
      ["submit", "/drafts/acme__api-1/a.md"],
      ["submit", "/drafts/acme__api-1/b.md"],
    ]);
    expect(archived).toEqual(["acme__api-1"]);
    expect(notes[0]).toMatchObject({
      type: "junco_chat_draft",
      draftId: "acme__api-1",
      status: "submitted",
      ids: ["a", "b"],
      destination: "inbox",
    });
    expect(toasts[0]).toMatch(/^success:submitted/);
    expect(changed).toBe(1);
    unmount();
  });

  it("submit: an --as-issue draft notes destination issue; a command draft notes 'command'", async () => {
    const notes: Array<{ destination: string | null }> = [];
    const client: DashboardClient = {
      ...stubClient,
      chat: {
        ...stubClient.chat,
        note: async (_k, rec) => (
          notes.push(rec as unknown as { destination: string | null }),
          { ok: true, value: null }
        ),
      },
    };
    const { api, unmount } = mount({ client });
    await api.submit(draft({ routeOverride: "issue" }));
    await api.submit(
      draft({ kind: "audit", commandArgs: ["audit", "acme/api"], files: [file("a.md", null)] }),
    );
    expect(notes.map((n) => n.destination)).toEqual(["issue", "command"]);
    unmount();
  });

  it("submit: a non-zero exit stops the sequence, shows the command result, keeps the draft parked", async () => {
    const ran: string[][] = [];
    const shown: unknown[] = [];
    const archived: string[] = [];
    const client: DashboardClient = {
      ...stubClient,
      archiveSubmittedChatDraft: async (id) => (archived.push(id), { ok: true, value: null }),
    };
    const { api, toasts, unmount } = mount({
      client,
      runCliFn: async (n, a) => (
        ran.push([n, ...a]),
        { code: 1, output: "refused: not bridge-watched\n", timedOut: false }
      ),
      showCmdResult: (...a) => shown.push(a),
    });
    await api.submit(
      draft({ kind: "ticketSet", routeOverride: "issue", files: [file("a.md"), file("b.md")] }),
    );
    expect(ran).toHaveLength(1);
    expect(archived).toEqual([]);
    expect(shown[0]).toEqual([
      "submit",
      ["--as-issue", "/drafts/acme__api-1/a.md"],
      { code: 1, output: "refused: not bridge-watched\n", timedOut: false },
    ]);
    // Nothing landed before the failure, so no partial-count toast.
    expect(toasts).toEqual([]);
    unmount();
  });

  it("submit: a set that fails partway names how many landed before the failure", async () => {
    let call = 0;
    const { api, toasts, unmount } = mount({
      runCliFn: async () => ({
        code: ++call === 2 ? 1 : 0,
        output: "boom\n",
        timedOut: false,
      }),
    });
    await api.submit(
      draft({ kind: "ticketSet", files: [file("a.md"), file("b.md"), file("c.md")] }),
    );
    expect(call).toBe(2);
    expect(toasts).toEqual(["error:1 of 3 submitted before a failure"]);
    unmount();
  });

  it("submit refuses a lintFailed or blocked draft with a toast", async () => {
    const ran: string[][] = [];
    const { api, toasts, unmount } = mount({
      runCliFn: async (n, a) => (ran.push([n, ...a]), { code: 0, output: "", timedOut: false }),
    });
    await api.submit(draft({ lintFailed: true }));
    await api.submit(
      draft({ kind: "planSet", blocked: "plan_sets_disabled", files: [file("plan.md", null)] }),
    );
    await api.submit(draft({ kind: "audit", commandArgs: null }));
    expect(ran).toEqual([]);
    expect(toasts).toEqual([
      "error:draft failed lint — edit it first (e)",
      "error:draft blocked: plan sets disabled",
      "error:nothing to submit",
    ]);
    unmount();
  });

  it("submit: a transcript-note failure still archives the draft and says so", async () => {
    const archived: string[] = [];
    const client: DashboardClient = {
      ...stubClient,
      archiveSubmittedChatDraft: async (id) => (archived.push(id), { ok: true, value: null }),
      chat: { ...stubClient.chat, note: async () => ({ ok: false, error: "daemon down" }) },
    };
    const { api, toasts, unmount } = mount({ client });
    await api.submit(draft());
    expect(archived).toEqual(["acme__api-1"]);
    expect(toasts[0]).toBe("error:submitted → inbox (transcript note failed: daemon down)");
    unmount();
  });

  it("submit: a failed archive is the whole story — no 'submitted' note, no reload", async () => {
    const notes: unknown[] = [];
    const client: DashboardClient = {
      ...stubClient,
      archiveSubmittedChatDraft: async () => ({ ok: false, error: "read-only store" }),
      chat: { ...stubClient.chat, note: async (_k, rec) => (notes.push(rec), okv(null)) },
    };
    let changed = 0;
    const { api, toasts, unmount } = mount({ client, changed: () => changed++ });
    await api.submit(draft());
    expect(notes).toEqual([]);
    expect(changed).toBe(0);
    expect(toasts).toEqual(["error:submitted, but the draft did not archive: read-only store"]);
    unmount();
  });

  it("submit: an unmounted dashboard stops before archiving", async () => {
    const archived: string[] = [];
    const client: DashboardClient = {
      ...stubClient,
      archiveSubmittedChatDraft: async (id) => (archived.push(id), { ok: true, value: null }),
    };
    const { api, toasts, unmount } = mount({ client, alive: false });
    await api.submit(draft());
    expect(archived).toEqual([]);
    expect(toasts).toEqual([]);
    unmount();
  });

  it("edit opens every file in the editor under suspend, then re-lints; route cycles and persists; discard archives", async () => {
    const edited: string[] = [];
    const updated: PendingDraft[] = [];
    const relinted: string[] = [];
    const discarded: string[] = [];
    const notes: Array<{ status: string }> = [];
    const client: DashboardClient = {
      ...stubClient,
      relintChatDraft: async (id) => (relinted.push(id), { ok: true, value: draft({ id }) }),
      updateChatDraft: async (d) => (updated.push(d), { ok: true, value: null }),
      discardChatDraft: async (id) => (discarded.push(id), { ok: true, value: null }),
      chat: {
        ...stubClient.chat,
        note: async (_k, rec) => (
          notes.push(rec as unknown as { status: string }),
          { ok: true, value: null }
        ),
      },
    };
    const { api, toasts, unmount } = mount({
      client,
      editFileFn: async (p) => void edited.push(p),
    });
    await api.edit(draft({ kind: "ticketSet", files: [file("a.md"), file("b.md")] }));
    expect(edited).toEqual(["/drafts/acme__api-1/a.md", "/drafts/acme__api-1/b.md"]);
    expect(relinted).toEqual(["acme__api-1"]);
    expect(toasts).toEqual(["success:lint ok"]);
    await api.route(draft());
    expect(updated[0]!.routeOverride).toBe("inbox");
    await api.discard(draft());
    expect(discarded).toEqual(["acme__api-1"]);
    expect(notes[0]).toMatchObject({ status: "discarded", destination: null, ids: [] });
    expect(toasts).toEqual(["success:lint ok", "success:draft discarded"]);
    unmount();
  });

  it("edit: a still-failing re-lint says so; a failed re-lint surfaces the error", async () => {
    const failing: DashboardClient = {
      ...stubClient,
      relintChatDraft: async (id) => ({ ok: true, value: draft({ id, lintFailed: true }) }),
    };
    const a = mount({ client: failing });
    await a.api.edit(draft());
    expect(a.toasts).toEqual(["error:still failing lint"]);
    a.unmount();

    const broken: DashboardClient = {
      ...stubClient,
      relintChatDraft: async () => ({ ok: false, error: "no chat draft 'x'" }),
    };
    let changed = 0;
    const b = mount({ client: broken, changed: () => changed++ });
    await b.api.edit(draft());
    expect(b.toasts).toEqual(["error:no chat draft 'x'"]);
    expect(changed).toBe(0);
    b.unmount();
  });

  it("route and discard surface a client failure as a toast without reloading", async () => {
    const client: DashboardClient = {
      ...stubClient,
      updateChatDraft: async () => ({ ok: false, error: "disk full" }),
      discardChatDraft: async () => ({ ok: false, error: "gone" }),
    };
    let changed = 0;
    const { api, toasts, unmount } = mount({ client, changed: () => changed++ });
    await api.route(draft());
    await api.discard(draft());
    expect(toasts).toEqual(["error:disk full", "error:gone"]);
    expect(changed).toBe(0);
    unmount();
  });

  it("route, edit and discard stop at an unmounted dashboard", async () => {
    const updated: PendingDraft[] = [];
    const client: DashboardClient = {
      ...stubClient,
      relintChatDraft: async (id) => ({ ok: true, value: draft({ id }) }),
      updateChatDraft: async (d) => (updated.push(d), { ok: true, value: null }),
    };
    let changed = 0;
    const { api, toasts, unmount } = mount({ client, alive: false, changed: () => changed++ });
    await api.route(draft());
    await api.edit(draft());
    await api.discard(draft());
    expect(updated).toHaveLength(1); // the write happened; the reload did not
    expect(toasts).toEqual([]);
    expect(changed).toBe(0);
    unmount();
  });
});
