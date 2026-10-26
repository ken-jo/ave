import {
  LLM_VENDORS, OPENAI_COMPATIBLE_VENDOR_PRESETS, isOpenAICompatiblePresetVendor,
} from "./llm-vendor-defaults.js";
import { isLoopbackUrlHostname } from "./loopback-url.js";
import {
  marketplaceProviderPresetSecretId, type MarketplaceInstalledProviderPreset,
} from "./marketplace-package-assets.js";
import { SUBSCRIPTION_RUNTIME_DESCRIPTORS, isSubscriptionRuntimeId } from "./subscription-runtime.js";

export const PROVIDER_PICKER_GROUPS = ["subscription", "api", "local", "custom"] as const;
export type ProviderPickerGroup = (typeof PROVIDER_PICKER_GROUPS)[number];

export function providerPickerGroup(id: string): ProviderPickerGroup {
  if (isSubscriptionRuntimeId(id)) return "subscription";
  if (id === "openai-compatible") return "custom";
  if (isOpenAICompatiblePresetVendor(id)) {
    const url = new URL(OPENAI_COMPATIBLE_VENDOR_PRESETS[id].baseUrl);
    if (isLoopbackUrlHostname(url.hostname)) return "local";
  }
  return "api";
}

export function providerPickerEntries(presets: readonly MarketplaceInstalledProviderPreset[]): {
  id: string;
  group: ProviderPickerGroup;
}[] {
  const ids = [
    ...SUBSCRIPTION_RUNTIME_DESCRIPTORS.map(({ id }) => id),
    ...LLM_VENDORS.filter((id) => id !== "openai-compatible"),
    ...presets.map(({ providerId }) => marketplaceProviderPresetSecretId(providerId)),
    "openai-compatible",
  ];
  return ids.map((id) => ({ id, group: providerPickerGroup(id) }));
}
