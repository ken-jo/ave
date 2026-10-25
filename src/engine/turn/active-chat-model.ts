// Main owns credential presence; renderer and send path must share its active-model answer.
import type { SettingsService } from "../../data/settings-store.js";
import {
  resolveActiveChatModel,
  type ActiveChatModel,
} from "../../shared/active-chat-model.js";
import {
  canUseLlmVendorWithoutApiKey,
  getLlmVendorSettings,
} from "../../shared/llm-vendor-defaults.js";
import { marketplaceProviderPresetSecretKey } from "../../shared/marketplace-package-assets.js";
import { secretKeyFor } from "../llm/provider-factory.js";

export type ActiveChatModelSettingsReader = Pick<SettingsService, "get" | "hasStoredSecret">;

/** Check credential presence without decrypting on settings broadcasts. */
function activeApiRouteConnected(
  settingsService: ActiveChatModelSettingsReader,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const llm = settingsService.get("llm");
  const vendor = llm.provider;
  const block = getLlmVendorSettings(llm.vendors, vendor);
  const presetId = vendor === "openai-compatible" ? llm.marketplaceProviderPresetId : undefined;
  if (presetId) {
    const preset = (settingsService.get("marketplace").installedProviderPresets ?? [])
      .find((entry) => entry.providerId === presetId);
    // A removed preset has no active route.
    if (!preset) return false;
    if (preset.requiresApiKey === false && preset.baseUrl.trim()) return true;
    return settingsService.hasStoredSecret(marketplaceProviderPresetSecretKey(preset.providerId));
  }
  if (vendor === "vertex-ai") {
    // Native project authentication requires a project rather than an API key.
    return Boolean(block.vertexProject || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT);
  }
  if (canUseLlmVendorWithoutApiKey(vendor, block)) return true;
  return settingsService.hasStoredSecret(secretKeyFor(vendor));
}

export function resolveMainActiveChatModel(
  settingsService: ActiveChatModelSettingsReader,
  env: NodeJS.ProcessEnv = process.env,
): ActiveChatModel {
  const llm = settingsService.get("llm");
  // Subscription and retired-provider decisions must not consult the API secret store.
  if (llm.activeChatRuntime.kind === "subscription" || llm.retiredProvider) {
    return resolveActiveChatModel(llm, false);
  }
  return resolveActiveChatModel(llm, activeApiRouteConnected(settingsService, env));
}
