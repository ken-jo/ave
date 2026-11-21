import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTmpDirTracker } from "./tmp-dir-teardown.js";

const removal = vi.hoisted(() => ({ blocked: undefined as string | undefined }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rm: (path: Parameters<typeof fs.rm>[0], options?: Parameters<typeof fs.rm>[1]) =>
    path === removal.blocked ? Promise.reject(new Error("injected directory removal failure")) : fs.rm(path, options) };
});

it("removes other scratch directories after a removal fails and retains the failed directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "scratch-cleanup-"));
  try {
    const tracker = createTmpDirTracker();
    const blocked = tracker.track(join(root, "blocked"));
    const removable = tracker.track(join(root, "removable"));
    mkdirSync(blocked);
    mkdirSync(removable);
    removal.blocked = blocked;
    await expect(tracker.cleanup()).rejects.toThrow("injected directory removal failure");
    expect(existsSync(removable)).toBe(false);
    expect(existsSync(blocked)).toBe(true);
    removal.blocked = undefined;
    await tracker.cleanup();
    expect(existsSync(blocked)).toBe(false);
  } finally {
    removal.blocked = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});
