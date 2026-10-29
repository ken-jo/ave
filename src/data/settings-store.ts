import { isDocumentOpenMode, type DocumentSettings } from "../shared/document-settings.js";
import {
  DEFAULT_CORP_CA_COMMON_NAME,
  normalizeCorpCaCommonName,
} from "../shared/corp-ca-common-name.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { withInstalledStateMutation } from "../main/installed-state-mutation.js";
import {
  normalizeSidePanelSplitPercent,
  normalizeSidePanelWidth,
  normalizeSidebarWidth,
  normalizeFileTreeWidth,
} from "../shared/side-panel.js";
import { normalizeShutdownCleanupTimeoutMs } from "../shared/tool-timeout-policy.js";
import type { PricingOverride } from "../shared/pricing-overrides.js";
import { LlmProviderSettingsError } from "../shared/custom-provider.js";
import { compactionModelRouteKey } from "../shared/compaction-model.js";
import {
  sanitizePluginConfig,
  sanitizePluginConfigKey,
  sanitizePluginConfigPluginId,
  type PluginConfigRecord,
} from "../shared/plugin-config.js";
import type { AlertSettings, RetiredPluginConfigRecord } from "../shared/alerts-types.js";
import type { UpstreamProxySettings } from "../shared/upstream-proxy.js";
import {
  activeLlmRouteModel,
  getLlmVendorSettings,
  isRetiredLLMVendor,
  LLM_VENDORS,
  RETIRED_LLM_VENDOR_IDS,
  type LLMVendor,
  type LlmRouteRetirement,
  type RetiredLLMVendor,
  type RetiredLlmModel,
  type LLMVendorSettingsMap,
  type LLMVendorSettings,
  type MarketplaceEligibleLLMVendor,
} from "../shared/llm-vendor-defaults.js";
import { resolveRouteModelRetirement } from "../shared/context-budget.js";
import type { GitRuntimeMode } from "../shared/git-runtime-mode.js";
import { isThemeId } from "../shared/theme-bundles.js";
import {
  FONT_SIZE_SCALE_VALUES,
  type FontSizeScale,
  type AppearanceFontSettings,
  isValidFontFamilyOverride,
} from "../shared/appearance-font.js";
import {
  DEFAULT_LOCALE,
  isDefaultVisibleLocale,
  normalizeLocale,
  normalizeLocaleSetting,
  type Locale,
} from "../i18n/locale.js";
import { isSidebarTab, type SidebarTab } from "../shared/sidebar-tab.js";
import { isSidebarState, type SidebarState } from "../shared/sidebar-state.js";
import { type InlineViewKey } from "../shared/view-key.js";
import { normalizeSettingsTab, type SettingsTab } from "../shared/settings-tabs.js";
import {
  type LlmModelListCache,
} from "../shared/llm-model-list.js";
import type { ActiveChatRuntime, SubscriptionReasoningSpeed } from "../shared/subscription-runtime.js";
import {
  isProcessingDisplayLevel,
  type ProcessingDisplayLevel,
} from "../shared/processing-display-level.js";
import {
  isMarketplaceProviderPresetId,
  marketplaceProviderPresetSecretKey,
  normalizeMarketplaceProviderPreset,
  type MarketplaceInstalledMessagingConnection,
  type MarketplaceInstalledProviderPreset,
} from "../shared/marketplace-package-assets.js";
import {
  normalizeAccelerator,
  normalizeShortcuts,
  type ShortcutSettings,
  type ShortcutSettingsPatch,
} from "../shared/shortcuts.js";
import { createLogger } from "../lib/logger.js";
import type { MainLayoutSnapshot } from "../shared/main-layout.js";
import { SecretDocumentStore, type SecretDocumentIdentity, type SecretEncryption, type SecretPolicy } from "./secret-document-store.js";
import { isOwnerAwayAutoSkipMinutes, DEFAULT_OWNER_AWAY_AUTO_SKIP_MINUTES } from "../shared/owner-away-permission.js";
import { DEFAULT_SETTINGS } from "./settings-defaults.js";
import {
  appearanceMigration,
  marketplaceProviderPresetSecretInvalidationIds,
  mergeLlmPatch,
  normalizeA2ARemote,
  normalizeActiveChatRuntime,
  normalizeAppearance,
  normalizeChat,
  normalizeDiagnostics,
  normalizeUpstreamProxy,
  normalizeFeatureFlags,
  normalizeMarketplace,
  normalizeProjectRootList,
  normalizeProjectLabels,
  withoutMirroredMarketplaceProviderPresetEndpoint,
  withMarketplaceProviderPresetModelSlot,
  withRenamedLlmVendorIds,
  SIDE_PANEL_SPLIT_KEYS,
  normalizeSystem,
  normalizeDocuments,
  isWebViewPreferredFlow,
  normalizeWebView,
  preserveInstalledProviderPresetMetadata,
  sanitizeStoredPluginConfigs,
  normalizeAlertSettings,
  normalizeRetiredPluginConfigs,
  isActiveViewKey,
  normalizeMainLayout,
  isCloseBehavior,
  normalizeTelemetry,
  normalizeHomeDocs,
  acceptTelemetryText,
  TELEMETRY_TEXT_KEYS,
} from "./settings-normalization.js";
import {
  PATCHED_FIELD,
  acceptField,
  acceptNormalizedField,
  isBooleanValue,
} from "./settings-field-accept.js";
const log = createLogger("settings");

/** Marker for the one-time subAgentAutonomousWake un-fossilize migration in `loadSettings`. Delete together with that block; target 2026-10. */
const SUBAGENT_WAKE_DEFAULT_FLIP_MIGRATION = "subagent-autonomous-wake-default-flip";
/**
 * One-time cleanup for installs written while a marketplace provider preset's
 * endpoint was mirrored into the generic openai-compatible vendor block. See
 * {@link withoutMirroredMarketplaceProviderPresetEndpoint}.
 */
const PROVIDER_PRESET_ENDPOINT_UNMIRROR_MIGRATION =
  "marketplace-provider-preset-endpoint-unmirror";
/**
 * One-time split of the openai-compatible block's single `model` between the
 * generic custom-provider row and the selected marketplace preset. See
 * {@link withMarketplaceProviderPresetModelSlot}.
 */
const PROVIDER_PRESET_MODEL_SLOT_MIGRATION =
  "marketplace-provider-preset-model-slot";
/**
 * One-time rewrite of renamed built-in vendor ids in the stored settings. See
 * {@link withRenamedLlmVendorIds}; the matching API-key move is
 * {@link SettingsService.migrateRenamedVendorSecrets}.
 */
const LLM_VENDOR_ID_PACKAGE_NAMES_MIGRATION = "llm-vendor-id-package-names";
/**
 * One-time removal of the server marketplace's settings (design §16.2): the
 * catalog they addressed is gone. The matching secret is deleted by
 * {@link SettingsService.deleteRetiredMarketplaceApiKey}.
 */
const MARKETPLACE_SERVER_SETTINGS_REMOVED_MIGRATION = "marketplace-server-settings-removed";
const SYSTEM_APP_MODE_REMOVED_MIGRATION = "system-app-mode-removed";
const BUILT_IN_DEFAULT_MODELS_CLEARED_MIGRATION = "built-in-default-models-cleared";
const MARKETPLACE_DEFAULT_MODEL_CLEARED_MIGRATION_PREFIX = "marketplace-default-model-cleared:";
/** Frozen source: 26ab8c776^:src/shared/llm-vendor-defaults.ts, whose CORE_DEFAULT_MODEL and DEFAULT_MODEL preset expansion 26ab8c776
 * removed. Only the removed non-empty defaults belong here; live defaults must never change which saved selections this one-time migration clears. */
const REMOVED_BUILT_IN_DEFAULT_MODELS: Readonly<Partial<Record<LLMVendor, string>>> = Object.freeze({
  claude: "claude-sonnet-4-6",
  openai: "gpt-5.4-mini",
  gemini: "gemini-3.8-flash",
  "azure-foundry": "gpt-5.4-mini",
  "vertex-ai": "gemini-3.5-flash",
  openrouter: "anthropic/claude-sonnet-4.6",
  deepseek: "deepseek-flash",
  xai: "grok-4.20-0309-non-reasoning",
  together: "Qwen/Qwen3.6-Plus",
  fireworks: "accounts/fireworks/models/glm-5p3-flash",
  groq: "openai/gpt-oss-120b",
  poolside: "poolside/laguna-m.1",
  cerebras: "gpt-oss-120b",
  sambanova: "Meta-Llama-3.3-70B-Instruct",
  nebius: "nvidia/nemotron-3-super-120b-a12b",
  baseten: "deepseek-ai/DeepSeek-V4.1-Flash",
  requesty: "openai/gpt-6-luna",
  litellm: "gpt-5.4",
  huggingface: "MiniMaxAI/MiniMax-M2.5",
  "vercel-ai-gateway": "alibaba/qwen3.6-plus",
  "vercel-v0": "v0-1.5-md",
  aihubmix: "gpt-5.4-mini",
  hicap: "hicap-pro",
  "nous-research": "DeepHermes-3-Llama-3-3-70B-Preview",
  "huawei-cloud-maas": "DeepSeek-R1",
  wandb: "deepseek-ai/DeepSeek-V4.1-Flash",
  xiaomi: "mimo-v2.6-flash",
  kilo: "openai/gpt-5.4",
  zai: "glm-5v-turbo",
  "zai-coding-plan": "glm-5.2",
  qwen: "qwen3.7-plus",
  "qwen-code": "qwen3-coder-plus",
  doubao: "doubao-1-5-pro-256k-250115",
  mistral: "mistral-medium-latest",
  moonshot: "kimi-k3",
  asksage: "gpt-5.4-mini",
  ollama: "llama3.3",
  lmstudio: "local-model",
  oca: "anthropic/claude-3-7-sonnet-20250219",
});
/** The value every saved vendor block carried before the default stopped being written. A stored `outputTokenLimit` of exactly this, without the `outputTokenLimitSetByUser` stamp this build writes with a user's value, is the default written back and is dropped on every load, so the route reports
 * `host-default`. Every load, not once behind a marker: a build from before the stamp, reinstalled through the updater's downgrade offer, writes 32000 into every block again, and a marker would then leave those values reading as the user's after the re-upgrade. See {@link withoutFossilOutputTokenLimits}. */
const FOSSIL_OUTPUT_TOKEN_LIMIT = 32_000;
/** The removed keys, including the `real`-prefixed spellings older builds wrote. */
const RETIRED_MARKETPLACE_SETTING_KEYS: readonly string[] = [
  "backend",
  "cloudBaseUrl",
  "cloudAllowPrivateNetwork",
  "real" + "CloudBaseUrl",
  "real" + "CloudAllowPrivateNetwork",
];
/** Built-in vendor ids that were renamed, old → new. Marketplace provider packages are named after the vendor id and package names are lowercase kebab-case of at least
 * three characters, so neither a camelCase id nor one as short as `v0` could ship as a package. Read only by the one-time migrations: nothing resolves an old id at runtime. */
const RENAMED_LLM_VENDOR_IDS: Readonly<Record<string, LLMVendor>> = {
  nousResearch: "nous-research",
  v0: "vercel-v0",
};

/** The removed vendor a stored `llm` block still names: as its `provider` (a profile written before the removal), or as the marker an earlier load left. */
function retiredLlmProviderOf(rawLlm: unknown): RetiredLLMVendor | undefined {
  if (rawLlm === null || typeof rawLlm !== "object" || Array.isArray(rawLlm)) return undefined;
  const record = rawLlm as { provider?: unknown; retiredProvider?: unknown };
  if (isRetiredLLMVendor(record.provider)) return record.provider;
  return isRetiredLLMVendor(record.retiredProvider) ? record.retiredProvider : undefined;
}

/** The active API route's saved model, when the vendor's own complete listing no longer names it (the retired tier, design `model-capability-catalog.md` §6.1). A model the catalog only calls deprecated keeps working and
 * gets no marker; the window tells the user from the settings snapshot instead. Judged afresh on every load, so a model that comes back is released and a stored marker for a model the profile no longer names is dropped. */
function retiredLlmModelOf(llm: LLMSettings): RetiredLlmModel | undefined {
  if (resolveRouteModelRetirement(llm) !== "unlisted") return undefined;
  return { vendor: llm.provider, model: activeLlmRouteModel(llm), reason: "unlisted" };
}

/** Every global one-time migration this build knows. Fresh-install and corrupt-recovery settings start with ALL of them marked applied: a state built from current defaults is by definition post-migration, and
 * seeding the markers closes the window where a user's first-session opt-out would be silently reverted by a migration re-run on the next boot. Market model migrations instead acquire a marker per id once it resolves. */
const KNOWN_MIGRATIONS: readonly string[] = [
  SUBAGENT_WAKE_DEFAULT_FLIP_MIGRATION,
  PROVIDER_PRESET_ENDPOINT_UNMIRROR_MIGRATION,
  PROVIDER_PRESET_MODEL_SLOT_MIGRATION,
  LLM_VENDOR_ID_PACKAGE_NAMES_MIGRATION,
  MARKETPLACE_SERVER_SETTINGS_REMOVED_MIGRATION,
  SYSTEM_APP_MODE_REMOVED_MIGRATION,
  BUILT_IN_DEFAULT_MODELS_CLEARED_MIGRATION,
];

/** Preserve an explicit worker-confinement boolean; when absent, derive it only from stored osToolSandbox === true.
 * Apply on every load so downgraded writers cannot leave a stale migration marker hiding the missing field. */
function withPluginWorkerConfinementSplit(features: FeatureFlags): { features: FeatureFlags; changed: boolean } {
  if (typeof features.pluginWorkerConfinement === "boolean") return { features, changed: false };
  return { features: { ...features, pluginWorkerConfinement: features.osToolSandbox === true }, changed: true };
}

function withoutBuiltInDefaultModels(llm: LLMSettings): LLMSettings {
  const vendors = { ...llm.vendors };
  for (const vendor of LLM_VENDORS) {
    const block = vendors[vendor];
    const removedDefault = REMOVED_BUILT_IN_DEFAULT_MODELS[vendor];
    if (block && removedDefault !== undefined && block.model === removedDefault) {
      vendors[vendor] = { ...block, model: "" };
    }
  }
  // The same removed defaults used to seed new fallback rows.
  const fallbackChain = llm.fallbackChain.map((entry) => {
    const removedDefault = REMOVED_BUILT_IN_DEFAULT_MODELS[entry.provider];
    return removedDefault !== undefined && entry.model === removedDefault
      ? { ...entry, model: "" }
      : entry;
  });
  return { ...llm, vendors, fallbackChain };
}

/** A market default used to be saved on preset selection. Resolve each preset independently: an unavailable entry must remain pending until registration.
 * Mark even a different or absent model, so a later explicit pick survives. On load, compare the original slot before model-id normalization trims it. */
function withoutMarketplaceDefaultModels(
  llm: LLMSettings,
  presets: readonly MarketplaceInstalledProviderPreset[],
  appliedMigrations: string[],
  modelsBeforeNormalization: unknown = llm.vendors["openai-compatible"]?.presetModels,
): LLMSettings {
  const storedModels = modelsBeforeNormalization !== null
    && typeof modelsBeforeNormalization === "object" && !Array.isArray(modelsBeforeNormalization)
    ? modelsBeforeNormalization as Record<string, unknown>
    : undefined;
  let next = llm;
  for (const preset of presets) {
    if (typeof preset.defaultModel !== "string" || !preset.defaultModel.trim()) continue;
    const marker = `${MARKETPLACE_DEFAULT_MODEL_CLEARED_MIGRATION_PREFIX}${preset.providerId}`;
    if (appliedMigrations.includes(marker)) continue;
    const block = next.vendors["openai-compatible"];
    const model = storedModels && Object.hasOwn(storedModels, preset.providerId)
      ? storedModels[preset.providerId]
      : block?.presetModels?.[preset.providerId];
    if (block && model === preset.defaultModel) {
      next = { ...next, vendors: { ...next.vendors, "openai-compatible": {
        ...block, presetModels: { ...block.presetModels, [preset.providerId]: "" },
      } } };
    }
    appliedMigrations.push(marker);
  }
  return next;
}

/** The stored `llm` object with every unstamped fossil default output limit removed, and whether one was. */
function withoutFossilOutputTokenLimits(stored: Record<string, any>): { stored: Record<string, any>; changed: boolean } {
  const llm = stored.llm;
  if (llm === null || typeof llm !== "object" || Array.isArray(llm)) return { stored, changed: false };
  const vendors = llm.vendors;
  if (vendors === null || typeof vendors !== "object" || Array.isArray(vendors)) return { stored, changed: false };
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [vendorId, block] of Object.entries(vendors as Record<string, unknown>)) {
    const fields = block !== null && typeof block === "object" && !Array.isArray(block) ? block as Record<string, unknown> : undefined;
    if (fields?.outputTokenLimit === FOSSIL_OUTPUT_TOKEN_LIMIT && fields.outputTokenLimitSetByUser !== true) {
      const { outputTokenLimit: _fossil, ...rest } = fields;
      next[vendorId] = rest;
      changed = true;
    } else {
      next[vendorId] = block;
    }
  }
  return changed ? { stored: { ...stored, llm: { ...llm, vendors: next } }, changed } : { stored, changed };
}

/** Endpoints a vendor's default `baseUrl` used to name, and the one it names now. Saved vendor blocks carry the default they were saved with, so a stored copy of a retired default is rewritten to the current one. Applied on every load, by exact value, not behind a one-time marker: a
 * retired default is never a choice the user made (Baseten's old host does not resolve), and an older build reinstalled after this one can write the old default back into a fresh block, which a marker would leave stranded. Any other value; a proxy, a regional host; is the user's and is kept. */
const RETIRED_VENDOR_BASE_URLS: Readonly<Partial<Record<LLMVendor, Readonly<Record<string, string>>>>> = {
  // model-api.baseten.co does not resolve; Baseten's Model APIs are served from inference.baseten.co (docs.baseten.co, Model APIs overview).
  baseten: { "https://model-api.baseten.co/v1": "https://inference.baseten.co/v1" },
  // Nebius AI Studio became Token Factory; the old host still resolves to the same service, so this rewrite keeps the
  // stored endpoint on the documented name rather than repairing a broken one (docs.tokenfactory.nebius.com/switch).
  nebius: { "https://api.studio.nebius.ai/v1": "https://api.tokenfactory.nebius.com/v1" },
};

/** The stored `llm` object with every retired default endpoint rewritten, and whether anything changed. */
function withCurrentVendorBaseUrls(stored: Record<string, any>): { stored: Record<string, any>; changed: boolean } {
  const llm = stored.llm;
  if (llm === null || typeof llm !== "object" || Array.isArray(llm)) return { stored, changed: false };
  const vendors = llm.vendors;
  if (vendors === null || typeof vendors !== "object" || Array.isArray(vendors)) return { stored, changed: false };
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [vendorId, block] of Object.entries(vendors as Record<string, unknown>)) {
    const retired = Object.hasOwn(RETIRED_VENDOR_BASE_URLS, vendorId) ? RETIRED_VENDOR_BASE_URLS[vendorId as LLMVendor] : undefined;
    const baseUrl = block !== null && typeof block === "object" && !Array.isArray(block)
      ? (block as Record<string, unknown>).baseUrl
      : undefined;
    if (retired && typeof baseUrl === "string" && Object.hasOwn(retired, baseUrl)) {
      next[vendorId] = { ...(block as Record<string, unknown>), baseUrl: retired[baseUrl] };
      changed = true;
    } else {
      next[vendorId] = block;
    }
  }
  return changed ? { stored: { ...stored, llm: { ...llm, vendors: next } }, changed } : { stored, changed };
}

export type { LLMVendor, LLMVendorSettings };
export { LLM_VENDORS };
export type { ShortcutSettings, ShortcutSettingsPatch };

/** Single source of truth for the settings file path. Both `SettingsService` (writer) and the pre-`whenReady` synchronous readers derive the
 * settings path from this helper so the two can never drift onto different files. `userDataPath` is `app.getPath("userData")` (e.g. on macOS `~/Library/Application Support/Ave`). */
export function settingsFilePath(userDataPath: string): string {
  return resolve(userDataPath, "ave-settings.json");
}

/** Read lazy vendor blocks through getLlmVendorSettings; provider defaults govern sampling and stale controls drop on write. */
export interface LLMSettings {
  /** Empty uses the current chat model; another id stays on the active provider and credential route. */
  compactionModel?: string;
  /** Provider namespace that owns compactionModel; a different active route uses its current chat model. */
  compactionModelRoute?: string;
  /** Selects the execution boundary for new chat turns. API credentials and their provider/model
   * configuration remain under `provider` and `vendors` even while a subscription runtime is active. */
  activeChatRuntime: ActiveChatRuntime;
  provider: LLMVendor;
  /** Marketplace custom provider preset selected in the provider picker. Runtime still routes through
   * `openai-compatible`; this id preserves the user-visible preset identity, key namespace, and keyless policy. */
  marketplaceProviderPresetId?: string;
  vendors: LLMVendorSettingsMap;
  streamSmoothing: "none" | "word" | "char";
  fallbackChain: Array<{ provider: LLMVendor; model: string }>;
  /** Last successful standard `/models` sync per provider/baseUrl. This keeps router catalogs (OpenRouter/free tiers, local gateways,
   * OpenAI-compatible endpoints) from collapsing back to the small built-in seed list after a settings remount or offline restart. */
  modelListCache: LlmModelListCache;
  /** Per-model price corrections for a deployment on negotiated rates. Empty means "use the published list prices". Affects
   * reported spend (the Usage tab and its CSV export); the same reach the `AVE_PRICING_OVERRIDE` variable this surfaces has always had. */
  pricingOverrides: PricingOverride[];
  /** Models the user pinned to the top of the model chooser, newest last. ONE list across every provider, not one per provider: pinning exists so a model a person reaches for daily is not buried in a several-hundred-entry catalogue, and a per-provider list would still make them find the provider first. Entries are model ids as the provider reports them.
   * Never trusted on read. A pinned id may name a model that has since left the catalogue, or one whose provider is no longer connected; the chooser intersects this list with what is actually available and shows the rest of it not at all. The id STAYS stored through that, so reconnecting a provider brings its pins back rather than silently dropping them. */
  pinnedModels: string[];
  /** Retired vendors or models leave the route unresolved and block paid API turns until the user chooses a replacement.
   * Only loading sets the marker; saving a provider clears it, and mere deprecation does not set it. */
  retiredProvider?: LlmRouteRetirement;
  /** The model catalog refresh (design `model-capability-catalog.md` §7). Absent means the default, `"auto"`: once a day the host fetches the public models.dev document and caches
   * it for the next launch. `"off"` keeps the catalog to the last cached copy or the bundled snapshot. The `AVE_MODEL_CATALOG` pin and the managed policy file can also turn it off. */
  modelCatalogRefresh?: "auto" | "off";
  /** The model speed for a subscription runtime that `offersReasoningSpeed` (ChatGPT plan usage). Absent means
   * `DEFAULT_SUBSCRIPTION_REASONING_SPEED`. API-key routes keep their own per-vendor thinking budget and never read it. */
  subscriptionReasoningSpeed?: SubscriptionReasoningSpeed;
}

/** Patch shape for `SettingsService.patch()`. Vendor blocks are partial so a UI save touching a single vendor doesn't have to send every default or marketplace provider block. */
export interface LLMSettingsPatch {
  compactionModel?: string;
  compactionModelRoute?: string;
  activeChatRuntime?: ActiveChatRuntime;
  provider?: LLMVendor;
  marketplaceProviderPresetId?: string;
  vendors?: Partial<Record<LLMVendor, Partial<LLMVendorSettings>>>;
  streamSmoothing?: "none" | "word" | "char";
  fallbackChain?: Array<{ provider: LLMVendor; model: string }>;
  modelListCache?: LlmModelListCache;
  pricingOverrides?: PricingOverride[];
  pinnedModels?: string[];
  modelCatalogRefresh?: "auto" | "off";
  subscriptionReasoningSpeed?: SubscriptionReasoningSpeed;
}

export interface ChatSettings {
  systemPrompt: string;
  autoCompact: boolean;
  /** Controls which model work items are visible inside transcript work groups. */
  processingDisplayLevel: ProcessingDisplayLevel;
  /** Tool rounds a sub-agent may run before `round-cap` suspends it. Any positive integer; no ceiling sits above it.
   * SubAgentRunner runs exactly this budget and the child ConversationLoop honours it, so the number in Settings is the number that runs. */
  subAgentMaxRounds: number;
  /** Host progress nudges report rounds, elapsed time, and failures at a policy-controlled cadence; zero disables them.
   * Nudges are transient wire guidance, with progress.nudge recording the decision rather than persisting stale numbers. */
  progressNudgeRounds: number;
}

/** A renderer patch named a field that is invalid at the live settings boundary. Disk recovery is deliberately different: malformed persisted settings
 * retain the legacy full-display default during `normalizeChat`. A live mutation must not silently replace a user's current valid preference with that default. */
class SettingsPatchValidationError extends Error {
  readonly code = "invalid-processing-display-level";

  constructor() {
    super("chat.processingDisplayLevel must be one of: tools, reasoning, full.");
    this.name = "SettingsPatchValidationError";
  }
}

class OwnerAwayAutoSkipSettingsError extends Error {
  readonly code = "invalid-owner-away-auto-skip";
  constructor() {
    super("Owner-away auto-skip must be a nonnegative integer.");
    this.name = "OwnerAwayAutoSkipSettingsError";
  }
}

export interface A2ARemoteTargetSettings {
  targetAgentId: number;
  label: string;
  interfaceUrl: string;
  agentCardDigestSha256: string;
  trustKeyId: number;
  credentialBindingId: number;
  routePolicyVersion: number;
  routePolicyDigestSha256: string;
  intendedCredentialRevisionId: number;
  /** Main-owned ordered successor revisions used by explicit manual Replay actions. */
  replayCredentialRevisionIds: number[];
}

export interface A2ARemoteSettings {
  routeControlBaseUrl: string;
  /** Canonical public HTTPS origin advertised by the receiver Agent Card. */
  receiverPublicOrigin: string;
  outboundCallerGenerationId: string;
  receiverCallerGenerationId: string;
  extensionSpecDigestSha256: string;
  targets: A2ARemoteTargetSettings[];
  receiverMaxKeysPerGeneration: number;
}

/** §14.2 Audit log rotation + retention settings. - auditRotationMaxBytes: rotate when file exceeds
 * this size (default 10 MB) - auditRetentionDays: delete archives older than this many days (default 30) */
export interface AuditSettings {
  /** Rotate active .jsonl when it exceeds this size in bytes. Default: 10_485_760 (10 MB). */
  auditRotationMaxBytes: number;
  /** Delete .jsonl.*.gz archives older than this many days. Default: 30. */
  auditRetentionDays: number;
}

export type MemoryCaptureMode = "off" | "review" | "auto";

/** Experimental feature flags; UI-toggleable, persisted to settings.json. Defaults are defined per flag in
 * settings-defaults.ts. Safe to add fields without migration; missing keys are treated as false at load time. */
export interface FeatureFlags {
  /** When true, idle IDLE_SCAN may send local preference/memory sources to the configured LLM to refresh user-preferences.md. Default false: manual only. */
  idlePreferenceRefresh?: boolean;
  /** When true, idle IDLE_SCAN may send eligible active global and current explicit-project raw memories to the
   * configured LLM to update a derived long-term overview. Default false: manual consolidation remains available. */
  idleMemoryConsolidation?: boolean;
  /** Controls LLM-reviewed capture of durable memories from trusted keyboard turns. `off` makes no background reviewer call; `review` writes only
   * a candidate; `auto` lets a host-validated high-confidence proposal become active. Explicitly saved user notes remain user-owned exact text. */
  memoryCaptureMode?: MemoryCaptureMode;
  /** When true, a queued background sub-agent Message may start a new parent turn while that exact parent
   * session is loaded and idle. Default false: the durable mailbox joins the user's next turn instead. */
  subAgentAutonomousWake?: boolean;
  /** Enables the A2A loopback route family on the shared 127.0.0.1 listener. Default false. The
   * boot lifecycle snapshots this value once; a settings change takes effect only after restart. */
  a2aLoopbackServer?: boolean;
  /** Enables outbound P4-5 remote A2A routing after restart. Independent of loopback. */
  a2aRemoteRouting?: boolean;
  /** Enables the P4-5 exact-replay receiver profile after restart. Independent of loopback. */
  a2aRemoteReceiver?: boolean;



  onboardingCompleted?: boolean;
  /** Host risk classification ships on and ignores untrusted declared categories; disabling it restores declared categories (docs/architecture/permission-policy-design.md). */
  hostClassifiesRisk?: boolean;
  /** Controls host shells and workspace terminals only; worker confinement and approval policy remain independent.
   * Defaults on for macOS/Linux and off for Windows; unavailable settings activation warns, explicit macOS/Linux activation aborts, and Windows reports filesystem/network confinement only. */
  osToolSandbox?: boolean;
  /**
   * Plugin-worker confinement — when `true`, the processes extensions run
   * (plugin workers, out-of-process plugin children, plugin script hooks and
   * external MCP stdio servers) are spawned under ASRT. Separate from
   * {@link osToolSandbox} so that turning the shell sandbox on does not by
   * itself confine workers whose manifests under-declare their network
   * domains. Off by default; `loadSettings` derives it from a stored
   * `osToolSandbox: true` whenever a file lacks this boolean (one written by a
   * build that predates the split), so an existing opt-in stays on for both.
   *
   * `AVE_PLUGIN_WORKER_CONFINEMENT=1` is this setting's environment override
   * and, like `AVE_SANDBOX_ENABLED=1` for the shell sandbox, the explicit
   * fail-closed signal.
   */
  pluginWorkerConfinement?: boolean;
  /** Shell egress asks (proxy-egress PR 4): when a sandboxed Bash or PowerShell call connects to a host no grant covers, ask the person on the approval dock (Allow once / This
   * conversation / This workspace / Always, or Deny once). Off: such connections are denied without asking; granted hosts still work and plugin workers are unaffected. On by default. */
  shellEgressAsk?: boolean;
}

/** §E2 Diagnostics bundle + production log retention settings. - includeCrashDumps: include raw crash-dump binaries in the bundle (opt-in). - logRetentionDays: retention window for `~/.ave/logs/`. Default
 * + clamp bounds come from the fs-free SOT `src/shared/log-retention.ts` (`LOG_RETENTION_DAYS`, which log-file-sink re-exports); this setting value drives the sink's boot-time prune (boot/services.ts). */
export interface DiagnosticsSettings {
  /** Include raw crash-dump binaries in the exported bundle. Default false. */
  includeCrashDumps: boolean;
  /** Retention window (days) for production log files. Default 7. */
  logRetentionDays: number;
}

export interface AppSettings {
  llm: LLMSettings;
  chat: ChatSettings;
  /** Host-owned P4-5 routing configuration. Secrets remain in SettingsService secret storage. */
  a2aRemote: A2ARemoteSettings;
  webSearch: WebSearchSettings;
  marketplace: MarketplaceSettings;
  routine: RoutineSettings;
  /** How `~/.ave` reference docs follow the shipped ones. */
  homeDocs: HomeDocsSettings;
  permissions?: { ownerAwayAutoSkipMinutes: number };
  privacy: PrivacySettings;
  updates: UpdateSettings;
  telemetry: TelemetrySettings;
  audit: AuditSettings;
  /** Where the sandbox egress proxy sends allowed connections next. Main-owned: written only through the permissions `upstreamProxySet`
   * channel (host renderer only) via `set`, never through `patch()`, and left out of the renderer snapshot. See `src/shared/upstream-proxy.ts`. */
  upstreamProxy: UpstreamProxySettings;
  /** §E2; diagnostics bundle + log retention. */
  diagnostics: DiagnosticsSettings;
  /** Visual theme and UI preferences. */
  appearance: AppearanceSettings;
  /** §B1; external URL viewer policy (in-app BrowserWindow vs system browser). */
  webView: WebViewSettings;
  /** User-owned document opening policy; agent writes remain blocked by the settings-file floor. */
  documents: DocumentSettings;
  /** Window close-button behaviour (hide-to-tray vs quit). */
  system: SystemSettings;
  /** Global keyboard shortcuts (show/hide window toggle). */
  shortcuts: ShortcutSettings;
  /** Plugin settings reserved for non-trust UI preferences. Trust gates are host-owned. */
  plugins: PluginSettings;

  pluginConfigs: Record<string, PluginConfigRecord>;
  /** The user's per-kind choices for the alert kinds plugins declare, plus the master OS-notification switch. Written only by the alerts
   * service, never through `patch()`: a generic settings patch and the service's own write-back must not race. Shapes in `src/shared/alerts-types.ts`. */
  alerts: AlertSettings;
  /** The effective config a retired (revoked) plugin left behind, keyed by plugin id, so its
   * successors can inherit the user's choices. Written by the retirement paths, never through `patch()`. */
  retiredPluginConfigs: Record<string, RetiredPluginConfigRecord>;
  /** Experimental feature flags. All default false. */
  features?: FeatureFlags;
  /** Host-owned ids of one-time settings migrations already applied to this file. Never patched from the renderer; load and market registration append. */
  appliedMigrations?: string[];
}

export interface PluginSettings {}

/** Appearance schema 2 selects one complete token bundle; followSystem uses its paired theme.
 * Load migrates legacy axes once; new callers use AppearanceSettings. */

/** @internal; legacy v1 axis types, used only in migration. */
export type ThemePreference = "system" | "light" | "dark" | "high-contrast";
/** @internal; legacy v1 axis types, used only in migration. */
export type ChatThemePreference = "default" | "lg" | "purple" | "orange" | "blue";
/** @internal; legacy v1 axis types, used only in migration. */
export type CodeThemePreference = "auto" | "light" | "dark";

/** @internal; legacy v1 shape, used only in migrateAppearanceV1ToV2. */
export interface AppearanceSettingsV1 {
  theme: ThemePreference;
  chatTheme: ChatThemePreference;
  codeTheme: CodeThemePreference;
}

/** User-configurable font preferences. `family`; `"system"` keeps the built-in HOST_FONT_STACK (default). Any other value MUST match `isValidFontFamilyOverride`; rejected values fall back to `"system"` at normalize time so a corrupt settings.json cannot break first paint. `sizeScale`; multiplicative on `1rem`. Discrete preset values keep the UI legible at every step (a
 * free slider would let users pick `0.4` and lock themselves out of the settings dialog). The values + validators live in `src/shared/appearance-font.ts` (a zero-import pure module) so the renderer preload can enforce the same contract on the frame-0 theme prime without pulling this store's `electron`/`node:fs` deps. Re-exported here so existing import sites stay unchanged. */
export {
  FONT_SIZE_SCALE_VALUES,
  type FontSizeScale,
  type AppearanceFontSettings,
  isValidFontFamilyOverride,
} from "../shared/appearance-font.js";

/** v2 appearance settings; single bundle, optional followSystem + font overrides. */
export interface AppearanceSettings {
  schemaVersion: 2;
  bundleId: string;
  followSystem?: boolean;
  font?: AppearanceFontSettings;
  /**
   * UI language. Drives the i18n layer (see {@link ../i18n}). Defaults to
   * {@link DEFAULT_LOCALE} (English) for the global build; persisted here so
   * the choice survives restarts and is read by both main and renderer.
   */
  language?: Locale;
}

export function migrateAppearanceV1ToV2(
  legacy: AppearanceSettingsV1,
): AppearanceSettings {
  return appearanceMigration.migrateV1ToV2(legacy);
}

/** §B1; External URL viewer policy. `preferredFlow` decides whether external URLs (OAuth IdP, calendar webLinks, email open/compose URLs, etc.) are surfaced inside a host BrowserWindow ("in-app") or routed to the OS default browser ("system-browser"). SoT for the host. Plugins consume this via
 * `hostApi.getAppPreference(...)` and/or `hostApi.openExternalUrl(...)`; see plan `.omc/plans/2026-05-04-external-url-viewer-policy.md`. Default `"in-app"` keeps plugin-owned auth and link flows inside Ave unless the plugin asks the host to open the system browser. Future enum extension reserved (e.g. `"ask-each-time"`). */
export type WebViewPreferredFlow = "in-app" | "system-browser";

export interface WebViewSettings {
  preferredFlow: WebViewPreferredFlow;
}




export type SystemCloseBehavior = "hide-to-tray" | "quit";

export interface SystemSettings {
  /** Use the default OS sound for background turn-completion notifications. Default true. */
  turnCompletionSoundEnabled?: boolean;
  closeBehavior: SystemCloseBehavior;
  /** Launch Ave automatically at OS login. Applied via `app.setLoginItemSettings({ openAtLogin })` (see
   * `src/main/startup-launch.ts`). Default `false`. No-op in dev (unpackaged) builds; the login item would point at the Electron dev binary. */
  launchAtStartup?: boolean;
  /** When launching at startup, start hidden (tray only) instead of showing the main window. The host applies this preference to
   * macOS login launches; Windows uses a --hidden launch argument. Default `false`. Only meaningful when `launchAtStartup` is `true`. */
  launchMinimized?: boolean;
  /** Opt-in loopback HTTP+SSE server for the CLI / automation surface (#1409 external API, #1436 lifecycle wiring). Default OFF; the app never opens a listener socket unless the user turns this on here OR the environment sets `AVE_LOCAL_API=1`.
   * When enabled, the server binds 127.0.0.1 on an ephemeral port and requires a per-boot bearer secret (persisted for the CLI under `~/.ave/local-api/`). Independent of every other flag: it only controls whether the aux transport is started. */
  localApiServer?: boolean;
  /** Whether hardware acceleration is enabled at launch. Software rendering still uses a separate display-compositor process. Changes take effect on the next launch because the runtime only accepts this choice before ready. Default is
   * platform-derived (`settings-defaults.ts`): OFF on Windows/Linux, where restricted corp/VDI drivers crash the GPU process and take the renderer with it; ON on macOS. `AVE_KEEP_GPU=1` overrides both; see `resolveHardwareAcceleration`. */
  hardwareAcceleration?: boolean;
  /** Whether to acquire the corporate root CA and inject it into the TLS stack. Applied ONLY at launch: injection has to precede the first outbound request,
   * which is before `SettingsService` exists, so the reader is `persisted-corp-ca.ts` and the control says "next launch". `AVE_SKIP_CORP_CA=1` forces this off. */
  corpCaEnabled?: boolean;
  /** Certificate common name to look for in the system trust store. Empty or absent means the default placeholder name, which is almost
   * never the right one; an organization whose CA is named anything else has to say so here. `AVE_CORP_CA_CN` supplies it instead when set. */
  corpCaCommonName?: string;
  /** Whether to log the certificate paths that are skipped rather than staying silent. Off by default. `AVE_CORP_CA_DEBUG=1` forces it on. */
  corpCaDebugLog?: boolean;
  /** How long the app may spend on its quit-time cleanup chain (stopping routines, plugins, and child processes, then flushing window state) before it stops waiting and exits anyway. Milliseconds; default 60_000, from `TOOL_TIMEOUT_POLICY.shutdownCleanupMs`.
   * Raising it buys a slow plugin or a large unsaved workspace more time to finish writing; lowering it makes quitting feel immediate at the cost of abandoning work still in flight. `AVE_SHUTDOWN_CLEANUP_TIMEOUT_MS` overrides it; see `resolveShutdownCleanupTimeoutMs`. */
  shutdownCleanupTimeoutMs?: number;
  /** Persisted width (px) of the docked ChatSidePanel workspace rail, set by the left-edge drag handle; the card plus its insets
   * (`SIDE_PANEL_MIN_RESERVE` is the floor). Durable shell-layout preference; bounded by the tile's range at drag time in the renderer. Default 464. */
  sidePanelWidth?: number;
  /** Persisted width (px) of the primary (left) navigation sidebar card, set by the inner-edge drag handle. Durable shell-layout preference;
   * clamped to [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH] at drag time in the renderer. Default 232 (matches the historical expanded rail padding reserve). */
  sidebarWidth?: number;
  /** Explicit navigation visibility. Absent lets the renderer choose its width-dependent default. */
  sidebarState?: SidebarState;
  /** Persisted Files tree column width in pixels; clamped to the shared file-tree range. Default 300. */
  sidePanelFileTreeWidth?: number;
  /** Persisted TOP-pane percent of the workspace-rail vertical (list↕viewer) split, one field per tab kind whose body is a list-over-viewer layout (preview / subagent). A browser
   * tab is its address row and page only, so it has no split. Clamped to the [SIDE_PANEL_SPLIT_MIN_PERCENT, SIDE_PANEL_SPLIT_MAX_PERCENT] pane range at drag time in the renderer. Default 45. */
  sidePanelSplitPreviewPercent?: number;
  sidePanelSplitSubagentPercent?: number;
  /** Persisted active sidebar tab ("chats" = the plain ungrouped conversation list, "projects" = named-project groups). Durable
   * UI preference, same family as `sidebarWidth`. Default "chats". SoT for the value set: `../shared/sidebar-tab.js`. */
  sidebarActiveTab?: SidebarTab;
  /** Where the main window was when it last closed, so a restart resumes the user's location instead of always landing on home. Same durable-preference family as `sidebarActiveTab`. Default "home". SoT for the value set: `../shared/view-key.js`. Validation here is
   * STRUCTURAL only; this process cannot know which plugins are installed, and a `plugin:<id>:<viewId>` key stays well-formed after its plugin is uninstalled. The renderer therefore re-checks a restored plugin key against the views it actually loaded before navigating there. */
  activeView?: InlineViewKey;
  /** The main window's pane layout when it last changed; panes, which show a terminal or web page, open side panels, and terminal/browser side tabs with their last directory or
   * address; restored at launch. Absent until the layout first changes. SoT for the shape and its rules: `../shared/main-layout.js`; a value that breaks any rule is refused whole. */
  mainLayout?: MainLayoutSnapshot;
  /** Which settings tab the panel was on, so restoring into `activeView: "settings"` lands on the page the
   * user left rather than the default one. Default "llm". SoT for the value set: `../shared/settings-tabs.js`. */
  settingsTab?: SettingsTab;
  /** Pinned project roots; pinned projects sort to the top of the sidebar's Projects tab. A lightweight preference list (not a project-domain
   * mutation), so it lives here rather than a dedicated IPC domain. Default empty. Normalized to a de-duplicated string array on read/write. */
  pinnedProjectRoots?: string[];
  /** Archived project roots; hidden from the Projects tab's default listing without being removed. Removal drops the workspace
   * root and its durable permission scope; archiving touches neither, which is exactly why the two are separate actions on the row. */
  archivedProjectRoots?: string[];
  /** User-chosen display names for project rows, keyed by `projectRootKey`. A label renames the ROW, never the folder on disk. */
  projectLabels?: Record<string, string>;
}

/** Production release prep; Electron auto-update (electron-updater). `autoCheckEnabled` defaults to TRUE: only the background update *check* (metadata fetch) runs by default. Actual download +
 * install are always gated behind explicit user action in the update toast; there is no silent auto-install. Users who want zero network traffic for updates can flip this to false via the settings UI. */
export interface UpdateSettings {
  /** Background update-check enabled. Download/install still requires user action. */
  autoCheckEnabled: boolean;
  /** App version the user skipped. The updater hides only this exact version; a later version is shown again. */
  skippedVersion?: string;
}

/** Production release prep; anonymous opt-in telemetry. Default OFF. Requires explicit user action to enable. -
 * `telemetryPromptAnswered`; true once the user has dismissed the first-boot consent prompt (regardless of Yes/No). Events are NEVER sent before this is true. */
export interface TelemetrySettings {
  enabled: boolean;
  endpoint?: string;
  sentryDsn?: string;
  crashReportEndpoint?: string;
  crashReportingEnabled?: boolean;
  /** True once the user has answered the one-time opt-in prompt. */
  telemetryPromptAnswered?: boolean;
}




/** How the `~/.ave` reference docs follow the shipped ones. Default OFF, and off is the behavior that shipped before this setting: a divergent packaged doc is offered as an upgrade marker and nothing moves until
 * the user answers. Turning it on changes where the user's own content lives, not whether it survives; `agents.custom.md` holds it, and the system prompt reads it after the live doc so it still wins on conflict. */
export interface HomeDocsSettings {
  /** Keep the live `~/.ave/AGENTS.md` on the packaged version, carrying the user's own content in `agents.custom.md` from then on. */
  keepLatest: boolean;
}

export interface PrivacySettings {
  /** The single switch for personal-data handling. On, it redacts the user's input before the turn reaches the provider, and masks PII in the tool output the renderer shows and in the audit entries the host writes. Off, none of those three surfaces touches
   * PII, and no PII detection is reported. It does not govern credential scrubbing: bearer tokens, API keys and private keys are removed from display, audit and log text in both states, because a leaked secret is a security defect rather than a preference. */
  piiRedactEnabled: boolean;
}

/** §7 Routine Engine settings; v2. Lenient parsing: unknown keys (including all prior routine fields such as enableWakeupRoutine, wakeupRoutinePrompt,
 * scheduleEntries, etc.) are silently accepted so dev machines with old settings.json do not crash at boot. No migration code; v1 keys are simply never read. */
export type RoutineSettings = Record<string, unknown>;

export interface WebSearchSettings {
  provider: "duckduckgo" | "tavily" | "serper" | "google";
}

/** The git marketplace's settings (design §16.2). Sources, pins and tokens live in
 * `~/.ave/marketplaces` and the secret store, not here. A source's or package's automatic-update switch (design §18.7.2). */
export type AutoUpdateSwitch = "on" | "off";

export interface MarketplaceSettings {
  /** Which git the git marketplace runs (design §9.1). Unset means `auto`. */
  git?: { mode: GitRuntimeMode };
  /** Whether the renderer is told about package updates. Default true. */
  updateCheckEnabled?: boolean;
  /** Keep downloaded plugin artifacts under their pinned digest, so a reinstall of a version already fetched needs no network (design §7.5). Default true.
   * `AVE_MARKETPLACE_USE_CACHE`, when set, overrides this either way; it is the deployment-side kill switch and predates the setting. See `resolveKeepArtifacts`. */
  offlineCacheEnabled?: boolean;
  /** Periodic sync interval in milliseconds (design §7.3). Unset means 6 hours; a value below 15 minutes reads as 15 minutes; 0 turns the periodic sync off (boot and manual only). */
  updateCheckIntervalMs?: number;
  /** When true, canary/pre-release catalog entries are included in update notifications. Default false (stable only). */
  canaryOptIn?: boolean;
  /** Announcement banner ids the user has dismissed. Absent/empty until the first dismissal. The host
   * filters these out before pushing announcements to the renderer so a dismissed banner never reappears. */
  dismissedAnnouncementIds?: number[];
  /** Update versions the user skipped, keyed by a plugin's name or `kind:name` for other kinds. A skipped
   * update is hidden only while the offered version equals the stored one; the next version surfaces again. */
  skippedPluginUpdates?: Record<string, string>;
  /** The global automatic-update switch (design §18.7.2, §18.9). Unset means on; `false` turns automatic
   * updates off. Normalized here; the switch decides nothing until automatic apply is built (§18.10 F). */
  autoUpdate?: boolean;
  /** Per-source automatic-update switches, keyed by source id (`SOURCE_ID_RE`). An invalid id or value is dropped when read; the map is null-prototype. */
  autoUpdateSources?: Record<string, AutoUpdateSwitch>;
  /** Per-package automatic-update switches, keyed like `skippedPluginUpdates`
   * (`packageUpdateSkipKey`) and normalized with `normalizeSkippedPluginUpdateKey`; the map is null-prototype. */
  autoUpdatePackages?: Record<string, AutoUpdateSwitch>;
  /** Marketplace-installed provider packages. Defaults stay tiny; installed ids expand the provider picker without re-bundling every provider into the first-run surface. */
  installedProviderIds: MarketplaceEligibleLLMVendor[];
  /** User-installed OpenAI-compatible provider presets from Marketplace. */
  installedProviderPresets: MarketplaceInstalledProviderPreset[];
  /** Themes the server marketplace turned on. Legacy: read and emptied only by the first-boot migration (design
   * §16.3), which installs the theme package of each id; the renderer lists installed theme packages instead. */
  installedThemeBundleIds: string[];
  /** Language packs the server marketplace turned on. Legacy, like `installedThemeBundleIds`: the migration installs the language package for each locale. */
  installedLanguagePacks: Locale[];
  /** Messaging connections the owner installed, as the catalog declared them. Declarations only; the
   * credentials each one names are held by the connection itself in the encrypted secret store, never here. */
  installedMessagingConnections: MarketplaceInstalledMessagingConnection[];
}

export interface SettingsServiceOptions {
  userDataPath: string;
  encryption: SecretEncryption;
  /** Host-owned policy, never inferred from NODE_ENV. */
  secretPolicy?: SecretPolicy;
  /** BCP-47 locale tag from the host OS (e.g. `app.getPreferredSystemLanguages()[0]`). Used only on a fresh install (no settings file) to seed the UI
   * language from the system rather than hard-coding English. Once the user has a settings file the stored value takes precedence; this field is ignored. */
  systemLocale?: string;
  /** The running app version. The load drops alert kind entries whose plugin has been absent for two minor releases (see
   * `normalizeAlertSettings`). Absent, a pre-release build, or anything but a stable `X.Y.Z` release; the resolver's `"unknown"` included; drops nothing. */
  appVersion?: string;
}


/** `current` with the listed provider presets as they were in `previous`: an entry that changed goes back, a removed one returns, one added since goes. */
function withProviderPresetsFrom(
  current: AppSettings,
  previous: AppSettings,
  providerIds: readonly string[],
): AppSettings {
  const listed = new Set(providerIds);
  const before = new Map(
    previous.marketplace.installedProviderPresets
      .filter((preset) => listed.has(preset.providerId))
      .map((preset) => [preset.providerId, preset]),
  );
  const presets: MarketplaceInstalledProviderPreset[] = [];
  for (const preset of current.marketplace.installedProviderPresets) {
    if (!listed.has(preset.providerId)) {
      presets.push(preset);
      continue;
    }
    const restored = before.get(preset.providerId);
    if (restored) presets.push(restored);
    before.delete(preset.providerId);
  }
  presets.push(...before.values());
  return {
    ...current,
    marketplace: normalizeMarketplace({ ...current.marketplace, installedProviderPresets: presets }),
  };
}

export class SettingsService {
  private readonly changeListeners = new Map<keyof AppSettings, Set<() => void>>();
  private providerConfigRevision = 0;
  private readonly secretGenerations = new Map<string, number>();
  private observedSecretFingerprint: string | null | "unreadable" | undefined;
  private observedSecretMutation: number | null = null;
  private secretMutationRegressed = false;
  private readonly leaseStateListeners = new Set<() => void>();

  getProviderConfigRevision(): number { return this.providerConfigRevision; }
  getSecretGeneration(key: string): number {
    // Every issuance/use samples shared file identity. Unchanged metadata reuses its verified bytes; another writer's replacement forces a read.
    const fingerprint = this.readSecretFingerprint();
    if (this.observedSecretFingerprint === undefined) {
      this.observedSecretFingerprint = fingerprint;
    } else if (fingerprint !== this.observedSecretFingerprint) {
      this.observedSecretFingerprint = fingerprint;
      this.secretStatesChanged(this.secretGenerations.keys());
    }
    if (!this.secretGenerations.has(key)) this.secretGenerations.set(key, 0);
    return this.secretGenerations.get(key)!;
  }
  private readSecretFingerprint(): string | null | "unreadable" {
    try { return this.identityFingerprint(this.secretStore.identity()); } catch { return "unreadable"; }
  }
  private identityFingerprint(identity: SecretDocumentIdentity | null): string | null | "unreadable" {
    const mutation = identity?.mutation ?? null;
    // A previously observed writer counter cannot disappear or move backwards.
    if (this.observedSecretMutation !== null && (mutation === null || mutation < this.observedSecretMutation)) {
      this.secretMutationRegressed = true;
      return "unreadable";
    }
    if (this.secretMutationRegressed) return "unreadable";
    if (mutation !== null) this.observedSecretMutation = mutation;
    return identity === null ? null : `${mutation ?? "legacy"}:${identity.fingerprint}`;
  }
  isSecretIdentityUsable(): boolean { return this.observedSecretFingerprint !== "unreadable"; }
  onLeaseStateChanged(listener: () => void): () => void {
    this.leaseStateListeners.add(listener);
    return () => { this.leaseStateListeners.delete(listener); };
  }
  private notifyLeaseState(): void {
    for (const listener of this.leaseStateListeners) {
      try { listener(); } catch (error) { log.warn({ error }, "lease state listener failed"); }
    }
  }
  private providerConfigChanged(): void {
    this.providerConfigRevision += 1;
    this.notifyLeaseState();
  }
  private secretStateChanged(key: string): void {
    this.secretStatesChanged([key]);
  }
  private secretStatesChanged(keys: Iterable<string>): void {
    const changed = new Set(keys);
    if (changed.size === 0) return;
    for (const key of changed) this.secretGenerations.set(key, (this.secretGenerations.get(key) ?? 0) + 1);
    this.notifyLeaseState();
  }
  private readonly settingsPath: string;
  private readonly secretsPath: string;
  private readonly secretStore: SecretDocumentStore;
  private settings: AppSettings;
  /** The settings last written to disk (or loaded): what memory returns to when a save fails. */
  private saved: AppSettings;
  /** Writes whose change is in memory but not yet on disk (see `commit`). */
  private unsaved: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  private saving = false;
  /** Provider-preset keys left next to an address they were not entered for: their deletion failed and so did the
   * save that put their old address back. This process never hands them out, and deletes them once a save lands again. */
  private readonly withheldSecretKeys = new Set<string>();
  /** Provider-preset keys whose old address is being saved back. They are not handed out until that save lands; if it fails they are withheld. */
  private readonly restoringSecretKeys = new Set<string>();
  /** Provider-preset keys with an invalidation in flight (saved or not, deletion unsettled), counted. */
  private readonly invalidatingSecretKeys = new Map<string, number>();
  /** Keys entered again while an invalidation of them was in flight, with the preset they were entered next to: that is their address now. */
  private readonly reenteredSecretKeys = new Map<string, MarketplaceInstalledProviderPreset | undefined>();
  /** Re-entered keys whose new value is written: the only ones read while their invalidation runs. */
  private readonly writtenReentries = new Set<string>();

  constructor(options: SettingsServiceOptions) {
    const dir = resolve(options.userDataPath);
    mkdirSync(dir, { recursive: true });
    this.settingsPath = settingsFilePath(options.userDataPath);
    this.secretsPath = resolve(dir, "ave-secrets.json");
    this.secretStore = new SecretDocumentStore({
      path: this.secretsPath,
      policy: options.secretPolicy ?? "packaged",
      encryption: options.encryption,
      onCommittedSecretsChanged: (keys, before, after) => {
        // Fence leases at the file swap; awaited callers can resume only after lock release.
        const changed = new Set(keys);
        if (this.observedSecretMutation !== null
          && (before?.mutation === null || before?.mutation === undefined
            || before.mutation < this.observedSecretMutation)) this.secretMutationRegressed = true;
        if (this.observedSecretFingerprint !== undefined
          && this.observedSecretFingerprint !== (before === null ? null : `${before.mutation ?? "legacy"}:${before.fingerprint}`)) {
          for (const key of this.secretGenerations.keys()) changed.add(key);
        }
        this.observedSecretFingerprint = this.identityFingerprint(after);
        this.secretStatesChanged(changed);
      },
    });
    const { settings: loaded, writeBack: needsWriteBack } = this.loadSettings(options.appVersion, options.systemLocale);
    this.settings = loaded;
    this.saved = structuredClone(loaded);
    // Migration write-back (appearance v2, one-time markers): persist so the next load is clean.
    if (needsWriteBack) {
      void this.commit().catch(() => { /* best-effort — next load re-migrates */ });
    }
  }




  async migrateSecrets(): Promise<boolean> {
    return this.secretStore.migrate();
  }

  /** Delete the server marketplace's API key (design §16.2). Nothing reads it any more; a failure leaves it in the store and is
   * retried at the next boot. Once it is gone the delete writes nothing, so a store that cannot write reports nothing on the boots after. */
  async deleteRetiredMarketplaceApiKey(): Promise<void> {
    try {
      await this.deleteSecret("marketplace.apiKey");
    } catch (err) {
      log.warn("retired marketplace API key delete failed: %s", (err as Error).message);
    }
  }

  /** Delete the API key stored for each removed vendor ({@link RETIRED_LLM_VENDOR_IDS}). Nothing can use it: the vendor's service is gone and no
   * route reads the key. Runs on every boot and writes only while a key remains, so a failed delete is retried next boot and never fails the boot. */
  async deleteRetiredLlmVendorApiKeys(): Promise<void> {
    for (const vendor of RETIRED_LLM_VENDOR_IDS) {
      try {
        await this.deleteSecret(`llm.apiKey.${vendor}`);
      } catch {
        // A secret-store exception can contain credential material.
        log.warn("retired vendor %s API key delete failed; retrying next boot", vendor);
      }
    }
  }

  /** Move each API key stored under a renamed vendor id to the new id's key (see {@link RENAMED_LLM_VENDOR_IDS}). Runs on every boot: it writes only while an old key remains, so a
   * move that failed is retried next boot. A failure leaves the old key where it is and never fails the boot; the provider then reads as having no key until a later boot moves it. */
  async migrateRenamedVendorSecrets(): Promise<void> {
    for (const [from, to] of Object.entries(RENAMED_LLM_VENDOR_IDS)) {
      try {
        await this.secretStore.move(`llm.apiKey.${from}`, `llm.apiKey.${to}`);
      } catch (err) {
        log.warn("API key move from vendor %s to %s failed: %s", from, to, (err as Error).message);
      }
    }
  }

  getAll(): AppSettings {
    return structuredClone(this.settings);
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return structuredClone(this.settings[key]);
  }

  async set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
    const persist = async () => {
      this.settings[key] = value;
      if (key === "llm" || key === "marketplace") this.providerConfigChanged();
      await this.commit();
      for (const listener of this.changeListeners.get(key) ?? []) {
        try { listener(); } catch (error) { log.warn({ error }, "settings change listener failed"); }
      }
    };
    return key === "marketplace" ? withInstalledStateMutation(persist) : persist();
  }

  /** Observes durable writes through set; callbacks must not block the writer. */
  onChanged(key: keyof AppSettings, listener: () => void): () => void {
    let listeners = this.changeListeners.get(key);
    if (!listeners) this.changeListeners.set(key, (listeners = new Set()));
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  async patch(
    partial: Partial<Omit<
      AppSettings,
      | "llm" | "chat" | "marketplace" | "shortcuts" | "telemetry" | "appliedMigrations"
      | "alerts" | "retiredPluginConfigs" | "upstreamProxy"
    >> & {
      marketplace?: Partial<MarketplaceSettings>;
      llm?: LLMSettingsPatch;
      chat?: Partial<ChatSettings>;
      shortcuts?: ShortcutSettingsPatch;
      // Field by field, like the blocks above: the telemetry surface writes one switch or one address at a time,
      // and demanding the whole block would make every such write a read-modify-write the caller could get wrong.
      telemetry?: Partial<TelemetrySettings>;
    },
  ): Promise<AppSettings> {
    return partial.marketplace
      ? withInstalledStateMutation(() => this.patchSettings(partial))
      : this.patchSettings(partial);
  }

  private async patchSettings(partial: Parameters<SettingsService["patch"]>[0]): Promise<AppSettings> {
    const chatPatch = partial.chat;
    if (
      chatPatch
      && typeof chatPatch === "object"
      && !Array.isArray(chatPatch)
      && Object.prototype.hasOwnProperty.call(chatPatch, "processingDisplayLevel")
      && !isProcessingDisplayLevel(chatPatch.processingDisplayLevel)
    ) {
      throw new SettingsPatchValidationError();
    }
    if (partial.permissions !== undefined && (!partial.permissions || typeof partial.permissions !== "object" || Array.isArray(partial.permissions) || Object.keys(partial.permissions).some((key) => key !== "ownerAwayAutoSkipMinutes") || !isOwnerAwayAutoSkipMinutes(partial.permissions.ownerAwayAutoSkipMinutes))) {
      throw new OwnerAwayAutoSkipSettingsError();
    }
    const previousSettings = this.getAll();
    const nextMarketplace = partial.marketplace
      ? normalizeMarketplace({
          ...this.settings.marketplace,
          ...partial.marketplace,
        })
      : this.settings.marketplace;
    if (partial.marketplace) {
      nextMarketplace.installedProviderPresets = preserveInstalledProviderPresetMetadata(
        this.settings.marketplace.installedProviderPresets,
        nextMarketplace.installedProviderPresets,
      );
    }
    const providerPresetSecretInvalidationIds = partial.marketplace
      ? marketplaceProviderPresetSecretInvalidationIds(
          this.settings.marketplace.installedProviderPresets,
          nextMarketplace.installedProviderPresets,
        )
      : [];
    if (partial.llm) {
      const nextLlm = mergeLlmPatch(
        this.settings.llm,
        partial.llm,
        nextMarketplace.installedProviderPresets,
      );
      if (getLlmVendorSettings(nextLlm.vendors, "openai-compatible").wire
        !== getLlmVendorSettings(this.settings.llm.vendors, "openai-compatible").wire) {
        for (const [key, entry] of Object.entries(nextLlm.modelListCache)) {
          if (entry.vendor === "openai-compatible" && !entry.credentialScope) delete nextLlm.modelListCache[key];
        }
      }
      if (Object.hasOwn(partial.llm, "compactionModel")) {
        const route = compactionModelRouteKey(nextLlm, nextMarketplace.installedProviderPresets);
        if (Object.hasOwn(partial.llm, "compactionModelRoute") && partial.llm.compactionModelRoute !== route) {
          throw new Error("Compaction provider route changed");
        }
        nextLlm.compactionModelRoute = route;
      }
      this.settings.llm = nextLlm;
      this.providerConfigChanged();
    }
    if (partial.chat) this.settings.chat = normalizeChat({ ...this.settings.chat, ...partial.chat });
    if (partial.a2aRemote) this.settings.a2aRemote = normalizeA2ARemote({ ...this.settings.a2aRemote, ...partial.a2aRemote });
    if (partial.webSearch) this.settings.webSearch = { ...this.settings.webSearch, ...partial.webSearch };
    if (partial.marketplace) {
      this.settings.marketplace = nextMarketplace;
      const normalizedLlm = mergeLlmPatch(
        this.settings.llm,
        {},
        nextMarketplace.installedProviderPresets,
      );
      this.settings.llm = normalizedLlm;
      this.settings.llm = withoutMarketplaceDefaultModels(
        this.settings.llm,
        nextMarketplace.installedProviderPresets,
        this.settings.appliedMigrations ??= [],
      );
      this.providerConfigChanged();
    }
    if (partial.routine) {
      this.settings.routine = { ...this.settings.routine, ...partial.routine };
    }
    if (partial.homeDocs) {
      // Field-level validation (mirrors `system`/`telemetry`): a non-boolean keepLatest read as truthy would move the user's
      // AGENTS.md into agents.custom.md on the next packaged update, which is a file move a malformed payload must not be able to trigger.
      const nextHomeDocs: HomeDocsSettings = { ...this.settings.homeDocs };
      acceptField(
        nextHomeDocs, "keepLatest", partial.homeDocs.keepLatest,
        isBooleanValue, "homeDocs", PATCHED_FIELD,
      );
      this.settings.homeDocs = nextHomeDocs;
    }
    if (partial.permissions) {
      this.settings.permissions = { ...this.settings.permissions, ownerAwayAutoSkipMinutes: partial.permissions.ownerAwayAutoSkipMinutes };
    }
    if (partial.privacy) {
      this.settings.privacy = { ...this.settings.privacy, ...partial.privacy };
    }
    if (partial.plugins) {
      this.settings.plugins = { ...this.settings.plugins, ...partial.plugins };
    }
    if (partial.updates) {
      this.settings.updates = { ...this.settings.updates, ...partial.updates };
    }
    if (partial.telemetry) {
      // Field-level validation (mirrors `system`/`diagnostics`). These fields decide whether the app talks to a remote host at all, so a malformed payload must not be able to
      // persist one; and an `enabled` that is not a boolean would be read as OFF by `enabled !== true`, silently meaning the opposite of what a truthy-looking value suggests.
      const nextTelemetry: TelemetrySettings = { ...this.settings.telemetry };
      acceptField(
        nextTelemetry, "enabled", partial.telemetry.enabled,
        isBooleanValue, "telemetry", PATCHED_FIELD,
      );
      acceptField(
        nextTelemetry, "crashReportingEnabled", partial.telemetry.crashReportingEnabled,
        isBooleanValue, "telemetry", PATCHED_FIELD,
      );
      acceptField(
        nextTelemetry, "telemetryPromptAnswered", partial.telemetry.telemetryPromptAnswered,
        isBooleanValue, "telemetry", PATCHED_FIELD,
      );
      for (const key of TELEMETRY_TEXT_KEYS) {
        acceptTelemetryText(nextTelemetry, key, partial.telemetry[key], PATCHED_FIELD);
      }
      this.settings.telemetry = nextTelemetry;
    }
    if (partial.audit) {
      this.settings.audit = { ...this.settings.audit, ...partial.audit };
    }
    if (partial.diagnostics) {
      // Field-level validation (mirrors `system`/`features`): an invalid includeCrashDumps or out-of-range logRetentionDays is coerced/dropped so a
      // malformed renderer/IPC payload can never persist an unsafe value. normalizeDiagnostics clamps retention to [1,365] and drops non-booleans.
      this.settings.diagnostics = normalizeDiagnostics({
        ...this.settings.diagnostics,
        ...partial.diagnostics,
      });
    }
    if (partial.appearance) {
      // Validate every appearance field at the write boundary and exclude it from the outer spread; malformed IPC must never persist until reload.
      // Deep-merge font fields so partial updates and null payloads cannot overwrite valid nested settings.
      const {
        font: fontPatch,
        bundleId: bundleIdPatch,
        schemaVersion: schemaVersionPatch,
        followSystem: followSystemPatch,
        ...appearanceRest
      } = partial.appearance as unknown as {
        font?: AppearanceFontSettings | null;
        bundleId?: unknown;
        schemaVersion?: unknown;
        followSystem?: unknown;
        [k: string]: unknown;
      };
      const nextAppearance: AppearanceSettings = {
        ...this.settings.appearance,
        ...(appearanceRest as Partial<AppearanceSettings>),
      };
      // schemaVersion is host-owned, not user data: this store only ever persists the v2 shape, so the stored
      // value is pinned to 2 regardless of what the caller claims. Migration from v1 happens on load, from disk.
      if (schemaVersionPatch !== undefined && schemaVersionPatch !== 2) {
        log.warn(
          `appearance.schemaVersion patch ignored (received ${JSON.stringify(schemaVersionPatch)}), keeping 2`,
        );
      }
      nextAppearance.schemaVersion = 2;
      // Same value set as the load path; `isThemeId` in shared/theme-bundles is the single source of truth for both.
      acceptField(nextAppearance, "bundleId", bundleIdPatch, isThemeId, "appearance", PATCHED_FIELD);
      acceptField(nextAppearance, "followSystem", followSystemPatch, isBooleanValue, "appearance", PATCHED_FIELD);
      // Validate the language patch at the trust boundary (mirrors the font validation below): a malformed renderer/IPC payload becomes
      // English. A well-formed tag no package provides yet is kept, because the content ledger is read after settings (see normalizeLocaleSetting).
      if ("language" in appearanceRest) {
        nextAppearance.language = normalizeLocaleSetting((appearanceRest as { language?: unknown }).language);
      }
      // Accept `font: undefined`, missing field, or `font: null`; all three mean "no font subfield patch in
      // this call". Guard against `null` so a defensive caller (or a malformed test fixture) cannot crash

      if (fontPatch !== undefined && fontPatch !== null && typeof fontPatch === "object") {
        const mergedFont: AppearanceFontSettings = { ...this.settings.appearance.font };
        if (typeof fontPatch.family === "string") {
          if (fontPatch.family === "system" || isValidFontFamilyOverride(fontPatch.family)) {
            mergedFont.family = fontPatch.family;
          }
          // else: drop silently; the cross-window broadcast still carries the validated post-merge value so listeners stay consistent.
        }
        if (typeof fontPatch.sizeScale === "number"
          && (FONT_SIZE_SCALE_VALUES as readonly number[]).includes(fontPatch.sizeScale)) {
          mergedFont.sizeScale = fontPatch.sizeScale as FontSizeScale;
        }
        nextAppearance.font = Object.keys(mergedFont).length > 0 ? mergedFont : undefined;
      }
      this.settings.appearance = nextAppearance;
    }
    if (partial.documents && typeof partial.documents === "object" && !Array.isArray(partial.documents)) {
      const nextDocuments = { ...this.settings.documents };
      acceptField(nextDocuments, "openMode", partial.documents.openMode, isDocumentOpenMode, "documents", PATCHED_FIELD);
      this.settings.documents = nextDocuments;
    }
    if (partial.webView) {
      // Field-level validation (mirrors `system`/`shortcuts`): an out-of-enum `preferredFlow` is dropped and the existing preference kept, instead of persisting a
      // value that only the *next* load would reject. The accepted value set is owned by `isWebViewPreferredFlow` so the load path and this path can never drift apart.
      const nextWebView: WebViewSettings = { ...this.settings.webView };
      const rawFlow = partial.webView.preferredFlow;
      acceptField(nextWebView, "preferredFlow", rawFlow, isWebViewPreferredFlow, "webView", PATCHED_FIELD);
      this.settings.webView = nextWebView;
    }
    if (partial.system) {
      // Field-level validation (mirrors `appearance` pattern): invalid `closeBehavior` is silently dropped so an existing valid preference is
      // not clobbered by a malformed renderer / IPC payload. The disk-load path's `normalizeSystem` still backfills missing fields with defaults.
      const next: SystemSettings = { ...this.settings.system };
      acceptField(next, "closeBehavior", partial.system.closeBehavior, isCloseBehavior, "system", PATCHED_FIELD);
      const rawLocalApi = partial.system.localApiServer;
      acceptField(next, "localApiServer", rawLocalApi, isBooleanValue, "system", PATCHED_FIELD);
      const rawHardwareAcceleration = partial.system.hardwareAcceleration;
      acceptField(next, "hardwareAcceleration", rawHardwareAcceleration, isBooleanValue, "system", PATCHED_FIELD);
      // Corporate CA group; same validate-at-the-boundary shape. The common name is the only one that is not a boolean, and it is the only value here that reaches a child
      // process (`security` on macOS, PowerShell on Windows), so a value that is not a name is dropped at this boundary rather than carried to the process that searches for it.
      const rawCorpCaEnabled = partial.system.corpCaEnabled;
      acceptField(next, "corpCaEnabled", rawCorpCaEnabled, isBooleanValue, "system", PATCHED_FIELD);
      const rawCorpCaDebugLog = partial.system.corpCaDebugLog;
      acceptField(next, "corpCaDebugLog", rawCorpCaDebugLog, isBooleanValue, "system", PATCHED_FIELD);
      const rawCorpCaCommonName = partial.system.corpCaCommonName;
      if (rawCorpCaCommonName !== undefined) {
        const normalized = normalizeCorpCaCommonName(rawCorpCaCommonName);
        if (normalized !== null) {
          next.corpCaCommonName = normalized;
        } else if (rawCorpCaCommonName === "") {
          // Clearing the field is a real choice: it means "use the default".
          next.corpCaCommonName = DEFAULT_CORP_CA_COMMON_NAME;
        } else {
          log.warn("system.corpCaCommonName patch ignored (not a usable certificate name)");
        }
      }
      acceptField(next, "turnCompletionSoundEnabled", partial.system.turnCompletionSoundEnabled, isBooleanValue, "system", PATCHED_FIELD);
      // Launch-at-startup + launch-minimized booleans (same validate-at- boundary pattern as localApiServer: invalid → keep prior value).
      const rawLaunchAtStartup = partial.system.launchAtStartup;
      acceptField(next, "launchAtStartup", rawLaunchAtStartup, isBooleanValue, "system", PATCHED_FIELD);
      const rawLaunchMinimized = partial.system.launchMinimized;
      acceptField(next, "launchMinimized", rawLaunchMinimized, isBooleanValue, "system", PATCHED_FIELD);
      acceptNormalizedField(
        next,
        "shutdownCleanupTimeoutMs",
        partial.system.shutdownCleanupTimeoutMs,
        normalizeShutdownCleanupTimeoutMs,
        "system",
        PATCHED_FIELD,
      );
      acceptNormalizedField(
        next, "sidePanelWidth", partial.system.sidePanelWidth,
        normalizeSidePanelWidth, "system", PATCHED_FIELD,
      );
      acceptNormalizedField(
        next, "sidebarWidth", partial.system.sidebarWidth,
        normalizeSidebarWidth, "system", PATCHED_FIELD,
      );
      acceptNormalizedField(
        next, "sidePanelFileTreeWidth", partial.system.sidePanelFileTreeWidth,
        normalizeFileTreeWidth, "system", PATCHED_FIELD,
      );
      // Per-tab vertical split percents; each normalized independently through the shared clamp so an
      // out-of-range or non-finite value is ignored while a valid sibling is preserved (mirrors the width path above).
      for (const key of SIDE_PANEL_SPLIT_KEYS) {
        acceptNormalizedField(
          next, key, partial.system[key],
          normalizeSidePanelSplitPercent, "system", PATCHED_FIELD,
        );
      }
      acceptField(next, "sidebarActiveTab", partial.system.sidebarActiveTab, isSidebarTab, "system", PATCHED_FIELD);
      acceptField(next, "sidebarState", partial.system.sidebarState, isSidebarState, "system", PATCHED_FIELD);
      acceptField(next, "activeView", partial.system.activeView, isActiveViewKey, "system", PATCHED_FIELD);
      // The reason only is logged on refusal (`normalizeMainLayout`): the value holds page addresses that may carry tokens. A refused patch keeps the saved layout.
      const patchedLayout = normalizeMainLayout(partial.system.mainLayout);
      if (patchedLayout) next.mainLayout = patchedLayout;
      const rawSettingsTab = partial.system.settingsTab;
      if (rawSettingsTab !== undefined) {
        // `normalizeSettingsTab` folds retired ids onto their replacements and anything unrecognized onto the default, so there is no "ignored" arm.
        next.settingsTab = normalizeSettingsTab(rawSettingsTab);
      }
      const rawArchivedProjectRoots = partial.system.archivedProjectRoots;
      if (Array.isArray(rawArchivedProjectRoots)) {
        next.archivedProjectRoots = normalizeProjectRootList(rawArchivedProjectRoots);
      } else if (rawArchivedProjectRoots !== undefined) {
        log.warn(
          `system.archivedProjectRoots patch ignored (received ${JSON.stringify(rawArchivedProjectRoots)}), keeping %s`,
          this.settings.system.archivedProjectRoots,
        );
      }
      if (partial.system.projectLabels !== undefined) {
        next.projectLabels = normalizeProjectLabels(partial.system.projectLabels);
      }
      const rawPinnedProjectRoots = partial.system.pinnedProjectRoots;
      if (Array.isArray(rawPinnedProjectRoots)) {
        next.pinnedProjectRoots = normalizeProjectRootList(rawPinnedProjectRoots);
      } else if (rawPinnedProjectRoots !== undefined) {
        log.warn(
          `system.pinnedProjectRoots patch ignored (received ${JSON.stringify(rawPinnedProjectRoots)}), keeping %s`,
          this.settings.system.pinnedProjectRoots,
        );
      }
      this.settings.system = next;
    }
    if (partial.shortcuts) {
      // Field-level validation: an invalid accelerator is dropped (previous value preserved) rather than clobbering the
      // existing binding; mirrors the `system`/`appearance` per-field patch discipline. `enabled` is a plain boolean gate.
      const nextShortcuts: ShortcutSettings = { ...this.settings.shortcuts };
      const rawToggle = partial.shortcuts.toggleWindow;
      if (rawToggle === null) {
        nextShortcuts.toggleWindow = null;
      } else if (rawToggle !== undefined) {
        const accel = normalizeAccelerator(rawToggle);
        if (accel !== null) {
          nextShortcuts.toggleWindow = accel;
        } else {
          log.warn(
            `shortcuts.toggleWindow patch ignored (received ${JSON.stringify(rawToggle)}), keeping %s`,
            this.settings.shortcuts.toggleWindow,
          );
        }
      }
      const rawEnabled = partial.shortcuts.enabled;
      acceptField(nextShortcuts, "enabled", rawEnabled, isBooleanValue, "shortcuts", PATCHED_FIELD);
      this.settings.shortcuts = nextShortcuts;
    }
    if (partial.pluginConfigs) {
      const sanitized: Record<string, PluginConfigRecord> = {};
      for (const [pluginId, config] of Object.entries(partial.pluginConfigs)) {
        const safePluginId = sanitizePluginConfigPluginId(pluginId);
        sanitized[safePluginId] = sanitizePluginConfig(config);
      }
      this.settings.pluginConfigs = { ...this.settings.pluginConfigs, ...sanitized };
    }
    if (partial.features) {
      this.settings.features = {
        ...this.settings.features,
        ...normalizeFeatureFlags(partial.features),
      };
    }
    await this.commitPresetKeyInvalidation(previousSettings, providerPresetSecretInvalidationIds);
    if (partial.permissions) {
      for (const listener of this.changeListeners.get("permissions") ?? []) {
        try { listener(); } catch (error) { log.warn({ error }, "settings change listener failed"); }
      }
    }
    return this.getAll();
  }

  async installMarketplaceProviderPreset(
    preset: MarketplaceInstalledProviderPreset,
  ): Promise<AppSettings> {
    const normalized = normalizeMarketplaceProviderPreset(preset);
    if (!normalized) {
      throw new Error("Invalid marketplace provider preset.");
    }
    const current = this.settings.marketplace.installedProviderPresets;
    return this.replaceMarketplaceProviderPresets([
      ...current.filter((item) => item.providerId !== normalized.providerId),
      normalized,
    ]);
  }

  async uninstallMarketplaceProviderPreset(providerId: string): Promise<AppSettings> {
    if (!isMarketplaceProviderPresetId(providerId)) {
      throw new Error("Invalid marketplace provider preset id.");
    }
    const current = this.settings.marketplace.installedProviderPresets;
    return this.replaceMarketplaceProviderPresets(
      current.filter((item) => item.providerId !== providerId),
    );
  }

  private async replaceMarketplaceProviderPresets(
    installedProviderPresets: readonly MarketplaceInstalledProviderPreset[],
  ): Promise<AppSettings> {
    return withInstalledStateMutation(async () => {
      const previousSettings = this.getAll();
      const nextMarketplace = normalizeMarketplace({
        ...this.settings.marketplace,
        installedProviderPresets,
      });
      const providerPresetSecretInvalidationIds = marketplaceProviderPresetSecretInvalidationIds(
        this.settings.marketplace.installedProviderPresets,
        nextMarketplace.installedProviderPresets,
      );
      this.settings.marketplace = nextMarketplace;
      const normalizedLlm = mergeLlmPatch(
        this.settings.llm,
        {},
        nextMarketplace.installedProviderPresets,
      );
      this.settings.llm = normalizedLlm;
      this.settings.llm = withoutMarketplaceDefaultModels(
        this.settings.llm,
        nextMarketplace.installedProviderPresets,
        this.settings.appliedMigrations ??= [],
      );
      this.providerConfigChanged();
      await this.commitPresetKeyInvalidation(previousSettings, providerPresetSecretInvalidationIds);
      return this.getAll();
    });
  }

  /** Save the change just made in memory, then delete the preset keys it invalidated (`providerIds`: presets that moved or went). Called
   * right after the change, so its part before the first await; the applied snapshot and the in-flight count; sees memory holding this change. */
  private async commitPresetKeyInvalidation(
    previousSettings: AppSettings,
    providerIds: readonly string[],
  ): Promise<void> {
    if (providerIds.length === 0) {
      await this.commit();
      return;
    }
    const appliedSettings = this.getAll();
    const keys = providerIds.map(marketplaceProviderPresetSecretKey);
    for (const key of keys) this.invalidatingSecretKeys.set(key, (this.invalidatingSecretKeys.get(key) ?? 0) + 1);
    this.secretStatesChanged(keys);
    try {
      await this.commit();
      await this.deleteMarketplaceProviderPresetSecretsAtomically(
        previousSettings,
        appliedSettings,
        providerIds,
      );
    } finally {
      for (const key of keys) {
        const left = (this.invalidatingSecretKeys.get(key) ?? 1) - 1;
        if (left > 0) {
          this.invalidatingSecretKeys.set(key, left);
        } else {
          this.invalidatingSecretKeys.delete(key);
          this.reenteredSecretKeys.delete(key);
          this.writtenReentries.delete(key);
        }
      }
      this.secretStatesChanged(keys);
    }
  }

  private async deleteMarketplaceProviderPresetSecretsAtomically(
    previousSettings: AppSettings,
    appliedSettings: AppSettings,
    providerIds: readonly string[],
  ): Promise<void> {
    try {
      await this.deleteMarketplaceProviderPresetSecrets(providerIds, appliedSettings);
    } catch (err) {
      // Atomic secret deletion leaves the old document intact on rejection; avoid reading encrypted secrets when encryption is unavailable.
      // Rollback only unchanged presets still bound to retained keys, preserving concurrent successful writes and withholding ambiguous keys.
      const presetIn = (settings: AppSettings, providerId: string) =>
        settings.marketplace.installedProviderPresets.find((preset) => preset.providerId === providerId);
      // A key entered again meanwhile belongs to the preset it was entered next to: it is never moved back, and stays usable while the preset is still that one.
      const restorable = providerIds.filter((providerId) =>
        !this.enteredForApplied(providerId, appliedSettings)
        && this.invalidatingSecretKeys.get(marketplaceProviderPresetSecretKey(providerId)) === 1
        && isDeepStrictEqual(presetIn(this.settings, providerId), presetIn(appliedSettings, providerId)));
      const withheldKeys: string[] = [];
      for (const providerId of providerIds) {
        if (restorable.includes(providerId)) continue;
        const key = marketplaceProviderPresetSecretKey(providerId);
        if (
          this.enteredForApplied(providerId, appliedSettings)
          && isDeepStrictEqual(this.reenteredSecretKeys.get(key), presetIn(this.settings, providerId))
        ) {
          continue;
        }
        this.withheldSecretKeys.add(key);
        withheldKeys.push(key);
      }
      this.secretStatesChanged(withheldKeys);
      // Until the old addresses are back on disk their keys are held back, so nothing that runs when a failed rollback puts memory back on the new addresses can pair them.
      const keys = restorable.map(marketplaceProviderPresetSecretKey);
      for (const key of keys) this.restoringSecretKeys.add(key);
      this.secretStatesChanged(keys);
      this.settings = restorable.length === providerIds.length && isDeepStrictEqual(this.settings, appliedSettings)
        ? previousSettings
        : withProviderPresetsFrom(this.settings, previousSettings, restorable);
      this.providerConfigChanged();
      await this.commit().then(
        () => {
          for (const key of keys) this.restoringSecretKeys.delete(key);
          this.secretStatesChanged(keys);
        },
        (rollbackErr: Error) => {
          log.warn(
            "settings rollback after provider preset secret deletion failure failed: %s",
            rollbackErr.message,
          );
          for (const key of keys) {
            this.restoringSecretKeys.delete(key);
            this.withheldSecretKeys.add(key);
          }
          this.secretStatesChanged(keys);
        },
      );
      throw err;
    }
  }

  /** Whether the key was entered again next to the preset this change applied. */
  private enteredForApplied(providerId: string, appliedSettings: AppSettings): boolean {
    const key = marketplaceProviderPresetSecretKey(providerId);
    return this.reenteredSecretKeys.has(key) && isDeepStrictEqual(
      this.reenteredSecretKeys.get(key),
      appliedSettings.marketplace.installedProviderPresets.find((preset) => preset.providerId === providerId),
    );
  }

  private async deleteMarketplaceProviderPresetSecrets(
    providerIds: readonly string[],
    appliedSettings: AppSettings,
  ): Promise<void> {
    // A key entered again next to the preset this change applied is that preset's; one entered next to another preset is not spared.
    const keys = providerIds
      .filter((providerId) => !this.enteredForApplied(providerId, appliedSettings))
      .map(marketplaceProviderPresetSecretKey);
    if (keys.length === 0) return;
    await this.secretStore.deleteMany(keys);
    this.secretStatesChanged(keys);
  }

  async replaceLlm(llm: LLMSettings): Promise<AppSettings> {
    const replacement = structuredClone(llm);
    this.settings.llm = {
      ...replacement,
      activeChatRuntime: normalizeActiveChatRuntime(replacement.activeChatRuntime),
    };
    this.providerConfigChanged();
    await this.commit();
    return this.getAll();
  }

  getPluginConfig(pluginId: string): PluginConfigRecord {
    const safePluginId = sanitizePluginConfigPluginId(pluginId);
    return structuredClone(this.settings.pluginConfigs[safePluginId] ?? {});
  }

  async setPluginConfig(pluginId: string, config: unknown): Promise<PluginConfigRecord> {
    const safePluginId = sanitizePluginConfigPluginId(pluginId);
    const sanitizedConfig = sanitizePluginConfig(config);
    this.settings.pluginConfigs = {
      ...this.settings.pluginConfigs,
      [safePluginId]: sanitizedConfig,
    };
    await this.commit();
    return structuredClone(sanitizedConfig);
  }

  async deletePluginConfig(pluginId: string): Promise<void> {
    const safePluginId = sanitizePluginConfigPluginId(pluginId);
    if (!(safePluginId in this.settings.pluginConfigs)) return;
    const next = { ...this.settings.pluginConfigs };
    delete next[safePluginId];
    this.settings.pluginConfigs = next;
    await this.commit();
  }

  /** Encrypt and store a secret value such as an API key. */
  async setSecret(key: string, value: string): Promise<void> {
    // Entered for the preset shown now, while an invalidation may be moving it: recorded at once,
    // so a rollback or deletion running while the key is written already leaves it with that preset.
    const invalidating = this.invalidatingSecretKeys.has(key);
    if (invalidating) {
      const enteredFor = this.settings.marketplace.installedProviderPresets.find(
        (preset) => marketplaceProviderPresetSecretKey(preset.providerId) === key,
      );
      this.reenteredSecretKeys.set(key, structuredClone(enteredFor));
      this.writtenReentries.delete(key);
      this.secretStateChanged(key);
    }
    try {
      await this.secretStore.set(key, value);
    } catch (err) {
      if (invalidating) {
        // The invalidation may have kept its preset, or skipped the old key, for this entry: whatever
        // the store holds now is not known to be that preset's, so it is withheld until entered again.
        this.reenteredSecretKeys.delete(key);
        this.withheldSecretKeys.add(key);
        this.secretStateChanged(key);
      }
      throw err;
    }
    this.withheldSecretKeys.delete(key);
    if (this.reenteredSecretKeys.has(key)) this.writtenReentries.add(key);
    // Bookkeeping can change readability after the store's file-swap notification.
    this.secretStateChanged(key);
  }

  /** Decrypt and return a stored secret value. */
  getSecret(key: string): string | null {
    if (this.isRetiredLlmCredential(key) || !this.secretReadable(key)) return null;
    try {
      return this.secretStore.get(key);
    } catch (err) {
      log.warn("secret read failed: %s", (err as Error).message);
      throw err;
    }
  }

  /** Security-sensitive consumers that must reject legacy `plain:` secret entries. */
  getEncryptedSecret(key: string): string | null {
    if (this.isRetiredLlmCredential(key) || !this.secretReadable(key)) return null;
    return this.secretStore.getEncrypted(key);
  }

  /** Settings may offer a saved credential for an explicit provider choice without retrieving it. */
  hasStoredSecret(key: string): boolean {
    return this.secretReadable(key) && this.secretStore.has(key);
  }

  async deleteSecret(key: string): Promise<void> {
    await this.secretStore.delete(key);
    this.withheldSecretKeys.delete(key);
    this.secretStateChanged(key);
  }

  private isRetiredLlmCredential(key: string): boolean {
    // Cover every host consumer before a credential is retrieved. An accepted provider choice releases this fence.
    return Boolean(this.settings.llm.retiredProvider)
      && (key.startsWith("llm.apiKey.") || key.startsWith("llm.marketplaceProvider."));
  }

  /** Whether a stored key may be handed out. A preset key being invalidated may be the old address's; only a
   * value entered again, written, and next to the preset it was entered for is read until the invalidation settles. */
  private secretReadable(key: string): boolean {
    if (this.withheldSecretKeys.has(key) || this.restoringSecretKeys.has(key)) return false;
    if (!this.invalidatingSecretKeys.has(key)) return true;
    return this.writtenReentries.has(key) && isDeepStrictEqual(
      this.reenteredSecretKeys.get(key),
      this.settings.marketplace.installedProviderPresets.find(
        (preset) => marketplaceProviderPresetSecretKey(preset.providerId) === key,
      ),
    );
  }

  /** Delete the withheld keys (see `withheldSecretKeys`). A key entered again while this runs may go too, which fails closed: it is asked for again. */
  private async deleteWithheldSecrets(): Promise<void> {
    const keys = [...this.withheldSecretKeys];
    try {
      await this.secretStore.deleteMany(keys);
      for (const key of keys) {
        this.withheldSecretKeys.delete(key);
      }
      this.secretStatesChanged(keys);
    } catch (err) {
      log.warn("withheld provider preset key deletion failed: %s", (err as Error).message);
    }
  }

  /** Whether a secret written now would actually be encrypted at rest. A surface that stores a user credential
   * must check this before offering to, rather than discovering it as a failure after the user has committed. */
  isSecretStorageEncrypted(): boolean {
    return this.secretStore.canStoreEncrypted();
  }

  async deletePluginSecrets(pluginId: string, keys: Iterable<string>): Promise<number> {
    const safePluginId = sanitizePluginConfigPluginId(pluginId);
    const storageKeys: string[] = [];
    for (const key of keys) {
      const safeKey = sanitizePluginConfigKey(key);
      storageKeys.push(`plugin.${safePluginId}.${safeKey}`);
    }
    const deleted = await this.secretStore.deleteMany(storageKeys);
    this.secretStatesChanged(storageKeys);
    return deleted;
  }

  // Historical note: hasApiKey() only checked the single `llm.apiKey` key, while the IPC handler uses vendor-specific `llm.apiKey.<vendor>`
  // secrets. Keep callers on the explicit `getSecret(...)` path so future vendor checks cannot accidentally return false for configured credentials.

  private loadSettings(appVersion: string | undefined, systemLocale: string | undefined): { settings: AppSettings; writeBack: boolean } {
    if (!existsSync(this.settingsPath)) {
      const defaults = structuredClone(DEFAULT_SETTINGS);
      const locale = normalizeLocale(systemLocale);
      defaults.appearance.language = isDefaultVisibleLocale(locale) ? locale : DEFAULT_LOCALE;
      defaults.appliedMigrations = [...KNOWN_MIGRATIONS];
      return { settings: defaults, writeBack: false };
    }
    try {
      const raw = readFileSync(this.settingsPath, "utf-8");
      const rawParsed = JSON.parse(raw) as unknown;
      const stored = rawParsed !== null && typeof rawParsed === "object" && !Array.isArray(rawParsed)
        ? rawParsed as Record<string, any>
        : {};
      const appliedMigrations = Array.isArray(stored.appliedMigrations)
        ? stored.appliedMigrations.filter((m): m is string => typeof m === "string")
        : [];
      let migrationWriteBack = false;
      // The retired percent is consumed by normalizeSystem, then the next save retains only the pixel width.
      if (stored.system !== null && typeof stored.system === "object"
        && Object.hasOwn(stored.system, "sidePanelSplitFilePercent")) migrationWriteBack = true;

      // The system normalizer drops the removed field; persist that cleanup once so it also leaves the saved file.
      if (!appliedMigrations.includes(SYSTEM_APP_MODE_REMOVED_MIGRATION)) {
        appliedMigrations.push(SYSTEM_APP_MODE_REMOVED_MIGRATION);
        migrationWriteBack = true;
      }

      // One-time rename of built-in vendor ids. It has to rewrite the file as read, ahead of everything below: each normalizer drops a vendor id this build does not know.
      let parsed = stored;
      if (!appliedMigrations.includes(LLM_VENDOR_ID_PACKAGE_NAMES_MIGRATION)) {
        parsed = withRenamedLlmVendorIds(stored, RENAMED_LLM_VENDOR_IDS);
        appliedMigrations.push(LLM_VENDOR_ID_PACKAGE_NAMES_MIGRATION);
        migrationWriteBack = true;
      }

      const withoutFossils = withoutFossilOutputTokenLimits(parsed);
      if (withoutFossils.changed) {
        parsed = withoutFossils.stored;
        migrationWriteBack = true;
      }

      const currentBaseUrls = withCurrentVendorBaseUrls(parsed);
      if (currentBaseUrls.changed) {
        parsed = currentBaseUrls.stored;
        migrationWriteBack = true;
      }

      const rawLlm = parsed.llm;
      const storedCustom = rawLlm?.vendors?.["openai-compatible"];
      if (storedCustom && !Object.hasOwn(storedCustom, "wire")) migrationWriteBack = true;
      let llm = mergeLlmPatch(
        DEFAULT_SETTINGS.llm,
        rawLlm !== null && typeof rawLlm === "object" && !Array.isArray(rawLlm)
          ? rawLlm as LLMSettingsPatch
          : {},
        undefined,
      );
      // Clear before retirement detection: the old built-in model alone must not keep an otherwise unconfigured route.
      if (!appliedMigrations.includes(BUILT_IN_DEFAULT_MODELS_CLEARED_MIGRATION)) {
        llm = withoutBuiltInDefaultModels(llm);
        appliedMigrations.push(BUILT_IN_DEFAULT_MODELS_CLEARED_MIGRATION);
        migrationWriteBack = true;
      }
      // A profile still naming a removed vendor (RETIRED_LLM_VENDOR_IDS): the merge above has already moved `provider` to the default, because
      // the id is no longer a vendor. Record the move so it is not silent, and keep a marker from an earlier load until the user picks a provider.
      const retiredProvider = retiredLlmProviderOf(rawLlm);
      if (retiredProvider) {
        llm = { ...llm, retiredProvider };
        if (isRetiredLLMVendor((rawLlm as { provider?: unknown }).provider)) migrationWriteBack = true;
      } else {
        const retiredModel = retiredLlmModelOf(llm);
        if (retiredModel) llm = { ...llm, retiredProvider: retiredModel };
      }
      const marketplaceParsed: Record<string, unknown> = { ...(parsed.marketplace ?? {}) };
      // One-time: drop the server marketplace's settings and write the file back, so they leave settings.json rather than only this process.
      if (!appliedMigrations.includes(MARKETPLACE_SERVER_SETTINGS_REMOVED_MIGRATION)) {
        for (const key of RETIRED_MARKETPLACE_SETTING_KEYS) delete marketplaceParsed[key];
        appliedMigrations.push(MARKETPLACE_SERVER_SETTINGS_REMOVED_MIGRATION);
        migrationWriteBack = true;
      }
      const pluginConfigs = sanitizeStoredPluginConfigs(parsed.pluginConfigs);
      // Unknown routine keys are preserved in storage but never read by current code.
      const normalizedRoutine: RoutineSettings = {
        ...(parsed.routine as Record<string, unknown> | undefined ?? {}),
      };

      const onDisk = parsed.appearance as Record<string, unknown> | null | undefined;
      // Detect v1 (legacy tri-axis) to trigger write-back after constructor.
      const needsV2WriteBack = !!onDisk && typeof onDisk === "object" &&
        onDisk.schemaVersion !== 2 &&
        (typeof onDisk.theme === "string" || typeof onDisk.chatTheme === "string" || typeof onDisk.codeTheme === "string");

      const marketplace = normalizeMarketplace(marketplaceParsed);
      const normalizedLlm = mergeLlmPatch(
        llm,
        {},
        marketplace.installedProviderPresets,
      );
      llm = normalizedLlm;

      const appearance = normalizeAppearance(parsed.appearance);

      // One-time migration: un-fossilize subAgentAutonomousWake. saveSettings() writes the merged settings; defaults included; back to disk, so installs from the era when this flag defaulted to false carry an explicit `false` the user never chose, and the later default flip to `true` can never reach
      // them (explicit false beats the default merge below). Drop exactly that fossil once. A `false` written AFTER this migration ran is a real opt-out and sticks, because the marker suppresses any re-run. Remove this block (and the marker constant) once no pre-flip installs remain; target 2026-10.
      let normalizedFeatures = normalizeFeatureFlags(parsed.features);
      if (!appliedMigrations.includes(SUBAGENT_WAKE_DEFAULT_FLIP_MIGRATION)) {
        if (normalizedFeatures.subAgentAutonomousWake === false) {
          delete normalizedFeatures.subAgentAutonomousWake;
        }
        appliedMigrations.push(SUBAGENT_WAKE_DEFAULT_FLIP_MIGRATION);
        migrationWriteBack = true;
      }

      // The sandbox split: `osToolSandbox` used to confine shells AND workers. Written back, so the worker side
      // of an existing opt-in is the user's own value from here on and a later shell default flip cannot reach it.
      const split = withPluginWorkerConfinementSplit(normalizedFeatures);
      if (split.changed) {
        normalizedFeatures = split.features;
        migrationWriteBack = true;
      }

      // One-time cleanup: the generic openai-compatible row's endpoint used to be overwritten with the active marketplace preset's address.
      // Nothing writes that any more, but an install from before the change still carries it, and it would read as the generic row's own saved endpoint.
      if (!appliedMigrations.includes(PROVIDER_PRESET_ENDPOINT_UNMIRROR_MIGRATION)) {
        llm = withoutMirroredMarketplaceProviderPresetEndpoint(
          llm,
          marketplace.installedProviderPresets,
        );
        appliedMigrations.push(PROVIDER_PRESET_ENDPOINT_UNMIRROR_MIGRATION);
        migrationWriteBack = true;
      }

      // One-time split: the openai-compatible block's single `model` used to be shared by the generic custom-provider row and
      // every marketplace preset reached through that vendor. The stored value belongs to whichever row this install is actually on.
      if (!appliedMigrations.includes(PROVIDER_PRESET_MODEL_SLOT_MIGRATION)) {
        llm = withMarketplaceProviderPresetModelSlot(llm);
        appliedMigrations.push(PROVIDER_PRESET_MODEL_SLOT_MIGRATION);
        migrationWriteBack = true;
      }

      const migrationsBeforeMarketDefaults = appliedMigrations.length;
      llm = withoutMarketplaceDefaultModels(
        llm,
        marketplace.installedProviderPresets,
        appliedMigrations,
        rawLlm?.vendors?.["openai-compatible"]?.presetModels,
      );
      if (appliedMigrations.length !== migrationsBeforeMarketDefaults) migrationWriteBack = true;

      const result: AppSettings = {
        llm,
        chat: normalizeChat(parsed.chat),
        a2aRemote: normalizeA2ARemote(parsed.a2aRemote),
        webSearch: { ...DEFAULT_SETTINGS.webSearch, ...parsed.webSearch },
        marketplace,
        routine: normalizedRoutine,
        homeDocs: normalizeHomeDocs(parsed.homeDocs),
        permissions: {
          ownerAwayAutoSkipMinutes: isOwnerAwayAutoSkipMinutes(parsed.permissions?.ownerAwayAutoSkipMinutes)
            ? parsed.permissions.ownerAwayAutoSkipMinutes : DEFAULT_OWNER_AWAY_AUTO_SKIP_MINUTES,
        },
        privacy: { ...DEFAULT_SETTINGS.privacy, ...parsed.privacy },
        updates: { ...DEFAULT_SETTINGS.updates, ...parsed.updates },
        telemetry: normalizeTelemetry(parsed.telemetry),
        audit: { ...DEFAULT_SETTINGS.audit, ...parsed.audit },
        upstreamProxy: normalizeUpstreamProxy(parsed.upstreamProxy),
        diagnostics: normalizeDiagnostics(parsed.diagnostics),
        appearance,
        webView: normalizeWebView(parsed.webView),
        documents: normalizeDocuments(parsed.documents),
        system: normalizeSystem(parsed.system),
        shortcuts: normalizeShortcuts(parsed.shortcuts, DEFAULT_SETTINGS.shortcuts),
        plugins: {},
        pluginConfigs: { ...DEFAULT_SETTINGS.pluginConfigs, ...pluginConfigs },
        alerts: normalizeAlertSettings(parsed.alerts, appVersion),
        retiredPluginConfigs: normalizeRetiredPluginConfigs(parsed.retiredPluginConfigs),
        features: { ...DEFAULT_SETTINGS.features, ...normalizedFeatures },
        appliedMigrations,
      };
      return { settings: result, writeBack: needsV2WriteBack || migrationWriteBack };
    } catch (error) {
      if (error instanceof LlmProviderSettingsError) throw error;
      const defaults = structuredClone(DEFAULT_SETTINGS);
      defaults.appliedMigrations = [...KNOWN_MIGRATIONS];
      return { settings: defaults, writeBack: false };
    }
  }

  /** Save the change the caller just made in memory. A change applies to memory when the call is made, so a read and the write built from it stay atomic. Saves run one at a time, each writing memory as it is when the save starts; changes made while one waits on the file lock go
   * in the next. When a save fails, memory returns to what is on disk and every write not on disk fails with it; the failed save's and the ones made on top of it; so the process never runs on settings that are not on disk, and no write reports success for a change that is gone. */
  private commit(): Promise<void> {
    const done = new Promise<void>((resolve, reject) => {
      this.unsaved.push({ resolve, reject });
    });
    void this.drain();
    return done;
  }

  private async drain(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      while (this.unsaved.length > 0) {
        const batch = this.unsaved.splice(0);
        const snapshot = this.getAll();
        try {
          await this.saveSettings(snapshot);
          this.saved = snapshot;
          if (this.withheldSecretKeys.size > 0) void this.deleteWithheldSecrets();
          for (const write of batch) write.resolve();
        } catch (err) {
          this.settings = structuredClone(this.saved);
          this.providerConfigChanged();
          for (const write of [...batch, ...this.unsaved.splice(0)]) write.reject(err);
        }
      }
    } finally {
      this.saving = false;
    }
  }

  private async saveSettings(settings: AppSettings): Promise<void> {
    writeUtf8FileAtomicSync(this.settingsPath, JSON.stringify(settings, null, 2));
  }

}

/** Merge a partial LLM patch onto a base settings block. Per-vendor entries inside `partial.vendors` are deep-merged with the corresponding existing block, materializing only the providers touched by the user or selected as active. The long-tail provider
 * defaults live in `LLM_VENDOR_DEFAULTS` and are read through `getLlmVendorSettings()` instead of being persisted for every fresh install. Unknown vendor ids in `partial.vendors` are ignored; the active provider must be one of LLM_VENDORS, validated below. */
