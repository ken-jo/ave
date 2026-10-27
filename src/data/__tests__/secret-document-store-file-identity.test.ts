import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import type { BigIntStats, PathLike } from "node:fs";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let inspectStats: ((stats: BigIntStats) => BigIntStats) | undefined;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (path: PathLike, options?: { bigint?: boolean }) => {
      if (options?.bigint !== true) return actual.lstatSync(path);
      const stats = actual.lstatSync(path, { bigint: true });
      return inspectStats?.(stats) ?? stats;
    },
    fstatSync: (fd: number, options?: { bigint?: boolean }) => {
      if (options?.bigint !== true) return actual.fstatSync(fd);
      const stats = actual.fstatSync(fd, { bigint: true });
      return inspectStats?.(stats) ?? stats;
    },
  };
});

const { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { cleanupTmpDir } = await import("../../__tests__/support/tmp-dir-teardown.js");
const { SecretDocumentStore } = await import("../secret-document-store.js");

describe("secret document exact file identity", () => {
  const nativePlatform = process.platform;
  let root: string;
  let store: InstanceType<typeof SecretDocumentStore>;
  beforeEach(() => {
    setProcessPlatform("linux");
    root = mkdtempSync(join(tmpdir(), "ave-secret-identity-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, JSON.stringify({ version: 1, entries: {} }), { mode: 0o600 });
    store = new SecretDocumentStore({
      path,
      policy: "development",
      encryption: {
        isEncryptionAvailable: () => false,
        getSelectedStorageBackend: () => "unknown",
        encryptString: () => { throw new Error("Encryption unavailable"); },
        decryptString: () => { throw new Error("Encryption unavailable"); },
      },
      runtime: { lock: async (_anchor, callback) => callback() },
    });
  });
  afterEach(async () => {
    setProcessPlatform(nativePlatform);
    inspectStats = undefined;
    await cleanupTmpDir(root);
  });

  it.each([
    ["opened descriptor", 1],
    ["descriptor after read", 2],
    ["path after read", 3],
  ])("rejects an inexactly representable replacement at the %s", (_label, changedObservation) => {
    const inode = 2n ** 60n;
    let observations = 0;
    inspectStats = (stats) => Object.assign(stats, {
      ino: inode + (observations++ % 4 === changedObservation ? 1n : 0n),
    });
    if (changedObservation === 1) {
      inspectStats = (stats) => Object.assign(stats, { ino: inode + BigInt(observations++ % 2) });
    }
    expect(Number(inode)).toBe(Number(inode + 1n));
    expect(() => store.get("absent")).toThrow(/Configuration identity changed/);
  });

  it.each([
    ["opened descriptor", 1],
    ["path after mode repair", 2],
  ])("rejects a large file ID replacement at the %s during mode repair", async (_label, changedObservation) => {
    const modeStore = new SecretDocumentStore({
      path: store.path, policy: "development",
      encryption: {
        isEncryptionAvailable: () => false, getSelectedStorageBackend: () => "unknown",
        encryptString: () => { throw new Error("Encryption unavailable"); },
        decryptString: () => { throw new Error("Encryption unavailable"); },
      },
      runtime: { exists: existsSync },
    });
    chmodSync(store.path, 0o644);
    let observations = 0;
    inspectStats = (stats) => Object.assign(stats, {
      ino: 2n ** 60n + (observations++ === changedObservation ? 1n : 0n),
    });
    if (process.platform === "win32") {
      const before = { bytes: readFileSync(store.path), stats: statSync(store.path, { bigint: true }) };
      await expect(store.migrate()).resolves.toBe(false);
      const after = statSync(store.path, { bigint: true });
      expect(readFileSync(store.path)).toEqual(before.bytes);
      expect([after.ino, after.mtimeNs, after.mode]).toEqual([before.stats.ino, before.stats.mtimeNs, before.stats.mode]);
      return;
    }
    await expect(modeStore.migrate()).rejects.toThrow(/changed during mode repair/);
  });

  it("invalidates the identity cache for file IDs differing beyond the exact number range", () => {
    writeFileSync(store.path, JSON.stringify({ version: 1, mutation: 1, entries: {} }));
    const pinned = statSync(store.path, { bigint: true });
    let inode = 2n ** 60n;
    inspectStats = (stats) => Object.assign(stats, {
      ino: inode, size: pinned.size, mtimeNs: pinned.mtimeNs, ctimeNs: pinned.ctimeNs,
    });
    const before = store.identity();
    writeFileSync(store.path, JSON.stringify({ version: 1, mutation: 2, entries: {} }));
    inode += 1n;
    const after = store.identity();
    expect(before?.mutation).toBe(1);
    expect(after?.mutation).toBe(2);
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
  });
});
