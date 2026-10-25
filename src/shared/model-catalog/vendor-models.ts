/**
 * The chat models a vendor offers, read from the active model catalog.
 *
 * The catalog is the single source for which models exist (design
 * `model-capability-catalog.md`). Hand-written seed lists drifted: every API
 * provider offered models a release or more behind the catalog the same build
 * shipped. A vendor with a catalog provider therefore lists what the catalog
 * says that provider serves; only a vendor with no catalog provider (a local
 * runtime, a self-hosted gateway) keeps a hand-picked list.
 */
import { activeModelCatalog } from "./active.js";
import { CATALOG_PROVIDERS_BY_VENDOR } from "./provider-map.js";
import type { CatalogModel, ModelCatalogDocument } from "./types.js";
import type { LLMVendor } from "../llm-vendor-defaults.js";

/**
 * A model a chat turn can run on: text in, text only out, tool calls, and not
 * marked deprecated. Image, audio, realtime and embedding models are listed in
 * the same catalog providers but cannot answer a turn.
 */
function isCatalogChatModel(model: CatalogModel): boolean {
  if (model.status === "deprecated") return false;
  if (model.toolCall !== true) return false;
  const modalities = model.modalities;
  if (!modalities) return false;
  return modalities.input.includes("text")
    && modalities.output.length > 0
    && modalities.output.every((kind) => kind === "text");
}

/** Whether the vendor has a catalog provider at all. */
export function vendorHasCatalogProvider(vendor: LLMVendor): boolean {
  return CATALOG_PROVIDERS_BY_VENDOR[vendor].length > 0;
}

/**
 * The vendor's chat model ids from the active catalog, newest release first
 * (ties by id), without duplicates. Empty for a vendor with no catalog
 * provider; callers decide what that vendor offers instead.
 */
export function catalogChatModelIds(vendor: LLMVendor): readonly string[] {
  const catalog = activeModelCatalog();
  let byVendor = chatModelIdsByCatalog.get(catalog);
  if (!byVendor) {
    byVendor = new Map();
    chatModelIdsByCatalog.set(catalog, byVendor);
  }
  const cached = byVendor.get(vendor);
  if (cached) return cached;
  const ids = Object.freeze(chatModelIdsFrom(catalog, vendor));
  byVendor.set(vendor, ids);
  return ids;
}

/**
 * The settings card and the sub-agent check ask on every render and spawn;
 * the answer only changes when a different catalog document is installed.
 */
const chatModelIdsByCatalog = new WeakMap<ModelCatalogDocument, Map<LLMVendor, readonly string[]>>();

function chatModelIdsFrom(catalog: ModelCatalogDocument, vendor: LLMVendor): string[] {
  const found: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const provider of CATALOG_PROVIDERS_BY_VENDOR[vendor]) {
    const models = catalog.providers[provider]?.models;
    if (!models) continue;
    for (const model of Object.values(models)) {
      // The first mapped provider that lists an id is the entry the resolver
      // answers with (`context-budget.ts` `catalogModelFor`), so a later
      // provider's copy cannot bring back a model that entry deprecates.
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      if (isCatalogChatModel(model)) found.push(model);
    }
  }
  found.sort((a, b) => {
    const byDate = (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "");
    return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
  });
  return found.map((model) => model.id);
}
