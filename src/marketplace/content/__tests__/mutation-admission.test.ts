import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppRelaunchRequested } from "../../../main/app-relaunch-state.js";
import { hasMarketplaceInstallInFlight } from "../../app/install-lifecycle.js";
import * as storeModule from "../store.js";
import * as ledgerModule from "../ledger.js";
import { EMPTY_MARKETPLACE_POLICY } from "../../sources/policy.js";
import { SettingsService, settingsFilePath, type AppSettings } from "../../../data/settings-store.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { deferred } from "../../../__tests__/support/deferred.js";

const { ContentStore, stageLocalAgentPlugin } = storeModule;
const { ContentLedger } = ledgerModule;

function members(type: { prototype: object }, instance: object): string[] {
  return [...Object.getOwnPropertyNames(type), ...Object.getOwnPropertyNames(type.prototype), ...Object.getOwnPropertyNames(instance)]
    .filter((name) => !["length", "name", "prototype", "constructor"].includes(name)).sort();
}

const STORE_INTERNALS = ["queue", "options", "ledger", "serialize", "mutate", "removeWhenRetired", "assertClaimFree", "loadOne"];
const LEDGER_INTERNALS = ["path", "entries", "write"];
const SETTINGS_OBSERVERS = ["getAll", "get", "getProviderConfigRevision", "getSecretGeneration", "isSecretIdentityUsable",
  "onLeaseStateChanged", "onChanged", "getPluginConfig", "getSecret", "getEncryptedSecret", "hasStoredSecret", "isSecretStorageEncrypted"];
const SETTINGS_OTHER_WRITES = ["migrateSecrets", "deleteRetiredMarketplaceApiKey", "deleteRetiredLlmVendorApiKeys",
  "migrateRenamedVendorSecrets", "replaceLlm", "setPluginConfig", "deletePluginConfig", "setSecret", "deleteSecret", "deletePluginSecrets"];
const SETTINGS_INTERNALS = ["changeListeners", "providerConfigRevision", "secretGenerations", "observedSecretFingerprint",
  "observedSecretMutation", "secretMutationRegressed", "leaseStateListeners", "readSecretFingerprint", "identityFingerprint",
  "notifyLeaseState", "providerConfigChanged", "secretStateChanged", "secretStatesChanged", "settingsPath", "secretsPath",
  "secretStore", "settings", "saved", "unsaved", "saving", "withheldSecretKeys", "restoringSecretKeys", "invalidatingSecretKeys",
  "reenteredSecretKeys", "writtenReentries", "patchSettings", "replaceMarketplaceProviderPresets", "commitPresetKeyInvalidation",
  "deleteMarketplaceProviderPresetSecretsAtomically", "enteredForApplied", "deleteMarketplaceProviderPresetSecrets",
  "isRetiredLlmCredential", "secretReadable", "deleteWithheldSecrets", "loadSettings", "commit", "drain", "saveSettings"];

const PROVIDER_PRESET = {
  providerId: "fixture-router", label: "Fixture Router", baseUrl: "https://router.example.test/v1",
  defaultModel: "fixture", modelOptions: ["fixture"], requiresApiKey: true,
};

function settingsMutators(service: SettingsService): Record<string, () => Promise<unknown>> {
  const marketplace = { ...service.get("marketplace"), installedProviderPresets: [] };
  return {
    installMarketplaceProviderPreset: () => service.installMarketplaceProviderPreset({ ...PROVIDER_PRESET, label: "Updated Router" }),
    uninstallMarketplaceProviderPreset: () => service.uninstallMarketplaceProviderPreset(PROVIDER_PRESET.providerId),
    set: () => service.set("marketplace", marketplace),
    patch: () => service.patch({ marketplace }),
  };
}

describe("installed content mutation admission", () => {
  let root: string;
  let store: storeModule.ContentStore;
  const activation = { activate: vi.fn(async () => ({ retired: Promise.resolve() })),
    deactivate: vi.fn(async () => undefined), approveComponents: vi.fn(async () => undefined) };
  const staged = () => stageLocalAgentPlugin([
    { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "team-kit", version: "1.0.0", description: "Team tools" })) },
    { path: "skills/review/SKILL.md", data: Buffer.from("---\nname: review\ndescription: Review changes\n---\nReview changes.\n") },
  ]);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ave-mutation-admission-"));
    vi.clearAllMocks();
    store = await ContentStore.open({ root: join(root, "packages"), english: {}, activation });
  });
  afterEach(async () => {
    setAppRelaunchRequested(false);
    await rm(root, { recursive: true, force: true });
  });

  it("classifies every exported store and ledger member", async () => {
    const storeReads = ["open", "list", "installed", "packageDir", "installedConsent", "load"];
    const storeWrites = ["install", "uninstall", "sweep", "approveComponents"];
    const ledgerReads = ["open", "get", "list"];
    const ledgerWrites = ["put", "remove"];
    const ledger = await ContentLedger.open(join(root, "packages", "ledger.json"));
    expect(members(ContentStore, store)).toEqual([...storeReads, ...storeWrites, ...STORE_INTERNALS].sort());
    expect(members(ContentLedger, ledger)).toEqual([...ledgerReads, ...ledgerWrites, ...LEDGER_INTERNALS].sort());
    expect(Object.keys(storeModule).sort()).toEqual(["ContentStore", "stageContentPackage", "stageLocalAgentPlugin", "stagedConsent"].sort());
    expect(Object.keys(ledgerModule).sort()).toEqual(["ContentLedger", "contentLedgerOrigins", "installPayloadDir"].sort());
  });

  it("classifies every settings member including installed package writers", async () => {
    const service = new SettingsService({ userDataPath: root, encryption: unavailableSecretEncryption, secretPolicy: "development" });
    await service.patch({});
    expect(members(SettingsService, service)).toEqual([
      ...SETTINGS_OBSERVERS, ...SETTINGS_OTHER_WRITES, ...SETTINGS_INTERNALS, ...Object.keys(settingsMutators(service)),
    ].sort());
  });

  it("refuses every settings installed package mutator without changing memory or disk", async () => {
    const service = new SettingsService({ userDataPath: root, encryption: unavailableSecretEncryption, secretPolicy: "development" });
    await service.installMarketplaceProviderPreset(PROVIDER_PRESET);
    const before = readFileSync(settingsFilePath(root), "utf8");
    const snapshot = service.getAll();
    setAppRelaunchRequested(true);
    for (const mutate of Object.values(settingsMutators(service))) {
      await expect(mutate()).rejects.toMatchObject({ code: "relaunch-in-progress" });
      expect(service.getAll()).toEqual(snapshot);
      expect(readFileSync(settingsFilePath(root), "utf8")).toBe(before);
    }
  });

  it("counts every settings installed package mutator until its save completes", async () => {
    const service = new SettingsService({ userDataPath: root, encryption: unavailableSecretEncryption, secretPolicy: "development" });
    await service.installMarketplaceProviderPreset(PROVIDER_PRESET);
    const writer = service as unknown as { saveSettings(settings: AppSettings): Promise<void> };
    const save = writer.saveSettings.bind(service);
    const saveSpy = vi.spyOn(writer, "saveSettings");
    for (const mutate of Object.values(settingsMutators(service))) {
      const started = deferred<void>();
      const held = deferred<void>();
      saveSpy.mockImplementationOnce(async (settings) => { started.resolve(); await held.promise; await save(settings); });
      const pending = mutate();
      try {
        expect(hasMarketplaceInstallInFlight()).toBe(true);
        await started.promise;
        expect(hasMarketplaceInstallInFlight()).toBe(true);
      } finally {
        held.resolve();
        await pending;
      }
      expect(hasMarketplaceInstallInFlight()).toBe(false);
    }
  });

  it("allows ordinary settings changes during reserved relaunch", async () => {
    const service = new SettingsService({ userDataPath: root, encryption: unavailableSecretEncryption, secretPolicy: "development" });
    await service.patch({});
    setAppRelaunchRequested(true);
    await service.patch({ features: { osToolSandbox: true } });
    await service.set("appearance", service.get("appearance"));
    expect(service.get("features")?.osToolSandbox).toBe(true);
    expect(hasMarketplaceInstallInFlight()).toBe(false);
  });

  it("keeps settings admission through rollback after preset secret deletion fails", async () => {
    const service = new SettingsService({ userDataPath: root, encryption: unavailableSecretEncryption, secretPolicy: "development" });
    await service.installMarketplaceProviderPreset(PROVIDER_PRESET);
    const before = readFileSync(settingsFilePath(root), "utf8");
    const snapshot = service.getAll();
    const internals = service as unknown as {
      secretStore: { deleteMany(keys: readonly string[]): Promise<void> };
      saveSettings(settings: AppSettings): Promise<void>;
    };
    vi.spyOn(internals.secretStore, "deleteMany").mockRejectedValueOnce(new Error("secret-delete-failed"));
    const started = deferred<void>();
    const held = deferred<void>();
    const save = internals.saveSettings.bind(service);
    vi.spyOn(internals, "saveSettings").mockImplementationOnce(save).mockImplementationOnce(async (settings) => {
      started.resolve();
      await held.promise;
      await save(settings);
    });
    const pending = service.uninstallMarketplaceProviderPreset(PROVIDER_PRESET.providerId);
    const failed = expect(pending).rejects.toThrow("secret-delete-failed");
    try {
      await started.promise;
      expect(hasMarketplaceInstallInFlight()).toBe(true);
      expect(service.getAll()).toEqual(snapshot);
      expect(readFileSync(settingsFilePath(root), "utf8")).not.toBe(before);
    } finally {
      held.resolve();
      await failed;
    }
    expect(readFileSync(settingsFilePath(root), "utf8")).toBe(before);
    expect(hasMarketplaceInstallInFlight()).toBe(false);
  });

  it("refuses every public content mutator before any filesystem or activation change", async () => {
    const entry = (await store.install(staged())).entry;
    const before = readFileSync(join(root, "packages", "ledger.json"), "utf8");
    const files = await readdir(join(root, "packages"), { recursive: true });
    vi.clearAllMocks();
    setAppRelaunchRequested(true);
    const mutators: Record<string, () => Promise<unknown>> = {
      install: () => store.install(staged()),
      uninstall: () => store.uninstall("agent-plugin", "team-kit", EMPTY_MARKETPLACE_POLICY),
      sweep: () => store.sweep(),
      approveComponents: () => store.approveComponents("team-kit", entry.origin.installId!, []),
    };
    const reads = ["open", "list", "installed", "packageDir", "installedConsent", "load"];
    expect(members(ContentStore, store)).toEqual([...reads, ...Object.keys(mutators), ...STORE_INTERNALS].sort());
    for (const mutate of Object.values(mutators)) {
      await expect(mutate()).rejects.toMatchObject({ code: "relaunch-in-progress" });
      expect(readFileSync(join(root, "packages", "ledger.json"), "utf8")).toBe(before);
      expect(await readdir(join(root, "packages"), { recursive: true })).toEqual(files);
      expect(store.list()).toEqual([entry]);
    }
    expect(activation.activate).not.toHaveBeenCalled();
    expect(activation.deactivate).not.toHaveBeenCalled();
    expect(activation.approveComponents).not.toHaveBeenCalled();
  });

  it("refuses every public ledger mutator without changing memory or disk", async () => {
    const entry = (await store.install(staged())).entry;
    const path = join(root, "packages", "ledger.json");
    const ledger = await ContentLedger.open(path);
    const before = readFileSync(path, "utf8");
    setAppRelaunchRequested(true);
    const mutators: Record<string, () => Promise<unknown>> = {
      put: () => ledger.put({ ...entry, version: "2.0.0" }),
      remove: () => ledger.remove(entry.kind, entry.name),
    };
    expect(members(ContentLedger, ledger)).toEqual(["open", "get", "list", ...Object.keys(mutators), ...LEDGER_INTERNALS].sort());
    for (const mutate of Object.values(mutators)) {
      await expect(mutate()).rejects.toMatchObject({ code: "relaunch-in-progress" });
      expect(ledger.list()).toEqual([entry]);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });

  it("counts queued installs synchronously and keeps admission through activation rollback", async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    activation.activate.mockImplementationOnce(async () => { entered(); await held; throw new Error("activation-failed"); });
    const pending = store.install(staged());
    const failed = expect(pending).rejects.toThrow("activation-failed");
    try {
      expect(hasMarketplaceInstallInFlight()).toBe(true);
      await started;
      expect(hasMarketplaceInstallInFlight()).toBe(true);
    } finally {
      release();
      await failed;
    }
    expect(store.list()).toEqual([]);
    expect(hasMarketplaceInstallInFlight()).toBe(false);
  });
});
