import type { ActiveChatModel } from "../../../shared/active-chat-model.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVendorOption } from "../constants.js";
import { llmRouteModel } from "../../../shared/llm-vendor-defaults.js";
import type { AppSettings, AveApi } from "../types.js";
import {
  canUseLlmVendorWithoutApiKey,
  DEFAULT_LLM_VENDOR,
  getLlmVendorSettings,
  narrowLlmVendor,
  isLLMVendor,
  isLlmRouteRetirement,
  isRetiredLlmModelMarker,
  type LLMVendor,
  type LlmRouteRetirement,
} from "../../../shared/llm-vendor-defaults.js";
import {
  DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
  isSubscriptionRuntimeId,
  subscriptionRuntimeDescriptor,
  type SubscriptionChatRuntimeSelection,
  type SubscriptionRuntimeCapabilities,
  type SubscriptionRuntimeId,
} from "../../../shared/subscription-runtime.js";
import { selectSubscriptionRuntimeUiPolicy, type SubscriptionRuntimeUiPolicy } from "../utils/subscription-runtime-ui-policy.js";
import {
  llmRouteCatalogAddress,
  resolveContextWindowForRoute,
  resolveModelRetirement,
  resolveRouteModelRetirement,
  type ResolvedOutputTokenLimit,
  type RouteInputModalities,
} from "../../../shared/context-budget.js";
import { llmModelListCacheKey, type LlmModelListCacheEntry } from "../../../shared/llm-model-list.js";
import type { ModelPricingRoute } from "../../../shared/model-pricing.js";
import { syncPricingOverrides } from "./use-pricing-overrides.js";
import { DEFAULT_LLM_OUTPUT_TOKEN_LIMIT } from "../../../shared/model-host-policy.js";
import {
  DEFAULT_PROCESSING_DISPLAY_LEVEL,
  type ProcessingDisplayLevel,
} from "../../../shared/processing-display-level.js";

function canUseSettingsWithoutApiKey(
  settings: Awaited<ReturnType<AveApi["getSettings"]>>,
  provider: LLMVendor,
): boolean {
  const block = getLlmVendorSettings(settings.llm.vendors, provider);
  if (provider === "openai-compatible" && settings.llm.marketplaceProviderPresetId) {
    const preset = settings.marketplace?.installedProviderPresets?.find(
      (entry) => entry.providerId === settings.llm.marketplaceProviderPresetId,
    );
    const baseUrl = block.baseUrl?.trim() || preset?.baseUrl?.trim();
    return Boolean(
      preset &&
      preset.requiresApiKey === false &&
      baseUrl,
    );
  }
  return canUseLlmVendorWithoutApiKey(provider, block);
}

/** Settings arrive over IPC, so narrow the selected runtime before it can influence renderer readiness or attachment egress
 * policy. */
function activeSubscriptionRuntimeFromSettings(
  settings: Awaited<ReturnType<AveApi["getSettings"]>>,
): SubscriptionChatRuntimeSelection | null {
  const activeRuntime = settings.llm.activeChatRuntime;
  if (activeRuntime?.kind !== "subscription" || !isSubscriptionRuntimeId(activeRuntime.provider)) {
    return null;
  }
  const model = typeof activeRuntime.model === "string" ? activeRuntime.model.trim() : "";
  return model.length > 0
    ? { kind: "subscription", provider: activeRuntime.provider, model }
    : { kind: "subscription", provider: activeRuntime.provider };
}

function sameSubscriptionRuntime(
  left: SubscriptionChatRuntimeSelection | null,
  right: SubscriptionChatRuntimeSelection | null,
): boolean {
  return left?.provider === right?.provider
    && left?.model === right?.model;
}

/** LLM settings cache hook. Centralises the chat-input-bar's read-through cache of LLM provider/model/ thinking state.
 * Settings broadcasts are authoritative so provider changes and marketplace installs take effect without a restart. */
export interface UseSettingsResult {
  /** Cached provider — narrowed to the LLMVendor union. */
  llmVendor: LLMVendor;
  /** Cached model id. */
  llmModel: string;
  /**
   * The active route's context window, resolved once from the settings
   * snapshot through `resolveContextWindowForRoute` — the same number the
   * engine budgets compaction against. The context-fill ring divides by it
   * rather than resolving it a second time.
   */
  llmContextWindow: number;
  /** The active route's output limit — requested, the model's ceiling, and the effective value a request carries — from the
   * same resolution as the window, so the cost estimate assumes the limit the engine sends. */
  llmOutputTokenLimit: ResolvedOutputTokenLimit;
  /** The active route's prompt cap, when one is stated below the window (`resolveContextWindowForRoute(...).inputLimit`). The
   * ring's usable budget is bounded by it, as the engine's compaction threshold is. */
  llmInputLimit: number | undefined;
  autoCompactEnabled: boolean | undefined;
  /** The active route's endpoint and the prices its own `/models` answer reported, for the pre-send estimate
   * (`resolveModelPricing`'s route), so it prices a request as the engine records it. */
  llmRoutePricing: ModelPricingRoute;
  /**
   * The active route's input modalities, as its endpoint or the catalog states
   * them (`resolveContextWindowForRoute(...).inputModalities`), for the image
   * gate (`supportsVision(vendor, model, route)`). `undefined` until settings
   * have resolved; a route whose modalities nobody states carries none, and
   * the image gate refuses images for it.
   */
  llmRouteModalities: RouteInputModalities | undefined;
  /** True after an authoritative settings snapshot has been applied. */
  settingsLoaded: boolean;
  /**
   * Main's answer to which model chat is on (`RendererSettingsSnapshot`),
   * null until the first snapshot lands. `kind: "none"` is a first-class
   * state: `llmModel` may still hold the vendor default, but nothing chose it
   * and no route can answer on it.
   */
  activeChatModel: ActiveChatModel | null;
  /** Cached `enableThinking` flag for the active vendor. */
  enableThinkingChat: boolean;
  /** User-selected detail shown inside transcript work groups. */
  processingDisplayLevel: ProcessingDisplayLevel;
  /** True when the active vendor can run with no stored API key. */
  llmReadyWithoutApiKey: boolean;
  /** The removed vendor the stored profile was moved off, or the retired model it names, until the user picks in Settings.
   * API-key chat is not ready while it is set. */
  retiredLlmProvider: LlmRouteRetirement | null;
  /** The active API route's saved model when the catalog marks it deprecated and nothing retired the route (design
   * `model-capability-catalog.md` §6.1). Chat keeps working on it; the window only says it is going away. */
  deprecatedLlmModel: string | null;
  /** Single source of truth for selected subscription chat and attachment UX. */
  subscriptionRuntimePolicy: SubscriptionRuntimeUiPolicy;
  /** Active subscription runtime after untrusted settings boundary validation. */
  activeSubscriptionRuntime: SubscriptionChatRuntimeSelection | null;
  /** Whether the active subscription runtime has explicitly verified chat support. */
  subscriptionChatReady: boolean | null;
  /** Whether the active subscription runtime has explicitly verified raw image input support. */
  subscriptionImagesReady: boolean | null;
  /** Whether the active subscription runtime has explicitly verified file attachment support. */
  subscriptionFilesReady: boolean | null;
  /** Re-read settings from disk (call after SettingsContent save). */
  refresh: () => Promise<void>;
  /** Persist + optimistically update the thinking toggle. */
  toggleThinking: (next: boolean) => Promise<void>;
}

/** Before the first snapshot: the host default, unclamped (nothing estimates until settings load). */
const INITIAL_OUTPUT_TOKEN_LIMIT: ResolvedOutputTokenLimit = {
  requested: DEFAULT_LLM_OUTPUT_TOKEN_LIMIT,
  requestedSource: "host-default",
  effective: DEFAULT_LLM_OUTPUT_TOKEN_LIMIT,
  effectiveSource: "host-default",
};

export function useSettings(api: AveApi): UseSettingsResult {
  const [llmVendor, setLlmVendor] = useState<LLMVendor>(DEFAULT_LLM_VENDOR);
  const [llmModel, setLlmModel] = useState<string>("");
  const [llmContextWindow, setLlmContextWindow] = useState<number>(0);
  const [llmOutputTokenLimit, setLlmOutputTokenLimit] = useState<ResolvedOutputTokenLimit>(INITIAL_OUTPUT_TOKEN_LIMIT);
  const [llmInputLimit, setLlmInputLimit] = useState<number | undefined>(undefined);
  const [autoCompactEnabled, setAutoCompactEnabled] = useState<boolean | undefined>(undefined);
  const [llmRoutePricing, setLlmRoutePricing] = useState<ModelPricingRoute>({});
  const [llmRouteModalities, setLlmRouteModalities] = useState<UseSettingsResult["llmRouteModalities"]>(undefined);
  const [enableThinkingChat, setEnableThinkingChat] = useState<boolean>(true);
  const [processingDisplayLevel, setProcessingDisplayLevel] = useState<ProcessingDisplayLevel>(
    DEFAULT_PROCESSING_DISPLAY_LEVEL,
  );
  const [llmReadyWithoutApiKey, setLlmReadyWithoutApiKey] = useState(false);
  const [retiredLlmProvider, setRetiredLlmProvider] = useState<LlmRouteRetirement | null>(null);
  const [deprecatedLlmModel, setDeprecatedLlmModel] = useState<string | null>(null);
  const [activeSubscriptionRuntime, setActiveSubscriptionRuntime] =
    useState<SubscriptionChatRuntimeSelection | null>(null);
  const [subscriptionRuntimeCapabilities, setSubscriptionRuntimeCapabilities] =
    useState<SubscriptionRuntimeCapabilities | null>(null);
  const [subscriptionRuntimeProvableOnUse, setSubscriptionRuntimeProvableOnUse] = useState(false);
  const [subscriptionStatusRevision, setSubscriptionStatusRevision] = useState(0);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [activeChatModel, setActiveChatModel] = useState<ActiveChatModel | null>(null);
  // Guard late callbacks firing after unmount (matches pattern in renderer.tsx where this state lived before the hook
  // extraction).
  const isMountedRef = useRef(true);
  const snapshotRevisionRef = useRef(0);
  const activeSubscriptionRuntimeRef = useRef<SubscriptionChatRuntimeSelection | null>(null);
  const subscriptionStatusRequestRef = useRef(0);
  const subscriptionStatusRevisionByProviderRef = useRef(new Map<string, number>());
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const applySettingsSnapshot = useCallback(
    (settings: Awaited<ReturnType<AveApi["getSettings"]>>) => {
      if (!isMountedRef.current) return;
      const provider = narrowLlmVendor(settings.llm.provider);
      const block = getLlmVendorSettings(settings.llm.vendors, provider);
      setLlmVendor(provider);
      setActiveChatModel((current) =>
        JSON.stringify(current) === JSON.stringify(settings.activeChatModel) ? current : settings.activeChatModel);
      const routeModel = llmRouteModel(
        block,
        provider === "openai-compatible" ? settings.llm.marketplaceProviderPresetId : undefined,
      );
      setLlmModel(routeModel);
      const route = resolveContextWindowForRoute(
        { ...settings.llm, provider },
        settings.marketplace?.installedProviderPresets,
      );
      // A saved price correction arrives as a settings snapshot; the list in force is main's answer, which the environment can
      // override.
      void syncPricingOverrides(api).catch((error: unknown) => {
        console.error("[use-settings] pricing overrides could not be read", error);
      });
      setLlmContextWindow(route.contextWindow);
      setLlmOutputTokenLimit(route.output);
      setLlmInputLimit(route.inputLimit);
      const nextRoutePricing: ModelPricingRoute = {
        ...(route.baseUrl !== undefined ? { baseUrl: route.baseUrl } : {}),
        ...(route.reportedPricing !== undefined ? { reported: route.reportedPricing } : {}),
      };
      // Content-compared: every settings broadcast resolves a fresh object, and a new identity would re-render every chat tile
      // for the same route.
      setLlmRoutePricing((current) =>
        JSON.stringify(current) === JSON.stringify(nextRoutePricing) ? current : nextRoutePricing);
      setLlmRouteModalities(route.inputModalities !== undefined ? { inputModalities: route.inputModalities } : {});
      setEnableThinkingChat(block.enableThinking);
      setProcessingDisplayLevel(
        settings.chat.processingDisplayLevel ?? DEFAULT_PROCESSING_DISPLAY_LEVEL,
      );
      setLlmReadyWithoutApiKey(canUseSettingsWithoutApiKey(settings, provider));
      setAutoCompactEnabled(settings.chat.autoCompact);
      const retiredRoute = isLlmRouteRetirement(settings.llm.retiredProvider) ? settings.llm.retiredProvider : null;
      setRetiredLlmProvider(retiredRoute);
      // The deprecated tier is the catalog's word alone; a listing that lands mid-session is judged by the next load, which may
      // block the route.
      const deprecated = retiredRoute === null && routeModel !== ""
        && resolveRouteModelRetirement(
          { ...settings.llm, provider, modelListCache: undefined },
          settings.marketplace?.installedProviderPresets,
        ) === "catalog-deprecated";
      setDeprecatedLlmModel(deprecated ? routeModel : null);
      const nextSubscriptionRuntime = activeSubscriptionRuntimeFromSettings(settings);
      const runtimeChanged = !sameSubscriptionRuntime(
        activeSubscriptionRuntimeRef.current,
        nextSubscriptionRuntime,
      );
      activeSubscriptionRuntimeRef.current = nextSubscriptionRuntime;
      setActiveSubscriptionRuntime((current) =>
        sameSubscriptionRuntime(current, nextSubscriptionRuntime) ? current : nextSubscriptionRuntime,
      );
      if (runtimeChanged) {
        subscriptionStatusRequestRef.current += 1;
        setSubscriptionRuntimeCapabilities(null);
        setSubscriptionRuntimeProvableOnUse(false);
      }
      setSettingsLoaded(true);
    },
    [api],
  );

  const refresh = useCallback(async () => {
    const revisionAtReadStart = snapshotRevisionRef.current;
    try {
      const settings = await api.getSettings();
      if (revisionAtReadStart !== snapshotRevisionRef.current) return;
      applySettingsSnapshot(settings);
    } catch {
      /* ignore */
    }
  }, [api, applySettingsSnapshot]);

  // Subscribe before the initial read so a cross-window update cannot be missed between getSettings() and listener
  // registration. The revision guard prevents a slow initial read from overwriting a newer broadcast snapshot.
  useEffect(() => {
    const unsubscribe = api.onSettingsUpdated((settings) => {
      snapshotRevisionRef.current += 1;
      applySettingsSnapshot(settings);
    });
    const revisionAtReadStart = snapshotRevisionRef.current;
    void api
      .getSettings()
      .then((settings) => {
        if (revisionAtReadStart !== snapshotRevisionRef.current) return;
        applySettingsSnapshot(settings);
      })
      .catch(() => {});
    return unsubscribe;
  }, [api, applySettingsSnapshot]);

  useEffect(() => {
    return api.onSubscriptionRuntimeStatusUpdated((event) => {
      const activeRuntime = activeSubscriptionRuntimeRef.current;
      if (!activeRuntime || activeRuntime.provider !== event.provider) return;
      const previousRevision =
        subscriptionStatusRevisionByProviderRef.current.get(event.provider) ?? 0;
      if (event.revision <= previousRevision) return;
      subscriptionStatusRevisionByProviderRef.current.set(event.provider, event.revision);
      // Invalidate synchronously before React schedules the re-probe. A status response that was already in flight must not put
      // stale capabilities back after logout, login, verification, or a runtime reconfiguration.
      subscriptionStatusRequestRef.current += 1;
      setSubscriptionRuntimeCapabilities(null);
      setSubscriptionRuntimeProvableOnUse(false);
      setSubscriptionStatusRevision(event.revision);
    });
  }, [api]);

  useEffect(() => {
    if (!activeSubscriptionRuntime) {
      subscriptionStatusRequestRef.current += 1;
      setSubscriptionRuntimeCapabilities(null);
      setSubscriptionRuntimeProvableOnUse(false);
      return;
    }

    const requestId = ++subscriptionStatusRequestRef.current;
    setSubscriptionRuntimeCapabilities(null);
    setSubscriptionRuntimeProvableOnUse(false);
    void api.subscriptionRuntimeStatus(activeSubscriptionRuntime.provider)
      .then((result) => {
        if (!isMountedRef.current || requestId !== subscriptionStatusRequestRef.current) return;
        if (
          result.ok !== true
          || result.status.provider !== activeSubscriptionRuntime.provider
        ) {
          setSubscriptionRuntimeCapabilities(DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES);
          return;
        }
        setSubscriptionRuntimeProvableOnUse(result.status.runtime === "ready" && result.status.connection === "connected");
        setSubscriptionRuntimeCapabilities(
          result.status.capabilities ?? DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
        );
      })
      .catch(() => {
        if (isMountedRef.current && requestId === subscriptionStatusRequestRef.current) {
          setSubscriptionRuntimeCapabilities(DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES);
        }
      });
  }, [api, activeSubscriptionRuntime, subscriptionStatusRevision]);

  const toggleThinking = useCallback(
    async (next: boolean) => {
      // A subscription runtime owns its own effort controls. The renderer can
      // momentarily still hold API defaults while the authoritative settings
      // snapshot is loading, so do not let an old slider write to the inactive
      // API vendor during that window.
      if (!settingsLoaded || activeSubscriptionRuntimeRef.current !== null) return;
      try {
        const s = await api.getSettings();
        // The fresh disk snapshot and live broadcast ref must both still agree that API-key chat is active before writing an
        // API-vendor preference.
        if (
          activeSubscriptionRuntimeFromSettings(s) !== null
          || activeSubscriptionRuntimeRef.current !== null
        ) {
          return;
        }
        // Narrow before constructing the patch key. If `s.llm.provider`
        // is stale/corrupt (a since-removed vendor name), `mergeLlmPatch` would skip
        // the unknown vendor entry and the toggle would silently no-op.
        // The narrower's `DEFAULT_LLM_VENDOR` fallback guarantees the
        // update lands somewhere valid; if the user is actively on a
        // different vendor, the next settings load will re-narrow and
        // the toggle re-targets correctly.
        const provider = narrowLlmVendor(s.llm.provider);
        setEnableThinkingChat(next);
        await api.updateSettings({
          llm: { vendors: { [provider]: { enableThinking: next } } },
        });
      } catch {
        /* ignore */
      }
    },
    [api, settingsLoaded],
  );

  const subscriptionRuntimePolicy = useMemo(
    () => selectSubscriptionRuntimeUiPolicy({
      activeSubscriptionRuntime,
      settingsLoaded,
      capabilities: subscriptionRuntimeCapabilities,
      provableOnUse: subscriptionRuntimeProvableOnUse,
    }),
    [activeSubscriptionRuntime, settingsLoaded, subscriptionRuntimeCapabilities, subscriptionRuntimeProvableOnUse],
  );

  return {
    llmVendor,
    llmModel,
    llmContextWindow,
    llmOutputTokenLimit,
    llmInputLimit,
    autoCompactEnabled,
    llmRoutePricing,
    llmRouteModalities,
    enableThinkingChat,
    processingDisplayLevel,
    llmReadyWithoutApiKey,
    retiredLlmProvider,
    deprecatedLlmModel,
    subscriptionRuntimePolicy,
    activeSubscriptionRuntime: subscriptionRuntimePolicy.activeSubscriptionRuntime,
    subscriptionChatReady: subscriptionRuntimePolicy.chatReady,
    subscriptionImagesReady: subscriptionRuntimePolicy.imagesReady,
    subscriptionFilesReady: subscriptionRuntimePolicy.filesReady,
    refresh,
    toggleThinking,
    settingsLoaded,
    activeChatModel,
  };
}

interface ApiModelCardChoice {
  kind: "api";
  vendor: LLMVendor;
  vendorLabel: string;
  modelId: string;
  /** The model the chat is on right now. */
  current: boolean;
}

/**
 * The card's row for an active subscription runtime. A subscription session
 * has exactly one active route, and this is it — it is never one of several
 * candidates, so `current` is always `true` and it is never clickable.
 * `modelId` is null when the runtime has no model of its own to name (see
 * `SubscriptionRuntimeDescriptor.supportsModelSelection`).
 */
interface SubscriptionModelCardChoice {
  kind: "subscription";
  provider: SubscriptionRuntimeId;
  vendorLabel: string;
  modelId: string | null;
  current: true;
}

export type ModelCardChoice = ApiModelCardChoice | SubscriptionModelCardChoice;

/** Show the active runtime as checked and API pins as alternatives; resolve pins against offered models and retain user
 * order. */
export function modelCardChoices(llm: AppSettings["llm"]): ModelCardChoice[] {
  const pinned = llm.pinnedModels ?? [];
  const offered = new Map<string, Set<LLMVendor>>();
  const activeAddress = llmRouteCatalogAddress(llm);
  const activeListing = llm.modelListCache?.[
    llmModelListCacheKey(activeAddress.vendor, activeAddress.baseUrl, activeAddress.credentialScope)
  ];
  // A retired model is not a choice (design `model-capability-catalog.md` §6.1). The load's retirement marker counts too: it
  // names a model the route's own listing dropped, even while the catalog still lists that model.
  const marker = isRetiredLlmModelMarker(llm.retiredProvider) ? llm.retiredProvider : null;
  const retired = (vendor: LLMVendor, modelId: string, baseUrl?: string, listing?: LlmModelListCacheEntry) =>
    (marker !== null && marker.vendor === vendor && marker.model === modelId) ||
    resolveModelRetirement({ vendor, model: modelId, ...(baseUrl ? { baseUrl } : {}), ...(listing ? { listing } : {}) }) !== undefined;
  const offer = (vendor: LLMVendor, modelId: string, baseUrl?: string, listing?: LlmModelListCacheEntry) => {
    if (retired(vendor, modelId, baseUrl, listing)) return;
    let models = offered.get(modelId);
    if (!models) {
      models = new Set();
      offered.set(modelId, models);
    }
    models.add(vendor);
  };
  const active = llm.provider;
  // Synced catalogues first: a model a provider actually answered with belongs
  // to THAT provider, and `offered` keeps insertion order — offering the active
  // vendor's bundled line first made a pin resolve to whichever vendor happens
  // to be active rather than to the one serving it.
  for (const entry of Object.values(llm.modelListCache ?? {})) {
    // The cache is persisted host data keyed by vendor string; only entries naming a known vendor can be offered as a pick.
    if (!isLLMVendor(entry.vendor)) continue;
    for (const modelId of entry.models) offer(entry.vendor, modelId, entry.baseUrl, entry);
  }
  for (const modelId of getVendorOption(active).modelOptions) {
    offer(active, modelId, activeAddress.baseUrl, activeListing);
  }
  const activeBlock = llm.vendors[active];
  const currentModel = activeBlock && llmRouteModel(
    activeBlock,
    active === "openai-compatible" ? llm.marketplaceProviderPresetId : undefined,
  );
  // `kind === "subscription"` alone decides the branch: an unrecognised
  // provider id must still keep the card off the API model it would
  // otherwise mismark as current. `isSubscriptionRuntimeId` below only
  // chooses how to *label* that provider — it never re-admits the API
  // branch.
  const activeRuntime = llm.activeChatRuntime;
  const subscription = activeRuntime?.kind === "subscription" ? activeRuntime : null;
  const choices: ModelCardChoice[] = [];
  for (const modelId of pinned) {
    for (const vendor of offered.get(modelId) ?? []) {
      choices.push({
        kind: "api",
        vendor,
        vendorLabel: getVendorOption(vendor).label,
        modelId,
        // A pinned API model can equal the vendor/model the settings still hold for the API path even while a subscription runtime
        // is what the chat is actually on — that stale match is not "current".
        current: subscription === null && !llm.retiredProvider && vendor === active && modelId === currentModel,
      });
    }
  }
  // A retired vendor leaves its configured model as an unselected candidate; a retired model is not offered at all.
  const currentRetired = currentModel !== undefined && currentModel !== ""
    && (isRetiredLlmModelMarker(llm.retiredProvider)
      || retired(active, currentModel, activeAddress.baseUrl, activeListing));
  if (subscription === null && currentModel && !currentRetired && !choices.some((choice) =>
    choice.kind === "api" && choice.vendor === active && choice.modelId === currentModel
  )) {
    choices.unshift({ kind: "api", vendor: active, vendorLabel: getVendorOption(active).label, modelId: currentModel, current: !llm.retiredProvider });
  }
  if (subscription) {
    const model = typeof subscription.model === "string" ? subscription.model.trim() : "";
    // `subscriptionRuntimeDescriptor` falls back to its first entry for an id
    // it does not recognise — fine for a lookup that only ever sees validated
    // ids, wrong here: an unrecognised id must show as itself, never borrow
    // another provider's label.
    const vendorLabel = isSubscriptionRuntimeId(subscription.provider)
      ? subscriptionRuntimeDescriptor(subscription.provider).planName
      : subscription.provider;
    choices.unshift({
      kind: "subscription",
      provider: subscription.provider,
      vendorLabel,
      modelId: model.length > 0 ? model : null,
      current: true,
    });
  }
  return choices;
}
