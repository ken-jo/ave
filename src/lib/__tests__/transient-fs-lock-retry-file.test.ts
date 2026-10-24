import { mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { BACKGROUND_ATTEMPTS, renameFile, retryOnFileLock } from "../transient-fs-lock-retry.js";

vi.mock("../../shared/abortable-deadline.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../shared/abortable-deadline.js")>(),
  sleep: async () => {},
}));

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "ave-file-lock-retry-"))); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanupTmpDir(dir);
});

const fail = (code: string) => Object.assign(new Error(code), { code });
const onPlatform = (platform: NodeJS.Platform) => vi.stubGlobal("process", { ...process, platform });

describe("retryOnFileLock", () => {
  it("retries a Windows file lock and returns the eventual result", async () => {
    onPlatform("win32");
    const op = vi.fn().mockRejectedValueOnce(fail("EBUSY")).mockRejectedValueOnce(fail("EPERM")).mockResolvedValue("ok");
    await expect(retryOnFileLock(op)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("stops at the background budget", async () => {
    onPlatform("win32");
    const op = vi.fn().mockRejectedValue(fail("EACCES"));
    await expect(retryOnFileLock(op)).rejects.toMatchObject({ code: "EACCES" });
    expect(op).toHaveBeenCalledTimes(BACKGROUND_ATTEMPTS);
  });

  it.each([
    ["win32", "ENOENT"],
    ["win32", "ENOTEMPTY"],
    ["linux", "EBUSY"],
    ["darwin", "EPERM"],
  ] as const)("fails at once on %s for %s", async (platform, code) => {
    onPlatform(platform);
    const op = vi.fn().mockRejectedValue(fail(code));
    await expect(retryOnFileLock(op)).rejects.toMatchObject({ code });
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe("renameFile", () => {
  it("replaces a link at the destination without writing through it", async (ctx: TestContext) => {
    const outside = join(dir, "outside.txt");
    const from = join(dir, "staged");
    const to = join(dir, "target");
    writeFileSync(outside, "user\n");
    writeFileSync(from, "new\n");
    try { symlinkSync(outside, to); } catch { ctx.skip(); }
    await renameFile(from, to);
    expect(readFileSync(outside, "utf8")).toBe("user\n");
    expect((await lstat(to)).isSymbolicLink()).toBe(false);
    expect(readFileSync(to, "utf8")).toBe("new\n");
    expect(readdirSync(dir).sort()).toEqual(["outside.txt", "target"]);
  });
});
