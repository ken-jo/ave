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
const { stageBrowserUpload, BROWSER_UPLOAD_LIMITS } = await import("../browser-upload.js");
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
  vi.restoreAllMocks();
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


  it.each(["replacement", "resize"] as const)("refuses a staged %s before dispatch", async (change) => {
    const selection = await stageBrowserUpload(destination, async () => [original], () => {});
    const root = join(dir, "home", "browser-uploads");
    const selectionDir = join(root, (await fs.readdir(root))[0]!);
    const stagedPath = join(selectionDir, (await fs.readdir(selectionDir))[0]!);
    if (change === "replacement") {
      await fs.rename(stagedPath, stagedPath + ".original");
      await fs.writeFile(stagedPath, "replaced bytes", { mode: 0o400 });
    } else {
      await fs.chmod(stagedPath, 0o600);
      await fs.writeFile(stagedPath, "resized");
    }
    const before = await fs.stat(stagedPath, { bigint: true });
    const send = vi.fn(async (_paths: readonly string[]) => {});
    try {
      await expect(selection!.dispatch(destination, send)).rejects.toMatchObject({ code: "upload-refused" });
      expect(send).not.toHaveBeenCalled();
      expect(await fs.readFile(stagedPath, "utf8")).toBe(change === "replacement" ? "replaced bytes" : "resized");
      expect((await fs.stat(stagedPath, { bigint: true })).mode).toBe(before.mode);
    } finally {
      if (change === "replacement") await expect(selection!.release()).rejects.toMatchObject({ code: "upload-cleanup-failed" });
      else await expect(selection!.release()).resolves.toBeUndefined();
    }
    if (change === "replacement") {
      expect(await fs.readFile(stagedPath, "utf8")).toBe("replaced bytes");
      expect((await fs.stat(stagedPath, { bigint: true })).mode).toBe(before.mode);
    }
  });

  it("refuses a same-size in-place staging edit before dispatch", async () => {
    const selection = await stageBrowserUpload(destination, async () => [original], () => {});
    const root = join(dir, "home", "browser-uploads");
    const selectionDir = join(root, (await fs.readdir(root))[0]!);
    const stagedPath = join(selectionDir, (await fs.readdir(selectionDir))[0]!);
    const before = await fs.stat(stagedPath, { bigint: true });
    await fs.chmod(stagedPath, 0o600);
    await fs.writeFile(stagedPath, "modified bytes");
    await fs.utimes(stagedPath, 1, 1);
    await fs.chmod(stagedPath, 0o400);
    const edited = await fs.stat(stagedPath, { bigint: true });
    expect({ dev: edited.dev, ino: edited.ino, size: edited.size }).toEqual({ dev: before.dev, ino: before.ino, size: before.size });
    expect(edited.mtimeNs).not.toBe(before.mtimeNs);
    const send = vi.fn(async (_paths: readonly string[]) => {});
    try {
      await expect(selection!.dispatch(destination, send)).rejects.toMatchObject({ code: "upload-refused" });
      expect(send).not.toHaveBeenCalled();
    } finally {
      await expect(selection!.release()).resolves.toBeUndefined();
    }
  });

  it.each(["dev", "ino"] as const)("refuses adjacent large %s values at dispatch", async (field) => {
    identityFor = (path) => path !== original ? ORIGINAL_IDENTITY : undefined;
    const selection = await stageBrowserUpload(destination, async () => [original], () => {});
    identityFor = (path) => path !== original ? { ...ORIGINAL_IDENTITY, [field]: LARGE_ID + 1n } : undefined;
    const send = vi.fn(async (_paths: readonly string[]) => {});
    await expect(selection!.dispatch(destination, send)).rejects.toMatchObject({ code: "upload-refused" });
    expect(send).not.toHaveBeenCalled();
    await expect(selection!.release()).rejects.toMatchObject({ code: "upload-cleanup-failed" });
  });

  it.each(["mtimeNs", "ctimeNs"] as const)("refuses changed staged %s before dispatch", async (field) => {
    const selection = await stageBrowserUpload(destination, async () => [original], () => {});
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      handle.stat = (async (options?: StatOptions) => {
        const observed = await stat(options);
        return options?.bigint ? Object.assign(observed, { [field]: (observed as BigIntStats)[field] + 1n }) : observed;
      }) as typeof handle.stat;
      return handle;
    });
    const send = vi.fn(async (_paths: readonly string[]) => {});
    try {
      await expect(selection!.dispatch(destination, send)).rejects.toMatchObject({ code: "upload-refused" });
      expect(send).not.toHaveBeenCalled();
    } finally {
      await expect(selection!.release()).resolves.toBeUndefined();
    }
  });

  it("delivers bytes read through the verified staging descriptor", async () => {
    const selection = await stageBrowserUpload(destination, async () => [original], () => {});
    const root = join(dir, "home", "browser-uploads");
    const selectionDir = join(root, (await fs.readdir(root))[0]!);
    const stagedPath = join(selectionDir, (await fs.readdir(selectionDir))[0]!);
    const open = fs.open.bind(fs);
    let observedSource = false;
    let assertDescriptorRead: () => void = () => { throw new Error("Staging descriptor was not opened"); };
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === stagedPath && !observedSource) {
        observedSource = true;
        const stat = vi.spyOn(handle, "stat");
        const read = vi.spyOn(handle, "read");
        assertDescriptorRead = () => {
          expect(stat).toHaveBeenCalledWith({ bigint: true });
          expect(read).toHaveBeenCalled();
          expect(stat.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]!);
        };
      }
      return handle;
    });
    try {
      await selection!.dispatch(destination, async (paths) => {
        assertDescriptorRead();
        expect(paths[0]).not.toBe(stagedPath);
        expect(await fs.readFile(paths[0]!, "utf8")).toBe("approved bytes");
        await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      await selection!.release();
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("retains only one generation within the process storage ceiling", async () => {
    await fs.truncate(original, BROWSER_UPLOAD_LIMITS.fileBytes - 1024 * 1024);
    const selections: NonNullable<Awaited<ReturnType<typeof stageBrowserUpload>>>[] = [];
    try {
      for (let index = 0; index < 3; index++) {
        const selection = await stageBrowserUpload(destination, async () => [original], () => {});
        expect(selection).not.toBeNull();
        selections.push(selection!);
      }
      await selections[0]!.dispatch(destination, async () => {});
      await selections[1]!.dispatch(destination, async () => {});
      await expect(selections[2]!.dispatch(destination, async () => {})).resolves.toBeUndefined();
      const fourth = await stageBrowserUpload(destination, async () => [original], () => {});
      selections.push(fourth!);
      await expect(fourth!.dispatch(destination, async () => {})).resolves.toBeUndefined();
      await expect(stageBrowserUpload(destination, async () => [original], () => {})).rejects.toMatchObject({ code: "upload-refused" });
    } finally {
      await Promise.all(selections.map((selection) => selection.release()));
    }
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
