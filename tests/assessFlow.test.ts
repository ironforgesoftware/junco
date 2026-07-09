import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAssessFlow } from "../src/assessFlow.js";
import { parseTicket } from "../src/ticket.js";
import { fingerprintFinding, findingMarker } from "../src/findings.js";
import { GitOpError } from "../src/git.js";
import type { Config, Ticket } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures — a full Config (copied from tests/runOnce.test.ts, incl. `assess`),
// a scriptable AgentSessionLike, and scriptable gh/git/runCmd fakes. No
// network, no real model; everything lives under real tmpdirs.
// ---------------------------------------------------------------------------

function cfg(root: string): Config {
  return {
    vaultRoot: root,
    juncoSubdir: "Junco",
    model: {
      id: "m",
      modelsJson: null,
      api: "openai-completions",
      baseUrl: "u",
      apiKey: "k",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 131072,
      maxTokens: 49152,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevel: "medium",
      compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen-chat-template" },
    },
    tools: ["read"],
    defaultTimeoutMinutes: 1,
    pollIntervalSeconds: 15,
    startupPollSeconds: 30,
    startupWait: true,
    maxTransientRetries: 2,
    retryBackoffSeconds: 60,
    maxConcurrent: 1,
    supervisorEnabled: true,
    supervisorBudgetPerKind: 1,
    supervisorEscalationWindow: 3,
    supervisorOutputBudgetPerTurn: 12000,
    supervisorOutputBudgetPostCommit: 24000,
    gitBin: "git",
    ghBin: "gh",
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    worktreeRoot: "/tmp/worktrees",
    removeWorktreeOnSuccess: true,
    allowedRepoRoots: [],
    draftByDefault: true,
    defaultLabels: [],
    verifyEnabled: true,
    verifyCommandTimeout: 60,
    verifyBlockOnFail: false,
    criticEnabled: true,
    criticMaxRetries: 1,
    criticThinking: "minimal",
    planLintEnabled: true,
    planLintBlockOnError: true,
    planLintCheckLabels: true,
    commitLeftoversEnabled: false,
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    logLevel: "info",
    github: {
      enabled: false,
      triggerLabel: "junco",
      askLabel: "junco:ask",
      pollIntervalSeconds: 60,
      repos: [],
      requireApproval: true,
      plannerModelId: null,
      externalReposRoot: "/tmp/junco-test-external",
    },
    assess: { maxIssuesPerRun: 20, minSeverity: "low", npmBin: "npm" },
    stateDir: join(root, "state"),
    logToFile: false,
    transcriptsEnabled: false,
  };
}

/** A sandbox with the four queue dirs and a claimed assess ticket in
 * processing/. Returns the parsed Ticket + its path. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "junco-assess-"));
  const j = join(root, "Junco");
  ["inbox", "processing", "done", "failed"].forEach((d) =>
    mkdirSync(join(j, d), { recursive: true }),
  );
  return { root, j };
}

/** A tmp repo dir with a couple of real files (for the hallucination filter). */
function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "junco-repo-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;\n", "utf8");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 1;\n", "utf8");
  return repo;
}

function claim(j: string, content: string, id = "assess-1"): { path: string; ticket: Ticket } {
  const path = join(j, "processing", `2026-07-08T0000Z__${id}.md`);
  writeFileSync(path, content, "utf8");
  const ticket = parseTicket(path, content, 1);
  return { path, ticket };
}

function ticketContent(repo: string, extra = ""): string {
  return `---\nid: assess-1\nrepo: ${JSON.stringify(repo)}\n${extra}---\n# Assess ${repo}\nscan for vulns\n`;
}

/** A scriptable AgentSessionLike that emits `finalText` as one text delta. */
function fakeSession(finalText: string) {
  return async () => ({
    subscribe(l: (e: any) => void) {
      queueMicrotask(() => {
        l({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: finalText },
        });
        l({
          type: "turn_end",
          message: {
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
          },
        });
        l({ type: "agent_end", messages: [], willRetry: false });
      });
      return () => {};
    },
    async prompt() {
      await new Promise((r) => setTimeout(r, 1));
    },
    dispose() {},
    abort: async () => {},
  });
}

/** A session whose prompt() throws — the Q&A transient-failure signature. */
function throwingSession() {
  return async () => ({
    subscribe() {
      return () => {};
    },
    async prompt() {
      throw new Error("fetch failed: ECONNREFUSED");
    },
    dispose() {},
    abort: async () => {},
  });
}

function findingsFence(arr: unknown[]): string {
  return "```junco-findings\n" + JSON.stringify(arr) + "\n```";
}

function codeFinding(ruleId: string, path: string, title = ruleId, extra: object = {}): object {
  return {
    kind: "code",
    severity: "high",
    ruleId,
    title,
    description: "desc",
    location: { path },
    ...extra,
  };
}

/** npm-audit v7 JSON with one advisory of the given severity. */
function auditJson(severity = "high"): string {
  return JSON.stringify({
    vulnerabilities: {
      lodash: {
        name: "lodash",
        severity,
        via: [
          {
            source: 1,
            name: "lodash",
            title: "Prototype Pollution in lodash",
            url: "https://github.com/advisories/GHSA-jf85-cpcp-j695",
            severity,
            range: "<4.17.21",
          },
        ],
        range: "<4.17.21",
        fixAvailable: { name: "lodash", version: "4.17.21" },
      },
    },
  });
}

/** Scriptable gh fake: records calls, captures issue-create body files. */
function fakeGh(handler: (args: string[]) => { stdout?: string } | void) {
  const calls: string[][] = [];
  const bodies: string[] = [];
  const ghFn = (async (_cfg: unknown, args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "create") {
      const idx = args.indexOf("--body-file");
      if (idx >= 0) bodies.push(readFileSync(args[idx + 1], "utf8"));
    }
    const r = handler(args);
    return { code: 0, stdout: "", stderr: "", ...(r ?? {}) };
  }) as never;
  return { calls, bodies, ghFn };
}

function fakeGit(remoteStdout: string) {
  return (async (_cfg: unknown, args: string[]) => {
    if (args[0] === "remote") return { code: 0, stdout: remoteStdout, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }) as never;
}

function fakeRunCmd(stdout: string) {
  return (async () => ({ code: 1, stdout, stderr: "" })) as never;
}

const NET_ERR = new GitOpError("gh failed", "could not resolve host: api.github.com", 1);
const PERM_ERR = new GitOpError("gh failed", "HTTP 404: Not Found", 1);

const originHttps = "https://github.com/o/r.git\n";

describe("runAssessFlow", () => {
  it("happy path: npm advisory + agent code finding → two issues, done/, found 2", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);

    let created = 0;
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
      if (args[0] === "issue" && args[1] === "create") {
        created++;
        return { stdout: `https://github.com/o/r/issues/${created}\n` };
      }
      return undefined;
    });
    const finalText = "found things\n\n" + findingsFence([codeFinding("XSS-1", "src/index.ts")]);
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd(auditJson("high")),
      sessionFactoryFor: () => fakeSession(finalText),
    });

    expect(r.found).toBe(2);
    expect(r.created).toBe(2);
    expect(r.urls).toEqual(["https://github.com/o/r/issues/1", "https://github.com/o/r/issues/2"]);
    expect(r.status).toBe("completed");
    const doneFiles = readdirSync(join(j, "done"));
    expect(doneFiles).toHaveLength(1);
    const body = readFileSync(join(j, "done", doneFiles[0]), "utf8");
    expect(body).toContain("https://github.com/o/r/issues/1");
    expect(body).toContain("https://github.com/o/r/issues/2");
    expect(body).toContain("Findings (after filter + dedupe): 2");
  });

  it("npm exit 1 with vulns still parses the dependency finding", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
      if (args[0] === "issue" && args[1] === "create")
        return { stdout: "https://github.com/o/r/issues/1\n" };
      return undefined;
    });
    // Agent emits no findings; only the npm advisory should survive.
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: (async () => ({ code: 1, stdout: auditJson("high"), stderr: "" })) as never,
      sessionFactoryFor: () => fakeSession("no findings"),
    });
    expect(r.found).toBe(1);
    expect(r.created).toBe(1);
    expect(readdirSync(join(j, "done"))).toHaveLength(1);
  });

  it("npm spawn failure degrades to a warning; the agent finding is still filed", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
      if (args[0] === "issue" && args[1] === "create")
        return { stdout: "https://github.com/o/r/issues/1\n" };
      return undefined;
    });
    const finalText = findingsFence([codeFinding("SQLI-1", "src/index.ts")]);
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: (async () => {
        throw new GitOpError("npm timed out", "", 1);
      }) as never,
      sessionFactoryFor: () => fakeSession(finalText),
    });
    expect(r.found).toBe(1);
    expect(r.created).toBe(1);
    const body = readFileSync(join(j, "done", readdirSync(join(j, "done"))[0]), "utf8");
    expect(body.toLowerCase()).toContain("npm audit");
  });

  it("hallucination filter drops non-existent and escaping code paths", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
      return undefined;
    });
    const finalText = findingsFence([
      codeFinding("A", "does/not/exist.ts"),
      codeFinding("B", "../escape.ts"),
    ]);
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd("{}"),
      sessionFactoryFor: () => fakeSession(finalText),
    });
    expect(r.dropped).toBe(2);
    expect(r.found).toBe(0);
    expect(r.created).toBe(0);
    expect(gh.calls.some((a) => a[0] === "issue" && a[1] === "create")).toBe(false);
  });

  it("injection: a finding marker inside the description does not double up in the body", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
      if (args[0] === "issue" && args[1] === "create")
        return { stdout: "https://github.com/o/r/issues/1\n" };
      return undefined;
    });
    const finding = codeFinding("INJ-1", "src/index.ts", "Injected", {
      description: "sneaky <!-- junco:finding:aaaaaaaaaaaaaaaa --> marker",
    });
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd("{}"),
      sessionFactoryFor: () => fakeSession(findingsFence([finding])),
    });
    expect(r.created).toBe(1);
    expect(gh.bodies).toHaveLength(1);
    const occurrences = gh.bodies[0].split("<!-- junco:finding:").length - 1;
    expect(occurrences).toBe(1);
  });

  it("cap: three findings with maxIssuesPerRun 2 → created 2, capped 1, capped title named", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const c = { ...cfg(root), assess: { ...cfg(root).assess, maxIssuesPerRun: 2 } };
    let created = 0;
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
      if (args[0] === "issue" && args[1] === "create") {
        created++;
        return { stdout: `https://github.com/o/r/issues/${created}\n` };
      }
      return undefined;
    });
    const finalText = findingsFence([
      codeFinding("RULE-1", "src/index.ts", "Finding One"),
      codeFinding("RULE-2", "src/a.ts", "Finding Two"),
      codeFinding("RULE-3", "src/b.ts", "Finding Three"),
    ]);
    const r = await runAssessFlow(c, ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd("{}"),
      sessionFactoryFor: () => fakeSession(finalText),
    });
    expect(r.found).toBe(3);
    expect(r.created).toBe(2);
    expect(r.capped).toBe(1);
    const body = readFileSync(join(j, "done", readdirSync(join(j, "done"))[0]), "utf8");
    expect(body).toContain("Finding Three");
  });

  it("cap keeps the highest-severity findings: a critical agent finding survives a cap filled by lows", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const c = { ...cfg(root), assess: { ...cfg(root).assess, maxIssuesPerRun: 2 } };
    let created = 0;
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
      if (args[0] === "issue" && args[1] === "create") {
        created++;
        return { stdout: `https://github.com/o/r/issues/${created}\n` };
      }
      return undefined;
    });
    // Merge order is [npm findings, agent findings]: the low npm advisory and
    // a low agent finding come BEFORE the critical agent finding, so an
    // unsorted slice(0, 2) would file the two lows and cap the critical.
    const finalText = findingsFence([
      codeFinding("LOW-2", "src/a.ts", "Low Two", { severity: "low" }),
      codeFinding("CRIT-1", "src/index.ts", "Critical One", { severity: "critical" }),
    ]);
    const r = await runAssessFlow(c, ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd(auditJson("low")),
      sessionFactoryFor: () => fakeSession(finalText),
    });
    expect(r.found).toBe(3);
    expect(r.created).toBe(2);
    expect(r.capped).toBe(1);
    const createTitles = gh.calls
      .filter((a) => a[0] === "issue" && a[1] === "create")
      .map((a) => a[a.indexOf("--title") + 1]);
    // The critical finding is filed FIRST (severity-desc order)…
    expect(createTitles[0]).toContain("Critical One");
    // …and the sort is stable: among the two lows, the npm advisory (earlier
    // in merge order) wins the remaining slot.
    expect(createTitles[1]).toContain("Prototype Pollution");
    expect(createTitles.some((t) => t.includes("Low Two"))).toBe(false);
    // The capped low is named in the summary for a re-run.
    const body = readFileSync(join(j, "done", readdirSync(join(j, "done"))[0]), "utf8");
    expect(body).toContain("Capped — re-run to file");
    expect(body).toContain("Low Two");
  });

  it("github dedup: a finding already filed upstream is skipped", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const fpA = fingerprintFinding({
      kind: "code",
      ruleId: "RULE-A",
      location: { path: "src/a.ts" },
      title: "A",
    });
    let created = 0;
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return { stdout: JSON.stringify([{ body: `x ${findingMarker(fpA)} y` }]) };
      }
      if (args[0] === "issue" && args[1] === "create") {
        created++;
        return { stdout: `https://github.com/o/r/issues/${created}\n` };
      }
      return undefined;
    });
    const finalText = findingsFence([
      codeFinding("RULE-A", "src/a.ts", "A"),
      codeFinding("RULE-B", "src/b.ts", "B"),
    ]);
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd("{}"),
      sessionFactoryFor: () => fakeSession(finalText),
    });
    expect(r.found).toBe(2);
    expect(r.deduped).toBe(1);
    expect(r.created).toBe(1);
  });

  it("offline create → outbox: issue create network failure enqueues an op, ticket still done/", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const fp = fingerprintFinding({
      kind: "code",
      ruleId: "OFF-1",
      location: { path: "src/index.ts" },
      title: "Offline",
    });
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
      if (args[0] === "issue" && args[1] === "create") throw NET_ERR;
      return undefined;
    });
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd("{}"),
      sessionFactoryFor: () =>
        fakeSession(findingsFence([codeFinding("OFF-1", "src/index.ts", "Offline")])),
    });
    expect(r.queuedOffline).toBe(1);
    expect(r.created).toBe(0);
    expect(readdirSync(join(j, "done"))).toHaveLength(1);
    const outbox = join(root, "state", "github-outbox");
    const opFiles = readdirSync(outbox).filter((n) => n.endsWith(".json"));
    expect(opFiles).toHaveLength(1);
    const op = JSON.parse(readFileSync(join(outbox, opFiles[0]), "utf8"));
    expect(op.op.kind).toBe("issue-create");
    expect(op.op.fingerprint).toBe(fp);
  });

  it("offline dedup list: a network failure on issue list warns and still files live", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") throw NET_ERR;
      if (args[0] === "issue" && args[1] === "create")
        return { stdout: "https://github.com/o/r/issues/1\n" };
      return undefined;
    });
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd("{}"),
      sessionFactoryFor: () => fakeSession(findingsFence([codeFinding("NET-1", "src/index.ts")])),
    });
    expect(r.created).toBe(1);
    expect(readdirSync(join(j, "done"))).toHaveLength(1);
    const body = readFileSync(join(j, "done", readdirSync(join(j, "done"))[0]), "utf8");
    expect(body.toLowerCase()).toContain("warning");
  });

  it("no origin remote: unparseable remote → failed/, phase error, zero gh calls", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const gh = fakeGh(() => undefined);
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit("not-a-github-url\n"),
      runCmdFn: fakeRunCmd("{}"),
      sessionFactoryFor: () => fakeSession("unused"),
    });
    expect(r.status).toBe("failed");
    expect(r.created).toBe(0);
    expect(gh.calls).toHaveLength(0);
    const failed = readdirSync(join(j, "failed"));
    expect(failed).toHaveLength(1);
    const body = readFileSync(join(j, "failed", failed[0]), "utf8");
    expect(body).toContain("status: failed");
    expect(body.toLowerCase()).toContain("origin");
  });

  it("min_severity filters a medium finding below the threshold", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const c = { ...cfg(root), assess: { ...cfg(root).assess, minSeverity: "high" as const } };
    let created = 0;
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
      if (args[0] === "issue" && args[1] === "create") {
        created++;
        return { stdout: `https://github.com/o/r/issues/${created}\n` };
      }
      return undefined;
    });
    const finalText = findingsFence([
      {
        kind: "code",
        severity: "high",
        ruleId: "HIGH-1",
        title: "High",
        description: "d",
        location: { path: "src/a.ts" },
      },
      {
        kind: "code",
        severity: "medium",
        ruleId: "MED-1",
        title: "Med",
        description: "d",
        location: { path: "src/b.ts" },
      },
    ]);
    const r = await runAssessFlow(c, ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd("{}"),
      sessionFactoryFor: () => fakeSession(finalText),
    });
    expect(r.found).toBe(1);
    expect(r.created).toBe(1);
    const createTitles = gh.calls
      .filter((a) => a[0] === "issue" && a[1] === "create")
      .map((a) => a[a.indexOf("--title") + 1]);
    expect(createTitles.some((t) => t.includes("High"))).toBe(true);
    expect(createTitles.some((t) => t.includes("Med"))).toBe(false);
  });

  it("transient requeue: a transient agent failure requeues to inbox, files nothing", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const gh = fakeGh(() => undefined);
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd("{}"),
      sessionFactoryFor: () => throwingSession(),
    });
    expect(r.requeued).toBe(true);
    expect(r.created).toBe(0);
    expect(r.found).toBe(0);
    expect(readdirSync(join(j, "done"))).toHaveLength(0);
    expect(readdirSync(join(j, "failed"))).toHaveLength(0);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    const content = readFileSync(join(j, "inbox", inbox[0]), "utf8");
    expect(content).toMatch(/retry_count: 1/);
  });

  it("auto_plan: the trigger label is added to filed issues", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo, "assess:\n  auto_plan: true\n"));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    expect(ticket.assess).toEqual({ autoPlan: true });
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
      if (args[0] === "issue" && args[1] === "create")
        return { stdout: "https://github.com/o/r/issues/1\n" };
      return undefined;
    });
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd("{}"),
      sessionFactoryFor: () => fakeSession(findingsFence([codeFinding("AP-1", "src/index.ts")])),
    });
    expect(r.created).toBe(1);
    const createCall = gh.calls.find((a) => a[0] === "issue" && a[1] === "create")!;
    const labels = createCall.filter((_v, i) => createCall[i - 1] === "--label");
    expect(labels).toContain("junco");
  });

  it("path containment: a repo outside allowed_repo_roots → failed/, no gh/npm/agent", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const c = { ...cfg(root), allowedRepoRoots: ["/somewhere-else-entirely"] };
    const gh = fakeGh(() => undefined);
    let npmRan = false;
    let sessionBuilt = false;
    const r = await runAssessFlow(c, ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: (async () => {
        npmRan = true;
        return { code: 0, stdout: "{}", stderr: "" };
      }) as never,
      sessionFactoryFor: () => {
        sessionBuilt = true;
        return fakeSession("unused");
      },
    });
    expect(r.status).toBe("failed");
    expect(gh.calls).toHaveLength(0);
    expect(npmRan).toBe(false);
    expect(sessionBuilt).toBe(false);
    const failed = readdirSync(join(j, "failed"));
    expect(failed).toHaveLength(1);
    expect(readFileSync(join(j, "failed", failed[0]), "utf8")).toContain("status: failed");
  });

  it("non-network dedup failure is fatal (ticket → failed/, no issues filed)", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") throw PERM_ERR;
      return undefined;
    });
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd("{}"),
      sessionFactoryFor: () => fakeSession(findingsFence([codeFinding("PERM-1", "src/index.ts")])),
    });
    expect(r.status).toBe("failed");
    expect(r.created).toBe(0);
    expect(gh.calls.some((a) => a[0] === "issue" && a[1] === "create")).toBe(false);
    expect(readdirSync(join(j, "failed"))).toHaveLength(1);
  });

  it("per-finding non-network create failure continues with remaining findings", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path } = claim(j, ticketContent(repo));
    const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);

    let createAttempts = 0;
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
      if (args[0] === "issue" && args[1] === "create") {
        createAttempts++;
        if (createAttempts === 1) {
          throw new GitOpError("gh failed", "HTTP 422: Validation Failed", 1);
        }
        return { stdout: "https://github.com/o/r/issues/1\n" };
      }
      return undefined;
    });
    const finalText = findingsFence([
      codeFinding("FAIL-1", "src/index.ts", "First Finding"),
      codeFinding("OK-1", "src/a.ts", "Second Finding"),
    ]);
    const r = await runAssessFlow(cfg(root), ticket, path, {
      ghFn: gh.ghFn,
      gitFn: fakeGit(originHttps),
      runCmdFn: fakeRunCmd("{}"),
      sessionFactoryFor: () => fakeSession(finalText),
    });

    // One finding succeeded, one failed
    expect(r.created).toBe(1);
    expect(r.failed).toBe(1);
    // Both were attempted
    const createCalls = gh.calls.filter((a) => a[0] === "issue" && a[1] === "create");
    expect(createCalls).toHaveLength(2);
    // Ticket finalized to done/ (not failed/)
    const doneFiles = readdirSync(join(j, "done"));
    expect(doneFiles).toHaveLength(1);
    // Summary mentions the failure
    const body = readFileSync(join(j, "done", doneFiles[0]), "utf8");
    expect(body).toMatch(/422|[Ff]ail|[Ee]rror/);
  });
});
