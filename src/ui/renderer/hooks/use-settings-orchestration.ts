import {
  SUBAGENT_MAX_ROUNDS_DEFAULT,
  SUBAGENT_MAX_ROUNDS_MIN,
  SUBAGENT_MAX_ROUNDS_MAX,
} from "../../../shared/subagent-policy.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isIpcErrorResult,
  type AppSettings,
  type DeepPartial,
  type AveApi,
} from "../types.js";
import { ALL_VENDORS, getVendorOption, type VendorOption } from "../constants.js";
import { requirePersistedResult } from "./use-settings-persistence.js";
import { formatIpcError } from "../format-ipc-error.js";
import type {
  FallbackEntry,
  ProviderCredentialDraft,
  ProviderCredentialSave,
} from "../tabs/LlmTab.js";
import { t } from "../../../i18n/runtime.js";
import {
  DEFAULT_LLM_VENDOR,
  getLlmVendorSettings,
  isLLMVendor,
  llmRouteModel,
  requestedLlmThinkingBudgetTokens,
  type LLMVendor,
  type LLMVendorSettings,
  requestedLlmOutputTokenLimit,
} from "../../../shared/llm-vendor-defaults.js";
import {
  marketplaceProviderPresetSecretId,
  type MarketplaceInstalledProviderPreset,
} from "../../../shared/marketplace-package-assets.js";
import {
  DEFAULT_PROCESSING_DISPLAY_LEVEL,
  isProcessingDisplayLevel,
  type ProcessingDisplayLevel,
} from "../../../shared/processing-display-level.js";

/** A save that arrived while another was running. See `pendingSaves`. */
type PendingSave =
  | { kind: "tab"; tab: string }
  | {
    kind: "credential";
    input: ProviderCredentialSave;
    /** Settles the promise the card is still holding. */
    resolve: (ok: boolean) => void;
  };

type LiveSettingsValues = {
  idlePreferenceRefresh: boolean;
  idleMemoryConsolidation: boolean;
  subAgentAutonomousWake: boolean;
  subAgentMaxRounds: number;
};

function liveSettingsValues(settings: AppSettings): LiveSettingsValues {
  return {
    idlePreferenceRefresh: settings.features?.idlePreferenceRefresh ?? false,
    idleMemoryConsolidation: settings.features?.idleMemoryConsolidation ?? false,
    subAgentAutonomousWake: settings.features?.subAgentAutonomousWake ?? false,
    subAgentMaxRounds: settings.chat.subAgentMaxRounds ?? SUBAGENT_MAX_ROUNDS_DEFAULT,
  };
}

export interface SettingsOrchestrationState {
  /** The provider chat runs on — `llm.provider`. Moved only by an explicit pick. */
  vendor: string;
  /** One draft per expanded provider row: rows expand independently, so a half-typed key on one must survive the user opening
   * another. */
  providerCredentialDrafts: readonly ProviderCredentialDraft[];
  setProviderCredentialDrafts: (next: readonly ProviderCredentialDraft[]) => void;
  saveProviderCredential: (input: ProviderCredentialSave) => Promise<boolean>;
  model: string;
  setModel: (v: string) => void;
  /** Whether the ACTIVE provider has a stored key. Per-row facts are the tab's. */
  hasKey: boolean;
  setHasKey: (v: boolean) => void;
  autoCompact: boolean;
  setAutoCompact: (updater: boolean | ((prev: boolean) => boolean)) => void;
  processingDisplayLevel: ProcessingDisplayLevel;
  setProcessingDisplayLevel: (value: ProcessingDisplayLevel) => void;
  enableThinking: boolean;
  setEnableThinking: (v: boolean) => void;
  thinkingBudget: number;
  setThinkingBudget: (v: number) => void;
  outputTokenLimit: number;
  /** The ACTIVE provider's endpoint. A card's endpoint field edits the draft. */
  baseUrl: string;
  // Cross-vendor LLM controls (UI moved out of "Advanced")
  streamSmoothing: "none" | "word" | "char";
  setStreamSmoothing: (v: "none" | "word" | "char") => void;
  fallbackChain: FallbackEntry[];
  setFallbackChain: (updater: FallbackEntry[] | ((c: FallbackEntry[]) => FallbackEntry[])) => void;
  fallbackOpen: boolean;
  setFallbackOpen: (updater: boolean | ((o: boolean) => boolean)) => void;
  webProvider: AppSettings["webSearch"]["provider"];
  setWebProvider: (v: AppSettings["webSearch"]["provider"]) => void;
  webKeyInput: string;
  setWebKeyInput: (v: string) => void;
  saveWebApiKey: () => Promise<boolean>;
  hasWebKey: boolean;
  setHasWebKey: (v: boolean) => void;
  // Privacy
  piiRedactEnabled: boolean;
  setPiiRedactEnabled: (v: boolean) => void;
  // Experimental feature flags
  idlePreferenceRefresh: boolean;
  setIdlePreferenceRefresh: (v: boolean) => void;
  idleMemoryConsolidation: boolean;
  setIdleMemoryConsolidation: (v: boolean) => void;
  subAgentAutonomousWake: boolean;
  subAgentMaxRounds: number;
  setSubAgentMaxRounds: (next: number) => void;
  setSubAgentAutonomousWake: (v: boolean) => void;
  // Marketplace
  marketplaceProviderPresetId: string;
  marketplaceProviderPresets: readonly MarketplaceInstalledProviderPreset[];
  selectMarketplaceProviderPreset: (preset: MarketplaceInstalledProviderPreset) => void;
  /** Move vendor and model together when the chosen model belongs elsewhere. */
  selectApiVendorModel: (vendorId: string, modelId: string) => void;
  clearMarketplaceProviderPreset: () => void;
  settingsLoaded: boolean;
  retiredLlmProvider: AppSettings["llm"]["retiredProvider"] | null;
  saving: boolean;
  /**
   * Last save failure surface. Cleared on the next successful save.
   * SettingsContent renders this as a banner so silent IPC failures
   * (network drop, locked settings file, schema reject) become
   * visible — without this, an auto-save that silently rejected
   * would leave the user thinking a toggle persisted when it did not.
   */
  lastSaveError: { tab: string; message: string } | null;
  /** Programmatic clear — used when the user opens the dialog fresh. */
  clearLastSaveError: () => void;
  loadError: string | null;
  retryLoad: () => void;

  save: (tab: string) => Promise<boolean>;
  vendorInfo: VendorOption;
}

export function useSettingsOrchestration(
  api: AveApi,
  onSaved: () => void,
  reloadEpoch = 0,
): SettingsOrchestrationState {
  // Initialize vendor to "" (empty) rather than "claude" so the UI never
  // flashes the wrong vendor label before the settings load effect hydrates
  // the correct persisted value. The `settingsLoaded` guard prevents any
  // save from firing before hydration completes.
  const [vendor, setVendor] = useState<LLMVendor | "">("");
  const [providerCredentialDrafts, setProviderCredentialDrafts] =
    useState<readonly ProviderCredentialDraft[]>([]);
  const [model, setModelState] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [autoCompact, setAutoCompactState] = useState(true);
  const [processingDisplayLevel, setProcessingDisplayLevelState] = useState<ProcessingDisplayLevel>(
    DEFAULT_PROCESSING_DISPLAY_LEVEL,
  );
  // A cross-window broadcast may arrive during the 200 ms immediate-save debounce or while a save is in flight. Preserve the
  // newer local edit, and mark the draft clean only when the save covered its current revision.
  const processingDisplayLevelDraftRef = useRef({ dirty: false, revision: 0 });
  const setProcessingDisplayLevel = useCallback((value: ProcessingDisplayLevel) => {
    processingDisplayLevelDraftRef.current.dirty = true;
    processingDisplayLevelDraftRef.current.revision++;
    setProcessingDisplayLevelState(value);
  }, []);
  const [enableThinking, setEnableThinkingState] = useState(true);
  const [thinkingBudget, setThinkingBudgetState] = useState(() => getLlmVendorSettings(undefined, DEFAULT_LLM_VENDOR).thinkingBudgetTokens);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const retryLoad = useCallback(() => setLoadRevision((revision) => revision + 1), []);
  const [baseUrl, setBaseUrl] = useState("");
  const [streamSmoothing, setStreamSmoothingState] = useState<"none" | "word" | "char">("none");
  const [fallbackChain, setFallbackChainState] = useState<FallbackEntry[]>([]);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [webProvider, setWebProviderState] = useState<AppSettings["webSearch"]["provider"]>("duckduckgo");
  const [webKeyInput, setWebKeyInputState] = useState("");
  const webKeyDraftRef = useRef<{ provider: AppSettings["webSearch"]["provider"]; key: string } | null>(null);
  const webProviderRef = useRef(webProvider);
  // A provider choice is a local edit until its save settles; only then may stored values (a reset, another window) replace it.
  const webProviderDraftRevisionRef = useRef(0);
  const webProviderSavedRevisionRef = useRef(0);
  // Host broadcasts arrive in store order, and a save's reply follows its own broadcast, so the newest broadcast received after a
  // save began is at least as new as that save's reply snapshot.
  const webProviderBroadcastRef = useRef<{ sequence: number; provider: AppSettings["webSearch"]["provider"] | null }>({ sequence: 0, provider: null });
  const applyWebProvider = useCallback((next: AppSettings["webSearch"]["provider"]) => {
    webProviderRef.current = next;
    webKeyDraftRef.current = null;
    setWebKeyInputState("");
    setWebProviderState(next);
  }, []);
  const setWebProvider = useCallback((next: AppSettings["webSearch"]["provider"]) => {
    webProviderDraftRevisionRef.current += 1;
    applyWebProvider(next);
  }, [applyWebProvider]);
  const setWebKeyInput = useCallback((key: string) => {
    webKeyDraftRef.current = { provider: webProviderRef.current, key };
    setWebKeyInputState(key);
  }, []);
  const [hasWebKey, setHasWebKey] = useState(false);
  const [piiRedactEnabled, setPiiRedactEnabledState] = useState(false);
  const [idlePreferenceRefresh, setIdlePreferenceRefresh] = useState(false);
  const [idleMemoryConsolidation, setIdleMemoryConsolidation] = useState(false);
  const [subAgentAutonomousWake, setSubAgentAutonomousWake] = useState(false);
  const [subAgentMaxRounds, setSubAgentMaxRounds] = useState(SUBAGENT_MAX_ROUNDS_DEFAULT);
  const liveRevisionsRef = useRef({ idlePreferenceRefresh: 0, idleMemoryConsolidation: 0, subAgentAutonomousWake: 0, subAgentMaxRounds: 0 });
  const livePendingRef = useRef(new Set<keyof LiveSettingsValues>());
  const liveAuthoritativeRef = useRef<LiveSettingsValues>({ idlePreferenceRefresh: false, idleMemoryConsolidation: false, subAgentAutonomousWake: false, subAgentMaxRounds: SUBAGENT_MAX_ROUNDS_DEFAULT });
  const [marketplaceProviderPresetId, setMarketplaceProviderPresetId] = useState("");
  const [marketplaceProviderPresets, setMarketplaceProviderPresets] = useState<MarketplaceInstalledProviderPreset[]>([]);
  const [saving, setSaving] = useState(false);
  const [lastSaveError, setLastSaveError] = useState<{ tab: string; message: string } | null>(null);
  const clearLastSaveError = useCallback(() => setLastSaveError(null), []);
  const [settingsSnapshot, setSettingsSnapshotState] = useState<AppSettings | null>(null);
  const settingsSnapshotRef = useRef<AppSettings | null>(null);
  const setSettingsSnapshot = useCallback((snapshot: AppSettings) => {
    settingsSnapshotRef.current = snapshot;
    setSettingsSnapshotState(snapshot);
  }, []);
  // A migrated default is not a choice. Only the model chooser may release retirement; saving another setting must not
  // select that default.
  const providerSelectionRef = useRef(false);
  const hydratedVendorRef = useRef<string | null>(null);
  const hydratedWebProviderRef = useRef<string | null>(null);
  const llmDraftRef = useRef({ model: 0, thinking: 0, fallback: 0, selection: 0 });
  const llmSavedRevisionRef = useRef({ model: 0, thinking: 0, fallback: 0, selection: 0 });
  const setModel = useCallback((value: string) => {
    llmDraftRef.current.model++;
    setModelState(value);
  }, []);
  const setEnableThinking = useCallback((value: boolean) => {
    llmDraftRef.current.thinking++;
    setEnableThinkingState(value);
  }, []);
  const setThinkingBudget = useCallback((value: number) => {
    llmDraftRef.current.thinking++;
    setThinkingBudgetState(value);
  }, []);
  const setFallbackChain = useCallback((value: FallbackEntry[] | ((current: FallbackEntry[]) => FallbackEntry[])) => {
    llmDraftRef.current.fallback++;
    setFallbackChainState(value);
  }, []);
  const chatDraftRef = useRef({ autoCompact: 0, streamSmoothing: 0, pii: 0 });
  const chatSavedRevisionRef = useRef({ autoCompact: 0, streamSmoothing: 0, pii: 0 });
  const setAutoCompact = useCallback((value: boolean | ((previous: boolean) => boolean)) => {
    chatDraftRef.current.autoCompact++;
    setAutoCompactState(value);
  }, []);
  const setStreamSmoothing = useCallback((value: "none" | "word" | "char") => {
    chatDraftRef.current.streamSmoothing++;
    setStreamSmoothingState(value);
  }, []);
  const setPiiRedactEnabled = useCallback((value: boolean) => {
    chatDraftRef.current.pii++;
    setPiiRedactEnabledState(value);
  }, []);
  const vendorInfo = getVendorOption(vendor);
  // Numeric request limits are applied separately from persisted effort intent.
  const outputTokenLimit = requestedLlmOutputTokenLimit(getLlmVendorSettings(
    settingsSnapshot?.llm.vendors, vendor || DEFAULT_LLM_VENDOR,
  )).value;
  const effectiveThinkingBudget = requestedLlmThinkingBudgetTokens(thinkingBudget);

  const activeCredentialProviderId =
    vendor === "openai-compatible" && marketplaceProviderPresetId
      ? marketplaceProviderPresetSecretId(marketplaceProviderPresetId)
      : vendor;

  const hydrateVendorBlock = useCallback((
    block: LLMVendorSettings,
    marketplaceProviderPresetIdForBlock = "",
  ): void => {
    setModelState(llmRouteModel(block, marketplaceProviderPresetIdForBlock));
    setBaseUrl(block.baseUrl ?? "");
    setEnableThinkingState(block.enableThinking);
    setThinkingBudgetState(block.thinkingBudgetTokens);
  }, []);

  const hydrationKey = JSON.stringify([loadRevision, reloadEpoch]);
  const currentHydrationKeyRef = useRef(hydrationKey);
  currentHydrationKeyRef.current = hydrationKey;

  // Load all settings on mount. (Before the BrowserWindow conversion this was gated on `open`; that's now always true while
  // the window exists.)
  useEffect(() => {
    let cancelled = false;
    providerSelectionRef.current = false;
    setSettingsLoaded(false);
    void (async () => {
      const s = await api.getSettings();
      const provider = isLLMVendor(s.llm.provider)
        ? s.llm.provider
        : DEFAULT_LLM_VENDOR;
      const providerPresetId = provider === "openai-compatible"
        ? s.llm.marketplaceProviderPresetId ?? ""
        : "";
      const [apiKeySet, webApiKeySet] = await Promise.all([
        api.hasApiKey(providerPresetId
          ? marketplaceProviderPresetSecretId(providerPresetId)
          : provider),
        api.hasWebApiKey(s.webSearch.provider),
      ]);
      if (cancelled || currentHydrationKeyRef.current !== hydrationKey) return;
      const block = getLlmVendorSettings(s.llm.vendors, provider);
      hydratedVendorRef.current = provider;
      hydratedWebProviderRef.current = s.webSearch.provider;
      setSettingsSnapshot(s);
      setVendor(provider);
      setMarketplaceProviderPresetId(providerPresetId);
      setMarketplaceProviderPresets(s.marketplace?.installedProviderPresets ?? []);
      hydrateVendorBlock(block, providerPresetId);
      setStreamSmoothingState(s.llm.streamSmoothing);
      setAutoCompactState(s.chat.autoCompact ?? true);
      processingDisplayLevelDraftRef.current.dirty = false;
      setProcessingDisplayLevelState(
        s.chat.processingDisplayLevel ?? DEFAULT_PROCESSING_DISPLAY_LEVEL,
      );
      setHasKey(apiKeySet);
      webProviderSavedRevisionRef.current = webProviderDraftRevisionRef.current;
      applyWebProvider(s.webSearch.provider);
      setHasWebKey(webApiKeySet);
      setPiiRedactEnabledState(s.privacy?.piiRedactEnabled ?? false);
      const liveValues = liveSettingsValues(s);
      liveAuthoritativeRef.current = liveValues;
      setIdlePreferenceRefresh(liveValues.idlePreferenceRefresh);
      setIdleMemoryConsolidation(liveValues.idleMemoryConsolidation);
      setSubAgentAutonomousWake(liveValues.subAgentAutonomousWake);
      setSubAgentMaxRounds(liveValues.subAgentMaxRounds);
      setFallbackChainState(s.llm.fallbackChain.map((e) => ({ provider: e.provider, model: e.model })));
      setSettingsLoaded(true);
      setLoadError(null);
    })().catch(() => {
      if (!cancelled && currentHydrationKeyRef.current === hydrationKey) setLoadError(t("useSettingsOrchestration.loadFailed"));
    });
    return () => { cancelled = true; };
  }, [api, hydrationKey, hydrateVendorBlock, setSettingsSnapshot, applyWebProvider]);

  // Stay in sync with cross-window settings broadcasts. Updating the snapshot refreshes the cached source that the
  // vendor-switch effect consults; the userTouchedRef-style guards in this hook protect in-flight form edits.
  useEffect(() => {
    return api.onSettingsUpdated((next) => {
      if (!next.llm.retiredProvider) providerSelectionRef.current = false;
      setSettingsSnapshot(next);
      if (chatDraftRef.current.autoCompact === chatSavedRevisionRef.current.autoCompact) setAutoCompactState(next.chat.autoCompact);
      if (chatDraftRef.current.streamSmoothing === chatSavedRevisionRef.current.streamSmoothing) setStreamSmoothingState(next.llm.streamSmoothing);
      if (chatDraftRef.current.pii === chatSavedRevisionRef.current.pii) setPiiRedactEnabledState(next.privacy.piiRedactEnabled);
      const draft = llmDraftRef.current;
      const saved = llmSavedRevisionRef.current;
      const provider = draft.selection === saved.selection && isLLMVendor(next.llm.provider)
        ? next.llm.provider : hydratedVendorRef.current;
      if (provider && isLLMVendor(provider)) {
        const presetId = draft.selection === saved.selection
          ? provider === "openai-compatible" ? next.llm.marketplaceProviderPresetId ?? "" : ""
          : marketplaceProviderPresetId;
        const block = getLlmVendorSettings(next.llm.vendors, provider);
        if (draft.selection === saved.selection) {
          hydratedVendorRef.current = provider;
          setVendor(provider);
          setMarketplaceProviderPresetId(presetId);
        }
        if (draft.model === saved.model) setModelState(llmRouteModel(block, presetId));
        if (draft.thinking === saved.thinking) {
          setEnableThinkingState(block.enableThinking);
          setThinkingBudgetState(block.thinkingBudgetTokens);
        }
        setBaseUrl(block.baseUrl ?? "");
      }
      if (draft.fallback === saved.fallback) {
        setFallbackChainState(next.llm.fallbackChain.map((entry) => ({ provider: entry.provider, model: entry.model })));
      }
      webProviderBroadcastRef.current = { sequence: webProviderBroadcastRef.current.sequence + 1, provider: next.webSearch.provider };
      // The key-presence effect re-queries for the adopted provider.
      if (webProviderDraftRevisionRef.current === webProviderSavedRevisionRef.current
        && next.webSearch.provider !== webProviderRef.current) applyWebProvider(next.webSearch.provider);
      const liveValues = liveSettingsValues(next);
      liveAuthoritativeRef.current = liveValues;
      if (!livePendingRef.current.has("idlePreferenceRefresh")) setIdlePreferenceRefresh(liveValues.idlePreferenceRefresh);
      if (!livePendingRef.current.has("idleMemoryConsolidation")) setIdleMemoryConsolidation(liveValues.idleMemoryConsolidation);
      if (!livePendingRef.current.has("subAgentAutonomousWake")) setSubAgentAutonomousWake(liveValues.subAgentAutonomousWake);
      if (!livePendingRef.current.has("subAgentMaxRounds")) setSubAgentMaxRounds(liveValues.subAgentMaxRounds);
      if (!processingDisplayLevelDraftRef.current.dirty) {
        setProcessingDisplayLevelState(
          next.chat.processingDisplayLevel ?? DEFAULT_PROCESSING_DISPLAY_LEVEL,
        );
      }
      // Follow installed-preset broadcasts without overwriting the form's unsaved provider selection or endpoint fields.
      setMarketplaceProviderPresets(next.marketplace?.installedProviderPresets ?? []);
    });
  }, [api, marketplaceProviderPresetId, setSettingsSnapshot, applyWebProvider]);

  // Re-hydrate every vendor-specific field when the active vendor changes.
  useEffect(() => {
    if (!settingsLoaded) return;
    if (!ALL_VENDORS.some((x) => x.id === vendor)) return;
    // Only a vendor CHANGE re-hydrates. This effect also re-runs whenever a
    // cross-window settings broadcast refreshes the snapshot, and hydrating
    // then would overwrite the fields the user is editing right now — the
    // chosen model, a half-typed base URL — with the persisted values.
    if (hydratedVendorRef.current === vendor) return;
    hydratedVendorRef.current = vendor;
    let cancelled = false;
    void api.hasApiKey(activeCredentialProviderId).then((k) => { if (!cancelled) setHasKey(k); });
    const block = isLLMVendor(vendor)
      ? getLlmVendorSettings(settingsSnapshot?.llm.vendors, vendor)
      : null;
    if (block) {
      hydrateVendorBlock(
        block,
        vendor === "openai-compatible" ? marketplaceProviderPresetId : "",
      );
    }
    return () => { cancelled = true; };
  }, [
    vendor, api, settingsLoaded, settingsSnapshot, activeCredentialProviderId,
    marketplaceProviderPresetId, hydrateVendorBlock,
  ]);

  // Re-check web key when webProvider changes
  useEffect(() => {
    if (!settingsLoaded) return;
    if (hydratedWebProviderRef.current === webProvider) {
      hydratedWebProviderRef.current = null;
      return;
    }
    let cancelled = false;
    void api.hasWebApiKey(webProvider).then((k) => { if (!cancelled) setHasWebKey(k); });
    return () => { cancelled = true; };
  }, [webProvider, api, settingsLoaded]);

  /**
   * Choose a model that may belong to a different API vendor than the one the
   * configuration form is pointed at. The chooser spans every configured
   * vendor, so vendor and model have to move together — and the hydration
   * marker is stamped here so the vendor-change effect does not immediately
   * replace the chosen model with that vendor's persisted one.
   */
  const selectApiVendorModel = useCallback((vendorId: string, modelId: string) => {
    if (!isLLMVendor(vendorId)) return;
    providerSelectionRef.current = true;
    llmDraftRef.current.selection++;
    llmDraftRef.current.model++;
    llmDraftRef.current.thinking++;
    const block = getLlmVendorSettings(settingsSnapshot?.llm.vendors, vendorId);
    hydratedVendorRef.current = vendorId;
    setVendor(vendorId);
    if (vendorId !== "openai-compatible") setMarketplaceProviderPresetId("");
    setBaseUrl(block.baseUrl ?? "");
    setEnableThinkingState(block.enableThinking);
    setThinkingBudgetState(block.thinkingBudgetTokens);
    setModelState(modelId);
    void api.hasApiKey(vendorId).then((k) => setHasKey(k)).catch(() => setHasKey(false));
  }, [api, settingsSnapshot]);

  const selectMarketplaceProviderPreset = useCallback((preset: MarketplaceInstalledProviderPreset) => {
    providerSelectionRef.current = true;
    llmDraftRef.current.selection++;
    llmDraftRef.current.model++;
    llmDraftRef.current.thinking++;
    const openaiCompatibleDefaults = getLlmVendorSettings(
      settingsSnapshot?.llm.vendors,
      "openai-compatible",
    );
    hydratedVendorRef.current = "openai-compatible";
    setMarketplaceProviderPresetId(preset.providerId);
    setVendor("openai-compatible");
    // This preset's own stored model, so switching between two presets restores what each was last set to rather than
    // resetting both to a seed.
    setModelState(llmRouteModel(openaiCompatibleDefaults, preset.providerId));
    // Keep the generic row's endpoint in its stored block; resolve preset addresses from their registry.
    setBaseUrl(openaiCompatibleDefaults.baseUrl ?? "");
    setEnableThinkingState(openaiCompatibleDefaults.enableThinking);
    setThinkingBudgetState(openaiCompatibleDefaults.thinkingBudgetTokens);
    void api
      .hasApiKey(marketplaceProviderPresetSecretId(preset.providerId))
      .then((k) => setHasKey(k))
      .catch(() => setHasKey(false));
  }, [api, settingsSnapshot]);

  const clearMarketplaceProviderPreset = useCallback(() => {
    llmDraftRef.current.selection++;
    llmDraftRef.current.model++;
    llmDraftRef.current.thinking++;
    setMarketplaceProviderPresetId("");
    if (vendor !== "openai-compatible") return;
    // Read the stored generic block even when a preset is active; replacing it with defaults would discard the user's
    // endpoint.
    const genericBlock = getLlmVendorSettings(settingsSnapshot?.llm.vendors, "openai-compatible");
    hydrateVendorBlock(genericBlock);
    void api.hasApiKey("openai-compatible")
      .then((k) => setHasKey(k))
      .catch(() => setHasKey(false));
  }, [api, settingsSnapshot, vendor, hydrateVendorBlock]);

  // In-flight guard + pending re-fire: if a debounced save lands while a
  // previous save is still in flight (cross-tab race), mark it pending
  // and re-fire after the current call resolves. Without this, two
  // overlapping saves would race in settingsService and `setSaving`
  // would flicker (the first call's `finally` clears the flag while the
  // second is still running).
  const savingRef = useRef(false);
  /** Serialize tab and credential saves in arrival order; queued credential saves retain their promise so callers learn the
   * real outcome. */
  const pendingSaves = useRef<PendingSave[]>([]);
  // Latest-`save` ref: the running save closure captures values from its
  // own render. When `finally` re-fires the pending payload, it must
  // call the LATEST `save` (with the latest closures) — otherwise
  // toggles that landed between the call and the re-fire are silently
  // dropped from the second save's payload. The ref is updated via
  // `useEffect` (canonical latest-ref pattern) so a discarded concurrent
  // render does not leave a dangling closure here.
  const saveRef = useRef<(tab: string) => Promise<boolean>>(null!);
  const saveProviderCredentialRef =
    useRef<(input: ProviderCredentialSave) => Promise<boolean>>(null!);
  /**
   * Run the next queued save, if any.
   *
   * Called from the `finally` of whichever save just finished, so the flag it
   * checks is already clear. Each run drains the next in its own `finally`,
   * which is what keeps the queue moving without a second scheduler.
   */
  const drainPendingSaves = useCallback((): void => {
    const next = pendingSaves.current.shift();
    if (!next) return;
    if (next.kind === "tab") {
      void saveRef.current(next.tab);
      return;
    }
    void saveProviderCredentialRef.current(next.input).then(next.resolve, () => next.resolve(false));
  }, []);
  const save = async (tab: string): Promise<boolean> => {
    if (!settingsLoaded) return false;
    if (savingRef.current) {
      // One pending entry per tab: the payload is read from state at run time, so a second request for the same tab would write
      // the same thing twice.
      if (!pendingSaves.current.some((entry) => entry.kind === "tab" && entry.tab === tab)) {
        pendingSaves.current.push({ kind: "tab", tab });
      }
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    const processingDisplayLevelRevision = processingDisplayLevelDraftRef.current.revision;
    const llmRevisions = { ...llmDraftRef.current };
    const chatRevisions = { ...chatDraftRef.current };
    const webProviderRevision = webProviderDraftRevisionRef.current;
    const webProviderBroadcastSequence = webProviderBroadcastRef.current.sequence;
    const chatDirty = {
      autoCompact: chatRevisions.autoCompact !== chatSavedRevisionRef.current.autoCompact,
      streamSmoothing: chatRevisions.streamSmoothing !== chatSavedRevisionRef.current.streamSmoothing,
      pii: chatRevisions.pii !== chatSavedRevisionRef.current.pii,
      processing: processingDisplayLevelDraftRef.current.dirty,
    };
    let ok = false;
    try {
      if (tab !== "permissions") {
        const selectionDirty = llmRevisions.selection !== llmSavedRevisionRef.current.selection;
        const modelDirty = llmRevisions.model !== llmSavedRevisionRef.current.model;
        const thinkingDirty = llmRevisions.thinking !== llmSavedRevisionRef.current.thinking;
        const activePresetId = vendor === "openai-compatible" ? marketplaceProviderPresetId : "";
        const activeBlock: DeepPartial<LLMVendorSettings> = {
          ...(modelDirty || selectionDirty
            ? activePresetId ? { presetModels: { [activePresetId]: model.trim() } } : { model: model.trim() }
            : {}),
          ...(thinkingDirty || selectionDirty ? { enableThinking, thinkingBudgetTokens: effectiveThinkingBudget } : {}),
        };
        const llmPatch: DeepPartial<AppSettings["llm"]> = {
          ...(selectionDirty ? {
            ...(!settingsSnapshot?.llm.retiredProvider || providerSelectionRef.current ? { provider: vendor || undefined } : {}),
            marketplaceProviderPresetId: activePresetId,
          } : {}),
          ...(Object.keys(activeBlock).length > 0 ? { vendors: { [vendor]: activeBlock } } : {}),
        };
        const patch: DeepPartial<AppSettings> = tab === "llm-fallback"
          ? { llm: { fallbackChain: fallbackChain.map((entry) => ({ provider: entry.provider, model: entry.model.trim() })) } }
          : tab === "llm"
          ? { llm: llmPatch }
          : tab === "web"
            ? { webSearch: { provider: webProvider } }
            : tab === "chat"
              ? {
                ...(chatDirty.streamSmoothing ? { llm: { streamSmoothing } } : {}),
                ...(chatDirty.autoCompact || chatDirty.processing ? { chat: {
                  ...(chatDirty.autoCompact ? { autoCompact } : {}),
                  ...(chatDirty.processing ? { processingDisplayLevel } : {}),
                } } : {}),
                ...(chatDirty.pii ? { privacy: { piiRedactEnabled } } : {}),
              }
              : {};
        if (Object.keys(patch).length === 0 || tab === "llm" && Object.keys(llmPatch).length === 0) return true;
        const updateResult = requirePersistedResult(await api.updateSettings(patch));
        if (tab === "llm") {
          const fallbackRevision = llmSavedRevisionRef.current.fallback;
          llmSavedRevisionRef.current = { ...llmRevisions, fallback: fallbackRevision };
        }
        if (tab === "llm-fallback") {
          setSettingsSnapshot(updateResult);
          llmSavedRevisionRef.current.fallback = llmRevisions.fallback;
          if (llmDraftRef.current.fallback === llmRevisions.fallback) {
            setFallbackChainState(updateResult.llm.fallbackChain.map((entry) => ({ provider: entry.provider, model: entry.model })));
          }
        }
        if (tab === "web" && webProviderDraftRevisionRef.current === webProviderRevision) {
          webProviderSavedRevisionRef.current = webProviderRevision;
          const broadcast = webProviderBroadcastRef.current;
          const stored = broadcast.sequence !== webProviderBroadcastSequence && broadcast.provider !== null
            ? broadcast.provider : updateResult.webSearch.provider;
          if (stored !== webProviderRef.current) applyWebProvider(stored);
        }
        if (tab === "chat") {
          chatSavedRevisionRef.current = chatRevisions;
          if (chatDirty.autoCompact && chatDraftRef.current.autoCompact === chatRevisions.autoCompact) setAutoCompactState(updateResult.chat.autoCompact);
          if (chatDirty.streamSmoothing && chatDraftRef.current.streamSmoothing === chatRevisions.streamSmoothing) setStreamSmoothingState(updateResult.llm.streamSmoothing);
          if (chatDirty.pii && chatDraftRef.current.pii === chatRevisions.pii) setPiiRedactEnabledState(updateResult.privacy.piiRedactEnabled);
        }
        if (tab === "chat" && chatDirty.processing && processingDisplayLevelDraftRef.current.revision === processingDisplayLevelRevision) {
          const authoritativeProcessingDisplayLevel = updateResult.chat.processingDisplayLevel;
          if (!isProcessingDisplayLevel(authoritativeProcessingDisplayLevel)) {
            throw new Error("Settings update returned an invalid processing display level.");
          }
          processingDisplayLevelDraftRef.current.dirty = false;
          setProcessingDisplayLevelState(authoritativeProcessingDisplayLevel);
        }
      }
      if (tab !== "permissions") onSaved();
      setLastSaveError(null);
      ok = true;
    } catch (err) {
      // Surface via state so SettingsContent can render an inline banner —
      // debounced callers do `void s.save(tab)` and would otherwise lose
      // the rejection in an unhandled-promise warning, leaving the user
      // thinking a toggle persisted when it did not.
      const message =
        err instanceof Error && err.message ? err.message : t("useSettingsOrchestration.saveFailed");
      const authoritative = settingsSnapshotRef.current;
      if (tab === "chat" && authoritative) {
        if (chatDirty.autoCompact && chatDraftRef.current.autoCompact === chatRevisions.autoCompact) {
          chatSavedRevisionRef.current.autoCompact = chatRevisions.autoCompact;
          setAutoCompactState(authoritative.chat.autoCompact);
        }
        if (chatDirty.streamSmoothing && chatDraftRef.current.streamSmoothing === chatRevisions.streamSmoothing) {
          chatSavedRevisionRef.current.streamSmoothing = chatRevisions.streamSmoothing;
          setStreamSmoothingState(authoritative.llm.streamSmoothing);
        }
        if (chatDirty.pii && chatDraftRef.current.pii === chatRevisions.pii) {
          chatSavedRevisionRef.current.pii = chatRevisions.pii;
          setPiiRedactEnabledState(authoritative.privacy.piiRedactEnabled);
        }
        if (chatDirty.processing && processingDisplayLevelDraftRef.current.revision === processingDisplayLevelRevision) {
          processingDisplayLevelDraftRef.current.dirty = false;
          setProcessingDisplayLevelState(authoritative.chat.processingDisplayLevel);
        }
      }
      if (tab === "llm" && authoritative) {
        const savedVendor = authoritative.llm.provider;
        const presetId = savedVendor === "openai-compatible" ? authoritative.llm.marketplaceProviderPresetId ?? "" : "";
        const block = getLlmVendorSettings(authoritative.llm.vendors, savedVendor);
        if (llmDraftRef.current.selection === llmRevisions.selection) {
          llmSavedRevisionRef.current.selection = llmRevisions.selection;
          hydratedVendorRef.current = savedVendor;
          providerSelectionRef.current = false;
          setVendor(savedVendor);
          setMarketplaceProviderPresetId(presetId);
        }
        if (llmDraftRef.current.model === llmRevisions.model) {
          llmSavedRevisionRef.current.model = llmRevisions.model;
          setModelState(llmRouteModel(block, presetId));
        }
        if (llmDraftRef.current.thinking === llmRevisions.thinking) {
          llmSavedRevisionRef.current.thinking = llmRevisions.thinking;
          setEnableThinkingState(block.enableThinking);
          setThinkingBudgetState(block.thinkingBudgetTokens);
        }
      }
      if (tab === "web" && authoritative && webProviderDraftRevisionRef.current === webProviderRevision) {
        webProviderSavedRevisionRef.current = webProviderRevision;
        applyWebProvider(authoritative.webSearch.provider);
      }
      setLastSaveError({ tab, message });
    } finally {
      savingRef.current = false;
      setSaving(false);
      // If a save was coalesced while we were running, fire it now via the
      // LATEST closure (the refs) so the re-fire reads the most recent state,
      // not the stale closure of the original call. Without this the second
      // save would silently drop any toggles that landed between the original
      // call and the re-fire.
      drainPendingSaves();
    }
    return ok;
  };
  useEffect(() => {
    saveRef.current = save;
  });

  /** Saving a provider card must not switch the active route; persist its block before the secret and abort if the block is
   * refused. */
  const saveProviderCredential = useCallback(async (
    input: ProviderCredentialSave,
  ): Promise<boolean> => {
    if (!settingsLoaded) return false;
    if (savingRef.current) {
      // Queue behind the in-flight save and hand the caller the outcome of the run that actually happens, so the card stays
      // dirty until then instead of quietly reporting a failure it cannot explain.
      return new Promise<boolean>((resolve) => {
        pendingSaves.current.push({ kind: "credential", input, resolve });
      });
    }
    savingRef.current = true;
    setSaving(true);
    try {
      if (input.vendorBlock) {
        const updateResult = await api.updateSettings({
          llm: { vendors: { [input.vendorId]: input.vendorBlock } },
        });
        if (isIpcErrorResult(updateResult)) {
          throw new Error(formatIpcError(updateResult.error, updateResult.message));
        }
        // The active provider's mirrored fields feed the model-list handshake, so editing that provider's own card has to move
        // them here too.
        if (input.vendorId === vendor) {
          if (input.vendorBlock.baseUrl !== undefined) setBaseUrl(input.vendorBlock.baseUrl);
        }
      }
      const trimmedKey = input.apiKey.trim();
      if (trimmedKey) {
        requirePersistedResult(await api.setApiKey(input.credentialProviderId, trimmedKey));
        if (input.credentialProviderId === activeCredentialProviderId) setHasKey(true);
      }
      onSaved();
      setLastSaveError(null);
      return true;
    } catch (err) {
      const message = err instanceof Error && err.message
        ? err.message
        : t("useSettingsOrchestration.saveFailed");
      setLastSaveError({ tab: "llm", message });
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
      drainPendingSaves();
    }
  }, [api, activeCredentialProviderId, drainPendingSaves, onSaved, settingsLoaded, vendor]);
  useEffect(() => {
    saveProviderCredentialRef.current = saveProviderCredential;
  }, [saveProviderCredential]);

  const saveWebApiKey = useCallback(async (): Promise<boolean> => {
    const draft = webKeyDraftRef.current;
    if (!settingsLoaded || savingRef.current || !draft?.key.trim()) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      requirePersistedResult(await api.setWebApiKey(draft.provider, draft.key.trim()));
      if (webKeyDraftRef.current === draft) {
        webKeyDraftRef.current = null;
        setWebKeyInputState("");
      }
      if (webProviderRef.current === draft.provider) setHasWebKey(true);
      setLastSaveError(null);
      onSaved();
      return true;
    } catch (error) {
      setLastSaveError({ tab: "web", message: error instanceof Error ? error.message : t("useSettingsOrchestration.saveFailed") });
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
      drainPendingSaves();
    }
  }, [api, drainPendingSaves, onSaved, settingsLoaded]);

  const persistLiveSetting = useCallback(<K extends keyof LiveSettingsValues>(
    key: K,
    next: LiveSettingsValues[K],
    setValue: (value: LiveSettingsValues[K]) => void,
  ) => {
    if (!settingsLoaded) return;
    const revision = ++liveRevisionsRef.current[key];
    livePendingRef.current.add(key);
    setValue(next);
    const patch = key === "subAgentMaxRounds"
      ? { chat: { subAgentMaxRounds: next as number } }
      : { features: { [key]: next } };
    void api.updateSettings(patch).then((result) => {
      const updated = requirePersistedResult(result);
      const actual = key === "subAgentMaxRounds" ? updated.chat.subAgentMaxRounds : updated.features?.[key as Exclude<keyof LiveSettingsValues, "subAgentMaxRounds">];
      if (typeof actual !== typeof next) throw new Error("Settings update returned an invalid live setting.");
      const authoritative = actual as LiveSettingsValues[K];
      if (liveRevisionsRef.current[key] !== revision) return;
      liveAuthoritativeRef.current[key] = authoritative;
      livePendingRef.current.delete(key);
      setSettingsSnapshot(updated);
      setValue(authoritative);
      setLastSaveError(null);
      onSaved();
    }).catch((error: unknown) => {
      // A later edit owns this control and its status.
      if (liveRevisionsRef.current[key] !== revision) return;
      livePendingRef.current.delete(key);
      setValue(liveAuthoritativeRef.current[key]);
      setLastSaveError({ tab: "chat", message: error instanceof Error ? error.message : t("useSettingsOrchestration.saveFailed") });
    });
  }, [api, onSaved, setSettingsSnapshot, settingsLoaded]);

  const setIdlePreferenceRefreshLive = useCallback((next: boolean) => {
    if (next !== idlePreferenceRefresh) persistLiveSetting("idlePreferenceRefresh", next, setIdlePreferenceRefresh);
  }, [idlePreferenceRefresh, persistLiveSetting]);
  const setIdleMemoryConsolidationLive = useCallback((next: boolean) => {
    if (next !== idleMemoryConsolidation) persistLiveSetting("idleMemoryConsolidation", next, setIdleMemoryConsolidation);
  }, [idleMemoryConsolidation, persistLiveSetting]);
  const setSubAgentAutonomousWakeLive = useCallback((next: boolean) => {
    if (next !== subAgentAutonomousWake) persistLiveSetting("subAgentAutonomousWake", next, setSubAgentAutonomousWake);
  }, [subAgentAutonomousWake, persistLiveSetting]);
  const setSubAgentMaxRoundsLive = useCallback((next: number) => {
    if (!Number.isInteger(next) || next < SUBAGENT_MAX_ROUNDS_MIN || next > SUBAGENT_MAX_ROUNDS_MAX || next === subAgentMaxRounds) return;
    persistLiveSetting("subAgentMaxRounds", next, setSubAgentMaxRounds);
  }, [persistLiveSetting, subAgentMaxRounds]);
  return {
    lastSaveError,
    clearLastSaveError,
    loadError, retryLoad,
    vendor,
    retiredLlmProvider: settingsSnapshot?.llm.retiredProvider ?? null,
    providerCredentialDrafts, setProviderCredentialDrafts,
    saveProviderCredential,
    selectApiVendorModel,
    model, setModel,
    hasKey, setHasKey,
    autoCompact, setAutoCompact,
    processingDisplayLevel, setProcessingDisplayLevel,
    enableThinking, setEnableThinking,
    thinkingBudget: effectiveThinkingBudget, setThinkingBudget,
    outputTokenLimit,
    baseUrl,
    streamSmoothing, setStreamSmoothing,
    fallbackChain, setFallbackChain,
    fallbackOpen, setFallbackOpen,
    webProvider, setWebProvider,
    webKeyInput, setWebKeyInput, saveWebApiKey,
    hasWebKey, setHasWebKey,
    piiRedactEnabled, setPiiRedactEnabled,
    idlePreferenceRefresh, setIdlePreferenceRefresh: setIdlePreferenceRefreshLive,
    idleMemoryConsolidation, setIdleMemoryConsolidation: setIdleMemoryConsolidationLive,
    subAgentAutonomousWake, setSubAgentAutonomousWake: setSubAgentAutonomousWakeLive,
    subAgentMaxRounds, setSubAgentMaxRounds: setSubAgentMaxRoundsLive,
    marketplaceProviderPresetId,
    marketplaceProviderPresets,
    selectMarketplaceProviderPreset,
    clearMarketplaceProviderPreset,
    settingsLoaded,
    saving,
    save,
    vendorInfo,
  };
}
