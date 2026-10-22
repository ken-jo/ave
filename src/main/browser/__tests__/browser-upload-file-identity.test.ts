import type { BigIntStats, PathLike, StatOptions, Stats } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let identityFor: ((path: string) => { dev: bigint; ino: bigint } | undefined) | undefined;
function observeStats(stats: Stats | BigIntStats, path: PathLike, options?: StatOptions): Stats | BigIntStats {
  const identity = identityFor?.(String(path));
  if (!identity) return stats;
  return Object.assign(stats, options?.bigint === true ? identity : {
    dev: Number(identity.dev), ino: Number(identity.ino),
  });
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lstat: async (path: PathLike, options?: StatOptions) => observeStats(await actual.promises.lstat(path, options), path, options),
      open: async (...args: Parameters<typeof actual.promises.open>) => {
        const handle = await actual.promises.open(...args);
        const stat = handle.stat.bind(handle);
        handle.stat = (async (options?: StatOptions) => observeStats(await stat(options), args[0], options)) as typeof handle.stat;
        return handle;
      },
    },
  };
});

const { promises: fs } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { stageBrowserUpload } = await import("../browser-upload.js");
const LARGE_ID = 2n ** 60n;
const ORIGINAL_IDENTITY = { dev: LARGE_ID, ino: LARGE_ID };
const destination = { windowId: 1, sessionId: "conversation", tabId: "tab-1", origin: "https://a.example:443", documentId: 7, controlGeneration: 3, ref: "e1", signal: new AbortController().signal };

let dir: string;
let original: string;
let previousHome: string | undefined;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "ave-upload-identity-")));
  previousHome = process.env.AVE_HOME;
  process.env.AVE_HOME = join(dir, "home");
  original = join(dir, "notes.txt");
  await fs.writeFile(original, "approved bytes");
});
afterEach(async () => {
  identityFor = undefined;
  if (previousHome === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = previousHome;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("browser upload exact file identity", () => {
  describe.each(["dev", "ino"] as const)("adjacent %s values beyond number precision", (field) => {
    it.each([
      ["opened descriptor", 1],
      ["descriptor after read", 2],
      ["path after read", 3],
    ])("refuses a source replacement at the %s", async (_label, changedObservation) => {
      expect(Number(LARGE_ID)).toBe(Number(LARGE_ID + 1n));
      let observations = 0;
      identityFor = (path) => path === original
        ? { ...ORIGINAL_IDENTITY, [field]: LARGE_ID + (observations++ === changedObservation ? 1n : 0n) }
        : undefined;
      const selection = stageBrowserUpload(destination, async () => [original], () => {});
      try {
        await expect(selection).rejects.toMatchObject({ code: "upload-refused" });
        expect(observations).toBeGreaterThan(changedObservation);
        expect(await fs.readFile(original, "utf8")).toBe("approved bytes");
        expect(await fs.readdir(join(dir, "home", "browser-uploads"))).toEqual([]);
      } finally {
        identityFor = undefined;
        await (await selection.catch(() => null))?.release();
      }
    });

    it.each([
      ["path before open", 0],
      ["opened descriptor", 1],
      ["path after mode repair", 2],
    ])("preserves a staging replacement at the %s", async (_label, changedObservation) => {
      identityFor = (path) => path !== original ? ORIGINAL_IDENTITY : undefined;
      const selection = await stageBrowserUpload(destination, async () => [original], () => {});
      expect(selection).not.toBeNull();
      let stagedPath = "";
      await selection!.dispatch(destination, async (paths) => { stagedPath = paths[0]!; });
      let observations = 0;
      identityFor = (path) => path === stagedPath
        ? { ...ORIGINAL_IDENTITY, [field]: LARGE_ID + (observations++ === changedObservation ? 1n : 0n) }
        : undefined;
      expect(Number(LARGE_ID)).toBe(Number(LARGE_ID + 1n));
      await expect(selection!.release()).rejects.toMatchObject({ code: "upload-cleanup-failed" });
      expect(observations).toBe(changedObservation + 1);
      expect(await fs.readFile(stagedPath, "utf8")).toBe("approved bytes");
    });
  });

  it("stages and removes files with equal large identities", async () => {
    identityFor = () => ORIGINAL_IDENTITY;
    const selection = await stageBrowserUpload(destination, async () => [original], () => {});
    expect(selection).not.toBeNull();
    let stagedPath = "";
    await selection!.dispatch(destination, async (paths) => {
      stagedPath = paths[0]!;
      expect(await fs.readFile(stagedPath, "utf8")).toBe("approved bytes");
    });
    await selection!.release();
    await expect(fs.lstat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(original, "utf8")).toBe("approved bytes");
  });
});
