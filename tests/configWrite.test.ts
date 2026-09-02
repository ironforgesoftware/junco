import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readConfigFile,
  writeConfigFile,
  updateConfigFile,
  isConfigValidationError,
} from "../src/configWrite.js";

/** In-memory fs seam: one config "file" plus a log of every write/rename/unlink. */
function fakeFs(initial: string | null) {
  const writes: [string, string][] = [];
  const renames: [string, string][] = [];
  const unlinks: string[] = [];
  const deps = {
    readFileFn: (p: string) => {
      if (initial === null) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return initial;
    },
    writeFileFn: (p: string, s: string) => void writes.push([p, s]),
    renameFn: (a: string, b: string) => void renames.push([a, b]),
    unlinkFn: (p: string) => void unlinks.push(p),
  };
  return { deps, writes, renames, unlinks };
}

const CFG = "/sbxroot/.junco/config.json";

describe("updateConfigFile", () => {
  it("reads, mutates, validates, writes a PID-suffixed temp file beside the config, renames over it", () => {
    const fs = fakeFs(JSON.stringify({ model: { id: "m" }, worker: { maxConcurrent: 2 } }));
    const written = updateConfigFile(CFG, (raw) => void (raw.dataDir = "/sbxroot/data"), fs.deps);
    expect(fs.writes).toHaveLength(1);
    const [tmp, content] = fs.writes[0];
    expect(tmp).toBe(`/sbxroot/.junco/.config.json.tmp-${process.pid}`);
    expect(content).toBe(JSON.stringify(written, null, 2) + "\n");
    expect(JSON.parse(content)).toEqual({
      model: { id: "m" },
      worker: { maxConcurrent: 2 },
      dataDir: "/sbxroot/data",
    });
    expect(fs.renames).toEqual([[tmp, CFG]]);
    expect(fs.unlinks).toEqual([]);
  });

  it("rejects a mutation that fails ConfigSchema: throws a validation error, writes nothing", () => {
    const fs = fakeFs(JSON.stringify({ model: { id: "m" } }));
    let thrown: unknown;
    try {
      updateConfigFile(CFG, (raw) => void (raw.worker = { maxConcurrent: 0 }), fs.deps);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(isConfigValidationError(thrown)).toBe(true);
    expect(fs.writes).toEqual([]);
    expect(fs.renames).toEqual([]);
  });

  it("refuses to persist a config that was ALREADY invalid in an unrelated field", () => {
    const fs = fakeFs(JSON.stringify({ vaultRoot: 123 }));
    expect(() => updateConfigFile(CFG, (raw) => void (raw.dataDir = "/d"), fs.deps)).toThrow();
    expect(fs.writes).toEqual([]);
  });

  it("propagates a read failure untouched (a missing config is the caller's decision, not a fresh `{}`)", () => {
    const fs = fakeFs(null);
    let thrown: unknown;
    try {
      updateConfigFile(CFG, () => {}, fs.deps);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe("ENOENT");
    expect(isConfigValidationError(thrown)).toBe(false);
    expect(fs.writes).toEqual([]);
  });

  it("on a rename failure, unlinks the temp file best-effort and rethrows the original error", () => {
    const fs = fakeFs(JSON.stringify({ model: { id: "m" } }));
    fs.deps.renameFn = () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    };
    expect(() => updateConfigFile(CFG, () => {}, fs.deps)).toThrow(/EPERM/);
    expect(fs.unlinks).toEqual([[...fs.writes][0][0]]);
    expect(fs.unlinks[0]).toMatch(/\.config\.json\.tmp-\d+$/);
  });

  it("on a temp-write failure, still attempts the unlink and rethrows even when the unlink itself throws", () => {
    const fs = fakeFs(JSON.stringify({ model: { id: "m" } }));
    fs.deps.writeFileFn = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    fs.deps.unlinkFn = () => {
      throw new Error("ENOENT: nothing to unlink");
    };
    expect(() => updateConfigFile(CFG, () => {}, fs.deps)).toThrow(/ENOSPC/);
    expect(fs.renames).toEqual([]);
  });

  // #343: config.json may hold a literal model.apiKey. The default writer
  // creates the temp file 0600 and the mode rides through the rename, so a
  // rewrite tightens a loose file too — for EVERY writer, not just `config set`.
  it.skipIf(process.platform === "win32")(
    "real fs: the default writer leaves the config owner-only (0600) even when it was 0644",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "cfgwrite-"));
      const p = join(dir, "config.json");
      writeFileSync(p, JSON.stringify({ model: { id: "m" } }), "utf8");
      chmodSync(p, 0o644);
      updateConfigFile(p, (raw) => void (raw.dataDir = dir));
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(p, "utf8")).dataDir).toBe(dir);
      expect(existsSync(join(dir, `.config.json.tmp-${process.pid}`))).toBe(false);
    },
  );
});

describe("writeConfigFile", () => {
  it("validates BEFORE touching the writer — an invalid whole object never reaches writeFileFn", () => {
    const fs = fakeFs(null);
    expect(() => writeConfigFile(CFG, { worker: { maxConcurrent: 0 } }, fs.deps)).toThrow();
    expect(fs.writes).toEqual([]);
  });

  it("writes a valid whole object without reading the existing file", () => {
    const fs = fakeFs(null); // readFileFn would throw — must never be called
    writeConfigFile(CFG, { model: { id: "m" } }, fs.deps);
    expect(fs.writes).toHaveLength(1);
    expect(JSON.parse(fs.writes[0][1])).toEqual({ model: { id: "m" } });
    expect(fs.renames).toEqual([[fs.writes[0][0], CFG]]);
  });
});

describe("readConfigFile", () => {
  it("parses the raw (sparse, undefaulted) object", () => {
    const fs = fakeFs(JSON.stringify({ model: { id: "m" } }));
    expect(readConfigFile(CFG, fs.deps)).toEqual({ model: { id: "m" } });
  });

  it.each([
    ["null", "null"],
    ["[]", "an array"],
    ['"s"', "string"],
  ])("rejects a JSON document that is not an object (%s)", (doc, kind) => {
    const fs = fakeFs(doc);
    expect(() => readConfigFile(CFG, fs.deps)).toThrow(
      new RegExp(`${CFG}: expected a JSON object, got ${kind}`),
    );
  });
});

describe("isConfigValidationError", () => {
  it("is false for a plain Error and for non-errors", () => {
    expect(isConfigValidationError(new Error("EACCES"))).toBe(false);
    expect(isConfigValidationError("nope")).toBe(false);
    expect(isConfigValidationError(undefined)).toBe(false);
  });
});
