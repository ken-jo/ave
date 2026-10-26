/** Short auto-dismiss duration for simple one-line toasts (ms). Use when the message is a brief status (e.g. drag-drop
 * result, copy confirmation) that does not require extended reading time. */
export const SHORT_TOAST_TTL_MS = 3000;

/** Default auto-dismiss duration for inline toasts and banners (ms). Most callsites use this value; those that need a
 * longer read window (complex permission banners, MCP status) override explicitly with a comment. */
export const DEFAULT_TOAST_TTL_MS = 4000;

/** Long auto-dismiss duration for toasts that require extended reading (ms). Use for multi-line banners, error details, or
 * Korean prose longer than ~8 words that needs comfortable reading time. */
export const LONG_TOAST_TTL_MS = 5000;

import type { AppSettings, ExecutionMode } from "./types.js";
import {
  LLM_VENDORS,
  OPENAI_COMPATIBLE_PRESET_VENDOR_IDS,
  OPENAI_COMPATIBLE_VENDOR_PRESETS,
  llmVendorModelOptions,
  getLlmThinkingBudgetRungs,
  type OpenAICompatiblePresetVendor,
  type LLMVendor,
} from "../../shared/llm-vendor-defaults.js";
import { t } from "../../i18n/runtime.js";

export const SOURCE_BADGE: Record<string, string> = {
  get builtin() { return t("constants.sourceBadgeBuiltin"); },
  get plugin() { return t("constants.sourceBadgePlugin"); },
  mcp: "MCP",
};

// Settings-dialog UI metadata per vendor. Typed as `Record<LLMVendor, ...>`
// so adding a new entry to `LLM_VENDORS` without updating this object is
// a compile error — keeps the dropdown in lockstep with the canonical
// vendor list. Model choices are read from the installed catalog without
// selecting one on the user's behalf.
interface VendorUiMeta {
  label: string;
  placeholder: string;
  needsBaseUrl: boolean;
  baseUrlPlaceholder?: string;
}

export interface VendorOption extends VendorUiMeta {
  id: LLMVendor;
  /** Read from the installed model catalog each time it is asked (`llmVendorModelOptions`). The renderer installs that
   * catalog before it mounts, after this module has loaded, so the value cannot be taken here. */
  readonly modelOptions: readonly string[];
}

const CORE_VENDOR_UI: Record<Exclude<LLMVendor, OpenAICompatiblePresetVendor>, VendorUiMeta> = {
  claude: { label: "Anthropic Claude", placeholder: "sk-ant-...", needsBaseUrl: false },
  openai: { label: "OpenAI", placeholder: "sk-...", needsBaseUrl: false },
  gemini: { label: "Google Gemini", placeholder: "AIza...", needsBaseUrl: false },
  "azure-foundry": {
    label: "Azure AI Foundry",
    get placeholder() { return t("constants.vendorAzureFoundryPlaceholder"); },
    needsBaseUrl: true,
    baseUrlPlaceholder: "https://{resource}.openai.azure.com/openai/v1/",
  },
  "vertex-ai": {
    label: "Google Vertex AI",
    get placeholder() { return t("constants.vendorVertexAiPlaceholder"); },
    needsBaseUrl: false,
  },
  "openai-compatible": {
    get label() { return t("constants.vendorOpenAiCompatibleLabel"); },
    get placeholder() { return t("constants.vendorOpenAiCompatiblePlaceholder"); },
    needsBaseUrl: true,
    baseUrlPlaceholder: "http://<host>:8001/v1",
  },
};

const PRESET_VENDOR_UI = Object.fromEntries(
  OPENAI_COMPATIBLE_PRESET_VENDOR_IDS.map((id) => {
    const preset = OPENAI_COMPATIBLE_VENDOR_PRESETS[id];
    return [
      id,
      {
        label: preset.label,
        placeholder: preset.apiKeyPlaceholder,
        needsBaseUrl: true,
        baseUrlPlaceholder: preset.baseUrl,
      } satisfies VendorUiMeta,
    ];
  }),
) as Record<OpenAICompatiblePresetVendor, VendorUiMeta>;

const VENDOR_UI: Record<LLMVendor, VendorUiMeta> = {
  ...CORE_VENDOR_UI,
  ...PRESET_VENDOR_UI,
};

export const ALL_VENDORS: VendorOption[] = LLM_VENDORS.map((id) => ({
  id,
  ...VENDOR_UI[id],
  get modelOptions() {
    return llmVendorModelOptions(id);
  },
}));

export const VENDORS = [...ALL_VENDORS];

export function getVendorOption(vendorId: string): VendorOption {
  return ALL_VENDORS.find((vendor) => vendor.id === vendorId) ?? VENDORS[0]!;
}

export function visibleVendorsFor(): VendorOption[] {
  return [...ALL_VENDORS];
}

export const WEB_PROVIDERS: { id: AppSettings["webSearch"]["provider"]; label: string; readonly placeholder: string; needsKey: boolean }[] = [
  { id: "duckduckgo", label: "DuckDuckGo", get placeholder() { return t("constants.webProviderDuckDuckGoPlaceholder"); }, needsKey: false },
  { id: "tavily", label: "Tavily AI", placeholder: "tvly-...", needsKey: true },
  { id: "serper", label: "Serper.dev", get placeholder() { return t("constants.webProviderSerperPlaceholder"); }, needsKey: true },
  { id: "google", label: "Google Search", get placeholder() { return t("constants.webProviderGooglePlaceholder"); }, needsKey: true },
];

const REASONING_DEPTH_LABELS = {
  low: "constants.reasoningEffortLow",
  medium: "constants.reasoningEffortMedium",
  high: "constants.reasoningEffortHigh",
  xhigh: "constants.reasoningEffortXHigh",
} as const;

/** Settings and composer label the same output-dependent user budget ladder. */
export function getReasoningDepths(outputTokenLimit?: number) {
  return getLlmThinkingBudgetRungs(outputTokenLimit).map((rung) => ({
    ...rung,
    get label() { return t(REASONING_DEPTH_LABELS[rung.key]); },
  }));
}

/** An off-preset stored value keeps its exact budget and a custom label. */
export function reasoningBudgetLabel(budget: number, depths: readonly { label: string; budget: number }[]): string {
  return depths.find((depth) => depth.budget === budget)?.label ?? t("constants.reasoningEffortCustom");
}

/** The rung a stored budget sits closest to. Any persisted value resolves. */
export function budgetToDepthIndex(budget: number, depths: readonly { budget: number }[]): number {
  if (depths.length === 0) return -1;
  let closest = 0;
  let minDiff = Math.abs(depths[0]!.budget - budget);
  for (let i = 1; i < depths.length; i++) {
    const diff = Math.abs(depths[i]!.budget - budget);
    if (diff < minDiff) {
      minDiff = diff;
      closest = i;
    }
  }
  return closest;
}

// Ordered most-restrictive → least-restrictive so the policy picker reads as a auto-wired from this mode
// (handleModeChange), so this is the only permission axis the user sets.
export const EXEC_MODE_OPTIONS: { value: ExecutionMode; readonly label: string; readonly description: string }[] = [
  {
    value: "strict",
    get label() { return t("constants.execModeStrictLabel"); },
    get description() { return t("constants.execModeStrictDesc"); },
  },
  {
    value: "default",
    get label() { return t("constants.execModeDefaultLabel"); },
    get description() { return t("constants.execModeDefaultDesc"); },
  },
  {
    value: "auto",
    get label() { return t("constants.execModeAutoLabel"); },
    get description() { return t("constants.execModeAutoDesc"); },
  },
  {
    value: "allow",
    get label() { return t("constants.execModeAllowLabel"); },
    get description() { return t("constants.execModeAllowDesc"); },
  },
];

// Keep in sync with src/tools/render-html.ts — the server already clamps, but reloaded history could deliver forged/NaN
// values and we must not trust them at render time.
export const RENDER_HTML_MIN_HEIGHT = 80;
export const RENDER_HTML_MAX_HEIGHT = 1200;
export const RENDER_HTML_DEFAULT_HEIGHT = 400;
