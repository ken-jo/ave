// Use the shared secret gate; check static grants before active-vendor state to avoid leaking it through denial reasons. Normalize public vendor aliases
// at entry and release resolved bearers in finally or on cancellation.
import type { SettingsService } from "../../data/settings-store.js";
import type { HostSecretGrantEvidence } from "../../plugins/secret-access/grants.js";
import type { PluginManifest, PluginRegistryTrust } from "../../plugins/types.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { shouldBlockPluginSecretRead } from "../../plugins/secret-shape.js";
import {
  hostSecretKeyForVendor,
  runSecretGate,
} from "../../plugins/secret-access/secret-gate.js";
import type { SecretGateOutcome } from "../../plugins/secret-access/secret-gate.js";
import {
  incrementHostSecretCounter,
  sanitizeKeyPrefix,
} from "../../telemetry/host-secret-counters.js";

export type ResolveApiKeyPurpose = "llm" | "stt" | "embedding" | "vision";
export type ResolveApiKeyVendor =
  | "openai"
  | "azure-openai"
  | "vertex"
  | "anthropic";

export type CredentialIssuanceStage = "before-gate" | "after-gate" | "after-secret-read" | "before-reply";

export type ResolveApiKeyResult =
  | {
      ok: true;
      vendor: string;
      keyName: string;
      source: "host-secret" | "plugin-own";
      bearer: () => string;
      baseUrl?: string;
      release: () => void;
    }
  | {
      ok: false;
      reason:
        | "no-host-vendor"
        | "vendor-mismatch"
        | "not-whitelisted"
        | "user-mode-plugin"
        | "aborted"
        | "user-endpoint-with-host-key";
    };

export interface ResolveApiKeyRequest {
  purpose: ResolveApiKeyPurpose;
  vendor?: ResolveApiKeyVendor;
  exposure?: "lease" | "raw";
  signal?: AbortSignal;
}

export interface ResolveApiKeyDeps {
  pluginId: string;
  // #885 v6 — reads only `hostSecrets` (shared by legacy + normalized manifests).
  manifest: Pick<PluginManifest, "hostSecrets">;
  // Canonical sha256 of the running `plugin.json` document; null when the manifest was not read from one.
  manifestSha256: string | null;
  settingsService: Pick<SettingsService, "get" | "getSecret">;
  auditLogger: Pick<AuditLogger, "log">;
  // Permission revocation releases outstanding bearers even when the caller’s own abort signal never fires.
  getPluginRevokeSignal?: (pluginId: string) => AbortSignal;
  // The host-owned registry entry Tier 3 trusts; read only when Tier 3 runs.
  readRegistryEntry: () => Promise<PluginRegistryTrust | undefined>;
  grantEvidence: HostSecretGrantEvidence;
  _onCredentialIssuanceStageForTest?: (stage: CredentialIssuanceStage) => Promise<void> | void;
}

// Normalize differing public aliases to host vendor keys; new aliases must also wire manifest permission and host grants.
const VENDOR_ALIAS_MAP: Record<string, string> = {
  anthropic: "claude",
  "azure-openai": "azure-foundry",
  vertex: "vertex-ai",
};

export function normalizeVendor(v: string): string {
  return VENDOR_ALIAS_MAP[v] ?? v;
}

function audit(deps: ResolveApiKeyDeps, level: "info" | "warn", message: string): void {
  try {
    deps.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "plugin",
      type: level,
      input: `[plugin:${deps.pluginId}] ${message}`,
    });
  } catch {
    // audit must not break host
  }
}

// release drops the captured string reference and makes bearer throw; immutable JavaScript strings cannot be zeroed in place.
// Already-aborted or later-aborted signals release immediately.
function makeSuccess(
  vendor: string,
  keyName: string,
  source: "host-secret" | "plugin-own",
  value: string,
  signal?: AbortSignal,
  baseUrl?: string,
): ResolveApiKeyResult & { ok: true } {
  let captured: string | null = value;
  const release = () => {
    captured = null;
  };
  if (signal) {
    if (signal.aborted) {
      release();
    } else {
      // `once: true` so the host doesn't leak listeners across hundreds of plugin calls sharing the same long-lived signal (e.g. an overlay session controller's signal).
      signal.addEventListener("abort", release, { once: true });
    }
  }
  const result: ResolveApiKeyResult & { ok: true } = {
    ok: true,
    vendor,
    keyName,
    source,
    bearer: () => {
      if (captured === null) {
        throw new Error("released");
      }
      return captured;
    },
    release,
  };
  if (baseUrl !== undefined) {
    (result as { baseUrl?: string }).baseUrl = baseUrl;
  }
  return result;
}

// Resolve an API key for a plugin. Runs the same 4-tier `runSecretGate` as `hostApi.getSecret`, returning the public contract's discriminated union so
// plugins can branch on each refusal cause.
export async function resolveApiKey(
  request: ResolveApiKeyRequest,
  deps: ResolveApiKeyDeps,
): Promise<ResolveApiKeyResult> {
  // Merge request abort and plugin revocation so either can release an in-flight bearer.
  const revokeSignal = deps.getPluginRevokeSignal?.(deps.pluginId);
  const mergedSignal = mergeSignals(request.signal, revokeSignal);
  if (mergedSignal?.aborted) {
    return { ok: false, reason: "aborted" };
  }
  // Default vendor to the user's active LLM provider when the plugin omits it (purpose-only call). The plugin may decline to pin a provider and ask the host to pick.
  const llmSettings = deps.settingsService.get("llm") as {
    provider?: unknown;
    marketplaceProviderPresetId?: unknown;
    retiredProvider?: unknown;
  };
  // An unresolved profile has no active API vendor to choose for the plugin. Explicit plugin-owned provider choices keep their independent namespace.
  if (llmSettings.retiredProvider && request.vendor === undefined) {
    return { ok: false, reason: "no-host-vendor" };
  }
  const defaultActiveProvider =
    typeof llmSettings.provider === "string" ? llmSettings.provider : "";
  // Map public vendor aliases before key lookup so the request reaches the host's configured key rather than a key built from the alias.
  const requestedVendor = request.vendor ?? defaultActiveProvider;
  const normalizedVendor =
    typeof requestedVendor === "string" ? normalizeVendor(requestedVendor) : requestedVendor;
  if (typeof normalizedVendor !== "string" || normalizedVendor.length === 0) {
    return { ok: false, reason: "no-host-vendor" };
  }
  // Audit log records BOTH the requested public name and the normalized host name so operators see the alias resolution.
  if (typeof requestedVendor === "string" && requestedVendor !== normalizedVendor) {
    audit(
      deps,
      "info",
      `resolveApiKey vendor_alias requested=${requestedVendor} normalized=${normalizedVendor}`,
    );
  }
  const vendor = normalizedVendor;
  const readGateSettings = () => ({
    llmProvider: defaultActiveProvider,
    marketplaceProviderPresetId: llmSettings.marketplaceProviderPresetId,
    readInstalledProviderPresetIds: () =>
      (
        (
          deps.settingsService.get("marketplace") as {
            installedProviderPresets?: readonly { providerId: string }[];
          }
        ).installedProviderPresets ?? []
      ).map((preset) => preset.providerId),
  });
  // Resolve secret keys through the shared gate so granted preset-key families remain reachable.
  const llmKey = hostSecretKeyForVendor(vendor, {
    llmProvider: defaultActiveProvider,
    marketplaceProviderPresetId: llmSettings.marketplaceProviderPresetId,
  });
  const keyPrefix = sanitizeKeyPrefix(llmKey);

  // Own-namespace misses continue into host tiers because the request asks for a vendor credential, not one named key.
  const ownNamespaceKey = `plugin.${deps.pluginId}.llm.apiKey.${vendor}`;
  const ownValue = deps.settingsService.getSecret(ownNamespaceKey);
  if (shouldBlockPluginSecretRead({ pluginId: deps.pluginId, storageKey: ownNamespaceKey, value: ownValue })) {
    audit(
      deps,
      "warn",
      `resolveApiKey deny source=plugin-namespace reason=endpoint-url-in-api-key-like-secret vendor=${vendor} purpose=${request.purpose}`,
    );
    incrementHostSecretCounter("hostSecret_denied", deps.pluginId, keyPrefix);
    return { ok: false, reason: "no-host-vendor" };
  }
  if (typeof ownValue === "string" && ownValue.length > 0) {
    audit(
      deps,
      "info",
      `resolveApiKey allow source=plugin-namespace vendor=${vendor} purpose=${request.purpose}`,
    );
    incrementHostSecretCounter("hostSecret_read", deps.pluginId, keyPrefix);
    return makeSuccess(vendor, ownNamespaceKey, "plugin-own", ownValue, mergedSignal);
  }

  if (deps._onCredentialIssuanceStageForTest) await deps._onCredentialIssuanceStageForTest("before-gate");
  const gateOutcome = await runSecretGate({
    pluginId: deps.pluginId,
    operation: "lease",
    key: llmKey,
    allowlist: deps.manifest.hostSecrets?.read ?? [],
    manifestSha256: deps.manifestSha256,
    readRegistryEntry: deps.readRegistryEntry,
    grantEvidence: deps.grantEvidence,
    readSettings: readGateSettings,
  });
  if (gateOutcome.kind === "deny") {
    audit(
      deps,
      "warn",
      `resolveApiKey deny reason=${gateOutcome.reason} vendor=${vendor} (${gateOutcome.tier})`,
    );
    incrementHostSecretCounter("hostSecret_denied", deps.pluginId, keyPrefix);
    if (gateOutcome.tier === "tier-4") {
      return { ok: false, reason: "vendor-mismatch" };
    }
    // Tier-2/Tier-3 deny — map the gate's reasons (`not-allowlisted` and the grant's refusals) to the public contract's narrow `not-whitelisted` slot. The
    // precise reason lives in the audit log.
    return { ok: false, reason: "not-whitelisted" };
  }
  if (deps._onCredentialIssuanceStageForTest) await deps._onCredentialIssuanceStageForTest("after-gate");
  // All four tiers passed — fetch the key from settings.
  const value = deps.settingsService.getSecret(llmKey);
  if (deps._onCredentialIssuanceStageForTest) await deps._onCredentialIssuanceStageForTest("after-secret-read");
  if (typeof value !== "string" || value.length === 0) {
    audit(deps, "info", `resolveApiKey deny reason=no-host-vendor vendor=${vendor}`);
    incrementHostSecretCounter("hostSecret_denied", deps.pluginId, keyPrefix);
    return { ok: false, reason: "no-host-vendor" };
  }
  audit(
    deps,
    "info",
    `resolveApiKey allow source=${grantAuditSource(gateOutcome.via)} vendor=${vendor} purpose=${request.purpose}`,
  );
  incrementHostSecretCounter("hostSecret_read", deps.pluginId, keyPrefix);

  // azure-foundry needs a baseUrl alongside the bearer — the public contract already exposes it. Reach into the per-vendor settings block when the vendor
  // is azure-foundry; otherwise leave baseUrl unset.
  let baseUrl: string | undefined;
  if (vendor === "azure-foundry") {
    const llmSettings = deps.settingsService.get("llm") as {
      vendors?: Record<string, { baseUrl?: string } | undefined>;
    };
    baseUrl = llmSettings?.vendors?.["azure-foundry"]?.baseUrl;
  }
  return makeSuccess(vendor, llmKey, "host-secret", value, mergedSignal, baseUrl);
}

// Resolve the two possible key identities before issuance crosses an await.
export function apiKeyIdentities(
  request: ResolveApiKeyRequest,
  pluginId: string,
  settingsService: Pick<SettingsService, "get">,
): readonly string[] {
  const llm = settingsService.get("llm");
  const active = typeof llm.provider === "string" ? llm.provider : "";
  const requested = request.vendor ?? active;
  const vendor = normalizeVendor(requested);
  return [
    `plugin.${pluginId}.llm.apiKey.${vendor}`,
    hostSecretKeyForVendor(vendor, {
      llmProvider: active,
      marketplaceProviderPresetId: llm.marketplaceProviderPresetId,
    }),
  ];
}

// Name the gate path that produced a grant, for the `resolveApiKey allow` audit line. Exhaustively matched on the gate's `via`, so a new allow path is a
// compile-time error here rather than a silently wrong audit line.
function grantAuditSource(
  via: Extract<SecretGateOutcome, { kind: "allow" }>["via"],
): string {
  switch (via) {
    case "own-namespace":
      return "plugin-namespace";
    case undefined:
      return "host-secret-grant";
    default: {
      const exhaustive: never = via;
      return exhaustive;
    }
  }
}

// Return no signal when neither exists; on older runtimes without AbortSignal.any, use the first defined signal with reduced merge fidelity.
function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (a && !b) return a;
  if (!a && b) return b;
  // Both signals present — use AbortSignal.any when available so the returned signal aborts on whichever fires first.
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") {
    return anyFn([a!, b!]);
  }
  // Fallback for runtimes without AbortSignal.any — prefer the revoke signal so the security guarantee is preserved at the cost of losing the caller's
  // cancellation propagation.
  return b ?? a;
}
