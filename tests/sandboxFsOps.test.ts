import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  makeJailedReadOperations,
  makeJailedWriteOperations,
  makeJailedEditOperations,
  makeJailedLsOperations,
  makeJailedFindOperations,
  makeJailedGrepOperations,
} from "../src/agent/sandbox/fsOps.js";
import { SandboxViolation } from "../src/agent/sandbox/pathJail.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const dirs: string[] = [];
function tmp(): string {
  // realpath so writableRoots match the canonicalized jail comparison on macOS.
  const d = realpathSync(mkdtempSync(join(tmpdir(), "junco-fsops-")));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function policyFor(work: string, deny: string[] = []): SandboxPolicy {
  return {
    writableRoots: [work],
    readDenyPaths: deny,
    readDenyFiles: [],
    readAllowPaths: [],
    network: false,
    scratchDir: work,
    bashTimeoutMs: undefined,
  };
}

describe("jailed read", () => {
  it("reads an allowed file, blocks a denied subpath", async () => {
    const work = tmp();
    writeFileSync(join(work, "a.txt"), "hello");
    const secret = tmp();
    writeFileSync(join(secret, "id_rsa"), "KEY");
    const ops = makeJailedReadOperations(work, policyFor(work, [secret]));
    expect((await ops.readFile(join(work, "a.txt"))).toString()).toBe("hello");
    await expect(ops.readFile(join(secret, "id_rsa"))).rejects.toBeInstanceOf(SandboxViolation);
    await expect(ops.access(join(secret, "id_rsa"))).rejects.toBeInstanceOf(SandboxViolation);
  });
});

describe("jailed write", () => {
  it("writes inside the root, blocks outside", async () => {
    const work = tmp();
    const outside = tmp();
    const ops = makeJailedWriteOperations(work, policyFor(work));
    await ops.writeFile(join(work, "out.txt"), "ok");
    await expect(ops.writeFile(join(outside, "x.txt"), "no")).rejects.toBeInstanceOf(
      SandboxViolation,
    );
    await ops.mkdir(join(work, "sub"));
    await expect(ops.mkdir(join(outside, "sub"))).rejects.toBeInstanceOf(SandboxViolation);
  });
});

describe("jailed edit", () => {
  it("access requires the path to be writable (read+write)", async () => {
    const work = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "f.txt"), "x");
    const ops = makeJailedEditOperations(work, policyFor(work));
    await expect(ops.access(join(outside, "f.txt"))).rejects.toBeInstanceOf(SandboxViolation);
  });

  it("reads an allowed file, blocks a denied subpath", async () => {
    const work = tmp();
    writeFileSync(join(work, "a.txt"), "hello");
    const secret = tmp();
    writeFileSync(join(secret, "id_rsa"), "KEY");
    const ops = makeJailedEditOperations(work, policyFor(work, [secret]));
    expect((await ops.readFile(join(work, "a.txt"))).toString()).toBe("hello");
    await expect(ops.readFile(join(secret, "id_rsa"))).rejects.toBeInstanceOf(SandboxViolation);
  });
});

describe("jailed ls", () => {
  it("lists an allowed dir, blocks a denied subpath", async () => {
    const work = tmp();
    writeFileSync(join(work, "a.txt"), "hello");
    const secret = tmp();
    writeFileSync(join(secret, "id_rsa"), "KEY");
    const ops = makeJailedLsOperations(work, policyFor(work, [secret]));
    expect(await ops.exists(join(work, "a.txt"))).toBe(true);
    expect((await ops.stat(work)).isDirectory()).toBe(true);
    expect(await ops.readdir(work)).toEqual(["a.txt"]);
    // The file exists on disk, so `false` here can only be the jail firing.
    expect(await ops.exists(join(secret, "id_rsa"))).toBe(false);
    await expect(ops.stat(join(secret, "id_rsa"))).rejects.toBeInstanceOf(SandboxViolation);
    await expect(ops.readdir(secret)).rejects.toBeInstanceOf(SandboxViolation);
  });
});

describe("jailed find", () => {
  it("globs under an allowed root, blocks a denied root", async () => {
    const work = tmp();
    writeFileSync(join(work, "a.txt"), "hello");
    writeFileSync(join(work, "b.txt"), "world");
    const secret = tmp();
    writeFileSync(join(secret, "id_rsa"), "KEY");
    const ops = makeJailedFindOperations(work, policyFor(work, [secret]));
    expect(await ops.exists(join(work, "a.txt"))).toBe(true);
    const all = await ops.glob("*.txt", work, { ignore: [], limit: 10 });
    expect(all.sort()).toEqual(["a.txt", "b.txt"]);
    expect(await ops.glob("*.txt", work, { ignore: [], limit: 1 })).toHaveLength(1);
    expect(await ops.exists(join(secret, "id_rsa"))).toBe(false);
    await expect(ops.glob("*", secret, { ignore: [], limit: 10 })).rejects.toBeInstanceOf(
      SandboxViolation,
    );
  });
});

describe("jailed grep", () => {
  it("reads an allowed file, blocks a denied subpath", async () => {
    const work = tmp();
    writeFileSync(join(work, "a.txt"), "hello");
    const secret = tmp();
    writeFileSync(join(secret, "id_rsa"), "KEY");
    const ops = makeJailedGrepOperations(work, policyFor(work, [secret]));
    expect(await ops.isDirectory(work)).toBe(true);
    expect(await ops.isDirectory(join(work, "a.txt"))).toBe(false);
    expect(await ops.readFile(join(work, "a.txt"))).toBe("hello");
    await expect(ops.isDirectory(secret)).rejects.toBeInstanceOf(SandboxViolation);
    await expect(ops.readFile(join(secret, "id_rsa"))).rejects.toBeInstanceOf(SandboxViolation);
  });
});

// Security (#158): a dangling in-jail symlink pointing OUT of the jail must not
// let a write escape. The jail must deny it and no file may appear outside.
describe("dangling-symlink write escape is blocked", () => {
  it("write through an out-of-jail dangling symlink is denied and creates nothing", async () => {
    const work = tmp();
    const outsideTarget = join(tmp(), "ESCAPED.txt"); // absent, outside `work`
    symlinkSync(outsideTarget, join(work, "innocent"));
    const ops = makeJailedWriteOperations(work, policyFor(work));
    await expect(ops.writeFile(join(work, "innocent"), "PWNED")).rejects.toBeInstanceOf(
      SandboxViolation,
    );
    expect(existsSync(outsideTarget)).toBe(false);
  });

  it("edit through an out-of-jail dangling symlink is denied and creates nothing", async () => {
    const work = tmp();
    const outsideTarget = join(tmp(), "ESCAPED2.txt");
    symlinkSync(outsideTarget, join(work, "innocent"));
    const ops = makeJailedEditOperations(work, policyFor(work));
    await expect(ops.writeFile(join(work, "innocent"), "PWNED")).rejects.toBeInstanceOf(
      SandboxViolation,
    );
    expect(existsSync(outsideTarget)).toBe(false);
  });

  it("mkdir through an out-of-jail dangling symlink is denied and creates nothing", async () => {
    const work = tmp();
    const outsideParent = join(tmp(), "escape-dir"); // absent, outside `work`
    symlinkSync(outsideParent, join(work, "innocent"));
    const ops = makeJailedWriteOperations(work, policyFor(work));
    await expect(ops.mkdir(join(work, "innocent"))).rejects.toBeInstanceOf(SandboxViolation);
    expect(existsSync(outsideParent)).toBe(false);
  });

  it("still allows a legit write to a NEW in-jail file via an in-jail symlink", async () => {
    const work = tmp();
    symlinkSync(join(work, "real.txt"), join(work, "link")); // → work/real.txt (absent, in-jail)
    const ops = makeJailedWriteOperations(work, policyFor(work));
    await ops.writeFile(join(work, "link"), "ok");
    expect(existsSync(join(work, "real.txt"))).toBe(true);
  });
});
