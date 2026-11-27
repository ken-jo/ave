import { collectPermissionEvents } from "../../../__tests__/support/permission-events.js";

vi.mock("../../../shared/windows-path-facts.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../../shared/windows-configuration-handles.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { requiredFixture } from "../../../__tests__/support/required-fixture.js";
import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

// Shell isolation and plugin-worker confinement are independent settings.
import { afterEach, describe, expect, it, vi, onTestFinished } from "vitest";
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
import * as backgroundFeatures from "../../../permissions/windows-background-features.js";
import { securitySettingsGestures } from "../../security-settings-gesture.js";
import { __resetSandboxHomesUnavailableForTest, __resetWindowsSandboxSubstrateForTest, getSandboxHomesUnavailable } from "../../../permissions/sandbox-capability.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
}));

const NO_ACCOUNT = { errors: [] as string[], warnings: [] as string[], accountBackendAbsent: true as const };
const NO_CONTAINER = { state: "unavailable", reason: "container-unavailable", windowsBuild: null, detail: "", baseContainerApiPresent: false, containerBackendAbsent: true };
const backgroundState = vi.hoisted(() => ({
  release: false, noBackend: false, homeLost: false,
  accountInventory: vi.fn(async (): Promise<object> => ({})),
  containerInventory: vi.fn(async (): Promise<object> => ({})),
  substrate: { shells: "none", srtWinReady: false, accountBackendAbsent: true,
    mxc: { state: "unavailable", reason: "container-unavailable", containerBackendAbsent: true } },
  plan: { selectedBackend: "none", readiness: "unavailable", reason: "container-unavailable" },
}));
// The backend inventories are native queries; this file answers them itself.
vi.mock("../../../permissions/asrt-sandbox.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../permissions/asrt-sandbox.js")>(),
  checkAsrtDependencies: backgroundState.accountInventory,
  isWindowsAccountConfinementOperational: async () => false,
}));
vi.mock("../../../permissions/mxc-windows.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../permissions/mxc-windows.js")>(),
  detectHostMxcPrerequisites: backgroundState.containerInventory,
}));
vi.mock("../../../permissions/mxc-runtime-root.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../permissions/mxc-runtime-root.js")>(),
  mxcSandboxHomesParent: () => {
    if (backgroundState.homeLost) throw new Error("HOME parent changed identity");
    return "C:/example/ave-runtime/homes";
  },
}));
vi.mock("../../../permissions/mxc-extension-admission.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../permissions/mxc-extension-admission.js")>(),
  hasMxcReleaseGateEvidence: () => backgroundState.release,
}));
vi.mock("../../../permissions/sandbox-capability.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../permissions/sandbox-capability.js")>(),
  getWindowsSandboxSubstrate: () => backgroundState.noBackend ? backgroundState.substrate : null,
  getWindowsExtensionBackendPlan: () => backgroundState.noBackend ? backgroundState.plan : undefined,
}));
vi.mock("../../../shared/ave-home.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../shared/ave-home.js")>(),
  isAveHomePrivacyVerifiedAtBoot: () => true,
}));

let userDataPath: string;
let stopSettingsListener: (() => void) | undefined;
const USER_INTENT = { inputOrigin: "user-keyboard", userActivation: true };

async function setup() {
  backgroundState.accountInventory.mockReset().mockResolvedValue(NO_ACCOUNT);
  backgroundState.containerInventory.mockReset().mockResolvedValue(NO_CONTAINER);
  userDataPath = mkdtempSync(join(tmpdir(), "shell-sandbox-scope-ipc-"));
  const settingsService = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
  const frame = { url: "file:///application/dist/index.html" };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame, isDestroyed: () => false, send: vi.fn(),
  });
  const window = { webContents: contents, isDestroyed: () => false };

  const refreshSandboxNetworkConfig = vi.fn(async () => undefined);
  const deps = { settingsService, conversationLoop: { refreshProvider: vi.fn() }, getMainWindow: () => window, getAppWindows: () => [window], singleHopNetworkFetch: vi.fn(), refreshSandboxNetworkConfig };
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
  return { settingsService, refreshSandboxNetworkConfig, contents, invoke, gesture, updateSecurity };
}

afterEach(async () => {
  handlers.clear();
  stopSettingsListener?.();
  stopSettingsListener = undefined;
  __resetWindowsSandboxSubstrateForTest();
  __resetSandboxHomesUnavailableForTest();
  await cleanupTmpDir(userDataPath);
});

describe("session search indexing settings", () => {
  it("does not refresh Windows admission for a POSIX snapshot or a crafted switch patch", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    const f = await setup();
    const refresh = vi.spyOn(backgroundFeatures, "refreshWindowsBackgroundAdmission");
    try {
      Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
      await expect(f.invoke(CHANNELS.settings.get, undefined)).resolves.not.toHaveProperty("features.sessionIndexingWithoutContainment");
      const result = await f.invoke(CHANNELS.settings.update, {
        features: { sessionIndexingWithoutContainment: false, idlePreferenceRefresh: true },
      });
      expect.soft(result).toHaveProperty("features.idlePreferenceRefresh", true);
      expect.soft(result).not.toHaveProperty("features.sessionIndexingWithoutContainment");
      expect.soft(f.settingsService.get("features")?.idlePreferenceRefresh).toBe(true);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
      if (original) Object.defineProperty(process, "platform", original);
    }
  });

  it.each(["projection", "write"] as const)("rechecks HOME identity before the first settings %s after loss", async (operation) => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    const f = await setup();
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    backgroundState.noBackend = backgroundState.release = true;
    try {
      await expect(f.invoke(CHANNELS.settings.get, undefined)).resolves.toHaveProperty("features.sessionIndexingWithoutContainment", true);
      await f.settingsService.patch({ features: { sessionIndexingWithoutContainment: true } });
      backgroundState.homeLost = true;
      expect(getSandboxHomesUnavailable()).toBe(false);
      if (operation === "projection") {
        await expect(f.invoke(CHANNELS.settings.get, undefined)).resolves.not.toHaveProperty("features.sessionIndexingWithoutContainment");
      } else {
        await expect(f.invoke(CHANNELS.settings.update, { features: { sessionIndexingWithoutContainment: false } }))
          .resolves.toEqual({ ok: false, error: "invalid-input" });
        expect(f.settingsService.get("features")?.sessionIndexingWithoutContainment).toBe(true);
      }
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
      backgroundState.release = backgroundState.noBackend = backgroundState.homeLost = false;
    }
  });

  it.each([
    ["projection", "present account", () => backgroundState.accountInventory.mockResolvedValue({ errors: [], warnings: [] })],
    ["write", "present account", () => backgroundState.accountInventory.mockResolvedValue({ errors: [], warnings: [] })],
    ["projection", "degraded account", () => backgroundState.accountInventory.mockResolvedValue({ ...NO_ACCOUNT, warnings: ["inventory incomplete"] })],
    ["write", "degraded account", () => backgroundState.accountInventory.mockResolvedValue({ ...NO_ACCOUNT, warnings: ["inventory incomplete"] })],
    ["projection", "unreadable account", () => backgroundState.accountInventory.mockRejectedValue(new Error("inventory failed"))],
    ["write", "unreadable account", () => backgroundState.accountInventory.mockRejectedValue(new Error("inventory failed"))],
    ["projection", "present container", () => backgroundState.containerInventory.mockResolvedValue({ state: "available", windowsBuild: null })],
    ["write", "present container", () => backgroundState.containerInventory.mockResolvedValue({ state: "available", windowsBuild: null })],
    ["projection", "degraded container", () => backgroundState.containerInventory.mockResolvedValue({ ...NO_CONTAINER, baseContainerApiPresent: true })],
    ["write", "degraded container", () => backgroundState.containerInventory.mockResolvedValue({ ...NO_CONTAINER, baseContainerApiPresent: true })],
    ["projection", "unreadable container", () => backgroundState.containerInventory.mockRejectedValue(new Error("probe failed"))],
    ["write", "unreadable container", () => backgroundState.containerInventory.mockRejectedValue(new Error("probe failed"))],
  ] as const)("rechecks backend absence before the first settings %s after a %s backend replaces published absence", async (operation, _backend, change) => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    const f = await setup();
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    backgroundState.noBackend = backgroundState.release = true;
    try {
      await expect(f.invoke(CHANNELS.settings.get, undefined)).resolves.toHaveProperty("features.sessionIndexingWithoutContainment", true);
      await f.settingsService.patch({ features: { sessionIndexingWithoutContainment: true } });
      change();
      if (operation === "projection") {
        await expect(f.invoke(CHANNELS.settings.get, undefined)).resolves.not.toHaveProperty("features.sessionIndexingWithoutContainment");
      } else {
        await expect(f.invoke(CHANNELS.settings.update, { features: { sessionIndexingWithoutContainment: false } }))
          .resolves.toEqual({ ok: false, error: "invalid-input" });
        expect(f.settingsService.get("features")?.sessionIndexingWithoutContainment).toBe(true);
      }
      expect(getSandboxHomesUnavailable()).toBe(false);
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
      backgroundState.release = backgroundState.noBackend = false;
    }
  });

  it("publishes and accepts the independent switch only on a released PC without containment", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    const f = await setup();
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const read = () => f.invoke(CHANNELS.settings.get, undefined);
    const write = (value: unknown) => f.invoke(CHANNELS.settings.update, {
      features: { sessionIndexingWithoutContainment: value },
    });
    try {
      backgroundState.noBackend = true;
      expect(await read()).not.toHaveProperty("features.sessionIndexingWithoutContainment");
      expect(await write(false)).toEqual({ ok: false, error: "invalid-input" });
      backgroundState.release = true;
      expect(await read()).toHaveProperty("features.sessionIndexingWithoutContainment", true);
      expect(await write("false")).toEqual({ ok: false, error: "invalid-input" });
      expect(await write(false)).toHaveProperty("features.sessionIndexingWithoutContainment", false);
      expect(await read()).toHaveProperty("features.sessionIndexingWithoutContainment", false);
      expect(f.settingsService.get("memoryEmbedding")).toBeUndefined();
      backgroundState.noBackend = false;
      expect(await read()).not.toHaveProperty("features.sessionIndexingWithoutContainment");
      expect(await write(true)).toEqual({ ok: false, error: "invalid-input" });
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
      backgroundState.release = backgroundState.noBackend = false;
    }
  });
});

describe("shell sandbox checkbox write", () => {
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
    const capture = collectPermissionEvents();
    onTestFinished(capture.restore);
    const f = await setup();
    await f.settingsService.patch({ features: { osToolSandbox: true, pluginWorkerConfinement: true } });
    const save = vi.spyOn(f.settingsService as unknown as { saveSettings(settings: AppSettings): Promise<void> }, "saveSettings");
    save.mockRejectedValueOnce(new Error("Settings storage unavailable"));
    await expect(f.updateSecurity({ features: { osToolSandbox: false } })).rejects.toThrow("Settings storage unavailable");
    expect(f.settingsService.get("features")).toMatchObject({ osToolSandbox: true, pluginWorkerConfinement: true });
    expect(new SettingsService({ userDataPath, encryption: unavailableSecretEncryption }).get("features"))
      .toMatchObject({ osToolSandbox: true, pluginWorkerConfinement: true });
    expect(f.refreshSandboxNetworkConfig).not.toHaveBeenCalled();
    expect(capture.events.filter(({ event }) => event === "security_settings_changed")).toEqual([
      expect.objectContaining({ phase: "requested" }),
    ]);
  });
});
