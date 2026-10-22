import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { ensureAveHomePrivate, setAveHomePrivacyAtBoot, _resetAveHomePrivacyForTest } from "../../shared/ave-home.js";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox, wrapWorkerCommand, grantWindowsWorkerFilesystemAccess } from "../asrt-sandbox.js";
import { readAsrtWindowsStatus } from "../asrt-windows-support.js";

const runtime = vi.hoisted(() => ({ initialize: vi.fn(), wrap: vi.fn() }));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: runtime.initialize,
    wrapWithSandboxArgv: runtime.wrap,
    reset: vi.fn(),
    setParentProxyRouter: vi.fn(),
    getProxyPort: () => undefined,
    getSocksProxyPort: () => undefined,
  },
}));

const ORIGINAL_PLATFORM = process.platform;
const OWNER_SID = "S-1-5-21-100-200-300-1001";
const OWNER_DACL = `D:P(A;OICI;FA;;;${OWNER_SID})`;
const home = useTempPaths("ave-home-confinement-", ".ave");

afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  _resetAveHomePrivacyForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

describe("private-directory confinement gate", () => {
  it.each(["home-command", "home-read", "secrets-command", "secrets-read"])("refuses %s failure and publishes the failed path to the UI", async (failure) => {
    setProcessPlatform("win32");
    const dir = home();
    const path = failure.startsWith("secrets") ? join(dir, "secrets") : dir;
    const privacy = ensureAveHomePrivate(dir, {
      platform: "win32",
      run: (file, args) => {
        if (file.endsWith("whoami.exe")) return `"example","${OWNER_SID}"`;
        if (args[0] === path && failure.endsWith("command")) throw new Error("command failed");
        return "";
      },
      readDacl: (target) => {
        if (target === path && failure.endsWith("read")) throw new Error("read failed");
        return OWNER_DACL;
      },
    });
    expect(privacy.enforcement).toBe("none");
    setAveHomePrivacyAtBoot(privacy);
    await expect(initializeAsrtSandbox({ allowedDomains: [] })).rejects.toThrow(path);
    expect(isAsrtSandboxActive()).toBe(false);
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(await readAsrtWindowsStatus()).toMatchObject({ ready: false, homePrivacyError: { path } });
  });

  it("allows proxy-only initialization but refuses extension wraps and ACL grants after protection fails", async () => {
    setProcessPlatform("win32");
    const path = home();
    setAveHomePrivacyAtBoot({ enforcement: "none", home: path, reason: "DACL mismatch" });
    await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true } });
    expect(isAsrtSandboxActive()).toBe(true);
    await expect(wrapWorkerCommand("echo denied", { commandId: "private-directory-test" })).rejects.toThrow(path);
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowRead: [path] })).rejects.toThrow(path);
    expect(runtime.wrap).not.toHaveBeenCalled();
  });

  it("does not impose the Windows privacy gate on POSIX confinement", async () => {
    setProcessPlatform("darwin");
    setAveHomePrivacyAtBoot({ enforcement: "none", home: home(), reason: "fixture" });
    await initializeAsrtSandbox({ allowedDomains: [] });
    expect(isAsrtSandboxActive()).toBe(true);
    expect(await readAsrtWindowsStatus()).toMatchObject({ applicable: false });
  });
});
