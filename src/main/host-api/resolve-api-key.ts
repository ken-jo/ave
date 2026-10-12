/**
 * #893 Stage 2 — Host implementation of `hostApi.resolveApiKey()`.
 *
 * Wraps the four-tier secret gate (`runSecretGate`) and returns the public
 * contract's `ResolveApiKeyResult` discriminated union.
 * On `ok=true` the host yields a one-shot bearer thunk + `release()`; plugins
 * should call `release()` in a `finally` block so the in-memory copy of the
 * key has a deterministic lifetime.
 *
 * Decision tree — the same four tiers `hostApi.getSecret` runs, because both
 * call `runSecretGate`:
 *   - tier-1 own-namespace          → ok=true (vendor = requested vendor or active)
 *   - tier-2 manifest allowlist     → check
 *   - tier-3 host-secret grant      → check (BEFORE Tier-4 — see ORDER below)
 *   - tier-4 active-vendor cross    → reason "vendor-mismatch"
 *   - tier-2/tier-3 refusal         → reason "not-whitelisted" (public contract reason)
 *   - missing key in settings       → reason "no-host-vendor"
 *
 * Tier-3 / Tier-4 ORDER:
 *   Both `getSecret` and `resolveApiKey` evaluate Tier-3 (the app's grant
 *   table, design §10.3) BEFORE Tier-4 (active-vendor cross-check). The
 *   grant table is a coarse ACL — the static declaration of which plugin
 *   may read which key. The vendor cross-check is per-call and dynamic
 *   (driven by `settings.llm.provider`). Running the coarse ACL first
 *   prevents an ungranted plugin from leaking the dynamic vendor state via
 *   the deny-reason channel.
 *
 * Vendor alias normalization:
 *   The public contract uses
 *   `"openai" | "azure-openai" | "vertex" | "anthropic"`; the host's
 *   internal vendor union (`src/shared/llm-vendor-defaults.ts`) uses
 *   `"openai" | "azure-foundry" | "vertex-ai" | "claude"`. Map the public
 *   names to host names at the entry so a Claude-default user and an
 *   plugin that asks for `vendor:"anthropic"` doesn't silently fall into
 *   `not-whitelisted` for a non-existent `llm.apiKey.anthropic` key.
 *
 * Cancellation: when `signal.aborted`, returns `{ ok: false, reason: "aborted" }`
 * before any I/O. On a successful resolve the returned `release()` is wired
 * to fire automatically when the signal aborts mid-flight, so the captured
 * bearer reference is dropped without the plugin having to remember.
 */
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
  /** Canonical sha256 of the running `plugin.json` document; null when the manifest was not read from one. */
  manifestSha256: string | null;
  settingsService: Pick<SettingsService, "get" | "getSecret">;
  auditLogger: Pick<AuditLogger, "log">;
  /**
   * Optional accessor for the PermissionManager's
   * per-plugin revoke signal. When provided, the returned bearer is wired
   * to release on EITHER the caller's signal OR this signal — so a
   * permission rule change aborts the outstanding bearer mid-flight even
   * when the plugin's own `opts.signal` is never aborted. Boot wiring in
   * `plugin-runtime.ts` binds this to `permissionManager.getPluginRevokeSignal`.
   */
  getPluginRevokeSignal?: (pluginId: string) => AbortSignal;
  /** The host-owned registry entry Tier 3 trusts; read only when Tier 3 runs. */
  readRegistryEntry: () => Promise<PluginRegistryTrust | undefined>;
  grantEvidence: HostSecretGrantEvidence;
  _onCredentialIssuanceStageForTest?: (stage: CredentialIssuanceStage) => Promise<void> | void;
}

/**
 * Map public-contract vendor names to host internal vendor names. The contract has
 * `"openai" | "azure-openai" | "vertex" | "anthropic"`; the host's
 * `LLM_VENDORS` union is
 * `"openai" | "azure-foundry" | "vertex-ai" | "claude" | "gemini"`.
 *
 * Only the three aliases that *differ* between the two surfaces are
 * mapped; `"openai"` passes through unchanged. Adding a new public alias
 * needs an entry here AND an `llm.apiKey.<host-vendor>` key wired into
 * the manifest allowlist and host whitelist.
 */
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
    /* audit must not break host */
  }
}

/**
 * One-shot bearer thunk wired to the request's `AbortSignal`. The captured
 * string is dropped after `release()` so subsequent `bearer()` calls throw
 * `Error("released")` per the vendored HostApi contract. Strings in JS are
 * immutable, so we cannot literally zero the buffer; the "zeroize" here is a
 * best-effort signal: the reference is dropped, and tests can assert
 * the post-release state.
 *
 * The signal is load-bearing, not advisory: an already-aborted signal at
 * construction time releases immediately, and a mid-flight abort fires a
 * one-shot listener that drops the reference without the caller acting.
 */
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
      // `once: true` so the host doesn't leak listeners across hundreds
      // of plugin calls sharing the same long-lived signal (e.g. an
      // overlay session controller's signal).
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

/**
 * Resolve an API key for a plugin. Runs the same 4-tier `runSecretGate` as
 * `hostApi.getSecret`, returning the public contract's discriminated union so
 * plugins can branch on each refusal cause.
 */
export async function resolveApiKey(
  request: ResolveApiKeyRequest,
  deps: ResolveApiKeyDeps,
): Promise<ResolveApiKeyResult> {
  // Merge the caller's per-request signal with the
  // PermissionManager's per-plugin revoke signal so a permission rule
  // change aborts an in-flight bearer even when the plugin's own signal
  // never fires. The merged signal flows into `makeSuccess` and short-
  // circuits the entry-guard below when either signal is already aborted.
  const revokeSignal = deps.getPluginRevokeSignal?.(deps.pluginId);
  const mergedSignal = mergeSignals(request.signal, revokeSignal);
  if (mergedSignal?.aborted) {
    return { ok: false, reason: "aborted" };
  }
  // Default vendor to the user's active LLM provider when the plugin omits
  // it (purpose-only call). The plugin may decline to pin a provider and
  // ask the host to pick.
  const llmSettings = deps.settingsService.get("llm") as {
    provider?: unknown;
    marketplaceProviderPresetId?: unknown;
  };
  const defaultActiveProvider =
    typeof llmSettings.provider === "string" ? llmSettings.provider : "";
  // Map public vendor aliases before key lookup so the request reaches the
  // host's configured key rather than a key built from the alias.
  const requestedVendor = request.vendor ?? defaultActiveProvider;
  const normalizedVendor =
    typeof requestedVendor === "string" ? normalizeVendor(requestedVendor) : requestedVendor;
  if (typeof normalizedVendor !== "string" || normalizedVendor.length === 0) {
    return { ok: false, reason: "no-host-vendor" };
  }
  // Audit log records BOTH the requested public name and the normalized
  // host name so operators see the alias resolution.
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
  // WHICH key holds this vendor's credential is asked once, in the shared gate
  // module. Building `llm.apiKey.<vendor>` inline here is what made the
  // `llm.marketplaceProvider.<presetId>.apiKey` family structurally unreachable
  // through this API even when the manifest and the signed whitelist granted it.
  const llmKey = hostSecretKeyForVendor(vendor, {
    llmProvider: defaultActiveProvider,
    marketplaceProviderPresetId: llmSettings.marketplaceProviderPresetId,
  });
  const keyPrefix = sanitizeKeyPrefix(llmKey);

  // Tier-1 own-namespace shortcut — the plugin asked for *its* key, not a host
  // secret. We still return the bearer through `resolveApiKey` to unify the
  // lifetime contract on the plugin side. A MISS falls through to the host
  // tiers rather than terminating, which is this API's own semantics: it was
  // asked for "a key for this vendor", not for one named key.
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
    // Tier-2/Tier-3 deny — map the gate's reasons (`not-allowlisted` and the
    // grant's refusals) to the public contract's narrow `not-whitelisted` slot.
    // The precise reason lives in the audit log.
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

  // azure-foundry needs a baseUrl alongside the bearer — the public contract
  // already exposes it. Reach into the per-vendor settings block when
  // the vendor is azure-foundry; otherwise leave baseUrl unset.
  let baseUrl: string | undefined;
  if (vendor === "azure-foundry") {
    const llmSettings = deps.settingsService.get("llm") as {
      vendors?: Record<string, { baseUrl?: string } | undefined>;
    };
    baseUrl = llmSettings?.vendors?.["azure-foundry"]?.baseUrl;
  }
  return makeSuccess(vendor, llmKey, "host-secret", value, mergedSignal, baseUrl);
}

/** Resolve the two possible key identities before issuance crosses an await. */
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

/**
 * Name the gate path that produced a grant, for the `resolveApiKey allow`
 * audit line. Exhaustively matched on the gate's `via`, so a new allow path is
 * a compile-time error here rather than a silently wrong audit line.
 */
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

/**
 * Combine the caller's per-request signal with the
 * PermissionManager's per-plugin revoke signal into a single AbortSignal.
 * Returns `undefined` when both inputs are absent so the bearer thunk skips
 * the listener wiring entirely. Falls back gracefully when `AbortSignal.any`
 * is unavailable (older Node) by returning the first defined signal — the
 * loss of merge fidelity is preferable to a hard crash on plugin call.
 */
function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (a && !b) return a;
  if (!a && b) return b;
  // Both signals present — use AbortSignal.any when available so the
  // returned signal aborts on whichever fires first.
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") {
    return anyFn([a!, b!]);
  }
  // Fallback for runtimes without AbortSignal.any — prefer the revoke
  // signal so the security guarantee is preserved at the cost of losing
  // the caller's cancellation propagation.
  return b ?? a;
}
