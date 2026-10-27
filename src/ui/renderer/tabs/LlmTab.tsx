import { CUSTOM_PROVIDER_WIRES, customProviderWire, type CustomProviderWire } from "../../../shared/custom-provider.js";
import { PROVIDER_PICKER_GROUPS, providerPickerEntries } from "../../../shared/provider-picker.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select.js";
import { Slider } from "../../../components/ui/slider.js";
import { Switch } from "../../../components/ui/switch.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { ChevronDown, ChevronUp, Loader2, Pin, Plus, RefreshCw, Store } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import {
  getReasoningDepths,
  VENDORS,
  budgetToDepthIndex,
  reasoningBudgetLabel,
  getVendorOption,
  visibleVendorsFor,
  type VendorOption,
} from "../constants.js";
import {
  canUseLlmVendorWithoutApiKey,
  isLLMVendor,
  narrowLlmVendor,
  isRetiredLlmModelMarker,
  type LLMVendor,
  type LlmModelRetirementReason,
  isOpenAICompatiblePresetVendor,
  isSelfHostedTrustedNetworkVendor,
  llmRouteModel,
  llmImageInputKey,
  llmRouteImageInput,
  type LLMVendorSettings,
  LLM_VENDOR_DEFAULTS,
  OPENAI_COMPATIBLE_VENDOR_PRESETS,
} from "../../../shared/llm-vendor-defaults.js";
import {
  cachedModelListEntry,
  chatRouteModelOptions,
  llmModelListCacheKey,
  STANDARD_CATALOGUE_ENDPOINT_VENDORS,
  usesEndpointModelCatalogue,
  type LlmModelListCache,
  type LlmModelListCacheEntry,
  type LlmModelListEntry,
} from "../../../shared/llm-model-list.js";
import {
  isOpenRouterFreeModel,
} from "../../../shared/openrouter-free-models.js";
import {
  marketplaceProviderPresetIdFromSecretId,
  marketplaceProviderPresetSecretId,
  modelDiscoveryPolicyAllowsFetch,
  modelDiscoveryPolicyUsesSeededOptions,
  type MarketplaceInstalledProviderPreset,
  type MarketplaceProviderModelDiscoveryPolicy,
} from "../../../shared/marketplace-package-assets.js";
import { isIpcErrorResult, type AppSettings, type AveApi } from "../types.js";
import { ConnectionRow, type ConnectionRowState } from "../components/ConnectionRow.js";
import { SettingsHelpPopover, SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { PricingOverridesSection } from "./PricingOverridesSection.js";
import { ModelCatalogRefreshSection } from "./ModelCatalogRefreshSection.js";
import { useTranslation, type I18nContextValue } from "../../../i18n/react.js";
import { compactionModelRouteKey } from "../../../shared/compaction-model.js";
import {
  SUBSCRIPTION_RUNTIME_API_COUNTERPART,
  SUBSCRIPTION_RUNTIME_ROW_PARTNER,
  MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH,
  openAiLoginTypeFor,
  isSubscriptionRuntimeId,
  subscriptionAcceptsModelOverride,
  subscriptionRuntimeDescriptor,
  type SubscriptionRuntimeId,
} from "../../../shared/subscription-runtime.js";
import { useSubscriptionProviders } from "./SubscriptionProvidersController.js";
import {
  ERROR_MESSAGE_KEYS,
  SignInMethodChoice,
  SubscriptionAuthControls,
  type ProviderSignInMethod,
  type SubscriptionProviderView,
} from "./SubscriptionProvidersSection.js";
import { TEST_IDS } from "../../../shared/test-ids.js";
import { formatTokensExact } from "../../../lib/cost-format.js";
import { errorMessage } from "../../../shared/error-message.js";
import { supportsVision } from "../../../engine/llm/vendor-capabilities.js";
import {
  resolveInputModalities,
  resolveModelRetirement,
  resolveReasoningSupport,
  resolveToolCallSupport,
  type ResolvedReasoningSupport,
  type ResolvedToolCallSupport,
} from "../../../shared/context-budget.js";
import { planReasoning } from "../../../engine/llm/reasoning-plan.js";

const PROVIDER_GROUP_LABEL_KEYS = {
  subscription: "llmTab.modeSubscription",
  api: "llmTab.groupApi",
  local: "llmTab.groupLocal",
  custom: "llmTab.groupCustom",
} as const;

const CUSTOM_WIRE_LABEL_KEYS = {
  "openai-chat": "llmTab.wireOpenaiChat",
  "openai-responses": "llmTab.wireOpenaiResponses",
  "anthropic-messages": "llmTab.wireAnthropicMessages",
  "google-gemini": "llmTab.wireGoogleGemini",
} as const;

export interface FallbackEntry {
  provider: LLMVendor;
  model: string;
}

/** The provider card whose credential form is open, and what has been typed into it. Kept apart from the active provider on purpose: `LlmTabProps.vendor` is what chat runs on, and opening a card must not move it. The draft therefore carries its OWN vendor / preset; the row it
 * belongs to; so the fields edit that row's `llm.vendors` block and that row's secret whatever chat is using. It is held by the settings orchestration rather than by this tab because the settings tabs unmount when the user leaves them, and a half-typed key has to survive that. */
export interface ProviderCredentialDraft {
  /** The provider card this draft belongs to. */
  readonly rowId: string;
  /** The `llm.vendors` block the fields edit. */
  readonly vendorId: string;
  /** The marketplace preset the row is reached through, or "". */
  readonly presetId: string;
  readonly keyInput: string;
  readonly baseUrl: string;
  readonly wire?: CustomProviderWire;
  readonly vertexProject: string;
  readonly vertexLocation: string;
}

/** What one provider card commits; its own block and its own secret, no more. */
export interface ProviderCredentialSave {
  /** The id the secret is stored under: a preset's scoped id, or the vendor. */
  credentialProviderId: string;
  vendorId: string;
  /** Empty leaves the stored key alone. */
  apiKey: string;
  /** Omitted where the row owns no persisted field; a vendor whose endpoint is fixed, or a preset that
   * carries its own. Writing a block for those would overwrite an endpoint that belongs to another row. */
  vendorBlock?: {
    baseUrl?: string | undefined;
    wire?: CustomProviderWire;
    vertexProject?: string | undefined;
    vertexLocation?: string | undefined;
  };
}





/** Every field a model-list state carries besides the status itself. A `Record` of the whole union rather than a hand-kept array: adding a field to any variant leaves a required property missing here and
 * fails to compile, where a list would have gone on comparing the old fields and reported an updated state as unchanged; which is invisible, because an unchanged state is deliberately not re-rendered. */
type ModelListStateField = ModelListState extends infer Variant
  ? Variant extends ModelListState ? Exclude<keyof Variant, "status"> : never
  : never;

const COMPARED_MODEL_LIST_FIELDS: Record<ModelListStateField, true> = {
  error: true,
  endpoint: true,
  fetchedAt: true,
  source: true,
  persistError: true,
  options: true,
  entries: true,
};

/** Whether two model-list states say the same thing about the same row. */
function sameModelListState(
  a: ModelListState | undefined,
  b: ModelListState,
): boolean {
  if (!a || a.status !== b.status) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return Object.keys(COMPARED_MODEL_LIST_FIELDS)
    .every((field) => left[field] === right[field]);
}

/** Render persisted catalogs immediately; fetch each vendor/endpoint/credential key once per window launch or on explicit refresh.
 * Module-scoped launch markers survive remounts; settings broadcasts and unrelated edits must not refetch. */
const modelListRefreshedThisLaunch = new Set<string>();

/** Cross that launch boundary deliberately. Nothing in the app calls this; a launch ends when the window goes; but a test has
 * to be able to say "and then the app started again", and a module that keeps the marker private cannot be asked to forget it. */
export function forgetModelListLaunchRefreshes(): void {
  modelListRefreshedThisLaunch.clear();
}

/** Forget one row's launch refresh. The key is built from vendor, endpoint and scope; not from the credential; so storing a working key over a broken one changes nothing the key can see,
 * and the launch marker would hold the row on its old failure until the window reloaded. A credential save IS a change to that row's inputs, so it earns the row its one request again. */
function forgetModelListLaunchRefresh(key: string): void {
  modelListRefreshedThisLaunch.delete(key);
}

/** Whether two vendor-block maps say the same thing about every row. Structural, not serialized: a block reaches this from two different writers (the store's normalizer and a broadcast
 * payload), and key ORDER between them is not a promise anyone made; comparing serialized text would report a reordered but identical block as news, which is exactly the churn this exists to stop. */
function sameSavedVendorBlocks(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  return sameSettingsValue(a, b);
}

function sameSettingsValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameSettingsValue(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key)
    && sameSettingsValue(left[key], right[key]));
}

/** The credential form's element id. One form is open at a time, so the button that reveals it can name it in `aria-controls`. */

/** A stable empty list, so an absent drafts prop is not a new identity a render. */
const NO_CREDENTIAL_DRAFTS: readonly ProviderCredentialDraft[] = [];

/** Catalog-specific bounds for the provider/model popups. Anchoring and width now come from `SelectContent` itself. What is still local is the SIZE OF THIS LIST: a provider catalog is long ids plus a provider/context/price detail line, so `min-w-64` keeps a narrow trigger's popup readable and the
 * height is capped at whichever is smaller; a list a person can scan, or the room Radix reports. Why a row's API route cannot serve chat yet, by cause. Kept as a map so the key strings stay greppable from the catalogue, the way `ERROR_MESSAGE_KEYS` does for the subscription runtimes' failures. */
const CHAT_BLOCKER_MESSAGE_KEYS = {
  "needs-api-key": "llmTab.chatNeedsApiKey",
  "needs-gcp-project": "llmTab.chatNeedsGcpProject",
  "awaiting-catalogue": "llmTab.chatAwaitingCatalogue",
  "catalogue-empty": "llmTab.chatCatalogueEmpty",
  "catalogue-failed": "llmTab.chatCatalogueFailed",
} as const;

type ChatBlocker = keyof typeof CHAT_BLOCKER_MESSAGE_KEYS;

export const SELECT_POPUP_LAYOUT =
  "min-w-64 max-h-[min(386px,var(--radix-select-content-available-height))]";

type ModelListState =
  | {
      /** Not attempted, and here is why: this provider's endpoint is fixed and its /models call is credentialed, so with nothing stored
       * the request could only come back 401. Reporting that as an error would paint a healthy card red for a state that is not a failure. */
      status: "needs-credential";
      options?: string[];
      entries?: LlmModelListEntry[];
      endpoint?: string;
      fetchedAt?: string;
      source?: "cache" | "network";
    }
  | {
      status: "loading";
      options?: string[];
      entries?: LlmModelListEntry[];
      endpoint?: string;
      fetchedAt?: string;
      source?: "cache" | "network";
    }
  | {
      status: "ready";
      options: string[];
      entries?: LlmModelListEntry[];
      endpoint: string;
      fetchedAt: string;
      source?: "cache" | "network";
      persistError?: string;
    }
  | {
      status: "error";
      error: string;
      options?: string[];
      entries?: LlmModelListEntry[];
      endpoint?: string;
      fetchedAt?: string;
      source?: "cache" | "network";
    };

interface ProviderSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  triggerId?: string;
  triggerClassName?: string;
  triggerTestId?: string;
  placeholder?: string;
  vendorOptions?: readonly ProviderOption[];
}

type ProviderOption = Omit<VendorOption, "id"> & {
  id: string;
  requiresApiKey?: boolean;
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
};

function normalizeProviderSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function ProviderSelect({
  value,
  onValueChange,
  triggerId,
  triggerClassName,
  triggerTestId,
  placeholder,
  vendorOptions = VENDORS,
}: ProviderSelectProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  const options = useMemo(
    () => vendorOptions.map((vendor) => ({
      id: vendor.id,
      label: vendor.label,
      searchText: `${vendor.id} ${vendor.label}`,
      marketplaceInstalled: marketplaceProviderPresetIdFromSecretId(vendor.id) !== undefined,
    })),
    [vendorOptions],
  );

  const normalizedQuery = normalizeProviderSearch(query);
  const filteredOptions = useMemo(
    () => normalizedQuery
      ? options.filter((option) => normalizeProviderSearch(option.searchText).includes(normalizedQuery))
      : options,
    [normalizedQuery, options],
  );

  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        onValueChange(nextValue);
        setQuery("");
      }}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <SelectTrigger
        id={triggerId}
        className={triggerClassName}
        data-testid={triggerTestId}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        className={SELECT_POPUP_LAYOUT}
        data-testid="llm-tab:vendor-content"
      >
        <div className="sticky top-0 z-10 border-b border-border/(--opacity-medium) bg-popover p-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            placeholder={t("llmTab.vendorSearchPlaceholder")}
            aria-label={t("llmTab.vendorSearchAriaLabel")}
            data-testid="llm-tab:vendor-search"
            className="h-8 text-xs"
          />
        </div>
        <SelectGroup className="p-1" data-testid="llm-tab:vendor-options">
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate">{option.label}</span>
                  {option.marketplaceInstalled && (
                    <span
                      className="inline-flex h-5 shrink-0 items-center rounded-full bg-secondary px-1.5 text-[10px] font-medium text-secondary-foreground"
                      data-testid={`llm-tab:vendor-marketplace-badge:${option.id}`}
                    >
                      {t("llmTab.marketplaceInstalledBadge")}
                    </span>
                  )}
                </span>
              </SelectItem>
            ))
          ) : (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("llmTab.vendorNoResults")}
            </div>
          )}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export interface LlmTabProps {
  retiredLlmProvider?: AppSettings["llm"]["retiredProvider"] | null;
  api: AveApi;
  /** The provider chat runs on. Read-only here: a card is opened by this tab, but WHICH provider serves chat
   * moves only through the explicit switch, `selectApiVendorModel`, or a subscription runtime's own action. */
  vendor: string;
  /** The active provider's endpoint; what its model-list handshake reaches. */
  baseUrl: string;
  /** Whether the ACTIVE provider has a stored key. Rows read their own. */
  hasKey: boolean;
  setHasKey: (v: boolean) => void;
  /** Every card being edited, and what has been typed into each. One entry per row: rows expand independently, so a half-typed key on one must survive the user opening another. */
  providerCredentialDrafts?: readonly ProviderCredentialDraft[];
  onProviderCredentialDraftsChange?: (next: readonly ProviderCredentialDraft[]) => void;
  /** Commits one card: that row's vendor block and that row's secret only. */
  onSaveProviderCredential?: (input: ProviderCredentialSave) => Promise<boolean>;
  marketplaceProviderPresetId?: string;
  marketplaceProviderPresets?: readonly MarketplaceInstalledProviderPreset[];
  onSelectMarketplaceProviderPreset?: (preset: MarketplaceInstalledProviderPreset) => void;
  onClearMarketplaceProviderPreset?: () => void;
  /** Opens Settings → Marketplace with the provider package filter active. */
  onOpenMarketplace?: () => void;
  model: string;
  setModel: (v: string) => void;
  /** Moves vendor and model together when the pick belongs to another vendor. */
  selectApiVendorModel: (vendorId: string, modelId: string) => void;
  enableThinking: boolean;
  setEnableThinking: (v: boolean) => void;
  thinkingBudget: number;
  setThinkingBudget: (v: number) => void;
  outputTokenLimit: number;
  fallbackChain: FallbackEntry[];
  setFallbackChain: (updater: FallbackEntry[] | ((c: FallbackEntry[]) => FallbackEntry[])) => void;
  fallbackOpen: boolean;
  setFallbackOpen: (updater: boolean | ((o: boolean) => boolean)) => void;
  onSaved: () => void;
  /** Called after the user changes an immediate-apply control (the model chooser / vendor / thinking toggle / reasoning slider).
   * The dialog debounces these and persists via `s.save("llm")` so the user gets immediate-feel application without spamming saves. */
  onImmediateChange?: () => void;
  /** Section-anchored explicit save handler, for the TYPED fields; an API key, a base URL; where a keystroke is not yet a decision. A pick from a chooser is, and goes through `onImmediateChange` instead. Both the 공급자 구성 and Fallback
   * Chain sections render their own Save button that calls this; the orchestration save() persists the whole `llm` payload, so the two buttons are functionally identical and the visual placement just anchors each Save to its inputs. */
  onSave?: () => void;
  saving?: boolean;
  settingsLoaded?: boolean;
}

/** Inline save bar for a LlmTab subsection. Both 공급자 구성 and Fallback Chain reuse this; the Extended
 * Thinking section is fully immediate-apply (Switch + Slider auto-save via onImmediateChange) and renders no bar. */
function SectionSaveBar({
  onSave,
  onCancel,
  saving,
  settingsLoaded,
  dirty = true,
  testId,
}: {
  onSave: () => void;
  /** Given where the bar closes something; a provider row; so the user can put the row away without committing what they typed into it. */
  onCancel?: () => void;
  saving: boolean;
  settingsLoaded: boolean;
  /** Omitted where the section has no dirty signal to offer, in which case Save stays available. */
  dirty?: boolean;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end gap-2 border-t border-border/(--opacity-medium) pt-2">
      {onCancel && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
          data-testid={`${testId}-cancel`}
        >
          {t("llmTab.cancel")}
        </Button>
      )}
      <Button
        size="sm"
        onClick={onSave}
        disabled={saving || !settingsLoaded || !dirty}
        data-testid={testId}
      >
        {saving ? t("llmTab.saving") : t("llmTab.save")}
      </Button>
    </div>
  );
}

/** Inline badge for "즉시 적용" label. */
function ImmediateBadge() {
  const { t } = useTranslation();
  return (
    <span data-testid="llm-tab:immediate-badge" className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full border border-transparent bg-secondary px-2.5 text-xs font-semibold text-secondary-foreground">
      {t("llmTab.immediateApply")}
    </span>
  );
}

function getVendorInfo(vendorId: string): VendorOption {
  return getVendorOption(vendorId);
}

function providerOptionFromPreset(
  preset: MarketplaceInstalledProviderPreset,
): ProviderOption {
  return {
    id: marketplaceProviderPresetSecretId(preset.providerId),
    label: preset.label,
    placeholder: preset.apiKeyPlaceholder ?? "sk-...",
    needsBaseUrl: true,
    baseUrlPlaceholder: preset.baseUrl,
    modelOptions: preset.modelOptions,
    requiresApiKey: preset.requiresApiKey,
    ...(preset.modelDiscoveryPolicy ? { modelDiscoveryPolicy: preset.modelDiscoveryPolicy } : {}),
  };
}

function providerOptionsForPresets(
  presets: readonly MarketplaceInstalledProviderPreset[],
): ProviderOption[] {
  return presets.map(providerOptionFromPreset);
}


/** Whether this provider has a model list worth asking its endpoint for. The two contract questions come FIRST, before any address is considered: may the host fetch this provider's list at all, and does this provider have an endpoint list at all. An address is not a catalogue; Azure AI Foundry's `baseUrl` names one deployment
 * while its models are the curated table here; so letting a configured endpoint short-circuit these made a card fetch a list it does not read, and paint itself red when the fetch failed. Only once both are answered does the address decide: a user-supplied endpoint is asked, and so are the vendors whose `/models` is fixed and known. */
function shouldSyncModelList(
  vendorId: string,
  baseUrl?: string,
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy,
): boolean {
  if (!vendorId) return false;
  if (!modelDiscoveryPolicyAllowsFetch(modelDiscoveryPolicy)) return false;
  if (STANDARD_CATALOGUE_ENDPOINT_VENDORS.has(vendorId)) return true;
  if (!usesEndpointModelCatalogue(vendorId)) return false;
  return Boolean(baseUrl?.trim());
}

/** Ask for endpoints only when users own the address, such as self-hosted or account-specific routes; fixed presets already supply theirs. */
function endpointIsUserSupplied(
  vendorId: string,
  info: ProviderOption | VendorOption,
  lockedToMarketplacePreset: boolean,
): boolean {
  if (lockedToMarketplacePreset) return false;
  if (!info.needsBaseUrl) return false;
  if (isLLMVendor(vendorId) && isSelfHostedTrustedNetworkVendor(vendorId)) return true;
  return !isOpenAICompatiblePresetVendor(vendorId);
}

function modelOptionsFor(
  vendorId: string,
  selectedModel: string,
  syncedOptions?: readonly string[],
  info: ProviderOption | VendorOption = getVendorInfo(vendorId),
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy,
  isRetired: (model: string) => boolean = () => false,
): string[] {
  // The one derivation the chat chooser and the permission reviewer's model catalog share (`chatRouteModelOptions`).
  return chatRouteModelOptions({
    vendorId,
    selectedModel,
    ...(syncedOptions ? { syncedOptions } : {}),
    seed: info,
    ...(modelDiscoveryPolicy ? { modelDiscoveryPolicy } : {}),
    isRetired,
  });
}

/** Which retirement tier a model is in on the route this cache key names, judged from the catalog and that route's last successful listing. */
function modelRetirementOn(
  cache: LlmModelListCache,
  modelListKey: string | undefined,
  vendorId: string,
): (model: string) => LlmModelRetirementReason | undefined {
  const [, baseUrl = ""] = modelListKey?.split("\n") ?? [];
  const listing = modelListKey ? cache[modelListKey] : undefined;
  return (model) => resolveModelRetirement({
    vendor: vendorId,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(listing ? { listing } : {}),
  });
}

/** Whether a model is in either retirement tier; both are hidden from the pickers. */
function modelRetiredOn(
  cache: LlmModelListCache,
  modelListKey: string | undefined,
  vendorId: string,
): (model: string) => boolean {
  const tier = modelRetirementOn(cache, modelListKey, vendorId);
  return (model) => tier(model) !== undefined;
}

/** What a picker whose saved model is hidden shows instead, by tier. */
function retiredModelPlaceholder(
  t: (key: string, params?: Record<string, string | number>) => string,
  reason: LlmModelRetirementReason,
  model: string,
): string {
  return reason === "unlisted"
    ? t("llmTab.modelRetiredPlaceholder", { model })
    : t("llmTab.modelDeprecatedPlaceholder", { model });
}

/** The saved model, when the endpoint's catalogue no longer lists it. `modelOptionsFor` keeps the saved id in the chooser so a configured provider never shows a blank selection; but that also lets a model the server has since dropped sit at the top of the
 * list looking exactly like one it still serves, while every request to it is rejected. This names that case so the chooser and the status line can say it. Only a catalogue that actually landed counts: with nothing synced yet there is nothing to disagree with. */
export function unlistedSavedModel(
  selectedModel: string,
  catalogue: readonly string[] | undefined,
): string | null {
  const model = selectedModel.trim();
  if (!model || !catalogue || catalogue.length === 0) return null;
  return catalogue.includes(model) ? null : model;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function modelEntryMap(entries: readonly LlmModelListEntry[] | undefined): Map<string, LlmModelListEntry> {
  const map = new Map<string, LlmModelListEntry>();
  for (const entry of entries ?? []) {
    if (!entry.id || map.has(entry.id)) continue;
    map.set(entry.id, entry);
  }
  return map;
}

function modelEntryPricingLabel(entry: LlmModelListEntry | undefined): string | null {
  const pricing = entry?.pricing;
  if (!pricing) return null;
  if (pricing.prompt === undefined && pricing.completion === undefined) return null;
  return `in ${pricing.prompt ?? "?"} / out ${pricing.completion ?? "?"}`;
}

/** Keep provider and model on one line; put the free-route disclaimer in the title.
 * Determine missing reasoning levels from the engine plan independently of the selected budget. */
function reasoningFallsToHost(params: {
  vendor: LLMVendor;
  model: string;
  baseUrl?: string;
  catalogModel?: string;
  reasoning?: ResolvedReasoningSupport;
}): boolean {
  const plan = planReasoning({
    vendor: params.vendor,
    model: params.model,
    enableThinking: true,
    budgetTokens: 16_000,
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    ...(params.catalogModel !== undefined ? { catalogModel: params.catalogModel } : {}),
    ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
    request: { hasTools: false },
  });
  return plan?.kind === "none" && plan.source === "host-fallback";
}

function ModelSelectItemContent({
  option,
  entry,
  provider,
  vision,
  toolCall,
  reasoning,
  reasoningUnstatedVendor,
  factsOverride,
  tone,
}: {
  option: string;
  entry?: LlmModelListEntry;
  /** Whether images may be attached to a turn on THIS model, when the route serving it has answered.
   * Undefined draws nothing: the badge is a positive claim, and a route that has not answered has not made one. */
  vision?: boolean;
  /** The same capability result the request uses to withhold tool definitions. */
  toolCall?: ResolvedToolCallSupport;
  /** The shared reasoning answer (`resolveReasoningSupport`) the engine plans with. */
  reasoning?: ResolvedReasoningSupport;
  /** Set when thinking here would send no effort (host fallback): the vendor whose `catalogModel` setting supplies the levels, named in the badge's help. */
  reasoningUnstatedVendor?: string;
  /** Leading column: who serves this model. The caller decides whether the catalogue entry may name it;
   * see `UnifiedModelOption.vendorLabel`; and the fallback chain lists a vendor's own models without one. */
  provider?: string;
  /** Trailing facts for the same case. */
  factsOverride?: string;
  /** The facts carry a problem, not a number; a saved model the endpoint dropped. */
  tone?: "destructive";
}) {
  const { t } = useTranslation();
  const isFree = entry?.tags?.free === true || isOpenRouterFreeModel(option);
  const isRouter = entry?.tags?.router === true;
  const isLocal = entry?.tags?.local === true;
  const isReasoning = reasoning?.supported === true;
  const noTools = toolCall?.supported === false;
  // Provider is the leading column now, so it is NOT repeated in the trailing facts; those are the numbers that differ between models.
  const facts = factsOverride ? [factsOverride] : [
    entry?.contextLength !== undefined
      ? t("llmTab.modelContextTokens", { count: compactNumber(entry.contextLength) })
      : undefined,
    modelEntryPricingLabel(entry) ?? undefined,
  ].filter((part): part is string => Boolean(part));
  return (
    <span
      className="flex w-full min-w-0 flex-col gap-1"
      data-model-id={option}
      {...(isFree ? { title: t("llmTab.openRouterFreeDisclaimer") } : {})}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        {provider && (
          <span
            className="max-w-[9rem] min-w-0 truncate text-muted-foreground"
            data-testid={`llm-tab:model-provider:${option}`}
          >
            {provider}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{option}</span>
        {reasoningUnstatedVendor !== undefined && (
          <Badge
            variant="outline"
            className="h-4 shrink-0 px-1 text-[9px]"
            data-testid={`llm-tab:model-reasoning-unstated:${option}`}
            role="note"
            title={t("llmTab.modelReasoningUnstatedHelp", { vendor: reasoningUnstatedVendor })}
            aria-label={t("llmTab.modelReasoningUnstatedHelp", { vendor: reasoningUnstatedVendor })}
          >
            {t("llmTab.modelReasoningUnstatedBadge")}
          </Badge>
        )}
      </span>
      {(isFree || isRouter || isLocal || vision === true || isReasoning || noTools || facts.length > 0) && (
        <span className="flex min-w-0 flex-wrap items-center gap-1 [[data-slot=select-value]_&]:hidden">
          {isFree && (
            <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[9px] uppercase">
              {t("llmTab.openRouterFreeBadge")}
            </Badge>
          )}
          {isRouter && (
            <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] uppercase">
              {t("llmTab.modelRouterBadge")}
            </Badge>
          )}
          {isLocal && (
            <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] uppercase">
              {t("llmTab.modelLocalBadge")}
            </Badge>
          )}
          {vision === true && (
            <Badge
              variant="outline"
              className="h-4 shrink-0 px-1 text-[9px] uppercase"
              data-testid={`llm-tab:model-vision:${option}`}
            >
              {t("llmTab.modelVisionBadge")}
            </Badge>
          )}
          {isReasoning && (
            <Badge
              variant="outline"
              className="h-4 shrink-0 px-1 text-[9px] uppercase"
              data-testid={`llm-tab:model-reasoning:${option}`}
            >
              {t("llmTab.modelReasoningBadge")}
            </Badge>
          )}
          {noTools && (
            <Badge
              variant="outline"
              className="h-4 shrink-0 px-1 text-[9px] uppercase"
              data-testid={`llm-tab:model-no-tools:${option}`}
              role="note"
              title={t("llmTab.modelNoToolsHelp")}
              aria-label={t("llmTab.modelNoToolsHelp")}
            >
              {t("llmTab.modelNoToolsBadge")}
            </Badge>
          )}
          {facts.length > 0 && (
            <span
              className={`min-w-0 truncate text-[10px] ${tone === "destructive" ? "text-destructive" : "text-muted-foreground"}`}
              data-testid={`llm-tab:model-facts:${option}`}
            >
              {facts.join(" · ")}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/** One choosable model, wherever it comes from. The API vendor's catalogue and every connected subscription's models are the same kind
 * of choice; "who answers, with what"; and the user makes exactly one of them. Keeping them in two lists made the screen say otherwise. */
export interface UnifiedModelOption {
  /** `providerId::modelId`. The Select's value, so a model id repeated by two providers still resolves to the right one. */
  value: string;
  providerId: string;
  /** The name of the ROW this model is offered on; the card title. It is the chooser's group label. */
  providerLabel: string;
  /** Leading column: who serves THIS model. Usually the catalogue's own word, because an aggregator's catalogue is other companies' models and the sub-vendor is the only thing that tells them apart. It falls back to the row
   * name for the rows whose catalogue cannot name itself; an OpenAI-compatible server reports everything it serves as owned by "openai"; so a self-hosted endpoint is named by what the user connected. See `unifiedOptions`. */
  vendorLabel: string;
  modelId: string;
  entry?: LlmModelListEntry;
  /** Whether images may be attached on this model, per the route that serves it; the same gate the composer and the send path use. */
  vision?: boolean;
  toolCall?: ResolvedToolCallSupport;
  reasoning?: ResolvedReasoningSupport;
  /** The vendor whose `catalogModel` would state the levels, when nobody does. */
  reasoningUnstatedVendor?: string;
  /** Subscription-side facts, where there is no catalogue entry to read them from. */
  facts?: string;
  /** The provider exposes no model choice; this row IS the provider. */
  fixed?: boolean;
  /** Saved, but no longer in the endpoint's catalogue; see `unlistedSavedModel`. */
  unlisted?: boolean;
}

/** Marks the API-key provider inside a unified option value. One provider, however it is reached. A provider with both halves is ONE row: the
 * same company, two ways in. The settings list must not make a user learn that "OpenAI" and "Codex" are the same account seen from two angles. */
interface ProviderConnection {
  /** The subscription runtime id when paired, the marketplace preset's secret id when the row IS a preset, otherwise the API vendor id. */
  id: string;
  label: string;
  /** Present when this provider can be reached with an API key. */
  apiVendorId?: string;
  /** The marketplace preset this row is reached through, when there is one. */
  presetId?: string;
  /** The `modelLists` key whose handshake belongs to THIS row. Folding the keys onto the vendor made
   * two presets share one set of facts, so one preset's failure was reported on the other's card. */
  modelListKey?: string;
  apiConfigured: boolean;
  subscription?: SubscriptionProviderView;
  /** A second subscription way into the same provider (OpenAI: ChatGPT plan usage beside the Codex CLI); see `SUBSCRIPTION_RUNTIME_ROW_PARTNER`. */
  planSubscription?: SubscriptionProviderView;
  connected: boolean;
}

/** One configured way in to an API vendor; see `configuredApiRoutes`. */
interface ConfiguredApiRoute {
  vendorId: string;
  presetId?: string;
  modelListKey: string;
}

/** The name Settings gives a subscription runtime: its company's, through the API counterpart ("OpenAI" for the
 * ChatGPT plan, "Anthropic Claude" for the Claude plan). The runtime's own name is never a provider a user picks. */
function subscriptionCompanyLabel(view: SubscriptionProviderView): string {
  const counterpart = SUBSCRIPTION_RUNTIME_API_COUNTERPART[
    SUBSCRIPTION_RUNTIME_ROW_PARTNER[view.descriptor.id] ?? view.descriptor.id
  ];
  return counterpart ? getVendorInfo(counterpart).label : view.descriptor.planName;
}

/** The chooser's group name for a subscription's models: the company and the plan, so a subscription pick and
 * an API-key pick from the same company cannot be confused for one another ("OpenAI · ChatGPT subscription"). */
function subscriptionModelsLabel(t: I18nContextValue["t"], view: SubscriptionProviderView): string {
  // A partner runtime shares its company with the primary one, so its group names its own way in.
  if (SUBSCRIPTION_RUNTIME_ROW_PARTNER[view.descriptor.id]) {
    return t("subscriptionProvidersSection.chatgptPlanModels", {
      company: subscriptionCompanyLabel(view),
      plan: view.descriptor.planName,
    });
  }
  return t("subscriptionProvidersSection.subscriptionModels", {
    company: subscriptionCompanyLabel(view),
    plan: view.descriptor.planName,
  });
}

/** Whether a subscription model may be sent original images: the runtime's capability, then (for a runtime whose image
 * input follows the model) the same catalog predicate the composer and the send path use. */
function subscriptionModelAcceptsImages(runtimeId: string, modelId: string): boolean {
  if (!isSubscriptionRuntimeId(runtimeId)) return false;
  const vendor = subscriptionRuntimeDescriptor(runtimeId).imageInputFollowsModelOf;
  return vendor === undefined || supportsVision(vendor, modelId);
}

function apiRouteRowId(route: ConfiguredApiRoute): string {
  return route.presetId ? marketplaceProviderPresetSecretId(route.presetId) : route.vendorId;
}

const API_PROVIDER_PREFIX = "api:";

export function apiProviderId(vendorId: string): string {
  return `${API_PROVIDER_PREFIX}${vendorId}`;
}

export function unifiedValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function parseUnifiedValue(value: string): { providerId: string; modelId: string } | null {
  const at = value.indexOf("::");
  if (at <= 0) return null;
  return { providerId: value.slice(0, at), modelId: value.slice(at + 2) };
}

function upstreamModelProvider(
  modelId: string,
  providerId: string,
  providerLabel: string,
  otherLabel: string,
): { id: string; label: string } {
  const presetId = providerId.startsWith(API_PROVIDER_PREFIX)
    ? providerId.slice(API_PROVIDER_PREFIX.length) : "";
  if (!isOpenAICompatiblePresetVendor(presetId)
    || !OPENAI_COMPATIBLE_VENDOR_PRESETS[presetId].upstreamPrefixedModelIds) {
    return { id: "", label: providerLabel };
  }
  const slash = modelId.indexOf("/");
  // OpenRouter's `~vendor/...-latest` aliases belong in the vendor's own group.
  const id = slash > 0 ? modelId.slice(0, slash).replace(/^~/, "") : "";
  const vendorId = id === "anthropic" ? "claude" : id === "google" ? "gemini" : id;
  const readableId = id.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return {
    id,
    label: isLLMVendor(vendorId) ? getVendorOption(vendorId).label : readableId || otherLabel,
  };
}

/** Show currently offered pins first across providers, then group other models by provider; retain stored pins for disconnected catalogs.
 * Reviewer selection omits pin controls and offers unset to follow chat. */
export function UnifiedModelSelect({
  options,
  value,
  onValueChange,
  pinned = [],
  onTogglePin,
  placeholder,
  popupClassName,
  disabled = false,
  triggerId = "model-select",
  testId = TEST_IDS.llmModelSelect,
  leadingOption,
}: {
  options: readonly UnifiedModelOption[];
  value: string;
  onValueChange: (value: string) => void;
  pinned?: readonly string[];
  /** Absent: the chooser offers no pinning (pins belong to the chat picker). */
  onTogglePin?: (modelId: string) => void;
  placeholder: string;
  popupClassName: string;
  /** A chat-runtime switch is already in flight; a second pick would race it. */
  disabled?: boolean;
  triggerId?: string;
  testId?: string;
  /** A first row that is not a model, e.g. "follow the chat model". */
  leadingOption?: { value: string; label: string };
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchFocusPreferredRef = useRef(true);
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const indexedOptions = useMemo(() => options.map((option) => {
    const modelId = parseUnifiedValue(option.value)?.modelId ?? option.modelId;
    const upstream = upstreamModelProvider(modelId, option.providerId, option.providerLabel, t("llmTab.modelOtherGroup"));
    return {
      option,
      upstream,
      free: option.entry?.tags?.free === true || isOpenRouterFreeModel(modelId),
      searchText: normalizeProviderSearch([
        modelId, option.modelId, option.entry?.name, upstream.id, upstream.label,
        option.providerLabel, option.vendorLabel,
      ].join(" ")),
    };
  }), [options, t]);
  const groupedOptions = useMemo(() => {
    const providers = new Map<string, {
      label: string;
      upstreams: Map<string, { label: string; unprefixed: boolean; items: UnifiedModelOption[] }>;
    }>();
    const pins: UnifiedModelOption[] = [];
    for (const { option, upstream } of indexedOptions) {
      if (pinnedSet.has(option.modelId)) {
        pins.push(option);
        continue;
      }
      let provider = providers.get(option.providerId);
      if (!provider) {
        provider = { label: option.providerLabel, upstreams: new Map() };
        providers.set(option.providerId, provider);
      }
      let group = provider.upstreams.get(upstream.label);
      if (!group) {
        group = { label: upstream.label, unprefixed: false, items: [] };
        provider.upstreams.set(upstream.label, group);
      }
      group.unprefixed ||= upstream.id === "";
      group.items.push(option);
    }
    return {
      pins,
      providers: [...providers].map(([id, provider]) => ({
        id,
        label: provider.label,
        groups: [...provider.upstreams].map(([upstreamId, group]) => ({ id: upstreamId, ...group }))
          .sort((a, b) => Number(a.unprefixed) - Number(b.unprefixed) || a.label.localeCompare(b.label)),
      })),
    };
  }, [indexedOptions, pinnedSet]);
  const normalizedQuery = normalizeProviderSearch(query);
  const matches = useMemo(() => {
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    return new Set(indexedOptions.filter(({ free, searchText }) => terms.every((term) =>
      term === "free" || term === "무료" ? free : searchText.includes(term),
    )).map(({ option }) => option.value));
  }, [indexedOptions, normalizedQuery]);
  const visibleGroups = useMemo(() => ({
    pins: groupedOptions.pins.filter((option) => matches.has(option.value)),
    providers: groupedOptions.providers.map((provider) => ({
      ...provider,
      groups: provider.groups.map((group) => ({
        ...group,
        items: group.items.filter((option) => matches.has(option.value)),
      })).filter((group) => group.items.length > 0),
    })).filter((provider) => provider.groups.length > 0),
  }), [groupedOptions, matches]);

  const content = (option: UnifiedModelOption) => (
    <ModelSelectItemContent
      option={option.modelId}
      {...(option.entry ? { entry: option.entry } : {})}
      /* Kept on grouped rows too, where it repeats the group header: the collapsed trigger renders this same content and has no label of its own, so dropping it would leave the closed control showing a bare model id. */
      provider={option.vendorLabel}
      {...(option.vision === true ? { vision: true } : {})}
      {...(option.toolCall ? { toolCall: option.toolCall } : {})}
      {...(option.reasoning ? { reasoning: option.reasoning } : {})}
      {...(option.reasoningUnstatedVendor ? { reasoningUnstatedVendor: option.reasoningUnstatedVendor } : {})}
      {...(option.facts ? { factsOverride: option.facts } : {})}
      {...(option.unlisted ? { tone: "destructive" as const } : {})}
    />
  );
  const selectedOption = options.find((option) => option.value === value);

  const togglePin = onTogglePin;
  const row = (option: UnifiedModelOption) => {
    const isPinned = pinnedSet.has(option.modelId);
    return (
      <SelectItem
        key={option.value}
        value={option.value}
        className="hover:bg-accent hover:text-accent-foreground"
        onPointerMove={(event) => {
          if (document.activeElement === searchInputRef.current) event.preventDefault();
        }}
        leading={togglePin === undefined ? undefined : (
          /* Outside ItemText so the pin stays in the row and never mirrors into the collapsed trigger. Radix commits a row on POINTERUP, so both pointer events stop here; pinning is not choosing. */
          <span
            role="button"
            tabIndex={-1}
            aria-label={isPinned ? t("llmTab.modelUnpin") : t("llmTab.modelPin")}
            aria-pressed={isPinned}
            data-testid={`llm-tab:model-pin:${option.value}`}
            className={[
              "inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded",
              "hover:bg-accent",
              isPinned ? "text-primary" : "text-muted-foreground/(--opacity-strong)",
            ].join(" ")}
            onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onPointerUp={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              togglePin(option.modelId);
            }}
          >
            <Pin className={`h-3 w-3 ${isPinned ? "fill-current" : ""}`} aria-hidden={true} />
          </span>
        )}
      >
        {content(option)}
      </SelectItem>
    );
  };

  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        onValueChange(nextValue);
        setQuery("");
      }}
      onOpenChange={(open) => {
        searchFocusPreferredRef.current = true;
        if (!open) setQuery("");
      }}
      disabled={disabled}
    >
      <SelectTrigger id={triggerId} className="w-full" data-testid={testId}>
        <SelectValue placeholder={placeholder}>
          {selectedOption ? content(selectedOption) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        className={popupClassName}
        onFocusCapture={(event) => {
          // Placement and changes to the selected row can request item focus. Keep search active until the user navigates or presses an item.
          if (searchFocusPreferredRef.current && event.target !== searchInputRef.current) {
            event.stopPropagation();
            searchInputRef.current?.focus();
          }
        }}
        onPointerDownCapture={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('[role="option"]') && !target.closest('[role="button"]')) {
            searchFocusPreferredRef.current = false;
          }
        }}
      >
        <div className="sticky top-0 z-10 border-b border-border/(--opacity-medium) bg-popover p-2">
          <Input
            ref={searchInputRef}
            value={query}
            onFocus={() => { searchFocusPreferredRef.current = true; }}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                const firstItem = event.currentTarget.closest('[role="listbox"]')
                  ?.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])');
                if (firstItem) {
                  searchFocusPreferredRef.current = false;
                  firstItem.focus();
                }
                event.preventDefault();
              }
              if (event.key !== "Escape") event.stopPropagation();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            placeholder={t("llmTab.modelSearchPlaceholder")}
            aria-label={t("llmTab.modelSearchAriaLabel")}
            data-testid="llm-tab:model-search"
            className="h-8 text-xs"
          />
        </div>
        {leadingOption && (
          <SelectItem value={leadingOption.value}>{leadingOption.label}</SelectItem>
        )}
        {visibleGroups.pins.length > 0 && (
          <SelectGroup>
            <SelectLabel className="text-[10px] uppercase tracking-normal text-muted-foreground">
              {t("llmTab.modelPinnedGroup")}
            </SelectLabel>
            {visibleGroups.pins.map(row)}
          </SelectGroup>
        )}
        {visibleGroups.providers.map((provider) => (
          <SelectGroup key={provider.id} data-model-provider={provider.id}>
            <SelectLabel className="text-[10px] uppercase tracking-normal text-muted-foreground">
              {provider.label}
            </SelectLabel>
            {provider.groups.map((group) => group.label === provider.label ? (
              group.items.map(row)
            ) : (
              <SelectGroup key={group.id}>
                <SelectLabel className="text-[10px] text-muted-foreground">
                  {group.label}
                </SelectLabel>
                {group.items.map(row)}
              </SelectGroup>
            ))}
          </SelectGroup>
        ))}
        {options.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground" data-testid="llm-tab:model-none">
            {t("llmTab.modelNoConnectedProvider")}
          </div>
        )}
        <div
          aria-live="polite"
          role="status"
          className={normalizedQuery ? "px-2 py-2 text-center text-xs text-muted-foreground" : "sr-only"}
          data-testid="llm-tab:model-search-status"
        >
          {normalizedQuery && (matches.size === 0 ? (
            <span data-testid="llm-tab:model-no-results">{t("llmTab.modelNoResults")}</span>
          ) : t("llmTab.modelMatchCount", { count: matches.size }))}
        </div>
      </SelectContent>
    </Select>
  );
}

function modelListStateFromCacheEntry(entry: LlmModelListCacheEntry): ModelListState {
  return {
    status: "ready",
    options: entry.models,
    entries: entry.modelEntries,
    endpoint: entry.endpoint,
    fetchedAt: entry.fetchedAt,
    source: "cache",
  };
}

function modelListStatesFromCache(
  cache?: LlmModelListCache,
  marketplaceProviderPresets: readonly MarketplaceInstalledProviderPreset[] = [],
): Record<string, ModelListState> {
  if (!cache) return {};
  const states: Record<string, ModelListState> = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry.models.length) continue;
    if (entry.vendor === "openai-compatible" && entry.credentialScope) {
      const preset = marketplaceProviderPresets.find((candidate) =>
        candidate.providerId === entry.credentialScope
      );
      if (modelDiscoveryPolicyUsesSeededOptions(preset?.modelDiscoveryPolicy)) continue;
    }
    states[key] = modelListStateFromCacheEntry(entry);
  }
  return states;
}

function optionsFromModelListState(state: ModelListState | undefined): readonly string[] | undefined {
  if (state?.status === "ready") return state.options ?? [];
  return state?.options && state.options.length > 0 ? state.options : undefined;
}

function hasUsableModelListOptions(state: ModelListState | undefined): boolean {
  return (optionsFromModelListState(state)?.length ?? 0) > 0;
}

/** What the last handshake did, in one phrase. The row's subline and the chooser's status line read it from here so the two can never disagree. It separates a failure that left a previously synced catalogue
 * standing from one that left nothing; the first is still a usable list and the second is not, and a single message claiming saved options would be wrong in one of the two cases whichever way it was worded. */
function modelSyncLabel(t: I18nContextValue["t"], state: ModelListState): string {
  switch (state.status) {
    case "needs-credential":
      return t("llmTab.modelSyncNeedsApiKey");
    case "loading":
      return t("llmTab.modelSyncing");
    case "error":
      return hasUsableModelListOptions(state)
        ? t("llmTab.modelSyncFailedUsingCache")
        : t("llmTab.modelSyncFailed");
    case "ready":
      return t("llmTab.modelSynced", { count: state.options.length });
  }
}

function reconcileModelListStatesWithCache(
  current: Record<string, ModelListState>,
  cachedStates: Record<string, ModelListState>,
): Record<string, ModelListState> {
  const next: Record<string, ModelListState> = {};
  for (const [key, state] of Object.entries(current)) {
    if (state.source === "cache" && !(key in cachedStates)) continue;
    next[key] = state;
  }
  for (const [key, state] of Object.entries(cachedStates)) {
    const currentState = current[key];
    next[key] = currentState && currentState.source !== "cache" && hasUsableModelListOptions(currentState)
      ? currentState
      : state;
  }
  return next;
}

export function LlmTab(props: LlmTabProps) {
  const {
    api,
    vendor,
    retiredLlmProvider,
    baseUrl,
    hasKey,
    setHasKey,
    providerCredentialDrafts = NO_CREDENTIAL_DRAFTS,
    onProviderCredentialDraftsChange,
    onSaveProviderCredential,
    marketplaceProviderPresetId = "",
    marketplaceProviderPresets = [],
    onSelectMarketplaceProviderPreset,
    onClearMarketplaceProviderPreset,
    onOpenMarketplace,
    model,
    setModel,
    selectApiVendorModel,
    enableThinking,
    setEnableThinking,
    thinkingBudget,
    setThinkingBudget,
    outputTokenLimit,
    fallbackChain,
    setFallbackChain,
    fallbackOpen,
    setFallbackOpen,
    onSaved,
    onImmediateChange,
    onSave,
    saving = false,
    settingsLoaded = true,
  } = props;
  const { t } = useTranslation();
  const selectedMarketplaceProviderPreset = vendor === "openai-compatible" && marketplaceProviderPresetId
    ? marketplaceProviderPresets.find((preset) => preset.providerId === marketplaceProviderPresetId)
    : undefined;
  const activeModelListCredentialScope = selectedMarketplaceProviderPreset?.providerId ?? "";
  const hasOnSave = typeof onSave === "function";
  const trimmedModel = model.trim();
  const activeModelValue = trimmedModel;
  /** What is actually stored for each vendor, mirrored so the typed fields can say whether they still hold something uncommitted. */
  const [savedVendorBlocks, setSavedVendorBlocks] = useState<
    Readonly<Record<string, {
      model?: string;
      catalogModel?: string;
      imageInput?: LLMVendorSettings["imageInput"];
      presetModels?: Record<string, string>;
      baseUrl?: string;
      wire?: CustomProviderWire;
      vertexProject?: string;
      vertexLocation?: string;
    }>>
  >({});
  const [imageInputSaving, setImageInputSaving] = useState(false);
  const [imageInputError, setImageInputError] = useState<string | null>(null);
  const imageInputPresetId = vendor === "openai-compatible" ? marketplaceProviderPresetId : undefined;
  const imageInputSelection = JSON.stringify([vendor, imageInputPresetId ?? "", activeModelValue]);
  const selectedImageInput = llmRouteImageInput(savedVendorBlocks[vendor] ?? {}, activeModelValue, imageInputPresetId);
  const handleImageInputChange = async (value: string) => {
    if (!isLLMVendor(vendor) || !activeModelValue || imageInputSaving) return;
    const selection = imageInputSelection;
    const key = llmImageInputKey(activeModelValue, imageInputPresetId);
    setImageInputSaving(true);
    setImageInputError(null);
    try {
      const result = await api.updateSettings({ llm: { vendors: {
        [vendor]: { imageInput: { [key]: value === "automatic" ? undefined : value === "supported" } },
      } } });
      if (isIpcErrorResult(result)) setImageInputError(selection);
    } catch {
      setImageInputError(selection);
    } finally {
      setImageInputSaving(false);
    }
  };
  /** Capability reports the engine can read, after the cache save succeeds. */
  const [savedModelListCache, setSavedModelListCache] = useState<LlmModelListCache>({});
  /** Which providers actually have a key in the store. A stored credential IS a configuration, whatever the endpoint has since said back. Reading configuration
   * off the handshake alone made a provider whose key had gone stale vanish from the page; taking with it the only place that key can be replaced or deleted. */
  const [credentialedProviderIds, setCredentialedProviderIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  /** The row whose credential was saved on this screen, if any. Saving never moves the chat route, so that row may need telling where the switch is. */
  const [credentialSavedRowId, setCredentialSavedRowId] = useState<string | null>(null);
  /** The address this row's catalogue lives at, or "" when the row has none of its own. Whether that
   * address is ever ASKED is `shouldSyncModelList`'s question, not this one; one decision, in one place. */
  const rowModelListBaseUrl = useCallback((
    vendorId: string,
    preset: MarketplaceInstalledProviderPreset | undefined,
  ): string => {
    if (preset) return preset.baseUrl.trim();
    const saved = savedVendorBlocks[vendorId]?.baseUrl?.trim();
    if (saved) return saved;
    // A preset vendor ships the one address it serves from; the generic custom provider ships none until the user supplies one.
    return isLLMVendor(vendorId)
      ? LLM_VENDOR_DEFAULTS[vendorId].baseUrl?.trim() ?? ""
      : "";
  }, [savedVendorBlocks]);

  /** Bumped on every settings broadcast; `setApiKey`/`deleteApiKey` send one, so this is what re-asks the credential store. */
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [modelLists, setModelLists] = useState<Record<string, ModelListState>>({});
  const modelListsRef = useRef<Record<string, ModelListState>>({});
  /** Keys with a catalogue request out right now. Per instance, not per launch: a request belongs to the
   * component that made it, and the settings tab unmounting mid-request must not leave the next mount unable to ask. */
  const modelListRequestsInFlight = useRef<Set<string> | null>(null);
  const modelListCacheRef = useRef<LlmModelListCache>({});
  const setModelListState = useCallback((key: string, state: ModelListState) => {
    setModelLists((current) => {
      // Writing an identical state must not produce a new map: `connections` is derived from this, and a fresh identity re-runs the launch refresh,
      // which would write the same state again. Payload fields are compared by reference because a fetch that actually landed always brings new ones.
      if (sameModelListState(current[key], state)) return current;
      const next = { ...current, [key]: state };
      modelListsRef.current = next;
      return next;
    });
  }, []);
  const requestModelList = useCallback(
    async (
      provider: string,
      options: {
        baseUrl?: string;
        wire?: CustomProviderWire;
        force?: boolean;
        credentialScope?: string;
        modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
      } = {},
    ) => {
      if (!settingsLoaded && !options.force) return;
      const baseUrl = options.baseUrl?.trim() ?? "";
      if (!shouldSyncModelList(provider, baseUrl, options.modelDiscoveryPolicy)) return;
      const credentialScope =
        provider === "openai-compatible" ? options.credentialScope?.trim() ?? "" : "";
      const key = llmModelListCacheKey(provider, baseUrl, credentialScope);
      const existing = modelListsRef.current[key];
      const inFlight = modelListRequestsInFlight.current ??= new Set<string>();
      // One request in flight per key. This is the only guard `force` does not lift: a second
      // press while the first is still out would not produce a newer answer, only a second spinner.
      if (inFlight.has(key)) return;
      // See `modelListRefreshedThisLaunch` for the policy this enforces.
      if (!options.force && modelListRefreshedThisLaunch.has(key)) return;
      // Both claimed BEFORE anything is awaited. More than one caller asks for the same key; a row's card, the fallback panel, the launch pass, a second press; and a guard set only after an await is no guard at
      // all for whoever reads it during that await. The `loading` STATE is not that guard: it is written only once a request actually goes out, so a row with no key stored never shows a sync that was never made.
      modelListRefreshedThisLaunch.add(key);
      inFlight.add(key);
      // One shape for every way this can fail, so the row says the same thing whichever step broke; and keeps the catalogue it already has.
      const failWith = (message: string): void => {
        const latest = modelListsRef.current[key] ?? existing;
        setModelListState(key, {
          status: "error",
          error: message,
          options: latest?.options,
          entries: latest?.entries,
          endpoint: latest?.endpoint,
          fetchedAt: latest?.fetchedAt,
          source: latest?.source,
        });
      };
      try {
        // A fixed-endpoint vendor reaches its own /models with a stored key, so a request with nothing stored could only come back 401; and a red "sync failed" on a card
        // whose subscription is signed in and healthy says the wrong thing. Asked here, on the edge of actually fetching, so a catalogue that is already in hand still stands.
        if (!baseUrl && STANDARD_CATALOGUE_ENDPOINT_VENDORS.has(provider)) {
          let hasCredential: boolean;
          try {
            hasCredential = await api.hasApiKey(provider);
          } catch (err) {
            // Callers fire this with `void`, so a rejection escaping here is unhandled and the row is left saying nothing at all.
            failWith(errorMessage(err));
            return;
          }
          if (!hasCredential) {
            // Nothing was asked, so the launch owes this key a request still: storing a key is a change to this row's inputs, and it gets that request then.
            forgetModelListLaunchRefresh(key);
            setModelListState(key, { status: "needs-credential" });
            return;
          }
        }
        setModelListState(key, existing?.options
          ? { ...existing, status: "loading" }
          : { status: "loading" });
        try {
          const result = await api.listLlmModels({
            vendor: provider,
            ...(baseUrl ? { baseUrl } : {}),
            ...(provider === "openai-compatible" && !credentialScope && options.wire !== undefined ? { wire: options.wire } : {}),
            ...(credentialScope ? { credentialScope } : {}),
            ...(options.modelDiscoveryPolicy ? { modelDiscoveryPolicy: options.modelDiscoveryPolicy } : {}),
          });
          if (result.ok) {
            const nextEntry: LlmModelListCacheEntry = {
              vendor: result.vendor,
              ...(baseUrl ? { baseUrl } : {}),
              ...(credentialScope ? { credentialScope } : {}),
              endpoint: result.endpoint,
              models: result.models,
              ...(result.modelEntries ? { modelEntries: result.modelEntries } : {}),
              ...(result.complete ? { complete: true } : {}),
              fetchedAt: result.fetchedAt,
            };
            const nextCache = {
              ...modelListCacheRef.current,
              [key]: nextEntry,
            };
            modelListCacheRef.current = nextCache;
            setModelListState(key, {
              status: "ready",
              options: result.models,
              entries: result.modelEntries,
              endpoint: result.endpoint,
              fetchedAt: result.fetchedAt,
              source: "network",
            });
            const markPersistError = (err: unknown): void => {
              const latest = modelListsRef.current[key];
              if (latest?.status !== "ready") return;
              setModelListState(key, {
                ...latest,
                persistError: errorMessage(err),
              });
            };
            void api.updateSettings({ llm: { modelListCache: nextCache } })
              .then((persistResult) => {
                if (isIpcErrorResult(persistResult)) {
                  markPersistError(persistResult.message ?? persistResult.error);
                }
              })
              .catch(markPersistError);
          } else {
            failWith(result.message ?? result.error);
          }
        } catch (err) {
          failWith(errorMessage(err));
        }
      } finally {
        inFlight.delete(key);
      }
    },
    [api, setModelListState, settingsLoaded],
  );
  const activeModelListBaseUrl = selectedMarketplaceProviderPreset?.baseUrl ?? baseUrl.trim();
  const activeModelDiscoveryPolicy = selectedMarketplaceProviderPreset?.modelDiscoveryPolicy;
  const activeProviderRequiresApiKey = selectedMarketplaceProviderPreset
    ? selectedMarketplaceProviderPreset.requiresApiKey !== false
    : !(isLLMVendor(vendor) && canUseLlmVendorWithoutApiKey(vendor, {
      baseUrl: activeModelListBaseUrl,
    }));
  const activeModelListKey = llmModelListCacheKey(
    vendor,
    activeModelListBaseUrl,
    activeModelListCredentialScope,
  );
  // Subscription providers live beside the API vendor in ONE chooser, so this tab owns both halves of the state rather than handing one down.
  const subscription = useSubscriptionProviders(api);
  // Mirrored from settings rather than held locally: another window may pin a model too, and the chooser must show one truth.
  const [pinnedModels, setPinnedModels] = useState<readonly string[]>([]);
  const [compactionModel, setCompactionModel] = useState("");
  const [savedCompactionModel, setSavedCompactionModel] = useState("");
  const [compactionSaving, setCompactionSaving] = useState(false);
  const [compactionSaveFailed, setCompactionSaveFailed] = useState(false);
  const compactionModelDirtyRef = useRef(false);
  const compactionRouteRef = useRef("");
  const compactionModelEditable = subscription.activeRuntime.kind === "api"
    || subscriptionAcceptsModelOverride(subscription.activeRuntime);
  const handleCompactionModelSave = async () => {
    setCompactionSaving(true);
    setCompactionSaveFailed(false);
    try {
      const latest = await api.getSettings();
      const route = compactionModelRouteKey(latest.llm, latest.marketplace?.installedProviderPresets);
      if (route !== compactionRouteRef.current) throw new Error("Compaction provider route changed");
      const result = await api.updateSettings({ llm: { compactionModel: compactionModel.trim(), compactionModelRoute: route } });
      if (isIpcErrorResult(result)) throw new Error(result.error);
      compactionModelDirtyRef.current = false;
      setSavedCompactionModel(result.llm.compactionModel ?? "");
      setCompactionModel(result.llm.compactionModel ?? "");
    } catch {
      setCompactionSaveFailed(true);
    } finally {
      setCompactionSaving(false);
    }
  };

  const handleTogglePin = useCallback((modelId: string) => {
    const next = pinnedModels.includes(modelId)
      ? pinnedModels.filter((id: string) => id !== modelId)
      : [...pinnedModels, modelId];
    setPinnedModels(next);
    void api.updateSettings({ llm: { pinnedModels: next } });
  }, [api, pinnedModels]);

  /** Key open credential forms by row identity to avoid rendering under a stale vendor; multiple rows may remain expanded. */
  const [openRowIds, setOpenRowIds] = useState<readonly string[]>([]);
  /** The sign-in method the user picked on a card that offers two (a provider with both a subscription and
   * an API key). A pick only decides what the card shows; it never removes the other method's credential. */
  const [authMethodByRow, setAuthMethodByRow] = useState<Readonly<Record<string, ProviderSignInMethod>>>({});
  /** Rows whose last save was refused, so the row says so instead of closing. */
  const [saveFailedRowIds, setSaveFailedRowIds] = useState<readonly string[]>([]);
  const [addedRowIds, setAddedRowIds] = useState<readonly string[]>([]);
  /** The row a click just revealed, until it has been scrolled to and focused. */
  const [rowToReveal, setRowToReveal] = useState<string | null>(null);
  /** The row the add menu revealed, until the menu has let go of the caret. */
  const menuRevealedRowRef = useRef<string | null>(null);
  const connectionsRef = useRef<HTMLDivElement | null>(null);
  // A vendor with no usable credential has not answered the checklist yet.
  const apiPathConfigured = hasKey || !activeProviderRequiresApiKey;

  const marketplaceProviderPresetOptions = useMemo(
    () => providerOptionsForPresets(marketplaceProviderPresets),
    [marketplaceProviderPresets],
  );

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const applySettings = (settings: Awaited<ReturnType<AveApi["getSettings"]>>) => {
      // Content-compared, like the credential set below it: a broadcast arrives for every settings write, and a fresh object identity
      // each time would re-run every effect that reads a row's endpoint; including the one that asks endpoints for their catalogues.
      setSavedVendorBlocks((current) => {
        const next = settings.llm?.vendors ?? {};
        return sameSavedVendorBlocks(current, next) ? current : next;
      });
      setSettingsRevision((current) => current + 1);
      setPinnedModels(settings.llm?.pinnedModels ?? []);
      if (isLLMVendor(settings.llm?.provider)) {
        const compactRoute = compactionModelRouteKey(settings.llm, settings.marketplace?.installedProviderPresets);
        if (compactionRouteRef.current !== compactRoute) compactionModelDirtyRef.current = false;
        compactionRouteRef.current = compactRoute;
        const compactModel = settings.llm?.compactionModelRoute === compactRoute ? settings.llm?.compactionModel ?? "" : "";
        setSavedCompactionModel(compactModel);
        if (!compactionModelDirtyRef.current) setCompactionModel(compactModel);
      }
      const cache = settings.llm?.modelListCache ?? {};
      setSavedModelListCache((current) => sameSettingsValue(current, cache) ? current : cache);
      modelListCacheRef.current = cache;
      const cachedStates = modelListStatesFromCache(cache, marketplaceProviderPresets);
      setModelLists((current) => {
        const next = reconcileModelListStatesWithCache(current, cachedStates);
        modelListsRef.current = next;
        return next;
      });
    };
    void (async () => {
      try {
        const settings = await api.getSettings();
        if (cancelled) return;
        applySettings(settings);
        unsubscribe = api.onSettingsUpdated((nextSettings) => {
          if (cancelled) return;
          applySettings(nextSettings);
        });
      } catch {
        /* defaults remain */
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, marketplaceProviderPresets]);
  const providerSelectOptions = useMemo(
    () => [
      ...visibleVendorsFor(),
      ...marketplaceProviderPresetOptions,
    ],
    [marketplaceProviderPresetOptions],
  );
  // Every provider that could own a row, including the API counterparts of the subscription runtimes; a
  // paired provider's key belongs to its runtime's row, and that runtime need not be in the vendor catalogue.
  const credentialCandidateKey = useMemo(
    () => [...new Set([
      ...providerSelectOptions.map((option) => option.id),
      ...Object.values(SUBSCRIPTION_RUNTIME_API_COUNTERPART),
    ])].filter(Boolean).sort().join("\n"),
    [providerSelectOptions],
  );
  useEffect(() => {
    let cancelled = false;
    const candidates = credentialCandidateKey.split("\n").filter(Boolean);
    void (async () => {
      const found = new Set<string>();
      await Promise.all(candidates.map(async (providerId) => {
        try {
          if (await api.hasApiKey(providerId)) found.add(providerId);
        } catch {
          /* a provider we cannot ask about is not one we can claim is keyed */
        }
      }));
      if (cancelled) return;
      setCredentialedProviderIds((current) =>
        current.size === found.size && [...found].every((id) => current.has(id))
          ? current
          : found);
    })();
    return () => { cancelled = true; };
  }, [api, credentialCandidateKey, settingsRevision]);
  const fallbackProviderKey = useMemo(
    () => [...new Set(fallbackChain.map((entry) => entry.provider).filter(Boolean))]
      .sort()
      .join("\n"),
    [fallbackChain],
  );
  useEffect(() => {
    if (!settingsLoaded || !fallbackOpen) return;
    for (const provider of fallbackProviderKey.split("\n").filter(Boolean)) {
      // A fallback entry need not have a row of its own, so this is the only thing that would ever ask for its
      // catalogue. It rides the same once-per-launch marker as everything else, so opening the panel twice asks once.
      const baseUrl = rowModelListBaseUrl(provider, undefined);
      void requestModelList(provider, { ...(baseUrl ? { baseUrl } : {}) });
    }
  }, [fallbackOpen, fallbackProviderKey, requestModelList, rowModelListBaseUrl, settingsLoaded]);

  // A provider that arrived from the marketplace says so on its row. The badge used to hang off the vendor
  // dropdown; the dropdown is gone, but where a provider CAME FROM is still something the user needs to be able to see.
  const marketplaceVendorIds = useMemo(
    () => new Set<string>([
      ...marketplaceProviderPresets.map((preset) =>
        marketplaceProviderPresetSecretId(preset.providerId)),
    ]),
    [marketplaceProviderPresets],
  );
  // ONE list. A provider a user recognises as one company is one row, whether it is reached with an API key, by signing in to its subscription runtime, or both; `SUBSCRIPTION_RUNTIME_API_COUNTERPART` is the join that says which pairs are the same company. One configured API route: a vendor,
  // plus the marketplace preset it is reached THROUGH when there is one, plus the `modelLists` key whose handshake belongs to it. Two presets are two routes through the same `openai-compatible` vendor, so a route; not a vendor id; is what a row is built from, and what its facts are looked up by.
  const installedPresetById = useMemo(
    () => new Map(marketplaceProviderPresets.map((preset) => [preset.providerId, preset])),
    [marketplaceProviderPresets],
  );

  /** The id this row's secret is stored under. */
  const rowCredentialId = useCallback((row: ProviderConnection): string =>
    row.presetId ? marketplaceProviderPresetSecretId(row.presetId) : row.apiVendorId!, []);

  /** Whether this row's credential form has to ask for a key at all. */
  const rowRequiresApiKey = useCallback((row: ProviderConnection): boolean => {
    const preset = row.presetId ? installedPresetById.get(row.presetId) : undefined;
    if (preset) return preset.requiresApiKey !== false;
    const vendorId = row.apiVendorId ?? "";
    return !(isLLMVendor(vendorId) && canUseLlmVendorWithoutApiKey(vendorId, {
      baseUrl: savedVendorBlocks[vendorId]?.baseUrl ?? "",
    }));
  }, [installedPresetById, savedVendorBlocks]);

  /** Where a plain vendor's catalogue is filed. The write and the read have to agree, and they only do if they build the key the same way: a preset vendor ships its own address, so its
   * catalogue lands under `vendor\n<address>\n` and reading `vendor\n\n` finds nothing; the fallback dropdown then showed only the saved model, as if the endpoint had never answered. */
  const vendorModelListKey = useCallback(
    (vendorId: string): string =>
      llmModelListCacheKey(vendorId, rowModelListBaseUrl(vendorId, undefined), ""),
    [rowModelListBaseUrl],
  );

  /** The catalogue request this row's own key names, or null when the row has no catalogue to ask anyone for. Read back OUT of `modelListKey` rather than rebuilt from the row's parts, so the answer
   * can only land where the row is already looking. The launch refresh and the card's refresh control both go through here, which is what makes "the button refreshes THIS card" true by construction. */
  const rowModelListRequest = useCallback((row: ProviderConnection): {
    vendorId: string;
    options: {
      baseUrl?: string;
      wire?: CustomProviderWire;
      credentialScope?: string;
      modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
    };
  } | null => {
    if (!row.apiVendorId || !row.modelListKey) return null;
    const [vendorId, baseUrl, credentialScope] = row.modelListKey.split("\n");
    if (!vendorId) return null;
    const preset = credentialScope ? installedPresetById.get(credentialScope) : undefined;
    const modelDiscoveryPolicy = preset?.modelDiscoveryPolicy;
    if (!shouldSyncModelList(vendorId, baseUrl, modelDiscoveryPolicy)) return null;
    // A route reached with no credential can only come back 401. There is nothing to ask yet and nothing to
    // refresh, so the card says what is missing (`rowChatBlocker`) instead of showing a control that would fail.
    if (rowRequiresApiKey(row) && !credentialedProviderIds.has(rowCredentialId(row))) return null;
    return {
      vendorId,
      options: {
        ...(baseUrl ? { baseUrl } : {}),
        ...(vendorId === "openai-compatible" && !credentialScope ? { wire: customProviderWire(savedVendorBlocks[vendorId]?.wire) } : {}),
        ...(credentialScope ? { credentialScope } : {}),
        ...(modelDiscoveryPolicy ? { modelDiscoveryPolicy } : {}),
      },
    };
  }, [credentialedProviderIds, installedPresetById, rowRequiresApiKey, savedVendorBlocks]);

  const configuredApiRoutes = useMemo<readonly ConfiguredApiRoute[]>(() => {
    const routes = new Map<string, ConfiguredApiRoute>();
    const add = (route: ConfiguredApiRoute) => {
      const rowId = apiRouteRowId(route);
      if (!routes.has(rowId)) routes.set(rowId, route);
    };
    // The ACTIVE route goes first: its credential is known here directly, so it counts before any fetch lands, and its key is the current
    // configuration rather than a stale cache entry. (It is the active route, not the one whose card happens to be open; opening a card moves nothing.)
    if (apiPathConfigured) {
      add({
        vendorId: vendor,
        ...(marketplaceProviderPresetId ? { presetId: marketplaceProviderPresetId } : {}),
        modelListKey: activeModelListKey,
      });
    }
    for (const [cacheKey, state] of Object.entries(modelLists)) {
      // A handshake that only STARTED is not evidence of configuration. A bare `loading` key used to be enough to draw a "connected" row for a
      // provider with nothing stored; only a catalogue that actually landed counts, and a later failure does not un-configure what already did.
      if (state.status !== "ready" && !hasUsableModelListOptions(state)) continue;
      const [cachedVendor, cachedBaseUrl, scope] = cacheKey.split("\n");
      if (!cachedVendor) continue;
      const preset = scope ? installedPresetById.get(scope) : undefined;
      if (scope && !preset) continue;
      // The key a persisted entry is filed under names the address it was fetched from. If that is not the address this row is configured for now, the entry
      // describes a route that no longer exists; and binding the row to it would leave the row reading a key nothing writes, holding an old catalogue that can never refresh.
      if ((cachedBaseUrl ?? "") !== rowModelListBaseUrl(cachedVendor, preset)) continue;
      add({ vendorId: cachedVendor, ...(scope ? { presetId: scope } : {}), modelListKey: cacheKey });
    }
    // And a stored key is a configuration in its own right. This is the half that does not depend on the endpoint
    // agreeing: a provider whose key has gone stale must keep its row, because that row is where the key is replaced or removed.
    for (const providerId of credentialedProviderIds) {
      const presetId = marketplaceProviderPresetIdFromSecretId(providerId);
      const preset = presetId ? installedPresetById.get(presetId) : undefined;
      if (presetId && !preset) continue;
      const vendorId = presetId ? "openai-compatible" : providerId;
      const rowAddress = preset?.baseUrl ?? rowModelListBaseUrl(vendorId, undefined);
      add({
        vendorId,
        ...(presetId ? { presetId } : {}),
        // Built from the row's CURRENT address, never resolved by searching what happens to be in the cache. That search matched on vendor and scope alone and took the first hit, so an entry written by
        // an older build under a different address could bind the row to a key nothing writes any more; a catalogue that could never refresh. Entries that no row's address names are simply never read.
        modelListKey: llmModelListCacheKey(vendorId, rowAddress, presetId ?? ""),
      });
    }
    return [...routes.values()];
  }, [
    modelLists, apiPathConfigured, vendor, marketplaceProviderPresetId, activeModelListKey,
    credentialedProviderIds, installedPresetById, rowModelListBaseUrl,
  ]);

  /** This row's draft, or undefined when the row is holding nothing. */
  const draftForRow = useCallback(
    (rowId: string): ProviderCredentialDraft | undefined =>
      providerCredentialDrafts.find((draft) => draft.rowId === rowId),
    [providerCredentialDrafts],
  );

  /** Replace one row's draft, leaving every other row's alone. */
  const putDraft = useCallback((draft: ProviderCredentialDraft) => {
    onProviderCredentialDraftsChange?.([
      ...providerCredentialDrafts.filter((entry) => entry.rowId !== draft.rowId),
      draft,
    ]);
  }, [onProviderCredentialDraftsChange, providerCredentialDrafts]);

  const dropDraft = useCallback((rowId: string) => {
    if (!providerCredentialDrafts.some((entry) => entry.rowId === rowId)) return;
    onProviderCredentialDraftsChange?.(
      providerCredentialDrafts.filter((entry) => entry.rowId !== rowId),
    );
  }, [onProviderCredentialDraftsChange, providerCredentialDrafts]);

  /** The provider option a draft's fields describe; preset first, else vendor. */
  const draftProviderOption = useCallback(
    (draft: ProviderCredentialDraft): ProviderOption | VendorOption => {
      const preset = draft.presetId ? installedPresetById.get(draft.presetId) : undefined;
      return preset ? providerOptionFromPreset(preset) : getVendorInfo(draft.vendorId);
    },
    [installedPresetById],
  );

  /** Whether a row still holds something the store has not been told. Read off the DRAFT's own vendor, not the active one: the card being edited and the provider chat runs on
   * are different questions, and comparing one row's typed endpoint against another row's saved block reported both a dirty card that was clean and a clean card that was dirty. */
  const rowCredentialDirty = useCallback((rowId: string): boolean => {
    const draft = draftForRow(rowId);
    if (!draft) return false;
    if (draft.keyInput.trim()) return true;
    const saved = savedVendorBlocks[draft.vendorId];
    if (draft.vendorId === "vertex-ai") {
      return draft.vertexProject.trim() !== (saved?.vertexProject ?? "").trim()
        || draft.vertexLocation.trim() !== (saved?.vertexLocation ?? "").trim();
    }
    return endpointIsUserSupplied(draft.vendorId, draftProviderOption(draft), Boolean(draft.presetId))
      && (draft.baseUrl.trim() !== (saved?.baseUrl ?? "").trim()
        || (draft.vendorId === "openai-compatible" && !draft.presetId
          && customProviderWire(draft.wire) !== customProviderWire(saved?.wire)));
  }, [draftForRow, draftProviderOption, savedVendorBlocks]);

  /** The row the ACTIVE API provider is drawn on. A preset id only names the route while chat is on the vendor presets are reached through; the
   * same rule main applies (`activeLlmRouteModel`, `activeApiRouteConnected`); a stale id left beside another vendor must not move the route off it. */
  const activeApiRowId = vendor === "openai-compatible" && marketplaceProviderPresetId
    ? marketplaceProviderPresetSecretId(marketplaceProviderPresetId)
    : vendor;

  // Rows that must stay on screen although nothing is connected on them yet: the ones the user added, plus every card holding uncommitted input. Those drafts live in the parent and
  // outlive this component, so the rows that own them are DERIVED from the drafts; otherwise a tab switch takes a card away while the half-typed key it belongs to is still there.
  const dirtyRowKey = providerCredentialDrafts
    .map((draft) => draft.rowId)
    .filter((rowId) => rowCredentialDirty(rowId))
    .join("\n");
  const pinnedRowIds = useMemo<readonly string[]>(() => {
    const rows = [...addedRowIds];
    for (const rowId of dirtyRowKey ? dirtyRowKey.split("\n") : []) {
      if (!rows.includes(rowId)) rows.push(rowId);
    }
    return rows;
  }, [addedRowIds, dirtyRowKey]);


  const connections = useMemo<ProviderConnection[]>(() => {
    const claimed = new Set<string>();
    const rows: ProviderConnection[] = [];
    const routeLabel = (route: ConfiguredApiRoute): string => {
      const preset = route.presetId ? installedPresetById.get(route.presetId) : undefined;
      return preset ? providerOptionFromPreset(preset).label : getVendorInfo(route.vendorId).label;
    };
    for (const view of subscription.providers) {
      // A partner runtime is drawn on its primary runtime's row, never as a second row for the same company.
      if (SUBSCRIPTION_RUNTIME_ROW_PARTNER[view.descriptor.id]) continue;
      const planView = subscription.providers.find((candidate) =>
        SUBSCRIPTION_RUNTIME_ROW_PARTNER[candidate.descriptor.id] === view.descriptor.id);
      const counterpart = SUBSCRIPTION_RUNTIME_API_COUNTERPART[view.descriptor.id];
      if (counterpart) claimed.add(counterpart);
      const route = counterpart
        ? configuredApiRoutes.find((candidate) =>
          !candidate.presetId && candidate.vendorId === counterpart)
        : undefined;
      rows.push({
        id: view.descriptor.id,
        // The company's name, not the runtime's: "OpenAI", not "Codex".
        label: subscriptionCompanyLabel(view),
        ...(counterpart ? { apiVendorId: counterpart } : {}),
        ...(counterpart
          ? { modelListKey: route?.modelListKey ?? llmModelListCacheKey(counterpart, "", "") }
          : {}),
        apiConfigured: Boolean(route),
        subscription: view,
        ...(planView ? { planSubscription: planView } : {}),
        connected: view.status?.connection === "connected"
          || planView?.status?.connection === "connected"
          || Boolean(route),
      });
    }
    for (const route of configuredApiRoutes) {
      if (!route.presetId && claimed.has(route.vendorId)) continue;
      rows.push({
        id: apiRouteRowId(route),
        label: routeLabel(route),
        apiVendorId: route.vendorId,
        ...(route.presetId ? { presetId: route.presetId } : {}),
        modelListKey: route.modelListKey,
        apiConfigured: true,
        connected: true,
      });
    }
    // A provider picked from "add a provider" has no row yet; it is neither a subscription runtime nor configured; and its credential form lives ON a row, so without this the
    // provider a user just chose does not appear at all. `providerSelectOptions` is the only source that knows the label for both a built-in vendor and a marketplace preset.
    for (const rowId of pinnedRowIds) {
      if (rows.some((row) => row.id === rowId || row.apiVendorId === rowId)) continue;
      const option = providerSelectOptions.find((candidate) => candidate.id === rowId);
      if (!option) continue;
      const preset = marketplaceProviderPresets.find(
        (entry) => marketplaceProviderPresetSecretId(entry.providerId) === rowId,
      );
      rows.push({
        id: rowId,
        label: option.label,
        // A preset is REACHED through the openai-compatible vendor but is not that vendor: the row keeps its own
        // identity so two presets are two cards, and so the generic custom provider is still addable beside it.
        apiVendorId: preset ? "openai-compatible" : rowId,
        ...(preset ? { presetId: preset.providerId } : {}),
        modelListKey: preset
          ? llmModelListCacheKey("openai-compatible", preset.baseUrl, preset.providerId)
          : llmModelListCacheKey(rowId, rowModelListBaseUrl(rowId, undefined), ""),
        apiConfigured: false,
        connected: false,
      });
    }
    return rows;
  }, [
    subscription.providers, configuredApiRoutes, pinnedRowIds, providerSelectOptions,
    marketplaceProviderPresets, installedPresetById, rowModelListBaseUrl,
  ]);

  // The order the user built the list in: everything already connected, then each provider they added, in the order they added it. A newly added card therefore lands at the END; directly above the button that created it; instead of wherever the catalogue
  // happens to sort it. A provider picked from "add a provider" also has to STAY on screen while it is being set up: signing in to a subscription runtime happens on its row, and a row that vanishes because it is not connected yet takes the login button with it.
  const visibleRows = useMemo<ProviderConnection[]>(() => {
    const rows = connections.filter((row) => row.connected);
    const seen = new Set(rows.map((row) => row.id));
    for (const rowId of pinnedRowIds) {
      if (seen.has(rowId)) continue;
      const row = connections.find((candidate) => candidate.id === rowId);
      if (!row) continue;
      seen.add(rowId);
      rows.push(row);
    }
    return rows;
  }, [connections, pinnedRowIds]);

  /** Read catalog handshake state from the row's bound route key everywhere; no route or unconfigured route is not a sync failure. */
  const rowModelListState = useCallback(
    (row: ProviderConnection | undefined): ModelListState | undefined =>
      row?.apiVendorId && row.modelListKey && row.apiConfigured
        ? modelLists[row.modelListKey]
        : undefined,
    [modelLists],
  );

  /** The row that serves what the chooser currently has selected. The status line under the chooser is about the selection, so it has to follow it: a
   * subscription-backed pick is served by the subscription row, and the API vendor's last handshake is then a fact about a route that is not answering anything. */
  const activeRuntime = subscription.activeRuntime;
  const activeSyncRow = useMemo<ProviderConnection | undefined>(
    () => activeRuntime.kind === "subscription"
      ? connections.find((row) =>
        row.id === activeRuntime.provider || row.planSubscription?.descriptor.id === activeRuntime.provider)
      : connections.find((row) => row.apiVendorId && rowCredentialId(row) === activeApiRowId),
    [activeApiRowId, activeRuntime, connections, rowCredentialId],
  );
  const activeModelList = rowModelListState(activeSyncRow);
  const activeSyncedModelOptions = modelDiscoveryPolicyUsesSeededOptions(activeModelDiscoveryPolicy)
    ? undefined
    : optionsFromModelListState(activeModelList);
  // Only a synced catalogue can disqualify the saved model; a seeded vendor's curated line is not the server's word on what it serves.
  const unlistedModel = unlistedSavedModel(
    activeModelValue,
    activeSyncedModelOptions,
  );

  // The launch refresh (see `modelListRefreshedThisLaunch`). An effect runs after the commit, and this one additionally waits for the first settings apply; so every card and the chooser have already
  // painted from the persisted cache before anything is asked, and nothing here can delay what the user sees. Re-runs are free: `requestModelList` decides per key whether this launch has asked yet.
  useEffect(() => {
    if (!settingsLoaded || settingsRevision === 0) return;
    for (const row of connections) {
      const request = rowModelListRequest(row);
      if (!request) continue;
      void requestModelList(request.vendorId, request.options);
    }
  }, [
    connections, requestModelList, rowModelListRequest, settingsLoaded, settingsRevision,
  ]);

  const visibleRowKey = visibleRows.map((row) => row.id).join("\n");
  // Everything else goes behind "add a provider". The catalogue keeps growing with marketplace presets, so
  // the list's length has to track the number of providers the user actually USES, not the number that exist.
  const pickerEntries = providerPickerEntries(marketplaceProviderPresets);

  /** Whether this row is the API provider chat is running on. This is the row's own question about the ACTIVE provider, and it is no longer the same question
   * as "is this row's form open"; opening a card used to move the active provider, so one predicate answered both and every opened card claimed to be live. */
  const rowIsActiveApiProvider = useCallback(
    (row: ProviderConnection): boolean =>
      Boolean(row.apiVendorId)
      && row.apiVendorId === vendor
      && (row.presetId ?? "") === marketplaceProviderPresetId,
    [vendor, marketplaceProviderPresetId],
  );

  /** The model this row has stored; its own, never another row's. A preset is a provider reached through the openai-compatible vendor, so
   * its model lives in that block's per-preset map rather than the block's single `model`, which belongs to the generic custom-provider row. */
  const rowSavedModel = useCallback((row: ProviderConnection): string => {
    const block = savedVendorBlocks[row.apiVendorId ?? ""];
    if (!block) return "";
    return llmRouteModel(
      { model: block.model ?? "", ...(block.presetModels ? { presetModels: block.presetModels } : {}) },
      row.presetId,
    );
  }, [savedVendorBlocks]);

  /** What this row can be asked for right now. The one computation behind both the chooser's options and the card's status line, so the two can never disagree about whether a provider has anything to
   * offer. The active row's selection is live state; every other row's is what it has stored, so a configured provider always shows its own saved model even when its endpoint has said nothing yet. */
  const rowModelIds = useCallback((row: ProviderConnection): readonly string[] => {
    const vendorId = row.apiVendorId ?? "";
    if (!vendorId) return [];
    const preset = row.presetId ? installedPresetById.get(row.presetId) : undefined;
    const rowInfo = preset ? providerOptionFromPreset(preset) : getVendorInfo(vendorId);
    const discoveryPolicy = preset?.modelDiscoveryPolicy;
    const state = row.modelListKey ? modelLists[row.modelListKey] : undefined;
    const synced = modelDiscoveryPolicyUsesSeededOptions(discoveryPolicy)
      ? undefined
      : optionsFromModelListState(state);
    const selectedModel = rowCredentialId(row) === activeApiRowId
      ? activeModelValue
      : rowSavedModel(row);
    return modelOptionsFor(
      vendorId, selectedModel, synced, rowInfo, discoveryPolicy,
      modelRetiredOn(savedModelListCache, row.modelListKey, vendorId),
    );
  }, [activeApiRowId, activeModelValue, installedPresetById, modelLists, rowSavedModel, savedModelListCache]);

  /** Read readiness from the route's actual credential requirements and offered catalog; keyless project-authenticated routes must not require a saved API key. */
  const rowChatBlocker = useCallback((row: ProviderConnection): ChatBlocker | null => {
    // A signed-in subscription row answers turns through its runtime. Whether its API counterpart
    // also has a key is a different question, and asking it here told a working card to go set one up.
    if (row.subscription?.status?.connection === "connected") return null;
    if (row.planSubscription?.status?.connection === "connected") return null;
    const vendorId = row.apiVendorId ?? "";
    if (vendorId === "vertex-ai" && !savedVendorBlocks[vendorId]?.vertexProject?.trim()) {
      return "needs-gcp-project";
    }
    if (
      vendorId !== "vertex-ai"
      && rowRequiresApiKey(row)
      && !credentialedProviderIds.has(rowCredentialId(row))
    ) {
      return "needs-api-key";
    }
    if (rowModelIds(row).length > 0) return null;
    // Nothing to choose, and the four ways to arrive there are four different sentences: a list that never came, one that
    // failed, and one that came back empty are not the same news, and saying "has not sent its list" for the last two would be false.
    const state = row.modelListKey ? modelLists[row.modelListKey] : undefined;
    if (state?.status === "error") return "catalogue-failed";
    if (state?.status === "ready") return "catalogue-empty";
    return "awaiting-catalogue";
  }, [credentialedProviderIds, modelLists, rowModelIds, rowRequiresApiKey, savedVendorBlocks]);

  /** Model selection also selects its provider; include every row that rowChatBlocker and rowModelIds consider usable without adding another credential gate. */
  const unifiedOptions = useMemo<UnifiedModelOption[]>(() => {
    const options: UnifiedModelOption[] = [];
    const pushed = new Set<string>();
    for (const row of connections) {
      if (!row.apiVendorId) continue;
      // A connected subscription does not authenticate its separate API route.
      if (row.apiVendorId !== "vertex-ai" && rowRequiresApiKey(row) && !credentialedProviderIds.has(rowCredentialId(row))) continue;
      if (rowChatBlocker(row) !== null) continue;
      const rowId = rowCredentialId(row);
      const state = row.modelListKey ? modelLists[row.modelListKey] : undefined;
      const isActiveRow = rowId === activeApiRowId;
      const entries = modelEntryMap(state?.entries);
      const [, reportedBaseUrl, credentialScope] = row.modelListKey?.split("\n") ?? [];
      // Whether the catalogue may name its own models. An OpenAI-compatible server answers `/models` with `owned_by: "openai"` for everything it serves; its word for its own software, not for who made the
      // model; and every marketplace preset is reached through that vendor. Those rows take the card title instead. A real vendor's catalogue keeps its sub-vendor, which is the whole point of an aggregator's list.
      const catalogueNamesItsModels = row.apiVendorId !== "openai-compatible" && !row.presetId;
      // The SAME predicate the composer and the send path use to decide whether an image may ride along. Reading the
      // catalogue's own modality list instead would let a badge promise vision on a model the send path then refuses.
      const visionVendor = isLLMVendor(row.apiVendorId) ? row.apiVendorId : null;
      for (const modelId of rowModelIds(row)) {
        // Keyed by the ROW, not the vendor: two marketplace presets are two providers reached through one vendor, and a pick has to say which.
        const value = unifiedValue(apiProviderId(rowId), modelId);
        if (pushed.has(value)) continue;
        pushed.add(value);
        const savedEntry = row.modelListKey ? cachedModelListEntry(savedModelListCache, {
          vendor: row.apiVendorId, model: modelId,
          baseUrl: reportedBaseUrl, credentialScope,
        }) : undefined;
        // An exact live report first; otherwise the report the engine and the badges below match under the same rule, so one row never mixes two.
        const entry = entries.get(modelId) ?? savedEntry;
        const rowCatalogModel = row.presetId ? undefined : savedVendorBlocks[row.apiVendorId]?.catalogModel;
        const toolCall = resolveToolCallSupport({
          vendor: row.apiVendorId,
          model: modelId,
          baseUrl: reportedBaseUrl || undefined,
          reported: savedEntry?.supportedParameters,
          catalogModel: rowCatalogModel,
        });
        // The same reasoning answer the engine plans the request with.
        const reasoning = resolveReasoningSupport({
          vendor: row.apiVendorId,
          model: modelId,
          ...(reportedBaseUrl ? { baseUrl: reportedBaseUrl } : {}),
          ...(savedEntry ? { reported: savedEntry } : {}),
          ...(rowCatalogModel !== undefined ? { catalogModel: rowCatalogModel } : {}),
        });
        const reasoningUnstated = visionVendor !== null && reasoningFallsToHost({
          vendor: visionVendor,
          model: modelId,
          ...(reportedBaseUrl ? { baseUrl: reportedBaseUrl } : {}),
          ...(rowCatalogModel !== undefined ? { catalogModel: rowCatalogModel } : {}),
          ...(reasoning !== undefined ? { reasoning } : {}),
        });
        options.push({
          value,
          providerId: apiProviderId(rowId),
          providerLabel: row.label,
          vendorLabel: catalogueNamesItsModels
            ? entry?.provider ?? entry?.ownedBy ?? row.label
            : row.label,
          modelId,
          ...(entry ? { entry } : {}),
          ...(toolCall ? { toolCall } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(reasoningUnstated ? { reasoningUnstatedVendor: row.apiVendorId } : {}),
          // This row's own endpoint report, else the catalog entry for its id.
          ...(visionVendor && supportsVision(visionVendor, modelId, {
            inputModalities: resolveInputModalities({
              vendor: visionVendor, model: modelId,
              baseUrl: reportedBaseUrl || undefined,
              imageInput: llmRouteImageInput(savedVendorBlocks[row.apiVendorId] ?? {}, modelId, row.presetId),
              reported: savedEntry?.inputModalities,
              catalogModel: row.presetId ? undefined : savedVendorBlocks[row.apiVendorId]?.catalogModel,
            }),
          }) ? { vision: true } : {}),
          ...(isActiveRow && modelId === unlistedModel
            ? { unlisted: true, facts: t("llmTab.modelUnlisted") }
            : {}),
        });
      }
    }
    for (const view of subscription.providers) {
      // Connected only. A signed-out provider has nothing to offer yet, and listing its models would invite a choice that cannot be honoured.
      if (view.status?.connection !== "connected") continue;
      const models = (view.status.models ?? []).filter((model) => model.id.trim());
      // A runtime with no default model offers only what its list names; an empty list offers nothing to pick.
      if (models.length === 0 && isSubscriptionRuntimeId(view.descriptor.id)
        && subscriptionRuntimeDescriptor(view.descriptor.id).requiresModelSelection) {
        continue;
      }
      if (models.length === 0) {
        // No model choice at all; the row IS the provider. It still belongs in the list, because
        // picking it is exactly as much of a choice as picking a model from a provider that has several.
        options.push({
          value: unifiedValue(view.descriptor.id, ""),
          providerId: view.descriptor.id,
          providerLabel: subscriptionModelsLabel(t, view),
          vendorLabel: subscriptionModelsLabel(t, view),
          modelId: t("llmTab.providerDefaultModel"),
          facts: t("llmTab.modelFixedByProvider"),
          fixed: true,
        });
        continue;
      }
      if (isSubscriptionRuntimeId(view.descriptor.id)
        && subscriptionRuntimeDescriptor(view.descriptor.id).offersCliDefaultModel) {
        // Choosing no model is a real choice here: the user's CLI runs its own default. It is named as that, never as a model id.
        options.push({
          value: unifiedValue(view.descriptor.id, ""),
          providerId: view.descriptor.id,
          providerLabel: subscriptionCompanyLabel(view),
          vendorLabel: subscriptionCompanyLabel(view),
          modelId: t("llmTab.cliDefaultModel"),
        });
      }
      for (const model of models) {
        options.push({
          value: unifiedValue(view.descriptor.id, model.id),
          providerId: view.descriptor.id,
          providerLabel: subscriptionModelsLabel(t, view),
          vendorLabel: subscriptionModelsLabel(t, view),
          modelId: model.label || model.id,
          // A subscription runtime answers the image question itself, so the badge follows the host-verified
          // projection; a runtime whose image input follows the model (plan usage) also needs a model that accepts them.
          ...(view.status.capabilities?.images === true && subscriptionModelAcceptsImages(view.descriptor.id, model.id)
            ? { vision: true }
            : {}),
        });
      }
    }
    return options;
  }, [
    connections, rowRequiresApiKey, credentialedProviderIds, rowChatBlocker, rowModelIds, modelLists, activeApiRowId,
    unlistedModel, subscription.providers, savedVendorBlocks, savedModelListCache, t,
  ]);

  const reasoningDepths = getReasoningDepths(outputTokenLimit, {
    vendor: narrowLlmVendor(vendor), model,
    baseUrl: savedVendorBlocks[vendor]?.baseUrl,
    catalogModel: selectedMarketplaceProviderPreset ? undefined : savedVendorBlocks[vendor]?.catalogModel,
    reasoning: unifiedOptions.find((option) => option.value === unifiedValue(apiProviderId(activeApiRowId), model))?.reasoning,
  });

  /** Whether the route chat is on right now can actually answer a turn. Saving a credential deliberately does NOT adopt the provider it belongs to; the model list is the one
   * switch, and a save silently moving the route would make it two. What a save does owe the user is the pointer: this is what says the key landed but chat is still elsewhere. */
  const activeRouteCanChat = useMemo(() => {
    if (subscription.activeRuntime.kind === "subscription") return true;
    if (retiredLlmProvider) return false;
    const active = connections.find(
      (row) => row.apiVendorId && rowCredentialId(row) === activeApiRowId,
    );
    return Boolean(active) && rowChatBlocker(active!) === null;
  }, [activeApiRowId, connections, rowChatBlocker, subscription.activeRuntime.kind, retiredLlmProvider]);

  // The saved model is hidden from the chooser in either retirement tier, so the trigger names it and the tier instead of pointing at no option.
  const activeModelRetirement = isRetiredLlmModelMarker(retiredLlmProvider)
    ? retiredLlmProvider.reason
    : modelRetirementOn(savedModelListCache, activeSyncRow?.modelListKey, vendor)(activeModelValue);
  const selectedUnifiedValue = subscription.activeRuntime.kind === "subscription"
    ? unifiedValue(subscription.activeRuntime.provider, subscription.activeRuntime.model ?? "")
    // No model is selected on a route that cannot answer: an empty value lets the trigger say so instead of pointing at an option that is not listed.
    : retiredLlmProvider || activeModelRetirement || !activeRouteCanChat || !activeModelValue
      ? ""
      : unifiedValue(apiProviderId(activeApiRowId), activeModelValue);
  const unifiedPlaceholder = subscription.activeRuntime.kind === "api" && activeModelRetirement
    ? retiredModelPlaceholder(t, activeModelRetirement, isRetiredLlmModelMarker(retiredLlmProvider) ? retiredLlmProvider.model : activeModelValue)
    : subscription.activeRuntime.kind === "api" && !activeRouteCanChat
      ? t("llmTab.modelPlaceholderNoProvider")
      : t("llmTab.model");

  /** A pick moves BOTH halves of the decision: which provider answers, and with what model. It persists the way the thinking controls do;
   * through the debounced save; rather than waiting on a Save button, which exists for the typed fields where a keystroke is not yet a decision. */
  const handleUnifiedModelChange = useCallback((value: string) => {
    const parsed = parseUnifiedValue(value);
    if (!parsed) return;
    if (parsed.providerId.startsWith(API_PROVIDER_PREFIX)) {
      const pickedRowId = parsed.providerId.slice(API_PROVIDER_PREFIX.length);
      const pickedPresetId = marketplaceProviderPresetIdFromSecretId(pickedRowId);
      const pickedPreset = pickedPresetId ? installedPresetById.get(pickedPresetId) : undefined;
      if (pickedRowId === activeApiRowId && !retiredLlmProvider) {
        // Same provider, different model: moving the vendor as well would re-hydrate fields the user may have just changed.
        setModel(parsed.modelId);
      } else if (pickedPreset) {
        onSelectMarketplaceProviderPreset?.(pickedPreset);
        setModel(parsed.modelId);
      } else {
        // The generic custom provider IS this vendor without a preset, so dropping the preset is what selects it.
        if (pickedRowId === "openai-compatible" && marketplaceProviderPresetId) {
          onClearMarketplaceProviderPreset?.();
        }
        selectApiVendorModel(pickedRowId, parsed.modelId);
      }
      onImmediateChange?.();
      // Only switch the runtime when it is not already the API path. Calling it unconditionally rewrites
      // settings on every pick, and that broadcast is what used to snap the chosen model back to the persisted one.
      if (subscription.activeRuntime.kind !== "api") {
        void subscription.props.actions.useApiForChat?.();
      }
      return;
    }
    void subscription.props.actions.useForChat?.(
      parsed.providerId as SubscriptionRuntimeId,
      parsed.modelId === "" ? null : parsed.modelId,
    );
  }, [
    activeApiRowId, installedPresetById, marketplaceProviderPresetId,
    retiredLlmProvider,
    onClearMarketplaceProviderPreset, onImmediateChange, onSelectMarketplaceProviderPreset,
    selectApiVendorModel, setModel,
    subscription.activeRuntime.kind, subscription.props.actions,
  ]);

  /** Put one row away: it closes, and whatever was typed into it goes with it. Cancelling is a decision; "not this"; so it must not leave the
   * draft behind to reappear the next time the row opens, and it must not leave the row pinned to the list by an edit the user just abandoned. */
  const closeRow = useCallback((rowId: string) => {
    setOpenRowIds((current) => current.filter((id) => id !== rowId));
    setSaveFailedRowIds((current) => current.filter((id) => id !== rowId));
    dropDraft(rowId);
  }, [dropDraft]);

  const revealRow = useCallback((rowId: string) => {
    setAddedRowIds((current) => current.includes(rowId) ? current : [...current, rowId]);
    setRowToReveal(rowId);
  }, []);

  /** Reveal a row picked from the add menu; see the menu's close handler. */
  const revealRowFromAddMenu = useCallback((rowId: string) => {
    menuRevealedRowRef.current = rowId;
    revealRow(rowId);
  }, [revealRow]);

  /** Show one card's credential form. Opening is not choosing: this touches no setting. It names the row and starts a draft
   * seeded from what that row already has stored, so the fields below describe the card the user clicked whatever chat is running on. */
  const openRowCredentialForm = useCallback((target: {
    rowId: string;
    vendorId: string;
    presetId: string;
  }) => {
    setOpenRowIds((current) =>
      current.includes(target.rowId) ? current : [...current, target.rowId]);
    if (draftForRow(target.rowId)) return;
    const preset = target.presetId ? installedPresetById.get(target.presetId) : undefined;
    const saved = savedVendorBlocks[target.vendorId];
    putDraft({
      rowId: target.rowId,
      vendorId: target.vendorId,
      presetId: target.presetId,
      keyInput: "",
      // A preset ships the one address it serves from; every other row's endpoint is whatever that vendor has stored.
      baseUrl: preset ? preset.baseUrl : saved?.baseUrl ?? "",
      ...(target.vendorId === "openai-compatible" && !preset ? { wire: customProviderWire(saved?.wire) } : {}),
      vertexProject: saved?.vertexProject ?? "",
      vertexLocation: saved?.vertexLocation ?? "",
    });
  }, [
    draftForRow, installedPresetById, putDraft, savedVendorBlocks,
  ]);

  /** Which sign-in method a two-way card is showing, or null when it should ask. The user's pick wins. Without one the card opens on the method that is already in use; the route chat runs on, then a subscription that is
   * signed in or signing in, then a stored or half-typed key; and with nothing configured it asks, so no key field appears until "API key" is chosen. A row reached only one way has nothing to choose and answers that way. */
  /** The method this row is serving chat through right now, or null. The OpenAI row (the only row with plan usage)
   * reads it from the one OpenAI login-type selector, so its three ways in can never disagree with the persisted selection. */
  const rowActiveMethod = useCallback((row: ProviderConnection): ProviderSignInMethod | null => {
    const activeRuntime = subscription.activeRuntime;
    if (row.planSubscription) {
      const loginType = openAiLoginTypeFor(activeRuntime, vendor);
      switch (loginType) {
        case "codex-cli":
          return "subscription";
        case "chatgpt-plan":
          return "plan";
        case "api-key":
          return rowIsActiveApiProvider(row) ? "api" : null;
        case null:
          return null;
        default: {
          const unhandled: never = loginType;
          throw new Error(`unhandled OpenAI login type: ${String(unhandled)}`);
        }
      }
    }
    if (activeRuntime.kind === "subscription") return activeRuntime.provider === row.id ? "subscription" : null;
    return rowIsActiveApiProvider(row) ? "api" : null;
  }, [rowIsActiveApiProvider, subscription.activeRuntime, vendor]);

  const rowAuthMethod = useCallback((row: ProviderConnection): ProviderSignInMethod | null => {
    if (!row.subscription) return row.apiVendorId ? "api" : null;
    if (!row.apiVendorId) return "subscription";
    const picked = authMethodByRow[row.id];
    if (picked) return picked;
    const active = rowActiveMethod(row);
    if (active === "subscription" || active === "plan") return active;
    if (active === "api" && credentialedProviderIds.has(rowCredentialId(row))) return "api";
    const connection = row.subscription.status?.connection;
    if (connection === "connected" || connection === "pending") return "subscription";
    const planConnection = row.planSubscription?.status?.connection;
    if (planConnection === "connected" || planConnection === "pending") return "plan";
    if (credentialedProviderIds.has(rowCredentialId(row)) || rowCredentialDirty(row.id)) return "api";
    return null;
  }, [
    authMethodByRow, credentialedProviderIds, rowActiveMethod, rowCredentialDirty, rowCredentialId,
  ]);

  /** Whether this row draws the API-key form when open. */
  const rowShowsCredentialForm = useCallback(
    (row: ProviderConnection): boolean => Boolean(row.apiVendorId) && rowAuthMethod(row) === "api",
    [rowAuthMethod],
  );

  /** Open a row: the key form only when the row is on (or only has) the API-key method. */
  const openRow = useCallback((row: ProviderConnection) => {
    // A card opened on a defaulted method stays on it while it is open, even when a status that arrives later would default it elsewhere.
    const method = rowAuthMethod(row);
    if (row.subscription && row.apiVendorId && method && !authMethodByRow[row.id]) {
      setAuthMethodByRow((current) => ({ ...current, [row.id]: method }));
    }
    if (rowShowsCredentialForm(row)) {
      openRowCredentialForm({ rowId: row.id, vendorId: row.apiVendorId!, presetId: row.presetId ?? "" });
    }
    else setOpenRowIds((current) => current.includes(row.id) ? current : [...current, row.id]);
  }, [authMethodByRow, openRowCredentialForm, rowAuthMethod, rowShowsCredentialForm]);

  /** Switch a two-way card to `method`. Picking "API key" starts the key form; leaving it puts away only what was
   * typed and not saved. Stored keys and signed-in subscriptions are untouched; the card offers their removal. */
  const chooseAuthMethod = useCallback((row: ProviderConnection, method: ProviderSignInMethod) => {
    setAuthMethodByRow((current) => ({ ...current, [row.id]: method }));
    setSaveFailedRowIds((current) => current.filter((rowId) => rowId !== row.id));
    if (method === "api") {
      openRowCredentialForm({ rowId: row.id, vendorId: row.apiVendorId!, presetId: row.presetId ?? "" });
    } else {
      dropDraft(row.id);
    }
  }, [dropDraft, openRowCredentialForm]);

  // A row opened on the API-key method; by default or because its method resolved after it opened; needs the draft its key form is drawn from.
  useEffect(() => {
    for (const row of visibleRows) {
      if (!openRowIds.includes(row.id) || !rowShowsCredentialForm(row) || draftForRow(row.id)) continue;
      openRowCredentialForm({ rowId: row.id, vendorId: row.apiVendorId!, presetId: row.presetId ?? "" });
    }
  }, [draftForRow, openRowCredentialForm, openRowIds, rowShowsCredentialForm, visibleRows]);

  /** Whether this row is showing its credential form. */
  const rowFormOpen = useCallback(
    (row: ProviderConnection): boolean => openRowIds.includes(row.id),
    [openRowIds],
  );

  /** Which row is actually showing a form right now; the signal the reveal waits on, since the form arrives a render after the row does. */
  const openFormRowId = visibleRows.find((row) => rowFormOpen(row))?.id ?? null;

  // A row that was just revealed has to be findable: the list can already be longer than the panel, and a card that appears below the fold reads as a click that did nothing.
  useEffect(() => {
    if (!rowToReveal) return;
    const node = connectionsRef.current?.querySelector<HTMLElement>(
      `[data-testid="llm-tab:connection:${rowToReveal}"]`,
    );
    if (!node) return;
    // A row added from the menu can be on screen a render before its form is; the draft it needs is the parent's to hold. Consuming the reveal on the bare row would put the caret on the disclosure button and leave nothing to move when the endpoint field
    // finally lands, so wait for the form the reveal was actually asking for. Only a row with an API route ever grows one: waiting on a form a subscription-only row will never have would strand the reveal, and the row it named would never be scrolled to.
    const expectsForm = visibleRows.some((row) => row.id === rowToReveal && rowShowsCredentialForm(row));
    const form = node.querySelector<HTMLElement>('[data-testid="llm-tab:manual-section"]');
    if (expectsForm && openRowIds.includes(rowToReveal) && !form) return;
    setRowToReveal(null);
    node.scrollIntoView?.({ block: "nearest" });
    const focusTarget = node.querySelector<HTMLElement>('[data-testid="llm-base-url-input"]')
      ?? node.querySelector<HTMLElement>('[data-testid="llm-api-key-input"]')
      ?? node.querySelector<HTMLElement>("button");
    focusTarget?.focus();
  }, [openFormRowId, openRowIds, rowShowsCredentialForm, rowToReveal, visibleRowKey, visibleRows]);

  /** Persist ONE card. Only what this row owns is written: its secret, and the fields the row itself is asked for. A vendor whose endpoint is fixed
   * and a preset that ships its own both write no block at all; sending one would overwrite an address that belongs to the generic provider's card. */
  const saveRowCredential = async (row: ProviderConnection) => {
    const draft = draftForRow(row.id);
    if (!draft || !onSaveProviderCredential) return;
    setSaveFailedRowIds((current) => current.filter((rowId) => rowId !== row.id));
    const preset = row.presetId ? installedPresetById.get(row.presetId) : undefined;
    const rowInfo = preset ? providerOptionFromPreset(preset) : getVendorInfo(draft.vendorId);
    const vendorBlock = draft.vendorId === "vertex-ai"
      ? {
        vertexProject: draft.vertexProject.trim() || undefined,
        vertexLocation: draft.vertexLocation.trim() || undefined,
      }
      : endpointIsUserSupplied(draft.vendorId, rowInfo, Boolean(row.presetId))
        ? { baseUrl: draft.baseUrl.trim() || undefined,
            ...(draft.vendorId === "openai-compatible" && !row.presetId ? { wire: customProviderWire(draft.wire) } : {}),
          }
        : undefined;
    const saved = await onSaveProviderCredential({
      credentialProviderId: rowCredentialId(row),
      vendorId: draft.vendorId,
      apiKey: draft.keyInput,
      ...(vendorBlock ? { vendorBlock } : {}),
    });
    if (!saved) {
      // The row stays open on what failed to commit: closing it would take the fields the user still has to correct away with it.
      setSaveFailedRowIds((current) =>
        current.includes(row.id) ? current : [...current, row.id]);
      return;
    }
    setCredentialSavedRowId(row.id);
    // Storing a key is not a settings write on every path, so re-ask the credential store directly rather than waiting on a broadcast that a secret-only save never sends.
    setSettingsRevision((current) => current + 1);
    // ...and let this row ask its endpoint again with the credential it now holds, whether the last answer was a failure or nothing at all.
    if (row.modelListKey) forgetModelListLaunchRefresh(row.modelListKey);
    // The same submit may also MOVE the row: the address it just wrote is the one the row will read from
    // next, and typing back an address that failed earlier this launch must still earn a fresh request.
    if (vendorBlock && "baseUrl" in vendorBlock) {
      forgetModelListLaunchRefresh(
        llmModelListCacheKey(draft.vendorId, draft.baseUrl.trim(), row.presetId ?? ""),
      );
    }
    // A committed card has nothing left to say, so it closes and gives its room back to the list. The draft goes with it; what it held is now what the store holds.
    dropDraft(row.id);
    setOpenRowIds((current) => current.filter((rowId) => rowId !== row.id));
  };

  /** Keep a two-way card on the method the user is acting in. Removing the credential the default was
   * read from would otherwise move the card to another method (or to none) under the user's hands. */
  const pinAuthMethod = (row: ProviderConnection, method: ProviderSignInMethod) => {
    if (!row.subscription || !row.apiVendorId) return;
    setAuthMethodByRow((current) => current[row.id] === method ? current : { ...current, [row.id]: method });
  };

  /** Remove the key this row stores. Only ever on an explicit request. */
  const deleteRowKey = (row: ProviderConnection) => {
    const method = rowAuthMethod(row);
    if (method) pinAuthMethod(row, method);
    void api.deleteApiKey(rowCredentialId(row)).then(() => {
      if (rowIsActiveApiProvider(row)) setHasKey(false);
      // A row that existed only because of the key it held would otherwise disappear the moment the key does; taking the open
      // card, and the field for entering a replacement, with it. Pin it so removing a key leaves somewhere to put the next one.
      revealRow(row.id);
      setSettingsRevision((current) => current + 1);
      onSaved();
    }).catch(() => {
      // The key is still stored; re-ask the store so the card says so.
      setSettingsRevision((current) => current + 1);
    });
  };

  /** The other method's credential, on a two-way card. Switching the card to one method does not remove what the other one holds: a
   * saved key or a signed-in subscription keeps working until the user says otherwise. The card says it is there and offers that removal. */
  const otherCredentialNote = (row: ProviderConnection) => {
    if (!row.subscription || !row.apiVendorId) return null;
    const method = rowAuthMethod(row);
    if ((method === "subscription" || method === "plan") && credentialedProviderIds.has(rowCredentialId(row))) {
      return (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/(--opacity-muted) px-3 py-2 text-xs text-muted-foreground"
          data-testid={`llm-tab:other-credential:${row.id}:api`}
        >
          <span>{t("subscriptionProvidersSection.otherApiKeySaved")}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-destructive"
            data-testid={`llm-tab:other-credential:${row.id}:remove-api-key`}
            onClick={() => deleteRowKey(row)}
          >
            {t("subscriptionProvidersSection.removeApiKey")}
          </Button>
        </div>
      );
    }
    // A signed-in way in the card is not showing: on the Codex CLI, plan usage; on plan usage, the Codex CLI; on the API key, either.
    const others = method === "subscription"
      ? [row.planSubscription]
      : method === "plan" ? [row.subscription] : [row.subscription, row.planSubscription];
    const view = others.find((candidate) => candidate?.status?.connection === "connected");
    if (view && method !== null) {
      const logout = subscription.props.actions.logout;
      return (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/(--opacity-muted) px-3 py-2 text-xs text-muted-foreground"
          data-testid={`llm-tab:other-credential:${row.id}:subscription`}
        >
          <span>{t("subscriptionProvidersSection.otherSubscriptionSignedIn", { plan: view.descriptor.planName })}</span>
          {view.descriptor.supportsLogout && logout ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-destructive"
              disabled={Boolean(view.busyAction) || view.refreshPending === true}
              data-testid={`llm-tab:other-credential:${row.id}:sign-out`}
              onClick={() => {
                pinAuthMethod(row, method);
                void Promise.resolve(logout(view.descriptor.id)).catch(() => undefined);
              }}
            >
              {t("subscriptionProvidersSection.signOut")}
            </Button>
          ) : null}
        </div>
      );
    }
    return null;
  };

  /** The credential form for one provider row. Every field here is the ROW's: its stored endpoint, its secret, its "requires a key"
   * answer. Nothing is read off the active provider, so the form for one card is the same form whichever provider chat is running on. */
  const credentialFormFor = (row: ProviderConnection) => {
    const draft = draftForRow(row.id);
    if (!draft) return null;
    const rowPreset = row.presetId ? installedPresetById.get(row.presetId) : undefined;
    const rowVendorId = draft.vendorId;
    const rowInfo = rowPreset ? providerOptionFromPreset(rowPreset) : getVendorInfo(rowVendorId);
    const rowEndpointLocked = Boolean(row.presetId);
    const rowHasKey = credentialedProviderIds.has(rowCredentialId(row));
    const rowNeedsApiKey = rowRequiresApiKey(row);
    const patchDraft = (next: Partial<ProviderCredentialDraft>) =>
      putDraft({ ...draft, ...next });
    return (
      <div className="space-y-3" data-testid="llm-tab:manual-section">
        {rowVendorId === "openai-compatible" && !rowEndpointLocked && (
          <div className="space-y-2">
            <Label htmlFor="custom-provider-wire">{t("llmTab.apiFormat")}</Label>
            <Select value={customProviderWire(draft.wire)} onValueChange={(value) => patchDraft({ wire: customProviderWire(value) })}>
              <SelectTrigger id="custom-provider-wire" data-testid="llm-tab:custom-wire"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CUSTOM_PROVIDER_WIRES.map((wire) => (
                  <SelectItem key={wire} value={wire}>{t(CUSTOM_WIRE_LABEL_KEYS[wire])}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t("llmTab.apiFormatModelList")}</p>
          </div>
        )}
        {rowVendorId !== "vertex-ai" && endpointIsUserSupplied(rowVendorId, rowInfo, rowEndpointLocked) && (
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              {t("llmTab.endpointBaseUrlLabel")} *
            </Label>
            <Input
              data-testid="llm-base-url-input"
              value={draft.baseUrl}
              onChange={(e) => patchDraft({ baseUrl: e.target.value })}
              placeholder={rowInfo.baseUrlPlaceholder ?? "https://..."}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("llmTab.baseUrlDiscardWarning")}
            </p>
            {rowVendorId === "azure-foundry" && (
              <p className="text-[11px] text-muted-foreground">
                {t("llmTab.azureEndpointFormat")}
                {" "}<code>https://{"{resource}"}.openai.azure.com/openai/v1/</code>
                {" "}— {t("llmTab.azureDeploymentNote")}
              </p>
            )}
          </div>
        )}
        {rowVendorId === "vertex-ai" && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">{t("llmTab.vertexTitle")}</p>
            <p className="text-[11px] text-muted-foreground">
              {t("llmTab.vertexAuthDesc1")}<code>gcloud auth application-default login</code>{t("llmTab.vertexAuthDesc2")}
              {t("llmTab.vertexAuthDesc3")}<code>GOOGLE_APPLICATION_CREDENTIALS</code>{t("llmTab.vertexAuthDesc4")}
            </p>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("llmTab.gcpProjectIdLabel")}</Label>
              <Input
                value={draft.vertexProject}
                onChange={(e) => patchDraft({ vertexProject: e.target.value })}
                placeholder="my-gcp-project"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t("llmTab.vertexLocationLabel", { optional: t("llmTab.optional") })}
              </Label>
              <Input
                value={draft.vertexLocation}
                onChange={(e) => patchDraft({ vertexLocation: e.target.value })}
                placeholder={t("llmTab.vertexLocationPlaceholder")}
              />
            </div>
          </div>
        )}
        {rowVendorId !== "vertex-ai" && (
          <div
            className="min-w-0 space-y-2"
            data-testid="llm-tab:api-key-section"
            data-api-key-required={rowNeedsApiKey ? "true" : "false"}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Label className="min-w-0 text-sm font-medium" data-testid="llm-tab:api-key-label">
              {row.label} {t("llmTab.apiKey")}
              {!rowNeedsApiKey ? ` (${t("llmTab.optional")})` : ""}
            </Label>
              {rowHasKey ? (
                <Badge variant="default" data-testid="llm-tab:api-key-status" className="h-5 shrink-0 whitespace-nowrap px-2.5 text-xs">{t("llmTab.apiKeySet")}</Badge>
              ) : (
                <Badge variant="secondary" data-testid="llm-tab:api-key-status" className="h-5 shrink-0 whitespace-nowrap px-2.5 text-xs">
                  {rowNeedsApiKey ? t("llmTab.apiKeyNotSet") : t("llmTab.optional")}
                </Badge>
              )}
              {rowHasKey && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-destructive"
                  onClick={() => deleteRowKey(row)}
                >
                  {t("llmTab.delete")}
                </Button>
              )}
            </div>
            <Input
              data-testid="llm-api-key-input"
              type="password"
              placeholder={rowHasKey ? t("llmTab.replaceKey") : rowInfo.placeholder}
              value={draft.keyInput}
              onChange={(e) => patchDraft({ keyInput: e.target.value })}
            />
          </div>
        )}
        {/* Save belongs to the card whose fields it commits. A page-level
            button sat below every provider and the "add provider" control, so
            the one thing a half-filled new card needed was the one control
            furthest from it — and it read as committing the whole page. */}
        {onSaveProviderCredential && (
          <SectionSaveBar
            onSave={() => void saveRowCredential(row)}
            saving={saving}
            settingsLoaded={settingsLoaded}
            dirty={rowCredentialDirty(row.id)}
            onCancel={() => closeRow(row.id)}
            testId="llm-tab:save-providers"
          />
        )}
      </div>
    );
  };

  // Which of this provider's two routes is serving chat right now. The user asked for exactly this: the row
  // says the provider, the badge says the mode. Which path this row is serving chat through right now, or null.
  const activeMode = (row: ProviderConnection): ProviderSignInMethod | null =>
    rowActiveMethod(row);

  /** What this card still needs before its models join the chooser. The card carries no switch of its own: picking a model IS picking the provider, so a provider that cannot answer a turn
   * is simply absent from the one list. Absent with no explanation reads as a bug, so the card that owns the missing piece says what it is, in the same words the list would have needed. */
  const pickModelGuidance = (row: ProviderConnection) => {
    if (credentialSavedRowId !== row.id || activeRouteCanChat) return null;
    return (
      <p
        className="text-[11px] text-muted-foreground"
        data-testid={`llm-tab:connection-pick-model:${row.id}`}
      >
        {t("llmTab.pickModelToUse")}
      </p>
    );
  };

  const chatAvailabilityNote = (row: ProviderConnection) => {
    if (!row.apiVendorId) return null;
    const blocker = rowChatBlocker(row);
    if (!blocker) return null;
    return (
      <p
        className="text-[11px] text-muted-foreground"
        data-testid={`llm-tab:connection-blocked:${row.id}`}
      >
        {t(CHAT_BLOCKER_MESSAGE_KEYS[blocker])}
      </p>
    );
  };

  /** What the row has to say whether or not it is open. Both of these answer "why can I not use this provider yet"; a question someone has while the row
   * is folded, so they sit outside the disclosure. Returning null when neither speaks keeps the shared row from drawing an empty band under the head. */
  const rowNote = (row: ProviderConnection) => {
    const blocked = chatAvailabilityNote(row);
    const guidance = pickModelGuidance(row);
    if (!blocked && !guidance) return null;
    return <>{blocked}{guidance}</>;
  };

  /** The ways in to this provider, named; and which one is live. A provider a user recognises as one company is one row, so the row has to
   * say how it is reached. A filled badge is the route chat is actually running on; an outlined one is a route that is configured and idle. */
  const routeBadges = (row: ProviderConnection) => {
    const active = activeMode(row);
    const badge = (mode: ProviderSignInMethod, label: string) => (
      <Badge
        key={mode}
        variant={active === mode ? "default" : "outline"}
        className="h-5 shrink-0 px-2 text-[10px]"
        data-testid={`llm-tab:connection-route:${row.id}:${mode}`}
        data-active={active === mode ? "true" : "false"}
      >
        {label}
      </Badge>
    );
    return (
      <>
        {row.subscription ? badge("subscription", t("llmTab.modeSubscription")) : null}
        {row.planSubscription ? badge("plan", t("llmTab.modeChatgptPlan")) : null}
        {row.apiVendorId ? badge("api", t("llmTab.modeApiKey")) : null}
      </>
    );
  };

  /** The subscription whose state can speak for the row: plan usage while the card is on it, otherwise the row's own runtime. */
  const rowSubscriptionView = (row: ProviderConnection): SubscriptionProviderView | undefined =>
    row.planSubscription && rowAuthMethod(row) === "plan" ? row.planSubscription : row.subscription;

  /** Whether the subscription's state is the row's state (see `providerRowState`). */
  const subscriptionSpeaksForRow = (row: ProviderConnection): boolean => {
    const view = rowSubscriptionView(row);
    if (!view) return false;
    if (!row.apiConfigured) return true;
    const connection = view.status?.connection;
    return connection === "connected" || connection === "pending";
  };

  /** What a subscription row is waiting on, in the row's own words. The five-word column is deliberately coarse; it says whether the
   * provider is usable, not which handshake is missing; so the specific answer moves down to the sub-line, where it has room to be a sentence. */
  const runtimeSentence = (row: ProviderConnection): string | null => {
    const view = rowSubscriptionView(row);
    const status = view?.status;
    if (!view || !status || !subscriptionSpeaksForRow(row)) return null;
    if (status.runtime === "unavailable") return t("subscriptionProvidersSection.statusRuntimeUnavailable");
    if (status.runtime === "not-configured") {
      return view.descriptor.executable === "discovered"
        ? t("subscriptionProvidersSection.statusCliNotFound")
        : t("subscriptionProvidersSection.statusRuntimeNotConfigured");
    }
    if (status.runtime === "unverified") return t("subscriptionProvidersSection.statusRuntimeUnverified");
    if (status.connection === "pending") {
      return status.pendingLoginMethod === "device-code"
        ? t("subscriptionProvidersSection.statusDeviceCodePending")
        : t("subscriptionProvidersSection.statusBrowserPending");
    }
    return null;
  };

  /** How many models this row contributes to the one chooser. */
  const rowOfferedModelCount = (row: ProviderConnection): number => {
    const apiId = row.apiVendorId ? apiProviderId(rowCredentialId(row)) : null;
    const planId = row.planSubscription?.descriptor.id;
    return unifiedOptions.filter((option) =>
      option.providerId === row.id
      || (planId !== undefined && option.providerId === planId)
      || (apiId !== null && option.providerId === apiId)).length;
  };

  /** Give each provider row one usability state; route details explain partial failures, while the active-route badge separately shows chat selection. */
  const providerRowState = (row: ProviderConnection): ConnectionRowState | null => {
    // A row with a working API key is not held back by the other method: a missing or unusable CLI only
    // speaks for the row while the subscription is the way in (signed in, signing in, or no key to fall back on).
    const speaks = subscriptionSpeaksForRow(row);
    const status = speaks ? rowSubscriptionView(row)?.status ?? null : null;
    // No word at all while the surface that owns the real state is still answering; guessing "signed out" during the check is how a row lies. "No CLI found" and
    // "the CLI found cannot be used" are answers, though: a runtime with nothing usable to run has no account to ask about, so its connection stays unknown for good.
    if (status?.runtime === "not-configured") return "needs-setup";
    if (status?.runtime === "unavailable") return "attention";
    if (speaks && (!status || status.runtime === "checking" || status.connection === "unknown")) {
      return null;
    }
    if (status?.runtime === "unverified") return "needs-setup";
    if (status?.connection === "pending") return "pending";
    if (status?.connection === "connected" || row.apiConfigured) {
      // A failed catalogue fetch is the fifth word only when it left the row with NOTHING to offer. A provider whose models are already in the chooser is usable right now, and one of its two routes failing does not change that; wording it "needs checking" sends a person to
      // repair a provider that is working. Where the row offers nothing, the stored credential really is "on, but not well", which is what that word is for. Either way the failed route is named on the sub-line, in its own tone, with the row shut; so "connected" here hides nothing.
      return rowModelListState(row)?.status === "error" && rowOfferedModelCount(row) === 0
        ? "attention"
        : "connected";
    }
    return "needs-setup";
  };

  /** Read endpoint and catalog status through rowModelListState so card and chooser agree; keep the sync-status attribute on this single outcome node. */
  const connectionSubline = (row: ProviderConnection) => {
    const state = rowModelListState(row);
    const parts: string[] = [];
    const waiting = runtimeSentence(row);
    if (waiting) parts.push(waiting);
    if (state && row.modelListKey) {
      const endpoint = state.endpoint ?? row.modelListKey.split("\n")[1] ?? "";
      if (endpoint) parts.push(endpoint);
      parts.push(modelSyncLabel(t, state));
    } else {
      const count = rowOfferedModelCount(row);
      if (count > 0) parts.push(t("llmTab.connectionModelCount", { count }));
    }
    if (parts.length === 0) return null;
    const text = parts.join(" · ");
    return (
      <span
        className={state?.status === "error" ? "text-destructive" : undefined}
        title={text}
        data-provider-sync-status={state?.status ?? "none"}
        data-testid={`llm-tab:connection-subline:${row.id}`}
      >
        {text}
      </span>
    );
  };

  /** Whether any row in the list has something to refresh at all. */
  const listHasRefresh = visibleRows.some((row) =>
    Boolean(rowModelListRequest(row)) || Boolean(row.subscription && subscription.props.actions.refreshStatus));

  /** ONE refresh per row, for the whole row. "Refresh this provider" was never two decisions, but the provider used to be two cards, so it grew two identical icons; one re-reading a sign-in, one re-asking an endpoint for its catalogue. This does whichever halves the
   * row actually has. The launch refresh is the only automatic one there is, so a row whose provider ships a model mid-session still needs this; a row with neither route to refresh (Azure AI Foundry, Claude, Gemini: their lists are curated here) shows no control at all. */
  const rowRefreshControl = (row: ProviderConnection) => {
    const request = rowModelListRequest(row);
    const refreshStatus = row.subscription ? subscription.props.actions.refreshStatus : undefined;
    if (!request && !refreshStatus) {
      // The chevron is a column, and a column that moves row to row is the "nothing lines up" complaint. A row with nothing to refresh still owes
      // the list the width the refreshable rows take; but only while the list actually has one, so a list of curated providers keeps its edge tight.
      return listHasRefresh
        ? <span className="h-7 w-7 shrink-0" aria-hidden={true} />
        : null;
    }
    const loading = (row.modelListKey ? modelLists[row.modelListKey]?.status === "loading" : false)
      || row.subscription?.refreshPending === true
      || row.planSubscription?.refreshPending === true;
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 shrink-0 p-0"
        aria-label={t("llmTab.connectionRefresh", { provider: row.label })}
        title={t("llmTab.connectionRefresh", { provider: row.label })}
        data-testid={`llm-tab:connection-refresh:${row.id}`}
        disabled={loading}
        onClick={() => {
          if (request) void requestModelList(request.vendorId, { ...request.options, force: true });
          void refreshStatus?.(row.id as SubscriptionRuntimeId);
          if (row.planSubscription) void refreshStatus?.(row.planSubscription.descriptor.id);
        }}
      >
        {loading
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden={true} />
          : <RefreshCw className="h-3.5 w-3.5" aria-hidden={true} />}
      </Button>
    );
  };

  /** Says that a collapsed card is still holding input. Collapsing is allowed; trapping a card open is worse; but a card that folds away with a
   * half-typed key must not read as finished. The header is the disclosure, so the marker sits on the control that reopens it and brings Save back. */
  const unsavedBadge = (row: ProviderConnection) => {
    if (!rowCredentialDirty(row.id)) return null;
    if (rowFormOpen(row)) return null;
    return (
      <Badge
        variant="outline"
        className="h-5 shrink-0 whitespace-nowrap px-2 text-[10px]"
        data-testid={`llm-tab:connection-unsaved:${row.id}`}
      >
        {t("llmTab.unsavedChanges")}
      </Badge>
    );
  };

  const connectionsList = (
    <div className="space-y-3" data-testid="llm-tab:connections" ref={connectionsRef}>
      <p className="rounded-md border bg-muted/(--opacity-muted) px-3 py-2 text-xs text-muted-foreground">
        {t("subscriptionProvidersSection.securityNotice")}
      </p>
      {subscription.props.apiChatError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
          data-testid="llm-tab:connections-error"
        >
          {t(ERROR_MESSAGE_KEYS[subscription.props.apiChatError])}
        </p>
      ) : null}
      {visibleRows.length === 0 ? (
        <p className="rounded-md border px-3 py-4 text-center text-xs text-muted-foreground" data-testid="llm-tab:connections-empty">
          {t("llmTab.connectionsEmpty")}
        </p>
      ) : null}
      {/* ONE row renderer for every provider, however it is reached — and the
          SAME renderer the remote connections list uses, so a reader scanning
          either list is reading one visual language. Two renderers meant two
          headers, two state words and two refresh buttons for one company, and
          two independent computations of the same facts, which is how the
          screen came to contradict itself. */}
      {visibleRows.length > 0 ? (
        <div className="flex flex-col gap-3" data-testid="llm-tab:connections-list">
          {visibleRows.map((row) => (
            <ConnectionRow
              key={row.id}
              label={row.label}
              state={providerRowState(row)}
              endpoint={connectionSubline(row)}
              badges={(
                <>
                  {routeBadges(row)}
                  {unsavedBadge(row)}
                  {row.apiVendorId && marketplaceVendorIds.has(row.apiVendorId) ? (
                    <span
                      className="inline-flex h-5 items-center rounded-full bg-secondary px-1.5 text-[10px] font-medium text-secondary-foreground"
                      data-testid={`llm-tab:selected-provider-marketplace:${row.apiVendorId}`}
                    >
                      {t("llmTab.marketplaceInstalledBadge")}
                    </span>
                  ) : null}
                </>
              )}
              note={rowNote(row)}
              action={rowRefreshControl(row)}
              expanded={rowFormOpen(row)}
              onToggle={() => {
                if (rowFormOpen(row)) {
                  closeRow(row.id);
                  return;
                }
                openRow(row);
                setRowToReveal(row.id);
              }}
              testId={`llm-tab:connection:${row.id}`}
            >
              <div className="space-y-3">
                {/* A provider reached two ways asks which one first, and the
                    body shows only that method: sign-in controls for the
                    subscription, the key form for the API key. */}
                {row.subscription && row.apiVendorId ? (
                  <SignInMethodChoice
                    rowId={row.id}
                    planName={row.subscription.descriptor.planName}
                    value={rowAuthMethod(row)}
                    onChange={(method) => chooseAuthMethod(row, method)}
                    {...(row.planSubscription ? { offersPlan: true } : {})}
                  />
                ) : null}
                {row.subscription && rowAuthMethod(row) === "subscription" ? (
                  <SubscriptionAuthControls
                    provider={row.subscription}
                    actions={{
                      ...subscription.props.actions,
                      // Signing out keeps the card on the subscription, so the sign-in buttons come back instead of the card asking again.
                      logout: (providerId) => {
                        pinAuthMethod(row, "subscription");
                        return subscription.props.actions.logout?.(providerId);
                      },
                    }}
                  />
                ) : null}
                {row.planSubscription && rowAuthMethod(row) === "plan" ? (
                  <SubscriptionAuthControls
                    provider={row.planSubscription}
                    actions={{
                      ...subscription.props.actions,
                      logout: (providerId) => {
                        pinAuthMethod(row, "plan");
                        return subscription.props.actions.logout?.(providerId);
                      },
                    }}
                  />
                ) : null}
                {otherCredentialNote(row)}
                {saveFailedRowIds.includes(row.id) ? (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
                    data-testid={`llm-tab:connection-save-failed:${row.id}`}
                  >
                    {t("llmTab.connectionSaveFailed")}
                  </p>
                ) : null}
                {rowShowsCredentialForm(row) ? credentialFormFor(row) : null}
              </div>
            </ConnectionRow>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 text-xs" data-testid="llm-tab:add-provider">
              <Plus className="size-3.5" aria-hidden={true} />
              {t("llmTab.addProvider")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-80 w-64 overflow-y-auto"
            /* Every item here reveals a card and moves the caret into it. That move cannot land while this menu's focus scope is still up, and the menu's own restore would put the caret back on the trigger afterwards; so decline the restore and re-arm the reveal for once the menu is gone. Closing without picking anything leaves the default restore alone. */
            onCloseAutoFocus={(event) => {
              const revealed = menuRevealedRowRef.current;
              menuRevealedRowRef.current = null;
              if (!revealed) return;
              event.preventDefault();
              setRowToReveal(revealed);
            }}
          >
            {PROVIDER_PICKER_GROUPS.map((group) => (
              <div key={group}>
                {group === "custom" ? <DropdownMenuSeparator /> : null}
                <h3 className="px-2 py-1.5 text-xs font-semibold text-muted-foreground" data-provider-group={group}>{t(PROVIDER_GROUP_LABEL_KEYS[group])}</h3>
                {pickerEntries.filter((entry) => entry.group === group).map((entry) => {
                  const runtime = isSubscriptionRuntimeId(entry.id) ? entry.id : undefined;
                  const runtimeRowId = runtime ? SUBSCRIPTION_RUNTIME_ROW_PARTNER[runtime] ?? runtime : undefined;
                  const row = connections.find((candidate) => runtimeRowId
                    ? candidate.id === runtimeRowId
                    : candidate.id === entry.id || (!candidate.presetId && candidate.apiVendorId === entry.id));
                  const option = providerSelectOptions.find((candidate) => candidate.id === entry.id);
                  const view = runtime ? subscription.providers.find((candidate) => candidate.descriptor.id === runtime) : undefined;
                  const label = runtime ? subscriptionModelsLabel(t, view ?? {
                    descriptor: { ...subscriptionRuntimeDescriptor(runtime), description: "" },
                  }) : option?.label;
                  if (!label) return null;
                  if (group !== "custom" && !runtime && (row?.apiConfigured || pinnedRowIds.includes(row?.id ?? entry.id))) return null;
                  return (
                    <DropdownMenuItem
                      key={entry.id}
                      data-testid={`llm-tab:add-provider-item:${entry.id}`}
                      disabled={Boolean(runtime && !row)}
                      onClick={() => {
                        const rowId = row?.id ?? entry.id;
                        revealRowFromAddMenu(rowId);
                        if (runtime && row) {
                          chooseAuthMethod(row, runtime === "chatgpt-plan" ? "plan" : "subscription");
                          setOpenRowIds((current) => current.includes(rowId) ? current : [...current, rowId]);
                        } else if (row) {
                          chooseAuthMethod(row, "api");
                          openRowCredentialForm({ rowId, vendorId: row.apiVendorId!, presetId: row.presetId ?? "" });
                        } else {
                          const presetId = marketplaceProviderPresetIdFromSecretId(entry.id) ?? "";
                          openRowCredentialForm({ rowId, vendorId: presetId ? "openai-compatible" : entry.id, presetId });
                        }
                      }}
                    >
                      {group === "custom" ? t("llmTab.addCustomProvider") : label}
                    </DropdownMenuItem>
                  );
                })}
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  return (
    <div className="min-w-0 space-y-6">
      <SettingsPageHeader
        title={t("llmTab.pageTitle")}
        description={t("llmTab.pageDescription")}
      />

      <SettingsSection title={t("compactionSettings.title")} id="llm-compaction">
        <div className="space-y-2">
          <Label htmlFor="compaction-model">{t("compactionSettings.model")}</Label>
          <Input
            id="compaction-model"
            data-testid="compaction-model"
            value={compactionModelEditable ? compactionModel : ""}
            onChange={(event) => {
              compactionModelDirtyRef.current = event.target.value.trim() !== savedCompactionModel;
              setCompactionModel(event.target.value);
            }}
            placeholder={t("compactionSettings.currentModel")}
            aria-describedby="compaction-model-description"
            maxLength={MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH}
            disabled={!settingsLoaded || !compactionModelEditable || compactionSaving}
          />
          <p id="compaction-model-description" className="text-xs text-muted-foreground">
            {t(compactionModelEditable ? "compactionSettings.description" : "compactionSettings.unavailable")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="compaction-model-save"
            disabled={!settingsLoaded || !compactionModelEditable || compactionSaving || compactionModel.trim() === savedCompactionModel}
            onClick={() => { void handleCompactionModelSave(); }}
          >
            {t(compactionSaving ? "llmTab.saving" : "llmTab.save")}
          </Button>
          {compactionSaveFailed && <p role="alert" className="text-xs text-destructive">{t("compactionSettings.saveFailed")}</p>}
        </div>
      </SettingsSection>

      {/* Provider configuration — API keys and endpoint settings are edited
          directly here. */}
      <SettingsSection
        data-settings-section="llm-providers"
        title={t("llmTab.providerConfig")}
        id="llm-providers"
        actions={onOpenMarketplace ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            data-testid="llm-tab:marketplace-providers"
            onClick={onOpenMarketplace}
          >
            <Store className="size-3.5" aria-hidden={true} />
            {t("llmTab.moreProvidersInMarketplace")}
          </Button>
        ) : null}
      >
        <div
          className="space-y-3"
          data-settings-loaded={settingsLoaded ? "true" : "false"}
          data-testid="llm-tab:section-providers"
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="model-select" className="text-sm font-medium">{t("llmTab.model")}</Label>
              <div className="flex items-center gap-1">
                {onOpenMarketplace && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 px-2 text-xs"
                        data-testid="llm-tab:marketplace-models"
                        onClick={onOpenMarketplace}
                      >
                        <Store className="h-3.5 w-3.5" aria-hidden={true} />
                        {t("llmTab.moreModelsInMarketplace")}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("llmTab.moreModelsInMarketplace")}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
            {/* ONE chooser across every connected provider. Picking a model
                is what selects the provider — there is no second "switch"
                control, because there was never a second choice to make. */}
            <UnifiedModelSelect
              options={unifiedOptions}
              value={selectedUnifiedValue}
              onValueChange={handleUnifiedModelChange}
              pinned={pinnedModels}
              onTogglePin={handleTogglePin}
              placeholder={unifiedPlaceholder}
              popupClassName={SELECT_POPUP_LAYOUT}
              disabled={subscription.props.chatSelectionBusy ?? false}
            />
            {unlistedModel && subscription.activeRuntime.kind === "api" && (
              <p
                role="alert"
                className="text-[11px] text-destructive"
                data-testid="llm-tab:model-unlisted"
              >
                {t("llmTab.modelUnlistedWarning", { model: unlistedModel })}
              </p>
            )}
          </div>
          {/* Declares support for the SELECTED model, so it waits for one: a
              route nothing can answer on has only its vendor's default id,
              and naming that here would describe a model nobody chose. */}
          {subscription.activeRuntime.kind === "api" && activeRouteCanChat && activeModelValue && (
            <div className="min-w-0 space-y-1.5" data-testid="llm-tab:image-input-row">
              <Label htmlFor="model-image-input">{t("llmTab.imageInput")}</Label>
              <Select
                value={selectedImageInput === undefined ? "automatic" : selectedImageInput ? "supported" : "unsupported"}
                onValueChange={(value) => { void handleImageInputChange(value); }}
                disabled={!settingsLoaded || !isLLMVendor(vendor) || imageInputSaving || Boolean(subscription.props.chatSelectionBusy)}
              >
                <SelectTrigger id="model-image-input" data-testid="llm-tab:image-input" aria-describedby="model-image-input-help">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="automatic">{t("llmTab.imageInputAutomatic")}</SelectItem>
                  <SelectItem value="supported">{t("llmTab.imageInputSupported")}</SelectItem>
                  <SelectItem value="unsupported">{t("llmTab.imageInputUnsupported")}</SelectItem>
                </SelectContent>
              </Select>
              <p id="model-image-input-help" className="break-words text-xs text-muted-foreground">
                {t("llmTab.imageInputHelp", { model: activeModelValue })}
              </p>
              {imageInputError === imageInputSelection && <p role="alert" className="text-xs text-destructive">{t("llmTab.imageInputSaveFailed")}</p>}
            </div>
          )}
          {connectionsList}
        </div>
      </SettingsSection>

      {/* Section B — Extended Thinking / Reasoning */}
      <SettingsSection
        data-settings-section="llm-thinking"
        title={t("llmTab.thinkingTitle")}
        description={t("llmTab.thinkingDesc")}
        badge={<ImmediateBadge />}
        actions={
          <Switch
            checked={enableThinking}
            onCheckedChange={(c) => {
              setEnableThinking(c);
              onImmediateChange?.();
            }}
            aria-label={t("llmTab.thinkingTitle")}
          />
        }
        id="llm-thinking"
      >
        <div
          className="min-w-0"
          data-testid="llm-tab:section-thinking"
        >
          {enableThinking && (
            <div className="space-y-2">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">{t("llmTab.reasoningEffortLabel")}</Label>
                  <SettingsHelpPopover ariaLabel={t("llmTab.reasoningEffortLabel")}>
                    {t("llmTab.reasoningEffortDesc")}
                  </SettingsHelpPopover>
                </span>
                <span className="text-xs font-medium tabular-nums">
                  {reasoningBudgetLabel(thinkingBudget, reasoningDepths)}
                  <span className="ml-2 text-muted-foreground">
                    · {t("llmTab.reasoningBudgetTokens", { count: formatTokensExact(thinkingBudget) })}
                  </span>
                </span>
              </div>
              {reasoningDepths.length > 0 && <Slider
                min={0}
                max={reasoningDepths.length - 1}
                step={1}
                value={[budgetToDepthIndex(thinkingBudget, reasoningDepths)]}
                onValueChange={([value]) => {
                  const rung = value === undefined ? undefined : reasoningDepths[value];
                  if (!rung) throw new Error("Invalid reasoning depth");
                  setThinkingBudget(rung.budget);
                  onImmediateChange?.();
                }}
                aria-label={t("llmTab.reasoningEffortAriaLabel")}
              />}
              <div className="flex justify-between text-[10px] text-muted-foreground">
                {reasoningDepths.map((s) => (
                  <button key={s.key} type="button" aria-pressed={s.budget === thinkingBudget} onClick={() => {
                    setThinkingBudget(s.budget);
                    onImmediateChange?.();
                  }}>{s.label}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Section C — Fallback Chain */}
      <SettingsSection
        data-settings-section="llm-fallback"
        title={t("llmTab.fallbackTitle")}
        description={t("llmTab.fallbackDesc")}
        id="llm-fallback"
        actions={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t("llmTab.fallbackTitle")}
            aria-controls="fallback-chain-content"
            aria-expanded={fallbackOpen}
            onClick={() => setFallbackOpen((open) => !open)}
            data-testid="fallback-chain-toggle"
          >
            {fallbackOpen ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
          </Button>
        }
      >
        <div
          className="min-w-0"
          data-testid="fallback-chain-section"
        >
          {fallbackOpen && (
            <div id="fallback-chain-content" className="min-w-0 space-y-3">
              {fallbackChain.map((entry, idx) => {
                const trimmedFallbackModel = entry.model.trim();
                const fallbackModelListKey = vendorModelListKey(entry.provider);
                const fallbackModelRetired = modelRetiredOn(savedModelListCache, fallbackModelListKey, entry.provider);
                const savedFallbackModel = trimmedFallbackModel;
                // A saved fallback at a retired or deprecated model stays unselected until the user picks another; it is not swapped for a default.
                const fallbackRetirement = modelRetirementOn(savedModelListCache, fallbackModelListKey, entry.provider)(savedFallbackModel);
                const retiredFallbackModel = fallbackRetirement ? savedFallbackModel : null;
                const fallbackModelValue = retiredFallbackModel ? "" : savedFallbackModel;
                const fallbackModelList = modelLists[fallbackModelListKey];
                const fallbackModelOptions = modelOptionsFor(
                  entry.provider,
                  fallbackModelValue,
                  optionsFromModelListState(fallbackModelList),
                  undefined,
                  undefined,
                  fallbackModelRetired,
                );
                return (
                  <div key={idx} className="flex min-w-0 flex-col gap-2 sm:flex-row">
                    <ProviderSelect
                      value={entry.provider}
                      onValueChange={(value) => {
                        if (!isLLMVendor(value)) return;
                        const next = [...fallbackChain];
                        next[idx] = {
                          ...next[idx]!,
                          provider: value,
                          model: "",
                        };
                        setFallbackChain(next);
                      }}
                      triggerClassName="w-full text-xs sm:w-36"
                      vendorOptions={visibleVendorsFor()}
                    />
                    <Select
                      value={fallbackModelValue}
                      onValueChange={(value) => {
                        const next = [...fallbackChain];
                        next[idx] = { ...next[idx]!, model: value };
                        setFallbackChain(next);
                      }}
                    >
                      <SelectTrigger className="min-w-0 flex-1 text-xs">
                        <SelectValue
                          placeholder={retiredFallbackModel && fallbackRetirement
                            ? retiredModelPlaceholder(t, fallbackRetirement, retiredFallbackModel)
                            : t("llmTab.model")}
                        />
                      </SelectTrigger>
                      <SelectContent className={SELECT_POPUP_LAYOUT}>
                        {fallbackModelOptions.map((option) => {
                          // The engine builds a fallback on its vendor block's saved endpoint (provider.ts) and matches it under that endpoint's identity, with no route catalog entry or report.
                          const fallbackRoute = {
                            vendor: entry.provider,
                            model: option,
                            ...(entry.provider !== "vertex-ai" && savedVendorBlocks[entry.provider]?.baseUrl
                              ? { baseUrl: savedVendorBlocks[entry.provider]!.baseUrl }
                              : {}),
                          };
                          const fallbackReasoning = resolveReasoningSupport(fallbackRoute);
                          const fallbackReasoningUnstated = reasoningFallsToHost({
                            ...fallbackRoute,
                            ...(fallbackReasoning !== undefined ? { reasoning: fallbackReasoning } : {}),
                          });
                          return (
                            <SelectItem key={option} value={option}>
                              <ModelSelectItemContent
                                option={option}
                                toolCall={resolveToolCallSupport(fallbackRoute)}
                                {...(fallbackReasoning ? { reasoning: fallbackReasoning } : {})}
                                {...(fallbackReasoningUnstated ? { reasoningUnstatedVendor: entry.provider } : {})}
                              />
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 self-end text-xs text-destructive sm:self-auto"
                      onClick={() => setFallbackChain((c) => c.filter((_, i) => i !== idx))}
                    >
                      {t("llmTab.delete")}
                    </Button>
                  </div>
                );
              })}
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => setFallbackChain((c) => [
                  ...c,
                  { provider: "openai", model: "" },
                ])}
              >
                {t("llmTab.addEntry")}
              </Button>
              {hasOnSave && (
                <SectionSaveBar
                  onSave={onSave!}
                  saving={saving}
                  settingsLoaded={settingsLoaded}
                  testId="llm-tab:save-fallback"
                />
              )}
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Per-model price corrections — self-contained: it reads and writes the
          one settings key it owns, so it does not join this tab's prop chain. */}
      <PricingOverridesSection />

      {/* The model catalog refresh switch — self-contained like the section above. */}
      <ModelCatalogRefreshSection />
    </div>
  );
}
