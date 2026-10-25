import { fetchPublicHttpResponse } from "../../core/network-guard.js";
import type { MarketplaceInstalledProviderPreset } from "../../shared/marketplace-package-assets.js";
import {
  isSelfHostedTrustedNetworkVendor,
  type LLMVendor,
} from "../../shared/llm-vendor-defaults.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

// Network access axes are closed or narrowed to the configured origin.
export type ModelProviderNetworkAccess = {
  allowPrivateNetworks: false | ((url: URL) => boolean);
  allowLoopback: false | ((url: URL) => boolean);
  allowCarrierGradeNat: false | ((url: URL) => boolean);
};

type GuardedProviderFetchPolicy = {
  origin: string;
  allowInsecureCredentialedHttp: boolean;
};

const guardedProviderFetchPolicies = new WeakMap<Function, GuardedProviderFetchPolicy>();

function sameOriginScopeFor(value: string): false | ((url: URL) => boolean) {
  try {
    const origin = new URL(value).origin;
    return (candidate) => candidate.origin === origin;
  } catch {
    return false;
  }
}

function originFor(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Saved endpoints authorize private, loopback, and overlay access only at their exact origin.
 * SDK pivots and redirects must not extend that trust to another host. */
export function configuredModelProviderNetworkAccess(baseUrl: string): ModelProviderNetworkAccess {
  const sameOrigin = sameOriginScopeFor(baseUrl);
  return {
    allowPrivateNetworks: sameOrigin,
    allowLoopback: sameOrigin,
    allowCarrierGradeNat: sameOrigin,
  };
}

/** Loopback-only access for an explicitly keyless marketplace preset. */
export function configuredModelProviderLoopbackAccess(baseUrl: string): ModelProviderNetworkAccess {
  return {
    allowPrivateNetworks: false,
    allowLoopback: sameOriginScopeFor(baseUrl),
    allowCarrierGradeNat: false,
  };
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestInitFromFetchInput(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): RequestInit | undefined {
  if (!(typeof Request !== "undefined" && input instanceof Request)) {
    return init;
  }
  const requestInit: RequestInit = {
    method: input.method,
    headers: input.headers,
    signal: input.signal,
    ...init,
  };
  if (input.body && init?.body === undefined) {
    Object.assign(requestInit, {
      body: input.body,
      duplex: "half",
    });
  }
  return requestInit;
}

export function createGuardedModelProviderFetch(
  baseUrl: string,
  fetchImpl: typeof fetch,
): typeof fetch {
  return createOriginLockedProviderFetch(
    baseUrl,
    configuredModelProviderNetworkAccess(baseUrl),
    true,
    fetchImpl,
  );
}

function createOriginLockedProviderFetch(
  baseUrl: string,
  networkAccess: ModelProviderNetworkAccess,
  allowInsecureCredentialedHttp: boolean,
  fetchImpl: typeof fetch,
): typeof fetch {
  const configuredOrigin = originFor(baseUrl);

  const guardedFetch: typeof fetch = (input, init) => {
    const requestUrl = fetchInputUrl(input);
    let requestOrigin: string | null;
    try {
      requestOrigin = new URL(requestUrl).origin;
    } catch {
      requestOrigin = null;
    }
    if (!configuredOrigin || requestOrigin !== configuredOrigin) {
      return Promise.reject(
        new Error("Configured model provider requests must target the configured origin."),
      );
    }
    return fetchPublicHttpResponse(requestUrl, {
      ...requestInitFromFetchInput(input, init),
      ...networkAccess,
      fetchImpl,
      maxRedirects: 0,
      // Not the web-fetch tool budget: a model answers on its own clock.
      timeoutMs: TOOL_TIMEOUT_POLICY.modelStreamIdleCeilingMs,
    });
  };
  if (configuredOrigin) {
    guardedProviderFetchPolicies.set(guardedFetch, {
      origin: configuredOrigin,
      allowInsecureCredentialedHttp,
    });
  }
  return guardedFetch;
}

/** Only trusted factory-created fetches for the exact origin authorize credentialed HTTP. */
export function isGuardedInsecureCredentialedModelProviderFetch(
  baseUrl: string | undefined,
  fetchImpl: typeof fetch | undefined,
): boolean {
  if (!baseUrl || !fetchImpl) return false;
  const policy = guardedProviderFetchPolicies.get(fetchImpl);
  return policy?.allowInsecureCredentialedHttp === true && policy.origin === originFor(baseUrl);
}

// Presets allow only explicit keyless loopback access; all requests stay origin-locked.
export function createGuardedMarketplaceProviderFetch(
  baseUrl: string,
  preset: MarketplaceInstalledProviderPreset,
  fetchImpl: typeof fetch,
): typeof fetch {
  return createOriginLockedProviderFetch(
    baseUrl,
    preset.requiresApiKey === false
      ? configuredModelProviderLoopbackAccess(baseUrl)
      : { allowPrivateNetworks: false, allowLoopback: false, allowCarrierGradeNat: false },
    false,
    fetchImpl,
  );
}

/** Select origin-locked preset or saved self-hosted fetches before vendor transport defaults. */
export function selectProviderRuntimeFetch(args: {
  vendor: LLMVendor;
  baseUrl: string | undefined;
  providerMetadata: MarketplaceInstalledProviderPreset | undefined;
  // This private-endpoint transport refuses other vendors and cannot serve as a general fetch.
  llmFetch: typeof fetch | undefined;
  // Guarded requests must use the host proxy and trust-store transport, never an ambient direct fetch.
  networkFetch: typeof fetch;
}): typeof fetch | undefined {
  const { vendor, baseUrl, providerMetadata, llmFetch, networkFetch } = args;
  const isSelfHostedDirect =
    isSelfHostedTrustedNetworkVendor(vendor) && !providerMetadata && Boolean(baseUrl?.trim());
  return providerMetadata && baseUrl
    ? createGuardedMarketplaceProviderFetch(baseUrl, providerMetadata, networkFetch)
    : isSelfHostedDirect && baseUrl
      ? createGuardedModelProviderFetch(baseUrl, networkFetch)
      : vendor === "azure-foundry"
        ? llmFetch
        : undefined;
}
