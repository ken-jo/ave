/**
 * Content activation (blueprint 3.5): a provider or messaging-connection
 * package takes effect through the same settings paths today's asset
 * install uses, and removing a selected theme, language or font returns its
 * setting to the default.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedElectron = vi.hoisted(() => ({
  safeStorage: {
    // Removing a preset deletes its secret, which needs the encrypted store.
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => "gnome_libsecret" as const),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().slice(4)),
  },
}));

vi.mock("electron", () => ({
  safeStorage: mockedElectron.safeStorage,
  ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn() },
}));

import { SettingsService } from "../../data/settings-store.js";
import type { LedgerEntry } from "../../marketplace/content/ledger.js";
import { installedFontStack } from "../../shared/installed-content.js";
import { DEFAULT_BUNDLE_ID } from "../../shared/theme-bundles.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { IpcDeps } from "../types.js";
import { createContentActivation } from "../domains/marketplace-content.js";

const entry = (kind: LedgerEntry["kind"], name: string): LedgerEntry => ({
  kind,
  name,
  version: "1.0.0",
  origin: { sourceId: "acme", sourceOrigin: "custom", commit: "c".repeat(40), packagePath: `x/${name}`, version: "1.0.0", contentSha256: "d".repeat(64), installedAt: "2026-09-23T00:00:00.000Z" },
});

const preset = {
  providerId: "harbor-llm",
  label: "Harbor LLM",
  baseUrl: "https://api.harbor.example/v1",
  defaultModel: "harbor-1",
  modelOptions: ["harbor-1"],
  requiresApiKey: true,
};

const connection = {
  connectionId: "harbor-chat",
  label: "Harbor Chat",
  summary: "Talk to Ave from Harbor Chat.",
  pairing: "one-time-code" as const,
  credentials: [{ key: "botToken", label: "Bot token", secret: true }],
};

describe("createContentActivation", () => {
  let userDataPath: string;
  let settingsService: SettingsService;
  let deps: IpcDeps;
  let sent: string[];

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "ave-content-activation-"));
    settingsService = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    sent = [];
    const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel: string) => sent.push(channel) } };
    deps = {
      settingsService,
      conversationLoop: { refreshProvider: vi.fn() },
      getMainWindow: () => window,
      getAppWindows: () => [window],
    } as unknown as IpcDeps;
  });

  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  it("installs and removes a provider preset through the settings preset path", async () => {
    const activation = createContentActivation(deps);
    await activation.activate({ kind: "provider", preset }, entry("provider", "harbor-llm"));
    expect(settingsService.get("marketplace").installedProviderPresets).toEqual([preset]);
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalled();
    expect(sent).toContain("ave:settings:updated");

    await activation.deactivate(entry("provider", "harbor-llm"), null);
    expect(settingsService.get("marketplace").installedProviderPresets).toEqual([]);
  });

  it("adds and removes a messaging connection declaration", async () => {
    const activation = createContentActivation(deps);
    await activation.activate({ kind: "messaging-connection", connection }, entry("messaging-connection", "harbor-chat"));
    expect(settingsService.get("marketplace").installedMessagingConnections).toEqual([connection]);
    await activation.activate({ kind: "messaging-connection", connection: { ...connection, label: "Harbor Chat 2" } }, entry("messaging-connection", "harbor-chat"));
    expect(settingsService.get("marketplace").installedMessagingConnections.map((item) => item.label)).toEqual(["Harbor Chat 2"]);
    await activation.deactivate(entry("messaging-connection", "harbor-chat"), null);
    expect(settingsService.get("marketplace").installedMessagingConnections).toEqual([]);
  });

  it("returns a selected theme, language or font to the default when its package is removed", async () => {
    const activation = createContentActivation(deps);
    await settingsService.patch({ appearance: { ...settingsService.get("appearance"), bundleId: "harbor", language: "fr", font: { family: installedFontStack("Harbor Sans") } } });

    await activation.deactivate(entry("theme", "harbor"), null);
    expect(settingsService.get("appearance").bundleId).toBe(DEFAULT_BUNDLE_ID);

    await activation.deactivate(entry("language", "french"), { kind: "language", locale: "fr", nativeName: "Français", englishName: "French", messages: {}, missingKeys: [] });
    expect(settingsService.get("appearance").language).toBe("en");

    await activation.deactivate(entry("font", "harbor-sans"), { kind: "font", family: "Harbor Sans", faces: [] });
    expect(settingsService.get("appearance").font?.family).toBe("system");
  });

  it("leaves settings alone when the removed package is not the selected one", async () => {
    const activation = createContentActivation(deps);
    await settingsService.patch({ appearance: { ...settingsService.get("appearance"), bundleId: "midnight" } });
    const before = settingsService.getAll();
    await activation.deactivate(entry("theme", "harbor"), null);
    expect(settingsService.getAll()).toEqual(before);
    expect(sent).toEqual([]);
  });
});
