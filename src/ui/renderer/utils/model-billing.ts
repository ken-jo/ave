import type { I18nContextValue } from "../../../i18n/react.js";
import { subscriptionRuntimeDescriptor, type SubscriptionRuntimeId } from "../../../shared/subscription-runtime.js";

export type ModelBillingRoute =
  | { kind: "subscription"; provider: SubscriptionRuntimeId }
  | { kind: "api-key" }
  | { kind: "keyless" };

/** The route's credential requirement and configured key determine billing, independently of its display identifier. */
export function apiModelBillingRoute(vendor: string, requiresApiKey: boolean, keyConfigured: boolean): ModelBillingRoute {
  return { kind: vendor !== "vertex-ai" && (requiresApiKey || keyConfigured) ? "api-key" : "keyless" };
}

export function modelBillingDisclosure(route: ModelBillingRoute | undefined, t: I18nContextValue["t"]): string | undefined {
  if (route?.kind === "subscription") {
    return t("modelBilling.subscription", { plan: subscriptionRuntimeDescriptor(route.provider).planName });
  }
  return route?.kind === "api-key" ? t("modelBilling.apiKey") : undefined;
}
