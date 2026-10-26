import { describe, expect, it, vi } from "vitest";
import type { BigIntStats } from "node:fs";
import {
  captureDenyPlaceholders,
  cleanupDenyPlaceholders,
  snapshotMissingDenyPaths,
  type PlaceholderFilesystem,
} from "../windows-deny-placeholders.js";

function entry(options: { ino?: bigint; size?: bigint; directory?: boolean; link?: boolean } = {}): BigIntStats {
  return {
    ino: options.ino ?? 1n, dev: 2n, birthtimeNs: 3n, size: options.size ?? 0n,
    isFile: () => !options.directory && !options.link,
    isDirectory: () => options.directory === true,
    isSymbolicLink: () => options.link === true,
  } as BigIntStats;
}

function provideFilesystem(entries: Record<string, BigIntStats>, children: string[] = []): PlaceholderFilesystem {
  const paths: Record<string, BigIntStats> = { "D:\\": entry({ directory: true }), "D:\\fixture": entry({ directory: true }), ...entries };
  return {
    lstatSync: vi.fn((path: string) => {
      const value = paths[path];
      if (!value) throw Object.assign(new Error("Missing path"), { code: "ENOENT" });
      return value;
    }),
    readdirSync: vi.fn(() => children),
    unlinkSync: vi.fn(),
    rmdirSync: vi.fn(),
  };
}

describe("Windows deny placeholders", () => {
  it("snapshots a missing leaf and its ancestors up to an existing entry", () => {
    const fs = provideFilesystem({ "D:\\fixture": entry({ directory: true }) });
    expect(snapshotMissingDenyPaths(["D:\\fixture\\new\\leaf", "D:\\fixture\\new\\dir\\"], fs))
      .toEqual(["D:\\fixture\\new\\leaf", "D:\\fixture\\new", "D:\\fixture\\new\\dir"]);
    expect(fs.lstatSync).toHaveBeenCalledWith("D:\\fixture", { bigint: true });
  });

  it("skips network targets and wildcard patterns without probing them", () => {
    const fs = provideFilesystem({});
    expect(snapshotMissingDenyPaths(["\\\\server\\share\\leaf", "D:\\fixture\\*"], fs)).toEqual([]);
    expect(fs.lstatSync).not.toHaveBeenCalled();
  });

  it("stops at a link ancestor before probing its child", () => {
    const fs = provideFilesystem({ "D:\\fixture\\link": entry({ link: true }) });
    expect(snapshotMissingDenyPaths(["D:\\fixture\\link\\missing"], fs)).toEqual([]);
    expect(fs.lstatSync).not.toHaveBeenCalledWith("D:\\fixture\\link\\missing", { bigint: true });
  });

  it("captures only entries that appeared after the snapshot", () => {
    const fs = provideFilesystem({ "D:\\fixture\\leaf": entry() });
    expect(captureDenyPlaceholders(["D:\\fixture\\leaf", "D:\\fixture\\absent"], fs))
      .toEqual([{ path: "D:\\fixture\\leaf", ino: 1n, dev: 2n, birthtimeNs: 3n }]);
  });

  it("removes empty placeholders in deepest-first order", () => {
    const fs = provideFilesystem({
      "D:\\fixture\\new": entry({ directory: true }),
      "D:\\fixture\\new\\leaf": entry(),
    });
    const entries = captureDenyPlaceholders(Object.keys({ "D:\\fixture\\new": 1, "D:\\fixture\\new\\leaf": 1 }), fs);
    const warn = vi.fn();
    cleanupDenyPlaceholders(entries, warn, fs, () => true);
    expect(fs.unlinkSync).toHaveBeenCalledWith("D:\\fixture\\new\\leaf");
    expect(fs.rmdirSync).toHaveBeenCalledWith("D:\\fixture\\new");
    expect(vi.mocked(fs.unlinkSync).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(fs.rmdirSync).mock.invocationCallOrder[0]!);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a replaced identity and logs its path once", () => {
    const fs = provideFilesystem({ "D:\\fixture\\leaf": entry() });
    const captured = captureDenyPlaceholders(["D:\\fixture\\leaf"], fs);
    vi.mocked(fs.lstatSync).mockReturnValue(entry({ ino: 9n }));
    const warn = vi.fn();
    cleanupDenyPlaceholders(captured, warn, fs, () => true);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith("D:\\fixture\\leaf");
  });

  it("keeps a directory containing data", () => {
    const fs = provideFilesystem({ "D:\\fixture\\new": entry({ directory: true }) }, ["data"]);
    const warn = vi.fn();
    cleanupDenyPlaceholders(captureDenyPlaceholders(["D:\\fixture\\new"], fs), warn, fs, () => true);
    expect(fs.rmdirSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith("D:\\fixture\\new");
  });

  it("keeps a link without reading its target", () => {
    const fs = provideFilesystem({ "D:\\fixture\\link": entry({ link: true }) });
    const warn = vi.fn();
    cleanupDenyPlaceholders(captureDenyPlaceholders(["D:\\fixture\\link"], fs), warn, fs, () => true);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith("D:\\fixture\\link");
  });

  it("keeps a nonempty file", () => {
    const fs = provideFilesystem({ "D:\\fixture\\leaf": entry({ size: 4n }) });
    const warn = vi.fn();
    cleanupDenyPlaceholders(captureDenyPlaceholders(["D:\\fixture\\leaf"], fs), warn, fs, () => true);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith("D:\\fixture\\leaf");
  });

  it("keeps an entry whose ancestry cannot be proved free of reparse points", () => {
    const fs = provideFilesystem({ "D:\\fixture\\leaf": entry() });
    const warn = vi.fn();
    cleanupDenyPlaceholders(captureDenyPlaceholders(["D:\\fixture\\leaf"], fs), warn, fs, () => false);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith("D:\\fixture\\leaf");
  });
});
