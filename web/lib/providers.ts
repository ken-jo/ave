import {
  BUILT_IN_LLM_VENDOR_IDS,
  isApiKeyOptionalLlmVendor,
  isOpenAICompatiblePresetVendor,
  LLM_VENDORS,
  OPENAI_COMPATIBLE_VENDOR_PRESETS,
  type LLMVendor,
  type OpenAICompatiblePresetVendor,
} from "../../src/shared/llm-vendor-defaults";
import type { Locale } from "./i18n";
import { packagesOf, type Pkg } from "./marketplace";

/**
 * The model providers the app supports, read from the app's own provider list
 * (`src/shared/llm-vendor-defaults.ts`) at build time: which vendors ship in
 * the app, which come as marketplace provider packages, their endpoints, and
 * which need no API key. Nothing here is a hand-kept list of providers.
 *
 * The only names this file carries are the six core vendors' display names,
 * which the app keeps in its renderer (`src/ui/renderer/constants.ts`, partly
 * translated). The record is exhaustive over those ids, so a new core vendor
 * fails the type check until it is named here.
 */

type CoreVendor = Exclude<LLMVendor, OpenAICompatiblePresetVendor>;

const CORE_NAMES: Record<CoreVendor, Record<Locale, string>> = {
  claude: { en: "Anthropic Claude", ko: "Anthropic Claude" },
  openai: { en: "OpenAI", ko: "OpenAI" },
  gemini: { en: "Google Gemini", ko: "Google Gemini" },
  "azure-foundry": { en: "Azure AI Foundry", ko: "Azure AI Foundry" },
  "vertex-ai": { en: "Google Vertex AI", ko: "Google Vertex AI" },
  "openai-compatible": { en: "OpenAI-compatible (custom)", ko: "OpenAI 호환 (사용자 지정)" },
};

export interface Provider {
  id: LLMVendor;
  name: string;
  builtIn: boolean;
  /** Host of the preset endpoint, for OpenAI-compatible presets. */
  host?: string;
  gateway: boolean;
  keyOptional: boolean;
  /** The official catalog's provider package, for a vendor that is not built in. */
  pkg?: Pkg;
}

export function providers(locale: Locale): Provider[] {
  const builtIn = new Set<string>(BUILT_IN_LLM_VENDOR_IDS);
  const pkgs = packagesOf("provider");
  return LLM_VENDORS.map((id) => {
    const preset = isOpenAICompatiblePresetVendor(id) ? OPENAI_COMPATIBLE_VENDOR_PRESETS[id] : null;
    const name = preset ? preset.label : CORE_NAMES[id as CoreVendor][locale];
    return {
      id,
      name,
      builtIn: builtIn.has(id),
      host: preset ? new URL(preset.baseUrl).host : undefined,
      gateway: preset?.gateway === true,
      keyOptional: isApiKeyOptionalLlmVendor(id),
      pkg: builtIn.has(id) ? undefined : pkgs.find((p) => p.name === id),
    };
  });
}
