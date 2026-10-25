/** Use active catalog choices for mapped vendors; only unmapped runtimes may retain hand-picked lists. */
import { activeModelCatalog } from "./active.js";
import { CATALOG_PROVIDERS_BY_VENDOR } from "./provider-map.js";
import type { CatalogModel, ModelCatalogDocument } from "./types.js";
import type { LLMVendor } from "../llm-vendor-defaults.js";

/** Chat models require text input, text-only output, tools, and nondeprecated status. */
function isCatalogChatModel(model: CatalogModel): boolean {
  if (model.status === "deprecated") return false;
  if (model.toolCall !== true) return false;
  const modalities = model.modalities;
  if (!modalities) return false;
  return modalities.input.includes("text")
    && modalities.output.length > 0
    && modalities.output.every((kind) => kind === "text");
}

export function vendorHasCatalogProvider(vendor: LLMVendor): boolean {
  return CATALOG_PROVIDERS_BY_VENDOR[vendor].length > 0;
}

/** Sort by release then id and deduplicate; unmapped vendors return no catalog choices. */
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

/** Cache by installed catalog identity, not module load time. */
const chatModelIdsByCatalog = new WeakMap<ModelCatalogDocument, Map<LLMVendor, readonly string[]>>();

function chatModelIdsFrom(catalog: ModelCatalogDocument, vendor: LLMVendor): string[] {
  const found: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const provider of CATALOG_PROVIDERS_BY_VENDOR[vendor]) {
    const models = catalog.providers[provider]?.models;
    if (!models) continue;
    for (const model of Object.values(models)) {
      // The first provider owns identity; later copies cannot revive an entry it deprecates.
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
