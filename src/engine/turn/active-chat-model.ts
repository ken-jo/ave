/**
 * Main's answer to "which model is chat on right now".
 *
 * Main owns the secret store, so it is the one place that can say whether the
 * active API route can authenticate. The settings snapshot carries this value
 * to the renderer, so the composer, Settings and the send path read one
 * answer. The credential rules mirror `buildProvider` (provider.ts), which
 * returns no provider for exactly these routes; `active-chat-model.test.ts`
 * pins the two together.
 */
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

/**
 * Whether the active API route has what it needs to authenticate: a stored
 * credential, or a route that is allowed to run without one.
 *
 * Presence only — this never decrypts the secret, so it is cheap enough to
 * run on every settings broadcast.
 */
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
    // A selected preset that is no longer installed has no route at all.
    if (!preset) return false;
    if (preset.requiresApiKey === false && preset.baseUrl.trim()) return true;
    return settingsService.hasStoredSecret(marketplaceProviderPresetSecretKey(preset.providerId));
  }
  if (vendor === "vertex-ai") {
    // Vertex authenticates through ADC; what it cannot run without is a project.
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
  // A selected subscription runtime or a retired provider is decided before
  // the API route matters, so the secret store is not consulted for them.
  if (llm.activeChatRuntime.kind === "subscription" || llm.retiredProvider) {
    return resolveActiveChatModel(llm, false);
  }
  return resolveActiveChatModel(llm, activeApiRouteConnected(settingsService, env));
}
