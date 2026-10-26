import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { bundledCredentialKey } from "../../mcp/bundled-credential.js";
import type { ParsedContent } from "../../marketplace/content/kinds.js";
import type { LedgerEntry } from "../../marketplace/content/ledger.js";
import { installedFontStack } from "../../shared/installed-content.js";
import { marketplaceProviderPresetSecretKey } from "../../shared/marketplace-package-assets.js";
import { DEFAULT_BUNDLE_ID } from "../../shared/theme-bundles.js";
import { AveHomeConfigurationUntrustedError } from "../../shared/ave-home.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { IpcDeps } from "../types.js";
import { createContentActivation, legacyContentSettings, removeAgentPluginData } from "../domains/marketplace-content.js";

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

  it("removes package data and bundled credentials only when explicitly requested", async () => {
    const savedHome = process.env.AVE_HOME;
    process.env.AVE_HOME = join(userDataPath, "isolated-home");
    try {
      const dataDir = await openFeatureNamespace("agent-plugin-data").childDir("meeting-kit");
      writeFileSync(join(dataDir, "marker"), "retained");
      const key = bundledCredentialKey({ kind: "agent-plugin", name: "meeting-kit" }, "notes");
      await settingsService.setSecret(key, "private-value");
      expect(existsSync(join(dataDir, "marker"))).toBe(true);
      expect(settingsService.getSecret(key)).toBe("private-value");
      await removeAgentPluginData(settingsService, "meeting-kit", ["notes"]);
      expect(existsSync(dataDir)).toBe(false);
      expect(settingsService.getSecret(key)).toBeNull();
    } finally {
      if (savedHome === undefined) delete process.env.AVE_HOME;
      else process.env.AVE_HOME = savedHome;
    }
  });

  it("installs and removes a provider preset through the settings preset path", async () => {
    const activation = createContentActivation(deps);
    await activation.activate({ kind: "provider", preset }, entry("provider", "harbor-llm"), null, false);
    expect(settingsService.get("marketplace").installedProviderPresets).toEqual([preset]);
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalled();
    expect(sent).toContain("ave:settings:updated");

    await activation.deactivate(entry("provider", "harbor-llm"), null);
    expect(settingsService.get("marketplace").installedProviderPresets).toEqual([]);
  });

  it("adds and removes a messaging connection declaration", async () => {
    const activation = createContentActivation(deps);
    await activation.activate({ kind: "messaging-connection", connection }, entry("messaging-connection", "harbor-chat"), null, false);
    expect(settingsService.get("marketplace").installedMessagingConnections).toEqual([connection]);
    await activation.activate({ kind: "messaging-connection", connection: { ...connection, label: "Harbor Chat 2" } }, entry("messaging-connection", "harbor-chat"), entry("messaging-connection", "harbor-chat"), false);
    expect(settingsService.get("marketplace").installedMessagingConnections.map((item) => item.label)).toEqual(["Harbor Chat 2"]);
    await activation.deactivate(entry("messaging-connection", "harbor-chat"), null);
    expect(settingsService.get("marketplace").installedMessagingConnections).toEqual([]);
  });

  it("returns a selected theme, language or font to the default when its package is removed", async () => {
    const activation = createContentActivation(deps);
    await settingsService.patch({ appearance: { ...settingsService.get("appearance"), bundleId: "harbor", language: "fr", font: { family: installedFontStack("harbor-sans") } } });

    await activation.deactivate(entry("theme", "harbor"), null);
    expect(settingsService.get("appearance").bundleId).toBe(DEFAULT_BUNDLE_ID);

    await activation.deactivate(entry("language", "french"), { kind: "language", locale: "fr", nativeName: "Français", englishName: "French", messages: {}, missingKeys: [] });
    expect(settingsService.get("appearance").language).toBe("en");

    await activation.deactivate(entry("font", "harbor-sans"), null);
    expect(settingsService.get("appearance").font?.family).toBe("system");
  });

  it("keeps a compiled language selected when the package that overlaid it is removed", async () => {
    const activation = createContentActivation(deps);
    await settingsService.patch({ appearance: { ...settingsService.get("appearance"), language: "ko" } });
    await activation.deactivate(entry("language", "korean"), { kind: "language", locale: "ko", nativeName: "한국어", englishName: "Korean", messages: {}, missingKeys: [] });
    expect(settingsService.get("appearance").language).toBe("ko");
  });

  it("preserves bundled vendor settings and credentials during package activation and replacement", async () => {
    const activation = createContentActivation(deps);
    await settingsService.patch({ llm: { vendors: { "azure-foundry": { model: "saved-model", baseUrl: "https://saved.example/v1", enableThinking: false } } } });
    await settingsService.setSecret("llm.apiKey.azure-foundry", "sk-user");
    const before = settingsService.get("llm");
    const vendor = { providerId: "azure-foundry" as const, defaultModel: "gpt-5", baseUrl: "https://gateway.corp.example/foundry" };
    await activation.activate({ kind: "provider", vendor }, entry("provider", "azure-foundry"), null, false);
    await activation.activate({ kind: "provider", vendor }, entry("provider", "azure-foundry"), entry("provider", "azure-foundry"), false);
    await activation.deactivate(entry("provider", "azure-foundry"), null);
    expect(settingsService.get("llm")).toEqual(before);
    expect(settingsService.getSecret("llm.apiKey.azure-foundry")).toBe("sk-user");
  });

  it("uninstalls an old bundled vendor package without changing its key or settings", async () => {
    const activation = createContentActivation(deps);
    await settingsService.patch({ marketplace: { installedProviderIds: ["groq"] }, llm: { vendors: { groq: { model: "saved-model", baseUrl: "https://saved.example/v1", enableThinking: false } } } });
    await settingsService.setSecret("llm.apiKey.groq", "sk-user");
    const before = settingsService.get("llm");
    await activation.deactivate(entry("provider", "groq"), null);
    expect(settingsService.getSecret("llm.apiKey.groq")).toBe("sk-user");
    expect(settingsService.get("llm")).toEqual(before);
    expect(settingsService.get("marketplace").installedProviderIds).not.toContain("groq");
  });

  it("does not read a bundled vendor secret while removing its legacy package", async () => {
    const activation = createContentActivation(deps);
    await settingsService.setSecret("llm.apiKey.azure-foundry", "sk-user");
    const read = vi.spyOn(settingsService, "getSecret").mockImplementation(() => {
      throw new Error("keychain changed");
    });
    await expect(activation.deactivate(entry("provider", "azure-foundry"), null)).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(settingsService.getSecret("llm.apiKey.azure-foundry")).toBe("sk-user");
  });

  it("preserves a saved key and its provider when the configuration boundary is untrusted", async () => {
    const activation = createContentActivation(deps);
    await activation.activate({ kind: "provider", vendor: { providerId: "azure-foundry" } }, entry("provider", "azure-foundry"), null, false);
    await settingsService.setSecret("llm.apiKey.azure-foundry", "sk-user");
    const failure = new AveHomeConfigurationUntrustedError(join(userDataPath, "ave-secrets.json"), "Unverified boundary");
    const read = vi.spyOn(settingsService, "getSecret").mockImplementationOnce(() => { throw failure; });
    const remove = vi.spyOn(settingsService, "deleteSecret");
    try {
      await expect(activation.deactivate(entry("provider", "azure-foundry"), null)).rejects.toBe(failure);
      expect(remove).not.toHaveBeenCalled();
      expect(settingsService.get("marketplace").installedProviderIds).toContain("azure-foundry");
      expect(settingsService.getSecret("llm.apiKey.azure-foundry")).toBe("sk-user");
    } finally {
      read.mockRestore();
      remove.mockRestore();
    }
  });

  it("keeps a third-party preset key and address when saving a move fails", async () => {
    const activation = createContentActivation(deps);
    await activation.activate({ kind: "provider", preset }, entry("provider", preset.providerId), null, false);
    const key = marketplaceProviderPresetSecretKey(preset.providerId);
    await settingsService.setSecret(key, "sk-user");
    const save = vi.spyOn(settingsService as unknown as { saveSettings(): Promise<void> }, "saveSettings").mockRejectedValueOnce(new Error("disk full"));
    await expect(
      activation.activate({ kind: "provider", preset: { ...preset, baseUrl: "https://moved.example/v1" } }, entry("provider", preset.providerId), entry("provider", preset.providerId), false),
    ).rejects.toThrow("disk full");
    save.mockRestore();
    expect(settingsService.getSecret(key)).toBe("sk-user");
    expect(settingsService.get("marketplace").installedProviderPresets).toEqual([preset]);
  });

  it("refuses a first install whose id the settings already hold from another path", async () => {
    const activation = createContentActivation(deps);
    await settingsService.installMarketplaceProviderPreset(preset);
    await expect(activation.activate({ kind: "provider", preset }, entry("provider", "harbor-llm"), null, false)).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
    await activation.activate({ kind: "provider", preset: { ...preset, label: "Harbor LLM 2" } }, entry("provider", "harbor-llm"), entry("provider", "harbor-llm"), false);
    expect(settingsService.get("marketplace").installedProviderPresets.map((item) => item.label)).toEqual(["Harbor LLM 2"]);

    await settingsService.patch({ marketplace: { installedMessagingConnections: [connection] } });
    await expect(activation.activate({ kind: "messaging-connection", connection }, entry("messaging-connection", "harbor-chat"), null, false)).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
    await settingsService.patch({ marketplace: { installedProviderIds: ["azure-foundry"] } });
    await expect(activation.activate({ kind: "provider", vendor: { providerId: "azure-foundry" } }, entry("provider", "azure-foundry"), null, false)).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });

    const nord = { kind: "theme", name: "Nord", description: "Arctic.", shell: "dark", highContrast: false, tokens: {}, surfaces: {} } as unknown as ParsedContent;
    await settingsService.patch({ marketplace: { installedThemeBundleIds: ["nord"] } });
    await expect(activation.activate(nord, entry("theme", "nord"), null, false)).resolves.toEqual({ retired: expect.any(Promise) });
  });

  it("reads the legacy activations for the first-boot migration, and drops only the theme ids and locales it was given", async () => {
    await settingsService.installMarketplaceProviderPreset(preset);
    await settingsService.patch({ marketplace: { installedProviderIds: ["azure-foundry"], installedThemeBundleIds: ["nord", "forest"], installedLanguagePacks: ["ko"] } });
    const legacy = legacyContentSettings(deps);
    expect(legacy.activations).toEqual({ themes: ["nord", "forest"], locales: ["ko"], providers: ["azure-foundry", "harbor-llm"] });

    await legacy.release({ themes: ["nord"], locales: ["ko"] });
    expect(settingsService.get("marketplace")).toMatchObject({
      installedThemeBundleIds: ["forest"],
      installedLanguagePacks: [],
      installedProviderIds: ["azure-foundry"],
      installedProviderPresets: [expect.objectContaining({ providerId: "harbor-llm" })],
    });
    expect(sent).toContain("ave:settings:updated");
  });

  it("adds the selected theme, and its old followSystem counterpart, to the legacy themes (§16.3)", async () => {
    await settingsService.patch({ marketplace: { installedThemeBundleIds: ["nord"] }, appearance: { schemaVersion: 2, bundleId: "violet-dark", followSystem: true } });
    expect(legacyContentSettings(deps).activations.themes).toEqual(["nord", "violet-dark", "violet-light"]);
    await settingsService.patch({ appearance: { schemaVersion: 2, bundleId: "gallery", followSystem: false } });
    expect(legacyContentSettings(deps).activations.themes).toEqual(["nord"]);
  });

  it("adopts a legacy activation the settings hold without rewriting it, and activates one they do not", async () => {
    const activation = createContentActivation(deps);
    await settingsService.patch({ marketplace: { installedProviderIds: ["azure-foundry"] }, llm: { vendors: { "azure-foundry": { model: "user-model", baseUrl: "https://own.example/foundry" } } } });
    await settingsService.setSecret("llm.apiKey.azure-foundry", "sk-user");
    const vendor = { providerId: "azure-foundry" as const, defaultModel: "gpt-5", baseUrl: "https://gateway.corp.example/foundry" };
    await activation.activate({ kind: "provider", vendor }, entry("provider", "azure-foundry"), null, true);
    expect(settingsService.get("llm").vendors["azure-foundry"]).toMatchObject({ model: "user-model", baseUrl: "https://own.example/foundry" });
    expect(settingsService.getSecret("llm.apiKey.azure-foundry")).toBe("sk-user");

    await settingsService.installMarketplaceProviderPreset(preset);
    await activation.activate({ kind: "provider", preset: { ...preset, label: "Harbor LLM 2" } }, entry("provider", "harbor-llm"), null, true);
    expect(settingsService.get("marketplace").installedProviderPresets.map((item) => item.label)).toEqual([preset.label]);

    await activation.activate({ kind: "messaging-connection", connection }, entry("messaging-connection", "harbor-chat"), null, true);
    expect(settingsService.get("marketplace").installedMessagingConnections).toEqual([connection]);
  });

  it("refuses a first skill or agent install whose name a user file already defines", async () => {
    const skillStore = { userSkillFile: vi.fn(async (name: string) => (name === "review" ? "/home/u/.ave/skills/review/SKILL.md" : null)) };
    const agentProfileStore = { userProfileFile: vi.fn(async (name: string) => (name === "triage" ? "/home/u/.ave/agents/triage.md" : null)) };
    const activation = createContentActivation({ ...deps, skillStore, agentProfileStore } as unknown as IpcDeps);
    await expect(activation.activate({ kind: "skill", name: "review", description: "Reviews." }, entry("skill", "review"), null, false)).rejects.toMatchObject({
      code: "PACKAGE_ID_CONFLICT",
      message: expect.stringContaining("/home/u/.ave/skills/review/SKILL.md"),
    });
    await expect(activation.activate({ kind: "agent", name: "triage", description: "Triages." }, entry("agent", "triage"), null, false)).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
    await activation.activate({ kind: "skill", name: "summarize", description: "Summarizes." }, entry("skill", "summarize"), null, false);
    await activation.activate({ kind: "skill", name: "review", description: "Reviews." }, entry("skill", "review"), entry("skill", "review"), false);
    expect(skillStore.userSkillFile).toHaveBeenCalledTimes(2);
  });

  it("keeps a provider installed when the provider refresh after the settings write throws", async () => {
    const activation = createContentActivation(deps);
    vi.mocked(deps.conversationLoop.refreshProvider).mockImplementation(() => {
      throw new Error("refresh boom");
    });
    await expect(activation.activate({ kind: "provider", preset }, entry("provider", "harbor-llm"), null, false)).resolves.toEqual({ retired: expect.any(Promise) });
    expect(settingsService.get("marketplace").installedProviderPresets).toEqual([preset]);
    await expect(activation.deactivate(entry("provider", "harbor-llm"), null)).resolves.toBeUndefined();
    expect(settingsService.get("marketplace").installedProviderPresets).toEqual([]);
  });

  it("throws when the settings write fails, and only logs a failed broadcast after it landed", async () => {
    const activation = createContentActivation(deps);
    const patch = vi.spyOn(settingsService, "patch").mockRejectedValueOnce(new Error("disk full"));
    await expect(activation.activate({ kind: "messaging-connection", connection }, entry("messaging-connection", "harbor-chat"), null, false)).rejects.toThrow("disk full");
    patch.mockRestore();

    const windows = vi.fn(() => {
      throw new Error("window gone");
    });
    deps.getAppWindows = windows as unknown as IpcDeps["getAppWindows"];
    await expect(activation.activate({ kind: "messaging-connection", connection }, entry("messaging-connection", "harbor-chat"), null, false)).resolves.toEqual({ retired: expect.any(Promise) });
    expect(windows).toHaveBeenCalled();
    expect(settingsService.get("marketplace").installedMessagingConnections).toEqual([connection]);
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
