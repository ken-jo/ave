import { copyFileSync, existsSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
// The real patched manager module (the mock above replaces only the package entry): its reset() releases a seam-provided ACL session.
import { SandboxManager as RealSandboxManager, setWindowsAclReleaseForTesting } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js";
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
  initialize: vi.fn<() => Promise<void>>(async () => undefined),
  setSignalCleanupOwnedByHost: vi.fn<(owned: boolean) => void>(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: {
  setParentProxyRouter: () => undefined,
  initialize: () => manager.initialize(),
  setSignalCleanupOwnedByHost: (owned: boolean) => manager.setSignalCleanupOwnedByHost(owned),
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
// The host's signal claim (asrt-signal-ownership.test.ts covers the module itself).
const signalClaim = vi.hoisted(() => ({ claimed: false }));
vi.mock("../asrt-signal-ownership.js", () => ({ readAsrtSignalReleaseClaim: () => signalClaim.claimed }));
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
      setWindowsAclReleaseForTesting(undefined);
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

  it("fails the quit release when the runtime could not run its ACL revoke, and keeps the copy for a retry", async () => {
    const revoke = vi.fn(() => undefined);
    setWindowsAclReleaseForTesting({ sandboxUserSid: "S-1-5-21-1", srtWin: executable, revoke, restore: () => [] });
    manager.reset.mockImplementation(() => RealSandboxManager.reset());
    await expect(releaseAsrtSandboxForExit()).rejects.toMatchObject({
      code: "acl_release_failed", message: "Windows sandbox ACL release incomplete: grant revoke did not run",
    });
    expect(revoke).toHaveBeenCalledWith({ sandboxUserSid: "S-1-5-21-1", srtWin: executable });
    expect(isAsrtSandboxActive()).toBe(false);
    // Still pending, so the copy's exit handler keeps the image for the runtime's own exit-time retry.
    expect(isSrtWinRuntimeReleasePending()).toBe(true);
    expect(existsSync(executable)).toBe(true);
  });

  it("does nothing once the runtime is already reset", async () => {
    await resetAsrtSandbox();
    manager.reset.mockClear();
    await releaseAsrtSandboxForExit();
    expect(manager.reset).not.toHaveBeenCalled();
  });
});

describe("signal release owned by the host", () => {
  const originalPlatform = process.platform;
  afterEach(async () => {
    try {
      if (isAsrtSandboxActive()) await resetAsrtSandbox();
    } finally {
      markSrtWinRuntimeReleased();
      setProcessPlatform(originalPlatform);
    }
  });

  it("tells the runtime before it initializes that the host's signal handling releases it", async () => {
    setProcessPlatform("linux");
    manager.reset.mockReset().mockResolvedValue(undefined);
    manager.setSignalCleanupOwnedByHost.mockClear();
    const order: string[] = [];
    manager.setSignalCleanupOwnedByHost.mockImplementation(() => { order.push("owned"); });
    manager.initialize.mockImplementation(async () => { order.push("initialize"); });
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    expect(manager.setSignalCleanupOwnedByHost).not.toHaveBeenCalled();
    await resetAsrtSandbox();
    order.length = 0;
    signalClaim.claimed = true;
    try {
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    } finally {
      signalClaim.claimed = false;
    }
    expect(manager.setSignalCleanupOwnedByHost).toHaveBeenCalledWith(true);
    expect(order).toEqual(["owned", "initialize"]);
  });
});
