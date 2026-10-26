import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockedElectron = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    getSelectedStorageBackend: vi.fn(() => "gnome_libsecret" as const),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  safeStorage: mockedElectron.safeStorage,
}));

import { SettingsService, type SystemSettings } from "../settings-store.js";
import { SecretDocumentStore } from "../secret-document-store.js";
import { CredentialLeaseRegistry } from "../../plugins/secret-access/credential-lease-registry.js";
import { DEFAULT_SETTINGS } from "../settings-defaults.js";
import { compactionModelRouteKey, selectedCompactionModel } from "../../shared/compaction-model.js";
import { normalizeMarketplace } from "../settings-normalization.js";
import { registerInstalledLocales } from "../../i18n/locale.js";
import {
  LOG_RETENTION_DAYS,
  LOG_RETENTION_MIN_DAYS,
  LOG_RETENTION_MAX_DAYS,
} from "../../shared/log-retention.js";
import { BUNDLE_IDS, DEFAULT_BUNDLE_ID } from "../../shared/theme-bundles.js";
import { SIDE_PANEL_MIN_RESERVE } from "../../shared/side-panel.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  DEFAULT_LLM_VENDOR,
  freshAllVendorBlocks,
  getLlmVendorSettings,
  llmImageInputKey,
} from "../../shared/llm-vendor-defaults.js";
import { llmModelListCacheKey, MAX_CACHED_LLM_MODEL_IDS } from "../../shared/llm-model-list.js";
import { marketplaceProviderPresetSecretKey } from "../../shared/marketplace-package-assets.js";
import { MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH } from "../../shared/subscription-runtime.js";
import { routeExternalUrl } from "../../boot/steps/plugin-runtime/external-url.js";
import { deferred } from "../../__tests__/support/deferred.js";

let currentSettingsPath: string;
let currentMigrations: readonly string[];

beforeAll(() => {
  currentSettingsPath = mkdtempSync(join(tmpdir(), "settings-store-current-"));
  const settings = new SettingsService({
    encryption: mockedElectron.safeStorage,
    userDataPath: currentSettingsPath,
  }).getAll();
  expect(settings.appliedMigrations).toBeDefined();
  currentMigrations = Object.freeze(settings.appliedMigrations!);
});

afterAll(async () => {
  await cleanupTmpDir(currentSettingsPath);
});

/** Current-format normalization fixtures do not need unrelated migration writes. */
function currentSettingsJson(settings: Record<string, unknown>): string {
  return JSON.stringify({ ...settings, appliedMigrations: currentMigrations });
}

describe("SettingsService upstream proxy (main-owned)", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-upstream-proxy-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  it("defaults to the system settings and is not written by patch()", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("upstreamProxy")).toEqual({ mode: "system", manualUrl: "", bypass: "", resolvesNames: false });
    await service.patch({ upstreamProxy: { mode: "manual", manualUrl: "http://p.test:1" } } as never);
    expect(service.get("upstreamProxy").mode).toBe("system");
  });

  it("normalizes a hand-edited file: credentials dropped from the URL, wrong types back to defaults", () => {
    writeFileSync(join(userDataPath, "ave-settings.json"), JSON.stringify({
      upstreamProxy: { mode: "manual", manualUrl: " http://user:secret@proxy.test:3128 ", bypass: 7, resolvesNames: "yes" },
    }), "utf-8");
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("upstreamProxy")).toEqual({ mode: "manual", manualUrl: "http://proxy.test:3128", bypass: "", resolvesNames: false });
    writeFileSync(join(userDataPath, "ave-settings.json"), JSON.stringify({ upstreamProxy: { mode: "pac" } }), "utf-8");
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("upstreamProxy").mode).toBe("system");
  });

  it("notifies a change written through set()", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const changed = vi.fn();
    service.onChanged("upstreamProxy", changed);
    await service.set("upstreamProxy", { mode: "off", manualUrl: "", bypass: "", resolvesNames: false });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(service.get("upstreamProxy").mode).toBe("off");
  });

  it.each([" * ", "\t* ", " ", "*"])("preserves bypass text %j across save and reload", async (bypass) => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.set("upstreamProxy", { mode: "manual", manualUrl: "http://proxy.test:80", bypass, resolvesNames: false });
    expect(service.get("upstreamProxy").bypass).toBe(bypass);
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("upstreamProxy").bypass).toBe(bypass);
  });
});

describe("SettingsService compaction model route", () => {
  it("binds model saves atomically and rejects an expected route that another settings write changed", async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), "settings-compaction-route-"));
    try {
      const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
      const expectedRoute = compactionModelRouteKey(service.get("llm"));
      await service.patch({ llm: { compactionModel: "summary-model", compactionModelRoute: expectedRoute } });
      expect(selectedCompactionModel(service.get("llm"))).toBe("summary-model");
      const vendor = service.get("llm").provider;
      await service.patch({ llm: { vendors: { [vendor]: { baseUrl: "https://another.example.test/v1" } } } });
      expect(selectedCompactionModel(service.get("llm"))).toBeUndefined();
      await expect(service.patch({ llm: { compactionModel: "wrong-route-model", compactionModelRoute: expectedRoute } }))
        .rejects.toThrow("Compaction provider route changed");
      expect(service.get("llm").compactionModel).toBe("summary-model");
      expect(selectedCompactionModel(service.get("llm"))).toBeUndefined();
      await service.patch({ llm: { compactionModel: "new-route-model" } });
      expect(selectedCompactionModel(service.get("llm"))).toBe("new-route-model");
    } finally { await cleanupTmpDir(userDataPath); }
  });
});

describe("SettingsService remote A2A canonical route-control origin", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-a2a-remote-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  it("accepts the canonical root slash and rejects a value URL would rewrite", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

    await service.patch({ a2aRemote: { routeControlBaseUrl: "https://hub.example.test/" } } as never);
    expect(service.get("a2aRemote").routeControlBaseUrl).toBe("https://hub.example.test/");

    for (const noncanonical of [
      "https://hub.example.test",
      "https://hub.example.test/?",
      "https://hub.example.test/#",
    ]) {
      await service.patch({ a2aRemote: { routeControlBaseUrl: noncanonical } } as never);
      expect(service.get("a2aRemote").routeControlBaseUrl).toBe("");
    }
  });
});

describe("SettingsService marketplace defaults", () => {
  let userDataPath: string;

  beforeEach(() => {

    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("defaults carry no server marketplace fields", () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

    expect(service.get("marketplace")).toEqual({
      updateCheckEnabled: DEFAULT_SETTINGS.marketplace.updateCheckEnabled,
      offlineCacheEnabled: DEFAULT_SETTINGS.marketplace.offlineCacheEnabled,
      installedProviderIds: [],
      installedProviderPresets: [],
      installedThemeBundleIds: [],
      installedLanguagePacks: [],
      installedMessagingConnections: [],
    });
  });

  it("drops the server marketplace settings once and writes the file back (design §16.2)", async () => {
    const path = join(userDataPath, "ave-settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        marketplace: {
          backend: "real-cloud",
          cloudBaseUrl: "https://marketplace.ave.local",
          cloudAllowPrivateNetwork: true,
          realCloudBaseUrl: "https://legacy.example",
          realCloudAllowPrivateNetwork: true,
          updateCheckEnabled: false,
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const marketplace = service.get("marketplace") as unknown as Record<string, unknown>;
    for (const key of ["backend", "cloudBaseUrl", "cloudAllowPrivateNetwork", "realCloudBaseUrl", "realCloudAllowPrivateNetwork"]) {
      expect(marketplace[key], key).toBeUndefined();
    }
    // The settings the git marketplace keeps are kept.
    expect(marketplace.updateCheckEnabled).toBe(false);

    await vi.waitFor(() => {
      expect(JSON.parse(readFileSync(path, "utf-8")).appliedMigrations).toContain("marketplace-server-settings-removed");
    });
    expect(readFileSync(path, "utf-8")).not.toMatch(/cloudBaseUrl|CloudBaseUrl|real-cloud|AllowPrivateNetwork/u);
  });

  it("normalizes the automatic-update switches, dropping invalid entries, and leaves the discovery interval as stored (design §18.9)", async () => {
    const load = (marketplace: unknown) => {
      writeFileSync(join(userDataPath, "ave-settings.json"), currentSettingsJson({ marketplace }), "utf-8");
      return new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("marketplace");
    };
    const read = load({
      autoUpdate: false,
      autoUpdateSources: { "acme-tools": "off", ave: "on", "Bad_Id": "on", corp: "maybe", "x": "on" },
      autoUpdatePackages: { meeting: "off", "skill:review": "on", " notes ": "on", constructor: "off", calendar: true },
      updateCheckIntervalMs: 60_000,
    });
    expect(read.autoUpdate).toBe(false);
    expect(read.autoUpdateSources).toEqual({ "acme-tools": "off", ave: "on" });
    expect(read.autoUpdatePackages).toEqual({ meeting: "off", "skill:review": "on", notes: "on" });
    // The normalizer builds both maps without a prototype, so no id read off disk answers for an inherited member.
    const normalized = normalizeMarketplace({ autoUpdateSources: { ave: "on" }, autoUpdatePackages: JSON.parse('{"__proto__":"on","meeting":"off"}') });
    expect(Object.getPrototypeOf(normalized.autoUpdateSources)).toBeNull();
    expect(Object.getPrototypeOf(normalized.autoUpdatePackages)).toBeNull();
    expect(Object.keys(normalized.autoUpdatePackages!)).toEqual(["meeting"]);
    // The discovery interval is read as stored; the 15-minute floor applies where it is used.
    expect(read.updateCheckIntervalMs).toBe(60_000);

    // Unset, or not a map, means the default decides: no key at all.
    const unset = load({ autoUpdate: "yes", autoUpdateSources: ["ave"], autoUpdatePackages: null });
    expect("autoUpdate" in unset).toBe(false);
    expect("autoUpdateSources" in unset).toBe(false);
    expect("autoUpdatePackages" in unset).toBe(false);

    // A renderer patch goes through the same normalizer.
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ marketplace: { autoUpdateSources: { corp: "on", "-bad": "off" } } } as never);
    expect(service.get("marketplace").autoUpdateSources).toEqual({ corp: "on" });
  });

  it("keeps a valid git runtime mode and drops anything else", () => {
    const load = (git: unknown) => {
      writeFileSync(join(userDataPath, "ave-settings.json"), currentSettingsJson({ marketplace: { git } }), "utf-8");
      return new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("marketplace").git;
    };
    expect(load({ mode: "managed" })).toEqual({ mode: "managed" });
    expect(load({ mode: "system", extra: true })).toEqual({ mode: "system" });
    expect(load({ mode: "portable" })).toBeUndefined();
    expect(load("managed")).toBeUndefined();
  });

  it("keeps only the declaration of an installed messaging connection", async () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        marketplace: {
          installedMessagingConnections: [
            {
              connectionId: "telegram",
              label: "Telegram",
              summary: "Reach one Ave conversation from Telegram.",
              pairing: "one-time-code",
              credentials: [{ key: "botToken", label: "Bot token", secret: true }],
              egress: ["api.telegram.org"],
              // Neither of these belongs in settings; both must be dropped.
              botToken: "123456:REAL-TOKEN",
              credentialValues: { botToken: "123456:REAL-TOKEN" },
            },
            { connectionId: "telegram", label: "Duplicate", summary: "x", pairing: "one-time-code", credentials: [] },
            { connectionId: "broken", label: "Broken" },
          ],
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    expect(service.get("marketplace").installedMessagingConnections).toEqual([{
      connectionId: "telegram",
      label: "Telegram",
      summary: "Reach one Ave conversation from Telegram.",
      pairing: "one-time-code",
      credentials: [{ key: "botToken", label: "Bot token", secret: true }],
      egress: ["api.telegram.org"],
    }]);
    expect(JSON.stringify(service.get("marketplace"))).not.toContain("REAL-TOKEN");
  });

  it("persists only valid marketplace-installed provider/theme/language assets", async () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        marketplace: {
          installedProviderIds: ["openrouter", "groq", "missing-vendor", "openai", "groq"],
          installedThemeBundleIds: [
            "moonstone",
            "tokyo-night",
            "missing-theme",
            "gallery",
            "tokyo-night",
            "Not_A_Package",
          ],
          installedLanguagePacks: ["en", "ko", "it", "ko"],
          installedProviderPresets: [
            {
              providerId: "future-router",
              label: "Future Router",
              baseUrl: "https://future.example/v1",
              defaultModel: "future/free",
              modelOptions: ["future/free", "future/pro"],
              requiresApiKey: false,
            },
            {
              providerId: "openai",
              label: "Core collision",
              baseUrl: "https://ignored.example/v1",
              defaultModel: "ignored",
            },
            {
              providerId: "future-router",
              label: "Duplicate",
              baseUrl: "https://duplicate.example/v1",
              defaultModel: "duplicate",
            },
          ],
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    expect(service.get("marketplace")).toMatchObject({
      installedProviderIds: ["groq"],
      installedProviderPresets: [{
        providerId: "future-router",
        label: "Future Router",
        baseUrl: "https://future.example/v1",
        defaultModel: "future/free",
        modelOptions: ["future/free", "future/pro"],
        requiresApiKey: false,
      }],
      // Legacy input of the first-boot migration: any theme package name, never a compiled id.
      installedThemeBundleIds: ["tokyo-night", "missing-theme"],
      installedLanguagePacks: ["ko"],
    });

    await service.patch({
      marketplace: {
        installedProviderIds: ["ollama", "openai", "nope"] as never,
        installedProviderPresets: [
          {
            providerId: "local-router",
            label: "Local Router",
            baseUrl: "http://localhost:8000/v1",
            defaultModel: "local/free",
            requiresApiKey: false,
          },
          { providerId: "bad router", label: "Bad", baseUrl: "http://localhost:8000/v1", defaultModel: "x" },
        ],
        installedThemeBundleIds: ["high-contrast", "moonstone", "No Theme"] as never,
        installedLanguagePacks: ["ko", "en", "nope"] as never,
      },
    });

    expect(service.get("marketplace")).toMatchObject({
      installedProviderIds: ["ollama"],
      installedProviderPresets: [{
        providerId: "local-router",
        label: "Local Router",
        baseUrl: "http://localhost:8000/v1",
        defaultModel: "local/free",
        modelOptions: ["local/free"],
        requiresApiKey: false,
      }],
      installedThemeBundleIds: ["high-contrast"],
      installedLanguagePacks: ["ko"],
    });
  });

  it("resets the active custom provider preset when the preset is uninstalled", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    await service.patch({
      marketplace: { installedProviderPresets: [preset] },
    });
    await service.patch({
      llm: {
        provider: "openai-compatible",
        marketplaceProviderPresetId: "future-router",
        vendors: {
          "openai-compatible": {
            model: "future/free",
            // The GENERIC custom-provider row's own endpoint; a different row from the preset, and no longer overwritten by it.
            baseUrl: "https://generic.example/v1",
          },
        },
        modelListCache: {
          [llmModelListCacheKey(
            "openai-compatible",
            "https://future.example/v1",
            "future-router",
          )]: {
            vendor: "openai-compatible",
            baseUrl: "https://future.example/v1",
            credentialScope: "future-router",
            endpoint: "https://future.example/v1/models",
            models: ["future/free"],
            fetchedAt: new Date(0).toISOString(),
          },
        },
      },
    });
    await service.setSecret(
      marketplaceProviderPresetSecretKey("future-router"),
      "fr-secret",
    );
    expect(service.getSecret(marketplaceProviderPresetSecretKey("future-router")))
      .toBe("fr-secret");
    expect(service.get("llm")).toMatchObject({
      provider: "openai-compatible",
      marketplaceProviderPresetId: "future-router",
    });

    await service.patch({
      marketplace: { installedProviderPresets: [] },
    });

    const llm = service.get("llm");
    expect(llm.provider).toBe(DEFAULT_LLM_VENDOR);
    expect(llm.marketplaceProviderPresetId).toBeUndefined();
    // The generic row keeps what the user saved: it was never the preset's block to scrub, and scrubbing it threw away another row's endpoint.
    expect(getLlmVendorSettings(llm.vendors, "openai-compatible").baseUrl)
      .toBe("https://generic.example/v1");
    expect(Object.values(llm.modelListCache)).not.toContainEqual(
      expect.objectContaining({ credentialScope: "future-router" }),
    );
    expect(service.getSecret(marketplaceProviderPresetSecretKey("future-router")))
      .toBeNull();
  });

  it("keeps a generic custom-provider endpoint patch while a preset is active", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({
      marketplace: {
        installedProviderPresets: [{
          providerId: "future-router",
          label: "Future Router",
          baseUrl: "https://future.example/v1",
          defaultModel: "future/free",
          modelOptions: ["future/free"],
          requiresApiKey: true,
        }],
      },
    });

    await service.patch({
      llm: {
        provider: "openai-compatible",
        marketplaceProviderPresetId: "future-router",
        vendors: {
          "openai-compatible": {
            model: "future/free",
            baseUrl: "https://stale.example/v1",
          },
        },
      },
    });

    const llm = service.get("llm");
    expect(llm.marketplaceProviderPresetId).toBe("future-router");
    // The generic custom-provider row's endpoint is its own and is persisted as written. It used to be
    // overwritten with the active preset's address, which silently reverted every save from that card.
    expect(getLlmVendorSettings(llm.vendors, "openai-compatible").baseUrl)
      .toBe("https://stale.example/v1");
    // And the preset route still resolves from the registry, so the patch cannot move where the active preset actually points.
    expect(service.get("marketplace").installedProviderPresets?.[0]?.baseUrl)
      .toBe("https://future.example/v1");
  });

  it("preserves existing custom provider preset metadata when settings patch tries to mutate its endpoint", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    await service.patch({
      marketplace: { installedProviderPresets: [preset] },
    });
    await service.patch({
      llm: {
        provider: "openai-compatible",
        marketplaceProviderPresetId: "future-router",
        vendors: {
          "openai-compatible": {
            model: "future/free",
            baseUrl: "https://future.example/v1",
          },
        },
        fallbackChain: [{ provider: "openai-compatible", model: "fallback/free" }],
      },
    });

    await service.patch({
      marketplace: {
        installedProviderPresets: [{
          ...preset,
          baseUrl: "https://attacker.example/v1",
        }],
      },
      llm: {
        vendors: {
          "openai-compatible": {
            model: "future/free",
            baseUrl: "https://attacker.example/v1",
          },
        },
        fallbackChain: [{ provider: "openai-compatible", model: "fallback/free" }],
      },
    });

    const marketplace = service.get("marketplace");
    // The preset registry owns the route's address, so refusing the mutation HERE is what keeps the active route on the installed endpoint.
    expect(marketplace.installedProviderPresets).toEqual([preset]);
    const llm = service.get("llm");
    expect(llm.fallbackChain).toEqual([]);
  });

  it("refreshes existing custom provider preset metadata through the trusted marketplace install path", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    await service.installMarketplaceProviderPreset(preset);
    await service.patch({
      llm: {
        provider: "openai-compatible",
        marketplaceProviderPresetId: "future-router",
        vendors: {
          "openai-compatible": {
            model: "future/free",
            baseUrl: "https://future.example/v1",
          },
        },
      },
    });
    await service.setSecret(
      marketplaceProviderPresetSecretKey("future-router"),
      "fr-old-secret",
    );

    await service.installMarketplaceProviderPreset({
      ...preset,
      label: "Future Router v2",
      baseUrl: "https://future-v2.example/v1",
      defaultModel: "future/v2",
      modelOptions: ["future/v2", "future/free"],
      requiresApiKey: false,
    });

    expect(service.get("marketplace").installedProviderPresets).toEqual([{
      providerId: "future-router",
      label: "Future Router v2",
      baseUrl: "https://future-v2.example/v1",
      defaultModel: "future/v2",
      modelOptions: ["future/v2", "future/free"],
      requiresApiKey: false,
    }]);
    expect(service.getSecret(marketplaceProviderPresetSecretKey("future-router")))
      .toBeNull();
  });

  it("keeps a write that landed during a failed preset-secret deletion, and puts back only the preset", async () => {
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockedElectron.safeStorage.encryptString.mockImplementation(
      (value: string) => Buffer.from(`sealed:${value}`),
    );
    mockedElectron.safeStorage.decryptString.mockImplementation(
      (value: Buffer) => value.toString("utf-8").slice(7),
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    await service.installMarketplaceProviderPreset(preset);
    await service.setSecret(marketplaceProviderPresetSecretKey("future-router"), "fr-secret");
    const secrets = (service as unknown as { secretStore: { deleteMany(keys: string[]): Promise<number> } }).secretStore;
    vi.spyOn(secrets, "deleteMany").mockImplementationOnce(async () => {
      // Another write lands, and reports success, while the deletion runs.
      await service.setPluginConfig("sample", { mode: "fast" });
      throw new Error("keychain locked");
    });

    await expect(service.installMarketplaceProviderPreset({
      ...preset,
      baseUrl: "https://elsewhere.example/v1",
    })).rejects.toThrow("keychain locked");

    expect(service.get("marketplace").installedProviderPresets).toEqual([preset]);
    expect(service.getSecret(marketplaceProviderPresetSecretKey("future-router"))).toBe("fr-secret");
    expect(service.getPluginConfig("sample")).toEqual({ mode: "fast" });
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("marketplace").installedProviderPresets).toEqual([preset]);
    expect(reloaded.getPluginConfig("sample")).toEqual({ mode: "fast" });
  });

  it("withholds a preset key left next to a new address when its deletion and the rollback both fail", async () => {
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockedElectron.safeStorage.encryptString.mockImplementation(
      (value: string) => Buffer.from(`sealed:${value}`),
    );
    mockedElectron.safeStorage.decryptString.mockImplementation(
      (value: Buffer) => value.toString("utf-8").slice(7),
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    const key = marketplaceProviderPresetSecretKey("future-router");
    await service.installMarketplaceProviderPreset(preset);
    await service.setSecret(key, "fr-secret");
    type Internals = {
      saveSettings(settings: unknown): Promise<void>;
      secretStore: { deleteMany(keys: string[]): Promise<number> };
    };
    const internals = service as unknown as Internals;
    const realSave = (settings: unknown) => (SettingsService.prototype as unknown as Internals).saveSettings.call(service, settings);
    vi.spyOn(internals, "saveSettings")
      .mockImplementationOnce(realSave)
      .mockImplementationOnce(() => Promise.reject(new Error("disk full")));
    const deleteMany = vi.spyOn(internals.secretStore, "deleteMany")
      .mockImplementationOnce(() => Promise.reject(new Error("keychain locked")));

    await expect(service.installMarketplaceProviderPreset({
      ...preset,
      baseUrl: "https://elsewhere.example/v1",
    })).rejects.toThrow("keychain locked");

    // The new address is what is saved; its old key is not handed out.
    expect(service.get("marketplace").installedProviderPresets[0]?.baseUrl).toBe("https://elsewhere.example/v1");
    expect(service.getSecret(key)).toBeNull();
    expect(service.getEncryptedSecret(key)).toBeNull();

    // The next save that lands deletes it.
    await service.setPluginConfig("sample", { mode: "fast" });
    await vi.waitFor(() => expect(deleteMany).toHaveBeenLastCalledWith([key]));
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await vi.waitFor(() => expect(reloaded.getSecret(key)).toBeNull());

    // A key entered for the new address is handed out again.
    await service.setSecret(key, "fr-new-secret");
    expect(service.getSecret(key)).toBe("fr-new-secret");
  });

  it("holds a preset key back while its old address is saved back, then hands it out again", async () => {
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockedElectron.safeStorage.encryptString.mockImplementation(
      (value: string) => Buffer.from(`sealed:${value}`),
    );
    mockedElectron.safeStorage.decryptString.mockImplementation(
      (value: Buffer) => value.toString("utf-8").slice(7),
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    const key = marketplaceProviderPresetSecretKey("future-router");
    await service.installMarketplaceProviderPreset(preset);
    await service.setSecret(key, "fr-secret");
    type Internals = {
      saveSettings(settings: unknown): Promise<void>;
      secretStore: { deleteMany(keys: string[]): Promise<number> };
    };
    const internals = service as unknown as Internals;
    const realSave = (settings: unknown) => (SettingsService.prototype as unknown as Internals).saveSettings.call(service, settings);
    const seenDuringRestore: Array<string | null> = [];
    vi.spyOn(internals, "saveSettings")
      .mockImplementationOnce(realSave)
      .mockImplementationOnce((settings) => {
        seenDuringRestore.push(service.getSecret(key));
        return realSave(settings);
      });
    const deleteMany = vi.spyOn(internals.secretStore, "deleteMany")
      .mockImplementationOnce(() => Promise.reject(new Error("keychain locked")));

    await expect(service.installMarketplaceProviderPreset({
      ...preset,
      baseUrl: "https://elsewhere.example/v1",
    })).rejects.toThrow("keychain locked");

    expect(seenDuringRestore).toEqual([null]);
    expect(service.get("marketplace").installedProviderPresets).toEqual([preset]);
    expect(service.getSecret(key)).toBe("fr-secret");
    await service.setPluginConfig("sample", { mode: "fast" });
    expect(deleteMany).toHaveBeenCalledOnce();
    expect(service.getSecret(key)).toBe("fr-secret");
  });

  it("never pairs a key with an address it was not entered for when overlapping moves fail", async () => {
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockedElectron.safeStorage.encryptString.mockImplementation(
      (value: string) => Buffer.from(`sealed:${value}`),
    );
    mockedElectron.safeStorage.decryptString.mockImplementation(
      (value: Buffer) => value.toString("utf-8").slice(7),
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    const key = marketplaceProviderPresetSecretKey("future-router");
    await service.installMarketplaceProviderPreset(preset);
    await service.setSecret(key, "entered-for-future");
    const secrets = (service as unknown as { secretStore: { deleteMany(keys: string[]): Promise<number> } }).secretStore;
    let markFirstDeletionStarted!: () => void;
    const firstDeletionStarted = new Promise<void>((resolve) => { markFirstDeletionStarted = resolve; });
    let rejectFirstDeletion!: (error: Error) => void;
    const deleteMany = vi.spyOn(secrets, "deleteMany")
      // The first move's deletion fails last, so the second move rolls back first.
      .mockImplementationOnce(() => {
        markFirstDeletionStarted();
        return new Promise((_, reject) => { rejectFirstDeletion = reject; });
      })
      .mockImplementationOnce(() => Promise.reject(new Error("keychain locked")));

    const first = service.installMarketplaceProviderPreset({ ...preset, baseUrl: "https://second.example/v1" });
    const firstRejected = expect(first).rejects.toThrow("keychain locked");
    await firstDeletionStarted;
    const second = service.installMarketplaceProviderPreset({ ...preset, baseUrl: "https://third.example/v1" });
    try {
      await expect(second).rejects.toThrow("keychain locked");
    } finally {
      rejectFirstDeletion(new Error("keychain locked"));
      await firstRejected;
    }

    // Neither the second address (never the key's) nor any other is paired with the key: it is withheld wherever the preset points.
    expect(service.getSecret(key)).toBeNull();
    expect(service.get("marketplace").installedProviderPresets[0]?.baseUrl).not.toBe("https://second.example/v1");
    deleteMany.mockRestore();
    await service.setPluginConfig("sample", { mode: "fast" });
    await vi.waitFor(() => {
      const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
      expect(reloaded.getSecret(key)).toBeNull();
    });
  });

  it("keeps a preset edit that landed during a failed key deletion, and withholds the key", async () => {
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockedElectron.safeStorage.encryptString.mockImplementation(
      (value: string) => Buffer.from(`sealed:${value}`),
    );
    mockedElectron.safeStorage.decryptString.mockImplementation(
      (value: Buffer) => value.toString("utf-8").slice(7),
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    const key = marketplaceProviderPresetSecretKey("future-router");
    await service.installMarketplaceProviderPreset(preset);
    await service.setSecret(key, "entered-for-future");
    const moved = { ...preset, baseUrl: "https://elsewhere.example/v1" };
    const secrets = (service as unknown as { secretStore: { deleteMany(keys: string[]): Promise<number> } }).secretStore;
    vi.spyOn(secrets, "deleteMany").mockImplementationOnce(async () => {
      // A label edit of the moved preset lands, and reports success, meanwhile.
      await service.installMarketplaceProviderPreset({ ...moved, label: "Elsewhere Router" });
      throw new Error("keychain locked");
    });

    await expect(service.installMarketplaceProviderPreset(moved)).rejects.toThrow("keychain locked");

    expect(service.get("marketplace").installedProviderPresets).toEqual([{ ...moved, label: "Elsewhere Router" }]);
    expect(service.getSecret(key)).toBeNull();
  });

  it("keeps a key entered for the new address while the old key's deletion fails", async () => {
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockedElectron.safeStorage.encryptString.mockImplementation(
      (value: string) => Buffer.from(`sealed:${value}`),
    );
    mockedElectron.safeStorage.decryptString.mockImplementation(
      (value: Buffer) => value.toString("utf-8").slice(7),
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    const key = marketplaceProviderPresetSecretKey("future-router");
    await service.installMarketplaceProviderPreset(preset);
    await service.setSecret(key, "entered-for-future");
    const moved = { ...preset, baseUrl: "https://elsewhere.example/v1" };
    const secrets = (service as unknown as { secretStore: { deleteMany(keys: string[]): Promise<number> } }).secretStore;
    vi.spyOn(secrets, "deleteMany").mockImplementationOnce(async () => {
      // The user enters a key for the new address before the deletion fails.
      await service.setSecret(key, "entered-for-elsewhere");
      throw new Error("keychain locked");
    });

    await expect(service.installMarketplaceProviderPreset(moved)).rejects.toThrow("keychain locked");

    expect(service.get("marketplace").installedProviderPresets).toEqual([moved]);
    expect(service.getSecret(key)).toBe("entered-for-elsewhere");
  });

  it("keeps a key whose entry is still being written when the old key's deletion fails", async () => {
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockedElectron.safeStorage.encryptString.mockImplementation(
      (value: string) => Buffer.from(`sealed:${value}`),
    );
    mockedElectron.safeStorage.decryptString.mockImplementation(
      (value: Buffer) => value.toString("utf-8").slice(7),
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    const key = marketplaceProviderPresetSecretKey("future-router");
    await service.installMarketplaceProviderPreset(preset);
    await service.setSecret(key, "entered-for-future");
    const moved = { ...preset, baseUrl: "https://elsewhere.example/v1" };
    const secrets = (service as unknown as {
      secretStore: { set(key: string, value: string): Promise<void>; deleteMany(keys: string[]): Promise<number> };
    }).secretStore;
    const realSet = secrets.set.bind(secrets);
    const entryMayCommit = deferred<void>();
    vi.spyOn(secrets, "set").mockImplementationOnce(async (k, v) => {
      await entryMayCommit.promise;
      await realSet(k, v);
    });
    let entry: Promise<void> | undefined;
    vi.spyOn(secrets, "deleteMany").mockImplementationOnce(async () => {
      // The user starts entering a key for the new address; the deletion fails before that write lands.
      entry = service.setSecret(key, "entered-for-elsewhere");
      throw new Error("keychain locked");
    });

    try {
      await expect(service.installMarketplaceProviderPreset(moved)).rejects.toThrow("keychain locked");
    } finally {
      entryMayCommit.resolve();
    }
    await entry;

    expect(service.get("marketplace").installedProviderPresets).toEqual([moved]);
    expect(service.getSecret(key)).toBe("entered-for-elsewhere");
  });

  it("does not delete a key entered for the new address before the move's deletion runs", async () => {
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockedElectron.safeStorage.encryptString.mockImplementation(
      (value: string) => Buffer.from(`sealed:${value}`),
    );
    mockedElectron.safeStorage.decryptString.mockImplementation(
      (value: Buffer) => value.toString("utf-8").slice(7),
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    const key = marketplaceProviderPresetSecretKey("future-router");
    await service.installMarketplaceProviderPreset(preset);
    await service.setSecret(key, "entered-for-future");
    type Internals = { saveSettings(settings: unknown): Promise<void> };
    const realSave = (settings: unknown) => (SettingsService.prototype as unknown as Internals).saveSettings.call(service, settings);
    vi.spyOn(service as unknown as Internals, "saveSettings").mockImplementationOnce(async (settings) => {
      // The key for the new address is entered while the move is saved.
      await service.setSecret(key, "entered-for-elsewhere");
      await realSave(settings);
    });

    await service.installMarketplaceProviderPreset({ ...preset, baseUrl: "https://elsewhere.example/v1" });

    expect(service.getSecret(key)).toBe("entered-for-elsewhere");
  });

  it("withholds the key when an entry made during a move fails to write", async () => {
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockedElectron.safeStorage.encryptString.mockImplementation(
      (value: string) => Buffer.from(`sealed:${value}`),
    );
    mockedElectron.safeStorage.decryptString.mockImplementation(
      (value: Buffer) => value.toString("utf-8").slice(7),
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    const key = marketplaceProviderPresetSecretKey("future-router");
    await service.installMarketplaceProviderPreset(preset);
    await service.setSecret(key, "entered-for-future");
    const registry = new CredentialLeaseRegistry(service);
    const incarnation = {};
    const permission = new AbortController();
    const previous = registry.reserve("fixture", incarnation, [key], permission.signal, "lease");
    if (!previous) throw new Error("reservation missing");
    const lease = registry.register(previous, {
      key, vendor: "openai-compatible", secret: "entered-for-future", scheme: "bearer",
      audience: () => true, permissionSignal: permission.signal,
    });
    if (!lease || lease.exposure !== "lease") throw new Error("lease missing");
    const closed = vi.fn();
    lease.onClosed(closed);
    const secrets = (service as unknown as { secretStore: { set(key: string, value: string): Promise<void> } }).secretStore;
    // The entry's write fails only after the move's deletion has run.
    let rejectEntry!: (error: Error) => void;
    vi.spyOn(secrets, "set").mockImplementationOnce(
      () => new Promise((_, reject) => { rejectEntry = reject; }),
    );
    type Internals = { saveSettings(settings: unknown): Promise<void> };
    const realSave = (settings: unknown) => (SettingsService.prototype as unknown as Internals).saveSettings.call(service, settings);
    let entry: Promise<void> | undefined;
    let issuing: ReturnType<typeof registry.reserve> | undefined;
    let releaseSave!: () => void;
    let saveEntered!: () => void;
    const heldSave = new Promise<void>((resolve) => { releaseSave = resolve; });
    const atSave = new Promise<void>((resolve) => { saveEntered = resolve; });
    vi.spyOn(service as unknown as Internals, "saveSettings").mockImplementationOnce(async (settings) => {
      // The entry for the new address starts during the move, then fails.
      entry = service.setSecret(key, "entered-for-elsewhere");
      entry.catch(() => undefined);
      issuing = registry.reserve("fixture", incarnation, [key], permission.signal, "lease");
      saveEntered();
      await heldSave;
      await realSave(settings);
    });

    const moving = service.installMarketplaceProviderPreset({ ...preset, baseUrl: "https://elsewhere.example/v1" });
    await atSave;
    try {
      expect(service.getSecret(key)).toBeNull();
      expect(closed).toHaveBeenCalledWith("revoked");
    } finally {
      releaseSave();
    }
    await moving;
    rejectEntry(new Error("keychain locked"));
    await expect(entry).rejects.toThrow("keychain locked");

    // The key kept for the entry is the old address's: it is not handed out.
    expect(service.getSecret(key)).toBeNull();
    expect(closed).toHaveBeenCalledWith("revoked");
    if (!issuing) throw new Error("issuing reservation missing");
    expect(registry.register(issuing, {
      key, vendor: "openai-compatible", secret: "entered-for-elsewhere", scheme: "bearer",
      audience: () => true, permissionSignal: permission.signal,
    })).toBeNull();
  });

  it("deletes a key entered next to an earlier address when a later move lands", async () => {
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockedElectron.safeStorage.encryptString.mockImplementation(
      (value: string) => Buffer.from(`sealed:${value}`),
    );
    mockedElectron.safeStorage.decryptString.mockImplementation(
      (value: Buffer) => value.toString("utf-8").slice(7),
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    const key = marketplaceProviderPresetSecretKey("future-router");
    await service.installMarketplaceProviderPreset(preset);
    await service.setSecret(key, "entered-for-future");
    type Internals = { saveSettings(settings: unknown): Promise<void> };
    const realSave = (settings: unknown) => (SettingsService.prototype as unknown as Internals).saveSettings.call(service, settings);
    let second: Promise<unknown> | undefined;
    vi.spyOn(service as unknown as Internals, "saveSettings").mockImplementationOnce(async (settings) => {
      // During the first move, a key is entered next to its address, and a second move starts before the first finishes.
      await service.setSecret(key, "entered-for-second");
      second = service.installMarketplaceProviderPreset({ ...preset, baseUrl: "https://third.example/v1" });
      await realSave(settings);
    });

    await service.installMarketplaceProviderPreset({ ...preset, baseUrl: "https://second.example/v1" });
    await second;

    expect(service.get("marketplace").installedProviderPresets[0]?.baseUrl).toBe("https://third.example/v1");
    expect(service.getSecret(key)).toBeNull();
  });

  it("reads no key while its invalidation runs, except one entered again for the new address", async () => {
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockedElectron.safeStorage.encryptString.mockImplementation(
      (value: string) => Buffer.from(`sealed:${value}`),
    );
    mockedElectron.safeStorage.decryptString.mockImplementation(
      (value: Buffer) => value.toString("utf-8").slice(7),
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    const key = marketplaceProviderPresetSecretKey("future-router");
    await service.installMarketplaceProviderPreset(preset);
    await service.setSecret(key, "entered-for-future");
    const secrets = (service as unknown as { secretStore: { deleteMany(keys: string[]): Promise<number> } }).secretStore;
    const reads: Array<string | null> = [];
    vi.spyOn(secrets, "deleteMany").mockImplementationOnce(async () => {
      // The old key is still stored while the move's deletion runs.
      reads.push(service.getSecret(key), service.getEncryptedSecret(key));
      await service.setSecret(key, "entered-for-elsewhere");
      reads.push(service.getSecret(key));
      return 0;
    });

    await service.installMarketplaceProviderPreset({ ...preset, baseUrl: "https://elsewhere.example/v1" });

    expect(reads).toEqual([null, null, "entered-for-elsewhere"]);
    expect(service.getSecret(key)).toBe("entered-for-elsewhere");
  });

  it("leaves an active custom provider preset installed when preset-secret deletion fails", async () => {
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockedElectron.safeStorage.encryptString.mockImplementation(
      (value: string) => Buffer.from(`sealed:${value}`),
    );
    mockedElectron.safeStorage.decryptString.mockImplementation(
      (value: Buffer) => value.toString("utf-8").slice(7),
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const preset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    await service.patch({
      marketplace: { installedProviderPresets: [preset] },
    });
    await service.patch({
      llm: {
        provider: "openai-compatible",
        marketplaceProviderPresetId: "future-router",
        vendors: {
          "openai-compatible": {
            model: "future/free",
            baseUrl: "https://future.example/v1",
          },
        },
      },
    });
    await service.setSecret(
      marketplaceProviderPresetSecretKey("future-router"),
      "fr-secret",
    );
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);

    await expect(service.patch({
      marketplace: { installedProviderPresets: [] },
    })).rejects.toThrow("Host encryption is unavailable");

    expect(service.get("marketplace").installedProviderPresets).toEqual([preset]);
    expect(service.get("llm")).toMatchObject({
      provider: "openai-compatible",
      marketplaceProviderPresetId: "future-router",
    });
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    expect(service.getSecret(marketplaceProviderPresetSecretKey("future-router")))
      .toBe("fr-secret");

    await service.patch({
      marketplace: { installedProviderPresets: [] },
    });
    expect(service.get("marketplace").installedProviderPresets).toEqual([]);
    expect(service.getSecret(marketplaceProviderPresetSecretKey("future-router")))
      .toBeNull();
  });

  it("unmirrors a preset endpoint that an older install left in the generic block", () => {
    // Before the preset registry became the only owner of a preset's address, that address was copied into the generic openai-compatible block. On
    // this install it would now read as the generic custom-provider row's OWN saved endpoint, and saving that card would write it back as if typed.
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        llm: {
          provider: "openai-compatible",
          marketplaceProviderPresetId: "future-router",
          vendors: {
            "openai-compatible": { model: "future/free", baseUrl: "https://future.example/v1" },
          },
        },
        marketplace: {
          installedProviderPresets: [{
            providerId: "future-router",
            label: "Future Router",
            baseUrl: "https://future.example/v1",
            defaultModel: "future/free",
            modelOptions: ["future/free"],
            requiresApiKey: true,
          }],
        },
      }),
      "utf-8",
    );

    const llm = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm");

    expect(getLlmVendorSettings(llm.vendors, "openai-compatible").baseUrl)
      .toBeUndefined();
    // The route itself is untouched; the preset still owns its address.
    expect(llm.marketplaceProviderPresetId).toBe("future-router");
  });

  it("leaves a generic endpoint that matches no installed preset alone", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        llm: {
          provider: "openai-compatible",
          vendors: {
            "openai-compatible": { model: "local", baseUrl: "http://localhost:8001/v1" },
          },
        },
        marketplace: {
          installedProviderPresets: [{
            providerId: "future-router",
            label: "Future Router",
            baseUrl: "https://future.example/v1",
            defaultModel: "future/free",
            modelOptions: ["future/free"],
            requiresApiKey: true,
          }],
        },
      }),
      "utf-8",
    );

    const llm = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm");

    expect(getLlmVendorSettings(llm.vendors, "openai-compatible").baseUrl)
      .toBe("http://localhost:8001/v1");
  });

  it("leaves an installed preset's address alone when that preset is not the selected one", () => {
    // Only the SELECTED preset's address can be a mirror; that is the only one the old code ever wrote
    // here. This block holds another installed preset's URL, which nothing but the user could have typed.
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        llm: {
          provider: "openai-compatible",
          marketplaceProviderPresetId: "future-router",
          vendors: {
            "openai-compatible": { model: "local", baseUrl: "https://other.example/v1" },
          },
        },
        marketplace: {
          installedProviderPresets: [
            {
              providerId: "future-router",
              label: "Future Router",
              baseUrl: "https://future.example/v1",
              defaultModel: "future/free",
              modelOptions: ["future/free"],
              requiresApiKey: true,
            },
            {
              providerId: "other-router",
              label: "Other Router",
              baseUrl: "https://other.example/v1",
              defaultModel: "other/free",
              modelOptions: ["other/free"],
              requiresApiKey: true,
            },
          ],
        },
      }),
      "utf-8",
    );

    const llm = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm");

    expect(getLlmVendorSettings(llm.vendors, "openai-compatible").baseUrl)
      .toBe("https://other.example/v1");
  });

  it("gives the selected preset the shared model slot it used to fight over", () => {
    // One `model` served the generic custom-provider row and every preset reached through the same vendor, so the row picked last overwrote the
    // rest. The stored value belongs to the row this install is actually on. Use an explicit alternative so default cleanup does not clear this slot.
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        llm: {
          provider: "openai-compatible",
          marketplaceProviderPresetId: "future-router",
          vendors: {
            "openai-compatible": { model: "future/chosen", baseUrl: "http://localhost:8001/v1" },
          },
        },
        marketplace: {
          installedProviderPresets: [{
            providerId: "future-router",
            label: "Future Router",
            baseUrl: "https://future.example/v1",
            defaultModel: "future/free",
            modelOptions: ["future/free"],
            requiresApiKey: true,
          }],
        },
      }),
      "utf-8",
    );

    const llm = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm");
    const block = getLlmVendorSettings(llm.vendors, "openai-compatible");

    expect(block.presetModels).toEqual({ "future-router": "future/chosen" });
    // The generic row starts empty, so its chooser shows what its OWN endpoint answers rather than a model borrowed from a gateway.
    expect(block.model).toBe("");
    expect(block.baseUrl).toBe("http://localhost:8001/v1");
  });

  it("persists and merges model image declarations, clears only the selected model, and retains inactive configuration", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const first = llmImageInputKey("opaque-model");
    const second = llmImageInputKey("other-model", "fixture-provider");
    await service.patch({ llm: { provider: "openai-compatible", vendors: { "openai-compatible": { imageInput: { [first]: true } } } } });
    await service.patch({ llm: { vendors: { "openai-compatible": { imageInput: { [second]: false } } } } });
    expect(getLlmVendorSettings(service.get("llm").vendors, "openai-compatible").imageInput).toEqual({ [first]: true, [second]: false });
    await service.patch({ llm: { provider: "openai", vendors: { "openai-compatible": { imageInput: { [first]: undefined } } } } });
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(getLlmVendorSettings(reloaded.get("llm").vendors, "openai-compatible").imageInput).toEqual({ [second]: false });
    expect(JSON.parse(readFileSync(join(userDataPath, "ave-settings.json"), "utf8")).llm.vendors["openai-compatible"].imageInput).toEqual({ [second]: false });
  });

  it("retains an inactive optional provider customized only by image input across pruning and reload", async () => {
    const model = "llama-3.3-70b-versatile";
    const key = llmImageInputKey(model);
    writeFileSync(join(userDataPath, "ave-settings.json"), JSON.stringify({
      llm: { provider: "openai", vendors: { groq: { imageInput: { [key]: false } } } },
    }));
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("marketplace").installedProviderIds).toContain("groq");
    expect(service.get("llm").vendors.groq?.model).toBe("");
    expect(service.get("llm").vendors.groq?.imageInput).toEqual({ [key]: false });
    await service.patch({ llm: { provider: "groq" } });
    await service.patch({ llm: { provider: "openai" } });
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("llm").provider).toBe("openai");
    expect(reloaded.get("marketplace").installedProviderIds).toContain("groq");
    expect(reloaded.get("llm").vendors.groq?.model).toBe("");
    expect(reloaded.get("llm").vendors.groq?.imageInput).toEqual({ [key]: false });
  });

  it("merges one preset's model into the map instead of replacing it", async () => {
    // The renderer sends the key it just chose and nothing else, so the store has to merge: replacing the map
    // would delete every other preset's model on every pick; including one another window chose a moment ago.
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        llm: {
          provider: "openai-compatible",
          vendors: {
            "openai-compatible": {
              model: "local-model",
              presetModels: { "beta-gw": "beta/chosen" },
            },
          },
        },
      }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

    await service.patch({
      llm: { vendors: { "openai-compatible": { presetModels: { "alpha-gw": "alpha/chosen" } } } },
    });

    const block = getLlmVendorSettings(service.get("llm").vendors, "openai-compatible");
    expect(block.presetModels).toEqual({ "beta-gw": "beta/chosen", "alpha-gw": "alpha/chosen" });
    // And the generic row's own model, which the patch never named, is intact.
    expect(block.model).toBe("local-model");
  });

  it("clears one preset's model when its route is saved with none", async () => {
    // An empty model is what "not configured yet" looks like for this family (the openai-compatible default model is ""), and the
    // provider builder reads an empty model as not-configured. So the key goes away rather than keeping a value the user has moved off.
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        llm: {
          provider: "openai-compatible",
          vendors: {
            "openai-compatible": {
              presetModels: { "alpha-gw": "alpha/chosen", "beta-gw": "beta/chosen" },
            },
          },
        },
      }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

    await service.patch({
      llm: { vendors: { "openai-compatible": { presetModels: { "alpha-gw": "" } } } },
    });

    expect(getLlmVendorSettings(service.get("llm").vendors, "openai-compatible").presetModels)
      .toEqual({ "beta-gw": "beta/chosen" });
  });

  it("leaves the model with the generic row when no preset is selected", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        llm: {
          provider: "openai-compatible",
          vendors: {
            "openai-compatible": { model: "local-model", baseUrl: "http://localhost:8001/v1" },
          },
        },
      }),
      "utf-8",
    );

    const block = getLlmVendorSettings(
      new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm").vendors,
      "openai-compatible",
    );

    expect(block.model).toBe("local-model");
    expect(block.presetModels).toBeUndefined();
  });

});

describe("SettingsService removes plugin-specific legacy host settings", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-legacy-plugin-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("drops legacy sampleMail blocks from loaded and saved settings", async () => {
    const settingsPath = join(userDataPath, "ave-settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        sampleMail: { enabled: true, tenantId: "legacy" },
        chat: { systemPrompt: "preserved", autoCompact: false },
      }),
      "utf-8",
    );

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.getAll()).not.toHaveProperty("sampleMail");

    await service.patch({ sampleMail: { enabled: true } } as never);
    expect(service.getAll()).not.toHaveProperty("sampleMail");
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).not.toHaveProperty("sampleMail");
  });
});

describe("SettingsService removed manual host-resolver map", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-host-map-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  // The manual host-resolver map was removed with the private-endpoint access path. A value written by an older build is inert, but it is a user-authored
  // internal-hostname mapping; the load path must drop it so the next write erases it from disk rather than leaving it persisted with nothing acting on it.
  it("drops a persisted llm.hostResolverMap on load and on the next write", async () => {
    const settingsPath = join(userDataPath, "ave-settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        llm: {
          provider: "openai",
          hostResolverMap: "10.0.0.10 internal-endpoint.example.com",
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    // Sibling llm fields still load; the drop is selective, not the whole block.
    expect(service.get("llm").provider).toBe("openai");
    expect(service.get("llm")).not.toHaveProperty("hostResolverMap");

    await service.patch({ llm: { streamSmoothing: "word" } });
    expect(service.get("llm").streamSmoothing).toBe("word");
    expect(service.get("llm")).not.toHaveProperty("hostResolverMap");
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf-8")) as { llm: Record<string, unknown> };
    expect(onDisk.llm).not.toHaveProperty("hostResolverMap");
    expect(JSON.stringify(onDisk)).not.toContain("internal-endpoint.example.com");
  });

  // A patch cannot reintroduce the key either; `llm` is rebuilt field by field from a fixed literal, so an unknown key never survives normalization.
  it("ignores an attempt to write llm.hostResolverMap back", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

    await service.patch({ llm: { hostResolverMap: "10.0.0.11 other.example.com" } } as never);

    expect(service.get("llm")).not.toHaveProperty("hostResolverMap");
    const settingsPath = join(userDataPath, "ave-settings.json");
    expect(readFileSync(settingsPath, "utf-8")).not.toContain("other.example.com");
  });
});

describe("SettingsService plugin uninstall cleanup", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-plugin-cleanup-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("deletes only the selected plugin config", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

    await service.setPluginConfig("meeting", { apiKey: "abc" });
    await service.setPluginConfig("calendar", { tenant: "example" });
    await service.deletePluginConfig("meeting");

    expect(service.getPluginConfig("meeting")).toEqual({});
    expect(service.getPluginConfig("calendar")).toEqual({ tenant: "example" });
  });

  it("deletes only requested secret keys for the selected plugin", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });

    await service.setSecret("plugin.meeting.token", "abc");
    await service.setSecret("plugin.meeting.unlisted", "preserved");
    await service.setSecret("plugin.meeting_extra.token", "preserved");
    await service.setSecret("llm.apiKey.openai", "preserved");

    await expect(service.deletePluginSecrets("meeting", ["token"])).resolves.toBe(1);

    expect(service.getSecret("plugin.meeting.token")).toBeNull();
    expect(service.getSecret("plugin.meeting.unlisted")).toBe("preserved");
    expect(service.getSecret("plugin.meeting_extra.token")).toBe("preserved");
    expect(service.getSecret("llm.apiKey.openai")).toBe("preserved");
  });

  it("does not delete another dotted plugin id's secret by prefix", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });

    await service.setSecret("plugin.com.example.token", "abc");
    await service.setSecret("plugin.com.example.mail.token", "preserved");

    await expect(service.deletePluginSecrets("com.example", ["token"])).resolves.toBe(1);

    expect(service.getSecret("plugin.com.example.token")).toBeNull();
    expect(service.getSecret("plugin.com.example.mail.token")).toBe("preserved");
  });
});

describe("SettingsService role presets", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-roles-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("ignores unknown on-disk sections without resetting unrelated sections", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({
        unknownSection: { foo: "bar" },
        chat: { systemPrompt: "preserved-prompt", autoCompact: false },
      }),
      "utf-8",
    );

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("chat").systemPrompt).toBe("preserved-prompt");
    expect(service.get("chat").autoCompact).toBe(false);
  });

  it("defaults idle preference refresh off and normalizes the flag to boolean only", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("features")?.idlePreferenceRefresh).toBe(false);

    await service.patch({ features: { idlePreferenceRefresh: false } });
    expect(service.get("features")?.idlePreferenceRefresh).toBe(false);

    // A non-boolean patch is rejected; the value stays at its current `false` instead of silently changing the user's opt-in choice.
    await service.patch({ features: { idlePreferenceRefresh: "yes" } as never });
    expect(service.get("features")?.idlePreferenceRefresh).toBe(false);

    await service.patch({ features: { idlePreferenceRefresh: true } });
    expect(service.get("features")?.idlePreferenceRefresh).toBe(true);
  });

  it("defaults idle long-term-memory consolidation off and accepts booleans only", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("features")?.idleMemoryConsolidation).toBe(false);

    await service.patch({ features: { idleMemoryConsolidation: false } });
    expect(service.get("features")?.idleMemoryConsolidation).toBe(false);

    // A non-boolean must not silently opt a user into provider-backed idle work.
    await service.patch({ features: { idleMemoryConsolidation: "yes" } as never });
    expect(service.get("features")?.idleMemoryConsolidation).toBe(false);

    await service.patch({ features: { idleMemoryConsolidation: true } });
    expect(service.get("features")?.idleMemoryConsolidation).toBe(true);
  });

  it("defaults LLM-reviewed memory capture off and accepts only the supported modes", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("features")?.memoryCaptureMode).toBe("off");

    await service.patch({ features: { memoryCaptureMode: "review" } });
    expect(service.get("features")?.memoryCaptureMode).toBe("review");
    await service.patch({ features: { memoryCaptureMode: "auto" } });
    expect(service.get("features")?.memoryCaptureMode).toBe("auto");

    // Invalid data must not silently alter the user's provider-backed capture choice.
    await service.patch({ features: { memoryCaptureMode: "always" as never } });
    expect(service.get("features")?.memoryCaptureMode).toBe("auto");
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("features")?.memoryCaptureMode).toBe("auto");

    const corruptPath = mkdtempSync(join(tmpdir(), "settings-memory-capture-mode-"));
    try {
      writeFileSync(
        join(corruptPath, "ave-settings.json"),
        currentSettingsJson({ features: { memoryCaptureMode: "always" } }),
        "utf-8",
      );
      expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath: corruptPath }).get("features")?.memoryCaptureMode).toBe("off");
    } finally {
      await cleanupTmpDir(corruptPath);
    }
  });

  it("keeps the A2A loopback server off by default and accepts booleans only", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("features")?.a2aLoopbackServer).toBe(false);

    await service.patch({ features: { a2aLoopbackServer: true } });
    expect(service.get("features")?.a2aLoopbackServer).toBe(true);

    await service.patch({ features: { a2aLoopbackServer: "yes" } as never });
    expect(service.get("features")?.a2aLoopbackServer).toBe(true);

    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("features")?.a2aLoopbackServer).toBe(true);
  });

  it("keeps host risk classification enabled and plugin-worker confinement opt-in", () => {
    // pluginWorkerConfinement (workers, plugin children, plugin hooks, MCP servers) ships OFF
    // everywhere. It is separate from osToolSandbox so the shell default cannot confine workers on its own.
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("features")?.hostClassifiesRisk ?? false).toBe(true);
    expect(service.get("features")?.pluginWorkerConfinement).toBe(false);
  });

  it("ships shell egress asks ON and keeps a stored opt-out", async () => {
    // With asks on, a sandboxed shell that reaches an ungranted host gets an approval card; off, it is refused and only granted hosts work.
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("features")?.shellEgressAsk)
      .toBe(true);
    writeFileSync(join(userDataPath, "ave-settings.json"), JSON.stringify({ features: { shellEgressAsk: false } }), "utf-8");
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("features")?.shellEgressAsk)
      .toBe(false);
  });

  // Re-import after replacing the host platform: defaults are evaluated once.
  it.each([
    ["darwin", true],
    ["linux", true],
    ["win32", false],
    ["freebsd", false],
  ] as const)(
    "osToolSandbox default on %s = %s",
    async (platform, expected) => {
      const original = process.platform;
      const dir = mkdtempSync(join(tmpdir(), "settings-store-truthtable-"));
      try {
        setProcessPlatform(platform);
        vi.resetModules();
        const { SettingsService: FreshSettingsService } = await import(
          "../settings-store.js"
        );
        const service = new FreshSettingsService({ userDataPath: dir, encryption: mockedElectron.safeStorage });
        expect(service.get("features")?.osToolSandbox ?? false).toBe(expected);
      } finally {
        setProcessPlatform(original);
        vi.resetModules();
        await cleanupTmpDir(dir);
      }
    },
  );

  it.each([true, false])("preserves an explicit sandbox setting of %s across reload", async (enabled) => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ features: { osToolSandbox: enabled } });
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("features")?.osToolSandbox).toBe(enabled);
  });
});

describe("SettingsService LLM per-vendor patching", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-llm-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("rewrites a stored retired default endpoint on every load, and keeps any other endpoint", async () => {
    const settingsFile = join(userDataPath, "ave-settings.json");
    const write = () => writeFileSync(settingsFile, JSON.stringify({
      marketplace: { installedProviderIds: ["baseten", "nebius", "together"] },
      llm: {
        provider: "baseten",
        vendors: {
          // The default baseUrl every saved block carried before: this host does not resolve.
          baseten: { model: "deepseek-ai/DeepSeek-V3.1", baseUrl: "https://model-api.baseten.co/v1" },
          nebius: { model: "nvidia/nemotron-3-super-120b-a12b", baseUrl: "https://api.studio.nebius.ai/v1" },
          together: { model: "fixture-model", baseUrl: "https://proxy.example.invalid/v1" },
        },
      },
    }));
    write();
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const vendors = service.get("llm").vendors;
    expect(vendors.baseten?.baseUrl).toBe("https://inference.baseten.co/v1");
    expect(vendors.nebius?.baseUrl).toBe("https://api.tokenfactory.nebius.com/v1");
    expect(vendors.together?.baseUrl).toBe("https://proxy.example.invalid/v1");
    await service.patch({});
    expect(JSON.parse(readFileSync(settingsFile, "utf-8")).llm.vendors.baseten.baseUrl).toBe("https://inference.baseten.co/v1");

    // An older build reinstalled over this one writes the retired default back; the next load rewrites it again, with no marker to stop it.
    const applied = JSON.parse(readFileSync(settingsFile, "utf-8")).appliedMigrations as string[];
    writeFileSync(settingsFile, JSON.stringify({
      appliedMigrations: applied,
      marketplace: { installedProviderIds: ["baseten"] },
      llm: { provider: "baseten", vendors: { baseten: { model: "deepseek-ai/DeepSeek-V3.1", baseUrl: "https://model-api.baseten.co/v1" } } },
    }));
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("llm").vendors.baseten?.baseUrl).toBe("https://inference.baseten.co/v1");
  });

  it("keeps an endpoint on the same vendor that only resembles the retired default", () => {
    writeFileSync(join(userDataPath, "ave-settings.json"), JSON.stringify({
      marketplace: { installedProviderIds: ["baseten", "nebius"] },
      llm: {
        provider: "baseten",
        vendors: {
          // A trailing slash, and a proxy in front of the old path: the user typed these.
          baseten: { model: "deepseek-ai/DeepSeek-V3.1", baseUrl: "https://model-api.baseten.co/v1/" },
          nebius: { model: "nvidia/nemotron-3-super-120b-a12b", baseUrl: "https://nebius-proxy.example.invalid/v1" },
        },
      },
    }));
    const vendors = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm").vendors;
    expect(vendors.baseten?.baseUrl).toBe("https://model-api.baseten.co/v1/");
    expect(vendors.nebius?.baseUrl).toBe("https://nebius-proxy.example.invalid/v1");
  });

  it("bounds legacy profile budgets and persists the normalized value without changing the output cap", async () => {
    writeFileSync(join(userDataPath, "ave-settings.json"), JSON.stringify({
      llm: {
        provider: "openai",
        vendors: { openai: { model: "fixture-model", enableThinking: true, thinkingBudgetTokens: 24_000, outputTokenLimit: 32_000 } },
      },
    }));
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    // The stored 32000 is the old materialized default (no migration marker), so it becomes the host default; the budget is bounded against the same 32000.
    expect(service.get("llm").vendors.openai).toMatchObject({
      model: "fixture-model", enableThinking: true, thinkingBudgetTokens: 16_000,
    });
    expect(service.get("llm").vendors.openai?.outputTokenLimit).toBeUndefined();
    await service.patch({ llm: { vendors: { openai: { thinkingBudgetTokens: 14_000 } } } });
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("llm").vendors.openai).toMatchObject({ thinkingBudgetTokens: 14_000 });
    expect(reloaded.get("llm").vendors.openai?.outputTokenLimit).toBeUndefined();
  });

  it("clamps thinking on patches and output changes while preserving unrelated vendor fields", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ llm: { vendors: { "openai-compatible": {
      model: "fixture-model", baseUrl: "https://provider.example/v1", enableThinking: false,
      contextWindow: 128_000, outputTokenLimit: 32_000, thinkingBudgetTokens: 32_000,
    } } } });
    expect(service.get("llm").vendors["openai-compatible"]?.thinkingBudgetTokens).toBe(16_000);
    await service.patch({ llm: { vendors: { "openai-compatible": { outputTokenLimit: 16_000 } } } });
    expect(service.get("llm").vendors["openai-compatible"]).toMatchObject({
      model: "fixture-model", baseUrl: "https://provider.example/v1", enableThinking: false,
      contextWindow: 128_000, outputTokenLimit: 16_000, thinkingBudgetTokens: 8_000,
    });
    await service.patch({ llm: { vendors: { "openai-compatible": { outputTokenLimit: 64_000 } } } });
    expect(service.get("llm").vendors["openai-compatible"]?.thinkingBudgetTokens).toBe(8_000);
    await service.patch({ llm: { vendors: { "openai-compatible": { thinkingBudgetTokens: 48_000 } } } });
    expect(service.get("llm").vendors["openai-compatible"]?.thinkingBudgetTokens).toBe(32_000);
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("llm").vendors["openai-compatible"]).toEqual(service.get("llm").vendors["openai-compatible"]);
  });

  it("retains an inactive provider customized only by its output cap across pruning and reload", async () => {
    writeFileSync(join(userDataPath, "ave-settings.json"), JSON.stringify({
      llm: { provider: "openai", vendors: { groq: { outputTokenLimit: 64_000 } } },
    }));
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("llm").vendors.groq).toMatchObject({ outputTokenLimit: 64_000, thinkingBudgetTokens: 8_000 });
    expect(service.get("marketplace").installedProviderIds).toContain("groq");
    await service.patch({ llm: { provider: "groq" } });
    await service.patch({ llm: { provider: "openai" } });
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("llm").provider).toBe("openai");
    expect(reloaded.get("llm").vendors.groq).toMatchObject({ outputTokenLimit: 64_000, thinkingBudgetTokens: 8_000 });
    await reloaded.patch({ llm: { provider: "groq", vendors: { groq: { thinkingBudgetTokens: 40_000 } } } });
    expect(reloaded.get("llm").vendors.groq).toMatchObject({ outputTokenLimit: 64_000, thinkingBudgetTokens: 32_000 });
  });

  it("round-trips a per-vendor output ceiling through patch", async () => {
    // The ceiling is the only brake on a runaway round, and it is configured rather than assumed;
    // so it has to survive the write path a caller actually uses, not just the block normalizer.
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({
      llm: { vendors: { "openai-compatible": { outputTokenLimit: 16_384 } } },
    });
    expect(service.get("llm").vendors["openai-compatible"]?.outputTokenLimit)
      .toBe(16_384);
  });

  it("fresh installs persist only default-visible provider blocks", () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const llm = service.get("llm");

    expect(llm.provider).toBe(DEFAULT_LLM_VENDOR);
    expect(Object.keys(llm.vendors).sort()).toEqual([
      "claude",
      "gemini",
      "openai",
      "openai-compatible",
      "openrouter",
    ]);
    expect(llm.vendors["azure-foundry"]).toBeUndefined();
    expect(getLlmVendorSettings(llm.vendors, "azure-foundry").model).toBe("");
  });

  it("migrates legacy API provider/model settings to the API chat runtime", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        llm: {
          provider: "openai",
          vendors: { openai: { model: "gpt-5-turbo" } },
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const llm = service.get("llm");

    expect(llm.activeChatRuntime).toEqual({ kind: "api" });
    expect(llm.provider).toBe("openai");
    expect(getLlmVendorSettings(llm.vendors, "openai").model).toBe("gpt-5-turbo");
  });

  it("keeps API configuration and secrets while selecting a subscription runtime", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    await service.patch({
      llm: {
        provider: "openai",
        vendors: { openai: { model: "gpt-5-turbo" } },
      },
    });
    await service.setSecret("llm.apiKey.openai", "existing-api-key");

    await service.patch({
      llm: {
        activeChatRuntime: {
          kind: "subscription",
          provider: "codex",
          model: " gpt-5.4 ",
        },
      },
    });

    const llm = service.get("llm");
    expect(llm.activeChatRuntime).toEqual({
      kind: "subscription",
      provider: "codex",
      model: "gpt-5.4",
    });
    expect(llm.provider).toBe("openai");
    expect(getLlmVendorSettings(llm.vendors, "openai").model).toBe("gpt-5-turbo");
    expect(service.getSecret("llm.apiKey.openai")).toBe("existing-api-key");

    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    expect(reloaded.get("llm").activeChatRuntime).toEqual(llm.activeChatRuntime);
    expect(reloaded.getSecret("llm.apiKey.openai")).toBe("existing-api-key");
  });

  it("drops invalid subscription models without changing the selected runtime", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({
      llm: {
        activeChatRuntime: {
          kind: "subscription",
          provider: "kimi-code",
          model: "x".repeat(MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH + 1),
        },
      },
    });

    expect(service.get("llm").activeChatRuntime).toEqual({
      kind: "subscription",
      provider: "kimi-code",
    });
  });

  it.each(["kimi-code", "grok-build"] as const)(
    "drops a legacy ACP model selection while retaining %s",
    async (provider) => {
      writeFileSync(
        join(userDataPath, "ave-settings.json"),
        JSON.stringify({
          llm: {
            activeChatRuntime: {
              kind: "subscription",
              provider,
              model: "legacy-provider-model",
            },
          },
        }),
        "utf-8",
      );

      const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
      expect(service.get("llm").activeChatRuntime).toEqual({
        kind: "subscription",
        provider,
      });
    },
  );

  it("fails closed unknown subscription runtime ids while preserving API settings", async () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        llm: {
          activeChatRuntime: {
            kind: "subscription",
            provider: "removed-runtime",
            model: "untrusted-model",
          },
          provider: "openai",
          vendors: { openai: { model: "gpt-5-turbo" } },
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    await service.setSecret("llm.apiKey.openai", "existing-api-key");
    expect(service.get("llm").activeChatRuntime).toEqual({ kind: "api" });
    expect(service.get("llm").provider).toBe("openai");
    expect(getLlmVendorSettings(service.get("llm").vendors, "openai").model)
      .toBe("gpt-5-turbo");

    await service.patch({
      llm: {
        activeChatRuntime: {
          kind: "subscription",
          provider: "unknown-runtime",
        } as never,
      },
    });

    expect(service.get("llm").activeChatRuntime).toEqual({ kind: "api" });
    expect(service.getSecret("llm.apiKey.openai")).toBe("existing-api-key");
  });

  it("prunes legacy default marketplace vendor blocks while preserving custom ones", () => {
    const legacyVendors = freshAllVendorBlocks();
    legacyVendors.groq.model = "llama-3.3-70b-versatile";
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        llm: {
          provider: "openai",
          vendors: legacyVendors,
          fallbackChain: [],
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const settings = service.getAll();

    expect(settings.llm.vendors["azure-foundry"]).toBeUndefined();
    expect(settings.llm.vendors.ollama).toBeUndefined();
    expect(getLlmVendorSettings(settings.llm.vendors, "groq").model).toBe(
      "llama-3.3-70b-versatile",
    );
    expect(settings.marketplace.installedProviderIds).toEqual(["groq"]);
  });

  it("rejects uninstalled marketplace providers as active or fallback providers", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

    await service.patch({
      llm: {
        provider: "groq",
        vendors: { groq: { model: "llama-3.3-70b-versatile" } },
        fallbackChain: [{ provider: "ollama", model: "llama3.3" }],
      },
    });

    const llm = service.get("llm");
    expect(llm.provider).toBe(DEFAULT_LLM_VENDOR);
    expect(llm.fallbackChain).toEqual([]);
    expect(llm.vendors.groq).toBeUndefined();
    expect(llm.vendors.ollama).toBeUndefined();
    expect(service.get("marketplace").installedProviderIds).toEqual([]);
  });

  it("persists model list cache and prunes uninstalled marketplace provider caches", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

    await service.patch({
      marketplace: { installedProviderIds: ["groq"] },
      llm: {
        modelListCache: {
          [llmModelListCacheKey("openrouter")]: {
            vendor: "openrouter",
            endpoint: "https://openrouter.ai/api/v1/models",
            models: ["openrouter/free", "openai/gpt-5.4"],
            modelEntries: [
              {
                id: "openrouter/free",
                name: "Free Router",
                contextLength: 128_000,
                pricing: { prompt: "0", completion: "0" },
                tags: { free: true, router: true },
              },
              {
                id: "not-in-models",
                name: "Should be pruned",
              },
            ],
            fetchedAt: "2026-07-06T00:00:00.000Z",
          },
          [llmModelListCacheKey("groq")]: {
            vendor: "groq",
            endpoint: "https://api.groq.com/openai/v1/models",
            models: ["llama-3.3-70b-versatile"],
            fetchedAt: "2026-07-06T00:00:00.000Z",
          },
          malformed: {
            vendor: "openrouter",
            endpoint: "file:///tmp/models.json",
            models: ["bad"],
            fetchedAt: "2026-07-06T00:00:00.000Z",
          },
        },
      },
    });

    expect(Object.keys(service.get("llm").modelListCache).sort()).toEqual([
      llmModelListCacheKey("groq"),
      llmModelListCacheKey("openrouter"),
    ].sort());

    await service.patch({ marketplace: { installedProviderIds: [] } });

    expect(service.get("llm").modelListCache).toEqual({
      [llmModelListCacheKey("openrouter")]: {
        vendor: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/models",
        models: ["openrouter/free", "openai/gpt-5.4"],
        modelEntries: [
          {
            id: "openrouter/free",
            name: "Free Router",
            contextLength: 128_000,
            pricing: { prompt: "0", completion: "0" },
            tags: { free: true, router: true },
          },
        ],
        fetchedAt: "2026-07-06T00:00:00.000Z",
      },
    });
  });

  it("prunes manual and static marketplace provider model list caches", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

    await service.patch({
      marketplace: {
        installedProviderPresets: [
          {
            providerId: "manual-router",
            label: "Manual Router",
            baseUrl: "https://manual.example/v1",
            defaultModel: "manual/default",
            modelOptions: ["manual/default"],
            requiresApiKey: true,
            modelDiscoveryPolicy: "manual",
          },
          {
            providerId: "static-router",
            label: "Static Router",
            baseUrl: "https://static.example/v1",
            defaultModel: "static/default",
            modelOptions: ["static/default"],
            requiresApiKey: true,
            modelDiscoveryPolicy: "static",
          },
          {
            providerId: "dynamic-router",
            label: "Dynamic Router",
            baseUrl: "https://dynamic.example/v1",
            defaultModel: "dynamic/default",
            modelOptions: ["dynamic/default"],
            requiresApiKey: true,
            modelDiscoveryPolicy: "models-api",
          },
        ],
      },
      llm: {
        modelListCache: {
          [llmModelListCacheKey(
            "openai-compatible",
            "https://manual.example/v1",
            "manual-router",
          )]: {
            vendor: "openai-compatible",
            baseUrl: "https://manual.example/v1",
            credentialScope: "manual-router",
            endpoint: "https://manual.example/v1/models",
            models: ["cached/manual-only"],
            fetchedAt: "2026-07-06T00:00:00.000Z",
          },
          [llmModelListCacheKey(
            "openai-compatible",
            "https://static.example/v1",
            "static-router",
          )]: {
            vendor: "openai-compatible",
            baseUrl: "https://static.example/v1",
            credentialScope: "static-router",
            endpoint: "https://static.example/v1/models",
            models: ["cached/static-only"],
            fetchedAt: "2026-07-06T00:00:00.000Z",
          },
          [llmModelListCacheKey(
            "openai-compatible",
            "https://dynamic.example/v1",
            "dynamic-router",
          )]: {
            vendor: "openai-compatible",
            baseUrl: "https://dynamic.example/v1",
            credentialScope: "dynamic-router",
            endpoint: "https://dynamic.example/v1/models",
            models: ["dynamic/discovered"],
            fetchedAt: "2026-07-06T00:00:00.000Z",
          },
        },
      },
    });

    expect(service.get("llm").modelListCache).toEqual({
      [llmModelListCacheKey(
        "openai-compatible",
        "https://dynamic.example/v1",
        "dynamic-router",
      )]: {
        vendor: "openai-compatible",
        baseUrl: "https://dynamic.example/v1",
        credentialScope: "dynamic-router",
        endpoint: "https://dynamic.example/v1/models",
        models: ["dynamic/discovered"],
        fetchedAt: "2026-07-06T00:00:00.000Z",
      },
    });
  });

  it("allows installed marketplace providers and removes them durably on uninstall", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

    await service.patch({
      marketplace: { installedProviderIds: ["groq", "ollama"] },
      llm: {
        provider: "groq",
        vendors: { groq: { model: "llama-3.3-70b-versatile" } },
        fallbackChain: [{ provider: "ollama", model: "llama3.3" }],
      },
    });
    expect(service.get("llm").provider).toBe("groq");
    expect(service.get("llm").fallbackChain).toEqual([
      { provider: "ollama", model: "llama3.3" },
    ]);

    await service.patch({
      marketplace: { installedProviderIds: [] },
    });
    const settings = service.getAll();
    expect(settings.llm.provider).toBe(DEFAULT_LLM_VENDOR);
    expect(settings.llm.fallbackChain).toEqual([]);
    expect(settings.llm.vendors.groq).toBeUndefined();
    expect(settings.llm.vendors.ollama).toBeUndefined();
    expect(settings.marketplace.installedProviderIds).toEqual([]);
  });

  // Regression for the bug shipped + reverted between #279 and the per-vendor refactor: switching the active provider used to carry the previous vendor's model into the new vendor's persisted block. With per-vendor
  // lazy blocks, a patch touching only `azure-foundry` MUST leave every other materialized vendor's settings intact. CTRL simplification: test rewritten to use `model` instead of the removed `maxOutputTokens` field.
  it("vendor switch + save does not leak model across vendors", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

    // Establish a non-default OpenAI model (simulating a user who switched to a specific model for OpenAI).
    await service.patch({
      llm: {
        provider: "openai",
        vendors: { openai: { model: "gpt-5-turbo" } },
      },
    });

    await service.patch({
      marketplace: { installedProviderIds: ["azure-foundry"] },
    });

    // User switches to azure-foundry and saves a deployment name. The id is kept as saved (no name list rewrites it), and the patch must not leak across vendor blocks.
    await service.patch({
      llm: {
        provider: "azure-foundry",
        vendors: { "azure-foundry": { model: "gpt-4o" } },
      },
    });

    const llm = service.get("llm");
    expect(llm.provider).toBe("azure-foundry");
    expect(getLlmVendorSettings(llm.vendors, "azure-foundry").model).toBe("gpt-4o");
    // The OpenAI block must still hold the user-tuned value, not be overwritten by the Foundry save.
    expect(getLlmVendorSettings(llm.vendors, "openai").model).toBe("gpt-5-turbo");
  });

  it("replaceLlm removes optional transport fields that merge patches would retain", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const original = service.get("llm");

    await service.patch({
      llm: {
        provider: "openai",
        vendors: {
          openai: {
            baseUrl: "https://proxy.example/v1",
            vertexProject: "should-clear",
            vertexLocation: "us-central1",
          },
        },
      },
    });
    await service.replaceLlm(original);

    const llm = service.get("llm");
    const openai = getLlmVendorSettings(llm.vendors, "openai");
    expect(openai.baseUrl).toBeUndefined();
    expect(openai.vertexProject).toBeUndefined();
    expect(openai.vertexLocation).toBeUndefined();
  });

  it("coerces a stale unknown provider on disk to the default", () => {
    // Simulate an old install where the user had a since-removed vendor selected. Without
    // coercion, `llm.vendors[llm.provider]` would be undefined and crash refreshProvider at first turn.
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({ llm: { provider: "unknown-vendor" } }),
      "utf-8",
    );

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const llm = service.get("llm");

    expect(llm.provider).toBe(DEFAULT_LLM_VENDOR);
    expect(getLlmVendorSettings(llm.vendors, llm.provider)).toBeDefined();
  });
});

describe("SettingsService webView (B1 — external URL viewer policy)", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-webview-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("defaults preferredFlow to 'in-app' on a fresh install", () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("webView")).toEqual({ preferredFlow: "in-app" });
  });

  it("applies default 'in-app' when webView field is absent on disk (legacy settings.json)", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({ marketplace: { updateCheckEnabled: true } }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("webView")).toEqual({ preferredFlow: "in-app" });
  });

  it("round-trips a system-browser preference across restart", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ webView: { preferredFlow: "system-browser" } });
    expect(service.get("webView")).toEqual({ preferredFlow: "system-browser" });

    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("webView")).toEqual({ preferredFlow: "system-browser" });
  });

  // Critic F4 mitigation: schema-invalid value falls back to default for THIS field only; other settings sections must remain intact.
  it.each([
    ["string-not-in-enum", "yes"],
    ["null", null],
    ["number", 42],
    ["array", ["in-app"]],
  ])("falls back to default when preferredFlow is invalid (%s) without resetting unrelated settings", (_label, badValue) => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({
        webView: { preferredFlow: badValue },
        chat: { systemPrompt: "preserved-prompt", autoCompact: false },
        marketplace: { updateCheckEnabled: false },
      }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("webView")).toEqual({ preferredFlow: "in-app" });
    // Unrelated sections must be preserved (no full default reset).
    expect(service.get("chat").systemPrompt).toBe("preserved-prompt");
    expect(service.get("chat").autoCompact).toBe(false);
    expect(service.get("marketplace").updateCheckEnabled).toBe(false);
  });

  it("falls back to default when webView block is not an object", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({ webView: "garbage" }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("webView")).toEqual({ preferredFlow: "in-app" });
  });

  // The patch path is the trust boundary: `CHANNELS.settings.update` forwards the renderer payload to `patch()` without a schema check, so an out-of-enum
  // `preferredFlow` used to be spread straight into settings.json and was only dropped on the NEXT load. Both paths now share `isWebViewPreferredFlow`.
  it.each([
    ["string-not-in-enum", "yes"],
    ["null", null],
    ["number", 42],
    ["array", ["in-app"]],
    ["object", { preferredFlow: "in-app" }],
  ])("ignores an invalid preferredFlow patch (%s) and keeps the stored preference", async (_label, badValue) => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ webView: { preferredFlow: "system-browser" } });

    await service.patch({
      webView: { preferredFlow: badValue as never },
    });

    expect(service.get("webView")).toEqual({ preferredFlow: "system-browser" });
    // The rejected value must not reach disk either; otherwise the next load would silently reset the user's choice to the default.
    const onDisk = JSON.parse(readFileSync(join(userDataPath, "ave-settings.json"), "utf-8")) as {
      webView: { preferredFlow: unknown };
    };
    expect(onDisk.webView).toEqual({ preferredFlow: "system-browser" });
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("webView")).toEqual({
      preferredFlow: "system-browser",
    });
  });

  it("keeps a valid preferredFlow patch working after validation", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ webView: { preferredFlow: "system-browser" } });
    expect(service.get("webView")).toEqual({ preferredFlow: "system-browser" });
    await service.patch({ webView: { preferredFlow: "in-app" } });
    expect(service.get("webView")).toEqual({ preferredFlow: "in-app" });
  });

  // Consumer-side proof, driven by the REAL producer (SettingsService.patch), not a hand-built settings object: `routeExternalUrl` reads the live preferredFlow and treats anything that is not exactly "system-browser"
  // as "in-app". A hostile/malformed patch therefore used to silently move a "system-browser" user back into the in-app viewer for the rest of the session; the validated patch keeps the routing on the user's choice.
  it("keeps routeExternalUrl on system-browser after an invalid preferredFlow patch", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ webView: { preferredFlow: "system-browser" } });
    await service.patch({ webView: { preferredFlow: "systembrowser" as never } });

    const shellOpened: string[] = [];
    const inAppOpened: string[] = [];
    await routeExternalUrl({
      url: "https://example.com/sso",
      pluginId: "plugin-a",
      settingsService: service,
      bootAuditLogger: { log: () => {} },
      openLinkWindowService: async ({ url }) => { inAppOpened.push(url); },
      shellOpenExternal: async (url) => { shellOpened.push(url); },
    });

    expect(shellOpened).toEqual(["https://example.com/sso"]);
    expect(inAppOpened).toEqual([]);
  });
});

describe("SettingsService system preferences", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-system-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("defaults completion sound on for older profiles and persists a strict boolean switch", async () => {
    writeFileSync(join(userDataPath, "ave-settings.json"), JSON.stringify({ system: { closeBehavior: "quit" } }));
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("system").turnCompletionSoundEnabled).toBe(true);
    await service.patch({ system: { turnCompletionSoundEnabled: false } as SystemSettings });
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("system").turnCompletionSoundEnabled).toBe(false);
    await service.patch({ system: { turnCompletionSoundEnabled: "yes" } } as never);
    expect(service.get("system").turnCompletionSoundEnabled).toBe(false);
    expect(service.get("system").closeBehavior).toBe("quit");
    writeFileSync(join(userDataPath, "ave-settings.json"), JSON.stringify({ system: { turnCompletionSoundEnabled: "no" } }));
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("system").turnCompletionSoundEnabled).toBe(true);
  });

  it("defaults closeBehavior to 'hide-to-tray' on a fresh install", () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("system")).toEqual({ turnCompletionSoundEnabled: true, closeBehavior: "hide-to-tray", localApiServer: false, hardwareAcceleration: DEFAULT_SETTINGS.system.hardwareAcceleration, corpCaEnabled: DEFAULT_SETTINGS.system.corpCaEnabled, corpCaCommonName: DEFAULT_SETTINGS.system.corpCaCommonName, corpCaDebugLog: DEFAULT_SETTINGS.system.corpCaDebugLog, sidePanelWidth: DEFAULT_SETTINGS.system.sidePanelWidth, sidebarWidth: 232, sidePanelFileTreeWidth: 300, sidePanelSplitPreviewPercent: 45, sidePanelSplitSubagentPercent: 45, sidebarActiveTab: "chats", activeView: "home", settingsTab: "llm", pinnedProjectRoots: [], archivedProjectRoots: [], projectLabels: {}, launchAtStartup: false, launchMinimized: false, shutdownCleanupTimeoutMs: DEFAULT_SETTINGS.system.shutdownCleanupTimeoutMs });
  });

  it("applies default 'hide-to-tray' when system field is absent on disk (legacy settings.json)", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({ marketplace: { updateCheckEnabled: true } }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("system")).toEqual({ turnCompletionSoundEnabled: true, closeBehavior: "hide-to-tray", localApiServer: false, hardwareAcceleration: DEFAULT_SETTINGS.system.hardwareAcceleration, corpCaEnabled: DEFAULT_SETTINGS.system.corpCaEnabled, corpCaCommonName: DEFAULT_SETTINGS.system.corpCaCommonName, corpCaDebugLog: DEFAULT_SETTINGS.system.corpCaDebugLog, sidePanelWidth: DEFAULT_SETTINGS.system.sidePanelWidth, sidebarWidth: 232, sidePanelFileTreeWidth: 300, sidePanelSplitPreviewPercent: 45, sidePanelSplitSubagentPercent: 45, sidebarActiveTab: "chats", activeView: "home", settingsTab: "llm", pinnedProjectRoots: [], archivedProjectRoots: [], projectLabels: {}, launchAtStartup: false, launchMinimized: false, shutdownCleanupTimeoutMs: DEFAULT_SETTINGS.system.shutdownCleanupTimeoutMs });
  });

  it("round-trips a 'quit' preference across restart", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ system: { closeBehavior: "quit" } });
    expect(service.get("system")).toEqual({ turnCompletionSoundEnabled: true, closeBehavior: "quit", localApiServer: false, hardwareAcceleration: DEFAULT_SETTINGS.system.hardwareAcceleration, corpCaEnabled: DEFAULT_SETTINGS.system.corpCaEnabled, corpCaCommonName: DEFAULT_SETTINGS.system.corpCaCommonName, corpCaDebugLog: DEFAULT_SETTINGS.system.corpCaDebugLog, sidePanelWidth: DEFAULT_SETTINGS.system.sidePanelWidth, sidebarWidth: 232, sidePanelFileTreeWidth: 300, sidePanelSplitPreviewPercent: 45, sidePanelSplitSubagentPercent: 45, sidebarActiveTab: "chats", activeView: "home", settingsTab: "llm", pinnedProjectRoots: [], archivedProjectRoots: [], projectLabels: {}, launchAtStartup: false, launchMinimized: false, shutdownCleanupTimeoutMs: DEFAULT_SETTINGS.system.shutdownCleanupTimeoutMs });

    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("system")).toEqual({ turnCompletionSoundEnabled: true, closeBehavior: "quit", localApiServer: false, hardwareAcceleration: DEFAULT_SETTINGS.system.hardwareAcceleration, corpCaEnabled: DEFAULT_SETTINGS.system.corpCaEnabled, corpCaCommonName: DEFAULT_SETTINGS.system.corpCaCommonName, corpCaDebugLog: DEFAULT_SETTINGS.system.corpCaDebugLog, sidePanelWidth: DEFAULT_SETTINGS.system.sidePanelWidth, sidebarWidth: 232, sidePanelFileTreeWidth: 300, sidePanelSplitPreviewPercent: 45, sidePanelSplitSubagentPercent: 45, sidebarActiveTab: "chats", activeView: "home", settingsTab: "llm", pinnedProjectRoots: [], archivedProjectRoots: [], projectLabels: {}, launchAtStartup: false, launchMinimized: false, shutdownCleanupTimeoutMs: DEFAULT_SETTINGS.system.shutdownCleanupTimeoutMs });
  });

  // Critic M1; schema-invalid value on disk falls back to default for THIS field only; other settings sections must remain intact.
  it.each([
    ["string-not-in-enum", "yes"],
    ["null", null],
    ["number", 42],
    ["array", ["quit"]],
  ])("falls back to default when closeBehavior is invalid on disk (%s) without resetting unrelated settings", (_label, badValue) => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({
        system: { closeBehavior: badValue },
        chat: { systemPrompt: "preserved-prompt", autoCompact: false },
        marketplace: { updateCheckEnabled: false },
      }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("system")).toEqual({ turnCompletionSoundEnabled: true, closeBehavior: "hide-to-tray", localApiServer: false, hardwareAcceleration: DEFAULT_SETTINGS.system.hardwareAcceleration, corpCaEnabled: DEFAULT_SETTINGS.system.corpCaEnabled, corpCaCommonName: DEFAULT_SETTINGS.system.corpCaCommonName, corpCaDebugLog: DEFAULT_SETTINGS.system.corpCaDebugLog, sidePanelWidth: DEFAULT_SETTINGS.system.sidePanelWidth, sidebarWidth: 232, sidePanelFileTreeWidth: 300, sidePanelSplitPreviewPercent: 45, sidePanelSplitSubagentPercent: 45, sidebarActiveTab: "chats", activeView: "home", settingsTab: "llm", pinnedProjectRoots: [], archivedProjectRoots: [], projectLabels: {}, launchAtStartup: false, launchMinimized: false, shutdownCleanupTimeoutMs: DEFAULT_SETTINGS.system.shutdownCleanupTimeoutMs });
    expect(service.get("chat").systemPrompt).toBe("preserved-prompt");
    expect(service.get("chat").autoCompact).toBe(false);
    expect(service.get("marketplace").updateCheckEnabled).toBe(false);
  });

  it("falls back to default when system block is not an object", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({ system: "garbage" }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("system")).toEqual({ turnCompletionSoundEnabled: true, closeBehavior: "hide-to-tray", localApiServer: false, hardwareAcceleration: DEFAULT_SETTINGS.system.hardwareAcceleration, corpCaEnabled: DEFAULT_SETTINGS.system.corpCaEnabled, corpCaCommonName: DEFAULT_SETTINGS.system.corpCaCommonName, corpCaDebugLog: DEFAULT_SETTINGS.system.corpCaDebugLog, sidePanelWidth: DEFAULT_SETTINGS.system.sidePanelWidth, sidebarWidth: 232, sidePanelFileTreeWidth: 300, sidePanelSplitPreviewPercent: 45, sidePanelSplitSubagentPercent: 45, sidebarActiveTab: "chats", activeView: "home", settingsTab: "llm", pinnedProjectRoots: [], archivedProjectRoots: [], projectLabels: {}, launchAtStartup: false, launchMinimized: false, shutdownCleanupTimeoutMs: DEFAULT_SETTINGS.system.shutdownCleanupTimeoutMs });
  });

  // Critic N1; patch-merge must NOT clobber a valid prior preference when an invalid value
  // arrives via the renderer/IPC layer. Field-level guard mirrors the `appearance` block's behavior.
  it("ignores invalid closeBehavior patch and preserves prior 'quit' preference", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ system: { closeBehavior: "quit" } });
    expect(service.get("system").closeBehavior).toBe("quit");

    // Patch with garbage; should be a no-op on the closeBehavior field.
    await service.patch({ system: { closeBehavior: "invalid-value" as never } });
    expect(service.get("system").closeBehavior).toBe("quit");
  });
});

describe("SettingsService system — pinned project roots", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-pinned-roots-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("de-dupes case/slash-variant roots via projectRootKey, keeping the first-seen casing", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({
      system: {
        pinnedProjectRoots: [
          "C:\\workspace\\alpha",
          "c:/workspace/alpha/",
          "C:\\WORKSPACE\\ALPHA",
          "C:\\workspace\\beta",
        ],
      },
    });

    expect(service.get("system").pinnedProjectRoots).toEqual([
      "C:\\workspace\\alpha",
      "C:\\workspace\\beta",
    ]);
  });

  it("round-trips a de-duped pinned-roots list across restart", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({
      system: { pinnedProjectRoots: ["/ws/alpha", "/ws/alpha/", "/ws/beta"] },
    });

    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("system").pinnedProjectRoots).toEqual(["/ws/alpha", "/ws/beta"]);
  });
});

describe("SettingsService system — workspace preferences", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-system-preferences-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("round-trips a localApiServer=true preference across restart", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ system: { localApiServer: true } });
    expect(service.get("system")).toEqual({ turnCompletionSoundEnabled: true, closeBehavior: "hide-to-tray", localApiServer: true, hardwareAcceleration: DEFAULT_SETTINGS.system.hardwareAcceleration, corpCaEnabled: DEFAULT_SETTINGS.system.corpCaEnabled, corpCaCommonName: DEFAULT_SETTINGS.system.corpCaCommonName, corpCaDebugLog: DEFAULT_SETTINGS.system.corpCaDebugLog, sidePanelWidth: DEFAULT_SETTINGS.system.sidePanelWidth, sidebarWidth: 232, sidePanelFileTreeWidth: 300, sidePanelSplitPreviewPercent: 45, sidePanelSplitSubagentPercent: 45, sidebarActiveTab: "chats", activeView: "home", settingsTab: "llm", pinnedProjectRoots: [], archivedProjectRoots: [], projectLabels: {}, launchAtStartup: false, launchMinimized: false, shutdownCleanupTimeoutMs: DEFAULT_SETTINGS.system.shutdownCleanupTimeoutMs });

    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("system").localApiServer).toBe(true);
  });

  it("ignores an invalid localApiServer patch and preserves prior value", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ system: { localApiServer: true } });
    await service.patch({ system: { localApiServer: "yes" as never } });
    expect(service.get("system").localApiServer).toBe(true);
  });

  it("round-trips a rounded sidePanelWidth across restart", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ system: { sidePanelWidth: 640.6 } });
    expect(service.get("system").sidePanelWidth).toBe(641);

    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("system").sidePanelWidth).toBe(641);
  });

  it("clamps a sidePanelWidth below the minimum up to the floor", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ system: { sidePanelWidth: 100 } });
    expect(service.get("system").sidePanelWidth).toBe(SIDE_PANEL_MIN_RESERVE);
  });

  it("ignores an invalid sidePanelWidth patch and preserves prior value", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ system: { sidePanelWidth: 700 } });
    await service.patch({ system: { sidePanelWidth: Number.NaN } });
    await service.patch({ system: { sidePanelWidth: "wide" as never } });
    expect(service.get("system").sidePanelWidth).toBe(700);
  });

  it("round-trips per-tab vertical split percents (rounded) across restart", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({
      system: {
        sidePanelFileTreeWidth: 360.4,
        sidePanelSplitPreviewPercent: 33.5,
        sidePanelSplitSubagentPercent: 50,
      },
    });
    expect(service.get("system").sidePanelFileTreeWidth).toBe(360);
    expect(service.get("system").sidePanelSplitPreviewPercent).toBe(34);
    expect(service.get("system").sidePanelSplitSubagentPercent).toBe(50);

    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("system").sidePanelFileTreeWidth).toBe(360);
    expect(reloaded.get("system").sidePanelSplitPreviewPercent).toBe(34);
    expect(reloaded.get("system").sidePanelSplitSubagentPercent).toBe(50);
  });

  it("clamps out-of-range split percents to the [22, 78] pane range", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ system: { sidePanelSplitPreviewPercent: 5 } });
    expect(service.get("system").sidePanelSplitPreviewPercent).toBe(22);
    await service.patch({ system: { sidePanelSplitPreviewPercent: 95 } });
    expect(service.get("system").sidePanelSplitPreviewPercent).toBe(78);
  });

  it("ignores an invalid split-percent patch and preserves prior value", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ system: { sidePanelSplitPreviewPercent: 40 } });
    await service.patch({ system: { sidePanelSplitPreviewPercent: Number.NaN } });
    await service.patch({ system: { sidePanelSplitPreviewPercent: "mid" as never } });
    expect(service.get("system").sidePanelSplitPreviewPercent).toBe(40);
  });
});

describe("SettingsService appearance v2 — fresh install defaults", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-appearance-v2-fresh-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("fresh install returns schemaVersion:2 with DEFAULT_BUNDLE_ID", () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: DEFAULT_BUNDLE_ID });
  });

  it("v2 appearance round-trips across restart", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "midnight" } });
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "midnight" });
  });

  it("v2 with followSystem=true round-trips", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "violet-light", followSystem: true } });
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-light", followSystem: true });
  });

  it("malformed bundleId coerces to DEFAULT_BUNDLE_ID", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({ appearance: { schemaVersion: 2, language: "en", bundleId: "Not A Bundle!" } }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: DEFAULT_BUNDLE_ID });
  });

  // The content ledger is read after settings: an installed theme or language the user selected must survive the settings load.
  it("keeps a well-formed installed theme id and language tag it cannot resolve yet", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({ appearance: { schemaVersion: 2, language: "fr", bundleId: "harbor-night" } }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("appearance")).toMatchObject({ language: "fr", bundleId: "harbor-night" });
  });

  // `CHANNELS.settings.update` hands the renderer payload to `patch()` unchecked, so patch() is the trust boundary. `language` and `font`
  // are already validated there; `bundleId`, `schemaVersion` and `followSystem` used to ride the plain outer spread straight onto disk.

  it("ignores a malformed bundleId patch and keeps the stored theme", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ appearance: { schemaVersion: 2, bundleId: "midnight" } });

    await service.patch({ appearance: { schemaVersion: 2, bundleId: "../nonexistent bundle" } });

    expect(service.get("appearance").bundleId).toBe("midnight");
    const onDisk = JSON.parse(readFileSync(join(userDataPath, "ave-settings.json"), "utf-8")) as {
      appearance: { bundleId: string };
    };
    expect(onDisk.appearance.bundleId).toBe("midnight");
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("appearance").bundleId).toBe("midnight");
  });

  // The sharpest consequence: a non-2 schemaVersion on disk sends the next load down the v1 branch, which finds no legacy
  // `theme`/`chatTheme`/`codeTheme` keys and therefore returns DEFAULT_SETTINGS.appearance; silently discarding the user's bundle, language AND font in one go.
  it.each([
    ["v1", 1],
    ["string", "2"],
    ["null", null],
  ])("ignores a non-2 schemaVersion patch (%s) so appearance is not wiped on next load", async (_label, badVersion) => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({
      appearance: {
        schemaVersion: 2,
        bundleId: "midnight",
        language: "ko",
        font: { sizeScale: 1.125 },
      },
    });

    await service.patch({
      appearance: { schemaVersion: badVersion as never, bundleId: "midnight" },
    });

    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("appearance")).toEqual({
      schemaVersion: 2,
      bundleId: "midnight",
      language: "ko",
      font: { sizeScale: 1.125 },
    });
  });

  it("ignores a non-boolean followSystem patch and keeps the stored value", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ appearance: { schemaVersion: 2, bundleId: "violet-light", followSystem: true } });

    await service.patch({
      appearance: { schemaVersion: 2, bundleId: "violet-light", followSystem: "yes" as never },
    });

    expect(service.get("appearance").followSystem).toBe(true);
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("appearance").followSystem).toBe(true);
  });

  it("still accepts every valid bundleId through patch", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    for (const bundleId of BUNDLE_IDS) {
      await service.patch({ appearance: { schemaVersion: 2, bundleId } });
      expect(service.get("appearance").bundleId).toBe(bundleId);
    }
  });

  it("appearance block absent (pre-theme system install) → DEFAULT_BUNDLE_ID", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({ chat: { systemPrompt: "preserved", autoCompact: false } }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: DEFAULT_BUNDLE_ID });
    // Unrelated section preserved
    expect(service.get("chat").systemPrompt).toBe("preserved");
  });
});

describe("SettingsService system locale detection", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-locale-detect-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("fresh install with systemLocale=ko-KR selects the compiled Korean locale", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, systemLocale: "ko-KR" });
    expect(service.get("appearance").language).toBe("ko");
    await service.set("chat", service.get("chat"));
    expect(JSON.parse(readFileSync(join(userDataPath, "ave-settings.json"), "utf-8")).appearance.language).toBe("ko");
  });

  it("fresh install with systemLocale=en-US keeps English as the default language", () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, systemLocale: "en-US" });
    expect(service.get("appearance").language).toBe("en");
  });

  it("fresh install with unsupported systemLocale falls back to 'en'", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, systemLocale: "fr-FR" });
    expect(service.get("appearance").language).toBe("en");
    await service.set("chat", service.get("chat"));
    expect(JSON.parse(readFileSync(join(userDataPath, "ave-settings.json"), "utf-8")).appearance.language).toBe("en");
  });

  it("fresh install without systemLocale defaults to 'en'", () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("appearance").language).toBe("en");
  });

  it("does not seed a third-party system locale even when its package is registered", () => {
    registerInstalledLocales([{ locale: "fr", nativeName: "Français", englishName: "French" }]);
    try {
      const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, systemLocale: "fr-FR" });
      expect(service.get("appearance").language).toBe("en");
    } finally {
      registerInstalledLocales([]);
    }
  });

  it("existing settings file with explicit language is not overridden by systemLocale", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({ appearance: { schemaVersion: 2, language: "en", bundleId: DEFAULT_BUNDLE_ID } }),
      "utf-8",
    );
    // Even if OS is Korean, the stored "en" is the user's explicit choice; respect it.
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, systemLocale: "ko-KR" });
    expect(service.get("appearance").language).toBe("en");
  });

  it("existing settings file with language='ko' is preserved regardless of systemLocale", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({ appearance: { schemaVersion: 2, language: "ko", bundleId: DEFAULT_BUNDLE_ID } }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, systemLocale: "en-US" });
    expect(service.get("appearance").language).toBe("ko");
  });

  it("does not seed an existing settings file whose language is absent", () => {
    writeFileSync(join(userDataPath, "ave-settings.json"), currentSettingsJson({}), "utf-8");
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, systemLocale: "ko-KR" });
    expect(service.get("appearance").language).toBe("en");
  });
});

describe("SettingsService appearance v1 → v2 migration", () => {
  let userDataPath: string;
  let migrationWrites: Array<{ promise: Promise<void>; settled: boolean }>;
  let restoreWriteObserver: () => void;

  async function waitForV2WriteBack(): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(migrationWrites.map((writing) => writing.promise)),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("Settings migration write-back did not settle before teardown")), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    const settingsPath = join(userDataPath, "ave-settings.json");
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      appearance?: { schemaVersion?: unknown };
    };
    expect(onDisk.appearance?.schemaVersion).toBe(2);
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-appearance-migration-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    migrationWrites = [];
    type SettingsWriter = { saveSettings(settings: unknown): Promise<void> };
    const prototype = SettingsService.prototype as unknown as SettingsWriter;
    const realSave = prototype.saveSettings;
    const observer = vi.spyOn(prototype, "saveSettings").mockImplementation(function (this: SettingsWriter, settings) {
      const writing = realSave.call(this, settings);
      const tracked = { promise: writing, settled: false };
      migrationWrites.push(tracked);
      const markSettled = () => { tracked.settled = true; };
      void writing.then(markSettled, markSettled);
      return writing;
    });
    restoreWriteObserver = () => observer.mockRestore();
  });

  afterEach(async () => {
    try {
      await waitForV2WriteBack();
    } finally {
      restoreWriteObserver();
      vi.clearAllMocks();
      if (migrationWrites.every((writing) => writing.settled)) {
        await cleanupTmpDir(userDataPath);
      } else {
        // A timed-out write still owns this root until its real I/O settles.
        console.warn("Settings migration writes are pending; retained temporary directory: %s", userDataPath);
      }
    }
  });

  function writeV1(appearance: Record<string, unknown>): void {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({ appearance }),
      "utf-8",
    );
  }

  it("dark + default → tokyo-night", () => {
    writeV1({ theme: "dark", chatTheme: "default", codeTheme: "auto" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "tokyo-night" });
  });

  it("dark + lg → violet-dark", () => {
    writeV1({ theme: "dark", chatTheme: "lg", codeTheme: "auto" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-dark" });
  });

  it("light + default → forest", () => {
    writeV1({ theme: "light", chatTheme: "default", codeTheme: "auto" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "forest" });
  });

  it("light + lg → violet-light", () => {
    writeV1({ theme: "light", chatTheme: "lg", codeTheme: "auto" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-light" });
  });

  it("dark + lg + dark (code override) → violet-dark (code override ignored)", () => {
    writeV1({ theme: "dark", chatTheme: "lg", codeTheme: "dark" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-dark" });
  });

  it("light + default + dark (code override) → forest (code override ignored)", () => {
    writeV1({ theme: "light", chatTheme: "default", codeTheme: "dark" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "forest" });
  });

  it("* + purple → midnight (closest accent coercion)", () => {
    writeV1({ theme: "dark", chatTheme: "purple", codeTheme: "auto" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "midnight" });
  });

  it("* + orange → midnight", () => {
    writeV1({ theme: "light", chatTheme: "orange", codeTheme: "auto" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "midnight" });
  });

  it("* + blue → midnight", () => {
    writeV1({ theme: "dark", chatTheme: "blue", codeTheme: "dark" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "midnight" });
  });

  it("high-contrast + * → high-contrast (HC always wins)", () => {
    writeV1({ theme: "high-contrast", chatTheme: "purple", codeTheme: "dark" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "high-contrast" });
  });

  it("invalid theme string → DEFAULT_BUNDLE_ID", () => {
    writeV1({ theme: "sepia", chatTheme: "default", codeTheme: "auto" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: DEFAULT_BUNDLE_ID });
  });

  it("v1 write-back: migrated appearance is written to disk as v2", async () => {
    writeV1({ theme: "dark", chatTheme: "lg", codeTheme: "auto" });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    // Await the constructor's actual atomic write, including lock release.
    await waitForV2WriteBack();
    const onDisk = JSON.parse(readFileSync(join(userDataPath, "ave-settings.json"), "utf-8")) as Record<string, unknown>;
    expect(onDisk.appearance).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-dark" });
    // No legacy keys remain after write-back
    expect(onDisk.appearance.theme).toBeUndefined();
    expect(onDisk.appearance.chatTheme).toBeUndefined();
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-dark" });
  });

  it("persists migrations and normalized fields from an unmarked legacy file", async () => {
    const settingsPath = join(userDataPath, "ave-settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      appearance: { theme: "dark", chatTheme: "lg", codeTheme: "auto" },
      features: { subAgentAutonomousWake: false },
      shortcuts: { toggleWindow: 42, enabled: "nope" },
    }), "utf-8");
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).not.toHaveProperty("appliedMigrations");

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-dark" });
    expect(service.get("features")?.subAgentAutonomousWake).toBe(true);
    expect(service.get("shortcuts")).toEqual({ toggleWindow: null, enabled: false });

    await waitForV2WriteBack();
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(onDisk.appearance).toEqual(service.get("appearance"));
    expect(onDisk.features).toMatchObject({ subAgentAutonomousWake: true });
    expect(onDisk.shortcuts).toEqual({ toggleWindow: null, enabled: false });
    expect(onDisk.appliedMigrations).toContain("subagent-autonomous-wake-default-flip");
  });

  it("v2 file loads without re-migration", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({ appearance: { schemaVersion: 2, language: "en", bundleId: "forest" } }),
      "utf-8",
    );
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "forest" });
  });

  // Main process has no window.matchMedia; system theme must not crash and must produce a deterministic DEFAULT_BUNDLE_ID result (no silent OS-scheme access).
  it("system + default → DEFAULT_BUNDLE_ID (main process: no matchMedia needed)", () => {
    writeV1({ theme: "system", chatTheme: "default", codeTheme: "auto" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: DEFAULT_BUNDLE_ID });
  });

  it("system + lg → violet-dark + followSystem:true (main process: renderer will track OS)", () => {
    writeV1({ theme: "system", chatTheme: "lg", codeTheme: "auto" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-dark", followSystem: true });
  });

  it("codeTheme-only v1 triggers write-back (needsV2WriteBack includes codeTheme)", async () => {
    writeV1({ codeTheme: "light" });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await waitForV2WriteBack();
    const onDisk = JSON.parse(readFileSync(join(userDataPath, "ave-settings.json"), "utf-8")) as Record<string, unknown>;
    expect((onDisk.appearance as Record<string, unknown>).codeTheme).toBeUndefined();
    expect(service.get("appearance")).toMatchObject({ schemaVersion: 2 });
  });
});

describe("SettingsService appearance.font — Track A user-configurable font", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-font-"));
  });
  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  function writeAppearance(font: unknown): void {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font } }),
    );
  }

  it("accepts `family: 'system'` verbatim", () => {
    writeAppearance({ family: "system" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toMatchObject({ font: { family: "system" } });
  });

  it("accepts a valid user stack and roundtrips it", () => {
    const stack = 'Pretendard, system-ui, "Apple SD Gothic Neo", sans-serif';
    writeAppearance({ family: stack });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance")).toMatchObject({ font: { family: stack } });
  });

  it("rejects a stack that contains injection metachars and drops the field", () => {
    writeAppearance({ family: 'Arial; color: red; url(http://evil)' });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance").font?.family).toBeUndefined();
  });

  it("rejects a stack longer than 256 chars and drops the field", () => {
    writeAppearance({ family: "A".repeat(257) });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance").font?.family).toBeUndefined();
  });

  it("reads the pre-ladder top step 1.25 as the current top step", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { sizeScale: 1.25 } } }),
      "utf-8",
    );
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("appearance").font?.sizeScale).toBe(1.125);
  });

  it("accepts each preset sizeScale value", async () => {
    for (const value of [0.75, 0.875, 1, 1.125]) {
      const dir = mkdtempSync(join(tmpdir(), `settings-store-size-${value}-`));
      try {
        writeFileSync(
          join(dir, "ave-settings.json"),
          currentSettingsJson({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { sizeScale: value } } }),
        );
        const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath: dir });
        expect(s.get("appearance")).toMatchObject({ font: { sizeScale: value } });
      } finally {
        await cleanupTmpDir(dir);
      }
    }
  });

  it("rejects an off-preset sizeScale (e.g. 0.4) and drops the field", () => {
    writeAppearance({ sizeScale: 0.4 });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance").font?.sizeScale).toBeUndefined();
  });

  it("drops the entire `font` field when both fields are invalid", () => {
    writeAppearance({ family: 123, sizeScale: "huge" });
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("appearance").font).toBeUndefined();
  });

  it("patch family-only preserves a previously patched sizeScale (PR #672 review HIGH#1)", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { sizeScale: 1.125 } } });
    await s.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { family: "Pretendard, system-ui, sans-serif" } } });
    expect(s.get("appearance").font).toEqual({
      sizeScale: 1.125,
      family: "Pretendard, system-ui, sans-serif",
    });
  });

  it("patch sizeScale-only preserves a previously patched family (PR #672 review HIGH#1, reverse order)", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { family: "Pretendard, sans-serif" } } });
    await s.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { sizeScale: 1.125 } } });
    expect(s.get("appearance").font).toEqual({
      family: "Pretendard, sans-serif",
      sizeScale: 1.125,
    });
  });

  it("validates font.family at patch time — drops injection metachars (PR #672 review MAJOR#4)", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({
      appearance: {
        schemaVersion: 2,
        bundleId: "tokyo-night",
        font: { family: 'Arial; color: red; url(http://evil)' },
      },
    });
    expect(s.get("appearance").font?.family).toBeUndefined();
  });

  it("patch accepts unquoted Hangul family names with Unicode-aware validator (PR #672 review CRITICAL#3)", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({
      appearance: {
        schemaVersion: 2,
        bundleId: "tokyo-night",
        font: { family: "맑은 고딕, sans-serif" },
      },
    });
    expect(s.get("appearance").font?.family).toBe("맑은 고딕, sans-serif");
  });

  it("rejects font.family containing embedded newlines (PR #672 review MAJOR#6)", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({
      appearance: {
        schemaVersion: 2,
        bundleId: "tokyo-night",
        font: { family: "Arial\nevil" },
      },
    });
    expect(s.get("appearance").font?.family).toBeUndefined();
  });

  it("patch with `font: null` is a no-op — does not crash on null deref (PR #672 2차 critic N3)", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { sizeScale: 1.125 } } });
    // Caller deliberately sends `font: null` (some defensive call sites do this to "clear"
    // without specifying subfields). Must not throw, must preserve the previously-patched font block.
    await s.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: null as unknown as { sizeScale: 1 | 1.125 } } });
    expect(s.get("appearance").font?.sizeScale).toBe(1.125);
  });
});

describe("SettingsService E4 — shortcuts + launch-at-startup", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-e4-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("defaults shortcuts OFF with no accelerator + launch flags false", () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("shortcuts")).toEqual({ toggleWindow: null, enabled: false });
    expect(s.get("system").launchAtStartup).toBe(false);
    expect(s.get("system").launchMinimized).toBe(false);
  });

  it("persists a valid accelerator + enabled through patch", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ shortcuts: { toggleWindow: "CommandOrControl+Shift+Space", enabled: true } });
    expect(s.get("shortcuts")).toEqual({
      toggleWindow: "CommandOrControl+Shift+Space",
      enabled: true,
    });
    // Reload from disk to confirm round-trip persistence.
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("shortcuts").toggleWindow).toBe("CommandOrControl+Shift+Space");
    expect(reloaded.get("shortcuts").enabled).toBe(true);
  });

  it("drops an invalid accelerator (lone modifier) but keeps the previous value", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ shortcuts: { toggleWindow: "Alt+F1", enabled: true } });
    // Invalid: lone modifier; must be ignored, prior value preserved.
    await s.patch({ shortcuts: { toggleWindow: "Shift" } });
    expect(s.get("shortcuts").toggleWindow).toBe("Alt+F1");
    // enabled sibling still patchable.
    expect(s.get("shortcuts").enabled).toBe(true);
  });

  it("clears the accelerator when patched with null", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ shortcuts: { toggleWindow: "Alt+F1", enabled: true } });
    await s.patch({ shortcuts: { toggleWindow: null } });
    expect(s.get("shortcuts").toggleWindow).toBeNull();
    expect(s.get("shortcuts").enabled).toBe(true);
  });

  it("persists launchAtStartup + launchMinimized booleans", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ system: { launchAtStartup: true, launchMinimized: true } });
    expect(s.get("system").launchAtStartup).toBe(true);
    expect(s.get("system").launchMinimized).toBe(true);
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("system").launchAtStartup).toBe(true);
    expect(reloaded.get("system").launchMinimized).toBe(true);
  });

  it("ignores a non-boolean launchAtStartup patch, keeping the prior value", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ system: { launchAtStartup: true } });
    await s.patch({ system: { launchAtStartup: "yes" as unknown as boolean } });
    expect(s.get("system").launchAtStartup).toBe(true);
  });

  it("normalizes a corrupt shortcuts block on load", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({ shortcuts: { toggleWindow: 42, enabled: "nope" } }),
      "utf-8",
    );
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    // Corrupt fields fall back to defaults (No-Fallback at boundary).
    expect(s.get("shortcuts")).toEqual({ toggleWindow: null, enabled: false });
  });
});

describe("SettingsService diagnostics (#1499 E2)", () => {
  let userDataPath: string;
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-diagnostics-"));
  });
  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  it("defaults: includeCrashDumps false, logRetentionDays = LOG_RETENTION_DAYS SOT", () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("diagnostics")).toEqual({
      includeCrashDumps: false,
      logRetentionDays: LOG_RETENTION_DAYS,
    });
  });

  it("patch persists valid values", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ diagnostics: { includeCrashDumps: true, logRetentionDays: 30 } });
    expect(s.get("diagnostics")).toEqual({ includeCrashDumps: true, logRetentionDays: 30 });
  });

  it("patch clamps out-of-range retention and drops non-boolean includeCrashDumps", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ diagnostics: { logRetentionDays: 99999 } });
    expect(s.get("diagnostics").logRetentionDays).toBe(LOG_RETENTION_MAX_DAYS); // clamped to max
    await s.patch({ diagnostics: { logRetentionDays: 0 } });
    expect(s.get("diagnostics").logRetentionDays).toBe(LOG_RETENTION_MIN_DAYS); // clamped to min
    await s.patch({ diagnostics: { includeCrashDumps: "yes" as never } });
    expect(s.get("diagnostics").includeCrashDumps).toBe(false); // dropped → prior value kept
  });

  it("corrupt on-disk diagnostics falls back to defaults", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({ diagnostics: { includeCrashDumps: 1, logRetentionDays: "seven" } }),
      "utf-8",
    );
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("diagnostics")).toEqual({
      includeCrashDumps: false,
      logRetentionDays: LOG_RETENTION_DAYS,
    });
  });
});

describe("SettingsService telemetry normalization", () => {
  let userDataPath: string;
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-telemetry-"));
  });
  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  it("defaults to everything off and no destination", () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("telemetry")).toEqual({ enabled: false, crashReportingEnabled: false });
  });

  it("patches one field without disturbing the rest of the block", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ telemetry: { endpoint: "https://metrics.corp.example/v1" } });
    await s.patch({ telemetry: { enabled: true } });
    expect(s.get("telemetry")).toEqual({
      enabled: true,
      crashReportingEnabled: false,
      endpoint: "https://metrics.corp.example/v1",
    });
  });

  it("trims a submitted address and clears the field when it is emptied", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ telemetry: { endpoint: "  https://metrics.corp.example/v1  " } });
    expect(s.get("telemetry").endpoint).toBe("https://metrics.corp.example/v1");
    await s.patch({ telemetry: { endpoint: "" } });
    expect(s.get("telemetry").endpoint).toBeUndefined();
  });

  it("drops a non-boolean switch and a non-string address, keeping the stored value", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ telemetry: { enabled: true, sentryDsn: "https://k@sentry.example/1" } });
    await s.patch({ telemetry: { enabled: "yes" as never, sentryDsn: 42 as never } });
    expect(s.get("telemetry")).toEqual({
      enabled: true,
      crashReportingEnabled: false,
      sentryDsn: "https://k@sentry.example/1",
    });
  });

  it("corrupt on-disk telemetry falls back to defaults field by field", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({
        telemetry: {
          enabled: "true",
          crashReportingEnabled: true,
          endpoint: { url: "https://nope.example" },
          sentryDsn: "  https://k@sentry.example/1  ",
        },
      }),
      "utf-8",
    );
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("telemetry")).toEqual({
      enabled: false,
      crashReportingEnabled: true,
      sentryDsn: "https://k@sentry.example/1",
    });
  });
});

describe("SettingsService chat normalization", () => {
  let userDataPath: string;
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-chat-"));
  });
  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  it("defaults processing detail to the existing full transcript", () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("chat").processingDisplayLevel).toBe("full");
  });

  it("persists every valid processing detail level across reload", async () => {
    for (const level of ["tools", "reasoning", "full"] as const) {
      const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
      await s.patch({ chat: { processingDisplayLevel: level } });
      const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
      expect(reloaded.get("chat").processingDisplayLevel).toBe(level);
    }
  });

  it("falls back to full for a malformed processing detail value", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({ chat: { processingDisplayLevel: "everything" } }),
      "utf-8",
    );
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("chat").processingDisplayLevel).toBe("full");
  });

  it("rejects an invalid live processing detail patch without replacing the saved preference", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ chat: { processingDisplayLevel: "tools" } });

    await expect(s.patch({
      chat: { processingDisplayLevel: "everything" as never },
    })).rejects.toMatchObject({
      name: "SettingsPatchValidationError",
      code: "invalid-processing-display-level",
    });

    expect(s.get("chat").processingDisplayLevel).toBe("tools");
    const onDisk = JSON.parse(readFileSync(join(userDataPath, "ave-settings.json"), "utf-8")) as {
      chat: { processingDisplayLevel: unknown };
    };
    expect(onDisk.chat.processingDisplayLevel).toBe("tools");
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath })
      .get("chat").processingDisplayLevel).toBe("tools");
  });

  it("keeps the stored processing detail on an unrelated partial chat patch", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ chat: { processingDisplayLevel: "tools" } });
    await s.patch({ chat: { autoCompact: false } });
    expect(s.get("chat")).toMatchObject({
      autoCompact: false,
      processingDisplayLevel: "tools",
    });
  });

  it("floors a fractional sub-agent round budget and drops mistyped fields", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({
      chat: {
        ...s.get("chat"),
        subAgentMaxRounds: 12.7,
        autoCompact: "yes" as never,
        systemPrompt: 42 as never,
      },
    });
    const chat = s.get("chat");
    expect(chat.subAgentMaxRounds).toBe(12);
    // Mistyped values are dropped, so the prior (default) value stands.
    expect(chat.autoCompact).toBe(DEFAULT_SETTINGS.chat.autoCompact);
    expect(chat.systemPrompt).toBe(DEFAULT_SETTINGS.chat.systemPrompt);
  });

  it("raises a non-positive round budget to the runnable minimum", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ chat: { ...s.get("chat"), subAgentMaxRounds: 0 } });
    expect(s.get("chat").subAgentMaxRounds).toBe(1);
    await s.patch({ chat: { ...s.get("chat"), subAgentMaxRounds: -5 } });
    expect(s.get("chat").subAgentMaxRounds).toBe(1);
  });

  it("keeps a very large round budget — the budget has no upper clamp", async () => {
    // Deliberate: an absolute ceiling above the configured budget can only surface as an agent that stops
    // mid-task. The 32-bit timer bound this could once overflow is enforced where the timer is armed instead.
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ chat: { ...s.get("chat"), subAgentMaxRounds: 300_000 } });
    expect(s.get("chat").subAgentMaxRounds).toBe(300_000);
  });

  it("corrupt on-disk chat falls back to defaults", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({
        chat: { subAgentMaxRounds: "many", autoCompact: 1, systemPrompt: [] },
      }),
      "utf-8",
    );
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(s.get("chat")).toEqual(DEFAULT_SETTINGS.chat);
  });

  it("rejects a non-finite round budget rather than persisting NaN", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ chat: { ...s.get("chat"), subAgentMaxRounds: Number.NaN } });
    expect(s.get("chat").subAgentMaxRounds).toBe(
      DEFAULT_SETTINGS.chat.subAgentMaxRounds,
    );
  });

  it("keeps 0 as the off value for the progress-notification cadence", async () => {
    // Unlike the round budget above, 0 is meaningful here: it is how the notification is turned off, so it must not be raised to a minimum.
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ chat: { ...s.get("chat"), progressNudgeRounds: 0 } });
    expect(s.get("chat").progressNudgeRounds).toBe(0);
  });

  it("floors a fractional cadence and reads a negative one as off", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ chat: { ...s.get("chat"), progressNudgeRounds: 7.9 } });
    expect(s.get("chat").progressNudgeRounds).toBe(7);
    await s.patch({ chat: { ...s.get("chat"), progressNudgeRounds: -4 } });
    expect(s.get("chat").progressNudgeRounds).toBe(0);
  });

  it("rejects a mistyped cadence rather than disabling the notification", async () => {
    const s = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await s.patch({ chat: { ...s.get("chat"), progressNudgeRounds: "often" as never } });
    expect(s.get("chat").progressNudgeRounds).toBe(
      DEFAULT_SETTINGS.chat.progressNudgeRounds,
    );
  });
});

describe("SettingsService — persisted main-window location", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "ave-settings-active-view-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  it("round-trips an inline view key across restart", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ system: { activeView: "work-board" } as SystemSettings });
    expect(service.get("system").activeView).toBe("work-board");

    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("system").activeView).toBe("work-board");
  });

  it("round-trips a plugin view key, which only the renderer can confirm still exists", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({
      system: { activeView: "plugin:example-plugin:MainView" } as unknown as SystemSettings,
    });
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("system").activeView).toBe(
      "plugin:example-plugin:MainView",
    );
  });

  it.each([
    ["a key an older build shipped and this one retired", "reminders"],
    ["a malformed plugin key", "plugin:"],
    ["a card key that is detach-only by construction", "mcp-app:ab:card"],
    ["a typo", "wrok-board"],
    ["a non-string", 42],
  ])("keeps the default when the stored location is %s", (_label, badValue) => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        system: { activeView: badValue },
        chat: { systemPrompt: "preserved-prompt", autoCompact: false },
      }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("system").activeView).toBe("home");
    // The rest of the file is untouched by one bad field.
    expect(service.get("chat").systemPrompt).toBe("preserved-prompt");
  });

  it("refuses to patch an invalid location, keeping the stored one", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ system: { activeView: "work-board" } as SystemSettings });
    // A retired key: valid in an older build, absent from the table now.
    await service.patch({ system: { activeView: "reminders" } as unknown as SystemSettings });
    expect(service.get("system").activeView).toBe("work-board");
  });

  it("folds a retired settings tab id onto its replacement", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    // "general" was split up; a value persisted by an older build must still land somewhere real rather than on a tab that no longer exists.
    await service.patch({ system: { settingsTab: "general" } as unknown as SystemSettings });
    expect(service.get("system").settingsTab).toBe("llm");

    await service.patch({ system: { settingsTab: "permissions" } as SystemSettings });
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("system").settingsTab).toBe("permissions");
  });
});

describe("subAgentAutonomousWake un-fossilize migration", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-wake-migration-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  it("drops a pre-flip fossil false once so the flipped default reaches the install", async () => {
    // saveSettings() materializes merged defaults, so installs from the era when the flag defaulted to
    // false carry an explicit false the user never chose; and the default flip to true could never reach them.
    const path = join(userDataPath, "ave-settings.json");
    writeFileSync(path, JSON.stringify({ features: { subAgentAutonomousWake: false } }), "utf-8");

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("features")?.subAgentAutonomousWake).toBe(true);

    // Any save persists the marker; afterwards the migration never re-runs.
    await service.patch({} as never);
    const onDisk = JSON.parse(readFileSync(path, "utf-8")) as {
      appliedMigrations?: string[];
    };
    expect(onDisk.appliedMigrations).toContain("subagent-autonomous-wake-default-flip");
  });

  it("keeps a fresh install's first-session opt-out across the next boot", async () => {
    // Fresh installs have no settings file; loadSettings seeds KNOWN_MIGRATIONS so a user opt-out saved in the very
    // first session (before any migration marker could exist on disk) is not treated as a fossil on the next load.
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ features: { subAgentAutonomousWake: false } } as never);

    const rebooted = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(rebooted.get("features")?.subAgentAutonomousWake).toBe(false);
  });

  it("respects an explicit opt-out written after the migration ran", () => {
    const path = join(userDataPath, "ave-settings.json");
    writeFileSync(path, JSON.stringify({
      appliedMigrations: ["subagent-autonomous-wake-default-flip"],
      features: { subAgentAutonomousWake: false },
    }), "utf-8");

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("features")?.subAgentAutonomousWake).toBe(false);
  });
});

describe("plugin-worker confinement split migration", () => {
  let userDataPath: string;
  let path: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-worker-split-"));
    path = join(userDataPath, "ave-settings.json");
  });

  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  const onDisk = () => JSON.parse(readFileSync(path, "utf-8")) as {
    appliedMigrations?: string[];
    features?: { osToolSandbox?: boolean; pluginWorkerConfinement?: boolean };
  };

  it("keeps an existing sandbox opt-in on for both shells and workers, and persists it", async () => {
    writeFileSync(path, JSON.stringify({ features: { osToolSandbox: true } }), "utf-8");

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("features")?.osToolSandbox).toBe(true);
    expect(service.get("features")?.pluginWorkerConfinement).toBe(true);

    await service.patch({} as never);
    expect(onDisk().features).toMatchObject({ osToolSandbox: true, pluginWorkerConfinement: true });
  });

  it.each([
    ["an explicit false", { osToolSandbox: false }, false],
    // A file without the shell value takes the platform shell default; that default is not the user's opt-in, so workers stay unconfined.
    ["no stored value", {}, DEFAULT_SETTINGS.features!.osToolSandbox],
  ])("keeps workers off for a default install (%s)", async (_label, features, shell) => {
    writeFileSync(path, JSON.stringify({ features }), "utf-8");

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("features")?.osToolSandbox).toBe(shell);
    expect(service.get("features")?.pluginWorkerConfinement).toBe(false);

    await service.patch({} as never);
    // Written as the user's own value, so a later shell default cannot reach it.
    expect(onDisk().features?.pluginWorkerConfinement).toBe(false);
  });

  it("keeps a worker value already on disk", () => {
    writeFileSync(path, JSON.stringify({ features: { osToolSandbox: true, pluginWorkerConfinement: false } }), "utf-8");

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("features")?.osToolSandbox).toBe(true);
    expect(service.get("features")?.pluginWorkerConfinement).toBe(false);
  });

  it("does not re-derive after it ran: turning the shell sandbox on later leaves workers alone", async () => {
    writeFileSync(path, JSON.stringify({ features: { osToolSandbox: false } }), "utf-8");
    const first = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await first.patch({ features: { osToolSandbox: true } });

    const rebooted = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(rebooted.get("features")?.osToolSandbox).toBe(true);
    expect(rebooted.get("features")?.pluginWorkerConfinement).toBe(false);
  });

  it("each setting changes only itself", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ features: { pluginWorkerConfinement: true } });
    expect(service.get("features")?.osToolSandbox).toBe(DEFAULT_SETTINGS.features!.osToolSandbox);
    expect(service.get("features")?.pluginWorkerConfinement).toBe(true);

    await service.patch({ features: { osToolSandbox: true, pluginWorkerConfinement: false } });
    await service.patch({ features: { osToolSandbox: false } });
    expect(service.get("features")?.pluginWorkerConfinement).toBe(false);
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("features")).toMatchObject({ osToolSandbox: false, pluginWorkerConfinement: false });
  });

  it("does not rewrite a fresh install's first-session shell opt-in into worker confinement", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ features: { osToolSandbox: true } });
    expect(onDisk().features?.pluginWorkerConfinement).toBe(false);

    const rebooted = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(rebooted.get("features")?.pluginWorkerConfinement).toBe(false);
  });

  it("re-derives after a downgrade dropped the worker key, even when a marker survived", () => {
    // An older build keeps unknown `appliedMigrations` entries but drops the unknown
    // `pluginWorkerConfinement` key on save; the shell opt-in it kept must still confine workers after the re-upgrade.
    writeFileSync(path, JSON.stringify({
      appliedMigrations: ["plugin-worker-confinement-split"],
      features: { osToolSandbox: true },
    }), "utf-8");

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("features")).toMatchObject({ osToolSandbox: true, pluginWorkerConfinement: true });
  });
});

describe("output token limit: the stored old default becomes the host default", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-output-limit-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  function writeStored(contents: Record<string, unknown>): string {
    const path = join(userDataPath, "ave-settings.json");
    writeFileSync(path, JSON.stringify(contents), "utf-8");
    return path;
  }

  type OnDisk = { appliedMigrations?: string[]; llm: { vendors: Record<string, { outputTokenLimit?: number; outputTokenLimitSetByUser?: true }> } };

  it("drops a stored 32000 an older build wrote, and keeps any other value", async () => {
    const path = writeStored({
      llm: {
        provider: "openai",
        vendors: {
          openai: { model: "gpt-5.4-mini", outputTokenLimit: 32_000 },
          claude: { model: "claude-sonnet-4-6", outputTokenLimit: 64_000 },
        },
      },
    });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("llm").vendors.openai?.outputTokenLimit).toBeUndefined();
    expect(service.get("llm").vendors.claude?.outputTokenLimit).toBe(64_000);
    await service.patch({} as never);
    const onDisk = JSON.parse(readFileSync(path, "utf-8")) as OnDisk;
    expect(onDisk.llm.vendors.openai?.outputTokenLimit).toBeUndefined();
  });

  it("keeps a 32000 the user set, across reloads", async () => {
    const path = writeStored({ llm: { provider: "openai", vendors: { openai: { model: "gpt-5.4-mini" } } } });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ llm: { vendors: { openai: { outputTokenLimit: 32_000 } } } } as never);
    expect(service.get("llm").vendors.openai).toMatchObject({ outputTokenLimit: 32_000, outputTokenLimitSetByUser: true });
    expect((JSON.parse(readFileSync(path, "utf-8")) as OnDisk).llm.vendors.openai).toMatchObject({ outputTokenLimit: 32_000, outputTokenLimitSetByUser: true });
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("llm").vendors.openai?.outputTokenLimit).toBe(32_000);
    // Clearing the limit clears the stamp with it.
    await reloaded.patch({ llm: { vendors: { openai: { outputTokenLimit: undefined } } } } as never);
    expect(reloaded.get("llm").vendors.openai).not.toHaveProperty("outputTokenLimitSetByUser");
  });

  it("drops the 32000 an older build writes back after a downgrade, even once the old marker is on disk", () => {
    // The updater can offer an older build. It writes 32000 into every block and keeps the marker an earlier
    // version of this migration recorded; a one-time migration would then read those values as the user's.
    writeStored({
      appliedMigrations: ["llm-output-token-limit-default"],
      llm: {
        provider: "openai",
        vendors: {
          openai: { model: "gpt-5.4-mini", outputTokenLimit: 32_000 },
          claude: { model: "claude-sonnet-4-6", outputTokenLimit: 32_000, outputTokenLimitSetByUser: true },
        },
      },
    });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("llm").vendors.openai?.outputTokenLimit).toBeUndefined();
    expect(service.get("llm").vendors.claude?.outputTokenLimit).toBe(32_000);
  });

  it("does not write the default into any vendor block a save persists", async () => {
    // Before, every saved block carried the materialized default, which is how 32000 came to stand for "never chosen".
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ llm: { vendors: { openai: { model: "gpt-5.4" } } } } as never);
    const onDisk = JSON.parse(readFileSync(join(userDataPath, "ave-settings.json"), "utf-8")) as OnDisk;
    for (const [vendor, block] of Object.entries(onDisk.llm.vendors)) {
      expect(block.outputTokenLimit, vendor).toBeUndefined();
    }
  });
});

function writePlainSecrets(secretsPath: string, entries: Record<string, string>): void {
  writeFileSync(secretsPath, `${JSON.stringify({
    version: 1,
    entries: Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [key, { encoding: "plain-development", value }]),
    ),
  })}\n`, { mode: 0o600 });
}

describe("vendor ids renamed to package names (nousResearch, v0)", () => {
  const MARKER = "llm-vendor-id-package-names";
  const MODEL = "selected-model";
  const BASE_URL = "https://inference-api.nousresearch.com/v1";
  let userDataPath: string;
  let settingsPath: string;
  let secretsPath: string;

  function cacheEntry(vendor: string, models: string[]) {
    return {
      vendor,
      baseUrl: BASE_URL,
      endpoint: `${BASE_URL}/models`,
      models,
      fetchedAt: "2026-09-01T00:00:00.000Z",
    };
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-vendor-rename-"));
    settingsPath = join(userDataPath, "ave-settings.json");
    secretsPath = join(userDataPath, "ave-secrets.json");
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("carries every stored reference to the old id over to the new one, once", async () => {
    writeFileSync(settingsPath, JSON.stringify({
      llm: {
        provider: "nousResearch",
        vendors: { nousResearch: { model: MODEL, baseUrl: BASE_URL } },
        fallbackChain: [{ provider: "nousResearch", model: MODEL }],
        modelListCache: {
          [llmModelListCacheKey("nousResearch", BASE_URL)]: cacheEntry("nousResearch", [MODEL]),
        },
        pricingOverrides: [{ vendor: "nousResearch", model: MODEL, inputPer1M: 1, outputPer1M: 2 }],
      },
      marketplace: { installedProviderIds: ["nousResearch"] },
    }), "utf-8");

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const llm = service.get("llm");
    expect(llm.provider).toBe("nous-research");
    expect(getLlmVendorSettings(llm.vendors, "nous-research")).toMatchObject({ model: MODEL, baseUrl: BASE_URL });
    expect(llm.fallbackChain).toEqual([{ provider: "nous-research", model: MODEL }]);
    expect(llm.modelListCache[llmModelListCacheKey("nous-research", BASE_URL)]).toMatchObject({
      vendor: "nous-research",
      models: [MODEL],
    });
    expect(llm.pricingOverrides).toEqual([
      { vendor: "nous-research", model: MODEL, inputPer1M: 1, outputPer1M: 2 },
    ]);
    expect(service.get("marketplace").installedProviderIds).toEqual(["nous-research"]);

    // The load writes the result back with the marker; nothing on disk still names the old id.
    await vi.waitFor(() => {
      expect(JSON.parse(readFileSync(settingsPath, "utf-8")).appliedMigrations).toContain(MARKER);
    });
    expect(readFileSync(settingsPath, "utf-8")).not.toContain("nousResearch");
  });

  it("renames v0 to vercel-v0 in the same load as nousResearch", () => {
    writeFileSync(settingsPath, JSON.stringify({
      llm: {
        provider: "v0",
        vendors: { v0: { model: "selected-model" } },
        fallbackChain: [
          { provider: "nousResearch", model: MODEL },
          { provider: "v0", model: "selected-model" },
        ],
      },
      marketplace: { installedProviderIds: ["v0", "nousResearch"] },
    }), "utf-8");

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const llm = service.get("llm");
    expect(llm.provider).toBe("vercel-v0");
    expect(getLlmVendorSettings(llm.vendors, "vercel-v0").model).toBe("selected-model");
    expect(llm.fallbackChain).toEqual([
      { provider: "nous-research", model: MODEL },
      { provider: "vercel-v0", model: "selected-model" },
    ]);
    expect(service.get("marketplace").installedProviderIds).toEqual(["vercel-v0", "nous-research"]);
  });

  it("keeps the new id's value where the file holds both ids", () => {
    writeFileSync(settingsPath, JSON.stringify({
      llm: {
        provider: "nous-research",
        vendors: {
          nousResearch: { model: "old-model" },
          "nous-research": { model: MODEL },
        },
        fallbackChain: [
          { provider: "nousResearch", model: MODEL },
          { provider: "nous-research", model: MODEL },
        ],
        modelListCache: {
          [llmModelListCacheKey("nousResearch", BASE_URL)]: cacheEntry("nousResearch", ["old-model"]),
          [llmModelListCacheKey("nous-research", BASE_URL)]: cacheEntry("nous-research", [MODEL]),
        },
        pricingOverrides: [
          { vendor: "nous-research", model: MODEL, inputPer1M: 3, outputPer1M: 4 },
          { vendor: "nousResearch", model: MODEL, inputPer1M: 1, outputPer1M: 2 },
        ],
      },
      marketplace: { installedProviderIds: ["nousResearch", "nous-research"] },
    }), "utf-8");

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const llm = service.get("llm");
    expect(getLlmVendorSettings(llm.vendors, "nous-research").model).toBe(MODEL);
    expect(llm.fallbackChain).toEqual([{ provider: "nous-research", model: MODEL }]);
    expect(Object.values(llm.modelListCache).map((entry) => entry.models)).toEqual([[MODEL]]);
    expect(llm.pricingOverrides).toEqual([
      { vendor: "nous-research", model: MODEL, inputPer1M: 3, outputPer1M: 4 },
    ]);
    expect(service.get("marketplace").installedProviderIds).toEqual(["nous-research"]);
  });

  it("does not run again once the marker is on disk", () => {
    writeFileSync(settingsPath, JSON.stringify({
      appliedMigrations: [MARKER],
      llm: {
        provider: "nousResearch",
        vendors: { nousResearch: { model: MODEL } },
      },
      marketplace: { installedProviderIds: ["nousResearch"] },
    }), "utf-8");

    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    // No rename: normalization treats the old id as the unknown id it is.
    expect(service.get("llm").provider).toBe(DEFAULT_LLM_VENDOR);
    expect(service.get("marketplace").installedProviderIds).toEqual([]);
  });

  it("starts a fresh install already migrated", () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("appliedMigrations")).toContain(MARKER);
  });

  it("moves each API key stored under an old id to the new id's key", async () => {
    writePlainSecrets(secretsPath, {
      "llm.apiKey.nousResearch": "nr_old",
      "llm.apiKey.v0": "v0_old",
      "llm.apiKey.openai": "sk-keep",
    });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });

    await service.migrateRenamedVendorSecrets();

    expect(service.getSecret("llm.apiKey.nous-research")).toBe("nr_old");
    expect(service.getSecret("llm.apiKey.nousResearch")).toBeNull();
    expect(service.getSecret("llm.apiKey.vercel-v0")).toBe("v0_old");
    expect(service.getSecret("llm.apiKey.v0")).toBeNull();
    expect(service.getSecret("llm.apiKey.openai")).toBe("sk-keep");
  });

  it("drops the old key when the new id already has one", async () => {
    writePlainSecrets(secretsPath, { "llm.apiKey.nousResearch": "nr_old", "llm.apiKey.nous-research": "nr_new" });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });

    await service.migrateRenamedVendorSecrets();

    expect(service.getSecret("llm.apiKey.nous-research")).toBe("nr_new");
    expect(service.getSecret("llm.apiKey.nousResearch")).toBeNull();
  });

  it("writes nothing when no old key is stored", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    await service.migrateRenamedVendorSecrets();
    expect(() => readFileSync(secretsPath, "utf-8")).toThrow();

    writePlainSecrets(secretsPath, { "llm.apiKey.openai": "sk-keep" });
    const before = readFileSync(secretsPath, "utf-8");
    await service.migrateRenamedVendorSecrets();
    expect(readFileSync(secretsPath, "utf-8")).toBe(before);
  });

  it("leaves the old key in place without failing the boot when the move fails", async () => {
    // Packaged policy with no OS encryption refuses every secret write.
    writePlainSecrets(secretsPath, { "llm.apiKey.nousResearch": "nr_old" });
    const before = readFileSync(secretsPath, "utf-8");
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "packaged" });

    await expect(service.migrateRenamedVendorSecrets()).resolves.toBeUndefined();
    expect(readFileSync(secretsPath, "utf-8")).toBe(before);

    // The next boot, with writes available again, completes the move.
    const retry = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    await retry.migrateRenamedVendorSecrets();
    expect(retry.getSecret("llm.apiKey.nous-research")).toBe("nr_old");
    expect(retry.getSecret("llm.apiKey.nousResearch")).toBeNull();
  });

  it("deletes the retired marketplace API key and keeps every other secret", async () => {
    writePlainSecrets(secretsPath, { "marketplace.apiKey": "mk_old", "llm.apiKey.openai": "sk-keep" });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });

    await service.deleteRetiredMarketplaceApiKey();

    expect(service.getSecret("marketplace.apiKey")).toBeNull();
    expect(readFileSync(secretsPath, "utf-8")).not.toContain("marketplace.apiKey");
    expect(service.getSecret("llm.apiKey.openai")).toBe("sk-keep");
  });

  it("leaves the retired key for the next boot when the store refuses the write", async () => {
    writePlainSecrets(secretsPath, { "marketplace.apiKey": "mk_old" });
    const before = readFileSync(secretsPath, "utf-8");
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "packaged" });

    await expect(service.deleteRetiredMarketplaceApiKey()).resolves.toBeUndefined();
    expect(readFileSync(secretsPath, "utf-8")).toBe(before);
  });
});

describe("retired vendor profile migration", () => {
  let userDataPath: string;
  let settingsPath: string;
  let secretsPath: string;

  function writeCopilotProfile(): void {
    writeFileSync(settingsPath, JSON.stringify({
      llm: {
        provider: "copilot",
        vendors: {
          copilot: { model: "gpt-5.4-mini" },
          claude: { model: "selected-model" },
          openai: { model: "gpt-5.4" },
        },
        fallbackChain: [{ provider: "copilot", model: "gpt-4.1" }, { provider: "claude", model: "selected-model" }],
      },
    }), "utf-8");
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-retired-vendor-"));
    settingsPath = join(userDataPath, "ave-settings.json");
    secretsPath = join(userDataPath, "ave-secrets.json");
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("moves an active copilot profile off it with a marker, keeping the other vendor blocks", async () => {
    writeCopilotProfile();
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const llm = service.get("llm");

    expect(llm.provider).toBe(DEFAULT_LLM_VENDOR);
    expect(llm.retiredProvider).toBe("copilot");
    expect(Object.keys(llm.vendors)).not.toContain("copilot");
    expect(getLlmVendorSettings(llm.vendors, "claude").model).toBe("selected-model");
    expect(getLlmVendorSettings(llm.vendors, "openai").model).toBe("gpt-5.4");
    expect(llm.fallbackChain).toEqual([{ provider: "claude", model: "selected-model" }]);

    // Written back: the file no longer selects copilot, and the marker survives a restart until the user picks a provider.
    await vi.waitFor(() => {
      const onDisk = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(onDisk.llm.provider).toBe(DEFAULT_LLM_VENDOR);
      expect(onDisk.llm.retiredProvider).toBe("copilot");
    });
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("llm").retiredProvider).toBe("copilot");
  });

  it("keeps the marker through unrelated patches and clears it when a provider is saved", async () => {
    writeCopilotProfile();
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });

    await service.patch({ llm: { pinnedModels: ["gpt-5.4"] } });
    expect(service.get("llm").retiredProvider).toBe("copilot");

    await service.patch({ llm: { provider: "claude" } });
    expect(service.get("llm").provider).toBe("claude");
    expect(service.get("llm").retiredProvider).toBeUndefined();
  });

  it("does not let a patch set the marker", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ llm: { retiredProvider: "copilot" } as never });
    expect(service.get("llm").retiredProvider).toBeUndefined();
  });

  it.each([
    { provider: "deepseek" },
    { provider: "openai-compatible", marketplaceProviderPresetId: "missing-preset" },
  ])("retains the retirement marker when a provider selection is unavailable: %j", async (llmPatch) => {
    writeCopilotProfile();
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ llm: llmPatch as never });
    expect(service.get("llm").retiredProvider).toBe("copilot");
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("llm").retiredProvider).toBe("copilot");
  });

  it("withholds host LLM credentials before reading the secret document until a provider is chosen", async () => {
    writeCopilotProfile();
    writePlainSecrets(secretsPath, { "llm.apiKey.openai": "credential-marker" });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    const read = vi.spyOn(SecretDocumentStore.prototype, "get");
    const encryptedRead = vi.spyOn(SecretDocumentStore.prototype, "getEncrypted");
    try {
      for (const key of ["llm.apiKey.openai", "llm.apiKey.claude", "llm.marketplaceProvider.example.apiKey"]) {
        expect(service.getSecret(key)).toBeNull();
        expect(service.getEncryptedSecret(key)).toBeNull();
      }
      expect(read).not.toHaveBeenCalled();
      expect(encryptedRead).not.toHaveBeenCalled();
      expect(service.hasStoredSecret("llm.apiKey.openai")).toBe(true);
      expect(service.hasStoredSecret("llm.apiKey.claude")).toBe(false);
      expect(read).not.toHaveBeenCalled();
      expect(encryptedRead).not.toHaveBeenCalled();
      await service.patch({ llm: { provider: "openai" } });
      service.getSecret("llm.apiKey.openai");
      expect(read).toHaveBeenCalledOnce();
    } finally {
      read.mockRestore();
      encryptedRead.mockRestore();
    }
  });

  it("retries a failed retired credential deletion without blocking boot or logging the credential", async () => {
    writePlainSecrets(secretsPath, { "llm.apiKey.copilot": "credential-marker" });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deletion = vi.spyOn(service, "deleteSecret").mockRejectedValueOnce(new Error("credential-marker"));
    try {
      await expect(service.deleteRetiredLlmVendorApiKeys()).resolves.toBeUndefined();
      const logContainsCredential = warn.mock.calls.some((call) => JSON.stringify(call).includes("credential-marker"));
      expect(logContainsCredential).toBe(false);
      await service.deleteRetiredLlmVendorApiKeys();
      expect(service.getSecret("llm.apiKey.copilot")).toBeNull();
      const afterDelete = statSync(secretsPath).mtimeMs;
      await service.deleteRetiredLlmVendorApiKeys();
      expect(statSync(secretsPath).mtimeMs).toBe(afterDelete);
      expect(deletion).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
      deletion.mockRestore();
    }
  });

  it("deletes a retired vendor credential and preserves other keys", async () => {
    writePlainSecrets(secretsPath, { "llm.apiKey.copilot": "gh-models-token", "llm.apiKey.openai": "sk-keep" });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    expect(service.getSecret("llm.apiKey.copilot")).not.toBeNull();

    await service.deleteRetiredLlmVendorApiKeys();

    expect(service.getSecret("llm.apiKey.copilot")).toBeNull();
    expect(service.getSecret("llm.apiKey.openai")).toBe("sk-keep");
    expect(readFileSync(secretsPath, "utf-8")).not.toContain("gh-models-token");
  });
});

describe("retired model profile (design model-capability-catalog §6.1)", () => {
  let userDataPath: string;
  let settingsPath: string;

  function writeProfile(llm: Record<string, unknown>): void {
    writeFileSync(settingsPath, JSON.stringify({ llm }), "utf-8");
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-retired-model-"));
    settingsPath = join(userDataPath, "ave-settings.json");
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  /** A complete native OpenAI listing that no longer names `gpt-4o`. */
  const listingWithout = (models: string[]) => ({
    x: { vendor: "openai", endpoint: "https://api.openai.com/v1/models", models, complete: true, fetchedAt: "2026-10-13T00:00:00.000Z" },
  });

  it("does not block a saved model the catalog only deprecates, and keeps the saved id", () => {
    // o4-mini is `deprecated` in the bundled catalog: the deprecated tier.
    writeProfile({ provider: "openai", vendors: { openai: { model: "o4-mini" } } });
    const llm = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm");
    expect(llm.provider).toBe("openai");
    expect(getLlmVendorSettings(llm.vendors, "openai").model).toBe("o4-mini");
    expect(llm.retiredProvider).toBeUndefined();
  });

  it("keeps the host's API credentials for a deprecated model", () => {
    writeProfile({ provider: "openai", vendors: { openai: { model: "o4-mini" } } });
    writePlainSecrets(join(userDataPath, "ave-secrets.json"), { "llm.apiKey.openai": "credential-marker" });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    expect(service.getSecret("llm.apiKey.openai")).toBe("credential-marker");
  });

  it("drops a deprecated-tier marker an earlier build stored for the same model, releasing its keys", () => {
    writeProfile({
      provider: "openai",
      vendors: { openai: { model: "o4-mini" } },
      retiredProvider: { vendor: "openai", model: "o4-mini", reason: "catalog-deprecated" },
    });
    writePlainSecrets(join(userDataPath, "ave-secrets.json"), { "llm.apiKey.openai": "credential-marker" });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    expect(service.get("llm").retiredProvider).toBeUndefined();
    expect(service.getSecret("llm.apiKey.openai")).toBe("credential-marker");
  });

  it("retires a deprecated model the vendor's complete listing also dropped: the listing outranks the catalog", () => {
    writeProfile({ provider: "openai", vendors: { openai: { model: "o4-mini" } }, modelListCache: listingWithout(["gpt-5.4"]) });
    const llm = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm");
    expect(llm.retiredProvider).toEqual({ vendor: "openai", model: "o4-mini", reason: "unlisted" });
  });

  it("marks a saved model the vendor's last complete listing no longer names", () => {
    writeProfile({
      provider: "openai",
      vendors: { openai: { model: "gpt-4o" } },
      modelListCache: {
        x: { vendor: "openai", endpoint: "https://api.openai.com/v1/models", models: ["gpt-5.4"], complete: true, fetchedAt: "2026-10-13T00:00:00.000Z" },
      },
    });
    const llm = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm");
    expect(llm.retiredProvider).toEqual({ vendor: "openai", model: "gpt-4o", reason: "unlisted" });
  });

  it("does not mark a model from a listing that is not known to be complete", () => {
    writeProfile({
      provider: "openai",
      vendors: { openai: { model: "gpt-4o" } },
      modelListCache: {
        x: { vendor: "openai", endpoint: "https://api.openai.com/v1/models", models: ["gpt-5.4"], fetchedAt: "2026-10-13T00:00:00.000Z" },
      },
    });
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm").retiredProvider).toBeUndefined();
  });

  it("re-judges every load: a stored marker for a model the profile no longer names is dropped", () => {
    writeProfile({
      provider: "openai",
      vendors: { openai: { model: "gpt-5.4" } },
      retiredProvider: { vendor: "openai", model: "gpt-4o", reason: "unlisted" },
    });
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm").retiredProvider).toBeUndefined();
  });

  it("lets a retired vendor win over a retired model", () => {
    writeProfile({ provider: "copilot", vendors: { openai: { model: "o4-mini" } } });
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm").retiredProvider).toBe("copilot");
  });

  it("keeps the marker through ordinary saves and clears it when a model is picked", async () => {
    writeProfile({ provider: "openai", vendors: { openai: { model: "gpt-4o" } }, modelListCache: listingWithout(["gpt-5.4"]) });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ llm: { pinnedModels: ["gpt-5.4"] } });
    expect(service.get("llm").retiredProvider).toMatchObject({ model: "gpt-4o" });
    await service.patch({ llm: { provider: "openai", vendors: { openai: { model: "gpt-5.4" } } } as never });
    expect(service.get("llm").retiredProvider).toBeUndefined();
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("llm").retiredProvider).toBeUndefined();
  });

  it("withholds the host's API credentials while a retired model is unresolved", async () => {
    writeProfile({ provider: "openai", vendors: { openai: { model: "gpt-4o" } }, modelListCache: listingWithout(["gpt-5.4"]) });
    writePlainSecrets(join(userDataPath, "ave-secrets.json"), { "llm.apiKey.openai": "credential-marker" });
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath, secretPolicy: "development" });
    expect(service.getSecret("llm.apiKey.openai")).toBeNull();
    await service.patch({ llm: { provider: "openai", vendors: { openai: { model: "gpt-5.4" } } } as never });
    expect(service.getSecret("llm.apiKey.openai")).toBe("credential-marker");
  });

  it("keeps a listing's completeness only while the cache holds every id", () => {
    const entry = (models: string[]) => ({
      vendor: "openai", endpoint: "https://api.openai.com/v1/models", models, complete: true, fetchedAt: "2026-10-13T00:00:00.000Z",
    });
    writeProfile({ provider: "openai", vendors: { openai: { model: "gpt-5.4" } }, modelListCache: { a: entry(["gpt-5.4"]) } });
    const kept = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm").modelListCache ?? {};
    expect(Object.values(kept)[0]).toHaveProperty("complete", true);
    const many = Array.from({ length: MAX_CACHED_LLM_MODEL_IDS + 1 }, (_, index) => `fixture-${index}`);
    writeProfile({ provider: "openai", vendors: { openai: { model: "gpt-5.4" } }, modelListCache: { a: entry(many) } });
    const cut = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm");
    expect(Object.values(cut.modelListCache ?? {})[0]).not.toHaveProperty("complete");
    expect(cut.retiredProvider).toBeUndefined();
  });

  it("keeps a saved fallback at a retired model as saved", () => {
    writeProfile({ provider: "openai", vendors: { openai: { model: "gpt-5.4" } }, fallbackChain: [{ provider: "openai", model: "gpt-4o" }] });
    const llm = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm");
    expect(llm.fallbackChain).toEqual([{ provider: "openai", model: "gpt-4o" }]);
  });
});

it("notifies only the written settings key after persistence and releases observers", async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), "settings-observer-"));
  try {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    const persistedValues: boolean[] = [];
    const observer = vi.fn(() => {
      const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
      persistedValues.push(reloaded.get("alerts").osNotificationsEnabled);
    });
    const other = vi.fn();
    const unsubscribe = service.onChanged("alerts", observer);
    service.onChanged("retiredPluginConfigs", other);
    service.onChanged("alerts", () => { throw new Error("observer failed"); });
    await service.set("alerts", { ...service.get("alerts"), osNotificationsEnabled: false });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(persistedValues).toEqual([false]);
    expect(other).not.toHaveBeenCalled();
    unsubscribe();
    await service.set("alerts", { ...service.get("alerts"), osNotificationsEnabled: true });
    expect(observer).toHaveBeenCalledTimes(1);
  } finally { await cleanupTmpDir(userDataPath); }
});

describe("SettingsService llm.modelCatalogRefresh", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-model-catalog-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  const stored = (llm: Record<string, unknown>) => {
    writeFileSync(join(userDataPath, "ave-settings.json"), currentSettingsJson({ llm }), "utf-8");
    return new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
  };

  it("defaults the refresh on", () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("llm").modelCatalogRefresh).toBe("auto");
  });

  it("keeps a stored off and reads anything unreadable as the default", () => {
    expect(stored({ modelCatalogRefresh: "off" }).get("llm").modelCatalogRefresh).toBe("off");
    expect(stored({ modelCatalogRefresh: "never" }).get("llm").modelCatalogRefresh).toBe("auto");
    expect(stored({ modelCatalogRefresh: { refresh: "off" } }).get("llm").modelCatalogRefresh).toBe("auto");
  });

  it("applies a patch from the settings switch and keeps it across a reload", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ llm: { modelCatalogRefresh: "off" } });
    expect(service.get("llm").modelCatalogRefresh).toBe("off");
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("llm").modelCatalogRefresh).toBe("off");
    await service.patch({ llm: { streamSmoothing: "word" } });
    expect(service.get("llm").modelCatalogRefresh).toBe("off");
  });
});

describe("SettingsService system — main window layout", () => {
  let userDataPath: string;
  const layout = {
    version: 1,
    tree: {
      kind: "split",
      axis: "row",
      children: [{ kind: "leaf", chatGroupId: "main" }, { kind: "leaf", chatGroupId: "group-2" }],
      sizes: [0.5, 0.5],
    },
    focusedId: "group-2",
    surfaces: { "group-2": { kind: "terminal", tabId: "terminal:0000000a-3", ordinal: 1, cwd: "/ws/app", url: null } },
    panelOpenIds: ["main"],
    thumbnailOpenIds: ["group-2"],
    sideTabs: { main: [{ kind: "browser", tabId: "browser:0000000a-4", ordinal: 1, cwd: null, url: "https://example.com/" }] },
  } as const;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-main-layout-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTmpDir(userDataPath);
  });

  it("is absent until the window first saves one, then round-trips across restart", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("system").mainLayout).toBeUndefined();
    await service.patch({ system: { mainLayout: layout } } as never);
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("system").mainLayout).toEqual(layout);
  });

  it("refuses a patch that breaks a layout rule and keeps the saved layout", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    await service.patch({ system: { mainLayout: layout } } as never);
    await service.patch({ system: { mainLayout: { ...layout, focusedId: "group-9" } } } as never);
    expect(service.get("system").mainLayout).toEqual(layout);
  });

  it("drops a corrupt layout on disk whole, leaving the rest of system intact", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      currentSettingsJson({ system: { closeBehavior: "quit", mainLayout: { ...layout, version: 99 } } }),
      "utf-8",
    );
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("system").mainLayout).toBeUndefined();
    expect(service.get("system").closeBehavior).toBe("quit");
  });
});

describe("SettingsService Files tree width", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-files-tree-width-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  it("migrates the old file split once, persists pixels, and removes the percent key", async () => {
    const path = join(userDataPath, "ave-settings.json");
    writeFileSync(path, currentSettingsJson({ system: { sidePanelSplitFilePercent: 60 } }));
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("system").sidePanelFileTreeWidth).toBe(400);
    expect(service.get("system")).not.toHaveProperty("sidePanelSplitFilePercent");
    await vi.waitFor(() => expect(JSON.parse(readFileSync(path, "utf-8")).system.sidePanelFileTreeWidth).toBe(400));
    const stored = JSON.parse(readFileSync(path, "utf-8"));
    expect(stored.system.sidePanelFileTreeWidth).toBe(400);
    expect(stored.system).not.toHaveProperty("sidePanelSplitFilePercent");
    expect(new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath }).get("system").sidePanelFileTreeWidth).toBe(400);
  });

  it.each([[45, 300], [5, 180], [95, 520], ["wide", 300]])("normalizes a legacy %s split to %s pixels", (legacy, expected) => {
    writeFileSync(join(userDataPath, "ave-settings.json"), currentSettingsJson({ system: { sidePanelSplitFilePercent: legacy } }));
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("system").sidePanelFileTreeWidth).toBe(expected);
  });

  it("keeps an explicit pixel width ahead of the retired percent value", () => {
    writeFileSync(join(userDataPath, "ave-settings.json"), currentSettingsJson({ system: {
      sidePanelSplitFilePercent: 60, sidePanelFileTreeWidth: 241.5,
    } }));
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("system").sidePanelFileTreeWidth).toBe(242);
  });

  it("round-trips a clamped pixel preference and ignores invalid or retired-key patches", async () => {
    const service = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(service.get("system").sidePanelFileTreeWidth).toBe(300);
    await service.patch({ system: { ...service.get("system"), sidePanelFileTreeWidth: 420.6 } });
    expect(service.get("system").sidePanelFileTreeWidth).toBe(421);
    await service.patch({ system: { ...service.get("system"), sidePanelFileTreeWidth: 900 } });
    expect(service.get("system").sidePanelFileTreeWidth).toBe(520);
    await service.patch({ system: { ...service.get("system"), sidePanelFileTreeWidth: 1 } });
    expect(service.get("system").sidePanelFileTreeWidth).toBe(180);
    await service.patch({ system: { ...service.get("system"), sidePanelFileTreeWidth: Number.NaN } });
    await service.patch({ system: { sidePanelFileTreeWidth: "wide" } } as never);
    await service.patch({ system: { sidePanelSplitFilePercent: 78 } } as never);
    expect(service.get("system").sidePanelFileTreeWidth).toBe(180);
    const reloaded = new SettingsService({ encryption: mockedElectron.safeStorage, userDataPath });
    expect(reloaded.get("system").sidePanelFileTreeWidth).toBe(180);
    expect(reloaded.get("system")).not.toHaveProperty("sidePanelSplitFilePercent");
  });
});
