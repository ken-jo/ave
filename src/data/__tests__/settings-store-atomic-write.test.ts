import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { SettingsService, settingsFilePath } from "../settings-store.js";

let root: string;
let service: SettingsService;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ave-settings-atomic-"));
  service = new SettingsService({ userDataPath: root, encryption: unavailableSecretEncryption });
  await service.patch({ system: { ...service.get("system"), hardwareAcceleration: false } });
});
afterEach(async () => cleanupTmpDir(root));

describe("settings persistence", () => {
  it("lets an existing reader finish the previous complete settings while publishing the next version", async () => {
    const path = settingsFilePath(root);
    const before = readFileSync(path, "utf8");
    const fd = openSync(path, "r");
    try {
      await service.patch({ system: { ...service.get("system"), hardwareAcceleration: true } });
      expect(readFileSync(fd, "utf8")).toBe(before);
      expect(JSON.parse(readFileSync(path, "utf8")).system.hardwareAcceleration).toBe(true);
      const reloaded = new SettingsService({ userDataPath: root, encryption: unavailableSecretEncryption });
      expect(reloaded.get("system").hardwareAcceleration).toBe(true);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      closeSync(fd);
    }
  });

  it.skipIf(process.platform === "win32")("replaces a settings symlink without overwriting its target", async () => {
    const path = settingsFilePath(root);
    const outside = join(root, "separate-document.json");
    const original = "{\"keep\":true}\n";
    writeFileSync(outside, original);
    unlinkSync(path);
    symlinkSync(outside, path);

    await service.patch({ system: { ...service.get("system"), hardwareAcceleration: true } });

    expect(readFileSync(outside, "utf8")).toBe(original);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).system.hardwareAcceleration).toBe(true);
  });

  it.skipIf(process.platform === "win32")("keeps memory on the saved settings when a write fails", async () => {
    // A directory where the settings file goes: every write fails.
    const path = settingsFilePath(root);
    unlinkSync(path);
    mkdirSync(path);

    await expect(service.patch({ system: { ...service.get("system"), hardwareAcceleration: true } })).rejects.toThrow();
    expect(service.get("system").hardwareAcceleration).toBe(false);

    const preset = {
      providerId: "harbor-llm",
      label: "Harbor LLM",
      baseUrl: "https://api.harbor.example/v1",
      defaultModel: "harbor-1",
      modelOptions: ["harbor-1"],
      requiresApiKey: true,
    };
    await expect(service.installMarketplaceProviderPreset(preset)).rejects.toThrow();
    expect(service.get("marketplace").installedProviderPresets).toEqual([]);
  });

  it("takes writes one at a time, so a failed write undoes only its own change", async () => {
    const save = vi.spyOn(service as unknown as { saveSettings(): Promise<void> }, "saveSettings");
    // The first save waits, as on a held file lock, then fails.
    save.mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new Error("disk full")), 20)));

    const failing = service.patch({ system: { ...service.get("system"), hardwareAcceleration: true } });
    const next = service.setPluginConfig("sample", { mode: "fast" });

    await expect(failing).rejects.toThrow("disk full");
    await expect(next).resolves.toEqual({ mode: "fast" });
    expect(service.get("system").hardwareAcceleration).toBe(false);
    expect(service.getPluginConfig("sample")).toEqual({ mode: "fast" });
    const saved = JSON.parse(readFileSync(settingsFilePath(root), "utf8"));
    expect(saved.system.hardwareAcceleration).toBe(false);
    expect(saved.pluginConfigs.sample).toEqual({ mode: "fast" });
  });

  it("changes memory when the call is made while no write is in flight", async () => {
    const write = service.patch({ system: { ...service.get("system"), hardwareAcceleration: true } });
    expect(service.get("system").hardwareAcceleration).toBe(true);
    await write;
  });
});
