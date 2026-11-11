import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

// Shell isolation and plugin-worker confinement are independent settings.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../../../data/settings-store.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { makeAppIpcInvoker } from "./test-helpers.js";
import { __resetWindowsSandboxSubstrateForTest, getWindowsSandboxSubstrate,
  setWindowsSandboxSubstrate, setWindowsShellLocalNetworkAccess, bindWindowsShellLocalNetworkAccess } from "../../../permissions/sandbox-capability.js";
import { mxcShellCapability, planWindowsSandbox } from "../../../boot/steps/windows-sandbox-plan.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
}));

const invoke = makeAppIpcInvoker(handlers);
let userDataPath: string;
let disposeConsent: (() => void) | undefined;

afterEach(async () => {
  handlers.clear();
  disposeConsent?.();
  disposeConsent = undefined;
  __resetWindowsSandboxSubstrateForTest();
  await cleanupTmpDir(userDataPath);
});

describe("shell sandbox checkbox write", () => {
  it("applies local-network consent after save without changing either confinement scope", async () => {
    userDataPath = mkdtempSync(join(tmpdir(), "shell-network-scope-ipc-"));
    const settingsService = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
    disposeConsent = bindWindowsShellLocalNetworkAccess(settingsService);
    const { substrate } = planWindowsSandbox({ shellRequested: true, workerRequested: true,
      mxc: { state: "available" }, windowsBuild: null, srtWinReady: false });
    setWindowsSandboxSubstrate(substrate, mxcShellCapability());
    const extensionPlan = getWindowsSandboxSubstrate()?.extensionPlan;
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers({ settingsService, conversationLoop: { refreshProvider: vi.fn() },
      auditLogger: { log: vi.fn() }, getAppWindows: () => [], singleHopNetworkFetch: vi.fn() } as never);
    for (const enabled of [true, false]) {
      await invoke(CHANNELS.settings.update, { features: { windowsShellLocalNetworkAccess: enabled } });
      expect(getWindowsSandboxSubstrate()).toMatchObject({ shellLocalNetworkAccess: enabled,
        shells: enabled ? "mxc" : "approved-host" });
      expect(getWindowsSandboxSubstrate()?.extensionPlan).toBe(extensionPlan);
      const reloaded = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
      expect(reloaded.get("features")?.windowsShellLocalNetworkAccess).toBe(enabled);
      expect(reloaded.get("features")?.pluginWorkerConfinement).toBe(false);
    }
    setWindowsShellLocalNetworkAccess(false);
  });

  it.each([
    [false, true, true],
    [true, false, true],
    [false, true, false],
    [true, false, false],
  ])(
    "osToolSandbox %s -> %s leaves pluginWorkerConfinement=%s untouched",
    async (shellBefore, shellAfter, workers) => {
      userDataPath = mkdtempSync(join(tmpdir(), "shell-sandbox-scope-ipc-"));
      const settingsService = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
      await settingsService.patch({ features: { osToolSandbox: shellBefore, pluginWorkerConfinement: workers } });
      const { registerSettingsHandlers } = await import("../settings.js");
      registerSettingsHandlers({
        settingsService,
        conversationLoop: { refreshProvider: vi.fn() },
        auditLogger: { log: vi.fn() },
        getAppWindows: () => [],
        singleHopNetworkFetch: vi.fn(),
      } as never);

      const result = await invoke(CHANNELS.settings.update, { features: { osToolSandbox: shellAfter } });

      expect(result).not.toMatchObject({ ok: false });
      expect(settingsService.get("features")?.osToolSandbox).toBe(shellAfter);
      expect(settingsService.get("features")?.pluginWorkerConfinement).toBe(workers);
      const reread = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
      expect(reread.get("features")?.osToolSandbox).toBe(shellAfter);
      expect(reread.get("features")?.pluginWorkerConfinement).toBe(workers);
    },
  );
});
