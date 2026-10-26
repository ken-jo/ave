import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../settings-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const encryption = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => "gnome_libsecret" as const,
  encryptString: vi.fn(),
  decryptString: vi.fn(),
};

describe("sidebar visibility settings", () => {
  let userDataPath: string;
  let writes: Promise<void>[];

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-sidebar-state-"));
    writes = [];
    type SettingsWriter = { saveSettings(settings: unknown): Promise<void> };
    const prototype = SettingsService.prototype as unknown as SettingsWriter;
    const saveSettings = prototype.saveSettings;
    vi.spyOn(prototype, "saveSettings").mockImplementation(function (this: SettingsWriter, settings) {
      const writing = saveSettings.call(this, settings);
      writes.push(writing);
      return writing;
    });
  });

  afterEach(async () => {
    await Promise.allSettled(writes);
    vi.restoreAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("keeps an absent choice unset so the window can choose its width-dependent default", async () => {
    const service = new SettingsService({ encryption, userDataPath });
    expect(service.get("system")).not.toHaveProperty("sidebarState");
    await service.patch({ system: { ...service.get("system"), sidebarWidth: 280 } });
    const saved = JSON.parse(readFileSync(join(userDataPath, "ave-settings.json"), "utf8"));
    expect(saved.system).not.toHaveProperty("sidebarState");
  });

  it.each(["expanded", "rail", "hidden"] as const)("persists and restores the explicit %s choice", async (sidebarState) => {
    const service = new SettingsService({ encryption, userDataPath });
    await service.patch({ system: { ...service.get("system"), sidebarState } });
    const saved = JSON.parse(readFileSync(join(userDataPath, "ave-settings.json"), "utf8"));
    expect(saved.system.sidebarState).toBe(sidebarState);
    const reloaded = new SettingsService({ encryption, userDataPath });
    expect(reloaded.get("system")).toHaveProperty("sidebarState", sidebarState);
  });

  it("drops an invalid stored choice and refuses an invalid patch without losing a valid choice", async () => {
    const service = new SettingsService({ encryption, userDataPath });
    await Promise.all(writes);
    const settingsPath = join(userDataPath, "ave-settings.json");
    writeFileSync(settingsPath, JSON.stringify({ ...service.getAll(), system: { ...service.get("system"), sidebarState: "invalid" } }));
    const reloaded = new SettingsService({ encryption, userDataPath });
    expect(reloaded.get("system")).not.toHaveProperty("sidebarState");
    await reloaded.patch({ system: { ...reloaded.get("system"), sidebarState: "rail" } });
    await reloaded.patch({ system: { sidebarState: "invalid", sidebarWidth: 280 } } as never);
    expect(reloaded.get("system")).toHaveProperty("sidebarState", "rail");
    expect(reloaded.get("system").sidebarWidth).toBe(280);
  });
});
