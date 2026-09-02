import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ConfigSchema } from "../src/configSchema.js";
import { getAtPath } from "../src/configLevers.js";

// The hazard this file exists for: zod 4 changed `.default()` to SHORT-CIRCUIT
// — an absent key yields the declared value as given, without feeding it
// through the schema. Under zod 3, `z.object({...}).default({})` parsed that
// `{}` and so materialized every leaf default inside it; under zod 4 the same
// spelling hands back a literal `{}` and every leaf below it reads `undefined`.
// `ConfigSchema` therefore declares its sections with `.prefault({})` (zod 4's
// spelling for the v3 behaviour). Everything downstream — `assembleConfig`,
// `junco config`, the TUI levers — assumes an omitted section still arrives
// fully populated, so these tests pin that at the schema boundary rather than
// leaving it to be inferred from an assembly failure three modules away.

/** Every schema leaf that declares a default, with the value it declares.
 * Unwraps the zod 4 wrapper nodes: ZodDefault / ZodPrefault (both carry
 * `_def.defaultValue`), ZodOptional, and ZodPipe (`.transform()`, whose source
 * schema is `_def.in`). */
function declaredDefaults(schema: z.ZodTypeAny, prefix = ""): { path: string; default: unknown }[] {
  let s = schema;
  let def: unknown;
  let declared = false;
  for (;;) {
    if (s instanceof z.ZodPipe) {
      s = s._def.in as z.ZodTypeAny;
    } else if (s instanceof z.ZodDefault || s instanceof z.ZodPrefault) {
      def = s._def.defaultValue;
      declared = true;
      s = s._def.innerType as z.ZodTypeAny;
    } else if (s instanceof z.ZodOptional) {
      s = s._def.innerType as z.ZodTypeAny;
    } else {
      break;
    }
  }
  if (s instanceof z.ZodObject) {
    return Object.entries(s.shape).flatMap(([k, v]) =>
      declaredDefaults(v as z.ZodTypeAny, prefix ? `${prefix}.${k}` : k),
    );
  }
  return declared ? [{ path: prefix, default: def }] : [];
}

describe("ConfigSchema defaults (zod 4 `.default()` short-circuit)", () => {
  const leaves = declaredDefaults(ConfigSchema);

  it("walks a schema with defaults on most leaves (guards the oracle itself)", () => {
    expect(leaves.length).toBeGreaterThan(50);
  });

  it("materializes every declared leaf default when the whole config is empty", () => {
    const parsed = ConfigSchema.parse({}) as unknown as Record<string, unknown>;
    for (const leaf of leaves) {
      expect(getAtPath(parsed, leaf.path), `${leaf.path} did not materialize`).toEqual(
        leaf.default,
      );
    }
  });

  it("materializes a section's leaves when only that section is omitted", () => {
    const parsed = ConfigSchema.parse({ worker: { maxConcurrent: 4 } });
    expect(parsed.worker.maxConcurrent).toBe(4);
    expect(parsed.worker.defaultTimeoutMinutes).toBe(30);
    expect(parsed.worker.pollIntervalSeconds).toBe(15);
    expect(parsed.model.id).toBe("local/my-model");
    expect(parsed.sandbox.backend).toBe("auto");
  });

  it("materializes doubly-nested sections (model.retry / model.cost) under an omitted model", () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.model.retry).toEqual({});
    expect(parsed.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("materializes record defaults (model.thinkingLevelMap / model.compat)", () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.model.thinkingLevelMap.high).toBe("xhigh");
    expect(parsed.model.compat).toEqual({});
  });

  it("runs the healthHost transform over the default (loopback, never an empty bind)", () => {
    expect(ConfigSchema.parse({}).observability.healthHost).toBe("127.0.0.1");
    expect(
      ConfigSchema.parse({ observability: { healthHost: "  " } }).observability.healthHost,
    ).toBe("127.0.0.1");
  });

  it("still validates inside a defaulted section — prefault fills, it does not excuse", () => {
    expect(() => ConfigSchema.parse({ worker: { maxConcurrent: 0 } })).toThrow();
    expect(() => ConfigSchema.parse({ sandbox: { backend: "nope" } })).toThrow();
    expect(() => ConfigSchema.parse({ model: { apiKey: "!op read secret" } })).toThrow();
  });
});
