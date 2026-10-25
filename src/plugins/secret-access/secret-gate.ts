/** Both secret APIs share this ordered four-tier authorization gate; supported key families must match the manifest grammar. */
import {
  isMarketplaceProviderPresetId,
  marketplaceProviderPresetSecretKey,
} from "../../shared/marketplace-package-assets.js";
import { evaluateHostSecretGrant, type HostSecretGrantDenial, type HostSecretGrantEvidence } from "./grants.js";
import type { PluginRegistryTrust } from "../types.js";

/** `llm.apiKey.<vendor>` — the per-vendor host-secret key family. */
const LLM_API_KEY_PREFIX = "llm.apiKey.";
/** `llm.marketplaceProvider.<presetId>.apiKey` — the preset key family. */
const MARKETPLACE_PROVIDER_KEY_PREFIX = "llm.marketplaceProvider.";
const MARKETPLACE_PROVIDER_KEY_SUFFIX = ".apiKey";
const OPENAI_COMPATIBLE = "openai-compatible";

/** Own-namespace allows read no host secret; callers must distinguish them in audit and counters. */
export type SecretGateOutcome =
  | { kind: "allow"; via?: "own-namespace" }
  | { kind: "deny"; tier: "tier-2"; reason: "not-allowlisted" | "provider-key-not-exportable" }
  | { kind: "deny"; tier: "tier-3"; reason: HostSecretGrantDenial }
  | { kind: "deny"; tier: "tier-4"; reason: "vendor-mismatch" };

/** Inject dynamic provider state so policy stays independent of settings services. */
export interface SecretGateSettings {
  readonly llmProvider: string;
  readonly marketplaceProviderPresetId: unknown;
  /** Read installed preset IDs lazily only for preset-key requests. */
  readonly readInstalledProviderPresetIds: () => readonly string[];
}

export interface SecretGateInput {
  readonly pluginId: string;
  readonly operation: "export" | "lease";
  readonly key: string;
  readonly allowlist: readonly string[];
  readonly manifestSha256: string | null;
  readonly readRegistryEntry: () => Promise<PluginRegistryTrust | undefined>;
  readonly grantEvidence: HostSecretGrantEvidence;
  /** Defer settings reads until tier 4; earlier verdicts must perform none. */
  readonly readSettings: () => SecretGateSettings;
}

/** Select the credential key from the active provider, including marketplace preset keys. */
export function hostSecretKeyForVendor(
  vendor: string,
  settings: Pick<SecretGateSettings, "llmProvider" | "marketplaceProviderPresetId">,
): string {
  if (
    vendor === OPENAI_COMPATIBLE &&
    settings.llmProvider === OPENAI_COMPATIBLE &&
    isMarketplaceProviderPresetId(settings.marketplaceProviderPresetId)
  ) {
    return marketplaceProviderPresetSecretKey(settings.marketplaceProviderPresetId);
  }
  return `${LLM_API_KEY_PREFIX}${vendor}`;
}

/** Unknown key families leave provider matching inert; manifest and app grants still enforce access. */
function vendorCrossCheck(
  key: string,
  settings: SecretGateSettings,
): { vendor: string; activeProvider: string } {
  if (key.startsWith(LLM_API_KEY_PREFIX)) {
    const vendor = key.slice(LLM_API_KEY_PREFIX.length);
    const activeProvider =
      vendor === OPENAI_COMPATIBLE &&
      settings.llmProvider === OPENAI_COMPATIBLE &&
      isMarketplaceProviderPresetId(settings.marketplaceProviderPresetId)
        ? settings.marketplaceProviderPresetId
        : settings.llmProvider;
    return { vendor, activeProvider };
  }
  const presetId = marketplaceProviderPresetIdFromKey(key);
  if (presetId.length > 0) {
    // Preset credentials unlock only when the preset is installed and active.
    const installed =
      isMarketplaceProviderPresetId(presetId) &&
      settings.readInstalledProviderPresetIds().includes(presetId);
    const activeProvider =
      installed &&
      settings.llmProvider === OPENAI_COMPATIBLE &&
      settings.marketplaceProviderPresetId === presetId
        ? presetId
        : "";
    return { vendor: presetId, activeProvider };
  }
  return { vendor: "", activeProvider: "" };
}

/** Return the raw preset ID or empty string; do not trim. */
function marketplaceProviderPresetIdFromKey(key: string): string {
  if (
    !key.startsWith(MARKETPLACE_PROVIDER_KEY_PREFIX) ||
    !key.endsWith(MARKETPLACE_PROVIDER_KEY_SUFFIX)
  ) {
    return "";
  }
  return key.slice(
    MARKETPLACE_PROVIDER_KEY_PREFIX.length,
    -MARKETPLACE_PROVIDER_KEY_SUFFIX.length,
  );
}

/** Return the first tier verdict; callers still own audit records and counter updates. */
export async function runSecretGate(input: SecretGateInput): Promise<SecretGateOutcome> {
  if (input.key.startsWith(`plugin.${input.pluginId}.`)) {
    return { kind: "allow", via: "own-namespace" };
  }
  if (input.operation === "export" && input.key.startsWith(LLM_API_KEY_PREFIX)) {
    return { kind: "deny", tier: "tier-2", reason: "provider-key-not-exportable" };
  }
  if (!input.allowlist.includes(input.key)) {
    return { kind: "deny", tier: "tier-2", reason: "not-allowlisted" };
  }
  const grant = await evaluateHostSecretGrant({
    pluginId: input.pluginId,
    key: input.key,
    entry: await input.readRegistryEntry(),
    runningManifestSha256: input.manifestSha256,
    evidence: input.grantEvidence,
  });
  if (!grant.granted) {
    return { kind: "deny", tier: "tier-3", reason: grant.reason };
  }
  const { vendor, activeProvider } = vendorCrossCheck(input.key, input.readSettings());
  if (vendor !== activeProvider) {
    return { kind: "deny", tier: "tier-4", reason: "vendor-mismatch" };
  }
  return { kind: "allow" };
}
