import {
  activeLlmRouteModel,
  type LLMVendor,
  type LLMVendorSettingsMap,
  type LlmRouteRetirement,
} from "./llm-vendor-defaults.js";
import type { ActiveChatRuntime, SubscriptionRuntimeId } from "./subscription-runtime.js";

/**
 * Why no model is active. Each one is a state a person can act on, and the
 * composer, Settings and the send path all read the same answer.
 */
type ActiveChatModelUnavailableReason =
  /** The active API route has no credential (and cannot run without one). */
  | "no-connected-provider"
  /** The saved provider was retired; the user has to pick a new one. */
  | "retired-provider"
  /** The route is connected but names no model (handshake-only providers). */
  | "no-model-selected";

/**
 * The model chat would run on right now, or an explicit "none".
 *
 * A vendor block always carries a model id — the vendor's default is what a
 * newly connected provider starts on — so the stored id alone cannot say
 * whether a model is selected. A fresh profile holds `openai`/`gpt-5.4-mini`
 * with no key behind it; projecting that as the active model showed a model
 * nobody chose and no route could answer. This union is the one answer.
 */
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

/**
 * Resolve the active chat model.
 *
 * `apiRouteConnected` is the caller's answer to "can the active API route
 * authenticate": main reads the secret store, which is the only place that
 * knows. A selected subscription runtime is reported as such; whether it has
 * finished signing in is the subscription readiness policy's question.
 */
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
