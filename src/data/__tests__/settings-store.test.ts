import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const mockedElectron = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  safeStorage: mockedElectron.safeStorage,
}));

import { SettingsService } from "../settings-store.js";

describe("SettingsService marketplace defaults", () => {
  let userDataPath: string;

  beforeEach(() => {
    mkdirSync(join(homedir(), ".ave", "test-tmp"), { recursive: true });
    userDataPath = mkdtempSync(join(homedir(), ".ave", "test-tmp", "settings-store-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("defaults to the safe mock marketplace backend", () => {
    const service = new SettingsService({ userDataPath });

    expect(service.get("marketplace")).toEqual({
      backend: "mock",
      realCloudAllowPrivateNetwork: false,
    });
  });

  it("migrates the legacy localhost real-cloud default back to the safe mock backend", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        marketplace: {
          backend: "real-cloud",
          realCloudBaseUrl: "http://localhost:8000",
          realCloudAllowPrivateNetwork: true,
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ userDataPath });

    expect(service.get("marketplace")).toEqual({
      backend: "mock",
      realCloudAllowPrivateNetwork: false,
    });
  });

  it("preserves an explicitly configured real-cloud endpoint", () => {
    writeFileSync(
      join(userDataPath, "ave-settings.json"),
      JSON.stringify({
        marketplace: {
          backend: "real-cloud",
          realCloudBaseUrl: "https://marketplace.ave.internal.portal.example.com",
          realCloudAllowPrivateNetwork: false,
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ userDataPath });

    expect(service.get("marketplace")).toEqual({
      backend: "real-cloud",
      realCloudBaseUrl: "https://marketplace.ave.internal.portal.example.com",
      realCloudAllowPrivateNetwork: false,
    });
  });
});

describe("SettingsService lyraMail patching", () => {
  let userDataPath: string;

  beforeEach(() => {
    mkdirSync(join(homedir(), ".ave", "test-tmp"), { recursive: true });
    userDataPath = mkdtempSync(join(homedir(), ".ave", "test-tmp", "settings-store-lyramail-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("patch() persists lyraMail environment changes across restart", async () => {
    const service = new SettingsService({ userDataPath });

    await service.patch({ lyraMail: { environment: "corporate" } });
    expect(service.get("lyraMail")).toEqual({ environment: "corporate" });

    const reloaded = new SettingsService({ userDataPath });
    expect(reloaded.get("lyraMail")).toEqual({ environment: "corporate" });
  });
});
