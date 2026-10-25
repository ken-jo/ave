import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearKeptArtifacts, createArtifactCache, resolveKeepArtifacts } from "../artifact-cache.js";
import { sha256Hex as sha } from "../../__tests__/fixtures/package-files.js";

describe("createArtifactCache", () => {
  let dir: string;
  let enabled: boolean;
  let clock: number;
  const warn = vi.fn();
  const cache = (maxTotalBytes?: number) =>
    createArtifactCache({
      dir,
      enabled: () => enabled,
      maxFileBytes: 1024,
      ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }),
      log: { warn },
      now: () => new Date(clock),
    });

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "ave-kept-")), "artifacts");
    enabled = true;
    clock = Date.parse("2026-09-24T00:00:00.000Z");
    warn.mockReset();
  });

  afterEach(() => {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("returns a kept zip under its digest", async () => {
    const zip = Buffer.from("zip-a");
    await cache().keep(sha(zip), zip);
    expect(readdirSync(dir)).toEqual([`${sha(zip)}.zip`]);
    expect((await cache().read(sha(zip)))?.equals(zip)).toBe(true);
    expect(await cache().read(sha(Buffer.from("other")))).toBeNull();
  });

  it("reads and keeps nothing while keeping is off, and follows the setting at each use", async () => {
    const zip = Buffer.from("zip-a");
    const kept = cache();
    enabled = false;
    await kept.keep(sha(zip), zip);
    expect(existsSync(dir)).toBe(false);

    enabled = true;
    await kept.keep(sha(zip), zip);
    enabled = false;
    expect(await kept.read(sha(zip))).toBeNull();
    enabled = true;
    expect(await kept.read(sha(zip))).not.toBeNull();
  });

  it("deletes and misses a file that no longer hashes to its name", async () => {
    const zip = Buffer.from("zip-a");
    await cache().keep(sha(zip), zip);
    writeFileSync(join(dir, `${sha(zip)}.zip`), "tampered");
    expect(await cache().read(sha(zip))).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no longer matches its digest"));
  });

  it("refuses to keep bytes under another digest or a key that is not a sha256, and misses on reading one", async () => {
    await expect(cache().keep(sha(Buffer.from("a")), Buffer.from("b"))).rejects.toThrow(/another digest/);
    await expect(cache().keep("../../etc/passwd", Buffer.from("a"))).rejects.toThrow(/another digest|not a sha256/);
    await expect(cache().read("../../etc/passwd")).resolves.toBeNull();
  });

  it("clears every kept zip", async () => {
    const zip = Buffer.alloc(40, 7);
    await cache().keep(sha(zip), zip);
    expect(await cache().read(sha(zip))).toEqual(zip);
    await clearKeptArtifacts(dir);
    expect(await cache().read(sha(zip))).toBeNull();
    await expect(clearKeptArtifacts(dir)).resolves.toBeUndefined();
  });

  it("evicts the least recently used zips past the cap, counting a read as a use", async () => {
    const a = Buffer.alloc(40, 1);
    const b = Buffer.alloc(40, 2);
    const c = Buffer.alloc(40, 3);
    const kept = cache(100);
    await kept.keep(sha(a), a);
    clock += 60_000;
    await kept.keep(sha(b), b);
    clock += 60_000;
    await kept.read(sha(a));
    clock += 60_000;
    await kept.keep(sha(c), c);

    expect(readdirSync(dir).sort()).toEqual([`${sha(a)}.zip`, `${sha(c)}.zip`].sort());
  });
});

describe("resolveKeepArtifacts", () => {
  it("keeps by default, follows the setting, and lets a set environment decide either way", () => {
    expect(resolveKeepArtifacts(undefined, {})).toBe(true);
    expect(resolveKeepArtifacts(false, {})).toBe(false);
    expect(resolveKeepArtifacts(true, { AVE_MARKETPLACE_USE_CACHE: "0" })).toBe(false);
    expect(resolveKeepArtifacts(false, { AVE_MARKETPLACE_USE_CACHE: "1" })).toBe(true);
  });
});
