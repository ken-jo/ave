import { copyFileSync, existsSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, releaseAsrtSandboxForExit, resetAsrtSandbox } from "../asrt-sandbox.js";
import {
  getSrtWinArchitecture,
  isSrtWinRuntimeReleasePending,
  markSrtWinRuntimeReleased,
  prepareSrtWinExecutable,
  srtWinPrivateDirectories,
} from "../srt-win-integrity.js";

useVerifiedAveHomePrivacy();

// The release-pending lifecycle only: a mocked runtime records whether the private helper copy still exists when its reset runs.
const manager = vi.hoisted(() => ({
  reset: vi.fn<() => Promise<void>>(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: {
  setParentProxyRouter: () => undefined,
  initialize: async () => undefined,
  updateConfig: () => undefined,
  reset: () => manager.reset(),
  wrapWithSandboxArgv: async () => ({
    argv: ["/bin/bash", "-c", "/configured/bwrap --new-session --die-with-parent --unshare-pid --ro-bind / / -- /bin/bash -c true"],
    env: process.env,
  }),
  cleanupAfterCommand: () => undefined,
  openInvocationListener: async () => ({ socketPath: "/configured/proxy.sock" }),
  closeInvocationListener: () => undefined,
} }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  },
}));

const require = createRequire(import.meta.url);
const vendor = join(dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "vendor");
const sourceRoot = mkdtempSync(join(tmpdir(), "ave-asrt-exit-release-"));
const source = join(sourceRoot, "srt-win.exe");
copyFileSync(join(vendor, "srt-win", getSrtWinArchitecture(), "srt-win.exe"), source);
// The runtime is handed this copy at initialize on Windows; preparing it here makes the pending release observable on every platform.
const executable = prepareSrtWinExecutable(source);

afterAll(() => {
  rmSync(sourceRoot, { recursive: true, force: true });
  for (const bin of srtWinPrivateDirectories()) {
    for (const name of ["srt-win.exe", "owner.json"]) rmSync(join(bin, name), { force: true });
    if (existsSync(bin)) rmdirSync(bin);
    if (existsSync(dirname(bin))) rmdirSync(dirname(bin));
  }
});

describe("sandbox runtime release at exit", () => {
  const originalPlatform = process.platform;
  beforeEach(async () => {
    setProcessPlatform("linux");
    manager.reset.mockReset().mockImplementation(async () => {
      expect(existsSync(executable)).toBe(true);
    });
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
  });
  afterEach(async () => {
    try {
      if (isAsrtSandboxActive()) await resetAsrtSandbox();
    } finally {
      markSrtWinRuntimeReleased();
      setProcessPlatform(originalPlatform);
    }
  });

  it("marks the copy's release pending from initialize until the quit sequence's reset finishes", async () => {
    expect(isSrtWinRuntimeReleasePending()).toBe(true);
    await releaseAsrtSandboxForExit();
    expect(manager.reset).toHaveBeenCalledOnce();
    expect(isAsrtSandboxActive()).toBe(false);
    expect(isSrtWinRuntimeReleasePending()).toBe(false);
  });

  it("keeps the release pending when the reset fails, so the copy outlives the exit handler", async () => {
    manager.reset.mockRejectedValueOnce(new Error("srt-win acl: release failed"));
    await expect(releaseAsrtSandboxForExit()).rejects.toThrow("srt-win acl: release failed");
    expect(isSrtWinRuntimeReleasePending()).toBe(true);
  });

  it("does nothing once the runtime is already reset", async () => {
    await resetAsrtSandbox();
    manager.reset.mockClear();
    await releaseAsrtSandboxForExit();
    expect(manager.reset).not.toHaveBeenCalled();
  });
});
