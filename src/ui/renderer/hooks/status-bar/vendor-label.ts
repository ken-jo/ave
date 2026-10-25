import { t } from "../../../../i18n/runtime.js";
import { STATUS_BAR_VENDOR_EMOJIS } from "../../../../shared/status-bar-emojis.js";
import { isLLMVendor } from "../../../../shared/llm-vendor-defaults.js";
import { getVendorOption } from "../../constants.js";

/** Known provider labels match their metadata; unknown persisted ids display as themselves, never as another provider. */
export function shortVendorLabel(provider: string): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "openai":
      return "OpenAI";
    case "gemini":
      return "Gemini";
    case "azure-foundry":
      return "Azure";
    case "vertex-ai":
      return "Vertex";
    default:
      if (!provider) return t("useStatusBarVendor.notConfigured");
      return isLLMVendor(provider) ? getVendorOption(provider).label : provider;
  }
}

/** Vendor glyph — universal emoji so the indicator renders even on minimal font stacks. Picked to match each vendor's brand
 * color/identity at a glance. */
export function vendorEmoji(provider: string): string {
  switch (provider) {
    case "claude":
      return STATUS_BAR_VENDOR_EMOJIS.claude;
    case "openai":
      return STATUS_BAR_VENDOR_EMOJIS.openai;
    case "gemini":
      return STATUS_BAR_VENDOR_EMOJIS.gemini;
    case "azure-foundry":
      return STATUS_BAR_VENDOR_EMOJIS.azureFoundry;
    case "vertex-ai":
      return STATUS_BAR_VENDOR_EMOJIS.vertexAi;
    default:
      return STATUS_BAR_VENDOR_EMOJIS.fallback;
  }
}
