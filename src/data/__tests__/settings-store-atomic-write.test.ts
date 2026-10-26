import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { directHostFetchTransport } from "../../__tests__/support/host-fetch-transport.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { SettingsService, settingsFilePath } from "../settings-store.js";
import { CredentialLeaseRegistry } from "../../plugins/secret-access/credential-lease-registry.js";
import { evaluateHostFetch, runHostFetchHops } from "../../main/host-fetch-guard.js";

let root: string;
let service: SettingsService;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ave-settings-atomic-"));
  service = new SettingsService({ userDataPath: root, encryption: unavailableSecretEncryption });
  await service.patch({ system: { ...service.get("system"), hardwareAcceleration: false } });
});
afterEach(async () => cleanupTmpDir(root));

describe("settings persistence", () => {
  it.each(["rotate", "same-value", "delete", "bulk-delete"] as const)("fences a secret %s before the file lock returns", async (change) => {
    const key = change === "bulk-delete" ? "plugin.fixture.token" : "llm.apiKey.openai";
    const store = new SettingsService({
      userDataPath: root,
      encryption: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "external_key",
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    });
    await store.setSecret(key, "synthetic-old-key");
    const registry = new CredentialLeaseRegistry(store);
    const incarnation = {};
    const permissionSignal = new AbortController().signal;
    const reservation = registry.reserve("fixture", incarnation, [key], permissionSignal, "lease");
    if (!reservation) throw new Error("reservation missing");
    const lease = registry.register(reservation, {
      key, vendor: "openai", secret: store.getSecret(key)!, scheme: "bearer",
      audience: (url) => url.origin === "https://api.example.test", permissionSignal,
    });
    if (!lease || lease.exposure !== "lease") throw new Error("lease missing");
    const use = registry.beginUse(lease.leaseId, "fixture", incarnation);
    const secretStore = (store as unknown as { secretStore: { runtime: { lock: (path: string, callback: () => Promise<unknown>) => Promise<unknown> } } }).secretStore;
    const realLock = secretStore.runtime.lock;
    let signalVisible!: () => void;
    let releaseLock!: () => void;
    const visible = new Promise<void>((resolve) => { signalVisible = resolve; });
    const held = new Promise<void>((resolve) => { releaseLock = resolve; });
    vi.spyOn(secretStore.runtime, "lock").mockImplementationOnce((path, callback) => realLock(path, async () => {
      const result = await callback();
      signalVisible();
      await held;
      return result;
    }));
    const changing = change === "rotate" ? store.setSecret(key, "synthetic-new-key")
      : change === "same-value" ? store.setSecret(key, "synthetic-old-key")
      : change === "delete" ? store.deleteSecret(key)
        : store.deletePluginSecrets("fixture", ["token"]);
    try {
      await visible;
      expect(store.getSecret(key)).toBe(change === "rotate" ? "synthetic-new-key"
        : change === "same-value" ? "synthetic-old-key" : null);
      const first = await evaluateHostFetch({
        pluginId: "fixture", rawUrl: "https://api.example.test/v1", allowedDomains: ["api.example.test"],
        ensurePublicUrl: async (rawUrl) => new URL(rawUrl),
      });
      if (!first.ok) throw new Error(first.message);
      const transport = vi.fn(async () => new Response(null));
      await expect(runHostFetchHops({
        pluginId: "fixture", first, init: {}, transport: directHostFetchTransport(transport as typeof fetch),
        allowedDomains: ["api.example.test"], allowPrivateNetworks: false, credentialUse: use,
      })).rejects.toMatchObject({ code: "lease-unavailable" });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      releaseLock();
      await changing;
    }
  });

  it.each(["install", "update", "uninstall"] as const)("advances the configuration revision before a preset %s save completes", async (change) => {
    const store = new SettingsService({
      userDataPath: root,
      encryption: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "external_key",
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    });
    const preset = {
      providerId: "fixture-router", label: "Fixture Router", baseUrl: "https://router.example.test/v1",
      defaultModel: "fixture", modelOptions: ["fixture"], requiresApiKey: true,
    };
    if (change !== "install") await store.installMarketplaceProviderPreset(preset);
    const before = store.getProviderConfigRevision();
    const save = vi.spyOn(store as unknown as { saveSettings(settings: unknown): Promise<void> }, "saveSettings");
    const realSave = (settings: unknown) => (SettingsService.prototype as unknown as { saveSettings(settings: unknown): Promise<void> }).saveSettings.call(store, settings);
    let releaseSave!: () => void;
    const held = new Promise<void>((resolve) => { releaseSave = resolve; });
    save.mockImplementationOnce(async (settings) => { await held; await realSave(settings); });
    const changing = change === "uninstall" ? store.uninstallMarketplaceProviderPreset(preset.providerId)
      : store.installMarketplaceProviderPreset(change === "update"
        ? { ...preset, baseUrl: "https://other.example.test/v1" } : preset);
    try {
      expect(store.getProviderConfigRevision()).toBeGreaterThan(before);
    } finally {
      releaseSave();
      await changing;
    }
  });

  it.each(["rollback", "commit"] as const)("fences leases across a visible endpoint change and %s", async (outcome) => {
    const key = "llm.apiKey.openai";
    const registry = new CredentialLeaseRegistry(service);
    const incarnation = {};
    const permission = new AbortController();
    const issue = () => {
      const origin = new URL(service.get("llm").vendors.openai?.baseUrl ?? "").origin;
      const reservation = registry.reserve("fixture", incarnation, [key], permission.signal, "lease");
      if (!reservation) throw new Error("reservation missing");
      const result = registry.register(reservation, {
        key, vendor: "openai", secret: "synthetic-secret", scheme: "bearer",
        audience: (url) => url.origin === origin, permissionSignal: permission.signal,
      });
      if (!result || result.exposure !== "lease") throw new Error("lease missing");
      return result;
    };
    await service.patch({ llm: { vendors: { openai: { baseUrl: "https://a.example.test" } } } });
    const before = issue();
    const closedBefore = vi.fn();
    before.onClosed(closedBefore);
    const save = vi.spyOn(service as unknown as { saveSettings(settings: unknown): Promise<void> }, "saveSettings");
    const realSave = (settings: unknown) => (SettingsService.prototype as unknown as { saveSettings(settings: unknown): Promise<void> }).saveSettings.call(service, settings);
    let settle!: () => void;
    save.mockImplementationOnce((settings) => new Promise<void>((resolve, reject) => {
      settle = () => {
        if (outcome === "rollback") reject(new Error("disk full"));
        else void realSave(settings).then(resolve, reject);
      };
    }));
    const writing = service.patch({ llm: { vendors: { openai: { baseUrl: "https://b.example.test" } } } });
    expect(service.get("llm").vendors.openai?.baseUrl).toBe("https://b.example.test");
    expect(closedBefore).toHaveBeenCalledWith("revoked");
    const during = issue();
    const closedDuring = vi.fn();
    during.onClosed(closedDuring);
    settle();
    if (outcome === "rollback") {
      await expect(writing).rejects.toThrow("disk full");
      expect(service.get("llm").vendors.openai?.baseUrl).toBe("https://a.example.test");
      expect(closedDuring).toHaveBeenCalledWith("revoked");
      expect(() => registry.beginUse(during.leaseId, "fixture", incarnation)).toThrowError(expect.objectContaining({ code: "lease-unavailable" }));
    } else {
      await writing;
      expect(closedDuring).not.toHaveBeenCalled();
      expect(registry.beginUse(during.leaseId, "fixture", incarnation).headersFor(new URL("https://b.example.test"), 0).get("authorization")).toBe("Bearer synthetic-secret");
      expect(() => registry.beginUse(during.leaseId, "fixture", incarnation)
        .headersFor(new URL("https://a.example.test"), 0))
        .toThrowError(expect.objectContaining({ code: "lease-audience-denied" }));
    }
  });

  it.skipIf(process.platform === "win32")("lets an existing reader finish the previous complete settings while publishing the next version", async () => {
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

  // When Windows replacement exhausts lock retries, both readers and disk must retain complete prior settings.
  it.runIf(process.platform === "win32")("keeps the previous complete settings for an open reader when Windows refuses the publish", async () => {
    const path = settingsFilePath(root);
    const before = readFileSync(path, "utf8");
    const fd = openSync(path, "r");
    try {
      await expect(service.patch({ system: { ...service.get("system"), hardwareAcceleration: true } }))
        .rejects.toMatchObject({ code: "EPERM" });
      expect(readFileSync(fd, "utf8")).toBe(before);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      closeSync(fd);
    }
    await service.patch({ system: { ...service.get("system"), hardwareAcceleration: true } });
    expect(JSON.parse(readFileSync(path, "utf8")).system.hardwareAcceleration).toBe(true);
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

  it("fails every write not yet on disk when a save fails, and keeps memory on disk", async () => {
    const save = vi.spyOn(service as unknown as { saveSettings(settings: unknown): Promise<void> }, "saveSettings");
    save.mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new Error("disk full")), 20)));

    const failing = service.patch({ system: { ...service.get("system"), hardwareAcceleration: true } });
    const onTop = service.setPluginConfig("sample", { mode: "fast" });

    await expect(failing).rejects.toThrow("disk full");
    await expect(onTop).rejects.toThrow("disk full");
    expect(service.get("system").hardwareAcceleration).toBe(false);
    expect(service.getPluginConfig("sample")).toEqual({});

    await service.setPluginConfig("sample", { mode: "slow" });
    const saved = JSON.parse(readFileSync(settingsFilePath(root), "utf8"));
    expect(saved.system.hardwareAcceleration).toBe(false);
    expect(saved.pluginConfigs.sample).toEqual({ mode: "slow" });
  });

  it("applies a write when it is made, so a read and the write built from it stay atomic while a save waits", async () => {
    const save = vi.spyOn(service as unknown as { saveSettings(settings: unknown): Promise<void> }, "saveSettings");
    const real = (settings: unknown) => (SettingsService.prototype as unknown as { saveSettings(settings: unknown): Promise<void> }).saveSettings.call(service, settings);
    save.mockImplementationOnce((settings) => new Promise((resolve, reject) => setTimeout(() => real(settings).then(resolve, reject), 20)));

    const first = service.patch({ system: { ...service.get("system"), hardwareAcceleration: true } });
    const queued = service.setPluginConfig("sample", { mode: "fast" });
    expect(service.getPluginConfig("sample")).toEqual({ mode: "fast" });
    const built = service.set("pluginConfigs", { ...service.get("pluginConfigs"), other: { mode: "slow" } });

    await Promise.all([first, queued, built]);
    const saved = JSON.parse(readFileSync(settingsFilePath(root), "utf8"));
    expect(saved.system.hardwareAcceleration).toBe(true);
    expect(saved.pluginConfigs).toMatchObject({ sample: { mode: "fast" }, other: { mode: "slow" } });
  });
});

it("does not publish a settings change before its write succeeds", async () => {
  const observer = vi.fn();
  service.onChanged("retiredPluginConfigs", observer);
  const save = vi.spyOn(service as unknown as { saveSettings(settings: unknown): Promise<void> }, "saveSettings");
  let fail!: (error: Error) => void;
  save.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const writing = service.set("retiredPluginConfigs", {});
  await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
  expect(observer).not.toHaveBeenCalled();
  fail(new Error("disk full"));
  await expect(writing).rejects.toThrow("disk full");
  expect(observer).not.toHaveBeenCalled();
});
