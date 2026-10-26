import {
  activeLlmRouteModel,
  type LLMVendor,
  type LLMVendorSettingsMap,
  type LlmRouteRetirement,
} from "./llm-vendor-defaults.js";
import type { ActiveChatRuntime, SubscriptionRuntimeId } from "./subscription-runtime.js";

/** Share actionable missing-model states across UI and send validation. */
type ActiveChatModelUnavailableReason =
  | "no-connected-provider"
  | "retired-provider"
  | "no-model-selected";

export type ActiveChatModel =
  | { readonly kind: "none"; readonly reason: ActiveChatModelUnavailableReason }
  | {
    readonly kind: "api";
    readonly vendor: LLMVendor;
    readonly model: string;
    readonly marketplaceProviderPresetId?: string;
  }
  | {
    readonly kind: "subscription";
    readonly provider: SubscriptionRuntimeId;
    /** Null for a runtime that has no model of its own to name. */
    readonly model: string | null;
  };

export interface ActiveChatModelSettings {
  provider: LLMVendor;
  vendors: LLMVendorSettingsMap;
  marketplaceProviderPresetId?: string;
  retiredProvider?: LlmRouteRetirement;
  activeChatRuntime: ActiveChatRuntime;
}

/** Main owns the credential check; subscription sign-in readiness is a separate policy. */
export function resolveActiveChatModel(
  llm: ActiveChatModelSettings,
  apiRouteConnected: boolean,
): ActiveChatModel {
  const runtime = llm.activeChatRuntime;
  if (runtime.kind === "subscription") {
    const model = runtime.model?.trim() ?? "";
    return { kind: "subscription", provider: runtime.provider, model: model || null };
  }
  if (llm.retiredProvider) return { kind: "none", reason: "retired-provider" };
  if (!apiRouteConnected) return { kind: "none", reason: "no-connected-provider" };
  const model = activeLlmRouteModel(llm);
  if (!model) return { kind: "none", reason: "no-model-selected" };
  const presetId = llm.provider === "openai-compatible" ? llm.marketplaceProviderPresetId?.trim() : undefined;
  return {
    kind: "api",
    vendor: llm.provider,
    model,
    ...(presetId ? { marketplaceProviderPresetId: presetId } : {}),
  };
}
