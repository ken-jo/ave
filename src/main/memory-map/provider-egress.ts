import { validateHttpUrl } from "../../core/network-guard.js";
import { isLoopbackHost } from "../host-allow-list.js";
import { evaluateHostFetch, runHostFetchHops, type HostFetchDenyReason } from "../host-fetch-guard.js";
import { MemoryMapHostError } from "./errors.js";

type ProviderEgressAudit =
  | { allowed: false; reason: HostFetchDenyReason | "redirect-cap" }
  | { allowed: true; origin: string; method: string };
export interface ProviderEgress {
  isRouteEligible: (baseUrl: string | undefined) => boolean;
  send: (url: URL, init: RequestInit, assertCurrent: () => void) => Promise<Response>;
}

export function createMemoryProviderEgress(
  transport: typeof fetch,
  allowedDomains: readonly string[],
  audit: (entry: ProviderEgressAudit) => void,
): ProviderEgress {
  const caller = "memory-embeddings";
  const eligibilityDenial = (rawUrl: string | undefined): HostFetchDenyReason | undefined => {
    let url: URL;
    try {
      url = validateHttpUrl(rawUrl ?? "");
    } catch {
      return "invalid-url";
    }
    const isAllowed = allowedDomains.includes(url.hostname);
    if (url.protocol !== "https:" && !(isAllowed && isLoopbackHost(url.hostname))) return "non-https";
    return isAllowed ? undefined : "not-allowlisted";
  };
  const send: ProviderEgress["send"] = async (url, init, assertCurrent) => {
    const denied = eligibilityDenial(url.href);
    if (denied) {
      audit({ allowed: false, reason: denied });
      throw new MemoryMapHostError("provider-unavailable");
    }
    const allowed = [url.hostname];
    const first = await evaluateHostFetch({ pluginId: caller, rawUrl: url.href, method: init.method, allowedDomains: allowed });
    assertCurrent();
    if (!first.ok) {
      audit({ allowed: false, reason: first.reason });
      throw new MemoryMapHostError("provider-unavailable");
    }
    return runHostFetchHops({
      pluginId: caller,
      first,
      init: { ...init, redirect: "error" },
      transport,
      allowedDomains: allowed,
      allowPrivateNetworks: false,
      auditDeny: reason => audit({ allowed: false, reason }),
      authorizeHop: async () => { audit({ allowed: true, origin: first.url.origin, method: first.method }); },
      assertSendAllowed: assertCurrent,
    });
  };
  return { isRouteEligible: baseUrl => eligibilityDenial(baseUrl) === undefined, send };
}
