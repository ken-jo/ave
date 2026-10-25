/** Add aliases only with evidence both ids name the same model; unknown identity must remain unknown. */
import type { LLMVendor } from "../llm-vendor-defaults.js";

export const MODEL_CATALOG_ALIASES: Readonly<Partial<Record<LLMVendor, Readonly<Record<string, string>>>>> = {};
