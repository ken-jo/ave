/**
 * Find the catalog entry for a model an Ave vendor serves.
 *
 * The one place a `(vendor, model)` pair becomes a catalog key. Each step is
 * tried across the vendor's catalog providers, in the order the provider map
 * lists them, before the next step is tried:
 *
 *  1. the id exactly as given;
 *  2. an Ave-owned alias ({@link MODEL_CATALOG_ALIASES}), and the id with a
 *     Vertex version tag (`@default`, `@20250929`) dropped from either side:
 *     Vertex lists Claude as `claude-opus-4-6@default`, Ave names it
 *     `claude-opus-4-6`;
 *  3. an entry whose `canonicalId` is the id given (`<lab>/<model>`);
 *  4. the id without a release-date suffix (`-20250514`, `-2025-04-16`);
 *  5. the id with case and version separators folded (`4-6` against `4.6`);
 *  6. the same, ignoring a path prefix on either side (`openai/gpt-5.4`
 *     against `gpt-5.4`): gateways disagree about whether the lab is part of
 *     the id.
 *
 * The version-tag match and steps 3, 5 and 6 answer only when exactly one entry matches. Two candidates
 * mean the id does not say which model it is, and a guessed entry would put
 * another model's window and price on this one. No match is an answer too:
 * the model is unknown to the catalog, and the caller's next source decides.
 *
 * A vendor whose map entry is empty (a self-hosted endpoint, a local runtime)
 * never matches by name. The user may name the entry the endpoint serves
 * (`llm.vendors.<vendor>.catalogModel`, `<provider>/<id>`), which is looked up
 * exactly with {@link lookupCatalogModel}.
 */
import { MODEL_CATALOG_ALIASES } from "./aliases.js";
import { CATALOG_PROVIDERS_BY_VENDOR } from "./provider-map.js";
import type { CatalogModel, ModelCatalogDocument } from "./types.js";
import { isLLMVendor, isOpenAICompatiblePresetVendor, OPENAI_COMPATIBLE_VENDOR_PRESETS, type LLMVendor } from "../llm-vendor-defaults.js";

type CatalogMatch = "exact" | "alias" | "version-tag" | "canonical" | "date-suffix" | "folded" | "unprefixed" | "named";

export interface CatalogModelHit {
  /** Catalog provider id. */
  readonly provider: string;
  /** The entry's id within that provider. */
  readonly id: string;
  /** Which step found it. */
  readonly match: CatalogMatch;
  readonly model: CatalogModel;
}

type Catalog = Pick<ModelCatalogDocument, "providers">;

const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/u;
/** Vertex AI's model version tag: `@default` or a release date. */
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

/**
 * A mapped vendor's model name describes its limits only at its own endpoint.
 * A gateway may alias that name to a different deployment. Explicit settings
 * and endpoint reports still answer; unmapped vendors keep their existing
 * pricing rows until the legacy table is removed.
 */
export function allowsImplicitModelLimits(vendor: string, baseUrl?: string): boolean {
  // Without an override, the route uses the vendor's native default.
  if (providersFor(vendor).length === 0 || !baseUrl?.trim()) return true;
  try {
    const endpoint = new URL(baseUrl.trim());
    if (endpoint.protocol !== "https:" || endpoint.port !== "") return false;
    // Resource-scoped APIs use per-account or regional hosts.
    if (vendor === "azure-foundry") {
      return endpoint.hostname.endsWith(".openai.azure.com") || endpoint.hostname.endsWith(".services.ai.azure.com");
    }
    if (vendor === "vertex-ai") {
      return endpoint.hostname === "aiplatform.googleapis.com" || endpoint.hostname.endsWith("-aiplatform.googleapis.com");
    }
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

/** The single entry `accept` picks out across the providers, or none when zero or several do. */
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

/**
 * The entry a user named for an endpoint the catalog cannot match by name:
 * `<provider>/<id>`, looked up exactly. A name that is malformed or not in
 * the catalog answers nothing; the settings surface reports that, not this.
 */
export function lookupCatalogModel(catalog: Catalog, named: string): CatalogModelHit | undefined {
  const slash = named.indexOf("/");
  if (slash <= 0 || slash === named.length - 1) return undefined;
  const provider = named.slice(0, slash);
  const id = named.slice(slash + 1);
  const models = catalog.providers[provider]?.models;
  if (!models || !Object.hasOwn(models, id)) return undefined;
  return { provider, id, match: "named", model: models[id] as CatalogModel };
}
