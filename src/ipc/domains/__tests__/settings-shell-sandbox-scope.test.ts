// windows-permission
import { requiredFixture } from "../../../__tests__/support/required-fixture.js";
import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

// Shell isolation and plugin-worker confinement are independent settings.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService, type AppSettings } from "../../../data/settings-store.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";
import { SECURITY_FEATURE_KEYS } from "../../../shared/security-settings.js";
import { securitySettingsGestures } from "../../security-settings-gesture.js";
import { __resetWindowsSandboxSubstrateForTest, getWindowsSandboxSubstrate,
  setWindowsSandboxSubstrate, setWindowsShellLocalNetworkAccess, bindWindowsShellLocalNetworkAccess } from "../../../permissions/sandbox-capability.js";
import { mxcShellCapability, planWindowsSandbox } from "../../../boot/steps/windows-sandbox-plan.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
}));

let userDataPath: string;
let disposeConsent: (() => void) | undefined;
let stopSettingsListener: (() => void) | undefined;
const USER_INTENT = { inputOrigin: "user-keyboard", userActivation: true };

async function setup() {
  userDataPath = mkdtempSync(join(tmpdir(), "shell-sandbox-scope-ipc-"));
  const settingsService = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
  const frame = { url: "file:///application/dist/index.html" };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame, isDestroyed: () => false, send: vi.fn(),
  });
  const window = { webContents: contents, isDestroyed: () => false };
  const auditLogger = { log: vi.fn(), append: vi.fn(async (_entry: unknown) => {}) };
  const refreshSandboxNetworkConfig = vi.fn(async () => undefined);
  const deps = { settingsService, conversationLoop: { refreshProvider: vi.fn() }, auditLogger,
    getMainWindow: () => window, getAppWindows: () => [window], singleHopNetworkFetch: vi.fn(), refreshSandboxNetworkConfig };
  const { registerSettingsHandlers } = await import("../settings.js");
  const { registerPermissionsHandlers } = await import("../permissions.js");
  stopSettingsListener = registerSettingsHandlers(deps as never);
  registerPermissionsHandlers(deps as never);
  securitySettingsGestures.observe(contents as never);
  const event = { sender: contents, senderFrame: frame };
  const invoke = (channel: string, payload: unknown) => Promise.resolve(requiredFixture(handlers.get(channel))(event, payload));
  const gesture = () => contents.emit("before-mouse-event", {}, { type: "mouseUp" });
  const updateSecurity = async (patch: unknown) => {
    gesture();
    const result = await invoke(PERMISSIONS.updateSecuritySettings, { patch, intent: USER_INTENT });
    if (!(result as { ok?: boolean }).ok && !(result as { error?: string }).error) {
      expect(result).not.toHaveProperty("a2aRemote");
      expect(result).not.toHaveProperty("upstreamProxy");
      expect(result).toHaveProperty("activeChatModel");
    }
    return result;
  };
  return { settingsService, auditLogger, refreshSandboxNetworkConfig, contents, invoke, gesture, updateSecurity };
}

afterEach(async () => {
  handlers.clear();
  disposeConsent?.();
  disposeConsent = undefined;
  stopSettingsListener?.();
  stopSettingsListener = undefined;
  __resetWindowsSandboxSubstrateForTest();
  await cleanupTmpDir(userDataPath);
});

describe("shell sandbox checkbox write", () => {
  it("applies user-confirmed local-network consent after save without changing either confinement scope", async () => {
    const f = await setup();
    disposeConsent = bindWindowsShellLocalNetworkAccess(f.settingsService);
    const { substrate } = planWindowsSandbox({ shellRequested: true, workerRequested: true,
      mxc: { state: "available" }, windowsBuild: null, srtWinReady: false });
    setWindowsSandboxSubstrate(substrate, mxcShellCapability());
    const extensionPlan = getWindowsSandboxSubstrate()?.extensionPlan;
    for (const enabled of [true, false]) {
      await f.updateSecurity({ features: { windowsShellLocalNetworkAccess: enabled } });
      expect(getWindowsSandboxSubstrate()).toMatchObject({ shellLocalNetworkAccess: enabled,
        shells: enabled ? "mxc" : "approved-host" });
      expect(getWindowsSandboxSubstrate()?.extensionPlan).toBe(extensionPlan);
      const reloaded = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
      expect(reloaded.get("features")?.windowsShellLocalNetworkAccess).toBe(enabled);
      expect(reloaded.get("features")?.pluginWorkerConfinement).toBe(false);
    }
    expect(f.refreshSandboxNetworkConfig).toHaveBeenCalledTimes(2);
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
      const f = await setup();
      await f.settingsService.patch({ features: { osToolSandbox: shellBefore, pluginWorkerConfinement: workers } });
      const result = await f.updateSecurity({ features: { osToolSandbox: shellAfter } });
      expect(result).not.toMatchObject({ ok: false });
      expect(f.settingsService.get("features")?.osToolSandbox).toBe(shellAfter);
      expect(f.settingsService.get("features")?.pluginWorkerConfinement).toBe(workers);
      const reread = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
      expect(reread.get("features")?.osToolSandbox).toBe(shellAfter);
      expect(reread.get("features")?.pluginWorkerConfinement).toBe(workers);
    },
  );

  it.each(SECURITY_FEATURE_KEYS)("refuses protected feature %s through generic settings updates", async (key) => {
    const f = await setup();
    const before = f.settingsService.getAll();
    expect(await f.invoke(CHANNELS.settings.update, { features: { [key]: !before.features?.[key] } }))
      .toEqual({ ok: false, error: "security-settings-main-owned" });
    expect(f.settingsService.getAll()).toEqual(before);
    expect(f.refreshSandboxNetworkConfig).not.toHaveBeenCalled();
  });

  it.each([
    [{ system: { localApiServer: true } }, "security-settings-main-owned"],
    [{ pluginConfigs: { extension: { token: "plaintext" } } }, "plugin-config-settings-main-owned"],
  ])("refuses generic writes to separately owned settings %j", async (patch, error) => {
    const f = await setup();
    const before = f.settingsService.getAll();
    expect(await f.invoke(CHANNELS.settings.update, patch)).toEqual({ ok: false, error });
    expect(f.settingsService.getAll()).toEqual(before);
  });

  it("requires both renderer intent and native input before changing confinement", async () => {
    const f = await setup();
    const patch = { features: { osToolSandbox: false } };
    const before = f.settingsService.get("features");
    expect(await f.invoke(PERMISSIONS.updateSecuritySettings, { patch, intent: USER_INTENT }))
      .toMatchObject({ ok: false, error: "user-keyboard-required" });
    f.gesture();
    expect(await f.invoke(PERMISSIONS.updateSecuritySettings, { patch }))
      .toMatchObject({ ok: false, error: "user-keyboard-required" });
    expect(f.settingsService.get("features")).toEqual(before);
    expect(f.refreshSandboxNetworkConfig).not.toHaveBeenCalled();
  });

  it("propagates a settings persistence failure and retains both confinement choices", async () => {
    const f = await setup();
    await f.settingsService.patch({ features: { osToolSandbox: true, pluginWorkerConfinement: true } });
    const save = vi.spyOn(f.settingsService as unknown as { saveSettings(settings: AppSettings): Promise<void> }, "saveSettings");
    save.mockRejectedValueOnce(new Error("Settings storage unavailable"));
    await expect(f.updateSecurity({ features: { osToolSandbox: false } })).rejects.toThrow("Settings storage unavailable");
    expect(f.settingsService.get("features")).toMatchObject({ osToolSandbox: true, pluginWorkerConfinement: true });
    expect(new SettingsService({ userDataPath, encryption: unavailableSecretEncryption }).get("features"))
      .toMatchObject({ osToolSandbox: true, pluginWorkerConfinement: true });
    expect(f.refreshSandboxNetworkConfig).not.toHaveBeenCalled();
    expect(f.auditLogger.append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ input: expect.stringContaining('"phase":"requested"') }));
  });
});
