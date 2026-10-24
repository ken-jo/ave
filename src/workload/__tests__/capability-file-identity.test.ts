import type { BigIntStats, PathLike } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let inspectStats: ((stats: BigIntStats) => BigIntStats) | undefined;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (path: PathLike, options: { bigint: true }) => {
      expect(options).toEqual({ bigint: true });
      const stats = actual.lstatSync(path, options);
      return inspectStats?.(stats) ?? stats;
    },
    fstatSync: (fd: number, options: { bigint: true }) => {
      expect(options).toEqual({ bigint: true });
      const stats = actual.fstatSync(fd, options);
      return inspectStats?.(stats) ?? stats;
    },
  };
});

const { chmodSync, mkdtempSync, realpathSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { cleanupTmpDir } = await import("../../__tests__/support/tmp-dir-teardown.js");
const { loadWorkloadBrokerCapabilityFile } = await import("../capability-file.js");

describe("workload capability exact file identity", () => {
  let root: string;
  let path: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-capability-identity-")));
    chmodSync(root, 0o700);
    path = join(root, "capability.json");
    writeFileSync(path, "{}", { mode: 0o400 });
  });
  afterEach(async () => {
    inspectStats = undefined;
    await cleanupTmpDir(root);
  });

  it.each([
    ["parent path before open", 1, "capability-directory-changed"],
    ["descriptor after read", 3, "capability-file-changed"],
    ["path after read", 4, "capability-file-changed"],
    ["final path", 5, "capability-file-changed"],
    ["final parent descriptor", 6, "capability-directory-changed"],
    ["final parent path", 7, "capability-directory-changed"],
  ])("rejects a large file ID replacement at the %s", (_label, changedObservation, code) => {
    const inode = 2n ** 60n;
    let observations = 0;
    inspectStats = (stats) => Object.assign(stats, {
      ino: inode + (observations++ === changedObservation ? 1n : 0n),
    });
    expect(Number(inode)).toBe(Number(inode + 1n));
    // Windows lacks geteuid and O_NOFOLLOW, so the loader refuses before any stat or read.
    const expected = process.platform === "win32" ? "protected-file-unavailable" : code;
    expect(() => loadWorkloadBrokerCapabilityFile(path, join(root, "broker.sock")))
      .toThrow(`workload-broker:${expected}`);
    if (process.platform === "win32") expect(observations).toBe(0);
  });
});
