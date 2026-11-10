vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));
vi.mock("../../shared/policy-home.js", async original => {
  return {
    ...(await original<typeof import("../../shared/policy-home.js")>()),
    policyHomeAnchors: () => {
      const home = process.env.AVE_TEST_RUN_HOME;
      if (home === undefined) throw new Error("Isolated test home is unavailable");
      return [home];
    },
  };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { useVerifiedAveHomePrivacy as installVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { configureHostResources } from "../../main/host-resources.js";
import { setPluginWorkerConfinementRequestedAtBoot, __resetSandboxRequestedAtBootForTest } from "../sandbox-capability.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, isOfflineProcessConfinementActive, isPluginWorkerConfinementActive, resetAsrtSandbox } from "../asrt-sandbox.js";

const manager = vi.hoisted(() => ({
  initialize: vi.fn(async () => undefined),
  initializeWindowsIsolation: vi.fn<() => Promise<void>>(),
  reset: vi.fn(async () => undefined),
  setParentProxyRouter: vi.fn(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", async original => ({
  ...(await original<typeof import("@anthropic-ai/sandbox-runtime")>()),
  SandboxManager: manager,
}));
vi.mock("../srt-win-integrity.js", async original => ({
  ...(await original<typeof import("../srt-win-integrity.js")>()),
  prepareSrtWinExecutable: (path: string) => path,
}));

installVerifiedAveHomePrivacy();
const ORIGINAL_PLATFORM = process.platform;
let succeed: () => void;
let fail: (error: Error) => void;

beforeEach(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  setProcessPlatform("win32");
  setPluginWorkerConfinementRequestedAtBoot(true);
  manager.initializeWindowsIsolation.mockImplementation(() => new Promise<void>((resolve, reject) => {
    succeed = resolve;
    fail = reject;
  }));
});

afterEach(async () => {
  await resetAsrtSandbox();
  __resetSandboxRequestedAtBootForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

describe("background session isolation", () => {
  it("keeps both full-isolation gates closed until a late success", async () => {
    const initialization = await initializeAsrtSandbox({ windows: { backgroundInitialization: true } });
    expect(initialization.isCurrent()).toBe(true);
    expect(manager.initialize).toHaveBeenCalledWith(expect.objectContaining({
      windows: expect.objectContaining({ externalConfinement: "embedder" }),
    }), undefined, false);
    expect(manager.initializeWindowsIsolation).toHaveBeenCalledOnce();
    expect(isAsrtSandboxActive()).toBe(true);
    expect(isPluginWorkerConfinementActive()).toBe(false);
    expect(isOfflineProcessConfinementActive()).toBe(false);

    succeed();
    await expect(initialization.windowsIsolation).resolves.toEqual({ status: "ready" });
    expect(isPluginWorkerConfinementActive()).toBe(true);
    expect(isOfflineProcessConfinementActive()).toBe(true);
    expect(manager.reset).not.toHaveBeenCalled();
  });

  it("keeps both full-isolation gates closed after failure", async () => {
    const initialization = await initializeAsrtSandbox({ windows: { backgroundInitialization: true } });
    const error = new Error("session stamp failed");
    fail(error);
    await expect(initialization.windowsIsolation).resolves.toEqual({ status: "failed", error });
    expect(isAsrtSandboxActive()).toBe(true);
    expect(isPluginWorkerConfinementActive()).toBe(false);
    expect(isOfflineProcessConfinementActive()).toBe(false);
    expect(manager.reset).not.toHaveBeenCalled();
  });

  it("cannot reactivate either gate when a stamp settles after reset", async () => {
    const initialization = await initializeAsrtSandbox({ windows: { backgroundInitialization: true } });
    await resetAsrtSandbox();
    expect(initialization.isCurrent()).toBe(false);
    succeed();
    await expect(initialization.windowsIsolation).resolves.toEqual({ status: "cancelled" });
    expect(isAsrtSandboxActive()).toBe(false);
    expect(isPluginWorkerConfinementActive()).toBe(false);
    expect(isOfflineProcessConfinementActive()).toBe(false);
  });
});
