import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { useLinuxWrapperProgramFixtures } from "../../__tests__/support/linux-wrapper-programs.js";
// The real patched manager module (the mock above replaces only the package entry): its reset() releases a seam-provided ACL session.
import { SandboxManager as RealSandboxManager, setWindowsAclReleaseForTesting } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js";
import { recoverWindowsAcl } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, releaseAsrtSandboxForExit, resetAsrtSandbox } from "../asrt-sandbox.js";
import { aveHome } from "../../shared/ave-home.js";
import {
  getSrtWinArchitecture,
  isSrtWinRuntimeReleasePending,
  markSrtWinRuntimeReleased,
  prepareSrtWinExecutable,
} from "../srt-win-integrity.js";

useVerifiedAveHomePrivacy();
useLinuxWrapperProgramFixtures();

// The release-pending lifecycle only: a mocked runtime records whether the private helper copy still exists when its reset runs.
const manager = vi.hoisted(() => ({
  reset: vi.fn<() => Promise<unknown>>(),
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

describe("sandbox runtime release at exit", () => {
  const originalPlatform = process.platform;
  let sourceRoot: string | undefined;
  let executable: string;
  beforeAll(() => {
    const require = createRequire(import.meta.url);
    const vendor = join(dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "vendor");
    sourceRoot = mkdtempSync(join(tmpdir(), "ave-asrt-exit-release-"));
    const source = join(sourceRoot, "srt-win.exe");
    copyFileSync(join(vendor, "srt-win", getSrtWinArchitecture(), "srt-win.exe"), source);
    // A real private copy makes the pending release observable on every platform.
    executable = prepareSrtWinExecutable(source);
  });
  afterAll(() => {
    if (sourceRoot !== undefined) rmSync(sourceRoot, { recursive: true, force: true });
  });
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

  const MALFORMED_ROWS = [{ step: "grant revoke", status: "missing", count: 1, targets: null }];
  const WELL_FORMED_ROWS = [{ step: "grant revoke", status: "missing", count: 1, targets: [String.raw`D:\example\gone`] }];
  // Either the rows cannot be read, or the log sink throws (and throws again for the fallback warning).
  const LOGGING_FAULTS = [
    ["malformed rows", MALFORMED_ROWS, () => undefined],
    ["a throwing log sink", WELL_FORMED_ROWS, () => { throw new Error("log sink failed"); }],
  ] as const;

  it.each(LOGGING_FAULTS)("rejects with the reset's own error when its rows meet %s", async (_name, rows, sink) => {
    const failure = Object.assign(new Error("srt-win acl: release failed"), { windowsAclUnreleased: rows });
    manager.reset.mockRejectedValueOnce(failure);
    const warn = vi.spyOn(console, "warn").mockImplementation(sink);
    try {
      await expect(resetAsrtSandbox()).rejects.toBe(failure);
      expect(warn.mock.calls.flat().map(String).join("\n")).toContain("the dropped ACE rows could not be logged");
      expect(isSrtWinRuntimeReleasePending()).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(LOGGING_FAULTS)("finishes a successful reset and marks its release when its rows meet %s", async (_name, rows, sink) => {
    manager.reset.mockResolvedValueOnce({ windowsAclUnreleased: rows });
    const warn = vi.spyOn(console, "warn").mockImplementation(sink);
    try {
      await expect(resetAsrtSandbox()).resolves.toBeUndefined();
      expect(warn.mock.calls.flat().map(String).join("\n")).toContain("the dropped ACE rows could not be logged");
      expect(isSrtWinRuntimeReleasePending()).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(LOGGING_FAULTS)("marks a failed initialization's release when its successful reset's rows meet %s", async (_name, rows, sink) => {
    await resetAsrtSandbox();
    manager.initialize.mockRejectedValueOnce(new Error("runtime probe failed"));
    manager.reset.mockResolvedValueOnce({ windowsAclUnreleased: rows });
    const warn = vi.spyOn(console, "warn").mockImplementation(sink);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true })).rejects.toThrow("runtime probe failed");
      expect(warn.mock.calls.flat().map(String).join("\n")).toContain("the dropped ACE rows could not be logged");
      expect(isSrtWinRuntimeReleasePending()).toBe(false);
      expect(error.mock.calls.flat().map(String).join("\n")).not.toContain("sandbox runtime reset failed");
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("keeps a failed initialization's own error when the reset failure's log throws", async () => {
    await resetAsrtSandbox();
    manager.initialize.mockRejectedValueOnce(new Error("runtime probe failed"));
    manager.reset.mockRejectedValueOnce(new Error("srt-win acl: release failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("log sink failed"); });
    try {
      await expect(initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true })).rejects.toThrow("runtime probe failed");
      expect(isSrtWinRuntimeReleasePending()).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it("fails the quit release when the runtime could not run its ACL revoke, and keeps the copy for a retry", async () => {
    const revoke = vi.fn(() => undefined);
    setWindowsAclReleaseForTesting({ sandboxUserSid: "S-1-5-21-1", srtWin: executable, revoke, restore: () => [] });
    manager.reset.mockImplementation(() => RealSandboxManager.reset());
    await expect(releaseAsrtSandboxForExit()).rejects.toMatchObject({
      code: "acl_release_failed", message: "Windows sandbox ACL release incomplete: grant revoke did not run",
    });
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ sandboxUserSid: "S-1-5-21-1", srtWin: executable }));
    expect(isAsrtSandboxActive()).toBe(false);
    // Still pending, so the copy's exit handler keeps the image for the runtime's own exit-time retry.
    expect(isSrtWinRuntimeReleasePending()).toBe(true);
    expect(existsSync(executable)).toBe(true);
  });

  it("logs stable redacted target keys for every dropped release row", async () => {
    vi.stubEnv("HOME", "D:\\Users\\alice");
    vi.stubEnv("USERPROFILE", "D:\\Users\\alice");
    const dropped = (status: string, path: string) => ({ path, status });
    const appTarget = join(aveHome(), "settings.json");
    setWindowsAclReleaseForTesting({
      sandboxUserSid: "S-1-5-21-1", srtWin: executable,
      revoke: ({ onExit }) => { onExit(true); return [dropped("missing", appTarget), dropped("revoked", "unused")]; },
      restore: ({ onExit }) => { onExit(true); return [
        dropped("mismatch", appTarget.toUpperCase().replace(/\\/g, "/")),
        dropped("mismatch", "D:\\Users\\alice\\.config\\ave\\hooks"),
        dropped("mismatch", "d:/USERS/ALICE/.config/ave/hooks"),
        dropped("mismatch", "D:\\unknown\\alice\\private-target"),
        dropped("mismatch", "d:/UNKNOWN/ALICE/private-target"),
      ]; },
    });
    manager.reset.mockImplementation(() => RealSandboxManager.reset());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await releaseAsrtSandboxForExit();
      expect(isSrtWinRuntimeReleasePending()).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Windows ACE rows dropped without release (%s)"),
        expect.stringMatching(/^grant revoke missing x1 \[<ave-home>\\settings\.json\], deny restore mismatch x5 \[<ave-home>\\settings\.json \(per-file floor; identity changed\),<home>\\\.config\\ave\\hooks,<home>\\\.config\\ave\\hooks,(<outside-home>:[a-f0-9]{24}),\1\]$/));
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("private-target");
      expect(logged.toLowerCase()).not.toContain("alice");
      for (const args of warn.mock.calls) {
        for (const argument of args) expect(String(argument)).not.toContain(aveHome());
      }
      expect(logged).toContain("may remain on earlier aside copies or targets of dropped rows");
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["settings.json", " (per-file floor; identity changed)"],
    ["permissions.json", " (per-file floor; identity changed)"],
    ["policy.json", " (per-file floor; identity changed)"],
    ["ave-secrets.json", " (per-file floor; identity changed)"],
    ["mcp/servers.json", " (per-file floor; identity changed)"],
    ["AGENTS.md", " (per-file floor; identity changed)"],
    ["settings.json.other", ""],
    ["config", ""],
  ])("labels the per-file floor row for %s without changing release outcomes", async (name, label) => {
    const target = join(aveHome(), ...name.split("/"));
    const restore = vi.fn(({ onExit }: { onExit?: (ok: boolean) => void }) => {
      onExit?.(true);
      return [{ path: target, status: "mismatch" }];
    });
    setWindowsAclReleaseForTesting({
      sandboxUserSid: "S-1-5-21-1", srtWin: executable,
      revoke: ({ onExit }) => { onExit(true); return []; }, restore,
    });
    manager.reset.mockImplementation(() => RealSandboxManager.reset());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await releaseAsrtSandboxForExit();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("an explicit ACE may remain on earlier aside copies or targets of dropped rows"),
        `deny restore mismatch x1 [<ave-home>\\${name.replace(/\//g, "\\").toLowerCase()}${label}]`,
      );
      expect(restore).toHaveBeenCalledOnce();
      await RealSandboxManager.reset();
      expect(restore).toHaveBeenCalledOnce();
      expect(isSrtWinRuntimeReleasePending()).toBe(false);
    } finally { warn.mockRestore(); }
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

describe("Windows ACL crash recovery at initialize", () => {
  const originalPlatform = process.platform;
  const stubs: string[] = [];
  afterEach(async () => {
    try {
      if (isAsrtSandboxActive()) await resetAsrtSandbox();
    } finally {
      markSrtWinRuntimeReleased();
      setProcessPlatform(originalPlatform);
      for (const dir of stubs.splice(0)) rmSync(dir, { recursive: true, force: true });
    }
  });

  // The runtime's initialize runs `srt-win acl recover --json` (carried patch part 13); a stand-in prints the planned counts.
  async function recoverWith(counts: { deadBrokers: number; acesRevoked: number }) {
    setProcessPlatform("linux");
    manager.reset.mockReset().mockResolvedValue(undefined);
    manager.initialize.mockReset().mockResolvedValue(undefined);
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    const dir = mkdtempSync(join(tmpdir(), "ave-srt-win-stub-"));
    stubs.push(dir);
    const script = join(dir, "srt-win.mjs");
    writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(counts))});`);
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      recoverWindowsAcl({ srtWin: { exe: process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, prependArgs: [script] } as never });
      return { info: [...info.mock.calls], warn: [...warn.mock.calls] };
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  }

  it("logs what a previous session left behind at INFO, and warns when ACEs had to be revoked", async () => {
    const { info, warn } = await recoverWith({ deadBrokers: 1, acesRevoked: 6 });
    expect(info).toContainEqual([expect.stringContaining("Windows sandbox ACL recovery: pruned %d dead holder(s), revoked %d orphan ACE(s)"), 1, 6]);
    expect(warn).toContainEqual([expect.stringContaining("Windows sandbox ACLs left behind by a previous session were revoked (%d ACE(s))"), 6]);
  });

  it("says nothing when recovery found nothing", async () => {
    const { info, warn } = await recoverWith({ deadBrokers: 0, acesRevoked: 0 });
    expect(JSON.stringify(info)).not.toContain("ACL recovery");
    expect(JSON.stringify(warn)).not.toContain("left behind");
  });
});
