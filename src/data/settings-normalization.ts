import { isDocumentOpenMode, type DocumentSettings } from "../shared/document-settings.js";
import {
  normalizeCorpCaCommonName,
} from "../shared/corp-ca-common-name.js";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { isCanonicalA2APublicHttpsOrigin } from "../shared/a2a-public-origin.js";
import {
  normalizeSidePanelSplitPercent,
  normalizeSidePanelWidth,
  normalizeSidebarWidth,
  normalizeFileTreeWidth,
  fileTreeWidthFromLegacySplit,
} from "../shared/side-panel.js";
import {
  sanitizePluginConfig,
  sanitizePluginConfigKey,
  sanitizePluginConfigPluginId,
  type PluginConfigRecord,
} from "../shared/plugin-config.js";
import {
  ALERT_HOST_PLUGIN_ID,
  isAlertKindKey,
  isAlertVisibility,
  type AlertInheritRule,
  type AlertKindChoice,
  type AlertSettings,
  type RetiredPluginConfigRecord,
  type RetirementHostKindMapping,
  type RetirementSuccessorPlugin,
  type RetirementSuccessors,
} from "../shared/alerts-types.js";
import {
  DEFAULT_LLM_VENDOR,
  getLlmVendorSettings,
  isLLMVendor,
  isMarketplaceEligibleLLMVendor,
  type LLMVendor,
  type LLMVendorSettingsMap,
  type LLMVendorSettings,
  type MarketplaceEligibleLLMVendor,
} from "../shared/llm-vendor-defaults.js";
import {
  DEFAULT_BUNDLE_ID,
  isBundleId,
  isThemeId,
} from "../shared/theme-bundles.js";
import {
  FONT_SIZE_SCALE_VALUES,
  type FontSizeScale,
  type AppearanceFontSettings,
  isValidFontFamilyOverride,
} from "../shared/appearance-font.js";
import {
  isOfficialPackageLocale,
  normalizeLocaleSetting,
} from "../i18n/index.js";
import { isGitRuntimeMode } from "../shared/git-runtime-mode.js";
import { isProcessingDisplayLevel } from "../shared/processing-display-level.js";
import { isSidebarTab } from "../shared/sidebar-tab.js";
import { isSidebarState } from "../shared/sidebar-state.js";
import { isInlineViewKey } from "../shared/view-key.js";
import { normalizeSettingsTab } from "../shared/settings-tabs.js";
import {
  MAX_CACHED_LLM_MODEL_ID_LENGTH,
  MAX_CACHED_LLM_MODEL_IDS,
  MAX_LLM_MODEL_LIST_CACHE_ENTRIES,
  llmModelListCacheKey,
  type LlmModelListCache,
  type LlmModelListCacheEntry,
  type LlmModelListEntry,
} from "../shared/llm-model-list.js";
import {
  isMarketplaceProviderPresetId,
  modelDiscoveryPolicyUsesSeededOptions,
  normalizeMarketplaceMessagingConnection,
  normalizeMarketplaceProviderPreset,
  type MarketplaceInstalledMessagingConnection,
  type MarketplaceInstalledProviderPreset,
} from "../shared/marketplace-package-assets.js";
import { projectRootKey } from "../shared/project-identity.js";
import { clampLogRetentionDays } from "../shared/log-retention.js";
import {
  DEFAULT_UPSTREAM_PROXY,
  UPSTREAM_PROXY_MODES,
  type UpstreamProxyMode,
  type UpstreamProxySettings,
} from "../shared/upstream-proxy.js";
import { isSemver, isTwoMinorReleasesBehind } from "../shared/semver-compare.js";
import { SOURCE_ID_RE } from "../marketplace/sources/official.js";
import { normalizeSkippedPluginUpdateKey } from "../shared/skipped-plugin-updates.js";
import { createLogger } from "../lib/logger.js";
import { parseMainLayout, type MainLayoutSnapshot } from "../shared/main-layout.js";
import {
  STORED_FIELD,
  acceptField,
  acceptNormalizedField,
  isBooleanValue,
  type FieldRejection,
} from "./settings-field-accept.js";
import { normalizeShutdownCleanupTimeoutMs } from "../shared/tool-timeout-policy.js";
import { normalizePricingOverrides } from "../shared/pricing-overrides.js";
import {
  MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH,
  DEFAULT_SUBSCRIPTION_REASONING_SPEED,
  isSubscriptionReasoningSpeed,
  isSubscriptionRuntimeId,
  subscriptionRuntimeDescriptor,
  type ActiveChatRuntime,
  type SubscriptionReasoningSpeed,
} from "../shared/subscription-runtime.js";
import { DEFAULT_SETTINGS } from "./settings-defaults.js";
import type {
  A2ARemoteSettings,
  AutoUpdateSwitch,
  AppearanceSettings,
  AppearanceSettingsV1,
  ChatSettings,
  ChatThemePreference,
  CodeThemePreference,
  DiagnosticsSettings,
  FeatureFlags,
  HomeDocsSettings,
  LLMSettings,
  LLMSettingsPatch,
  MarketplaceSettings,
  SystemCloseBehavior,
  SystemSettings,
  TelemetrySettings,
  ThemePreference,
  WebViewPreferredFlow,
  WebViewSettings,
} from "./settings-store.js";
import { isRecord } from "../shared/is-record.js";

const log = createLogger("settings");


function normalizeModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  if (
    model.length === 0 ||
    model.length > MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(model)
  ) {
    return undefined;
  }
  return model;
}

function normalizeCompactionModelRoute(value: unknown): string {
  if (typeof value !== "string" || value.length > 8_192) return "";
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.every((part) => typeof part === "string")
      && ((parts[0] === "api" && parts.length === 4) || (parts[0] === "subscription" && parts.length === 2))
      ? JSON.stringify(parts) : "";
  } catch { return ""; }
}

/** Invalid subscription runtimes fall back to the API boundary without changing vendor secrets. */
/** Cap pin lists to bound corrupted-profile rendering. */
const MAX_PINNED_MODELS = 24;

/** Keep only trimmed unique string ids in original order, within the cap. */
function normalizePinnedModels(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_PINNED_MODELS) break;
  }
  return out;
}

/** Auto or absent enables refresh; off disables it. */
function normalizeModelCatalogRefresh(input: unknown): "auto" | "off" {
  return input === "off" ? "off" : "auto";
}

/** A stored speed outside the menu (hand-edited, or from a newer build) reads as the default, never as an effort. */
function normalizeSubscriptionReasoningSpeed(input: unknown): SubscriptionReasoningSpeed {
  return isSubscriptionReasoningSpeed(input) ? input : DEFAULT_SUBSCRIPTION_REASONING_SPEED;
}

export function normalizeActiveChatRuntime(input: unknown): ActiveChatRuntime {
  if (!isRecord(input)) {
    return { kind: "api" };
  }
  const raw = input;
  if (raw.kind === "api") return { kind: "api" };
  if (raw.kind !== "subscription" || !isSubscriptionRuntimeId(raw.provider)) {
    return { kind: "api" };
  }
  const model = subscriptionRuntimeDescriptor(raw.provider).supportsModelSelection
    ? normalizeModelId(raw.model)
    : undefined;
  return {
    kind: "subscription",
    provider: raw.provider,
    ...(model ? { model } : {}),
  };
}

function isLlmProviderEnabled(
  vendor: LLMVendor,
  installedProviderIds: readonly MarketplaceEligibleLLMVendor[],
): boolean {
  return (
    !isMarketplaceEligibleLLMVendor(vendor) ||
    installedProviderIds.includes(vendor)
  );
}

function isMarketplaceProviderPresetInstalled(
  providerId: string | undefined,
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[] | undefined,
): boolean {
  if (!providerId || !isMarketplaceProviderPresetId(providerId)) return false;
  if (installedProviderPresets === undefined) return true;
  return installedProviderPresets.some((preset) => preset.providerId === providerId);
}

function normalizeActiveMarketplaceProviderPresetId(
  provider: LLMVendor,
  requested: unknown,
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[] | undefined,
): string | undefined {
  if (provider !== "openai-compatible") return undefined;
  if (!isMarketplaceProviderPresetId(requested)) return undefined;
  return isMarketplaceProviderPresetInstalled(requested, installedProviderPresets)
    ? requested
    : undefined;
}

function marketplaceProviderPresetForId(
  providerId: string | undefined,
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[] | undefined,
): MarketplaceInstalledProviderPreset | undefined {
  if (!providerId || !installedProviderPresets) return undefined;
  return installedProviderPresets.find((preset) => preset.providerId === providerId);
}

function marketplaceProviderPresetUsesSeededModelOptions(
  providerId: string,
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[] | undefined,
): boolean {
  const preset = marketplaceProviderPresetForId(providerId, installedProviderPresets);
  return modelDiscoveryPolicyUsesSeededOptions(preset?.modelDiscoveryPolicy);
}

/** Remove only the selected preset's legacy endpoint mirror; other custom-row URLs may be deliberate user settings. */
export function withoutMirroredMarketplaceProviderPresetEndpoint(
  llm: LLMSettings,
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[] | undefined,
): LLMSettings {
  const block = llm.vendors["openai-compatible"];
  const baseUrl = block?.baseUrl?.trim();
  if (!baseUrl) return llm;
  const selected = marketplaceProviderPresetForId(
    llm.marketplaceProviderPresetId ?? "",
    installedProviderPresets,
  );
  if (!selected || selected.baseUrl.trim() !== baseUrl) return llm;
  const vendors: LLMVendorSettingsMap = { ...llm.vendors };
  const { baseUrl: _mirroredBaseUrl, ...rest } = block!;
  vendors["openai-compatible"] = getLlmVendorSettings(
    { ...vendors, "openai-compatible": rest },
    "openai-compatible",
  );
  return { ...llm, vendors };
}

/** Rename provider ids before normalization drops unknown ids; existing new-id values win. */
export function withRenamedLlmVendorIds(
  stored: Record<string, any>,
  renames: Readonly<Record<string, LLMVendor>>,
): Record<string, any> {
  const renamedId = (id: unknown): unknown =>
    typeof id === "string" && Object.hasOwn(renames, id) ? renames[id] : id;
  const renameRows = (rows: unknown[], idField: string, modelField: string): unknown[] => {
    const rowKey = (id: unknown, row: Record<string, unknown>) => `${String(id)}\u0000${String(row[modelField])}`;
    const present = new Set(rows.filter(isRecord).map((row) => rowKey(row[idField], row)));
    return rows.flatMap((row) => {
      if (!isRecord(row)) return [row];
      const to = renamedId(row[idField]);
      if (to === row[idField]) return [row];
      return present.has(rowKey(to, row)) ? [] : [{ ...row, [idField]: to }];
    });
  };
  const cacheKeyOf = (entry: Record<string, unknown>, vendor: string): string =>
    llmModelListCacheKey(
      vendor,
      typeof entry.baseUrl === "string" ? entry.baseUrl : undefined,
      typeof entry.credentialScope === "string" ? entry.credentialScope : undefined,
    );
  const next: Record<string, any> = { ...stored };

  if (isRecord(stored.llm)) {
    const llm: Record<string, unknown> = { ...stored.llm };
    if (llm.provider !== undefined) llm.provider = renamedId(llm.provider);
    if (isRecord(llm.vendors)) {
      const vendors = { ...llm.vendors };
      for (const [from, to] of Object.entries(renames)) {
        if (!Object.hasOwn(vendors, from)) continue;
        if (!Object.hasOwn(vendors, to)) vendors[to] = vendors[from];
        delete vendors[from];
      }
      llm.vendors = vendors;
    }
    if (Array.isArray(llm.fallbackChain)) {
      llm.fallbackChain = renameRows(llm.fallbackChain, "provider", "model");
    }
    if (Array.isArray(llm.pricingOverrides)) {
      llm.pricingOverrides = renameRows(llm.pricingOverrides, "vendor", "model");
    }
    if (isRecord(llm.modelListCache)) {
      const cache: Record<string, unknown> = {};
      const renamed: Array<[string, Record<string, unknown>]> = [];
      for (const [key, entry] of Object.entries(llm.modelListCache)) {
        const to = isRecord(entry) ? renamedId(entry.vendor) : undefined;
        if (isRecord(entry) && typeof to === "string" && to !== entry.vendor) {
          renamed.push([cacheKeyOf(entry, to), { ...entry, vendor: to }]);
        } else {
          cache[key] = entry;
        }
      }
      const present = new Set(
        Object.values(cache)
          .filter(isRecord)
          .filter((entry) => typeof entry.vendor === "string")
          .map((entry) => cacheKeyOf(entry, entry.vendor as string)),
      );
      for (const [key, entry] of renamed) {
        if (!present.has(key)) cache[key] = entry;
      }
      llm.modelListCache = cache;
    }
    next.llm = llm;
  }

  if (isRecord(stored.marketplace) && Array.isArray(stored.marketplace.installedProviderIds)) {
    next.marketplace = {
      ...stored.marketplace,
      installedProviderIds: [...new Set(stored.marketplace.installedProviderIds.map(renamedId))],
    };
  }
  return next;
}

/** Move the active preset's legacy model into its own slot; preserve the generic model when no preset is selected. */
export function withMarketplaceProviderPresetModelSlot(llm: LLMSettings): LLMSettings {
  const presetId = llm.marketplaceProviderPresetId?.trim();
  if (!presetId) return llm;
  const block = llm.vendors["openai-compatible"];
  const model = block?.model?.trim();
  if (!block || !model) return llm;
  if (block.presetModels?.[presetId]) return llm;
  const vendors: LLMVendorSettingsMap = {
    ...llm.vendors,
    "openai-compatible": getLlmVendorSettings(
      {
        ...llm.vendors,
        "openai-compatible": {
          ...block,
          model: "",
          presetModels: { ...block.presetModels, [presetId]: model },
        },
      },
      "openai-compatible",
    ),
  };
  return { ...llm, vendors };
}

function isValidCachedModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const id = value.trim();
  return (
    id.length > 0 &&
    id.length <= MAX_CACHED_LLM_MODEL_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(id)
  );
}

function normalizeCachedModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const models: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isValidCachedModelId(raw)) continue;
    const model = raw.trim();
    if (seen.has(model)) continue;
    seen.add(model);
    models.push(model);
    if (models.length >= MAX_CACHED_LLM_MODEL_IDS) break;
  }
  return models;
}

function normalizeCachedModelListString(
  value: unknown,
  maxLength = MAX_CACHED_LLM_MODEL_ID_LENGTH,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizeCachedModelListNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function normalizeCachedModelListStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const entry = normalizeCachedModelListString(raw, 64);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
    if (entries.length >= 32) break;
  }
  return entries.length > 0 ? entries : undefined;
}

function normalizeCachedModelListPricing(value: unknown): LlmModelListEntry["pricing"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const pricing: NonNullable<LlmModelListEntry["pricing"]> = {};
  for (const key of [
    "prompt",
    "completion",
    "request",
    "image",
    "webSearch",
    "internalReasoning",
    "inputCacheRead",
    "inputCacheWrite",
  ] as const) {
    const entry = normalizeCachedModelListString(record[key], 64);
    if (entry !== undefined) pricing[key] = entry;
  }
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

function normalizeCachedModelListTags(value: unknown): LlmModelListEntry["tags"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tags: NonNullable<LlmModelListEntry["tags"]> = {};
  if (record.free === true) tags.free = true;
  if (record.router === true) tags.router = true;
  if (record.local === true) tags.local = true;
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function normalizeCachedModelListEntries(
  value: unknown,
  models: readonly string[],
): LlmModelListEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set(models);
  const entries: LlmModelListEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Partial<LlmModelListEntry>;
    const id = normalizeCachedModelListString(record.id);
    if (!id || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    const entry: LlmModelListEntry = { id };
    const name = normalizeCachedModelListString(record.name);
    const provider = normalizeCachedModelListString(record.provider);
    const ownedBy = normalizeCachedModelListString(record.ownedBy);
    const description = normalizeCachedModelListString(record.description, 4_096);
    const contextLength = normalizeCachedModelListNumber(record.contextLength);
    const maxOutputTokens = normalizeCachedModelListNumber(record.maxOutputTokens);
    const inputModalities = normalizeCachedModelListStringArray(record.inputModalities);
    const outputModalities = normalizeCachedModelListStringArray(record.outputModalities);
    const supportedParameters = normalizeCachedModelListStringArray(record.supportedParameters);
    const pricing = normalizeCachedModelListPricing(record.pricing);
    const tags = normalizeCachedModelListTags(record.tags);
    if (name && name !== id) entry.name = name;
    if (provider) entry.provider = provider;
    if (ownedBy) entry.ownedBy = ownedBy;
    if (description) entry.description = description;
    if (contextLength !== undefined) entry.contextLength = contextLength;
    if (maxOutputTokens !== undefined) entry.maxOutputTokens = maxOutputTokens;
    if (inputModalities) entry.inputModalities = inputModalities;
    if (outputModalities) entry.outputModalities = outputModalities;
    if (supportedParameters) entry.supportedParameters = supportedParameters;
    if (pricing) entry.pricing = pricing;
    if (tags) entry.tags = tags;
    entries.push(entry);
    if (entries.length >= models.length) break;
  }
  return entries.length > 0 ? entries : undefined;
}

function isValidModelListUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function normalizeLlmModelListCache(
  input: unknown,
  installedProviderIds: readonly MarketplaceEligibleLLMVendor[],
  installedProviderPresets?: readonly MarketplaceInstalledProviderPreset[],
): LlmModelListCache {
  if (!isRecord(input)) return {};
  const result: LlmModelListCache = {};
  for (const value of Object.values(input)) {
    if (!isRecord(value)) continue;
    const entry = value as Partial<LlmModelListCacheEntry>;
    if (!isLLMVendor(entry.vendor)) continue;
    if (!isLlmProviderEnabled(entry.vendor, installedProviderIds)) continue;
    if (!isValidModelListUrl(entry.endpoint)) continue;
    const models = normalizeCachedModelIds(entry.models);
    if (models.length === 0) continue;
    const modelEntries = normalizeCachedModelListEntries(entry.modelEntries, models);
    const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
    let credentialScope = "";
    if (entry.credentialScope !== undefined) {
      if (!isMarketplaceProviderPresetId(entry.credentialScope)) continue;
      const scopedPresetId = entry.credentialScope.trim();
      if (!isMarketplaceProviderPresetInstalled(scopedPresetId, installedProviderPresets)) continue;
      if (marketplaceProviderPresetUsesSeededModelOptions(scopedPresetId, installedProviderPresets)) continue;
      credentialScope = scopedPresetId;
    }
    const fetchedAt = typeof entry.fetchedAt === "string" && entry.fetchedAt.trim()
      ? entry.fetchedAt.trim()
      : new Date(0).toISOString();
    const key = llmModelListCacheKey(entry.vendor, baseUrl, credentialScope);
    result[key] = {
      vendor: entry.vendor,
      ...(baseUrl ? { baseUrl } : {}),
      ...(credentialScope ? { credentialScope } : {}),
      endpoint: entry.endpoint.trim(),
      models,
      ...(modelEntries ? { modelEntries } : {}),
      ...(entry.complete === true && models.length < MAX_CACHED_LLM_MODEL_IDS ? { complete: true } : {}),
      fetchedAt,
    };
    if (Object.keys(result).length >= MAX_LLM_MODEL_LIST_CACHE_ENTRIES) break;
  }
  return result;
}

export function mergeLlmPatch(
  base: LLMSettings,
  partial: LLMSettingsPatch,
  installedProviderIds: readonly MarketplaceEligibleLLMVendor[],
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[] | undefined,
): LLMSettings {
  const activeChatRuntime = "activeChatRuntime" in partial
    ? normalizeActiveChatRuntime(partial.activeChatRuntime)
    : normalizeActiveChatRuntime(base.activeChatRuntime);
  const vendors: LLMVendorSettingsMap = { ...base.vendors };
  if (partial.vendors) {
    for (const [vendorId, incoming] of Object.entries(partial.vendors)) {
      if (!isLLMVendor(vendorId) || !incoming) continue;
      const v = vendorId;
      if (!isLlmProviderEnabled(v, installedProviderIds)) continue;
      // Explicit undefined clears a setting; an omitted patch key preserves it.
      const previous = getLlmVendorSettings(vendors, v);
      const merged: LLMVendorSettings = { ...previous, ...incoming };
      // Mark patched output limits as user choices so load can distinguish old persisted defaults.
      if (Object.hasOwn(incoming, "outputTokenLimit")) {
        if (incoming.outputTokenLimit !== undefined) merged.outputTokenLimitSetByUser = true;
        else delete merged.outputTokenLimitSetByUser;
      }
      // Merge preset model entries independently; empty strings clear only their own route.
      if (incoming.presetModels) {
        merged.presetModels = { ...previous.presetModels, ...incoming.presetModels };
      }
      if (incoming.imageInput) {
        merged.imageInput = { ...previous.imageInput, ...incoming.imageInput };
      }
      vendors[v] = getLlmVendorSettings({ ...vendors, [v]: merged }, v);
    }
  }
  for (const vendorId of Object.keys(vendors)) {
    if (!isLLMVendor(vendorId)) continue;
    vendors[vendorId] = getLlmVendorSettings(vendors, vendorId);
  }
  // Coerce unknown stored providers before runtime consumers index vendor blocks.
  const requestedProvider: LLMVendor = isLLMVendor(partial.provider)
    ? partial.provider
    : base.provider;
  const provider = isLlmProviderEnabled(requestedProvider, installedProviderIds)
    ? requestedProvider
    : DEFAULT_LLM_VENDOR;
  const requestedMarketplaceProviderPresetId =
    partial.marketplaceProviderPresetId !== undefined
      ? partial.marketplaceProviderPresetId
      : base.marketplaceProviderPresetId;
  let activeProvider = provider;
  const marketplaceProviderPresetId = normalizeActiveMarketplaceProviderPresetId(
    provider,
    requestedMarketplaceProviderPresetId,
    installedProviderPresets,
  );
  const removedActiveMarketplaceProviderPreset =
    provider === "openai-compatible" &&
    isMarketplaceProviderPresetId(requestedMarketplaceProviderPresetId) &&
    !marketplaceProviderPresetId;
  if (removedActiveMarketplaceProviderPreset) {
    activeProvider = DEFAULT_LLM_VENDOR;
  }
  // Clearing a preset must preserve the user's generic provider settings.
  vendors[activeProvider] = getLlmVendorSettings(vendors, activeProvider);
  const fallbackChain = (partial.fallbackChain ?? base.fallbackChain)
    .filter((entry) =>
      isLLMVendor(entry.provider) &&
      isLlmProviderEnabled(entry.provider, installedProviderIds) &&
      !(marketplaceProviderPresetId && entry.provider === "openai-compatible")
    );
  const isProviderSelectionAccepted = isLLMVendor(partial.provider)
    && activeProvider === partial.provider
    && !removedActiveMarketplaceProviderPreset
    && (activeProvider !== "openai-compatible"
      || !requestedMarketplaceProviderPresetId
      || (typeof requestedMarketplaceProviderPresetId === "string"
        && marketplaceProviderPresetId === requestedMarketplaceProviderPresetId.trim()));
  return {
    activeChatRuntime,
    provider: activeProvider,
    ...(marketplaceProviderPresetId ? { marketplaceProviderPresetId } : {}),
    vendors,
    streamSmoothing: partial.streamSmoothing ?? base.streamSmoothing,
    compactionModel: normalizeModelId("compactionModel" in partial ? partial.compactionModel : base.compactionModel) ?? "",
    compactionModelRoute: normalizeCompactionModelRoute("compactionModelRoute" in partial ? partial.compactionModelRoute : base.compactionModelRoute),
    fallbackChain,
    modelListCache: normalizeLlmModelListCache(
      "modelListCache" in partial ? partial.modelListCache : base.modelListCache,
      installedProviderIds,
      installedProviderPresets,
    ),
    pricingOverrides: normalizePricingOverrides(
      "pricingOverrides" in partial ? partial.pricingOverrides : base.pricingOverrides,
    ),
    pinnedModels: normalizePinnedModels(
      "pinnedModels" in partial ? partial.pinnedModels : base.pinnedModels,
    ),
    modelCatalogRefresh: normalizeModelCatalogRefresh(partial.modelCatalogRefresh ?? base.modelCatalogRefresh),
    subscriptionReasoningSpeed: normalizeSubscriptionReasoningSpeed(
      partial.subscriptionReasoningSpeed ?? base.subscriptionReasoningSpeed,
    ),
    // Only accepted explicit selection clears retired-provider state; coercion does not authorize the default.
    ...(base.retiredProvider && !isProviderSelectionAccepted
      ? { retiredProvider: base.retiredProvider }
      : {}),
    // Drop the inert legacy host-resolver map rather than retaining internal hostnames.
  };
}

const LLM_VENDOR_SETTING_KEYS = [
  "model",
  "outputTokenLimit",
  // Preset models alone still make the generic block configured; do not prune them when switching vendors.
  "presetModels",
  // A custom endpoint window alone still counts as route configuration.
  "contextWindow",
  "catalogModel",
  "imageInput",
  "baseUrl",
  "vertexProject",
  "vertexLocation",
  "enableThinking",
  "thinkingBudgetTokens",
] as const satisfies readonly (keyof LLMVendorSettings)[];

function hasCustomLlmVendorSettings(
  vendor: LLMVendor,
  block: LLMVendorSettings,
): boolean {
  const normalized = getLlmVendorSettings({ [vendor]: block }, vendor);
  const defaults = getLlmVendorSettings(undefined, vendor);
  return LLM_VENDOR_SETTING_KEYS.some(
    (key) => normalized[key] !== defaults[key],
  );
}

function addUniqueMarketplaceProvider(
  values: MarketplaceEligibleLLMVendor[],
  vendor: LLMVendor,
): MarketplaceEligibleLLMVendor[] {
  if (!isMarketplaceEligibleLLMVendor(vendor)) return values;
  return values.includes(vendor) ? values : [...values, vendor];
}

export function pruneLazyLlmVendorBlocks(
  llm: LLMSettings,
  installedProviderIds: MarketplaceEligibleLLMVendor[],
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[],
  options: { inferInstalledFromCustom: boolean },
): {
  llm: LLMSettings;
  installedProviderIds: MarketplaceEligibleLLMVendor[];
} {
  const vendors: LLMVendorSettingsMap = {};
  let inferredInstalledProviderIds = installedProviderIds;

  if (options.inferInstalledFromCustom) {
    for (const [vendorId, block] of Object.entries(llm.vendors)) {
      if (!isLLMVendor(vendorId) || !block) continue;
      if (!isMarketplaceEligibleLLMVendor(vendorId)) continue;
      const normalized = getLlmVendorSettings({ [vendorId]: block }, vendorId);
      if (!hasCustomLlmVendorSettings(vendorId, normalized)) continue;
      inferredInstalledProviderIds = addUniqueMarketplaceProvider(
        inferredInstalledProviderIds,
        vendorId,
      );
    }
  }

  let provider = isLlmProviderEnabled(llm.provider, inferredInstalledProviderIds)
    ? llm.provider
    : DEFAULT_LLM_VENDOR;
  const marketplaceProviderPresetId = normalizeActiveMarketplaceProviderPresetId(
    provider,
    llm.marketplaceProviderPresetId,
    installedProviderPresets,
  );
  const removedActiveMarketplaceProviderPreset =
    provider === "openai-compatible" &&
    isMarketplaceProviderPresetId(llm.marketplaceProviderPresetId) &&
    !marketplaceProviderPresetId;
  if (removedActiveMarketplaceProviderPreset) {
    provider = DEFAULT_LLM_VENDOR;
  }
  const fallbackChain = llm.fallbackChain.filter((entry) =>
    isLlmProviderEnabled(entry.provider, inferredInstalledProviderIds) &&
    !(marketplaceProviderPresetId && entry.provider === "openai-compatible")
  );
  const required = new Set<LLMVendor>(inferredInstalledProviderIds);
  required.add(provider);
  for (const entry of fallbackChain) {
    required.add(entry.provider);
  }

  for (const [vendorId, block] of Object.entries(llm.vendors)) {
    if (!isLLMVendor(vendorId) || !block) continue;
    const vendor = vendorId;
    const normalized = getLlmVendorSettings({ [vendor]: block }, vendor);
    const marketplaceOnly = isMarketplaceEligibleLLMVendor(vendor);
    const custom = hasCustomLlmVendorSettings(vendor, normalized);
    const keep =
      !marketplaceOnly ||
      required.has(vendor) ||
      (options.inferInstalledFromCustom && custom);
    if (!keep) continue;
    vendors[vendor] = normalized;
    if (options.inferInstalledFromCustom && marketplaceOnly && custom) {
      inferredInstalledProviderIds = addUniqueMarketplaceProvider(
        inferredInstalledProviderIds,
        vendor,
      );
    }
  }

  vendors[provider] = getLlmVendorSettings(vendors, provider);
  const prunedLlm: LLMSettings = {
    ...llm,
    activeChatRuntime: normalizeActiveChatRuntime(llm.activeChatRuntime),
    provider,
    fallbackChain,
    vendors,
    modelListCache: normalizeLlmModelListCache(
      llm.modelListCache,
      inferredInstalledProviderIds,
      installedProviderPresets,
    ),
    pricingOverrides: normalizePricingOverrides(llm.pricingOverrides),
    pinnedModels: normalizePinnedModels(llm.pinnedModels),
    compactionModel: normalizeModelId(llm.compactionModel) ?? "",
    compactionModelRoute: normalizeCompactionModelRoute(llm.compactionModelRoute),
    modelCatalogRefresh: normalizeModelCatalogRefresh(llm.modelCatalogRefresh),
    subscriptionReasoningSpeed: normalizeSubscriptionReasoningSpeed(llm.subscriptionReasoningSpeed),
  };
  if (marketplaceProviderPresetId) {
    prunedLlm.marketplaceProviderPresetId = marketplaceProviderPresetId;
  } else {
    delete prunedLlm.marketplaceProviderPresetId;
  }

  return {
    llm: prunedLlm,
    installedProviderIds: inferredInstalledProviderIds,
  };
}

function uniqueValidList<T extends string>(
  values: unknown,
  isValid: (value: unknown) => value is T,
): T[] {
  if (!Array.isArray(values)) return [];
  const result: T[] = [];
  for (const value of values) {
    if (!isValid(value)) continue;
    if (result.includes(value)) continue;
    result.push(value);
  }
  return result;
}

function uniqueValidProviderPresets(value: unknown): MarketplaceInstalledProviderPreset[] {
  if (!Array.isArray(value)) return [];
  const result: MarketplaceInstalledProviderPreset[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const preset = normalizeMarketplaceProviderPreset(raw);
    if (!preset || seen.has(preset.providerId)) continue;
    seen.add(preset.providerId);
    result.push(preset);
  }
  return result;
}

/** Reparse stored connections at the disk boundary so credential values cannot survive in settings. */
function uniqueValidMessagingConnections(
  value: unknown,
): MarketplaceInstalledMessagingConnection[] {
  if (!Array.isArray(value)) return [];
  const result: MarketplaceInstalledMessagingConnection[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const connection = normalizeMarketplaceMessagingConnection(raw);
    if (!connection || seen.has(connection.connectionId)) continue;
    seen.add(connection.connectionId);
    result.push(connection);
  }
  return result;
}

function removedMarketplaceProviderPresetIds(
  previous: readonly MarketplaceInstalledProviderPreset[],
  next: readonly MarketplaceInstalledProviderPreset[],
): string[] {
  const nextIds = new Set(next.map((preset) => preset.providerId));
  return previous
    .map((preset) => preset.providerId)
    .filter((providerId) => !nextIds.has(providerId));
}

export function marketplaceProviderPresetSecretInvalidationIds(
  previous: readonly MarketplaceInstalledProviderPreset[],
  next: readonly MarketplaceInstalledProviderPreset[],
): string[] {
  const ids = new Set(removedMarketplaceProviderPresetIds(previous, next));
  const previousById = new Map(previous.map((preset) => [preset.providerId, preset]));
  for (const nextPreset of next) {
    const previousPreset = previousById.get(nextPreset.providerId);
    if (!previousPreset) continue;
    if (
      previousPreset.baseUrl !== nextPreset.baseUrl ||
      previousPreset.requiresApiKey !== nextPreset.requiresApiKey
    ) {
      ids.add(nextPreset.providerId);
    }
  }
  return [...ids];
}

export function preserveInstalledProviderPresetMetadata(
  previous: readonly MarketplaceInstalledProviderPreset[],
  next: readonly MarketplaceInstalledProviderPreset[],
): MarketplaceInstalledProviderPreset[] {
  const previousById = new Map(previous.map((preset) => [preset.providerId, preset]));
  return next.map((preset) => previousById.get(preset.providerId) ?? preset);
}

export function normalizeMarketplace(input: unknown): MarketplaceSettings {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Partial<MarketplaceSettings>)
    : {};
  const merged: MarketplaceSettings = {
    ...DEFAULT_SETTINGS.marketplace,
    ...raw,
  };
  const gitMode = raw.git && typeof raw.git === "object" ? (raw.git as { mode?: unknown }).mode : undefined;
  if (isGitRuntimeMode(gitMode)) merged.git = { mode: gitMode };
  else delete merged.git;
  merged.installedProviderIds = uniqueValidList(
    raw.installedProviderIds,
    isMarketplaceEligibleLLMVendor,
  );
  merged.installedProviderPresets = uniqueValidProviderPresets(
    raw.installedProviderPresets,
  );
  merged.installedThemeBundleIds = uniqueValidList(
    raw.installedThemeBundleIds,
    (id: unknown): id is string => isThemeId(id) && !isBundleId(id),
  );
  merged.installedMessagingConnections = uniqueValidMessagingConnections(
    raw.installedMessagingConnections,
  );
  merged.installedLanguagePacks = uniqueValidList(
    raw.installedLanguagePacks,
    isOfficialPackageLocale,
  );
  merged.updateCheckEnabled = typeof raw.updateCheckEnabled === "boolean"
    ? raw.updateCheckEnabled
    : DEFAULT_SETTINGS.marketplace.updateCheckEnabled;
  merged.offlineCacheEnabled = typeof raw.offlineCacheEnabled === "boolean"
    ? raw.offlineCacheEnabled
    : DEFAULT_SETTINGS.marketplace.offlineCacheEnabled;
  // Unset update switches defer to defaults.
  if (typeof raw.autoUpdate === "boolean") merged.autoUpdate = raw.autoUpdate;
  else delete merged.autoUpdate;
  const sources = autoUpdateSwitches(raw.autoUpdateSources, (id) => (SOURCE_ID_RE.test(id) ? id : null));
  if (sources) merged.autoUpdateSources = sources;
  else delete merged.autoUpdateSources;
  const packages = autoUpdateSwitches(raw.autoUpdatePackages, normalizeSkippedPluginUpdateKey);
  if (packages) merged.autoUpdatePackages = packages;
  else delete merged.autoUpdatePackages;
  return merged;
}

/** Accept only plain objects with normalized keys and on/off values in a null-prototype map. */
function autoUpdateSwitches(
  input: unknown,
  normalizeKey: (key: string) => string | null,
): Record<string, AutoUpdateSwitch> | undefined {
  if (!isRecord(input)) return undefined;
  const switches = Object.create(null) as Record<string, AutoUpdateSwitch>;
  for (const [rawKey, value] of Object.entries(input)) {
    const key = normalizeKey(rawKey);
    if (key !== null && (value === "on" || value === "off")) switches[key] = value;
  }
  return switches;
}

/** Migrate old appearance shapes and validate current ones; malformed UI settings must never crash boot. */

const VALID_THEMES_V1: readonly ThemePreference[] = ["system", "light", "dark", "high-contrast"];
const VALID_CHAT_THEMES_V1: readonly ChatThemePreference[] = ["default", "lg", "purple", "orange", "blue"];


/** Do not resolve system appearance in main, where window is unavailable; the renderer tracks the OS scheme. */
function migrateAppearanceV1ToV2(
  legacy: AppearanceSettingsV1,
): AppearanceSettings {
  const theme = VALID_THEMES_V1.includes(legacy.theme) ? legacy.theme : "system";
  const chatTheme = VALID_CHAT_THEMES_V1.includes(legacy.chatTheme) ? legacy.chatTheme : "default";

  if (theme === "high-contrast") {
    return { schemaVersion: 2, bundleId: "high-contrast" };
  }

  if (chatTheme === "purple" || chatTheme === "orange" || chatTheme === "blue") {
    return { schemaVersion: 2, bundleId: "midnight" };
  }

  if (chatTheme === "lg") {
    if (theme === "light") return { schemaVersion: 2, bundleId: "violet-light" };
    if (theme === "dark")  return { schemaVersion: 2, bundleId: "violet-dark" };
    return { schemaVersion: 2, bundleId: "violet-dark", followSystem: true };
  }

  if (theme === "light") return { schemaVersion: 2, bundleId: "forest" };
  if (theme === "dark")  return { schemaVersion: 2, bundleId: "tokyo-night" };

  return { schemaVersion: 2, bundleId: DEFAULT_BUNDLE_ID };
}

export const appearanceMigration = Object.freeze({
  migrateV1ToV2: migrateAppearanceV1ToV2,
});

export function normalizeAppearance(input: unknown): AppearanceSettings {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_SETTINGS.appearance };
  }
  const obj = input as Record<string, unknown>;

  if (obj.schemaVersion === 2) {
    // Accept compiled or package theme ids here; installation is checked later after the ledger loads.
    const bundleId = isThemeId(obj.bundleId) ? obj.bundleId : DEFAULT_BUNDLE_ID;
    const followSystem = typeof obj.followSystem === "boolean" ? obj.followSystem : undefined;
    const result: AppearanceSettings = {
      schemaVersion: 2,
      bundleId,
      language: normalizeLocaleSetting(obj.language),
    };
    if (followSystem !== undefined) result.followSystem = followSystem;
    const font = normalizeAppearanceFont(obj.font);
    if (font) result.font = font;
    return result;
  }

  if (typeof obj.theme === "string" || typeof obj.chatTheme === "string" || typeof obj.codeTheme === "string") {
    const legacy: AppearanceSettingsV1 = {
      theme: (typeof obj.theme === "string" && (VALID_THEMES_V1 as readonly string[]).includes(obj.theme)
        ? obj.theme : "system") as ThemePreference,
      chatTheme: (typeof obj.chatTheme === "string" && (VALID_CHAT_THEMES_V1 as readonly string[]).includes(obj.chatTheme)
        ? obj.chatTheme : "default") as ChatThemePreference,
      codeTheme: (typeof obj.codeTheme === "string" ? obj.codeTheme : "auto") as CodeThemePreference,
    };
    return { ...migrateAppearanceV1ToV2(legacy), language: normalizeLocaleSetting(obj.language) };
  }

  return { ...DEFAULT_SETTINGS.appearance };
}

function normalizeAppearanceFont(input: unknown): AppearanceFontSettings | undefined {
  if (!isRecord(input)) return undefined;
  const o = input;
  const out: AppearanceFontSettings = {};
  if (typeof o.family === "string") {
    if (o.family === "system") {
      out.family = "system";
    } else if (isValidFontFamilyOverride(o.family)) {
      out.family = o.family;
    }
  }
  if (typeof o.sizeScale === "number"
    && (FONT_SIZE_SCALE_VALUES as readonly number[]).includes(o.sizeScale)) {
    out.sizeScale = o.sizeScale as FontSizeScale;
  } else if (o.sizeScale === 1.25) {
    // Map the former largest font step to the new largest step rather than silently resetting it.
    out.sizeScale = FONT_SIZE_SCALE_VALUES[FONT_SIZE_SCALE_VALUES.length - 1]!;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Replace only malformed web-view fields with defaults and warn once per load. */
const VALID_WEBVIEW_FLOWS: readonly WebViewPreferredFlow[] = ["in-app", "system-browser"];

/** Share the accepted flow predicate across disk load and patches so invalid values cannot persist. */
export function isWebViewPreferredFlow(value: unknown): value is WebViewPreferredFlow {
  return typeof value === "string" && (VALID_WEBVIEW_FLOWS as readonly string[]).includes(value);
}

export function normalizeWebView(input: unknown): WebViewSettings {
  if (!isRecord(input)) {
    return { ...DEFAULT_SETTINGS.webView };
  }
  const raw = input.preferredFlow;
  if (isWebViewPreferredFlow(raw)) {
    return { preferredFlow: raw };
  }
  if (raw !== undefined) {
    log.warn(
      `webView.preferredFlow invalid (received ${JSON.stringify(raw)}), using default %s`,
      DEFAULT_SETTINGS.webView.preferredFlow,
    );
  }
  return { ...DEFAULT_SETTINGS.webView };
}

export function normalizeDocuments(input: unknown): DocumentSettings {
  const result = { ...DEFAULT_SETTINGS.documents };
  if (isRecord(input)) {
    acceptField(result, "openMode", input.openMode, isDocumentOpenMode, "documents", STORED_FIELD);
  }
  return result;
}

const VALID_CLOSE_BEHAVIORS: readonly SystemCloseBehavior[] = ["hide-to-tray", "quit"];

/** Report the violated layout rule and use the default for refused layouts. */
export function normalizeMainLayout(value: unknown): MainLayoutSnapshot | undefined {
  if (value === undefined) return undefined;
  const parsed = parseMainLayout(value);
  if (parsed.ok) return parsed.layout;
  // Log reasons only; page addresses may contain tokens.
  log.warn(`system.mainLayout refused: ${parsed.reason}; the window starts in the default layout`);
  return undefined;
}

export function isActiveViewKey(value: unknown): boolean {
  return typeof value === "string" && isInlineViewKey(value);
}

export function isCloseBehavior(value: unknown): value is SystemCloseBehavior {
  return typeof value === "string" && (VALID_CLOSE_BEHAVIORS as readonly string[]).includes(value);
}

const MAX_PROJECT_ROOT_LIST = 200;
const MAX_PROJECT_LABEL_CHARS = 60;

/** Deduplicate pinned and archived roots by the shared case/slash-insensitive identity. */
export function normalizeProjectRootList(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const key = projectRootKey(trimmed) ?? trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_PROJECT_ROOT_LIST) break;
  }
  return out;
}

/** Labels rename rows only, never disk folders; key them by shared project-root identity. */
export function normalizeProjectLabels(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [root, label] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof label !== "string") continue;
    const key = projectRootKey(root);
    if (!key) continue;
    const trimmed = label.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ").trim();
    // Drop empty labels so clearing a rename has one representation.
    if (!trimmed) continue;
    out[key] = trimmed.slice(0, MAX_PROJECT_LABEL_CHARS);
    count += 1;
    if (count >= MAX_PROJECT_ROOT_LIST) break;
  }
  return out;
}

export const SIDE_PANEL_SPLIT_KEYS = [
  "sidePanelSplitPreviewPercent",
  "sidePanelSplitSubagentPercent",
] as const satisfies readonly (keyof SystemSettings)[];

export function normalizeSystem(input: unknown): SystemSettings {
  if (!isRecord(input)) {
    return { ...DEFAULT_SETTINGS.system };
  }
  const obj = input;
  const result: SystemSettings = { ...DEFAULT_SETTINGS.system };
  acceptField(result, "turnCompletionSoundEnabled", obj.turnCompletionSoundEnabled, isBooleanValue, "system", STORED_FIELD);
  acceptField(result, "closeBehavior", obj.closeBehavior, isCloseBehavior, "system", STORED_FIELD);
  const rawLocalApi = obj.localApiServer;
  acceptField(result, "localApiServer", rawLocalApi, isBooleanValue, "system", STORED_FIELD);
  const rawHardwareAcceleration = obj.hardwareAcceleration;
  acceptField(result, "hardwareAcceleration", rawHardwareAcceleration, isBooleanValue, "system", STORED_FIELD);
  const rawCorpCaEnabled = obj.corpCaEnabled;
  acceptField(result, "corpCaEnabled", rawCorpCaEnabled, isBooleanValue, "system", STORED_FIELD);
  const rawCorpCaDebugLog = obj.corpCaDebugLog;
  acceptField(result, "corpCaDebugLog", rawCorpCaDebugLog, isBooleanValue, "system", STORED_FIELD);
  const rawCorpCaCommonName = obj.corpCaCommonName;
  const normalizedCorpCaCommonName = normalizeCorpCaCommonName(rawCorpCaCommonName);
  if (normalizedCorpCaCommonName !== null) {
    result.corpCaCommonName = normalizedCorpCaCommonName;
  } else if (rawCorpCaCommonName !== undefined && rawCorpCaCommonName !== "") {
    // Log rejected shapes rather than contents because shared logs may contain arbitrary profile data.
    log.warn(
      "system.corpCaCommonName invalid (not a usable certificate name), using default",
    );
  }
  const rawLaunchAtStartup = obj.launchAtStartup;
  acceptField(result, "launchAtStartup", rawLaunchAtStartup, isBooleanValue, "system", STORED_FIELD);
  const rawLaunchMinimized = obj.launchMinimized;
  acceptField(result, "launchMinimized", rawLaunchMinimized, isBooleanValue, "system", STORED_FIELD);
  acceptNormalizedField(
    result,
    "shutdownCleanupTimeoutMs",
    obj.shutdownCleanupTimeoutMs,
    normalizeShutdownCleanupTimeoutMs,
    "system",
    STORED_FIELD,
  );
  acceptNormalizedField(
    result, "sidePanelWidth", obj.sidePanelWidth,
    normalizeSidePanelWidth, "system", STORED_FIELD,
  );
  acceptNormalizedField(
    result, "sidebarWidth", obj.sidebarWidth,
    normalizeSidebarWidth, "system", STORED_FIELD,
  );
  result.sidePanelFileTreeWidth = normalizeFileTreeWidth(obj.sidePanelFileTreeWidth)
    ?? fileTreeWidthFromLegacySplit(obj.sidePanelSplitFilePercent);
  for (const key of SIDE_PANEL_SPLIT_KEYS) {
    acceptNormalizedField(
      result, key, obj[key],
      normalizeSidePanelSplitPercent, "system", STORED_FIELD,
    );
  }
  acceptField(result, "sidebarActiveTab", obj.sidebarActiveTab, isSidebarTab, "system", STORED_FIELD);
  acceptField(result, "sidebarState", obj.sidebarState, isSidebarState, "system", STORED_FIELD);
  acceptField(result, "activeView", obj.activeView, isActiveViewKey, "system", STORED_FIELD);
  // Avoid acceptNormalizedField here: its rejected-value warning could expose page tokens.
  const storedLayout = normalizeMainLayout(obj.mainLayout);
  if (storedLayout) result.mainLayout = storedLayout;
  const rawSettingsTab = obj.settingsTab;
  if (rawSettingsTab !== undefined) {
    result.settingsTab = normalizeSettingsTab(rawSettingsTab);
  }
  const rawArchivedProjectRoots = obj.archivedProjectRoots;
  if (Array.isArray(rawArchivedProjectRoots)) {
    result.archivedProjectRoots = normalizeProjectRootList(rawArchivedProjectRoots);
  } else if (rawArchivedProjectRoots !== undefined) {
    log.warn(
      `system.archivedProjectRoots invalid (received ${JSON.stringify(rawArchivedProjectRoots)}), using default %s`,
      DEFAULT_SETTINGS.system.archivedProjectRoots,
    );
  }
  if (obj.projectLabels !== undefined) {
    result.projectLabels = normalizeProjectLabels(obj.projectLabels);
  }
  const rawPinnedProjectRoots = obj.pinnedProjectRoots;
  if (Array.isArray(rawPinnedProjectRoots)) {
    result.pinnedProjectRoots = normalizeProjectRootList(rawPinnedProjectRoots);
  } else if (rawPinnedProjectRoots !== undefined) {
    log.warn(
      `system.pinnedProjectRoots invalid (received ${JSON.stringify(rawPinnedProjectRoots)}), using default %s`,
      DEFAULT_SETTINGS.system.pinnedProjectRoots,
    );
  }
  return result;
}

/** Use shared diagnostics bounds so invalid retention values cannot persist. */
export function normalizeDiagnostics(input: unknown): DiagnosticsSettings {
  const base = DEFAULT_SETTINGS.diagnostics;
  if (!isRecord(input)) {
    return { ...base };
  }
  const obj = input;
  const result: DiagnosticsSettings = { ...base };
  if (typeof obj.includeCrashDumps === "boolean") {
    result.includeCrashDumps = obj.includeCrashDumps;
  }
  if (typeof obj.logRetentionDays === "number" && Number.isInteger(obj.logRetentionDays)) {
    result.logRetentionDays = clampLogRetentionDays(obj.logRetentionDays);
  }
  return result;
}

/** Strip proxy URL userinfo because credentials belong only in the secret store; drop oversized values rather than truncate them. */
export function normalizeUpstreamProxy(input: unknown): UpstreamProxySettings {
  const result: UpstreamProxySettings = { ...DEFAULT_UPSTREAM_PROXY };
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  const obj = input as Record<string, unknown>;
  if (typeof obj.mode === "string" && (UPSTREAM_PROXY_MODES as readonly string[]).includes(obj.mode)) {
    result.mode = obj.mode as UpstreamProxyMode;
  }
  if (typeof obj.manualUrl === "string" && obj.manualUrl.length <= 2048) {
    result.manualUrl = obj.manualUrl.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^/?#@]*@/iu, "$1");
  }
  if (typeof obj.bypass === "string" && obj.bypass.length <= 8192) result.bypass = obj.bypass;
  if (typeof obj.resolvesNames === "boolean") result.resolvesNames = obj.resolvesNames;
  return result;
}

/** Validate telemetry shapes at both boundaries; request-time endpoint policy owns HTTPS and host authorization. */
export function normalizeTelemetry(input: unknown): TelemetrySettings {
  const result: TelemetrySettings = { ...DEFAULT_SETTINGS.telemetry };
  if (!isRecord(input)) return result;
  for (const key of ["enabled", "crashReportingEnabled", "telemetryPromptAnswered"] as const) {
    acceptField(result, key, input[key], isBooleanValue, "telemetry", STORED_FIELD);
  }
  for (const key of TELEMETRY_TEXT_KEYS) {
    acceptTelemetryText(result, key, input[key], STORED_FIELD);
  }
  return result;
}

export const TELEMETRY_TEXT_KEYS = ["endpoint", "sentryDsn", "crashReportEndpoint"] as const;

/** Require real booleans; truthy strings must not enable document moves on update. */
export function normalizeHomeDocs(input: unknown): HomeDocsSettings {
  const result: HomeDocsSettings = { ...DEFAULT_SETTINGS.homeDocs };
  if (!isRecord(input)) return result;
  acceptField(result, "keepLatest", input.keepLatest, isBooleanValue, "homeDocs", STORED_FIELD);
  return result;
}

/** Clearing an endpoint deletes its key; warn by field name only because URLs and DSNs may contain secrets. */
export function acceptTelemetryText(
  target: TelemetrySettings,
  key: (typeof TELEMETRY_TEXT_KEYS)[number],
  raw: unknown,
  rejection: FieldRejection,
): void {
  if (raw === undefined) return;
  if (typeof raw !== "string") {
    log.warn(
      `telemetry.${key} ${rejection.reason} (not a string), ${rejection.verb} the stored value`,
    );
    return;
  }
  const trimmed = raw.trim();
  if (trimmed === "") delete target[key];
  else target[key] = trimmed;
}

/** Round budgets require valid positive integers and have no upper clamp; enforce timer bounds where timers are armed. */
export function normalizeChat(input: unknown): ChatSettings {
  const result: ChatSettings = { ...DEFAULT_SETTINGS.chat };
  if (!isRecord(input)) return result;
  const chat = input;
  if (typeof chat.systemPrompt === "string") result.systemPrompt = chat.systemPrompt;
  if (typeof chat.autoCompact === "boolean") result.autoCompact = chat.autoCompact;
  if (isProcessingDisplayLevel(chat.processingDisplayLevel)) {
    result.processingDisplayLevel = chat.processingDisplayLevel;
  }
  if (typeof chat.subAgentMaxRounds === "number" && Number.isFinite(chat.subAgentMaxRounds)) {
    result.subAgentMaxRounds = Math.max(1, Math.floor(chat.subAgentMaxRounds));
  }
  // Preserve zero as off; invalid fractional or negative notification intervals also read as off.
  if (
    typeof chat.progressNudgeRounds === "number"
    && Number.isFinite(chat.progressNudgeRounds)
  ) {
    result.progressNudgeRounds = Math.max(0, Math.floor(chat.progressNudgeRounds));
  }
  return result;
}

export function normalizeA2ARemote(input: unknown): A2ARemoteSettings {
  const result = structuredClone(DEFAULT_SETTINGS.a2aRemote);
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  const value = input as Record<string, unknown>;
  if (typeof value.routeControlBaseUrl === "string") {
    try {
      const url = new URL(value.routeControlBaseUrl);
      // Require canonical serialized URLs, including root slashes, so route-control byte bindings stay valid.
      if (url.protocol === "https:" && !url.port && !url.username && !url.password && !url.search && !url.hash && !value.routeControlBaseUrl.includes("?") && !value.routeControlBaseUrl.includes("#") && isIP(url.hostname) === 0 && url.hostname !== "localhost" && !url.hostname.endsWith(".localhost")
        && (url.pathname === "/" || url.pathname === "") && url.toString() === value.routeControlBaseUrl) result.routeControlBaseUrl = value.routeControlBaseUrl;
    } catch { /* Invalid input must remain fail-closed empty. */ }
  }
  if (isCanonicalA2APublicHttpsOrigin(value.receiverPublicOrigin)) {
    result.receiverPublicOrigin = value.receiverPublicOrigin;
  }
  for (const field of ["outboundCallerGenerationId", "receiverCallerGenerationId"] as const) {
    if (typeof value[field] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/.test(value[field])) result[field] = value[field];
  }
  if (typeof value.extensionSpecDigestSha256 === "string" && /^[a-f0-9]{64}$/.test(value.extensionSpecDigestSha256)) result.extensionSpecDigestSha256 = value.extensionSpecDigestSha256;
  if (Number.isSafeInteger(value.receiverMaxKeysPerGeneration) && (value.receiverMaxKeysPerGeneration as number) >= 1 && (value.receiverMaxKeysPerGeneration as number) <= 10_000) result.receiverMaxKeysPerGeneration = value.receiverMaxKeysPerGeneration as number;
  if (Array.isArray(value.targets) && value.targets.length <= 64) {
    const unique = new Set<string>();
    result.targets = value.targets.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const candidate = entry as Record<string, unknown>;
      if (!Number.isSafeInteger(candidate.targetAgentId) || (candidate.targetAgentId as number) <= 0
        || typeof candidate.label !== "string" || candidate.label.trim() !== candidate.label || candidate.label.length < 1 || candidate.label.length > 80
        || typeof candidate.interfaceUrl !== "string"
        || typeof candidate.agentCardDigestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.agentCardDigestSha256)
        || !Number.isSafeInteger(candidate.trustKeyId) || (candidate.trustKeyId as number) <= 0
        || !Number.isSafeInteger(candidate.credentialBindingId) || (candidate.credentialBindingId as number) <= 0
        || !Number.isSafeInteger(candidate.routePolicyVersion) || (candidate.routePolicyVersion as number) <= 0
        || typeof candidate.routePolicyDigestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.routePolicyDigestSha256)
        || !Number.isSafeInteger(candidate.intendedCredentialRevisionId) || (candidate.intendedCredentialRevisionId as number) <= 0) return [];
      const replayCredentialRevisionIds = candidate.replayCredentialRevisionIds === undefined
        ? []
        : Array.isArray(candidate.replayCredentialRevisionIds)
          && candidate.replayCredentialRevisionIds.length <= 16
          && candidate.replayCredentialRevisionIds.every((revision) => Number.isSafeInteger(revision) && (revision as number) > 0)
          && new Set(candidate.replayCredentialRevisionIds).size === candidate.replayCredentialRevisionIds.length
          && !candidate.replayCredentialRevisionIds.includes(candidate.intendedCredentialRevisionId)
          ? candidate.replayCredentialRevisionIds as number[]
          : null;
      if (!replayCredentialRevisionIds) return [];
      try {
        const url = new URL(candidate.interfaceUrl);
        if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || isIP(url.hostname) !== 0 || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.toString() !== candidate.interfaceUrl) return [];
      } catch { return []; }
      const key = String(candidate.targetAgentId);
      if (unique.has(key)) return [];
      unique.add(key);
      return [{
        targetAgentId: candidate.targetAgentId as number,
        label: candidate.label,
        interfaceUrl: candidate.interfaceUrl,
        agentCardDigestSha256: candidate.agentCardDigestSha256,
        trustKeyId: candidate.trustKeyId as number,
        credentialBindingId: candidate.credentialBindingId as number,
        routePolicyVersion: candidate.routePolicyVersion as number,
        routePolicyDigestSha256: candidate.routePolicyDigestSha256,
        intendedCredentialRevisionId: candidate.intendedCredentialRevisionId as number,
        replayCredentialRevisionIds: [...replayCredentialRevisionIds],
      }];
    });
  }
  return result;
}

export function normalizeFeatureFlags(input: unknown): FeatureFlags {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const obj = input as Record<string, unknown>;
  const result: FeatureFlags = {};
  if (typeof obj.idlePreferenceRefresh === "boolean") {
    result.idlePreferenceRefresh = obj.idlePreferenceRefresh;
  }
  if (typeof obj.idleMemoryConsolidation === "boolean") {
    result.idleMemoryConsolidation = obj.idleMemoryConsolidation;
  }
  if (obj.memoryCaptureMode === "off" || obj.memoryCaptureMode === "review" || obj.memoryCaptureMode === "auto") {
    result.memoryCaptureMode = obj.memoryCaptureMode;
  }
  if (typeof obj.subAgentAutonomousWake === "boolean") {
    result.subAgentAutonomousWake = obj.subAgentAutonomousWake;
  }
  if (typeof obj.subAgentParentAdjudication === "boolean") {
    result.subAgentParentAdjudication = obj.subAgentParentAdjudication;
  }
  if (typeof obj.a2aLoopbackServer === "boolean") {
    result.a2aLoopbackServer = obj.a2aLoopbackServer;
  }
  if (typeof obj.a2aRemoteRouting === "boolean") result.a2aRemoteRouting = obj.a2aRemoteRouting;
  if (typeof obj.a2aRemoteReceiver === "boolean") result.a2aRemoteReceiver = obj.a2aRemoteReceiver;
  if (typeof obj.onboardingCompleted === "boolean") {
    result.onboardingCompleted = obj.onboardingCompleted;
  }
  if (typeof obj.hostClassifiesRisk === "boolean") {
    result.hostClassifiesRisk = obj.hostClassifiesRisk;
  }
  if (typeof obj.osToolSandbox === "boolean") {
    result.osToolSandbox = obj.osToolSandbox;
  }
  if (typeof obj.pluginWorkerConfinement === "boolean") {
    result.pluginWorkerConfinement = obj.pluginWorkerConfinement;
  }
  if (typeof obj.shellEgressAsk === "boolean") {
    result.shellEgressAsk = obj.shellEgressAsk;
  }
  return result;
}

export function sanitizeStoredPluginConfigs(input: unknown): Record<string, PluginConfigRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const out: Record<string, PluginConfigRecord> = {};
  for (const [pluginId, config] of Object.entries(input)) {
    try {
      const safePluginId = sanitizePluginConfigPluginId(pluginId);
      out[safePluginId] = sanitizePluginConfig(config);
    } catch (err) {
      log.warn(
        "dropping invalid stored plugin config: %s",
        (err as Error).message,
      );
    }
  }
  return out;
}

/** Persist only complete SemVer versions, never the resolver's unknown sentinel. */
function isStoredAppVersion(value: unknown): value is string {
  return typeof value === "string" && isSemver(value);
}

/** Validate alert identities exactly as stored; trimming can merge records or invent unmatched successor ids. */
function isStoredPluginId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return sanitizePluginConfigPluginId(value) === value;
  } catch {
    return false;
  }
}

function isStoredConfigKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return sanitizePluginConfigKey(value) === value;
  } catch {
    return false;
  }
}

/** Malformed choices must remain stored as disabled, unseen, lowest-visibility entries; dropping them could reenable declared defaults. */
const FAIL_CLOSED_ALERT_KIND_CHOICE: Readonly<AlertKindChoice> = Object.freeze({
  enabled: false,
  osNotification: false,
  visibility: "silent",
  seenByUser: false,
  repaired: true,
});

function normalizeAlertKindChoice(key: string, input: unknown): AlertKindChoice {
  const obj = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  let choice: AlertKindChoice;
  if (
    typeof obj.enabled === "boolean"
    && typeof obj.osNotification === "boolean"
    && typeof obj.seenByUser === "boolean"
    && isAlertVisibility(obj.visibility)
    // Damaged marks remain fail-closed; treating them as absent could reenable repaired entries.
    && (!Object.hasOwn(obj, "repaired") || obj.repaired === true)
    && (!Object.hasOwn(obj, "escalated") || obj.escalated === true)
  ) {
    choice = {
      enabled: obj.enabled,
      osNotification: obj.osNotification,
      visibility: obj.visibility,
      seenByUser: obj.seenByUser,
    };
    if (obj.repaired === true) choice.repaired = true;
    if (obj.escalated === true) choice.escalated = true;
  } else {
    log.warn("alert kind entry %s is malformed, storing it off and unseen", key);
    choice = { ...FAIL_CLOSED_ALERT_KIND_CHOICE };
  }
  if (isStoredAppVersion(obj.absentSinceAppVersion)) {
    choice.absentSinceAppVersion = obj.absentSinceAppVersion;
  }
  return choice;
}

/** Validate kind keys and fail closed on malformed choices. Prune absent entries only after two stable minor releases; repaired entries never age out. */
export function normalizeAlertSettings(input: unknown, appVersion?: string): AlertSettings {
  const base = DEFAULT_SETTINGS.alerts;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { osNotificationsEnabled: base.osNotificationsEnabled, kinds: {} };
  }
  const obj = input as Record<string, unknown>;
  const result: AlertSettings = {
    osNotificationsEnabled: typeof obj.osNotificationsEnabled === "boolean"
      ? obj.osNotificationsEnabled
      : base.osNotificationsEnabled,
    kinds: {},
  };
  const rawKinds = obj.kinds;
  if (rawKinds && typeof rawKinds === "object" && !Array.isArray(rawKinds)) {
    for (const [key, value] of Object.entries(rawKinds as Record<string, unknown>)) {
      if (!isAlertKindKey(key)) {
        log.warn("dropping alert kind entry with an invalid key: %s", key);
        continue;
      }
      const choice = normalizeAlertKindChoice(key, value);
      if (
        appVersion !== undefined
        && choice.repaired !== true
        && choice.absentSinceAppVersion !== undefined
        && isTwoMinorReleasesBehind(choice.absentSinceAppVersion, appVersion)
      ) {
        log.info("dropping alert kind entry %s: its plugin was removed at %s", key, choice.absentSinceAppVersion);
        continue;
      }
      result.kinds[key] = choice;
    }
  }
  return result;
}

/** Inheritance rules need at least one value; an empty disabled list would enable all former users. */
function normalizeAlertInheritRule(input: unknown): AlertInheritRule | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  if (
    !isStoredConfigKey(obj.key)
    || (obj.listed !== "enabled" && obj.listed !== "disabled")
    || !Array.isArray(obj.values)
    || obj.values.length === 0
    || !obj.values.every((v) => typeof v === "string" && v.length > 0)
  ) {
    return undefined;
  }
  const rule: AlertInheritRule = { key: obj.key, listed: obj.listed, values: [...obj.values] };
  if (obj.masterKey !== undefined) {
    if (!isStoredConfigKey(obj.masterKey)) return undefined;
    rule.masterKey = obj.masterKey;
  }
  return rule;
}

function normalizeRetirementSuccessors(input: unknown): RetirementSuccessors | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.plugins) || !Array.isArray(obj.hostKinds)) return undefined;
  const plugins: RetirementSuccessorPlugin[] = [];
  for (const entry of obj.plugins) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const e = entry as Record<string, unknown>;
    if (!isStoredPluginId(e.pluginId)) return undefined;
    const pluginId = e.pluginId;
    if (e.anySource !== undefined && e.anySource !== true) return undefined;
    plugins.push(e.anySource === true ? { pluginId, anySource: true } : { pluginId });
  }
  const hostKinds: RetirementHostKindMapping[] = [];
  for (const entry of obj.hostKinds) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const e = entry as Record<string, unknown>;
    if (!isAlertKindKey(e.kind) || !e.kind.startsWith(`${ALERT_HOST_PLUGIN_ID}:`)) return undefined;
    const enabled = normalizeAlertInheritRule(e.enabled);
    if (!enabled) return undefined;
    const mapping: RetirementHostKindMapping = { kind: e.kind, enabled };
    if (e.osNotification !== undefined) {
      const osNotification = normalizeAlertInheritRule(e.osNotification);
      if (!osNotification) return undefined;
      mapping.osNotification = osNotification;
    }
    hostKinds.push(mapping);
  }
  return { plugins, hostKinds };
}

export function normalizeRetiredPluginConfigRecord(input: unknown): RetiredPluginConfigRecord | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  if (typeof obj.enabled !== "boolean") return undefined;
  if (obj.sourceId !== null && (typeof obj.sourceId !== "string" || !SOURCE_ID_RE.test(obj.sourceId))) {
    return undefined;
  }
  if (!isStoredAppVersion(obj.retiredAtAppVersion)) return undefined;
  const successors = normalizeRetirementSuccessors(obj.successors);
  if (!successors) return undefined;
  if (!Array.isArray(obj.consumedBy) || !obj.consumedBy.every(isStoredPluginId)) return undefined;
  const consumedBy: string[] = [...obj.consumedBy];
  let config: PluginConfigRecord;
  try {
    config = sanitizePluginConfig(obj.config);
  } catch {
    return undefined;
  }
  // Sanitization that changes config keys means the record was not host-written.
  if (!isDeepStrictEqual(config, obj.config)) return undefined;
  return {
    config,
    enabled: obj.enabled,
    sourceId: obj.sourceId,
    retiredAtAppVersion: obj.retiredAtAppVersion,
    successors,
    consumedBy,
  };
}

/** Drop malformed retirement records whole; only the alerts service may remove valid records after inheritance. */
export function normalizeRetiredPluginConfigs(input: unknown): Record<string, RetiredPluginConfigRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const out: Record<string, RetiredPluginConfigRecord> = {};
  for (const [pluginId, value] of Object.entries(input)) {
    if (!isStoredPluginId(pluginId)) {
      log.warn("dropping retired plugin config with an invalid id: %s", JSON.stringify(pluginId));
      continue;
    }
    const record = normalizeRetiredPluginConfigRecord(value);
    if (!record) {
      log.warn("dropping malformed retired plugin config: %s", pluginId);
      continue;
    }
    out[pluginId] = record;
  }
  return out;
}
