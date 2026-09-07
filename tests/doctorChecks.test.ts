/**
 * Per-check unit tests for the `CHECKS` table (#355).
 *
 * `tests/doctor.test.ts` pins the RENDERED report end-to-end and stays the
 * behavioural contract; this file pins the table itself — that report order is
 * array order, that ids are unique and stable, that a check with nothing to say
 * says nothing, and that each check can be driven on its own without running
 * the other twenty-four.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKS,
  createDoctorCtx,
  serverThinkingFlag,
  type DoctorCheck,
  type DoctorCtx,
  type DoctorDeps,
  type Finding,
} from "../src/doctor.js";
import { makeConfig, type ConfigSeams } from "./helpers/config.js";
import { outboxPaths } from "../src/githubOutbox.js";
import { writePending } from "../src/assessReview.js";
import { writeDraft } from "../src/commentReview.js";
import { recordRun } from "../src/assessHistory.js";
import { SKILL_DIR_NAME } from "../src/skillLinks.js";
import type { Config } from "../src/types.js";
import type { ResolvedModelInfo } from "../src/agent/session.js";

const SEAMS: ConfigSeams = {
  dataDir: "/sbxroot/doc-data",
  queueRoot: "/sbxroot/doc-queue",
  worktreeRoot: "/sbxroot/doc-wt",
  tools: [],
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: false,
  healthEnabled: true,
  removeWorktreeOnSuccess: false,
};

/** A local (never catalog-eligible) model, so `endpoint-model` takes the
 * reachability branch deterministically — the catalog/auth branch is covered
 * end-to-end in doctor.test.ts. */
function cfgOf(overrides: Partial<Config> = {}): Config {
  const base = makeConfig(SEAMS);
  return makeConfig(SEAMS, {
    model: { ...base.model, id: "local/m" },
    gitBin: "git",
    ghBin: "gh",
    ...overrides,
  });
}

/** Hermetic ctx: nothing here touches the network, the real environment, or
 * the real filesystem unless a test hands it a real path on purpose. */
function ctxOf(
  cfg: Config | null,
  over: Partial<DoctorDeps> = {},
  configPath = "/sbxroot/home/.junco/config.json",
): DoctorCtx {
  const ctx = createDoctorCtx(configPath, {
    execFn: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    reachableFn: async () => true,
    fetchModelsFn: async () => ["m"],
    accessOkFn: () => true,
    lockHolderFn: () => null,
    readTemplateFn: () => "template",
    checkUpdateFn: async () => null,
    env: { HOME: "/sbxroot/home" },
    existsFn: () => false,
    readdirFn: () => [],
    lstatFn: () => ({ isSymbolicLink: () => true }),
    statFn: () => {
      throw new Error("ENOENT");
    },
    ...over,
  });
  ctx.cfg = cfg;
  return ctx;
}

function check(id: string): DoctorCheck {
  const found = CHECKS.find((c) => c.id === id);
  if (!found) throw new Error(`no check with id "${id}"`);
  return found;
}

/** `<mark> label — detail`, the way runDoctor renders it. */
function render(f: Finding): string {
  const mark = f.v === "ok" ? "✓" : f.v === "info" ? "ℹ" : f.v === "warn" ? "⚠" : "✗";
  return `${mark} ${f.label}${f.detail ? ` — ${f.detail}` : ""}`;
}

/** The report order, as data. A reordering or a rename is a behaviour change
 * for the operator reading the output, so it has to be edited here too. */
const EXPECTED_ORDER = [
  "config",
  "node",
  "config-deprecations",
  "data-migrations",
  "dual-data-roots",
  "config-relocation",
  "legacy-worktree-root",
  "skill-links",
  "git-gh",
  "bot-account",
  "sandbox-backend",
  "sandbox-policy",
  "endpoint-model",
  "planner-model",
  "dirs-writable",
  "data-tree-modes",
  "split-queue",
  "health-bind",
  "chat",
  "chat-thinking",
  "github-bridge",
  "outbox",
  "audit-review",
  "audit-history",
  "investigate-drafts",
  "daemon",
  "update-check",
];

describe("the CHECKS table", () => {
  it("runs in the pinned order — position in the array IS the report order", () => {
    expect(CHECKS.map((c) => c.id)).toEqual(EXPECTED_ORDER);
  });

  it("has unique ids (the collision the numeric labels could not prevent)", () => {
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
  });

  it("every check but config/node contributes nothing when the config failed to load", async () => {
    const ctx = ctxOf(null);
    for (const c of CHECKS) {
      if (c.id === "config" || c.id === "node") continue;
      expect(await c.run(ctx), `check "${c.id}" must skip a null config`).toEqual([]);
    }
  });
});

describe("check: config", () => {
  it("loads the config, reports the path, and hands cfg to the rest of the table", async () => {
    const cfg = cfgOf();
    const ctx = ctxOf(null, { loadConfigFn: () => cfg });
    expect(await check("config").run(ctx)).toEqual([
      { v: "ok", label: "config", detail: "/sbxroot/home/.junco/config.json" },
    ]);
    expect(ctx.cfg).toBe(cfg);
  });

  it("fails with the loader's message and leaves cfg null", async () => {
    const ctx = ctxOf(null, {
      loadConfigFn: () => {
        throw new Error("bad json");
      },
    });
    const [f] = await check("config").run(ctx);
    expect(f.v).toBe("fail");
    expect(f.detail).toBe("/sbxroot/home/.junco/config.json: bad json");
    expect(ctx.cfg).toBeNull();
  });
});

describe("check: node", () => {
  it("reports the running node version, config or no config", async () => {
    const findings = await check("node").run(ctxOf(null));
    expect(findings).toHaveLength(1);
    expect(findings[0].label).toBe("node");
    expect(findings[0].detail).toContain(process.versions.node);
  });
});

describe("check: config-deprecations", () => {
  it("warns listing the legacy keys", async () => {
    const cfg = cfgOf({
      legacy: { ...cfgOf().legacy, vaultRoot: true },
    });
    const [f] = await check("config-deprecations").run(ctxOf(cfg));
    expect(f.v).toBe("warn");
    expect(f.label).toBe("deprecated config keys");
    expect(f.detail).toContain("vaultRoot");
  });

  it("is silent for a clean config", async () => {
    expect(await check("config-deprecations").run(ctxOf(cfgOf()))).toEqual([]);
  });
});

describe("check: data-migrations", () => {
  it("warns with the from -> to pair and the migrate hint", async () => {
    const cfg = cfgOf();
    const legacyDir = join(cfg.dataDir, "assess-review");
    const [f] = await check("data-migrations").run(
      ctxOf(cfg, { existsFn: (p) => p === legacyDir }),
    );
    expect(f.v).toBe("warn");
    expect(f.label).toBe("unmigrated data dirs");
    expect(f.detail).toContain(legacyDir);
    expect(f.detail).toContain("junco data migrate");
  });

  it("is silent when nothing is pending", async () => {
    expect(await check("data-migrations").run(ctxOf(cfgOf()))).toEqual([]);
  });
});

describe("check: dual-data-roots", () => {
  it("warns naming both roots when each holds a tree", async () => {
    const cfg = cfgOf({ dataDir: "/sbxroot/home/.junco" });
    const [f] = await check("dual-data-roots").run(
      ctxOf(cfg, {
        existsFn: (p) =>
          p.startsWith("/sbxroot/home/.junco/queue") ||
          p.startsWith("/sbxroot/home/.local/state/junco/queue"),
      }),
    );
    expect(f.v).toBe("warn");
    expect(f.detail).toContain("/sbxroot/home/.local/state/junco");
  });

  it("is silent when only one root holds a tree", async () => {
    const cfg = cfgOf({ dataDir: "/sbxroot/home/.junco" });
    expect(
      await check("dual-data-roots").run(
        ctxOf(cfg, { existsFn: (p) => p.startsWith("/sbxroot/home/.junco/queue") }),
      ),
    ).toEqual([]);
  });
});

describe("check: config-relocation", () => {
  it("warns when the config still sits at the legacy XDG path", async () => {
    const legacy = join("/sbxroot/home", ".config", "junco", "config.json");
    const [f] = await check("config-relocation").run(ctxOf(cfgOf(), {}, legacy));
    expect(f.v).toBe("warn");
    expect(f.label).toBe("unrelocated config");
    expect(f.detail).toContain(join("/sbxroot/home", ".junco", "config.json"));
  });

  it("is silent for a config already at the canonical path", async () => {
    expect(await check("config-relocation").run(ctxOf(cfgOf()))).toEqual([]);
  });
});

describe("check: legacy-worktree-root", () => {
  it("reports an ✓ hint (not a warning) when the override dir still holds worktrees", async () => {
    const cfg = cfgOf({ legacy: { ...cfgOf().legacy, worktreeRoot: true } });
    const [f] = await check("legacy-worktree-root").run(
      ctxOf(cfg, { existsFn: (p) => p === cfg.worktreeRoot, readdirFn: () => ["a-ticket"] }),
    );
    expect(f.v).toBe("ok");
    expect(f.detail).toContain("currently live at");
  });

  it("is silent when the override dir is empty", async () => {
    const cfg = cfgOf({ legacy: { ...cfgOf().legacy, worktreeRoot: true } });
    expect(
      await check("legacy-worktree-root").run(
        ctxOf(cfg, { existsFn: (p) => p === cfg.worktreeRoot, readdirFn: () => [] }),
      ),
    ).toEqual([]);
  });
});

describe("check: skill-links", () => {
  it("passes when every probed link is a live symlink", async () => {
    const mount = join(SEAMS.dataDir, "skills");
    const [f] = await check("skill-links").run(ctxOf(cfgOf(), { existsFn: (p) => p === mount }));
    expect(render(f)).toBe("✓ skill links — 1 link(s) resolve");
  });

  it("warns 'blocked' when a real directory squats on a link path", async () => {
    const [f] = await check("skill-links").run(
      ctxOf(cfgOf(), { lstatFn: () => ({ isSymbolicLink: () => false }) }),
    );
    expect(f.v).toBe("warn");
    expect(f.label).toBe("skill links blocked");
  });

  it("probes each configured harness dir whose parent exists", async () => {
    const harnessDir = "/sbxroot/home/.claude/skills";
    const cfg = cfgOf({ skills: { harnessDirs: [harnessDir] } });
    const [f] = await check("skill-links").run(
      ctxOf(cfg, {
        existsFn: (p) =>
          p === join(SEAMS.dataDir, "skills") ||
          p === "/sbxroot/home/.claude" ||
          p === join(harnessDir, SKILL_DIR_NAME),
      }),
    );
    expect(render(f)).toBe("✓ skill links — 2 link(s) resolve");
  });
});

describe("check: git-gh", () => {
  it("reports git + an authenticated gh, and records gh's availability on the ctx", async () => {
    const ctx = ctxOf(cfgOf(), { execFn: async () => ({ code: 0, stdout: "v", stderr: "" }) });
    expect((await check("git-gh").run(ctx)).map(render)).toEqual([
      "✓ git — v",
      "✓ gh — authenticated",
    ]);
    expect(ctx.ghAvailable).toBe(true);
  });

  it("a missing gh is a warning, and leaves ghAvailable false for bot-account", async () => {
    const ctx = ctxOf(cfgOf(), {
      execFn: async (_c, args) =>
        args[0] === "--version" && _c === "gh"
          ? { code: 1, stdout: "", stderr: "" }
          : { code: 0, stdout: "v", stderr: "" },
    });
    const findings = await check("git-gh").run(ctx);
    expect(findings[1].v).toBe("warn");
    expect(ctx.ghAvailable).toBe(false);
  });
});

describe("check: bot-account", () => {
  it("is silent when bot mode is off", async () => {
    const ctx = ctxOf(cfgOf());
    ctx.ghAvailable = true;
    expect(await check("bot-account").run(ctx)).toEqual([]);
  });

  it("is silent when gh itself is missing, even with bot mode on", async () => {
    const cfg = cfgOf({ botAccount: { enabled: true, configDir: "/sbxroot/junco-gh" } });
    const ctx = ctxOf(cfg); // ghAvailable stays false
    expect(await check("bot-account").run(ctx)).toEqual([]);
  });

  it("reports the bot identity when it differs from the ambient login", async () => {
    const cfg = cfgOf({ botAccount: { enabled: true, configDir: "/sbxroot/junco-gh" } });
    const ctx = ctxOf(cfg, {
      execFn: async (_cmd, _args, opts) => ({
        code: 0,
        stdout: JSON.stringify({ login: opts?.env ? "junco-bot" : "a-human" }),
        stderr: "",
      }),
    });
    ctx.ghAvailable = true;
    expect((await check("bot-account").run(ctx)).map(render)).toEqual([
      "✓ bot account — acting as junco-bot",
    ]);
  });
});

describe("check: sandbox-backend", () => {
  it("is silent when the sandbox is disabled", async () => {
    expect(await check("sandbox-backend").run(ctxOf(cfgOf()))).toEqual([]);
  });

  it("warns that backend=none gives no OS isolation", async () => {
    const cfg = cfgOf({ sandbox: { ...cfgOf().sandbox, enabled: true, backend: "none" } });
    const [f] = await check("sandbox-backend").run(ctxOf(cfg));
    expect(f.v).toBe("warn");
    expect(f.detail).toContain("no OS isolation");
  });
});

describe("check: sandbox-policy", () => {
  it("is silent when the sandbox is disabled", async () => {
    expect(await check("sandbox-policy").run(ctxOf(cfgOf()))).toEqual([]);
  });

  it("passes for a default arrangement", async () => {
    const cfg = cfgOf({ sandbox: { ...cfgOf().sandbox, enabled: true } });
    expect((await check("sandbox-policy").run(ctxOf(cfg))).map(render)).toEqual([
      "✓ sandbox policy — enforceable on every backend",
    ]);
  });

  it("fails when an extra_allow_write sits above a by-name deny file", async () => {
    const cfg = cfgOf({
      sandbox: { ...cfgOf().sandbox, enabled: true, extraAllowWrite: ["/sbxroot/home"] },
    });
    const [f] = await check("sandbox-policy").run(ctxOf(cfg));
    expect(f.v).toBe("fail");
    expect(f.label).toBe("sandbox policy");
  });
});

describe("check: endpoint-model", () => {
  it("probes the endpoint and confirms the model is advertised", async () => {
    expect((await check("endpoint-model").run(ctxOf(cfgOf()))).map(render)).toEqual([
      "✓ inference endpoint — http://127.0.0.1:1234/v1",
      "✓ model — local/m",
    ]);
  });

  it("fails on an unreachable endpoint and skips the model listing", async () => {
    const findings = await check("endpoint-model").run(
      ctxOf(cfgOf(), { reachableFn: async () => false }),
    );
    expect(findings.map((f) => f.v)).toEqual(["fail"]);
  });

  it("skips the probe entirely for endpointProbe=never", async () => {
    const cfg = cfgOf({ endpointProbe: "never" });
    const [f] = await check("endpoint-model").run(ctxOf(cfg));
    expect(f.v).toBe("ok");
    expect(f.detail).toContain("worker.endpointProbe=never");
  });
});

describe("check: planner-model", () => {
  it("is silent with no plannerModelId configured", async () => {
    expect(await check("planner-model").run(ctxOf(cfgOf()))).toEqual([]);
  });

  it("warns (never fails) when the override does not resolve", async () => {
    const cfg = cfgOf({ github: { ...cfgOf().github, plannerModelId: "openai/nope" } });
    const [f] = await check("planner-model").run(
      ctxOf(cfg, {
        resolveInfoFn: async () => {
          throw new Error("no catalog match");
        },
      }),
    );
    expect(f.v).toBe("warn");
    expect(f.detail).toBe("no catalog match");
  });
});

describe("check: dirs-writable", () => {
  it("reports the three roots in order", async () => {
    const findings = await check("dirs-writable").run(ctxOf(cfgOf()));
    expect(findings.map((f) => f.label)).toEqual(["queue", "worktree root", "data dir"]);
    expect(findings.every((f) => f.v === "ok")).toBe(true);
  });

  it("fails an unwritable dir", async () => {
    const findings = await check("dirs-writable").run(ctxOf(cfgOf(), { accessOkFn: () => false }));
    expect(findings.map((f) => f.v)).toEqual(["fail", "fail", "fail"]);
  });
});

describe("check: data-tree-modes", () => {
  it("warns with the exact chmod for a group/world-readable path", async () => {
    const cfg = cfgOf();
    const [f] = await check("data-tree-modes").run(
      ctxOf(cfg, { statFn: (p) => (p === cfg.dataDir ? { mode: 0o755 } : { mode: 0o700 }) }),
    );
    expect(f.v).toBe("warn");
    expect(f.detail).toContain(`chmod 700 ${cfg.dataDir}`);
  });

  it("passes when every present path is owner-only", async () => {
    expect(
      (await check("data-tree-modes").run(ctxOf(cfgOf(), { statFn: () => ({ mode: 0o700 }) }))).map(
        render,
      ),
    ).toEqual(["✓ data tree modes — owner-only"]);
  });
});

describe("check: split-queue", () => {
  it("passes when no other known root holds pending tickets", async () => {
    expect((await check("split-queue").run(ctxOf(cfgOf()))).map(render)).toEqual([
      "✓ queue roots — no other known queue root holds pending tickets",
    ]);
  });

  it("warns rather than claiming health when a root is unreadable", async () => {
    const [f] = await check("split-queue").run(
      ctxOf(cfgOf(), {
        existsFn: () => true,
        readdirFn: () => {
          throw new Error("EACCES");
        },
      }),
    );
    expect(f.v).toBe("warn");
    expect(f.detail).toContain("split-queue check failed");
  });
});

describe("check: health-bind", () => {
  it("warns on a non-loopback bind address", async () => {
    const [f] = await check("health-bind").run(ctxOf(cfgOf({ healthHost: "0.0.0.0" })));
    expect(f.v).toBe("warn");
    expect(f.detail).toContain("is not loopback");
  });

  it("is silent for a loopback host", async () => {
    expect(await check("health-bind").run(ctxOf(cfgOf()))).toEqual([]);
  });
});

describe("check: chat-thinking (spec 2026-09-06 §2.2)", () => {
  /** An inline-resolved local model on an openai-completions server. */
  function inlineInfo(baseUrl: string, over: Partial<ResolvedModelInfo> = {}): ResolvedModelInfo {
    return {
      provider: "local",
      modelId: "m",
      baseUrl,
      api: "openai-completions",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      path: "inline",
      ...over,
    };
  }

  function chatCfg(thinkTags: "auto" | "on" | "off" = "auto"): Config {
    const base = cfgOf();
    return cfgOf({ chat: { ...base.chat, enabled: true, thinkTags } });
  }

  it("names the llama.cpp flag for a port-8080 server, as an info (never a warn)", async () => {
    const [f] = await check("chat-thinking").run(
      ctxOf(chatCfg(), { resolveInfoFn: async () => inlineInfo("http://127.0.0.1:8080/v1") }),
    );
    expect(f.v).toBe("info");
    expect(f.label).toBe("chat thinking");
    expect(f.detail).toContain("chat.thinkTags=auto");
    expect(f.detail).toContain("start llama.cpp with --reasoning-format deepseek");
    expect(render(f)).toMatch(/^ℹ chat thinking — /);
  });

  it("names the LM Studio setting for a port-1234 server", async () => {
    const [f] = await check("chat-thinking").run(
      ctxOf(chatCfg("on"), { resolveInfoFn: async () => inlineInfo("http://localhost:1234/v1") }),
    );
    expect(f.v).toBe("info");
    expect(f.detail).toContain("chat.thinkTags=on");
    expect(f.detail).toContain("in LM Studio enable 'Reasoning → separate field'");
  });

  it("falls back to generic wording for an unrecognized server", async () => {
    const [f] = await check("chat-thinking").run(
      ctxOf(chatCfg(), { resolveInfoFn: async () => inlineInfo("http://gpu-box:11434/v1") }),
    );
    expect(f.v).toBe("info");
    expect(f.detail).toContain("move reasoning into reasoning_content on the server");
  });

  it("is silent when chat.thinkTags is off", async () => {
    let calls = 0;
    const out = await check("chat-thinking").run(
      ctxOf(chatCfg("off"), {
        resolveInfoFn: async () => {
          calls++;
          return inlineInfo("http://127.0.0.1:8080/v1");
        },
      }),
    );
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("is silent when chat is disabled", async () => {
    const base = cfgOf();
    expect(
      await check("chat-thinking").run(
        ctxOf(cfgOf({ chat: { ...base.chat, enabled: false } }), {
          resolveInfoFn: async () => inlineInfo("http://127.0.0.1:8080/v1"),
        }),
      ),
    ).toEqual([]);
  });

  it("is silent for a hosted (non openai-completions) api — native thinking there", async () => {
    expect(
      await check("chat-thinking").run(
        ctxOf(chatCfg(), {
          resolveInfoFn: async () =>
            inlineInfo("https://api.anthropic.com", {
              provider: "anthropic",
              api: "anthropic-messages",
              path: "catalog",
            }),
        }),
      ),
    ).toEqual([]);
  });

  it("is silent (not a failure) when the model does not resolve — endpoint-model owns that verdict", async () => {
    expect(
      await check("chat-thinking").run(
        ctxOf(chatCfg(), {
          resolveInfoFn: async () => {
            throw new Error("no such model");
          },
        }),
      ),
    ).toEqual([]);
  });

  it("resolves the chat model (chat.modelId) rather than the worker model", async () => {
    const seen: (string | undefined)[] = [];
    const base = cfgOf();
    await check("chat-thinking").run(
      ctxOf(cfgOf({ chat: { ...base.chat, enabled: true, modelId: "local/chat-m" } }), {
        resolveInfoFn: async (_cfg, id) => {
          seen.push(id);
          return inlineInfo("http://127.0.0.1:8080/v1");
        },
      }),
    );
    expect(seen).toEqual(["local/chat-m"]);
  });
});

describe("serverThinkingFlag", () => {
  it("port 8080 → llama.cpp wording", () => {
    expect(serverThinkingFlag("http://127.0.0.1:8080/v1")).toBe(
      "for a cleaner stream start llama.cpp with --reasoning-format deepseek",
    );
  });

  it("port 1234 → LM Studio wording", () => {
    expect(serverThinkingFlag("http://localhost:1234/v1")).toBe(
      "in LM Studio enable 'Reasoning → separate field' for a cleaner stream",
    );
  });

  it("anything else (including an unparsable url) → generic wording", () => {
    const generic = "move reasoning into reasoning_content on the server for a cleaner stream";
    expect(serverThinkingFlag("http://gpu-box:11434/v1")).toBe(generic);
    expect(serverThinkingFlag("https://api.example.com/v1")).toBe(generic);
    expect(serverThinkingFlag("not a url")).toBe(generic);
  });
});

describe("check: github-bridge", () => {
  it("is silent when the bridge is disabled", async () => {
    expect(await check("github-bridge").run(ctxOf(cfgOf()))).toEqual([]);
  });

  it("reports the template, each repo, and the watchlist path", async () => {
    const repoPath = "/sbxroot/repos/r";
    const cfg = cfgOf({
      github: { ...cfgOf().github, enabled: true, repos: [{ nwo: "o/r", path: repoPath }] },
    });
    const findings = await check("github-bridge").run(
      ctxOf(cfg, {
        execFn: async (_cmd, args) =>
          args.includes("get-url")
            ? { code: 0, stdout: "https://github.com/o/r.git", stderr: "" }
            : { code: 0, stdout: "{}", stderr: "" },
      }),
    );
    expect(findings.map((f) => f.label)).toEqual([
      "github planner template",
      "github repo o/r",
      "github watchlist",
    ]);
    expect(findings.every((f) => f.v === "ok")).toBe(true);
  });

  it("fails a repo whose origin does not match its nwo", async () => {
    const cfg = cfgOf({
      github: { ...cfgOf().github, enabled: true, repos: [{ nwo: "o/r", path: "/sbxroot/r" }] },
    });
    const findings = await check("github-bridge").run(
      ctxOf(cfg, {
        execFn: async (_cmd, args) =>
          args.includes("get-url")
            ? { code: 0, stdout: "https://github.com/o/other.git", stderr: "" }
            : { code: 0, stdout: "{}", stderr: "" },
      }),
    );
    const repoFinding = findings.find((f) => f.label === "github repo o/r");
    expect(repoFinding?.v).toBe("fail");
    expect(repoFinding?.detail).toContain("expected o/r");
  });
});

describe("check: outbox", () => {
  it("warns on a queued backlog and on dead-letters", async () => {
    const cfg = cfgOf({ dataDir: mkdtempSync(join(tmpdir(), "junco-check-obx-")) });
    const { dir, dead } = outboxPaths(cfg);
    mkdirSync(dir, { recursive: true });
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dir, "1-a-labels.json"), "{}", "utf8");
    writeFileSync(join(dead, "2-b-labels.json"), "{}", "utf8");
    const findings = await check("outbox").run(ctxOf(cfg));
    expect(findings.map((f) => f.label)).toEqual(["outbox backlog", "outbox dead-letters"]);
    expect(findings.every((f) => f.v === "warn")).toBe(true);
  });

  it("is silent with an empty outbox", async () => {
    expect(await check("outbox").run(ctxOf(cfgOf()))).toEqual([]);
  });
});

describe("check: audit-review", () => {
  it("reports a pending review informationally (✓, not a warning)", async () => {
    const cfg = cfgOf({ dataDir: mkdtempSync(join(tmpdir(), "junco-check-review-")) });
    writePending(cfg, {
      id: "a",
      nwo: "o/r",
      external: true,
      autoPlan: false,
      repoPath: "/x",
      createdAt: "2026-07-09T00:00:00.000Z",
      findings: [],
    });
    expect((await check("audit-review").run(ctxOf(cfg))).map(render)).toEqual([
      "✓ audit review — 1 pending (junco audit review)",
    ]);
  });

  it("is silent with nothing pending", async () => {
    expect(await check("audit-review").run(ctxOf(cfgOf()))).toEqual([]);
  });
});

describe("check: audit-history", () => {
  it("reports one ✓ line per assessed repo", async () => {
    const cfg = cfgOf({ dataDir: mkdtempSync(join(tmpdir(), "junco-check-history-")) });
    recordRun(cfg, "o/r", {
      ok: true,
      at: "2026-07-16T00:00:00.000Z",
      value: { found: 4, parked: 3 },
    });
    expect((await check("audit-history").run(ctxOf(cfg))).map(render)).toEqual([
      "✓ audit history — o/r: assessed 2026-07-16",
    ]);
  });

  it("is silent with no history", async () => {
    expect(await check("audit-history").run(ctxOf(cfgOf()))).toEqual([]);
  });
});

describe("check: investigate-drafts", () => {
  it("reports a pending draft informationally (✓, not a warning)", async () => {
    const cfg = cfgOf({ dataDir: mkdtempSync(join(tmpdir(), "junco-check-draft-")) });
    writeDraft(cfg, {
      id: "a",
      nwo: "o/r",
      issue: 1,
      issueTitle: "Title",
      external: true,
      repoPath: "/x",
      createdAt: "2026-07-09T00:00:00.000Z",
      draft: "draft body",
      footer: true,
    });
    expect((await check("investigate-drafts").run(ctxOf(cfg))).map(render)).toEqual([
      "✓ investigate drafts — 1 pending (junco investigate review)",
    ]);
  });

  it("is silent with no drafts", async () => {
    expect(await check("investigate-drafts").run(ctxOf(cfgOf()))).toEqual([]);
  });
});

describe("check: daemon", () => {
  it("reports 'not running' when no lock is held", async () => {
    expect((await check("daemon").run(ctxOf(cfgOf()))).map(render)).toEqual([
      "✓ daemon — not running",
    ]);
  });

  it("warns about a shared-root claim held by a pid that is not this config's daemon", async () => {
    const findings = await check("daemon").run(
      ctxOf(cfgOf(), { lockHolderFn: (p) => (p.endsWith("worker.lock") ? null : 4242) }),
    );
    expect(findings[0].detail).toBe("not running");
    expect(findings.slice(1).map((f) => f.v)).toEqual(["warn", "warn"]);
    expect(findings[1].detail).toContain("claimed by pid 4242");
  });
});

describe("check: update-check", () => {
  it("warns when a newer version is available", async () => {
    const [f] = await check("update-check").run(
      ctxOf(cfgOf(), {
        checkUpdateFn: async () => ({ current: "1.0.0", latest: "1.1.0", available: true }),
      }),
    );
    expect(render(f)).toBe("⚠ junco version — v1.0.0 — v1.1.0 available (run: junco update)");
  });

  it("reports a skipped check as ok", async () => {
    const [f] = await check("update-check").run(ctxOf(cfgOf()));
    expect(f.v).toBe("ok");
    expect(f.detail).toContain("update check skipped");
  });
});
