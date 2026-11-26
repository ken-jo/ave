import { catalogModelFor, llmRouteCatalogAddress, type LlmRouteProviderPreset, type LlmRouteSettings } from "./context-budget.js";
import { activeLlmRouteModel } from "./llm-vendor-defaults.js";
import { activeModelCatalog } from "./model-catalog/active.js";
import { lookupCatalogModel } from "./model-catalog/resolve.js";

/** The selected id and the catalog release it resolves to while deprecated. */
export interface ModelDeprecation {
  model: string;
  catalogEntry: string;
  releaseDate?: string;
}

export function modelDeprecationKey({ model, catalogEntry, releaseDate }: ModelDeprecation): string {
  return JSON.stringify([model, catalogEntry, releaseDate ?? null]);
}

/** A return to active status ends the observed deprecation. */
export function isCurrentModelDeprecation({ catalogEntry, releaseDate }: ModelDeprecation): boolean {
  const hit = lookupCatalogModel(activeModelCatalog(), catalogEntry);
  return hit?.model.status === "deprecated" && hit.model.releaseDate === releaseDate;
}

/** Resolve catalog deprecation for a saved route after the host has ruled out blocking retirement. */
export function modelDeprecationForRoute(
  llm: LlmRouteSettings,
  installedProviderPresets?: readonly LlmRouteProviderPreset[],
): ModelDeprecation | undefined {
  const model = activeLlmRouteModel(llm);
  if (!model) return undefined;
  const { vendor, baseUrl } = llmRouteCatalogAddress(llm, installedProviderPresets);
  const hit = catalogModelFor(vendor, model, undefined, baseUrl);
  if (hit?.model.status !== "deprecated") return undefined;
  return {
    model,
    catalogEntry: `${hit.provider}/${hit.id}`,
    ...(hit.model.releaseDate !== undefined ? { releaseDate: hit.model.releaseDate } : {}),
  };
}
