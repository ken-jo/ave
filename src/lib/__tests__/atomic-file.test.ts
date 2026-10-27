import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";

import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  isCommittedAtomicWriteError,
  isMissingPathError,
  replaceStagedFile,
  replaceUtf8FileAtomicSyncIf,
  writeUtf8FileAtomic,
  writeUtf8FileAtomicSync,
} from "../atomic-file.js";
import {
  BACKGROUND_ATTEMPTS,
  BACKGROUND_BUDGET_MS,
  SYNC_UI_BLOCKING_ATTEMPTS,
  SYNC_UI_BLOCKING_BUDGET_MS,
  transientFsLockDelayMs,
} from "../transient-fs-lock-retry.js";
import { retryOnTransientFsLock } from "../transient-fs-lock-retry.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const staging = vi.hoisted(() => ({ beforeOpen: undefined as ((path: string) => void) | undefined }));
const atStaging = (path: unknown) => {
  if (!String(path).endsWith(".tmp") || !staging.beforeOpen) return;
  const run = staging.beforeOpen;
  staging.beforeOpen = undefined;
  run(String(path));
};
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => { atStaging(args[0]); return actual.openSync(...args); } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => { atStaging(args[0]); return actual.open(...args); } };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-atomic-file-"));
});

afterEach(async () => {
  staging.beforeOpen = undefined;
  await cleanupTmpDir(dir);
});

describe("replaceStagedFile", () => {
  it("checks authority before using the default replacement runtime", () => {
    const source = join(dir, "staged.tmp");
    const target = join(dir, "document.txt");
    writeFileSync(source, "new");
    writeFileSync(target, "old");
    const denied = new Error("Authority expired");
    const beforeRename = vi.fn(() => { throw denied; });

    expect(() => replaceStagedFile(source, target, undefined, beforeRename)).toThrow(denied);
    expect(beforeRename).toHaveBeenCalledTimes(1);
    expect(readFileSync(source, "utf8")).toBe("new");
    expect(readFileSync(target, "utf8")).toBe("old");
  });

  it("revalidates authority before every replacement attempt after transient contention", () => {
    const source = join(dir, "staged.tmp");
    const target = join(dir, "document.txt");
    writeFileSync(source, "new");
    writeFileSync(target, "old");
    const events: string[] = [];
    let attempts = 0;

    replaceStagedFile(source, target, {
      platform: "win32", open: () => 0, fsync: () => undefined, close: () => undefined,
      rename(from, to) {
        attempts += 1;
        events.push("rename");
        if (attempts < 3) throw Object.assign(new Error("Locked"), { code: "EACCES" });
        renameSync(from, to);
      },
      wait: () => { events.push("wait"); },
    }, () => { events.push("guard"); });

    expect(events).toEqual(["guard", "rename", "wait", "guard", "rename", "wait", "guard", "rename"]);
    expect(readFileSync(target, "utf8")).toBe("new");
  });

  it("aborts an authority failure after a retry delay even when its error resembles a file lock", () => {
    const source = join(dir, "staged.tmp");
    const target = join(dir, "document.txt");
    writeFileSync(source, "new");
    writeFileSync(target, "old");
    let authorized = true;
    const denied = Object.assign(new Error("Authority expired"), { code: "EACCES" });
    const rename = vi.fn(() => { throw Object.assign(new Error("Locked"), { code: "EACCES" }); });
    const wait = vi.fn(() => { authorized = false; });
    const beforeRename = vi.fn(() => { if (!authorized) throw denied; });

    expect(() => replaceStagedFile(source, target, {
      platform: "win32", open: () => 0, fsync: () => undefined, close: () => undefined, rename, wait,
    }, beforeRename)).toThrow(denied);
    expect(beforeRename).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(readFileSync(source, "utf8")).toBe("new");
    expect(readFileSync(target, "utf8")).toBe("old");
  });
});

describe("writeUtf8FileAtomicSync", () => {
  it("creates a missing parent namespace before the atomic write", () => {
    const target = join(dir, "nested", "settings.json");

    writeUtf8FileAtomicSync(target, "created");

    expect(readFileSync(target, "utf8")).toBe("created");
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    }
  });

  it("atomically replaces UTF-8 content without leaving a staging file", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, "old", "utf8");

    writeUtf8FileAtomicSync(target, "새 내용\n", 0o600);

    expect(readFileSync(target, "utf8")).toBe("새 내용\n");
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    if (process.platform !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }
  });

  for (const [kind, write] of [
    ["sync", async (path: string, content: string) => { writeUtf8FileAtomicSync(path, content); }],
    ["async", writeUtf8FileAtomic],
  ] as const) {
    it(`refuses a link planted at the staging path instead of writing through it (${kind})`, async (ctx: TestContext) => {
      const outside = join(dir, "outside.txt");
      const target = join(dir, "settings.json");
      writeFileSync(outside, "user\n");
      writeFileSync(target, "old");
      try { symlinkSync(outside, join(dir, "probe")); } catch { ctx.skip(); }
      let planted: string | undefined;
      staging.beforeOpen = (path) => {
        symlinkSync(outside, path);
        planted = path;
      };
      await expect(write(target, "staged\n")).rejects.toMatchObject({ code: "EEXIST" });
      expect(planted?.startsWith(join(dir, ".settings.json."))).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe("user\n");
      expect(readFileSync(target, "utf8")).toBe("old");
    });
  }

  it("keeps the destination intact when a final replacement precondition fails", () => {
    const target = join(dir, "AGENTS.md");
    writeFileSync(target, "user edit", "utf8");

    const replaced = replaceUtf8FileAtomicSyncIf(
      target,
      "packaged update",
      () => false,
    );

    expect(replaced).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("user edit");
    expect(readdirSync(dir)).toEqual(["AGENTS.md"]);
  });

  it("residual TOCTOU window stays whole-file: an external write between check and rename is replaced atomically, never partial (#1640)", () => {
    // Precondition plus rename is not filesystem CAS; a race may only produce whole-file last-writer-wins with no staging residue.
    const target = join(dir, "AGENTS.md");
    writeFileSync(target, "packaged prior", "utf8");

    const replaced = replaceUtf8FileAtomicSyncIf(target, "migrated content", () => {
      writeFileSync(target, "racing external editor content", "utf8");
      return true;
    });

    expect(replaced).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("migrated content");
    expect(readdirSync(dir)).toEqual(["AGENTS.md"]);
  });

  it("cleans its unique temporary file when the final rename fails", () => {
    const target = join(dir, "existing-directory");
    mkdirSync(target);

    expect(() => writeUtf8FileAtomicSync(target, "not committed")).toThrow();

    expect(readdirSync(dir)).toEqual(["existing-directory"]);
    expect(readdirSync(target)).toEqual([]);
  });

  it("marks a post-rename directory sync failure as already committed", () => {
    const target = join(dir, "committed.json");
    const fakeDirectoryFd = 0x7fff_ffff;
    const writeWithDirectorySyncRuntime = writeUtf8FileAtomicSync as unknown as (
      filePath: string,
      content: string,
      mode: number | undefined,
      runtime: {
        platform: NodeJS.Platform;
        open(parentDir: string): number;
        fsync(fd: number): void;
        close(fd: number): void;
      },
    ) => void;
    let thrown: unknown;

    try {
      writeWithDirectorySyncRuntime(target, "committed", undefined, {
        platform: "linux",
        open: () => fakeDirectoryFd,
        fsync: () => {
          throw Object.assign(new Error("forced directory fsync failure"), { code: "EIO" });
        },
        close: () => undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "ATOMIC_FILE_DIRECTORY_SYNC_FAILED",
      committed: true,
    });
    expect(isCommittedAtomicWriteError(thrown)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("committed");
    expect(readdirSync(dir)).toEqual(["committed.json"]);
  });

  it("recognises only the Error this module throws as committed", () => {
    // Committed-write failures require Error instances, not arbitrary committed:true objects.
    expect(isCommittedAtomicWriteError({ committed: true })).toBe(false);
    expect(isCommittedAtomicWriteError(Object.assign(new Error("x"), { committed: true }))).toBe(true);
    expect(isCommittedAtomicWriteError(new Error("x"))).toBe(false);
  });

  it("retries transient Windows replacement failures and commits whole bytes", () => {
    const target = join(dir, "windows.json");
    writeFileSync(target, "old", "utf8");
    let attempts = 0;
    const waits: number[] = [];
    const writeWithRuntime = writeUtf8FileAtomicSync as unknown as (
      path: string,
      content: string,
      mode: number | undefined,
      runtime: { platform: NodeJS.Platform; open(path: string): number; fsync(fd: number): void; close(fd: number): void; rename(from: string, to: string): void; wait(ms: number): void },
    ) => void;

    writeWithRuntime(target, "new", undefined, {
      platform: "win32",
      open: () => 0,
      fsync: () => undefined,
      close: () => undefined,
      rename: (from, to) => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("transient"), { code: "EACCES" });
        renameSync(from, to);
      },
      wait: (ms) => waits.push(ms),
    });

    expect(attempts).toBe(3);
    expect(waits).toEqual([transientFsLockDelayMs(1), transientFsLockDelayMs(2)]);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["windows.json"]);
  });

  it.each(["EPERM", "EACCES"])("preserves the Windows target after persistent %s", (code) => {
    const target = join(dir, "windows.json");
    writeFileSync(target, "old", "utf8");
    let attempts = 0;
    const writeWithRuntime = writeUtf8FileAtomicSync as unknown as (
      path: string,
      content: string,
      mode: number | undefined,
      runtime: { platform: NodeJS.Platform; open(path: string): number; fsync(fd: number): void; close(fd: number): void; rename(from: string, to: string): void; wait(ms: number): void },
    ) => void;

    expect(() => writeWithRuntime(target, "new", undefined, {
      platform: "win32",
      open: () => 0,
      fsync: () => undefined,
      close: () => undefined,
      rename: () => {
        attempts += 1;
        throw Object.assign(new Error("persistent"), { code });
      },
      wait: () => undefined,
    })).toThrow("persistent");
    expect(attempts).toBe(SYNC_UI_BLOCKING_ATTEMPTS);
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["windows.json"]);
  });

  it("takes its curve and budget from the shared policy, and so does the async ladder", async () => {
    // Sync and async retries must use the same curve with separate budgets; only synchronous waits block the UI.
    const target = join(dir, "windows.json");
    writeFileSync(target, "old", "utf8");
    const syncWaits: number[] = [];
    const writeWithRuntime = writeUtf8FileAtomicSync as unknown as (
      path: string,
      content: string,
      mode: number | undefined,
      runtime: { platform: NodeJS.Platform; open(path: string): number; fsync(fd: number): void; close(fd: number): void; rename(from: string, to: string): void; wait(ms: number): void },
    ) => void;

    expect(() => writeWithRuntime(target, "new", undefined, {
      platform: "win32",
      open: () => 0,
      fsync: () => undefined,
      close: () => undefined,
      rename: () => {
        throw Object.assign(new Error("locked"), { code: "EBUSY" });
      },
      wait: (ms) => syncWaits.push(ms),
    })).toThrow("locked");

    const asyncWaits: number[] = [];
    await expect(
      retryOnTransientFsLock(
        async () => {
          throw Object.assign(new Error("locked"), { code: "EBUSY" });
        },
        { sleep: async (ms) => { asyncWaits.push(ms); } },
      ),
    ).rejects.toThrow("locked");

    const curveOver = (attempts: number) =>
      Array.from({ length: attempts - 1 }, (_, i) => transientFsLockDelayMs(i + 1));

    expect(syncWaits).toEqual(curveOver(SYNC_UI_BLOCKING_ATTEMPTS));
    expect(asyncWaits).toEqual(curveOver(BACKGROUND_ATTEMPTS));

    const syncTotal = syncWaits.reduce((sum, ms) => sum + ms, 0);
    const asyncTotal = asyncWaits.reduce((sum, ms) => sum + ms, 0);
    expect(syncTotal).toBe(SYNC_UI_BLOCKING_BUDGET_MS);
    expect(asyncTotal).toBe(BACKGROUND_BUDGET_MS);

    // Settings lock contention can outlive lock release; a failed replacement must not silently discard granted permissions.
    expect(syncTotal).toBeGreaterThanOrEqual(1000);
    // Keep synchronous retries well below the OS unresponsive-window threshold.
    expect(syncTotal).toBeLessThanOrEqual(1200);
    expect(syncTotal).toBeLessThan(asyncTotal);
  });
});

describe("isMissingPathError", () => {
  it("treats ENOENT and ENOTDIR as the same absence", () => {
    expect(isMissingPathError(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe(true);
    expect(isMissingPathError(Object.assign(new Error("parent is a file"), { code: "ENOTDIR" }))).toBe(true);
  });

  it("rejects every other error, including ones without a code", () => {
    expect(isMissingPathError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isMissingPathError(Object.assign(new Error("exists"), { code: "EEXIST" }))).toBe(false);
    expect(isMissingPathError(new Error("plain"))).toBe(false);
    expect(isMissingPathError(undefined)).toBe(false);
  });
});

describe("private storage modes", () => {
  it("are the storage-namespace rule: 0o700 directories, 0o600 files", () => {
    expect(PRIVATE_DIR_MODE).toBe(0o700);
    expect(PRIVATE_FILE_MODE).toBe(0o600);
  });
});
