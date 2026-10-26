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
const REMOVAL_MIGRATION = "system-app-mode-removed";

describe("removed workspace mode settings", () => {
  let userDataPath: string;
  let writes: Promise<void>[];

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-mode-removal-"));
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

  it.each(["chat", "work", "action"])("removes the saved %s value on disk once and preserves other preferences", async (appMode) => {
    const settingsPath = join(userDataPath, "ave-settings.json");
    const current = new SettingsService({ encryption, userDataPath }).getAll();
    const saved = {
      ...current,
      appliedMigrations: current.appliedMigrations?.filter((id) => id !== REMOVAL_MIGRATION),
      system: { ...current.system, appMode, closeBehavior: "quit", sidebarWidth: 280 },
      appearance: { ...current.appearance, language: "ko" },
      features: { ...current.features, subAgentAutonomousWake: false },
    };
    writeFileSync(settingsPath, JSON.stringify(saved), "utf-8");

    const service = new SettingsService({ encryption, userDataPath });
    await Promise.all(writes);
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(onDisk.system).not.toHaveProperty("appMode");
    expect(service.get("system")).not.toHaveProperty("appMode");
    expect(onDisk.appliedMigrations.filter((id: string) => id === REMOVAL_MIGRATION)).toHaveLength(1);
    expect(onDisk.system).toEqual(expect.objectContaining({ closeBehavior: "quit", sidebarWidth: 280 }));
    expect(onDisk.appearance.language).toBe("ko");
    expect(onDisk.features.subAgentAutonomousWake).toBe(false);

    const persisted = readFileSync(settingsPath, "utf-8");
    const writeCount = writes.length;
    const reloaded = new SettingsService({ encryption, userDataPath });
    await Promise.all(writes);
    expect(reloaded.getAll()).toEqual(service.getAll());
    expect(writes).toHaveLength(writeCount);
    expect(readFileSync(settingsPath, "utf-8")).toBe(persisted);
  });

  it("omits the removed field from defaults and ignores stale patches", async () => {
    const service = new SettingsService({ encryption, userDataPath });
    expect(service.get("system")).not.toHaveProperty("appMode");
    expect(service.getAll().appliedMigrations).toContain(REMOVAL_MIGRATION);
    await service.patch({ system: { appMode: "action", closeBehavior: "quit" } } as never);
    const onDisk = JSON.parse(readFileSync(join(userDataPath, "ave-settings.json"), "utf-8"));
    expect(onDisk.system).not.toHaveProperty("appMode");
    expect(onDisk.system.closeBehavior).toBe("quit");
  });
});
