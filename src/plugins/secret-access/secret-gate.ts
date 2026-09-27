/**
 * #893 — THE four-tier host-secret access gate: "may this plugin read this
 * host-managed secret key?".
 *
 * ONE authority for both host APIs that ask the question:
 *   - `hostApi.getSecret(key)` — src/boot/steps/plugin-runtime/host-api-factory.ts
 *   - `hostApi.resolveApiKey({purpose, vendor})` — src/main/host-api/resolve-api-key.ts
 *
 * Tiers, in order:
 *   (1) own namespace   — `plugin.<pluginId>.*`. Needs no grant, so any
 *       plugin holds its own keys under its own namespace.
 *   (2) manifest allowlist — the key must appear verbatim in
 *       `manifest.hostSecrets.read[]`.
 *   (3) host-secret grant — the app's grant table (design §10.3,
 *       `grants.ts`): an official install of the exact artifact the official
 *       snapshot pins, running the manifest recorded at install.
 *   (4) active-vendor cross-check — the vendor named by the key must be the
 *       user's ACTIVE provider, so a plugin cannot harvest idle credentials
 *       for a provider that is not in use.
 *
 * Tier-3 BEFORE Tier-4: the grant table is a coarse, statically-declared
 * ACL; the vendor cross-check is dynamic per-call state driven by
 * `settings.llm.provider`. Running the coarse ACL first keeps the dynamic
 * per-session vendor identity from leaking through the deny-reason channel of
 * an ungranted plugin.
 *
 * WHAT STAYS AT THE CALL SITES, and why: audit-log lines, counter increments,
 * and the shape of the returned value. `getSecret` answers with `string | null`
 * for one named key; `resolveApiKey` answers with the public contract's discriminated union
 * plus a bearer/release lifetime. Those are wrappers around this decision, not
 * part of it. The `via` / `tier` / `reason` discriminators exist so each caller
 * can render its own audit vocabulary from ONE verdict — see `grantAuditSource`
 * in resolve-api-key.ts for the exhaustive-match pattern.
 *
 * Tiers 1 and 2 used to be hand-copied into both callers while only 3+4 were
 * shared. The copies drifted: `resolveApiKey` synthesized only
 * `llm.apiKey.<vendor>` and so had NO reachable allow path for a
 * marketplace-provider preset key, a family `getSecret` and the manifest
 * schema accept.
 */
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
/** The host vendor id that routes through a marketplace provider preset. */
const OPENAI_COMPATIBLE = "openai-compatible";

/**
 * `via: "own-namespace"` marks a Tier-1 allow, where no host secret was read;
 * a plain allow means all four tiers ran and passed. Callers pattern-match
 * exhaustively, so a new variant is a compile-time error at every audit and
 * counter site rather than a silently wrong audit line.
 */
export type SecretGateOutcome =
  | { kind: "allow"; via?: "own-namespace" }
  | { kind: "deny"; tier: "tier-2"; reason: "not-allowlisted" }
  | { kind: "deny"; tier: "tier-3"; reason: HostSecretGrantDenial }
  | { kind: "deny"; tier: "tier-4"; reason: "vendor-mismatch" };

/**
 * The dynamic settings state Tier-4 compares against. Passed in rather than
 * read here so the gate stays free of the settings service and is trivially
 * exercisable from a test.
 */
export interface SecretGateSettings {
  /** `settings.llm.provider`. */
  readonly llmProvider: string;
  /** `settings.llm.marketplaceProviderPresetId`, unvalidated. */
  readonly marketplaceProviderPresetId: unknown;
  /**
   * `providerId` of every entry in `settings.marketplace.installedProviderPresets`.
   * A thunk because ONLY the marketplace-preset key family consults it — the
   * far more common `llm.apiKey.<vendor>` request never reads that settings
   * section at all.
   */
  readonly readInstalledProviderPresetIds: () => readonly string[];
}

export interface SecretGateInput {
  readonly pluginId: string;
  /** The host-secret key being requested, verbatim. */
  readonly key: string;
  /** `manifest.hostSecrets.read[]`. */
  readonly allowlist: readonly string[];
  /** Canonical sha256 of the `plugin.json` document running now; null when the manifest was not read from one. */
  readonly manifestSha256: string | null;
  /** The host-owned registry entry, read only when Tier 3 runs; undefined when the plugin has none. */
  readonly readRegistryEntry: () => Promise<PluginRegistryTrust | undefined>;
  readonly grantEvidence: HostSecretGrantEvidence;
  /**
   * Read LAZILY — only Tier-4 needs it, so a Tier-1 or Tier-2 verdict costs no
   * settings reads. Callers hand in a thunk rather than a snapshot to keep that
   * property visible at the call site.
   */
  readonly readSettings: () => SecretGateSettings;
}

/**
 * Which host-secret key holds the credential for `vendor` — the one place that
 * answers "what should I ask the gate for?".
 *
 * When the user's active provider is a marketplace provider preset, the key is
 * the preset form; otherwise it is the per-vendor form. `resolveApiKey` takes a
 * vendor and needs the key; without this it could only ever name
 * `llm.apiKey.<vendor>`, which made the whole preset key family unreachable
 * through the lifetime-safe API.
 */
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

/**
 * The `(vendor, activeProvider)` pair Tier-4 compares, derived from the
 * requested key. A key family the gate does not recognise compares equal to
 * itself, i.e. Tier-4 is a no-op for it — Tier-2/Tier-3 remain the gate.
 */
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
    // A preset key only unlocks while its preset is BOTH installed and the
    // active provider; an uninstalled or inactive preset yields an empty
    // `activeProvider`, which can never equal a non-empty vendor.
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

/** Raw `<presetId>` segment of a preset key, or `""`. Deliberately untrimmed. */
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

/**
 * Run all four tiers in their fixed order and return the first verdict.
 *
 * Callers MUST still emit their own audit lines + counter increments — the gate
 * deliberately stays free of those so it can serve both the boot-context
 * `getSecret` (which logs through `bootAuditLogger`) and the per-plugin
 * `resolveApiKey` (which logs through an injected `auditLogger`).
 */
export async function runSecretGate(input: SecretGateInput): Promise<SecretGateOutcome> {
  // Tier 1 — own namespace.
  if (input.key.startsWith(`plugin.${input.pluginId}.`)) {
    return { kind: "allow", via: "own-namespace" };
  }
  // Tier 2 — manifest allowlist.
  if (!input.allowlist.includes(input.key)) {
    return { kind: "deny", tier: "tier-2", reason: "not-allowlisted" };
  }
  // Tier 3 — the app's host-secret grants.
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
  // Tier 4 — active-vendor cross-check.
  const { vendor, activeProvider } = vendorCrossCheck(input.key, input.readSettings());
  if (vendor !== activeProvider) {
    return { kind: "deny", tier: "tier-4", reason: "vendor-mismatch" };
  }
  return { kind: "allow" };
}
