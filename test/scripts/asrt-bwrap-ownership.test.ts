import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import { hardenLinuxSandboxWrap } from "../../src/permissions/linux-sandbox-wrap.js";

// These cases require a working namespace backend, not just an installed binary.
describe.runIf(process.platform === "linux")("mount point cleanup ownership", () => {
  let root: string;
  let target: string;
  let marker: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-mount-owner-"));
    target = join(root, "denied");
    marker = join(root, "executed");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    cleanupBwrapMountPoints({ force: true });
    rmSync(root, { recursive: true, force: true });
  });

  async function plan(denies = [target], command = `printf executed > '${marker}'`) {
    const wrapped = await wrapCommandWithSandboxLinux({
      command,
      needsNetworkRestriction: false,
      allowAllUnixSockets: true,
      mandatoryDenySearchDepth: 0,
      writeConfig: { allowOnly: [root], denyWithinAllow: denies },
    });
    return hardenLinuxSandboxWrap({ argv: ["/bin/sh", "-c", wrapped], env: process.env });
  }

  function execute(wrapped: Awaited<ReturnType<typeof plan>>) {
    const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
      env: wrapped.env, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return result;
  }

  function identity(path: string) {
    const { dev, ino } = lstatSync(path, { bigint: true });
    return { dev, ino };
  }

  it("removes its own empty file after a real write denial", async () => {
    const wrapped = await plan([target], `printf executed > '${marker}'; printf forbidden > '${target}'`);
    expect(lstatSync(target).isFile()).toBe(true);
    const result = execute(wrapped);
    expect(result.status, result.stderr).not.toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("executed");
    expect(readFileSync(target, "utf8")).toBe("");
    cleanupBwrapMountPoints();
    expect(existsSync(target)).toBe(false);
  });

  it("preserves a directory installed after a file plan while execution fails closed", async () => {
    const wrapped = await plan();
    // Keep the old inode allocated so this also checks replacement identity.
    renameSync(target, join(root, "original"));
    mkdirSync(target);
    const replacement = identity(target);
    const result = execute(wrapped);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Is a directory/u);
    expect(existsSync(marker)).toBe(false);
    cleanupBwrapMountPoints();
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(identity(target)).toEqual(replacement);
    cleanupBwrapMountPoints({ force: true });
    expect(identity(target)).toEqual(replacement);
  });

  it("does not claim a directory that wins the exclusive creation race", async () => {
    const open = fs.openSync;
    const interception = vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof open>) => {
      if (args[0] === target && args[1] === "wx") mkdirSync(target);
      return open(...args);
    });
    syncBuiltinESMExports();
    const wrapped = await plan();
    interception.mockRestore();
    syncBuiltinESMExports();
    expect(lstatSync(target).isDirectory()).toBe(true);
    const replacement = identity(target);
    const result = execute(wrapped);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Is a directory/u);
    expect(existsSync(marker)).toBe(false);
    cleanupBwrapMountPoints();
    expect(identity(target)).toEqual(replacement);
  });

  it.each(["file", "directory", "symlink"] as const)("preserves a replacement %s", async (kind) => {
    const directory = kind === "directory";
    const wrapped = await plan(directory ? [join(target, "config")] : [target]);
    expect(lstatSync(target).isDirectory()).toBe(directory);
    renameSync(target, join(root, "original"));
    if (directory) mkdirSync(target);
    else if (kind === "file") writeFileSync(target, "");
    else symlinkSync(join(root, "original"), target);
    const replacement = identity(target);
    const result = execute(wrapped);
    if (kind === "symlink") {
      expect(result.status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    } else expect(result.status, result.stderr).toBe(0);
    cleanupBwrapMountPoints();
    expect(identity(target)).toEqual(replacement);
    expect(lstatSync(target).isSymbolicLink()).toBe(kind === "symlink");
  });

  it("removes its own empty intermediate directory", async () => {
    const wrapped = await plan([join(target, "config")]);
    expect(lstatSync(target).isDirectory()).toBe(true);
    const result = execute(wrapped);
    expect(result.status, result.stderr).toBe(0);
    cleanupBwrapMountPoints();
    expect(existsSync(target)).toBe(false);
  });

  it("preserves a replacement private empty mount source", async () => {
    const wrapped = await plan([join(target, "config")]);
    const words = wrapped.argv[2].split(" ");
    const targetIndex = words.findIndex((word, index) => word === target && words[index - 2] === "--ro-bind");
    expect(targetIndex).toBeGreaterThan(1);
    const source = words[targetIndex - 1];
    expect(lstatSync(source).isDirectory()).toBe(true);
    const original = `${source}-original`;
    renameSync(source, original);
    mkdirSync(source, { mode: 0o700 });
    const replacement = identity(source);
    try {
      const result = execute(wrapped);
      expect(result.status, result.stderr).toBe(0);
      cleanupBwrapMountPoints();
      expect(identity(source)).toEqual(replacement);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(original, { recursive: true, force: true });
    }
  });

  it.each(["file", "directory"] as const)("does not claim a pre-existing empty %s", async (kind) => {
    if (kind === "file") writeFileSync(target, "");
    else mkdirSync(target);
    const original = identity(target);
    const result = execute(await plan());
    expect(result.status, result.stderr).toBe(0);
    cleanupBwrapMountPoints();
    expect(identity(target)).toEqual(original);
  });

  it("defers owned cleanup until every planned invocation has ended", async () => {
    const first = await plan();
    const owned = identity(target);
    const second = await plan();
    expect(execute(first).status).toBe(0);
    cleanupBwrapMountPoints();
    expect(identity(target)).toEqual(owned);
    expect(execute(second).status).toBe(0);
    cleanupBwrapMountPoints();
    expect(existsSync(target)).toBe(false);
  });
});
