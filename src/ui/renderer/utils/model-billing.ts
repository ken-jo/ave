import type { I18nContextValue } from "../../../i18n/react.js";
import { canUseLlmVendorWithoutApiKey, getLlmVendorSettings, type LLMVendor } from "../../../shared/llm-vendor-defaults.js";
import { marketplaceProviderPresetSecretId } from "../../../shared/marketplace-package-assets.js";
import { subscriptionRuntimeDescriptor, type SubscriptionRuntimeId } from "../../../shared/subscription-runtime.js";
import type { AppSettings } from "../types.js";

export type ModelBillingRoute =
  | { kind: "subscription"; provider: SubscriptionRuntimeId }
  | { kind: "api-key" }
  | { kind: "keyless" };

/** The route's credential requirement and configured key determine billing, independently of its display identifier. */
export function apiModelBillingRoute(vendor: string, requiresApiKey: boolean, keyConfigured: boolean): ModelBillingRoute {
  return { kind: vendor !== "vertex-ai" && (requiresApiKey || keyConfigured) ? "api-key" : "keyless" };
}

/** Resolve the same preset-scoped secret and key requirement as the configured API route. */
export function modelBillingApiAddress(settings: Pick<AppSettings, "llm" | "marketplace">, vendor: LLMVendor, presetId?: string): {
  credentialId: string;
  requiresApiKey: boolean;
} {
  const block = getLlmVendorSettings(settings.llm.vendors, vendor);
  const preset = presetId ? settings.marketplace?.installedProviderPresets?.find((entry) => entry.providerId === presetId) : undefined;
  return {
    credentialId: presetId ? marketplaceProviderPresetSecretId(presetId) : vendor,
    requiresApiKey: presetId ? preset?.requiresApiKey !== false : !canUseLlmVendorWithoutApiKey(vendor, block),
  };
}

export function modelBillingDisclosure(route: ModelBillingRoute | undefined, t: I18nContextValue["t"]): string | undefined {
  if (route?.kind === "subscription") {
    return t("modelBilling.subscription", { plan: subscriptionRuntimeDescriptor(route.provider).planName });
  }
  return route?.kind === "api-key" ? t("modelBilling.apiKey") : undefined;
}
