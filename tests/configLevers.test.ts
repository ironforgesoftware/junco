import { describe, it, expect } from "vitest";
import { z } from "zod";
import { LEVERS, getAtPath, setAtPath, leverAtPath, coerceLever } from "../src/configLevers.js";
import { ConfigSchema, assembleConfig, type ConfigParsed } from "../src/config.js";
import type { Config } from "../src/types.js";

// Strip the wrapper nodes zod 4 puts between a declaration and its leaf type,
// reporting the innermost schema plus the default captured on the way down.
// The wrappers: `.optional()` → ZodOptional, `.default(v)` → ZodDefault,
// `.prefault(v)` → ZodPrefault, `.transform(fn)` → ZodPipe (`in` = the source
// schema, `out` = the transform). Unwrapping ZodPipe through `in` is what keeps
// `z.string().default(x).transform(fn)` (observability.healthHost) reporting
// the PRE-transform default. `.refine()` is not a wrapper in zod 4 — it hangs a
// check off the schema it is called on — so there is nothing to unwrap for it.
// A leaf never wrapped in ZodDefault/ZodPrefault (e.g. vaultRoot, optional with
// no default) reports `undefined`, matching a schema field with no default.
function unwrap(schema: z.ZodTypeAny): { schema: z.ZodTypeAny; default: unknown } {
  let s = schema;
  let def: unknown;
  for (;;) {
    if (s instanceof z.ZodPipe) {
      s = s._def.in as z.ZodTypeAny;
    } else if (s instanceof z.ZodDefault || s instanceof z.ZodPrefault) {
      def = s._def.defaultValue;
      s = s._def.innerType as z.ZodTypeAny;
    } else if (s instanceof z.ZodOptional) {
      s = s._def.innerType as z.ZodTypeAny;
    } else {
      return { schema: s, default: def };
    }
  }
}

// Walk a zod object schema to dotted leaf paths, capturing default + kind.
// Verbatim per the task brief — this is the bijection oracle LEVERS must match.
function schemaLeaves(schema: z.ZodTypeAny, prefix = ""): { path: string; def: z.ZodTypeAny }[] {
  const s = unwrap(schema).schema;
  if (s instanceof z.ZodObject) {
    return Object.entries(s.shape).flatMap(([k, v]) =>
      schemaLeaves(v as z.ZodTypeAny, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [{ path: prefix, def: schema }];
}

// Extended walker: same traversal, but also records the default captured while
// unwrapping.
function schemaLeavesWithDefault(
  schema: z.ZodTypeAny,
  prefix = "",
): { path: string; default: unknown }[] {
  const { schema: s, default: def } = unwrap(schema);
  if (s instanceof z.ZodObject) {
    return Object.entries(s.shape).flatMap(([k, v]) =>
      schemaLeavesWithDefault(v as z.ZodTypeAny, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [{ path: prefix, default: def }];
}

describe("LEVERS ↔ schema bijection", () => {
  const leafPaths = schemaLeaves(ConfigSchema)
    .map((l) => l.path)
    .sort();
  const leverPaths = LEVERS.map((l) => l.path).sort();

  it("has exactly one lever per schema leaf (no missing, no orphan)", () => {
    expect(leverPaths).toEqual(leafPaths);
  });
  it("gives every lever a reload classification", () => {
    for (const l of LEVERS) expect(["live", "restart"]).toContain(l.reload);
  });
  it("marks structured levers non-editable", () => {
    for (const l of LEVERS) if (l.type === "structured") expect(l.editable).toBe(false);
  });
  it("marks every non-structured lever editable", () => {
    for (const l of LEVERS) if (l.type !== "structured") expect(l.editable).toBe(true);
  });
  it("has no duplicate lever paths", () => {
    const seen = new Set<string>();
    for (const l of LEVERS) {
      expect(seen.has(l.path)).toBe(false);
      seen.add(l.path);
    }
  });

  it("matches the schema default for every leaf", () => {
    const schemaDefaults = new Map(
      schemaLeavesWithDefault(ConfigSchema).map((l) => [l.path, l.default]),
    );
    for (const lever of LEVERS) {
      expect(schemaDefaults.has(lever.path)).toBe(true);
      expect(lever.default).toEqual(schemaDefaults.get(lever.path));
    }
  });

  it("matches zod enum values for enum-typed levers", () => {
    const leafDefs = new Map(schemaLeaves(ConfigSchema).map((l) => [l.path, l.def]));
    for (const lever of LEVERS) {
      if (lever.type !== "enum") continue;
      const s = unwrap(leafDefs.get(lever.path)!).schema;
      expect(s).toBeInstanceOf(z.ZodEnum);
      if (s instanceof z.ZodEnum) {
        expect(lever.enumValues).toEqual(s.options);
      }
    }
  });

  it("matches zod min/max for number-typed levers that declare them", () => {
    const leafDefs = new Map(schemaLeaves(ConfigSchema).map((l) => [l.path, l.def]));
    for (const lever of LEVERS) {
      if (lever.type !== "number") continue;
      const s = unwrap(leafDefs.get(lever.path)!).schema;
      expect(s).toBeInstanceOf(z.ZodNumber);
      if (s instanceof z.ZodNumber) {
        if (lever.min !== undefined) expect(s.minValue).toBe(lever.min);
        if (lever.max !== undefined) expect(s.maxValue).toBe(lever.max);
      }
    }
  });
});

// --- LEVERS ↔ flat runtime Config correspondence ---------------------------
//
// `ConfigSchema` is the NESTED config.json shape; `Config` (src/types.ts) is
// the FLAT runtime shape, and `assembleConfig` renames between them by hand —
// inconsistently (`worker.pollIntervalSeconds` → `pollIntervalSeconds`,
// `supervisor.enabled` → `supervisorEnabled`, `verify.blockOnFail` →
// `verifyBlockOnFail`, while `model`/`github`/`sandbox`/… stay nested). That
// rename map was tribal knowledge: grepping `src/` for `verify.blockOnFail`
// returns nothing, and the only way to learn a key's flat spelling was to read
// assembleConfig top to bottom (#358).
//
// These tests DERIVE the map instead of restating it: perturb one schema leaf,
// re-run the assembly, record which flat keys moved. FLAT_KEYS below is that
// derivation's expected output — a rename or a re-wiring on either side fails
// here with the exact delta, and the table doubles as the searchable index the
// flat spellings otherwise lack.
const PROBE_ENV: Record<string, string | undefined> = { HOME: "/probe-home" };
// Every filesystem probe answers "absent", so the assembly is a pure function
// of the parsed config (no legacy data root, no legacy bot gh dir).
const noFs = (): boolean => false;
// Free-form maps: compared whole rather than walked into, so a probe shows up
// as one changed key instead of a set of synthesized ones.
const OPAQUE_FLAT = new Set(["model.compat", "model.thinkingLevelMap"]);

/** Flatten an assembled `Config` to dotted key → serialized value. */
function flatConfigKeys(cfg: Config): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, prefix: string): void => {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && !OPAQUE_FLAT.has(prefix)) {
      for (const [k, val] of Object.entries(v)) walk(val, prefix ? `${prefix}.${k}` : k);
      return;
    }
    out.set(prefix, JSON.stringify(v) ?? "undefined");
  };
  walk(cfg, "");
  return out;
}

/** A schema-valid value for `def` that differs from `current`. Strings avoid
 * "/" on purpose: a slash in `model.id` would flip `catalogEligible`, adding a
 * coupling the probe caused rather than one the assembly has. */
function probeValue(def: z.ZodTypeAny, current: unknown): unknown {
  const s = unwrap(def).schema;
  if (s instanceof z.ZodBoolean) return !current;
  if (s instanceof z.ZodNumber) return typeof current === "number" ? current + 1 : 1;
  if (s instanceof z.ZodEnum) return (s.options as string[]).find((o) => o !== current);
  if (s instanceof z.ZodRecord) return { probe: "probe" };
  if (s instanceof z.ZodArray) {
    const el = unwrap(s.element as z.ZodTypeAny).schema;
    if (el instanceof z.ZodObject) {
      return [Object.fromEntries(Object.keys(el.shape).map((k) => [k, "probe"]))];
    }
    return ["probe"];
  }
  return "probe";
}

// Two baselines, unioned: the defaults, and one with every legacy/optional
// override set. A key that only bites when a legacy override is present
// (`juncoSubdir` reaches `queueRoot` only under `vaultRoot`) would read as
// inert against the defaults alone.
const PROBE_BASELINES: unknown[] = [
  {},
  {
    dataDir: "probe-base-dataDir",
    vaultRoot: "probe-base-vaultRoot",
    model: {
      baseUrl: "probe-base-baseUrl",
      modelsJson: "probe-base-modelsJson",
      apiKey: "probe-base-apiKey",
      retry: { maxRetries: 9, baseDelayMs: 9 },
    },
    git: { worktreeRoot: "probe-base-worktreeRoot" },
    observability: { stateDir: "probe-base-stateDir" },
    github: {
      askLabel: "probe-base-askLabel",
      plannerModelId: "probe-base-planner",
      externalReposRoot: "probe-base-external",
    },
  },
];

/** path → the flat runtime keys perturbing it moves, derived by differential
 * assembly across both baselines. */
function deriveFlatKeys(): Map<string, string[]> {
  const defs = new Map(schemaLeaves(ConfigSchema).map((l) => [l.path, l.def]));
  const derived = new Map<string, Set<string>>(LEVERS.map((l) => [l.path, new Set<string>()]));
  for (const raw of PROBE_BASELINES) {
    const parsed = ConfigSchema.parse(raw);
    const before = flatConfigKeys(assembleConfig(parsed, PROBE_ENV, { existsFn: noFs }));
    for (const lever of LEVERS) {
      const mutated = structuredClone(parsed) as Record<string, unknown>;
      setAtPath(
        mutated,
        lever.path,
        probeValue(defs.get(lever.path)!, getAtPath(mutated, lever.path)),
      );
      const after = flatConfigKeys(
        assembleConfig(mutated as unknown as ConfigParsed, PROBE_ENV, { existsFn: noFs }),
      );
      const moved = derived.get(lever.path)!;
      for (const k of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(k) !== after.get(k)) moved.add(k);
      }
    }
  }
  return new Map([...derived].map(([path, keys]) => [path, [...keys].sort()]));
}

/** The rename map, machine-checked against `assembleConfig` (#358). */
const FLAT_KEYS: Record<string, string[]> = {
  dataDir: ["dataDir", "github.externalReposRoot", "queueRoot", "worktreeRoot"],
  vaultRoot: ["legacy.vaultRoot", "queueRoot"],
  juncoSubdir: ["queueRoot"],
  tools: ["tools"],
  updateCheck: ["updateCheck"],
  "model.id": ["model.id"],
  "model.source": ["model.apiKey", "model.source"],
  "model.modelsJson": ["model.modelsJson"],
  "model.api": ["model.api"],
  "model.baseUrl": ["model.baseUrl", "model.baseUrlExplicit"],
  "model.apiKey": ["model.apiKey"],
  "model.retry.maxRetries": ["model.retry.maxRetries"],
  "model.retry.baseDelayMs": ["model.retry.baseDelayMs"],
  "model.reasoning": ["model.reasoning"],
  "model.input": ["model.input"],
  "model.contextWindow": ["model.contextWindow"],
  "model.maxTokens": ["model.maxTokens"],
  "model.cost.input": ["model.cost.input"],
  "model.cost.output": ["model.cost.output"],
  "model.cost.cacheRead": ["model.cost.cacheRead"],
  "model.cost.cacheWrite": ["model.cost.cacheWrite"],
  "model.thinkingLevel": ["model.thinkingLevel"],
  "model.thinkingLevelMap": ["model.thinkingLevelMap"],
  "model.compat": ["model.compat"],
  "worker.defaultTimeoutMinutes": ["defaultTimeoutMinutes"],
  "worker.pollIntervalSeconds": ["pollIntervalSeconds"],
  "worker.startupPollSeconds": ["startupPollSeconds"],
  "worker.startupWait": ["startupWait"],
  "worker.endpointProbe": ["endpointProbe"],
  "worker.maxTransientRetries": ["maxTransientRetries"],
  "worker.retryBackoffSeconds": ["retryBackoffSeconds"],
  "worker.maxConcurrent": ["maxConcurrent"],
  "worker.commitLeftovers": ["commitLeftoversEnabled"],
  "worker.applyFallbackToAgent": ["applyFallbackToAgent"],
  "worker.dailyBudgetUsd": ["dailyBudgetUsd"],
  "supervisor.enabled": ["supervisorEnabled"],
  "supervisor.budgetPerKind": ["supervisorBudgetPerKind"],
  "supervisor.escalationWindowTurns": ["supervisorEscalationWindow"],
  "supervisor.outputBudgetPerTurn": ["supervisorOutputBudgetPerTurn"],
  "supervisor.outputBudgetPostCommit": ["supervisorOutputBudgetPostCommit"],
  "git.gitBin": ["gitBin"],
  "git.ghBin": ["ghBin"],
  "git.defaultBaseBranch": ["defaultBaseBranch"],
  "git.branchPrefix": ["branchPrefix"],
  "git.worktreeRoot": ["legacy.worktreeRoot", "worktreeRoot"],
  "git.removeWorktreeOnSuccess": ["removeWorktreeOnSuccess"],
  "git.allowedRepoRoots": ["allowedRepoRoots"],
  "pr.draftByDefault": ["draftByDefault"],
  "pr.defaultLabels": ["defaultLabels"],
  "pr.secretScan": ["secretScanEnabled"],
  "verify.enabled": ["verifyEnabled"],
  "verify.commandTimeout": ["verifyCommandTimeout"],
  "verify.blockOnFail": ["verifyBlockOnFail"],
  "verify.sandboxed": ["verifySandboxed"],
  "sandbox.enabled": ["sandbox.enabled"],
  "sandbox.backend": ["sandbox.backend"],
  "sandbox.requireBackend": ["sandbox.requireBackend"],
  "sandbox.network": ["sandbox.network"],
  "sandbox.extraDenyRead": ["sandbox.extraDenyRead"],
  "sandbox.extraAllowWrite": ["sandbox.extraAllowWrite"],
  "sandbox.bashTimeoutSeconds": ["sandbox.bashTimeoutSeconds"],
  "critic.enabled": ["criticEnabled"],
  "critic.maxRetries": ["criticMaxRetries"],
  "critic.thinking": ["criticThinking"],
  "planLint.enabled": ["planLintEnabled"],
  "planLint.blockOnError": ["planLintBlockOnError"],
  "planLint.checkLabels": ["planLintCheckLabels"],
  "observability.healthEnabled": ["healthEnabled"],
  "observability.healthHost": ["healthHost"],
  "observability.healthPort": ["healthPort"],
  "observability.logLevel": ["logLevel"],
  "observability.stateDir": [
    "dataDir",
    "github.externalReposRoot",
    "legacy.stateDir",
    "queueRoot",
    "worktreeRoot",
  ],
  "observability.logToFile": ["logToFile"],
  "observability.transcripts": ["transcriptsEnabled"],
  "github.enabled": ["github.enabled"],
  "github.triggerLabel": ["github.askLabel", "github.triggerLabel"],
  "github.askLabel": ["github.askLabel"],
  "github.pollIntervalSeconds": ["github.pollIntervalSeconds"],
  "github.requireApproval": ["github.requireApproval"],
  "github.plannerModelId": ["github.plannerModelId"],
  "github.externalReposRoot": ["github.externalReposRoot", "legacy.externalReposRoot"],
  "github.repos": ["github.repos"],
  "botAccount.enabled": ["botAccount.enabled"],
  "botAccount.configDir": ["botAccount.configDir"],
  "planSets.enabled": ["planSets.enabled"],
  "planSets.mergePollSeconds": ["planSets.mergePollSeconds"],
  "planSets.maxTasks": ["planSets.maxTasks"],
  "chat.enabled": ["chat.enabled"],
  "chat.modelId": ["chat.modelId"],
  "chat.thinkingLevel": ["chat.thinkingLevel"],
  "chat.turnTimeoutMinutes": ["chat.turnTimeoutMinutes"],
  "chat.submitTool": ["chat.submitTool"],
  "chat.confirmTimeoutMinutes": ["chat.confirmTimeoutMinutes"],
  "chat.thinkTags": ["chat.thinkTags"],
  "chat.maxFps": ["chat.maxFps"],
  "assess.maxIssuesPerRun": ["assess.maxIssuesPerRun"],
  "assess.minSeverity": ["assess.minSeverity"],
  "assess.npmBin": ["assess.npmBin"],
  "assess.fileAs": ["assess.fileAs"],
  "skills.harnessDirs": ["skills.harnessDirs"],
};

describe("LEVERS ↔ flat Config correspondence", () => {
  const derived = deriveFlatKeys();

  it("renames each schema leaf onto exactly the flat runtime keys the map records", () => {
    expect(Object.fromEntries(derived)).toEqual(FLAT_KEYS);
  });

  it("leaves no lever inert — every schema leaf moves at least one runtime key", () => {
    expect([...derived].filter(([, keys]) => keys.length === 0).map(([p]) => p)).toEqual([]);
  });

  it("reaches every runtime key except the three the assembly probes off disk", () => {
    const all = [
      ...flatConfigKeys(
        assembleConfig(ConfigSchema.parse({}), PROBE_ENV, { existsFn: noFs }),
      ).keys(),
    ];
    const reached = new Set([...derived.values()].flat());
    // dataLayout comes from layoutOf(); legacy.dataRoot/legacy.ghConfigDir from
    // the two "does the pre-0.10 location exist?" probes — none of the three is
    // settable in config.json, which is why no lever drives them.
    expect(all.filter((k) => !reached.has(k)).sort()).toEqual([
      "dataLayout",
      "legacy.dataRoot",
      "legacy.ghConfigDir",
    ]);
  });
});

describe("botAccount levers", () => {
  it("registers botAccount.enabled as a restart boolean lever defaulting to false", () => {
    const byPath = new Map(LEVERS.map((l) => [l.path, l]));
    expect(byPath.get("botAccount.enabled")).toMatchObject({
      type: "boolean",
      default: false,
      reload: "restart",
      editable: true,
    });
  });

  it("registers botAccount.configDir as a restart string lever", () => {
    const byPath = new Map(LEVERS.map((l) => [l.path, l]));
    expect(byPath.get("botAccount.configDir")).toMatchObject({
      type: "string",
      default: "~/.junco/gh",
      reload: "restart",
      editable: true,
    });
  });
});

describe("sandbox levers", () => {
  it("registers sandbox.requireBackend as a live boolean lever defaulting to false (#344)", () => {
    const byPath = new Map(LEVERS.map((l) => [l.path, l]));
    expect(byPath.get("sandbox.requireBackend")).toMatchObject({
      type: "boolean",
      default: false,
      reload: "live",
      editable: true,
    });
    // The description must say what the lever buys: auto fails closed
    // instead of degrading, so nobody reads it as a synonym for `enabled`.
    expect(byPath.get("sandbox.requireBackend")?.description).toMatch(/fail(s)? closed/i);
  });
});

describe("path helpers", () => {
  it("gets and sets nested dotted paths", () => {
    const obj: Record<string, unknown> = {};
    setAtPath(obj, "worker.maxConcurrent", 4);
    expect(getAtPath(obj, "worker.maxConcurrent")).toBe(4);
    expect(obj).toEqual({ worker: { maxConcurrent: 4 } });
  });
  it("leverAtPath finds a lever", () => {
    expect(leverAtPath("worker.maxConcurrent")?.type).toBe("number");
  });
  it("leverAtPath returns undefined for an unknown path", () => {
    expect(leverAtPath("nope.nope")).toBeUndefined();
  });
  it("getAtPath returns undefined through a missing intermediate object", () => {
    expect(getAtPath({}, "a.b.c")).toBeUndefined();
  });
});

describe("hosted-provider levers", () => {
  it("registers model.source and model.retry.* as live levers", () => {
    const byPath = new Map(LEVERS.map((l) => [l.path, l]));
    expect(byPath.get("model.source")).toMatchObject({ reload: "live", default: "auto" });
    expect(byPath.get("model.retry.maxRetries")).toMatchObject({ reload: "live" });
    expect(byPath.get("model.retry.baseDelayMs")).toMatchObject({ reload: "live" });
  });

  it("model.apiKey and model.baseUrl no longer advertise hard defaults", () => {
    const byPath = new Map(LEVERS.map((l) => [l.path, l]));
    expect(byPath.get("model.apiKey")?.default).toBeUndefined();
    expect(byPath.get("model.baseUrl")?.default).toBeUndefined();
  });

  it("registers worker.endpointProbe as a live enum lever defaulting to auto", () => {
    const byPath = new Map(LEVERS.map((l) => [l.path, l]));
    expect(byPath.get("worker.endpointProbe")).toMatchObject({
      type: "enum",
      enumValues: ["auto", "always", "never"],
      default: "auto",
      reload: "live",
      editable: true,
    });
  });

  it("registers worker.dailyBudgetUsd as a live number lever defaulting to 0 (Phase-3 Task 5)", () => {
    const byPath = new Map(LEVERS.map((l) => [l.path, l]));
    expect(byPath.get("worker.dailyBudgetUsd")).toMatchObject({
      type: "number",
      default: 0,
      min: 0,
      reload: "live",
      editable: true,
    });
  });

  it("registers worker.applyFallbackToAgent as a live boolean lever defaulting to true (Stage 2a)", () => {
    const byPath = new Map(LEVERS.map((l) => [l.path, l]));
    expect(byPath.get("worker.applyFallbackToAgent")).toMatchObject({
      type: "boolean",
      default: true,
      reload: "live",
      editable: true,
    });
  });

  it("worker.applyFallbackToAgent's description names BOTH rungs it gates — apply AND verification (final-review R10)", () => {
    // Before the fix, the description named only the apply rung ("fails to
    // apply") and never mentioned the Stage-2b verification rung it also
    // gates — the exact thing an operator reading `junco config` most needs
    // to know before turning the lever off. docs/configuration.md already
    // gets this right; this pins the lever string to match.
    const byPath = new Map(LEVERS.map((l) => [l.path, l]));
    const lever = byPath.get("worker.applyFallbackToAgent");
    expect(lever?.description).toMatch(/appl/i);
    expect(lever?.description).toMatch(/verif/i);
  });
});

describe("coerceLever", () => {
  // tests/configCmd.test.ts reaches coerceLever only through `junco config
  // set`, which rejects structured levers before the call and never sets a
  // secret or overshoots a max — so these three branches had no executing
  // test (#369).
  it("rejects a number above the lever's max", () => {
    const lever = leverAtPath("observability.healthPort")!;
    expect(coerceLever(lever, "65536")).toEqual({ error: "must be <= 65535" });
  });
  it("passes a secret through verbatim", () => {
    const lever = leverAtPath("model.apiKey")!;
    expect(coerceLever(lever, "sk-live-abc")).toEqual({ value: "sk-live-abc" });
  });
  it("falls back to the structured refusal for a lever the caller should have rejected first", () => {
    const lever = leverAtPath("skills.harnessDirs")!;
    expect(coerceLever(lever, "[]")).toEqual({ error: "structured — edit config.json directly" });
  });
});
