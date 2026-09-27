/**
 * #893 Ralph cycle 1 HIGH — unit tests for the host implementation of
 * `hostApi.resolveApiKey()`. Runs the same 4-tier secret gate as
 * `hostApi.getSecret` and exercises every refusal branch:
 *   - signal.aborted at entry → reason="aborted"
 *   - own-namespace (Tier-1) short-circuit
 *   - manifest allowlist (Tier-2) miss → reason="not-whitelisted"
 *   - host-secret grant (Tier-3, design §10.3) refusal → reason="not-whitelisted"
 *   - vendor cross-check (Tier-4) deny — runs AFTER Tier-3 (cycle 1 MEDIUM)
 *   - success path: bearer + release() lifetime, signal-bound release
 *   - vendor alias normalization (public "anthropic" → host "claude")
 *   - azure-foundry baseUrl resolution
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveApiKey } from "../resolve-api-key.js";
import { resetHostSecretCountersForTesting } from "../../../telemetry/host-secret-counters.js";
import type { PluginManifest, PluginRegistryTrust } from "../../../plugins/types.js";
import type { HostSecretGrantEvidence } from "../../../plugins/secret-access/grants.js";
import { manifestSha } from "../../../__tests__/support/manifest-sha-fixture.js";

// -------- helpers --------

/** A plugin the app's grant table lists (design §10.3). */
const GRANTED = "meeting";
const PIN = "a".repeat(64);

/**
 * Tier 3's inputs for an official install of the artifact the official
 * snapshot pins, running the manifest recorded at install: the one case the
 * grant table answers yes to.
 */
function officialGrant(manifestSha256: string, entry: Partial<PluginRegistryTrust> = {}) {
  const grantEvidence: HostSecretGrantEvidence = {
    officialPins: async () => [PIN],
    receiptArtifactSha256: async () => null,
  };
  return {
    readRegistryEntry: async (): Promise<PluginRegistryTrust | undefined> => ({
      installSource: "user",
      manifestSha256,
      origin: {
        sourceId: "ave",
        sourceOrigin: "official",
        commit: "c".repeat(40),
        packagePath: `plugins/${GRANTED}`,
        version: "1.0.0",
        rung: "release",
        artifactSha256: PIN,
        installedAt: "2026-09-24T00:00:00.000Z",
      },
      ...entry,
    }),
    grantEvidence,
  };
}

/** Tier 3's inputs for a plugin with no registry entry: nothing is ever granted, so nothing is read. */
const NO_GRANT = {
  readRegistryEntry: async (): Promise<PluginRegistryTrust | undefined> => undefined,
  grantEvidence: {
    officialPins: async () => {
      throw new Error("no grant evidence is read for a plugin without an entry");
    },
    receiptArtifactSha256: async () => {
      throw new Error("no grant evidence is read for a plugin without an entry");
    },
  } satisfies HostSecretGrantEvidence,
};

function manifestFor(pluginId: string, allowedKeys: string[]): PluginManifest {
  return {
    id: pluginId,
    name: pluginId,
    version: "0.0.0",
    entry: "index.js",
    description: "test fixture",
    tools: [],
    hostSecrets: { read: allowedKeys },
  } as PluginManifest;
}

function makeAuditLogger() {
  const log = vi.fn();
  return { log, mock: log };
}

interface SettingsOverrides {
  provider: string;
  marketplaceProviderPresetId?: string;
  /** Defaults to "the active preset is installed", the realistic state. */
  installedProviderPresetIds?: readonly string[];
  secrets?: Record<string, string | null>;
  baseUrl?: string;
}

function makeSettingsService(overrides: SettingsOverrides) {
  return {
    get: vi.fn((key: string) => {
      if (key === "llm") {
        return {
          provider: overrides.provider,
          ...(overrides.marketplaceProviderPresetId
            ? { marketplaceProviderPresetId: overrides.marketplaceProviderPresetId }
            : {}),
          vendors: {
            "azure-foundry": overrides.baseUrl
              ? { baseUrl: overrides.baseUrl }
              : {},
          },
        };
      }
      if (key === "marketplace") {
        const installed =
          overrides.installedProviderPresetIds ??
          (overrides.marketplaceProviderPresetId
            ? [overrides.marketplaceProviderPresetId]
            : []);
        return { installedProviderPresets: installed.map((providerId) => ({ providerId })) };
      }
      return undefined;
    }),
    getSecret: vi.fn((key: string) => overrides.secrets?.[key] ?? null),
  };
}

// -------- tests --------

beforeEach(() => {
  resetHostSecretCountersForTesting();
});

describe("resolveApiKey — signal.aborted at entry", () => {
  it("returns reason=aborted before touching settings", async () => {
    const ac = new AbortController();
    ac.abort();
    const manifest = manifestFor("p", []);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai", signal: ac.signal },
      {
        pluginId: "p",
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService({ provider: "openai" }) as never,
        auditLogger: makeAuditLogger(),
        ...NO_GRANT,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("aborted");
  });
});

describe("resolveApiKey — Tier-1 own-namespace short-circuit", () => {
  it("returns ok=true when plugin.<id>.llm.apiKey.<vendor> is set in settings", async () => {
    const manifest = manifestFor("plugin-x", []);
    const settings = makeSettingsService({
      provider: "openai",
      secrets: { "plugin.plugin-x.llm.apiKey.openai": "sk-own-namespace" },
    });
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "plugin-x",
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: settings as never,
        auditLogger: makeAuditLogger(),
        ...NO_GRANT,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bearer()).toBe("sk-own-namespace");
      expect(result.vendor).toBe("openai");
    }
  });

  it("rejects URL-shaped values in plugin-owned llm api keys before returning a bearer", async () => {
    const manifest = manifestFor("plugin-x", []);
    const audit = makeAuditLogger();
    const settings = makeSettingsService({
      provider: "openai",
      secrets: { "plugin.plugin-x.llm.apiKey.openai": "https://example.openai.azure.com/openai/deployments/stt/audio/transcriptions" },
    });

    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "plugin-x",
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: settings as never,
        auditLogger: audit,
        ...NO_GRANT,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-host-vendor");
    expect(audit.mock).toHaveBeenCalledWith(expect.objectContaining({
      type: "warn",
      input: expect.stringContaining("endpoint-url-in-api-key-like-secret"),
    }));
  });
});
describe("resolveApiKey — Tier-2 manifest allowlist miss", () => {
  it("returns reason=not-whitelisted when llm.apiKey.<vendor> not in hostSecrets.read", async () => {
    const manifest = manifestFor("p", []); // no allowlist entries
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService({ provider: "openai" }) as never,
        auditLogger: makeAuditLogger(),
        ...NO_GRANT,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-whitelisted");
  });
});

describe("resolveApiKey — Tier-3 whitelist registry deny passthrough", () => {
  it("returns reason=not-whitelisted when registry denies (plugin absent from grants)", async () => {
    // Seed registry with a grant for OTHER plugin so this plugin is absent.
    const manifest = manifestFor("p", ["llm.apiKey.openai"]);
    const manifestSha256 = manifestSha(manifest);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256,
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest)),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-whitelisted");
  });
});

describe("resolveApiKey — Tier-3 BEFORE Tier-4 ordering (cycle 1 MEDIUM)", () => {
  it("unwhitelisted plugin denied with not-whitelisted even when vendor mismatches", async () => {
    // Plugin is NOT in the whitelist grants AND vendor mismatches active.
    // Tier-3 must surface first (not-whitelisted), not the vendor-mismatch
    // leak that would tell the plugin which vendor is active.
    const manifest = manifestFor("p", ["llm.apiKey.openai"]);
    const manifestSha256 = manifestSha(manifest);
    const result = await resolveApiKey(
      // plugin asks for openai but active is claude → vendor-mismatch.
      // Whitelist also denies → tier-3 should win.
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256,
        settingsService: makeSettingsService({
          provider: "claude",
          secrets: { "llm.apiKey.openai": "sk-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest)),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-whitelisted");
  });
});

describe("resolveApiKey — Tier-4 vendor mismatch", () => {
  it("returns vendor-mismatch when plugin allowlisted but vendor != active", async () => {
    const manifest = manifestFor(GRANTED, ["llm.apiKey.openai"]);
    const manifestSha256 = manifestSha(manifest);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256,
        // Active vendor is claude → vendor-mismatch on requested openai.
        settingsService: makeSettingsService({ provider: "claude" }) as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest)),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("vendor-mismatch");
  });

  // ── The gate-merge disagreement set ─────────────────────────────────
  //
  // Tiers 1+2 used to be hand-copied into this file while only tiers 3+4 were
  // shared with `getSecret`. These pin the two behaviours that differed.

  it("asks for the active preset's key, which no host-secret grant covers", async () => {
    // `resolveApiKey` used to synthesize only `llm.apiKey.<vendor>`; it now
    // asks `hostSecretKeyForVendor`, so an active preset names the preset key.
    // The app's grant table (design §10.3) lists only `llm.apiKey.*` keys, so
    // Tier 3 refuses it and the key is never read.
    const presetKey = "llm.marketplaceProvider.future-router.apiKey";
    const manifest = manifestFor(GRANTED, [presetKey]);
    const manifestSha256 = manifestSha(manifest);
    const auditLogger = makeAuditLogger();
    const settingsService = makeSettingsService({
      provider: "openai-compatible",
      marketplaceProviderPresetId: "future-router",
      secrets: { [presetKey]: "fr-secret" },
    });

    const result = await resolveApiKey(
      { purpose: "llm" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256,
        settingsService: settingsService as never,
        auditLogger,
        ...officialGrant(manifestSha(manifest)),
      },
    );

    expect(result).toEqual({ ok: false, reason: "not-whitelisted" });
    expect(settingsService.getSecret).not.toHaveBeenCalledWith(presetKey);
    const lines = auditLogger.log.mock.calls.map((c) => (c[0] as { input?: string }).input ?? "");
    expect(lines.some((l) => l.includes("reason=not-in-grant-table") && l.includes("(tier-3)"))).toBe(true);
  });

  it("still denies a preset key whose preset is installed but NOT active", async () => {
    // Tier-4 is preserved across the merge: reachable is not the same as open.
    const presetKey = "llm.marketplaceProvider.future-router.apiKey";
    const manifest = manifestFor(GRANTED, [presetKey]);
    const manifestSha256 = manifestSha(manifest);
    const settingsService = makeSettingsService({
      provider: "openai-compatible",
      marketplaceProviderPresetId: "other-router",
      installedProviderPresetIds: ["future-router", "other-router"],
      secrets: { [presetKey]: "fr-secret" },
    });

    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256,
        settingsService: settingsService as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest)),
      },
    );

    expect(settingsService.getSecret).not.toHaveBeenCalledWith(presetKey);
    expect(result.ok).toBe(false);
  });

  it("names the Tier-2 deny `not-allowlisted`, the same token `getSecret` audits", async () => {
    // The audit vocabularies had drifted: this path logged
    // `reason=not-whitelisted ... (manifest)` for a plain manifest-allowlist
    // miss with no whitelist involvement, while `getSecret` logged
    // `reason=not-allowlisted`. An operator pivoting on either token saw half
    // the traffic. The public `reason` stays `not-whitelisted` — that enum
    // is the plugin contract and is deliberately unchanged.
    const manifest = manifestFor("p", []);
    const manifestSha256 = manifestSha(manifest);
    const auditLogger = makeAuditLogger();
    const settingsService = makeSettingsService({ provider: "openai" });

    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256,
        settingsService: settingsService as never,
        auditLogger,
        ...NO_GRANT,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-whitelisted");
    const lines = auditLogger.log.mock.calls.map(
      (c) => (c[0] as { input?: string }).input ?? "",
    );
    expect(lines.some((l) => l.includes("reason=not-allowlisted"))).toBe(true);
    expect(lines.some((l) => l.includes("(tier-2)"))).toBe(true);
  });

  it("denies the generic OpenAI-compatible key while a marketplace preset is active", async () => {
    const genericKey = "llm.apiKey.openai-compatible";
    const manifest = manifestFor(GRANTED, [genericKey]);
    const manifestSha256 = manifestSha(manifest);
    const settingsService = makeSettingsService({
      provider: "openai-compatible",
      marketplaceProviderPresetId: "future-router",
      secrets: { [genericKey]: "sk-generic" },
    });

    const result = await resolveApiKey(
      { purpose: "llm" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256,
        settingsService: settingsService as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest)),
      },
    );

    // The security property is unchanged and is the first assertion: the
    // generic key is never read while a preset is active. The REASON changed
    // with the merged gate. `resolveApiKey` no longer synthesizes
    // `llm.apiKey.<vendor>` unconditionally — it asks
    // `hostSecretKeyForVendor` which key holds the ACTIVE provider's
    // credential, which under an active preset is the preset key. That key is
    // absent from this manifest, so the verdict is a Tier-2 allowlist miss
    // (`not-whitelisted`, the public contract's slot for it) rather than a Tier-4
    // vendor mismatch.
    expect(settingsService.getSecret).not.toHaveBeenCalledWith(genericKey);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-whitelisted");
  });
});

describe("resolveApiKey — success: release() lifetime", () => {
  it("bearer throws after release", async () => {
    const manifest = manifestFor(GRANTED, ["llm.apiKey.openai"]);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest)),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bearer()).toBe("sk-host");
      result.release();
      expect(() => result.bearer()).toThrow("released");
    }
  });
});

describe("resolveApiKey — signal aborts mid-flight (cycle 1 HIGH)", () => {
  it("signal abort after resolve fires automatic release", async () => {
    const ac = new AbortController();
    const manifest = manifestFor(GRANTED, ["llm.apiKey.openai"]);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai", signal: ac.signal },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest)),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bearer()).toBe("sk-host");
      ac.abort();
      // Abort fires the signal listener → release() runs → bearer throws.
      expect(() => result.bearer()).toThrow("released");
    }
  });
});

describe("resolveApiKey — vendor alias normalization (cycle 1 CRITICAL)", () => {
  it("SDK vendor='anthropic' resolves against host activeProvider='claude'", async () => {
    const manifest = manifestFor(GRANTED, ["llm.apiKey.claude"]);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "anthropic" }, // public contract name
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService({
          provider: "claude", // host vendor name
          secrets: { "llm.apiKey.claude": "sk-claude" },
        }) as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest)),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.vendor).toBe("claude");
      expect(result.bearer()).toBe("sk-claude");
    }
  });

  it("SDK vendor='vertex' normalizes to host 'vertex-ai'", async () => {
    const manifest = manifestFor(GRANTED, ["llm.apiKey.vertex-ai"]);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "vertex" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService({
          provider: "vertex-ai",
          secrets: { "llm.apiKey.vertex-ai": "sk-vertex" },
        }) as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest)),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.vendor).toBe("vertex-ai");
  });

  it("vendor cross-check uses normalized host vendor name", async () => {
    // Public 'azure-openai' → host 'azure-foundry'. activeProvider = 'azure-foundry' →
    // should match (no mismatch). Conversely if activeProvider is anything
    // else, vendor-mismatch fires under the normalized name.
    const manifest = manifestFor(GRANTED, ["llm.apiKey.azure-foundry"]);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "azure-openai" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService({
          provider: "azure-foundry",
          secrets: { "llm.apiKey.azure-foundry": "sk-azure" },
          baseUrl: "https://my-region.openai.azure.com",
        }) as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest)),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.vendor).toBe("azure-foundry");
      expect(result.baseUrl).toBe("https://my-region.openai.azure.com");
    }
  });
});

describe("resolveApiKey — permission revoke fires release() on outstanding bearer (cluster M1)", () => {
  it("permission revoke signal abort fires release() on outstanding bearer", async () => {
    // Simulate the boot wiring: a per-plugin revoke controller owned by
    // PermissionManager. The host-api merges it with the caller's signal
    // via AbortSignal.any so the bearer aborts on either source.
    const revokeController = new AbortController();
    const manifest = manifestFor(GRANTED, ["llm.apiKey.openai"]);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest)),
        getPluginRevokeSignal: () => revokeController.signal,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bearer()).toBe("sk-host");
      // PermissionManager.revokePluginAccess(...) would fire this:
      revokeController.abort(new Error("permission-revoked: deny-rule-added"));
      // The bearer is released → next read throws per the public contract.
      expect(() => result.bearer()).toThrow("released");
    }
  });

  it("returns reason=aborted when revoke signal is pre-aborted before entry", async () => {
    const revokeController = new AbortController();
    revokeController.abort(new Error("permission-revoked: pre-aborted"));
    const manifest = manifestFor("p", []);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService({ provider: "openai" }) as never,
        auditLogger: makeAuditLogger(),
        ...NO_GRANT,
        getPluginRevokeSignal: () => revokeController.signal,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("aborted");
  });
});

describe("resolveApiKey — baseUrl present on azure-foundry success", () => {
  it("baseUrl threaded from llm.vendors['azure-foundry'].baseUrl", async () => {
    const manifest = manifestFor(GRANTED, ["llm.apiKey.azure-foundry"]);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "azure-openai" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService({
          provider: "azure-foundry",
          secrets: { "llm.apiKey.azure-foundry": "sk-az" },
          baseUrl: "https://foo.bar/",
        }) as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest)),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseUrl).toBe("https://foo.bar/");
    }
  });
});

describe("resolveApiKey — Tier 3 reads the host-owned registry, never the manifest", () => {
  const readsHostKey = { provider: "openai", secrets: { "llm.apiKey.openai": "sk-host" } };

  it("attributes the allow line to the host-secret grant", async () => {
    const manifest = manifestFor(GRANTED, ["llm.apiKey.openai"]);
    const auditLogger = makeAuditLogger();
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService(readsHostKey) as never,
        auditLogger,
        ...officialGrant(manifestSha(manifest)),
      },
    );
    expect(result.ok).toBe(true);
    const allowLine = auditLogger.mock.mock.calls
      .map((c) => String(c[0]?.input ?? ""))
      .find((input) => input.includes("resolveApiKey allow"));
    expect(allowLine).toContain("source=host-secret-grant");
  });

  it("grants nothing to an admin install the official snapshot did not publish", async () => {
    const manifest = manifestFor(GRANTED, ["llm.apiKey.openai"]);
    const settingsService = makeSettingsService(readsHostKey);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: settingsService as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant(manifestSha(manifest), { installSource: "admin", origin: undefined }),
      },
    );
    expect(result).toEqual({ ok: false, reason: "not-whitelisted" });
    expect(settingsService.getSecret).not.toHaveBeenCalledWith("llm.apiKey.openai");
  });

  it("ignores a manifest that claims an admin install policy", async () => {
    const manifest = { ...manifestFor(GRANTED, ["llm.apiKey.openai"]), installPolicy: "admin" as const };
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService(readsHostKey) as never,
        auditLogger: makeAuditLogger(),
        ...NO_GRANT,
      },
    );
    expect(result).toEqual({ ok: false, reason: "not-whitelisted" });
  });

  it("refuses a granted plugin whose running manifest is not the one recorded at install", async () => {
    const manifest = manifestFor(GRANTED, ["llm.apiKey.openai"]);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: GRANTED,
        manifest,
        manifestSha256: manifestSha(manifest),
        settingsService: makeSettingsService(readsHostKey) as never,
        auditLogger: makeAuditLogger(),
        ...officialGrant("f".repeat(64)),
      },
    );
    expect(result).toEqual({ ok: false, reason: "not-whitelisted" });
  });
});
