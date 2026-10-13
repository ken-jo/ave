/**
 * Ave-owned aliases: a vendor's model id the catalog lists under a
 * different id, for the cases {@link resolveCatalogKey}'s normalization steps
 * cannot find on their own.
 *
 * Add an entry only when both ids are documented to name the same model.
 * An entry made to shorten a list of unknown models would put one model's
 * window and price on another; an unknown model is an honest answer, and the
 * caller's next source (what the endpoint reports, the user's setting, the
 * host fallback) takes over. Empty today: every vendor id the bundled snapshot
 * can describe is found by the steps, and the rest have no catalog entry to
 * point at.
 */
import type { LLMVendor } from "../llm-vendor-defaults.js";

export const MODEL_CATALOG_ALIASES: Readonly<Partial<Record<LLMVendor, Readonly<Record<string, string>>>>> = {};
