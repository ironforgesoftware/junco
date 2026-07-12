import { describe, it, expect } from "vitest";
import { z } from "zod";
import { LEVERS, getAtPath, setAtPath, leverAtPath } from "../src/configLevers.js";
import { ConfigSchema } from "../src/config.js";

// Walk a zod object schema to dotted leaf paths, capturing default + kind.
// Verbatim per the task brief — this is the bijection oracle LEVERS must match.
function schemaLeaves(schema: z.ZodTypeAny, prefix = ""): { path: string; def: z.ZodTypeAny }[] {
  let s = schema;
  while (s instanceof z.ZodDefault || s instanceof z.ZodOptional || s instanceof z.ZodEffects) {
    s = s instanceof z.ZodEffects ? s._def.schema : s._def.innerType;
  }
  if (s instanceof z.ZodObject) {
    return Object.entries(s.shape).flatMap(([k, v]) =>
      schemaLeaves(v as z.ZodTypeAny, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [{ path: prefix, def: schema }];
}

// Extended walker: same traversal, but also records the default captured
// while unwrapping (a ZodDefault node's `defaultValue()`), and unwraps
// ZodEffects before ZodDefault so `z.string().default(x).transform(fn)`
// (e.g. observability.healthHost) still yields the pre-transform default.
// A leaf never wrapped in ZodDefault (e.g. vaultRoot, which is required)
// reports `undefined` — matching a required schema field with no default.
function schemaLeavesWithDefault(
  schema: z.ZodTypeAny,
  prefix = "",
): { path: string; default: unknown }[] {
  let s: z.ZodTypeAny = schema;
  let def: unknown;
  while (s instanceof z.ZodDefault || s instanceof z.ZodOptional || s instanceof z.ZodEffects) {
    if (s instanceof z.ZodEffects) {
      s = s._def.schema;
    } else if (s instanceof z.ZodDefault) {
      def = s._def.defaultValue();
      s = s._def.innerType;
    } else {
      s = s._def.innerType;
    }
  }
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
      let s: z.ZodTypeAny = leafDefs.get(lever.path)!;
      while (s instanceof z.ZodDefault || s instanceof z.ZodOptional || s instanceof z.ZodEffects) {
        s = s instanceof z.ZodEffects ? s._def.schema : s._def.innerType;
      }
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
      let s: z.ZodTypeAny = leafDefs.get(lever.path)!;
      while (s instanceof z.ZodDefault || s instanceof z.ZodOptional || s instanceof z.ZodEffects) {
        s = s instanceof z.ZodEffects ? s._def.schema : s._def.innerType;
      }
      expect(s).toBeInstanceOf(z.ZodNumber);
      if (s instanceof z.ZodNumber) {
        if (lever.min !== undefined) expect(s.minValue).toBe(lever.min);
        if (lever.max !== undefined) expect(s.maxValue).toBe(lever.max);
      }
    }
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
});
