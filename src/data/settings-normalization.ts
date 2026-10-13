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
  normalizeLlmVendorModel,
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
  isMarketplaceEligibleLocale,
  normalizeLocaleSetting,
} from "../i18n/index.js";
import { isGitRuntimeMode } from "../shared/git-runtime-mode.js";
import { normalizeAppMode } from "../shared/initial-app-mode.js";
import { isProcessingDisplayLevel } from "../shared/processing-display-level.js";
import { isSidebarTab } from "../shared/sidebar-tab.js";
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
import { isSemver, isTwoMinorReleasesBehind } from "../shared/semver-compare.js";
import { SOURCE_ID_RE } from "../marketplace/sources/official.js";
import { normalizeSkippedPluginUpdateKey } from "../shared/skipped-plugin-updates.js";
import { createLogger } from "../lib/logger.js";
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
  isSubscriptionRuntimeId,
  subscriptionRuntimeDescriptor,
  type ActiveChatRuntime,
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

const log = createLogger("settings");


function normalizeSubscriptionChatRuntimeModel(value: unknown): string | undefined {
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

/**
 * Normalizes the runtime discriminator independently from API-key provider
 * settings. Invalid or removed subscription providers fail closed to the API
 * boundary; the retained API vendor blocks and their secrets are untouched.
 */
/**
 * Upper bound on `llm.pinnedModels`.
 *
 * A pin list is a shortcut, and a shortcut longer than a screen is just the
 * catalogue again. The cap also bounds what a corrupted or hand-edited settings
 * file can push into the chooser.
 */
const MAX_PINNED_MODELS = 24;

/**
 * A stored pin list, made safe to render: strings only, trimmed, de-duplicated,
 * order preserved, capped. Anything else on disk is dropped rather than
 * repaired — a pin is a model id or it is nothing.
 */
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

/**
 * `llm.modelCatalogRefresh`: `"auto"` or `"off"`; anything else reads as
 * absent, and absent is the documented default, on (design
 * `model-capability-catalog.md` §7).
 */
function normalizeModelCatalogRefresh(input: unknown): "auto" | "off" {
  return input === "off" ? "off" : "auto";
}

export function normalizeActiveChatRuntime(input: unknown): ActiveChatRuntime {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { kind: "api" };
  }
  const raw = input as Record<string, unknown>;
  if (raw.kind === "api") return { kind: "api" };
  if (raw.kind !== "subscription" || !isSubscriptionRuntimeId(raw.provider)) {
    return { kind: "api" };
  }
  const model = subscriptionRuntimeDescriptor(raw.provider).supportsModelSelection
    ? normalizeSubscriptionChatRuntimeModel(raw.model)
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

/**
 * Drop a marketplace preset's address back out of the generic
 * openai-compatible block.
 *
 * A preset's endpoint used to be MIRRORED into `vendors["openai-compatible"]`
 * so that consumers reading the active vendor block would reach the preset's
 * address. But the generic custom provider is a different row that persists
 * its OWN endpoint in that same block, so the two were writing over each
 * other: selecting a preset overwrote the generic row's endpoint, saving the
 * generic row's endpoint was reverted by the next normalization, and clearing
 * the preset had to scrub the block — wiping the generic row again.
 *
 * The preset registry (`marketplace.installedProviderPresets`) is now the only
 * owner of a preset's address, so nothing writes one here any more. This
 * removes the value an older install still carries.
 *
 * Narrow on purpose: only the address of the preset that is SELECTED right now
 * can be a mirror, because that is the only one the old code ever wrote here.
 * A generic block holding some other installed preset's URL is a person who
 * typed that address into the custom-provider row themselves — rewriting it
 * would delete a setting they made deliberately.
 */
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rewrite renamed built-in vendor ids in settings exactly as they were read
 * from disk, before any normalization runs.
 *
 * Normalization drops every vendor id this build does not know, so an install
 * still on an old id would otherwise lose its selected provider, its vendor
 * block, its fallback entries, its price corrections, its cached model list and
 * its installed-provider record in a single load. Where the file already holds
 * the new id as well, the new id's value wins and the old one is dropped.
 */
export function withRenamedLlmVendorIds(
  stored: Record<string, any>,
  renames: Readonly<Record<string, LLMVendor>>,
): Record<string, any> {
  const renamedId = (id: unknown): unknown =>
    typeof id === "string" && Object.hasOwn(renames, id) ? renames[id] : id;
  // A row that would duplicate one already stored under the new id is dropped
  // rather than renamed, so the new id's row wins.
  const renameRows = (rows: unknown[], idField: string, modelField: string): unknown[] => {
    const rowKey = (id: unknown, row: Record<string, unknown>) => `${String(id)}\u0000${String(row[modelField])}`;
    const present = new Set(rows.filter(isPlainRecord).map((row) => rowKey(row[idField], row)));
    return rows.flatMap((row) => {
      if (!isPlainRecord(row)) return [row];
      const to = renamedId(row[idField]);
      if (to === row[idField]) return [row];
      return present.has(rowKey(to, row)) ? [] : [{ ...row, [idField]: to }];
    });
  };
  // Model-list cache entries are keyed by vendor + endpoint + credential scope.
  const cacheKeyOf = (entry: Record<string, unknown>, vendor: string): string =>
    llmModelListCacheKey(
      vendor,
      typeof entry.baseUrl === "string" ? entry.baseUrl : undefined,
      typeof entry.credentialScope === "string" ? entry.credentialScope : undefined,
    );
  const next: Record<string, any> = { ...stored };

  if (isPlainRecord(stored.llm)) {
    const llm: Record<string, unknown> = { ...stored.llm };
    if (llm.provider !== undefined) llm.provider = renamedId(llm.provider);
    if (isPlainRecord(llm.vendors)) {
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
    if (isPlainRecord(llm.modelListCache)) {
      const cache: Record<string, unknown> = {};
      const renamed: Array<[string, Record<string, unknown>]> = [];
      for (const [key, entry] of Object.entries(llm.modelListCache)) {
        const to = isPlainRecord(entry) ? renamedId(entry.vendor) : undefined;
        if (isPlainRecord(entry) && typeof to === "string" && to !== entry.vendor) {
          renamed.push([cacheKeyOf(entry, to), { ...entry, vendor: to }]);
        } else {
          cache[key] = entry;
        }
      }
      const present = new Set(
        Object.values(cache)
          .filter(isPlainRecord)
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

  if (isPlainRecord(stored.marketplace) && Array.isArray(stored.marketplace.installedProviderIds)) {
    next.marketplace = {
      ...stored.marketplace,
      installedProviderIds: [...new Set(stored.marketplace.installedProviderIds.map(renamedId))],
    };
  }
  return next;
}

/**
 * Give the selected marketplace preset its own model slot.
 *
 * The `openai-compatible` block's single `model` used to serve every row
 * reached through that vendor — the generic custom provider and every
 * marketplace preset — so whichever row was picked last overwrote the rest.
 * Presets now keep theirs in `presetModels` (see {@link llmRouteModel}).
 *
 * The stored value belongs to the row that is active on this install, which is
 * the only row the user can have chosen it for: with a preset selected it moves
 * to that preset and the generic row starts empty, so its chooser shows the
 * endpoint's own catalogue rather than a model borrowed from a gateway. With no
 * preset selected the value already belongs to the generic row and stays put.
 */
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
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const result: LlmModelListCache = {};
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
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
      // Spread carries explicit `undefined` keys through (e.g. clearing `seed`).
      // Omitting a key from the patch leaves the previous value intact —
      // omit ≠ clear by design.
      const previous = getLlmVendorSettings(vendors, v);
      const merged: LLMVendorSettings = { ...previous, ...incoming };
      // An output limit arriving through a patch is the user's: stamp it, so
      // a later load tells it from the default older builds wrote back.
      if (Object.hasOwn(incoming, "outputTokenLimit")) {
        if (incoming.outputTokenLimit !== undefined) merged.outputTokenLimitSetByUser = true;
        else delete merged.outputTokenLimitSetByUser;
      }
      // `presetModels` is a store keyed by preset, not a single value: a patch
      // naming one preset's model must not delete every other preset's. A key
      // set to an empty string still clears that one, which is what an
      // unconfigured route means — the normalizer drops it.
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
  // Coerce stale on-disk `provider` (e.g. a since-removed vendor name) to the
  // base provider — `vendors[provider]` would otherwise be undefined and
  // crash refreshProvider/stream-collector at first turn. The type guard
  // narrows `partial.provider` so the assignment below is cast-free.
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
  // Clearing or losing a preset leaves the generic openai-compatible block
  // exactly as the user saved it. It used to be reset to defaults here, which
  // was only ever undoing the preset address this code had mirrored in — with
  // the mirror gone, that reset would destroy the generic row's own endpoint.
  vendors[activeProvider] = getLlmVendorSettings(vendors, activeProvider);
  const fallbackChain = (partial.fallbackChain ?? base.fallbackChain)
    .filter((entry) =>
      isLLMVendor(entry.provider) &&
      isLlmProviderEnabled(entry.provider, installedProviderIds) &&
      !(marketplaceProviderPresetId && entry.provider === "openai-compatible")
    )
    .map((entry) => ({
      ...entry,
      model: normalizeLlmVendorModel(entry.provider, entry.model),
    }));
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
    // The retired-provider marker is set by the settings load only. A patch
    // whose provider selection is accepted resolves it. A missing provider or
    // preset that gets coerced to the default does not authorize that default.
    ...(base.retiredProvider && !isProviderSelectionAccepted
      ? { retiredProvider: base.retiredProvider }
      : {}),
    // `llm.hostResolverMap` is deliberately NOT carried forward. The manual
    // Chromium host-resolver map was removed with the private-endpoint access
    // path, so a value still on disk from an older build is inert. Dropping it
    // here means the next settings write erases it rather than leaving a
    // user-authored internal-hostname mapping persisted with nothing acting on
    // it. Do not reintroduce the key.
  };
}

const LLM_VENDOR_SETTING_KEYS = [
  "model",
  "outputTokenLimit",
  // A block whose only content is a preset's model is still configuration:
  // without this the openai-compatible block is pruned the moment chat moves
  // to another vendor, and every preset's model goes with it.
  "presetModels",
  // A route whose only customization is the window its endpoint serves is
  // still configured: pruning it would put that route back on the fallback
  // window the moment chat moved to another vendor.
  "contextWindow",
  // Likewise the catalog entry a self-hosted route was named as.
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
    modelCatalogRefresh: normalizeModelCatalogRefresh(llm.modelCatalogRefresh),
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

/**
 * Rebuild every installed connection through the asset parser.
 *
 * The settings file is an external boundary like any other, and this is the one
 * place a stored connection is re-read. Rebuilding rather than trusting the
 * record is what keeps a credential VALUE from surviving in settings if one
 * were ever written there: the parser only names declaration fields.
 */
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
  // Legacy: read only by the first-boot migration (design §16.3), whose theme
  // packages carry these ids; a compiled id never needed one.
  merged.installedThemeBundleIds = uniqueValidList(
    raw.installedThemeBundleIds,
    (id: unknown): id is string => isThemeId(id) && !isBundleId(id),
  );
  merged.installedMessagingConnections = uniqueValidMessagingConnections(
    raw.installedMessagingConnections,
  );
  merged.installedLanguagePacks = uniqueValidList(
    raw.installedLanguagePacks,
    isMarketplaceEligibleLocale,
  );
  merged.updateCheckEnabled = typeof raw.updateCheckEnabled === "boolean"
    ? raw.updateCheckEnabled
    : DEFAULT_SETTINGS.marketplace.updateCheckEnabled;
  merged.offlineCacheEnabled = typeof raw.offlineCacheEnabled === "boolean"
    ? raw.offlineCacheEnabled
    : DEFAULT_SETTINGS.marketplace.offlineCacheEnabled;
  // Automatic-update switches (design §18.7.2, §18.9): unset means the default decides.
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

/**
 * A switch map keeps each entry whose key normalizes and whose value is
 * `on` or `off`, in a null-prototype map; anything that is not a plain
 * object is unset.
 */
function autoUpdateSwitches(
  input: unknown,
  normalizeKey: (key: string) => string | null,
): Record<string, AutoUpdateSwitch> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const switches = Object.create(null) as Record<string, AutoUpdateSwitch>;
  for (const [rawKey, value] of Object.entries(input)) {
    const key = normalizeKey(rawKey);
    if (key !== null && (value === "on" || value === "off")) switches[key] = value;
  }
  return switches;
}

/**
 * UX Track 3 — coerce on-disk `appearance` block into AppearanceSettings v2.
 *
 * Detects whether the on-disk value is v1 (has `theme`/`chatTheme`/`codeTheme`)
 * or v2 (has `schemaVersion: 2`). v1 inputs are migrated; v2 inputs are
 * validated and returned as-is. Unknown bundleId falls back to DEFAULT_BUNDLE_ID.
 *
 * Settings load must never crash boot over a UI-only field.
 */

/** @internal — v1 legacy axis validation sets, used in migration only. */
const VALID_THEMES_V1: readonly ThemePreference[] = ["system", "light", "dark", "high-contrast"];
const VALID_CHAT_THEMES_V1: readonly ChatThemePreference[] = ["default", "lg", "purple", "orange", "blue"];


/**
 * Migrate a v1 tri-axis appearance object to a v2 bundleId.
 *
 * Migration matrix (12 cases, per spec §3):
 *  dark + default/auto  → tokyo-night
 *  dark + lg            → violet-dark
 *  light + default/auto → forest
 *  light + lg           → violet-light
 *  system + default     → DEFAULT_BUNDLE_ID (renderer may apply followSystem)
 *  system + lg          → violet-dark + followSystem:true (renderer tracks OS scheme)
 *  * + purple|orange|blue → midnight (closest dark accent coercion)
 *  high-contrast + *    → high-contrast (HC always wins)
 *  code override (dark+default+light / light+default+dark) → bundle wins, code override ignored
 *  dark + lg + dark     → violet-dark
 *  invalid/unknown      → DEFAULT_BUNDLE_ID
 *
 * Note: "system" is intentionally NOT resolved via window.matchMedia here.
 * This function runs in the Electron main process where `window` is undefined.
 * System-theme users get DEFAULT_BUNDLE_ID (or violet-dark+followSystem),
 * and the renderer's followSystem toggle can track the OS scheme from there.
 */
function migrateAppearanceV1ToV2(
  legacy: AppearanceSettingsV1,
): AppearanceSettings {
  const theme = VALID_THEMES_V1.includes(legacy.theme) ? legacy.theme : "system";
  const chatTheme = VALID_CHAT_THEMES_V1.includes(legacy.chatTheme) ? legacy.chatTheme : "default";

  // High-contrast always wins — accessibility first.
  if (theme === "high-contrast") {
    return { schemaVersion: 2, bundleId: "high-contrast" };
  }

  // Accent-only chat themes (purple/orange/blue) → midnight (closest dark accent).
  if (chatTheme === "purple" || chatTheme === "orange" || chatTheme === "blue") {
    return { schemaVersion: 2, bundleId: "midnight" };
  }

  // Violet pair (migrated from legacy "lg" chat theme).
  if (chatTheme === "lg") {
    if (theme === "light") return { schemaVersion: 2, bundleId: "violet-light" };
    if (theme === "dark")  return { schemaVersion: 2, bundleId: "violet-dark" };
    // system: default to violet-dark; renderer followSystem will track OS from here.
    return { schemaVersion: 2, bundleId: "violet-dark", followSystem: true };
  }

  // Default chat (no overlay) — preserve explicit legacy shell; "system" → DEFAULT.
  if (theme === "light") return { schemaVersion: 2, bundleId: "forest" };
  if (theme === "dark")  return { schemaVersion: 2, bundleId: "tokyo-night" };

  // system or unknown → DEFAULT_BUNDLE_ID
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

  // v2 path — schemaVersion:2 present.
  if (obj.schemaVersion === 2) {
    // A compiled-in bundle id or an installed theme's package name (design
    // §5.2): whether that theme is still installed is decided where it is
    // applied, since the content ledger is read after settings. Anything else
    // falls through to DEFAULT_BUNDLE_ID via `isThemeId` — the same predicate
    // the patch path in settings-store uses, so the two write paths cannot
    // accept different value sets.
    const bundleId = isThemeId(obj.bundleId) ? obj.bundleId : DEFAULT_BUNDLE_ID;
    const followSystem = typeof obj.followSystem === "boolean" ? obj.followSystem : undefined;
    const result: AppearanceSettings = {
      schemaVersion: 2,
      bundleId,
      // Coerce any stored/legacy value to a supported locale; missing →
      // English default for the global build.
      language: normalizeLocaleSetting(obj.language),
    };
    if (followSystem !== undefined) result.followSystem = followSystem;
    const font = normalizeAppearanceFont(obj.font);
    if (font) result.font = font;
    return result;
  }

  // v1 path — has legacy keys.
  if (typeof obj.theme === "string" || typeof obj.chatTheme === "string" || typeof obj.codeTheme === "string") {
    const legacy: AppearanceSettingsV1 = {
      theme: (typeof obj.theme === "string" && (VALID_THEMES_V1 as readonly string[]).includes(obj.theme)
        ? obj.theme : "system") as ThemePreference,
      chatTheme: (typeof obj.chatTheme === "string" && (VALID_CHAT_THEMES_V1 as readonly string[]).includes(obj.chatTheme)
        ? obj.chatTheme : "default") as ChatThemePreference,
      codeTheme: (typeof obj.codeTheme === "string" ? obj.codeTheme : "auto") as CodeThemePreference,
    };
    // Preserve any stored language across the v1→v2 migration; default English.
    return { ...migrateAppearanceV1ToV2(legacy), language: normalizeLocaleSetting(obj.language) };
  }

  return { ...DEFAULT_SETTINGS.appearance };
}

function normalizeAppearanceFont(input: unknown): AppearanceFontSettings | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
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
    // The top step of the ladder before it moved down one (0.875–1.25). A
    // profile that chose the largest size keeps the largest size rather than
    // landing on the default because its number fell off the ladder.
    out.sizeScale = FONT_SIZE_SCALE_VALUES[FONT_SIZE_SCALE_VALUES.length - 1]!;
  }
  // Empty object → treat as undefined so defaults serialize cleanly.
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * §B1 / Critic F4 mitigation — coerce on-disk `webView` block back to
 * the WebViewSettings shape.
 *
 * If the field is missing entirely (existing installs), apply the default
 * `"in-app"`. If a *partial-but-invalid* value is on disk (e.g. user hand-
 * edited to `"yes"`, `null`, `42`), only that field is replaced with the
 * default — the rest of settings.json is preserved by the normal per-section
 * spread pattern in loadSettings(). A warn log emits once per load so a
 * silent corruption is still observable.
 */
const VALID_WEBVIEW_FLOWS: readonly WebViewPreferredFlow[] = ["in-app", "system-browser"];

/**
 * Single authority for the accepted `webView.preferredFlow` value set. Both
 * write paths use it: `normalizeWebView` (disk load) and the `webView` branch
 * of `SettingsService.patch` (IPC/renderer). Before this predicate existed the
 * patch path did a bare spread with no validation, so an out-of-enum value
 * persisted to settings.json and was only dropped on the *next* load.
 */
export function isWebViewPreferredFlow(value: unknown): value is WebViewPreferredFlow {
  return typeof value === "string" && (VALID_WEBVIEW_FLOWS as readonly string[]).includes(value);
}

export function normalizeWebView(input: unknown): WebViewSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_SETTINGS.webView };
  }
  const obj = input as { preferredFlow?: unknown };
  const raw = obj.preferredFlow;
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

const VALID_CLOSE_BEHAVIORS: readonly SystemCloseBehavior[] = ["hide-to-tray", "quit"];

/** The active-view shape test, asked by both settings paths. */
export function isActiveViewKey(value: unknown): boolean {
  return typeof value === "string" && isInlineViewKey(value);
}

/**
 * The close-behavior shape test. Both settings paths ask it — the disk read
 * here and the patch path in settings-store — so it is written once.
 */
export function isCloseBehavior(value: unknown): value is SystemCloseBehavior {
  return typeof value === "string" && (VALID_CLOSE_BEHAVIORS as readonly string[]).includes(value);
}

const MAX_PROJECT_ROOT_LIST = 200;
/** Labels are display text for a sidebar row, not prose. */
const MAX_PROJECT_LABEL_CHARS = 60;

/**
 * De-duplicates, trims, and caps a list of project roots on both the patch and
 * normalize paths. De-dup keys on `projectRootKey` (the same case/slash-
 * insensitive root-identity SoT the sidebar's pin lookup uses via
 * `projectRootEquals`) rather than raw string equality, so e.g.
 * "C:\\ws\\alpha" and "c:/ws/alpha/" are recognized as the same root instead
 * of accumulating as separate entries.
 *
 * Serves BOTH the pinned and the archived list. Two copies of this would be
 * two chances for pin and archive to disagree about what counts as the same
 * folder — and they must agree, since a row can be both.
 */
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

/**
 * Trims, caps, and drops empty entries from the project label map.
 *
 * A label is what the user typed to rename a folder ROW; it never renames the
 * folder on disk. Keyed by `projectRootKey` so the lookup matches the same
 * root identity the pin and archive lists use.
 */
export function normalizeProjectLabels(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [root, label] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof label !== "string") continue;
    const key = projectRootKey(root);
    if (!key) continue;
    const trimmed = label.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ").trim();
    // An empty label is the ABSENCE of a custom name, so it is dropped rather
    // than stored — otherwise "clear my rename" and "rename to nothing" would
    // be two states that look identical to the row.
    if (!trimmed) continue;
    out[key] = trimmed.slice(0, MAX_PROJECT_LABEL_CHARS);
    count += 1;
    if (count >= MAX_PROJECT_ROOT_LIST) break;
  }
  return out;
}

/**
 * The per-tab-kind vertical-split percent keys, iterated identically in the
 * update-patch and normalize paths so a new split-bearing tab kind is added in
 * exactly one place. `satisfies` pins each entry to a real `SystemSettings`
 * field, so a typo can never silently no-op.
 */
export const SIDE_PANEL_SPLIT_KEYS = [
  "sidePanelSplitFilePercent",
  "sidePanelSplitPreviewPercent",
  "sidePanelSplitSubagentPercent",
  "sidePanelSplitBrowserPercent",
] as const satisfies readonly (keyof SystemSettings)[];

export function normalizeSystem(input: unknown): SystemSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_SETTINGS.system };
  }
  const obj = input as {
    closeBehavior?: unknown;
    appMode?: unknown;
    localApiServer?: unknown;
    hardwareAcceleration?: unknown;
    corpCaEnabled?: unknown;
    corpCaCommonName?: unknown;
    corpCaDebugLog?: unknown;
    launchAtStartup?: unknown;
    launchMinimized?: unknown;
    shutdownCleanupTimeoutMs?: unknown;
    sidePanelWidth?: unknown;
    sidebarWidth?: unknown;
    sidebarActiveTab?: unknown;
    activeView?: unknown;
    settingsTab?: unknown;
    pinnedProjectRoots?: unknown;
    archivedProjectRoots?: unknown;
    projectLabels?: unknown;
  } & Record<(typeof SIDE_PANEL_SPLIT_KEYS)[number], unknown>;
  // Each field is normalized independently: a missing/invalid field falls
  // back to its default while a valid sibling is preserved (mirrors the
  // per-field patch path in `update`).
  const result: SystemSettings = { ...DEFAULT_SETTINGS.system };
  acceptField(result, "closeBehavior", obj.closeBehavior, isCloseBehavior, "system", STORED_FIELD);
  const rawAppMode = obj.appMode;
  const normalizedAppMode = normalizeAppMode(rawAppMode);
  if (normalizedAppMode !== null) {
    result.appMode = normalizedAppMode;
  } else if (rawAppMode !== undefined) {
    log.warn(
      `system.appMode invalid (received ${JSON.stringify(rawAppMode)}), using default %s`,
      DEFAULT_SETTINGS.system.appMode,
    );
  }
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
    // The value is logged by shape, not by content: a hand-edited profile can
    // put anything here, and this line goes to a file the user may share.
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
  for (const key of SIDE_PANEL_SPLIT_KEYS) {
    acceptNormalizedField(
      result, key, obj[key],
      normalizeSidePanelSplitPercent, "system", STORED_FIELD,
    );
  }
  acceptField(result, "sidebarActiveTab", obj.sidebarActiveTab, isSidebarTab, "system", STORED_FIELD);
  acceptField(result, "activeView", obj.activeView, isActiveViewKey, "system", STORED_FIELD);
  const rawSettingsTab = obj.settingsTab;
  if (rawSettingsTab !== undefined) {
    // `normalizeSettingsTab` already folds retired ids and anything
    // unrecognized onto the default, so an invalid value is not a separate arm.
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

/**
 * Coerce on-disk `features` block to FeatureFlags shape.
 * Missing or invalid fields are silently dropped, so each flag falls back to
 * its value in DEFAULT_SETTINGS.features.
 */
/**
 * Coerce on-disk / patch `diagnostics` block to DiagnosticsSettings.
 * Invalid fields fall back to DEFAULT_SETTINGS.diagnostics; logRetentionDays is
 * clamped to [LOG_RETENTION_MIN_DAYS, LOG_RETENTION_MAX_DAYS] via the shared SOT
 * (a non-integer or out-of-range value can never persist).
 */
export function normalizeDiagnostics(input: unknown): DiagnosticsSettings {
  const base = DEFAULT_SETTINGS.diagnostics;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...base };
  }
  const obj = input as Record<string, unknown>;
  const result: DiagnosticsSettings = { ...base };
  if (typeof obj.includeCrashDumps === "boolean") {
    result.includeCrashDumps = obj.includeCrashDumps;
  }
  if (typeof obj.logRetentionDays === "number" && Number.isInteger(obj.logRetentionDays)) {
    result.logRetentionDays = clampLogRetentionDays(obj.logRetentionDays);
  }
  return result;
}

/**
 * Telemetry + crash-reporting block, normalized at both store boundaries.
 *
 * This block was a blind spread on BOTH sides — the disk read and the patch —
 * so a hand-edited profile or a misbehaving caller could put anything in it.
 * That mattered less while nothing but a yes/no consent prompt wrote here; it
 * matters now that the settings surface does, because these fields decide
 * whether the app talks to a remote host at all. A non-boolean `enabled` is
 * not a subtle bug: `enabled !== true` reads it as off, so the value would
 * silently mean the opposite of what a truthy string looks like it means.
 *
 * The two URL-shaped fields are validated for SHAPE only. What makes an
 * endpoint acceptable — https, and a host on the allowlist — is
 * `validateTelemetryEndpoint`'s question, asked where the request is about to
 * be made and against an allowlist this layer cannot see. Re-deciding it here
 * would be a second, weaker copy of a security rule.
 */
export function normalizeTelemetry(input: unknown): TelemetrySettings {
  const result: TelemetrySettings = { ...DEFAULT_SETTINGS.telemetry };
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  const obj = input as {
    enabled?: unknown;
    endpoint?: unknown;
    sentryDsn?: unknown;
    crashReportEndpoint?: unknown;
    crashReportingEnabled?: unknown;
    telemetryPromptAnswered?: unknown;
  };
  acceptField(result, "enabled", obj.enabled, isBooleanValue, "telemetry", STORED_FIELD);
  acceptField(
    result, "crashReportingEnabled", obj.crashReportingEnabled,
    isBooleanValue, "telemetry", STORED_FIELD,
  );
  acceptField(
    result, "telemetryPromptAnswered", obj.telemetryPromptAnswered,
    isBooleanValue, "telemetry", STORED_FIELD,
  );
  for (const key of TELEMETRY_TEXT_KEYS) {
    acceptTelemetryText(result, key, obj[key], STORED_FIELD);
  }
  return result;
}

export const TELEMETRY_TEXT_KEYS = ["endpoint", "sentryDsn", "crashReportEndpoint"] as const;

/**
 * Coerce an on-disk `homeDocs` block to HomeDocsSettings.
 *
 * A hand-edited profile carrying a truthy string where the boolean belongs
 * would otherwise switch on a mode that moves the user's AGENTS.md aside on
 * the next packaged update.
 */
export function normalizeHomeDocs(input: unknown): HomeDocsSettings {
  const result: HomeDocsSettings = { ...DEFAULT_SETTINGS.homeDocs };
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  const obj = input as { keepLatest?: unknown };
  acceptField(result, "keepLatest", obj.keepLatest, isBooleanValue, "homeDocs", STORED_FIELD);
  return result;
}

/**
 * Assign one of the telemetry URL/DSN fields, with an explicit CLEAR arm.
 *
 * These cannot go through {@link acceptNormalizedField}: emptying the field is
 * how a user says "stop sending anywhere", and that has to DELETE the key, not
 * be rejected as an unusable value. Every consumer reads absent as off, so a
 * stored `""` would be a falsy value sitting where anything checking presence
 * reads it as configured.
 *
 * The warning names the field and never the value. An endpoint or a DSN can
 * carry userinfo, a query-string secret, or a fragment token, and this line
 * goes to a log file the user may hand to someone else.
 */
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

/**
 * Chat block, normalized at both store boundaries (disk load and patch).
 *
 * `subAgentMaxRounds` reaches `SubAgentRunner` as a live round budget and a
 * scaled executor wall clock, so a `NaN`, a fraction, or a `0` from a
 * hand-edited settings.json is not an inert bad value — it is a sub-agent that
 * cannot run. There is deliberately NO upper clamp: the budget is uncapped by
 * design (a ceiling above it only shows up as an agent stopped mid-task), and
 * the timer-delay bound that used to be implicit is enforced where the timer
 * is armed instead (`resolveEffectiveCeilingMs`).
 */
export function normalizeChat(input: unknown): ChatSettings {
  const result: ChatSettings = { ...DEFAULT_SETTINGS.chat };
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  const chat = input as Record<string, unknown>;
  if (typeof chat.systemPrompt === "string") result.systemPrompt = chat.systemPrompt;
  if (typeof chat.autoCompact === "boolean") result.autoCompact = chat.autoCompact;
  if (isProcessingDisplayLevel(chat.processingDisplayLevel)) {
    result.processingDisplayLevel = chat.processingDisplayLevel;
  }
  // Missing or malformed values keep the full-view default above.
  if (typeof chat.subAgentMaxRounds === "number" && Number.isFinite(chat.subAgentMaxRounds)) {
    result.subAgentMaxRounds = Math.max(1, Math.floor(chat.subAgentMaxRounds));
  }
  // `0` is the OFF value and must survive, so this floors at 0 rather than 1.
  // A fraction or a negative from a hand-edited settings.json reads as "off"
  // instead of firing a notification on every round.
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
      // Route-control snapshots bind canonical URL bytes. Require serializer
      // identity (including the root slash) instead of silently rewriting a
      // near-canonical value that would later compare unequal on the wire.
      if (url.protocol === "https:" && !url.port && !url.username && !url.password && !url.search && !url.hash && !value.routeControlBaseUrl.includes("?") && !value.routeControlBaseUrl.includes("#") && isIP(url.hostname) === 0 && url.hostname !== "localhost" && !url.hostname.endsWith(".localhost")
        && (url.pathname === "/" || url.pathname === "") && url.toString() === value.routeControlBaseUrl) result.routeControlBaseUrl = value.routeControlBaseUrl;
    } catch { /* invalid remains fail-closed empty */ }
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

/**
 * A stored app version is a complete SemVer version, judged by the same
 * validator the marketplace applies to version ranges. The `"unknown"`
 * sentinel the version resolver can return is not a version and must never be
 * persisted as one.
 */
function isStoredAppVersion(value: unknown): value is string {
  return typeof value === "string" && isSemver(value);
}

/**
 * The identities in the alert blocks — plugin ids, source ids, config keys —
 * are compared exactly by their readers, so they are validated as stored and
 * never rewritten. Trimming `" sample "` into `sample` would let a second
 * record overwrite the first under the same id, or accept a successor id no
 * plugin carries.
 */
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

/**
 * What a malformed kind entry becomes: off, no OS notification, never seen,
 * and consented to the lowest visibility. Dropping the entry instead would
 * let the kind resolve again from its declaration, and a declaration may say
 * `defaultEnabled: true` for a plugin the user already has — a damaged file
 * must not turn a kind on. The lowest visibility makes any declared level an
 * escalation, which leaves the kind off until the user visits it.
 */
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
    // A damaged mark is a damaged entry: read as absent, it would turn a
    // repaired or escalated entry back into one a later retirement may
    // switch on.
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

/**
 * Coerce the on-disk `alerts` block to AlertSettings. The master switch falls
 * back to its default. A kind entry is kept only under a key that follows the
 * `<pluginId>:<kind>` grammar; an entry whose choice fields are out of shape
 * is stored as {@link FAIL_CLOSED_ALERT_KIND_CHOICE} rather than repaired
 * field by field, because a repaired choice would read as one the user made.
 * `absentSinceAppVersion` is kept only as a real version string.
 *
 * With the running `appVersion`, an entry whose plugin has been absent for two
 * minor releases is dropped: a reinstall after that starts from the kind's
 * declaration. A repaired entry is kept whatever its age, because dropping it
 * would let the kind resolve from its declaration again — the outcome the
 * repair exists to prevent. Without a stable release version nothing is dropped.
 */
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

/**
 * An inherit rule names at least one value: with none, a `listed: "disabled"`
 * rule would read as on for every former user whatever they had chosen.
 */
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
  // Sanitising trims keys; a config it had to change was not written by the host.
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

/**
 * Coerce the on-disk `retiredPluginConfigs` block. A record is what a
 * retirement wrote for one plugin, and a successor reads it as the user's
 * former choices, so a record with any field out of shape is dropped whole:
 * a half-repaired record would hand a successor choices nobody made.
 *
 * The load never removes a well-formed record, whatever its age: whether
 * every successor has inherited and the retired package is gone is the
 * alerts service's question, not one the settings file can answer.
 */
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
