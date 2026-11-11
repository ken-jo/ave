import type { LLMSettings } from "../data/settings-store.js";
import { CUSTOM_PROVIDER_WIRES, customProviderWire, type CustomProviderWire } from "./custom-provider.js";
import { hasControlChars } from "./display-safe-text.js";
import { getLlmVendorSettings, isLLMVendor, llmVendorSecretKey, LLM_VENDOR_DEFAULTS, type LLMVendor } from "./llm-vendor-defaults.js";
import { marketplaceProviderPresetSecretKey } from "./marketplace-package-assets.js";
import type { LlmRouteProviderPreset } from "./context-budget.js";

export interface SystemSubagentRouteIdentity {
  vendor: LLMVendor;
  baseUrl: string;
  credentialScope: string;
  marketplaceProviderPresetId?: string;
  vertexProject?: string;
  vertexLocation?: string;
  wire?: CustomProviderWire;
}

export interface SystemSubagentModelRef {
  vendor: LLMVendor;
  model: string;
  /** Absent only on legacy selections whose destination cannot be established. */
  route?: SystemSubagentRouteIdentity;
}

function isBoundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && !hasControlChars(value);
}

export function isSystemSubagentModelRef(value: unknown): value is SystemSubagentModelRef {
  if (!value || typeof value !== "object" || !("vendor" in value) || !("model" in value)) return false;
  if (!isLLMVendor(value.vendor) || !isBoundedText(value.model, 1_024) || !value.model.trim()) return false;
  if (!("route" in value) || value.route === undefined) return true;
  const route = value.route;
  if (!route || typeof route !== "object" || !("vendor" in route) || route.vendor !== value.vendor
    || !("baseUrl" in route) || !isBoundedText(route.baseUrl, 8_192)
    || !("credentialScope" in route) || !isBoundedText(route.credentialScope, 256)) return false;
  for (const field of ["marketplaceProviderPresetId", "vertexProject", "vertexLocation"] as const) {
    const fields = route as Record<string, unknown>;
    if (field in fields && !isBoundedText(fields[field], 1_024)) return false;
  }
  return !("wire" in route) || (CUSTOM_PROVIDER_WIRES as readonly unknown[]).includes(route.wire);
}

/** Derive one destination explicitly, independent of the active chat provider. */
export function systemSubagentRouteIdentity(
  llm: LLMSettings,
  vendor: LLMVendor,
  presets?: readonly LlmRouteProviderPreset[],
  marketplaceProviderPresetId?: string,
): SystemSubagentRouteIdentity | null {
  const block = getLlmVendorSettings(llm.vendors, vendor);
  const preset = marketplaceProviderPresetId
    ? presets?.find((entry) => entry.providerId === marketplaceProviderPresetId) : undefined;
  if (marketplaceProviderPresetId && (vendor !== "openai-compatible" || !preset)) return null;
  return {
    vendor,
    baseUrl: vendor === "vertex-ai" ? "" : (preset?.baseUrl ?? block.baseUrl ?? LLM_VENDOR_DEFAULTS[vendor].baseUrl ?? "").trim(),
    credentialScope: preset ? marketplaceProviderPresetSecretKey(preset.providerId) : llmVendorSecretKey(vendor),
    ...(preset ? { marketplaceProviderPresetId: preset.providerId } : {}),
    ...(vendor === "vertex-ai" ? {
      vertexProject: block.vertexProject?.trim() ?? "",
      vertexLocation: block.vertexLocation?.trim() || "us-central1",
    } : {}),
    ...(vendor === "openai-compatible" && !preset ? { wire: customProviderWire(block.wire) } : {}),
  };
}

export function systemSubagentModelKey(ref: SystemSubagentModelRef): string {
  return JSON.stringify([ref.vendor, ref.model, ref.route ? routeIdentityFields(ref.route) : null]);
}

function routeIdentityFields(route: SystemSubagentRouteIdentity): Array<string | null> {
  return [route.vendor, route.baseUrl, route.credentialScope, route.marketplaceProviderPresetId ?? null,
    route.vertexProject ?? null, route.vertexLocation ?? null, route.wire ?? null];
}

export function sameSystemSubagentRouteIdentity(a: SystemSubagentRouteIdentity, b: SystemSubagentRouteIdentity): boolean {
  return JSON.stringify(routeIdentityFields(a)) === JSON.stringify(routeIdentityFields(b));
}

export function sameSystemSubagentModel(a: SystemSubagentModelRef, b: SystemSubagentModelRef): boolean {
  return systemSubagentModelKey(a) === systemSubagentModelKey(b);
}
