/** All cost surfaces share main's resolved price overrides, including environment precedence, through one window store. */
import { useSyncExternalStore } from "react";
import { normalizePricingOverrides, type PricingOverride } from "../../../shared/pricing-overrides.js";

let current: readonly PricingOverride[] = [];
const listeners = new Set<() => void>();
let latestRequest = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly PricingOverride[] {
  return current;
}

/** Fetch the list in force and publish it. A reply that arrives after a newer request was sent is dropped, so a slow answer
 * cannot put an older list back. */
export async function syncPricingOverrides(api: { getPricingOverrides: () => Promise<unknown> }): Promise<void> {
  const request = ++latestRequest;
  const reply = await api.getPricingOverrides();
  if (request !== latestRequest) return;
  if (!Array.isArray(reply)) {
    // Main answers a list to the host renderer; anything else is a contract fault, reported rather than read as "no
    // corrections".
    throw new Error(`pricing overrides: main answered ${typeof reply}, not a list`);
  }
  const next = normalizePricingOverrides(reply);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  for (const listener of listeners) listener();
}

/** The corrections every renderer cost surface prices with. */
export function usePricingOverrides(): readonly PricingOverride[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
