import type { LLMSettings, SettingsService } from "../data/settings-store.js";
import type { JudgeModelRef } from "../permissions/judge/judge-settings.js";
import { judgeModelCatalogFrom } from "../permissions/judge/judge-model-catalog.js";
import { getLlmVendorSettings, isLLMVendor, llmRouteModel, canUseLlmVendorWithoutApiKey, LLM_VENDORS } from "../shared/llm-vendor-defaults.js";
import type { SubscriptionChatRuntimeSelection } from "../shared/subscription-runtime.js";
import type { LlmRouteProviderPreset } from "../shared/context-budget.js";
import { sameSystemSubagentModel, sameSystemSubagentRouteIdentity, systemSubagentRouteIdentity, type SystemSubagentRouteIdentity } from "../shared/system-subagent-model.js";
import { createProvider } from "./llm/provider-factory.js";
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
  route?: SystemSubagentRouteIdentity;
  isConnected(apiKey: string | null): boolean;
  build(apiKey: string | null): LLMProvider | null;
}

function settingsWithProjectEnvironment(llm: LLMSettings): LLMSettings {
  const block = getLlmVendorSettings(llm.vendors, "vertex-ai");
  return {
    ...llm,
    vendors: {
      ...llm.vendors,
      "vertex-ai": {
        ...block,
        vertexProject: block.vertexProject || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "",
        vertexLocation: block.vertexLocation || "us-central1",
      },
    },
  };
}

export function systemSubagentCurrentRouteIdentity(
  llm: LLMSettings,
  presets: readonly LlmRouteProviderPreset[] | undefined,
  vendor: JudgeModelRef["vendor"],
  presetId?: string,
): SystemSubagentRouteIdentity | null {
  return systemSubagentRouteIdentity(settingsWithProjectEnvironment(llm), vendor, presets, presetId);
}

export function createSystemSubagentProviderPlan(
  deps: SystemSubagentRouteDeps,
  vendor: string,
  selectedModel?: string,
  selectedRoute?: SystemSubagentRouteIdentity,
): SystemSubagentProviderPlan | null {
  const { settingsService, llmFetch, networkFetch, subscriptionProviderFactory } = deps;
  const llmSettings = settingsWithProjectEnvironment(settingsService.get("llm"));
  const activeChatRuntime = llmSettings.activeChatRuntime;
  if (selectedModel === undefined && activeChatRuntime?.kind === "subscription") {
    if (vendor !== `subscription:${activeChatRuntime.provider}`) return null;
    return { isConnected: () => true, build: () => subscriptionProviderFactory?.(activeChatRuntime) ?? null };
  }
  if (selectedModel === undefined && llmSettings.retiredProvider) return null;
  if (!isLLMVendor(vendor) || (selectedModel !== undefined && !selectedRoute)) return null;
  const presets = settingsService.get("marketplace")?.installedProviderPresets ?? [];
  const presetId = selectedModel !== undefined ? selectedRoute?.marketplaceProviderPresetId
    : vendor === "openai-compatible" && llmSettings.provider === vendor ? llmSettings.marketplaceProviderPresetId : undefined;
  const route = systemSubagentCurrentRouteIdentity(llmSettings, presets, vendor, presetId);
  if (!route || (vendor === "openai-compatible" && !route.baseUrl)) return null;
  if (selectedRoute && !sameSystemSubagentRouteIdentity(selectedRoute, route)) return null;
  const block = getLlmVendorSettings(llmSettings.vendors, vendor);
  const preset = presetId ? presets.find((entry) => entry.providerId === presetId) : undefined;
  const presetPolicy = JSON.stringify([preset?.requiresApiKey, preset?.capabilities, preset?.trust]);
  const canUseWithoutApiKey = preset ? preset.requiresApiKey === false : canUseLlmVendorWithoutApiKey(vendor, block);
  const isConnected = (apiKey: string | null): boolean => vendor === "vertex-ai"
    ? Boolean(route.vertexProject) : Boolean(apiKey) || canUseWithoutApiKey;
  return {
    secretKey: route.credentialScope,
    route,
    isConnected,
    build: (apiKey) => {
      // Recheck identity after asynchronous credential reads before transmitting any input.
      const currentRoute = systemSubagentCurrentRouteIdentity(settingsService.get("llm"),
        settingsService.get("marketplace")?.installedProviderPresets ?? [], vendor, presetId);
      if (!currentRoute || !sameSystemSubagentRouteIdentity(route, currentRoute) || !isConnected(apiKey)) return null;
      const currentPreset = presetId ? settingsService.get("marketplace").installedProviderPresets
        .find((entry) => entry.providerId === presetId) : undefined;
      if (JSON.stringify([currentPreset?.requiresApiKey, currentPreset?.capabilities, currentPreset?.trust]) !== presetPolicy) return null;
      const providerFetch = selectProviderRuntimeFetch({
        vendor,
        baseUrl: route.baseUrl || undefined,
        providerMetadata: preset,
        llmFetch,
        networkFetch,
      });
      return createProvider({
        vendor, apiKey: apiKey ?? "", model: selectedModel ?? llmRouteModel(block, presetId),
        ...(providerFetch ? { fetch: providerFetch } : {}),
        ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}),
        ...(route.wire ? { wire: route.wire } : {}),
        ...(preset ? { providerMetadata: preset } : {}),
        ...(route.vertexProject ? { vertexProject: route.vertexProject } : {}),
        ...(route.vertexLocation ? { vertexLocation: route.vertexLocation } : {}),
      });
    },
  };
}

/** Connected destinations include each installed preset independently of chat selection. */
export async function systemSubagentModelOptions(settingsService: SettingsService): Promise<JudgeModelRef[]> {
  const llm = settingsWithProjectEnvironment(settingsService.get("llm"));
  const presets = settingsService.get("marketplace")?.installedProviderPresets ?? [];
  const catalog = judgeModelCatalogFrom({ ...llm, installedProviderPresets: presets });
  const routes = [
    ...LLM_VENDORS.map((vendor) => systemSubagentRouteIdentity(llm, vendor, presets)),
    ...presets.map((preset) => systemSubagentRouteIdentity(llm, "openai-compatible", presets, preset.providerId)),
  ];
  const targets = routes.flatMap((route) => route ? [{
    route, models: catalog.optionsFor(route.vendor, route),
    plan: createSystemSubagentProviderPlan({ settingsService, networkFetch: fetch }, route.vendor, "", route),
  }] : []);
  const options: JudgeModelRef[] = [];
  for (const { route, models, plan } of targets) {
    if (!plan) continue;
    const apiKey = plan.secretKey ? await settingsService.getSecret(plan.secretKey) : null;
    if (!plan.isConnected(apiKey)) continue;
    for (const model of models) options.push({ vendor: route.vendor, model, route });
  }
  return options;
}

/** Resolve one provider instance without registering a conversation or a visible agent. */
export async function resolveSystemSubagentRoute(
  deps: SystemSubagentRouteDeps,
  model: JudgeModelRef,
): Promise<{ provider: LLMProvider; llmSettings: LLMSettings; model: string }> {
  const plan = createSystemSubagentProviderPlan(deps, model.vendor, model.model, model.route);
  const llmSettings = systemSubagentLlmSettings(deps.settingsService, model);
  const options = await systemSubagentModelOptions(deps.settingsService);
  if (!plan || !options.some((option) => sameSystemSubagentModel(option, model))) {
    throw new Error(`System subagent model is unavailable: ${model.vendor}/${model.model}`);
  }
  const apiKey = plan.secretKey ? await deps.settingsService.getSecret(plan.secretKey) : null;
  const provider = plan.build(apiKey);
  if (!provider) throw new Error(`System subagent model is unavailable: ${model.vendor}/${model.model}`);
  return {
    provider: new FallbackProvider(provider, [], () => ""),
    model: model.model,
    llmSettings,
  };
}

/** Project only the saved destination for context limits and request construction. */
export function systemSubagentLlmSettings(settingsService: SettingsService, model: JudgeModelRef): LLMSettings {
  const llm = settingsService.get("llm");
  const route = model.route;
  const block = getLlmVendorSettings(llm.vendors, model.vendor);
  const presetId = route?.marketplaceProviderPresetId;
  return {
    ...llm,
    activeChatRuntime: { kind: "api" },
    provider: model.vendor,
    marketplaceProviderPresetId: presetId,
    vendors: {
      ...llm.vendors,
      [model.vendor]: {
        ...block,
        model: model.model,
        baseUrl: route?.baseUrl,
        ...(route?.wire ? { wire: route.wire } : {}),
        ...(route?.vertexProject ? { vertexProject: route.vertexProject } : {}),
        ...(route?.vertexLocation ? { vertexLocation: route.vertexLocation } : {}),
        ...(presetId ? { presetModels: { ...block.presetModels, [presetId]: model.model } } : {}),
      },
    },
    retiredProvider: undefined,
  };
}
