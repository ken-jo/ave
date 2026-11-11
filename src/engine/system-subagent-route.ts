import type { LLMSettings, SettingsService } from "../data/settings-store.js";
import type { JudgeModelRef } from "../permissions/judge/judge-settings.js";
import { judgeModelCatalogFrom } from "../permissions/judge/judge-model-catalog.js";
import {
  getLlmVendorSettings,
  isLLMVendor,
  llmRouteModel,
  canUseLlmVendorWithoutApiKey,
  LLM_VENDORS,
} from "../shared/llm-vendor-defaults.js";
import { marketplaceProviderPresetSecretKey } from "../shared/marketplace-package-assets.js";
import type { SubscriptionChatRuntimeSelection } from "../shared/subscription-runtime.js";
import { createProvider, secretKeyFor } from "./llm/provider-factory.js";
import { selectProviderRuntimeFetch } from "./llm/marketplace-provider-fetch.js";
import type { LLMProvider } from "./llm/types.js";
import { FallbackProvider } from "./llm/vercel/fallback-chain.js";

export interface SystemSubagentRouteDeps {
  settingsService: SettingsService;
  llmFetch?: typeof fetch;
  networkFetch: typeof fetch;
  subscriptionProviderFactory?: (selection: SubscriptionChatRuntimeSelection) => LLMProvider | null;
}

export interface SystemSubagentProviderPlan {
  secretKey?: string;
  isConnected(apiKey: string | null): boolean;
  build(apiKey: string | null): LLMProvider | null;
}

export function createSystemSubagentProviderPlan(
  deps: SystemSubagentRouteDeps,
  vendor: string,
  selectedModel?: string,
): SystemSubagentProviderPlan | null {
  const { settingsService, llmFetch, networkFetch, subscriptionProviderFactory } = deps;
  const llmSettings = settingsService.get("llm");
  const activeChatRuntime = llmSettings.activeChatRuntime;
  if (selectedModel === undefined && activeChatRuntime?.kind === "subscription") {
    // Include authenticated transport in reviewer cache identity; stale subscription reads must not fall through to an API-key provider.
    if (vendor !== `subscription:${activeChatRuntime.provider}`) return null;
    return {
      isConnected: () => true,
      build: () => subscriptionProviderFactory?.(activeChatRuntime) ?? null,
    };
  }

  // An unresolved chat selection cannot supply the follow-chat route.
  if (selectedModel === undefined && llmSettings.retiredProvider) return null;

  const llmVendor = isLLMVendor(vendor) ? vendor : null;
  if (!llmVendor) return null;
  const block = getLlmVendorSettings(llmSettings.vendors, llmVendor);
  const hasMarketplaceProviderPresetSelection =
    llmVendor === "openai-compatible" &&
    (selectedModel === undefined || llmSettings.provider === llmVendor) &&
    Boolean(llmSettings.marketplaceProviderPresetId);
  const marketplaceProviderPreset = hasMarketplaceProviderPresetSelection
    ? (settingsService.get("marketplace").installedProviderPresets ?? [])
      .find((preset) => preset.providerId === llmSettings.marketplaceProviderPresetId)
    : undefined;
  if (hasMarketplaceProviderPresetSelection && !marketplaceProviderPreset) {
    return null;
  }
  const secretKey = marketplaceProviderPreset
    ? marketplaceProviderPresetSecretKey(marketplaceProviderPreset.providerId)
    : secretKeyFor(llmVendor);
  const effectiveBaseUrl = marketplaceProviderPreset?.baseUrl ?? block.baseUrl;
  const canUseWithoutApiKey = marketplaceProviderPreset
    ? marketplaceProviderPreset.requiresApiKey === false && Boolean(effectiveBaseUrl?.trim())
    : canUseLlmVendorWithoutApiKey(llmVendor, block);
  const projectConfigured = llmVendor === "vertex-ai" && Boolean(block.vertexProject?.trim()
    || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT);
  const isConnected = (apiKey: string | null): boolean => llmVendor === "vertex-ai"
    ? projectConfigured
    : Boolean(apiKey) || canUseWithoutApiKey;
  return {
    secretKey,
    isConnected,
    build: (apiKey) => {
      if (!isConnected(apiKey)) return null;
      const providerFetch = selectProviderRuntimeFetch({
        vendor: llmVendor,
        baseUrl: effectiveBaseUrl,
        providerMetadata: marketplaceProviderPreset,
        llmFetch,
        networkFetch,
      });
      return createProvider({
        vendor: llmVendor,
        apiKey: apiKey ?? "",
        model: selectedModel ?? llmRouteModel(block, marketplaceProviderPreset?.providerId),
        ...(providerFetch ? { fetch: providerFetch } : {}),
        ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
        ...(llmVendor === "openai-compatible" && !marketplaceProviderPreset ? { wire: block.wire } : {}),
        ...(marketplaceProviderPreset ? { providerMetadata: marketplaceProviderPreset } : {}),
        ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
        ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
      });
    },
  };
}

/** Connected model choices shared by hidden instances and the settings picker. */
export async function systemSubagentModelOptions(settingsService: SettingsService): Promise<JudgeModelRef[]> {
  const llm = settingsService.get("llm");
  const presets = settingsService.get("marketplace")?.installedProviderPresets ?? [];
  const catalog = judgeModelCatalogFrom({ ...llm, installedProviderPresets: presets });
  const targets = LLM_VENDORS.map((vendor) => ({
    vendor,
    models: catalog.optionsFor(vendor),
    plan: createSystemSubagentProviderPlan({ settingsService, networkFetch: fetch }, vendor, ""),
  }));
  const options: JudgeModelRef[] = [];
  for (const { vendor, models, plan } of targets) {
    if (!plan) continue;
    const apiKey = plan.secretKey ? await settingsService.getSecret(plan.secretKey) : null;
    if (!plan.isConnected(apiKey)) continue;
    for (const model of models) options.push({ vendor, model });
  }
  return options;
}

/** Resolve one provider instance without registering a conversation or a visible agent. */
export async function resolveSystemSubagentRoute(
  deps: SystemSubagentRouteDeps,
  model: JudgeModelRef,
): Promise<{ provider: LLMProvider; llmSettings: LLMSettings; model: string }> {
  // Capture provider construction and request limits before credential reads can yield to a settings change.
  const plan = createSystemSubagentProviderPlan(deps, model.vendor, model.model);
  const llmSettings = systemSubagentLlmSettings(deps.settingsService, model);
  const options = await systemSubagentModelOptions(deps.settingsService);
  if (!options.some((option) => option.vendor === model.vendor && option.model === model.model)) {
    throw new Error(`System subagent model is unavailable: ${model.vendor}/${model.model}`);
  }
  const apiKey = plan?.secretKey ? await deps.settingsService.getSecret(plan.secretKey) : null;
  const provider = plan?.build(apiKey);
  if (!provider) throw new Error(`System subagent model is unavailable: ${model.vendor}/${model.model}`);
  return {
    provider: new FallbackProvider(provider, [], () => ""),
    model: model.model,
    llmSettings,
  };
}

/** Project the selected route for request limits without changing the chat settings. */
export function systemSubagentLlmSettings(settingsService: SettingsService, model: JudgeModelRef): LLMSettings {
  const llm = settingsService.get("llm");
  const presetId = model.vendor === "openai-compatible" && llm.provider === model.vendor
    ? llm.marketplaceProviderPresetId : undefined;
  const block = getLlmVendorSettings(llm.vendors, model.vendor);
  return {
    ...llm,
    activeChatRuntime: { kind: "api" },
    provider: model.vendor,
    ...(llm.provider !== model.vendor ? { marketplaceProviderPresetId: undefined } : {}),
    vendors: {
      ...llm.vendors,
      [model.vendor]: {
        ...block, model: model.model,
        ...(presetId ? { presetModels: { ...block.presetModels, [presetId]: model.model } } : {}),
      },
    },
    retiredProvider: undefined,
  };
}
