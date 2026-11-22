import { evaluateHostFetch, runHostFetchHops, type HostFetchDenyReason } from "../host-fetch-guard.js";
import { MemoryMapHostError } from "./errors.js";

type ProviderEgressAudit =
  | { allowed: false; reason: HostFetchDenyReason | "redirect-cap" }
  | { allowed: true; origin: string; method: string };
export type ProviderEgress = (url: URL, init: RequestInit, assertCurrent: () => void) => Promise<Response>;

export function createMemoryProviderEgress(
  transport: typeof fetch,
  allowedDomains: readonly string[],
  audit: (entry: ProviderEgressAudit) => void,
): ProviderEgress {
  const caller = "memory-embeddings";
  return async (url, init, assertCurrent) => {
    const allowed = allowedDomains.filter(domain => domain === url.hostname);
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
}
