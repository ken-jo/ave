/** Try matching steps across mapped providers in order; ambiguous matches remain unknown. Unmapped endpoints require explicit catalog identity. */
import { MODEL_CATALOG_ALIASES } from "./aliases.js";
import { CATALOG_PROVIDERS_BY_VENDOR } from "./provider-map.js";
import type { CatalogModel, ModelCatalogDocument } from "./types.js";
import { isLLMVendor, isOpenAICompatiblePresetVendor, OPENAI_COMPATIBLE_VENDOR_PRESETS, type LLMVendor } from "../llm-vendor-defaults.js";

type CatalogMatch = "exact" | "alias" | "version-tag" | "canonical" | "date-suffix" | "folded" | "unprefixed" | "named";

export interface CatalogModelHit {
  readonly provider: string;
  readonly id: string;
  /** Which step found it. */
  readonly match: CatalogMatch;
  readonly model: CatalogModel;
}

type Catalog = Pick<ModelCatalogDocument, "providers">;

/** Recognize date-shaped suffixes only; four-digit versions that are not month/day remain intact. */
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2}|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/u;
/** Version tags may name default or release-date snapshots. */
const VERSION_TAG = /@(?:default|\d{8})$/u;

function fold(id: string): string {
  return id.toLowerCase().replace(/\./gu, "-");
}

function lastSegment(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

function providersFor(vendor: string): readonly string[] {
  return Object.hasOwn(CATALOG_PROVIDERS_BY_VENDOR, vendor) ? CATALOG_PROVIDERS_BY_VENDOR[vendor as LLMVendor] : [];
}

const DEFAULT_API_ORIGINS: Partial<Record<LLMVendor, string>> = {
  openai: "https://api.openai.com",
  claude: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

const OPENAI_NATIVE_API_HOSTS: readonly string[] = [
  "api.openai.com",
  "us.api.openai.com", "eu.api.openai.com", "au.api.openai.com", "ca.api.openai.com",
  "jp.api.openai.com", "in.api.openai.com", "sg.api.openai.com", "kr.api.openai.com",
  "gb.api.openai.com", "ae.api.openai.com",
  "mtls.api.openai.com", "mtls-us.api.openai.com", "mtls-eu.api.openai.com",
];

/** Implicit model identity holds only on the vendor’s native route; explicit settings and endpoint reports remain independent. */
export function allowsImplicitModelLimits(vendor: string, baseUrl?: string): boolean {
  // Deployment aliases and resource hostnames cannot establish public model identity.
  if (vendor === "azure-foundry") return false;
  // Without an override, the route uses the vendor's native default.
  if (providersFor(vendor).length === 0 || !baseUrl?.trim()) return true;
  try {
    const endpoint = new URL(baseUrl.trim());
    if (endpoint.protocol !== "https:" || endpoint.port !== "") return false;
    // Resource-scoped APIs use per-account or regional hosts.
    if (vendor === "vertex-ai") {
      return endpoint.hostname === "aiplatform.googleapis.com" || endpoint.hostname.endsWith("-aiplatform.googleapis.com");
    }
    if (vendor === "openai") return OPENAI_NATIVE_API_HOSTS.includes(endpoint.hostname);
    const standard = isLLMVendor(vendor) && isOpenAICompatiblePresetVendor(vendor)
      ? OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].baseUrl
      : DEFAULT_API_ORIGINS[vendor as LLMVendor];
    if (standard === undefined || endpoint.origin !== new URL(standard).origin) return false;
    // Some paths select a different product on the same API host.
    if (vendor === "zai" || vendor === "zai-coding-plan") {
      return endpoint.pathname.replace(/\/+$/u, "") === new URL(standard).pathname.replace(/\/+$/u, "");
    }
    return true;
  } catch {
    return false;
  }
}

function exact(catalog: Catalog, providers: readonly string[], id: string, match: CatalogMatch): CatalogModelHit | undefined {
  for (const provider of providers) {
    const models = catalog.providers[provider]?.models;
    if (models && Object.hasOwn(models, id)) return { provider, id, match, model: models[id] as CatalogModel };
  }
  return undefined;
}

/** Return only a unique accepted entry across providers. */
function unique(
  catalog: Catalog,
  providers: readonly string[],
  match: CatalogMatch,
  accept: (id: string, model: CatalogModel) => boolean,
): CatalogModelHit | undefined {
  for (const provider of providers) {
    const models = catalog.providers[provider]?.models ?? {};
    const hits = Object.keys(models).filter((id) => accept(id, models[id] as CatalogModel));
    if (hits.length === 1) {
      const id = hits[0] as string;
      return { provider, id, match, model: models[id] as CatalogModel };
    }
    if (hits.length > 1) return undefined;
  }
  return undefined;
}

export function resolveCatalogKey(
  catalog: Catalog,
  vendor: string,
  model: string,
  aliases: typeof MODEL_CATALOG_ALIASES = MODEL_CATALOG_ALIASES,
): CatalogModelHit | undefined {
  const providers = providersFor(vendor);
  if (providers.length === 0 || model.length === 0) return undefined;
  const direct = exact(catalog, providers, model, "exact");
  if (direct) return direct;
  const vendorAliases = Object.hasOwn(aliases, vendor) ? aliases[vendor as LLMVendor] : undefined;
  const alias = vendorAliases && Object.hasOwn(vendorAliases, model) ? vendorAliases[model] : undefined;
  if (alias) {
    const aliased = exact(catalog, providers, alias, "alias");
    if (aliased) return aliased;
  }
  const untagged = model.replace(VERSION_TAG, "");
  const tagged = unique(catalog, providers, "version-tag", (id) => id !== model && id.replace(VERSION_TAG, "") === untagged);
  if (tagged) return tagged;
  const canonical = unique(catalog, providers, "canonical", (_id, entry) => entry.canonicalId === model);
  if (canonical) return canonical;
  const undated = model.replace(DATE_SUFFIX, "");
  if (undated !== model) {
    const hit = exact(catalog, providers, undated, "date-suffix");
    if (hit) return hit;
  }
  const folded = fold(model);
  const foldedHit = unique(catalog, providers, "folded", (id) => fold(id) === folded);
  if (foldedHit) return foldedHit;
  const bare = fold(lastSegment(model));
  return unique(catalog, providers, "unprefixed", (id) => fold(lastSegment(id)) === bare);
}

/** Explicit catalog keys use exact lookup; missing or malformed keys remain unresolved for UI reporting. */
export function lookupCatalogModel(catalog: Catalog, named: string): CatalogModelHit | undefined {
  const slash = named.indexOf("/");
  if (slash <= 0 || slash === named.length - 1) return undefined;
  const provider = named.slice(0, slash);
  const id = named.slice(slash + 1);
  const models = catalog.providers[provider]?.models;
  if (!models || !Object.hasOwn(models, id)) return undefined;
  return { provider, id, match: "named", model: models[id] as CatalogModel };
}
