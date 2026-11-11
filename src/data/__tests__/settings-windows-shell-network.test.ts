import { useConfigurationOwner as configureConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

configureConfigurationOwner();

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeFeatureFlags } from "../settings-normalization.js";
import { createSettingsService } from "../../__tests__/support/settings-service.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { bindWindowsShellLocalNetworkAccess, isWindowsShellLocalNetworkAccessAllowed,
  __resetWindowsSandboxSubstrateForTest } from "../../permissions/sandbox-capability.js";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "settings-shell-network-")); });
afterEach(async () => { vi.restoreAllMocks(); __resetWindowsSandboxSubstrateForTest(); await cleanupTmpDir(directory); });

describe("Windows shell local-network consent", () => {
  it("keeps live consent on the saved value when a feature write fails", async () => {
    const settings = createSettingsService(directory);
    await settings.patch({ features: { windowsShellLocalNetworkAccess: true } });
    const dispose = bindWindowsShellLocalNetworkAccess(settings);
    try {
      vi.spyOn(settings as unknown as { saveSettings(value: unknown): Promise<void> }, "saveSettings")
        .mockRejectedValueOnce(new Error("disk full"));
      await expect(settings.patch({ features: { windowsShellLocalNetworkAccess: false } })).rejects.toThrow("disk full");
      expect(isWindowsShellLocalNetworkAccessAllowed()).toBe(true);
      expect(createSettingsService(directory).get("features")?.windowsShellLocalNetworkAccess).toBe(true);
    } finally { dispose(); }
  });

  it("honors durable consent off even if a mixed update later fails after a concurrent save", async () => {
    const settings = createSettingsService(directory);
    const preset = { providerId: "fixture-router", label: "Fixture Router", baseUrl: "https://router.example.test/v1",
      defaultModel: "fixture", modelOptions: ["fixture"], requiresApiKey: true };
    await settings.installMarketplaceProviderPreset(preset);
    await settings.patch({ features: { windowsShellLocalNetworkAccess: true } });
    const dispose = bindWindowsShellLocalNetworkAccess(settings);
    try {
      const secrets = (settings as unknown as { secretStore: { deleteMany(keys: string[]): Promise<number> } }).secretStore;
      vi.spyOn(secrets, "deleteMany").mockImplementationOnce(async () => {
        expect(isWindowsShellLocalNetworkAccessAllowed()).toBe(false);
        await settings.setPluginConfig("fixture", { enabled: true });
        throw new Error("secret deletion failed");
      });
      await expect(settings.patch({ features: { windowsShellLocalNetworkAccess: false },
        marketplace: { installedProviderPresets: [] } })).rejects.toThrow("secret deletion failed");
      expect(createSettingsService(directory).get("features")?.windowsShellLocalNetworkAccess).toBe(false);
      expect(isWindowsShellLocalNetworkAccessAllowed()).toBe(false);
      expect(settings.get("marketplace").installedProviderPresets).toEqual([preset]);
      expect(settings.getPluginConfig("fixture")).toEqual({ enabled: true });
    } finally { dispose(); }
  });

  it("defaults fresh and previously saved sandbox settings to off", () => {
    expect(createSettingsService(directory).get("features")?.windowsShellLocalNetworkAccess).toBe(false);
    writeFileSync(join(directory, "ave-settings.json"), JSON.stringify({ features: { osToolSandbox: true } }));
    expect(createSettingsService(directory).get("features")?.windowsShellLocalNetworkAccess).toBe(false);
  });

  it.each([true, false])("persists explicit consent %s independently of confinement scopes", async (enabled) => {
    const settings = createSettingsService(directory);
    await settings.patch({ features: { osToolSandbox: true, pluginWorkerConfinement: false } });
    await settings.patch({ features: { windowsShellLocalNetworkAccess: enabled } });
    expect(createSettingsService(directory).get("features")).toMatchObject({
      windowsShellLocalNetworkAccess: enabled,
      osToolSandbox: true,
      pluginWorkerConfinement: false,
    });
    expect(JSON.parse(readFileSync(join(directory, "ave-settings.json"), "utf8")))
      .toHaveProperty("features.windowsShellLocalNetworkAccess", enabled);
  });

  it.each([undefined, null, "true", 1, [], {}])("does not infer consent from %j", (value) => {
    expect(normalizeFeatureFlags({ windowsShellLocalNetworkAccess: value }))
      .not.toHaveProperty("windowsShellLocalNetworkAccess");
    writeFileSync(join(directory, "ave-settings.json"), JSON.stringify({ features: { windowsShellLocalNetworkAccess: value } }));
    expect(createSettingsService(directory).get("features")?.windowsShellLocalNetworkAccess).toBe(false);
  });

  it("rejects malformed patches without changing a saved choice", async () => {
    const settings = createSettingsService(directory);
    await settings.patch({ features: { windowsShellLocalNetworkAccess: true } });
    await settings.patch({ features: { windowsShellLocalNetworkAccess: "false" } } as never);
    expect(createSettingsService(directory).get("features")?.windowsShellLocalNetworkAccess).toBe(true);
  });
});
