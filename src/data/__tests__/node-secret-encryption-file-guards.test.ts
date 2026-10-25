import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BigIntStats } from "node:fs";

let onRead: (() => void) | undefined;
let inspectStats: ((stats: BigIntStats) => BigIntStats) | undefined;
const openDescriptors = new Set<number>();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      openDescriptors.add(fd);
      return fd;
    },
    closeSync: (fd: number) => { openDescriptors.delete(fd); actual.closeSync(fd); },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const count = (actual.readSync as (...values: unknown[]) => number)(...args);
      onRead?.();
      return count;
    },
    lstatSync: (path: string, options: { bigint: true }) => {
      const stats = actual.lstatSync(path, options);
      return inspectStats?.(stats) ?? stats;
    },
    fstatSync: (fd: number, options: { bigint: true }) => {
      const stats = actual.fstatSync(fd, options);
      return inspectStats?.(stats) ?? stats;
    },
  };
});

const { chmodSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { randomBytes } = await import("node:crypto");
const { createNodeSecretEncryption, SecretKeyFileError } = await import("../node-secret-encryption.js");
const { cleanupTmpDir } = await import("../../__tests__/support/tmp-dir-teardown.js");

let root: string;
let keyFile: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-key-file-race-"));
  keyFile = join(root, "key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
});
afterEach(async () => {
  onRead = undefined;
  inspectStats = undefined;
  expect(openDescriptors.size).toBe(0);
  await cleanupTmpDir(root);
});

// These drive the POSIX owner, mode and inode guards, which never run on Windows:
// the key reader refuses there before opening the file.
describe.skipIf(process.platform === "win32")("external key file invariants", () => {
  it("rejects a different owner and special permission bits before reading", () => {
    let reads = 0;
    onRead = () => { reads += 1; };
    inspectStats = (stats) => Object.assign(stats, { uid: stats.uid + 1n });
    expect(() => createNodeSecretEncryption(keyFile)).toThrow(/owned by the current user/);
    inspectStats = (stats) => Object.assign(stats, { mode: stats.mode | 0o4000n });
    expect(() => createNodeSecretEncryption(keyFile)).toThrow(/0400 or 0600/);
    expect(reads).toBe(0);
  });

  it("detects changed bytes even if equal-sized mutation preserves every observed metadata field", () => {
    const pinned = statSync(keyFile, { bigint: true });
    inspectStats = () => pinned;
    onRead = () => {
      onRead = undefined;
      writeFileSync(keyFile, randomBytes(32));
    };
    expect(() => createNodeSecretEncryption(keyFile)).toThrow(/changed during read/);
  });

  it("rejects replacement and permission broadening during the read", () => {
    const original = readFileSync(keyFile);
    const replacement = join(root, "replacement");
    writeFileSync(replacement, original, { mode: 0o600 });
    onRead = () => {
      onRead = undefined;
      renameSync(replacement, keyFile);
    };
    expect(() => createNodeSecretEncryption(keyFile)).toThrow(SecretKeyFileError);
    onRead = () => {
      onRead = undefined;
      chmodSync(keyFile, 0o644);
    };
    expect(() => createNodeSecretEncryption(keyFile)).toThrow(/0400 or 0600/);
    expect(statSync(keyFile).mode & 0o777).toBe(0o644);
  });

  it.each([
    ["descriptor", 1],
    ["path", 2],
  ])("rejects a %s file ID that differs only beyond the exact number range", (_label, changedObservation) => {
    const inode = 2n ** 60n;
    let observations = 0;
    inspectStats = (stats) => Object.assign(stats, {
      ino: inode + (observations++ === changedObservation ? 1n : 0n),
    });
    expect(Number(inode)).toBe(Number(inode + 1n));
    expect(() => createNodeSecretEncryption(keyFile)).toThrow(/changed during read/);
  });
});
