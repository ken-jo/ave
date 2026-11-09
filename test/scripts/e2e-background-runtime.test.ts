import { beforeEach, describe, expect, it, vi } from "vitest";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { setProcessPlatform } from "../../src/__tests__/support/process-platform.js";

const io = vi.hoisted(() => ({ cpSync: vi.fn(), mkdtempSync: vi.fn(), rmSync: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), cpSync: io.cpSync, mkdtempSync: io.mkdtempSync, rmSync: io.rmSync }));
vi.mock("node:child_process", () => ({ execFileSync: io.execFileSync }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  io.cpSync.mockReset();
  io.execFileSync.mockReset();
});

async function onPlatform(platform: NodeJS.Platform, run: () => Promise<void>) {
  const original = process.platform;
  setProcessPlatform(platform);
  try { await run(); } finally { setProcessPlatform(original); }
}

describe("test runtime bundle isolation", () => {
  it.each(["linux", "win32"] as const)("leaves %s launches unchanged", async (platform) => {
    await onPlatform(platform, async () => {
      const { resolveE2eExecutable } = await import("../e2e/ui/background-electron.js");
      expect(resolveE2eExecutable({})).toBeUndefined();
      expect(io.cpSync).not.toHaveBeenCalled();
    });
  });

  it("preserves explicit executables and the native focus fixture runtime", async () => {
    await onPlatform("darwin", async () => {
      const { resolveE2eExecutable } = await import("../e2e/ui/background-electron.js");
      expect(resolveE2eExecutable({ executablePath: "/applications/shipped-app" })).toBe("/applications/shipped-app");
      expect(resolveE2eExecutable({ env: { AVE_NATIVE_FIXTURE_MODE: "foreground" } })).toBeUndefined();
      expect(io.cpSync).not.toHaveBeenCalled();
    });
  });

  it("changes only a temporary copy, reuses it and cleans it at worker exit", async () => {
    await onPlatform("darwin", async () => {
      const source = createRequire(import.meta.url)("electron") as string;
      const root = join(tmpdir(), "ave-e2e-background-unit");
      io.mkdtempSync.mockReturnValue(root);
      const once = vi.spyOn(process, "once");
      try {
        const { resolveE2eExecutable } = await import("../e2e/ui/background-electron.js");
        const executable = resolveE2eExecutable({});
        expect(executable).toBe(join(root, "Electron.app", "Contents", "MacOS", basename(source)));
        expect(resolveE2eExecutable({})).toBe(executable);
        expect(io.cpSync).toHaveBeenCalledTimes(1);
        expect(io.cpSync).toHaveBeenCalledWith(dirname(dirname(dirname(source))), join(root, "Electron.app"), expect.objectContaining({ recursive: true }));
        expect(io.execFileSync.mock.calls).toEqual([
          ["/usr/bin/plutil", ["-replace", "LSUIElement", "-bool", "YES", join(root, "Electron.app", "Contents", "Info.plist")]],
        ]);
        const cleanup = once.mock.calls.find(([event]) => event === "exit")?.[1];
        if (!cleanup) throw new Error("Runtime cleanup is missing");
        cleanup(0);
        expect(io.rmSync).toHaveBeenCalledWith(root, { recursive: true, force: true });
      } finally { once.mockRestore(); }
    });
  });

  it("removes an incomplete copy and refuses launch when metadata preparation fails", async () => {
    await onPlatform("darwin", async () => {
      const root = join(tmpdir(), "ave-e2e-background-incomplete");
      io.mkdtempSync.mockReturnValue(root);
      io.execFileSync.mockImplementation(() => { throw new Error("metadata write failed"); });
      const { resolveE2eExecutable } = await import("../e2e/ui/background-electron.js");
      expect(() => resolveE2eExecutable({})).toThrow("metadata write failed");
      expect(io.rmSync).toHaveBeenCalledWith(root, { recursive: true, force: true });
    });
  });
});
