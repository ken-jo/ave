/** Exercise secret-gate tier ordering; the grant tests independently cover source and artifact evidence. */
import { describe, expect, it, vi } from "vitest";
import type { HostSecretGrantEvidence } from "../grants.js";
import { runSecretGate, type SecretGateInput } from "../secret-gate.js";
import type { PluginRegistryTrust } from "../../types.js";

const PIN = "a".repeat(64);
const MANIFEST = "m".repeat(64);

const officialEntry: PluginRegistryTrust = {
  installSource: "user",
  manifestSha256: MANIFEST,
  origin: {
    sourceId: "ave",
    sourceOrigin: "official",
    commit: "c".repeat(40),
    packagePath: "plugins/meeting",
    version: "2.1.0",
    rung: "release",
    artifactSha256: PIN,
    installedAt: "2026-09-23T00:00:00.000Z",
  },
};

const pinned: HostSecretGrantEvidence = {
  officialPins: async () => [PIN],
  receiptArtifactSha256: async () => null,
};

function gate(overrides: Partial<SecretGateInput> & { activeProvider?: string } = {}) {
  const { activeProvider = "openai", ...rest } = overrides;
  const readSettings = vi.fn(() => ({
    llmProvider: activeProvider,
    marketplaceProviderPresetId: undefined,
    readInstalledProviderPresetIds: () => [],
  }));
  const readRegistryEntry = vi.fn(async () => officialEntry);
  const input: SecretGateInput = {
    operation: "lease",
    pluginId: "meeting",
    key: "llm.apiKey.openai",
    allowlist: ["llm.apiKey.openai"],
    manifestSha256: MANIFEST,
    readRegistryEntry,
    grantEvidence: pinned,
    readSettings,
    ...rest,
  };
  return { outcome: runSecretGate(input), readSettings, readRegistryEntry: input.readRegistryEntry };
}

describe("runSecretGate", () => {
  it("refuses export of a host-provider key before provenance or settings reads", async () => {
    const { outcome, readRegistryEntry, readSettings } = gate({ operation: "export" });
    await expect(outcome).resolves.toEqual({ kind: "deny", tier: "tier-2", reason: "provider-key-not-exportable" });
    expect(readRegistryEntry).not.toHaveBeenCalled();
    expect(readSettings).not.toHaveBeenCalled();
  });
  it("allows a granted official install of the pinned artifact for the active vendor", async () => {
    await expect(gate().outcome).resolves.toEqual({ kind: "allow" });
  });

  it("allows the plugin's own namespace without reading the registry or settings", async () => {
    const { outcome, readRegistryEntry, readSettings } = gate({ pluginId: "notes", key: "plugin.notes.token", allowlist: [] });
    await expect(outcome).resolves.toEqual({ kind: "allow", via: "own-namespace" });
    expect(readRegistryEntry).not.toHaveBeenCalled();
    expect(readSettings).not.toHaveBeenCalled();
  });

  it("refuses a key the manifest does not list, before reading the registry", async () => {
    const { outcome, readRegistryEntry } = gate({ allowlist: ["llm.apiKey.claude"] });
    await expect(outcome).resolves.toEqual({ kind: "deny", tier: "tier-2", reason: "not-allowlisted" });
    expect(readRegistryEntry).not.toHaveBeenCalled();
  });

  it("refuses at Tier 3 with the grant's reason, before reading the active vendor", async () => {
    const notes = gate({ pluginId: "notes", allowlist: ["llm.apiKey.openai"] });
    await expect(notes.outcome).resolves.toEqual({ kind: "deny", tier: "tier-3", reason: "not-in-grant-table" });
    expect(notes.readSettings).not.toHaveBeenCalled();

    const local = gate({ readRegistryEntry: async () => ({ installSource: "local-dev", manifestSha256: MANIFEST }) });
    await expect(local.outcome).resolves.toEqual({ kind: "deny", tier: "tier-3", reason: "not-official" });

    const swapped = gate({ manifestSha256: "x".repeat(64) });
    await expect(swapped.outcome).resolves.toEqual({ kind: "deny", tier: "tier-3", reason: "manifest-sha-mismatch" });

    const unpinned = gate({ grantEvidence: { ...pinned, officialPins: async () => [] } });
    await expect(unpinned.outcome).resolves.toEqual({ kind: "deny", tier: "tier-3", reason: "artifact-not-pinned" });
  });

  it("grants nothing on an admin install that meets no grant condition", async () => {
    const admin = gate({ readRegistryEntry: async () => ({ installSource: "admin", manifestSha256: MANIFEST }) });
    await expect(admin.outcome).resolves.toEqual({ kind: "deny", tier: "tier-3", reason: "not-official" });
  });

  it("refuses a granted plugin for a vendor that is not the active one", async () => {
    await expect(gate({ activeProvider: "claude" }).outcome).resolves.toEqual({ kind: "deny", tier: "tier-4", reason: "vendor-mismatch" });
  });
});
