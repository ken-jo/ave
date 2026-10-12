/**
 * The price corrections in force, for the renderer's cost surfaces.
 *
 * The usage dashboard prices with the list main resolves (the setting, or the
 * deployment's `AVE_PRICING_OVERRIDE`, which wins whole). The pre-send
 * estimate and the per-turn cost badge must price with that same list, and the
 * environment that can force it is main's — so the renderer asks main for the
 * resolved list (`ave:usage:pricing-overrides`) each time a settings snapshot
 * lands, instead of reading `llm.pricingOverrides` raw.
 *
 * Held in one store for the window: the badge renders deep in the transcript,
 * and every cost surface has to change together when a correction is saved.
 */
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

/**
 * Fetch the list in force and publish it. A reply that arrives after a newer
 * request was sent is dropped, so a slow answer cannot put an older list back.
 */
export async function syncPricingOverrides(api: { getPricingOverrides: () => Promise<unknown> }): Promise<void> {
  const request = ++latestRequest;
  const reply = await api.getPricingOverrides();
  if (request !== latestRequest) return;
  if (!Array.isArray(reply)) {
    // Main answers a list to the host renderer; anything else is a contract
    // fault, reported rather than read as "no corrections".
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
