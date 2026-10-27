import { customProviderWire } from "../../shared/custom-provider.js";
import type { SettingsService } from "../../data/settings-store.js";
import type {
  LlmModelListCache,
  LlmModelListEntry,
  LlmModelListPricing,
  LlmModelListRequest,
  LlmModelListResult,
} from "../../shared/llm-model-list.js";
import {
  getLlmVendorSettings,
  isLLMVendor,
  isSelfHostedTrustedNetworkVendor,
  type LLMVendor,
  type LLMVendorSettingsMap,
} from "../../shared/llm-vendor-defaults.js";
import {
  isMarketplaceProviderPresetId,
  marketplaceProviderPresetSecretKey,
  modelDiscoveryPolicyAllowsFetch,
  type MarketplaceInstalledProviderPreset,
  type MarketplaceProviderModelDiscoveryPolicy,
} from "../../shared/marketplace-package-assets.js";
import {
  ensurePublicHttpUrl,
  fetchPublicHttpResponse,
  NetworkGuardError,
} from "../../core/network-guard.js";
import {
  configuredModelProviderLoopbackAccess,
  configuredModelProviderNetworkAccess,
  type ModelProviderNetworkAccess,
} from "./marketplace-provider-fetch.js";
import { secretKeyFor } from "./provider-factory.js";
import { trimmedString } from "../../shared/trimmed-string.js";
import { errorMessageWithCauseCode } from "../../shared/error-message.js";
import { llmModelListCacheKey, MAX_CACHED_LLM_MODEL_IDS } from "../../shared/llm-model-list.js";
import type { LlmRouteCatalogAddress } from "../../shared/context-budget.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("ave");

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_IDS = 2_000;
const MAX_MODEL_ID_LENGTH = 256;

const STANDARD_MODEL_LIST_BASE_URLS: Partial<Record<LLMVendor, string>> = {
  openai: "https://api.openai.com/v1",
  claude: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

/** A bounded paginated listing remains incomplete when its page cap is reached. */
const MAX_MODEL_LIST_PAGES = 10;
const VENDOR_MODEL_LIST_PAGE_SIZE = 1_000;

function modelListAuthHeaders(vendor: LLMVendor, apiKey: string): Record<string, string> {
  if (!apiKey) return {};
  if (vendor === "claude") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  if (vendor === "gemini") return { "x-goog-api-key": apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

function modelListPageUrl(vendor: LLMVendor, endpoint: string, cursor: string | null): string {
  if (vendor !== "claude" && vendor !== "gemini") return endpoint;
  const url = new URL(endpoint);
  if (vendor === "claude") {
    url.searchParams.set("limit", String(VENDOR_MODEL_LIST_PAGE_SIZE));
    if (cursor !== null) url.searchParams.set("after_id", cursor);
  } else {
    url.searchParams.set("pageSize", String(VENDOR_MODEL_LIST_PAGE_SIZE));
    if (cursor !== null) url.searchParams.set("pageToken", cursor);
  }
  return url.toString();
}

/** A continuation without a usable cursor is a malformed listing. */
function modelListNextCursor(vendor: LLMVendor, payload: unknown): string | null {
  if (vendor !== "claude" && vendor !== "gemini") return null;
  const record = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  if (vendor === "claude") {
    if (record.has_more !== true) return null;
    if (typeof record.last_id === "string" && record.last_id.trim() !== "") return record.last_id;
    throw new ModelListError("invalid-model-list-response", "model list says has_more without a last_id");
  }
  const token = record.nextPageToken;
  return typeof token === "string" && token.trim() !== "" ? token : null;
}

function modelListPageRows(vendor: LLMVendor, payload: unknown): unknown[] {
  const rows = modelListRows(payload);
  if (vendor === "claude") {
    return rows.filter((row) => {
      const lifecycle = optionalRecord(row)?.lifecycle;
      return lifecycle !== "retired";
    });
  }
  if (vendor !== "gemini") return rows;
  const chatRows: unknown[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const methods = record.supportedGenerationMethods;
    if (!Array.isArray(methods) || !methods.includes("generateContent")) continue;
    if (typeof record.name !== "string") continue;
    chatRows.push({
      ...record,
      id: record.name.replace(/^models\//u, ""),
      context_length: record.inputTokenLimit,
      max_output_tokens: record.outputTokenLimit,
    });
  }
  return chatRows;
}

export type LlmModelListFetchOptions = {
  // The caller must supply the host proxy and trust-store transport; this engine module cannot import it.
  fetchImpl: typeof fetch;
  fetchPublicHttpResponseImpl?: typeof fetchPublicHttpResponse;
  timeoutMs?: number;
  maxResponseBytes?: number;
  ensurePublicUrl?: typeof ensurePublicHttpUrl;
};

class ModelListError extends Error {
  constructor(
    readonly code: Exclude<LlmModelListResult, { ok: true }>["error"],
    message: string,
  ) {
    super(message);
    this.name = "ModelListError";
  }
}

type ResolvedModelListBaseUrl = {
  baseUrl: string | null;
  mayUseStoredCredential: boolean;
  isDraftEndpoint: boolean;
};

// Preset endpoints belong to their registry, not the unrelated generic custom-provider block.
function configuredModelListBaseUrl(
  settingsService: SettingsService,
  vendor: LLMVendor,
  credentialScope?: string,
): string | null {
  if (vendor === "openai-compatible" && isMarketplaceProviderPresetId(credentialScope)) {
    const preset = installedProviderPresetForScope(settingsService, credentialScope);
    return preset?.baseUrl.trim() || null;
  }
  return vendorModelListBaseUrl(settingsService.get("llm").vendors, vendor);
}

type ModelListVendorBlocks = Readonly<Partial<Record<LLMVendor, { readonly baseUrl?: string }>>>;

// Stored blank baseUrl overrides the vendor default and falls through to the standard catalog address.
function vendorModelListBaseUrl(vendors: ModelListVendorBlocks | undefined, vendor: LLMVendor): string | null {
  const block = getLlmVendorSettings(vendors as LLMVendorSettingsMap | undefined, vendor);
  return block.baseUrl?.trim() || STANDARD_MODEL_LIST_BASE_URLS[vendor] || null;
}

function sameModelListEndpoint(a: string, b: string): boolean {
  try {
    return modelListEndpointFromBaseUrl(a) === modelListEndpointFromBaseUrl(b);
  } catch {
    return false;
  }
}

/** Compare against the same saved endpoint resolution used by dispatch, including blank overrides. */
export function isDefaultModelListEndpoint(
  vendors: ModelListVendorBlocks | undefined,
  vendor: LLMVendor,
  endpoint: string,
): boolean {
  const base = vendorModelListBaseUrl(vendors, vendor);
  return base ? sameModelListEndpoint(endpoint, base) : false;
}

/** Read only cached IDs from a handshake matching the route endpoint. */
export function cachedLiveModelIds(
  llm: {
    readonly vendors?: ModelListVendorBlocks;
    readonly modelListCache?: LlmModelListCache;
  },
  vendor: LLMVendor,
): string[] {
  const ids = new Set<string>();
  for (const entry of Object.values(llm.modelListCache ?? {})) {
    if (entry.vendor !== vendor) continue;
    if (!isDefaultModelListEndpoint(llm.vendors, vendor, entry.endpoint)) continue;
    for (const model of entry.models) ids.add(model);
  }
  return [...ids];
}

function resolveModelListBaseUrl(
  settingsService: SettingsService,
  vendor: LLMVendor,
  requestBaseUrl: unknown,
  credentialScope?: string,
): ResolvedModelListBaseUrl {
  const configuredBaseUrl = configuredModelListBaseUrl(settingsService, vendor, credentialScope);
  if (typeof requestBaseUrl === "string" && requestBaseUrl.trim()) {
    const baseUrl = requestBaseUrl.trim();
    return {
      baseUrl,
      mayUseStoredCredential:
        configuredBaseUrl !== null &&
        sameModelListEndpoint(baseUrl, configuredBaseUrl),
      isDraftEndpoint:
        configuredBaseUrl === null ||
        !sameModelListEndpoint(baseUrl, configuredBaseUrl),
    };
  }

  return {
    baseUrl: configuredBaseUrl,
    mayUseStoredCredential: configuredBaseUrl !== null,
    isDraftEndpoint: false,
  };
}

function storedCredentialForModelList(
  settingsService: SettingsService,
  vendor: LLMVendor,
  resolved: ResolvedModelListBaseUrl,
  credentialScope?: string,
): string {
  if (!resolved.mayUseStoredCredential) return "";
  const requestedPresetId = vendor === "openai-compatible" && isMarketplaceProviderPresetId(credentialScope)
    ? credentialScope
    : undefined;
  if (requestedPresetId) {
    const installedPreset = settingsService
      .get("marketplace")
      .installedProviderPresets ?? [];
    const requestedPreset = installedPreset
      .find((preset) => preset.providerId === requestedPresetId);
    if (requestedPreset) {
      if (!resolved.baseUrl || !sameModelListEndpoint(resolved.baseUrl, requestedPreset.baseUrl)) {
        return "";
      }
      return settingsService.getSecret(
        marketplaceProviderPresetSecretKey(requestedPreset.providerId),
      ) ?? "";
    }
    return "";
  }
  const llm = settingsService.get("llm");
  if (
    vendor === "openai-compatible" &&
    llm.provider === "openai-compatible" &&
    llm.marketplaceProviderPresetId
  ) {
    const installedPreset = settingsService
      .get("marketplace")
      .installedProviderPresets ?? [];
    const activePreset = installedPreset
      .find((preset) => preset.providerId === llm.marketplaceProviderPresetId);
    if (activePreset) {
      if (!resolved.baseUrl || !sameModelListEndpoint(resolved.baseUrl, activePreset.baseUrl)) {
        return "";
      }
      return settingsService.getSecret(
        marketplaceProviderPresetSecretKey(activePreset.providerId),
      ) ?? "";
    }
  }
  return settingsService.getSecret(secretKeyFor(vendor)) ?? "";
}

function installedProviderPresetForScope(
  settingsService: SettingsService,
  providerId: string,
): MarketplaceInstalledProviderPreset | undefined {
  return (settingsService.get("marketplace").installedProviderPresets ?? [])
    .find((preset) => preset.providerId === providerId);
}

function validateModelListCredentialScope(
  settingsService: SettingsService,
  vendor: LLMVendor,
  resolved: ResolvedModelListBaseUrl,
  credentialScope?: string,
): LlmModelListResult | null {
  if (vendor !== "openai-compatible" || !credentialScope) return null;
  if (!isMarketplaceProviderPresetId(credentialScope)) {
    return {
      ok: false,
      error: "provider-not-installed",
      message: "Install this marketplace provider before syncing its models.",
    };
  }
  const installedPreset = installedProviderPresetForScope(settingsService, credentialScope);
  if (!installedPreset) {
    return {
      ok: false,
      error: "provider-not-installed",
      message: "Install this marketplace provider before syncing its models.",
    };
  }
  const llm = settingsService.get("llm");
  if (
    llm.provider !== "openai-compatible" ||
    llm.marketplaceProviderPresetId !== credentialScope
  ) {
    return {
      ok: false,
      error: "provider-not-installed",
      message: "Only the active marketplace provider can sync models with its stored credential.",
    };
  }
  if (!resolved.baseUrl || !sameModelListEndpoint(resolved.baseUrl, installedPreset.baseUrl)) {
    return {
      ok: false,
      error: "invalid-model-list-endpoint",
      message: "Model list endpoint must match the active marketplace provider preset.",
    };
  }
  return null;
}

function isSavedSelfHostedModelListEndpoint(
  settingsService: SettingsService,
  vendor: LLMVendor,
  resolved: ResolvedModelListBaseUrl,
  credentialScope?: string,
): boolean {
  if (
    resolved.isDraftEndpoint ||
    !resolved.baseUrl ||
    !isSelfHostedTrustedNetworkVendor(vendor)
  ) {
    return false;
  }
  if (vendor !== "openai-compatible") return true;
  if (isMarketplaceProviderPresetId(credentialScope)) return false;
  const llm = settingsService.get("llm");
  return !(
    llm.provider === "openai-compatible" &&
    Boolean(llm.marketplaceProviderPresetId)
  );
}

function keylessMarketplaceModelListNetworkAccess(
  settingsService: SettingsService,
  vendor: LLMVendor,
  resolved: ResolvedModelListBaseUrl,
  apiKey: string,
  credentialScope?: string,
): ModelProviderNetworkAccess {
  if (apiKey || vendor !== "openai-compatible" || !resolved.baseUrl) {
    return { allowPrivateNetworks: false, allowLoopback: false, allowCarrierGradeNat: false };
  }
  const llm = settingsService.get("llm");
  const presetId = isMarketplaceProviderPresetId(credentialScope)
    ? credentialScope
    : llm.provider === "openai-compatible"
      ? llm.marketplaceProviderPresetId
      : undefined;
  if (!presetId) return { allowPrivateNetworks: false, allowLoopback: false, allowCarrierGradeNat: false };
  const preset = installedProviderPresetForScope(settingsService, presetId);
  if (
    !preset ||
    preset.requiresApiKey !== false ||
    !sameModelListEndpoint(resolved.baseUrl, preset.baseUrl)
  ) {
    return { allowPrivateNetworks: false, allowLoopback: false, allowCarrierGradeNat: false };
  }
  return configuredModelProviderLoopbackAccess(resolved.baseUrl);
}

export function modelListEndpointFromBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
    url = new URL(`${normalizedBase}/`);
  } catch {
    throw new ModelListError(
      "invalid-model-list-endpoint",
      "baseUrl is not a valid URL",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ModelListError(
      "invalid-model-list-endpoint",
      "baseUrl must use http or https",
    );
  }
  if (url.username || url.password) {
    throw new ModelListError(
      "invalid-model-list-endpoint",
      "baseUrl must not include embedded credentials",
    );
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/models") ? pathname : `${pathname}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isValidModelId(value: string): boolean {
  const id = value.trim();
  return (
    id.length > 0 &&
    id.length <= MAX_MODEL_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(id)
  );
}

function candidateId(value: unknown): string | null {
  if (typeof value === "string") {
    const id = value.trim();
    return isValidModelId(id) ? id : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "name", "model"]) {
    const raw = record[key];
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (isValidModelId(id)) return id;
  }
  return null;
}

function modelListRows(payload: unknown): unknown[] {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const rows = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(record?.models)
      ? record.models
      : Array.isArray(payload)
        ? payload
        : null;

  if (!rows) {
    throw new ModelListError(
      "invalid-model-list-response",
      "model list response must contain data[] or models[]",
    );
  }
  return rows;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map(trimmedString)
    .filter((entry): entry is string => Boolean(entry));
  return entries.length > 0 ? [...new Set(entries)] : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pricingValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return String(value);
  }
  return trimmedString(value);
}

function pricingFromRecord(value: unknown): LlmModelListPricing | undefined {
  const record = optionalRecord(value);
  if (!record) return undefined;
  const pricing: LlmModelListPricing = {};
  const fields: Array<[keyof LlmModelListPricing, string[]]> = [
    ["prompt", ["prompt", "input"]],
    ["completion", ["completion", "output"]],
    ["request", ["request"]],
    ["image", ["image"]],
    ["webSearch", ["web_search", "webSearch"]],
    ["internalReasoning", ["internal_reasoning", "internalReasoning"]],
    ["inputCacheRead", ["input_cache_read", "inputCacheRead"]],
    ["inputCacheWrite", ["input_cache_write", "inputCacheWrite"]],
  ];
  for (const [target, keys] of fields) {
    for (const key of keys) {
      const value = pricingValue(record[key]);
      if (value !== undefined) {
        pricing[target] = value;
        break;
      }
    }
  }
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

function isZeroPrice(value: string | undefined): boolean {
  if (value === undefined) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}

function hasFreePricing(pricing: LlmModelListPricing | undefined): boolean {
  if (!pricing) return false;
  return isZeroPrice(pricing.prompt) && isZeroPrice(pricing.completion);
}

function modelEntryTags(
  id: string,
  record: Record<string, unknown> | undefined,
  pricing: LlmModelListPricing | undefined,
): LlmModelListEntry["tags"] | undefined {
  const lowerId = id.toLocaleLowerCase();
  const provider = trimmedString(record?.provider)?.toLocaleLowerCase()
    ?? trimmedString(record?.owned_by)?.toLocaleLowerCase()
    ?? trimmedString(optionalRecord(record?.top_provider)?.name)?.toLocaleLowerCase()
    ?? "";
  const free = lowerId === "openrouter/free" || lowerId.endsWith(":free") || hasFreePricing(pricing);
  const router = lowerId === "openrouter/auto"
    || lowerId === "openrouter/free"
    || lowerId.startsWith("openrouter/")
    || provider.includes("router")
    || Boolean(record?.route)
    || Boolean(record?.routing);
  const local = lowerId.startsWith("ollama/")
    || lowerId.startsWith("lmstudio/")
    || lowerId.startsWith("lm-studio/")
    || provider.includes("ollama")
    || provider.includes("lm studio");
  const tags: LlmModelListEntry["tags"] = {};
  if (free) tags.free = true;
  if (router) tags.router = true;
  if (local) tags.local = true;
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function modelEntryFromRow(row: unknown): LlmModelListEntry | null {
  const id = candidateId(row);
  if (!id) return null;
  const record = optionalRecord(row);
  if (!record) return { id };
  const architecture = optionalRecord(record.architecture);
  const topProvider = optionalRecord(record.top_provider);
  const limits = optionalRecord(record.limits);
  const pricing = pricingFromRecord(record.pricing);
  const name = trimmedString(record.display_name) ?? trimmedString(record.displayName) ?? trimmedString(record.name);
  const provider = trimmedString(record.provider) ?? trimmedString(record.publisher);
  const ownedBy = trimmedString(record.owned_by);
  const description = trimmedString(record.description) ?? trimmedString(record.summary);
  // Accept catalog prompt-limit aliases; absent limits defer to the next source.
  const contextLength = optionalNumber(record.context_length)
    ?? optionalNumber(record.contextLength)
    ?? optionalNumber(topProvider?.context_length)
    ?? optionalNumber(limits?.max_input_tokens)
    ?? optionalNumber(record.max_input_tokens)
    ?? optionalNumber(record.max_model_len);
  const maxOutputTokens = optionalNumber(record.max_tokens)
    ?? optionalNumber(record.max_output_tokens)
    ?? optionalNumber(limits?.max_output_tokens);
  const inputModalities = optionalStringArray(architecture?.input_modalities)
    ?? optionalStringArray(record.supported_input_modalities);
  const outputModalities = optionalStringArray(architecture?.output_modalities)
    ?? optionalStringArray(record.supported_output_modalities);
  const supportedParameters = optionalStringArray(record.supported_parameters);
  const entry: LlmModelListEntry = {
    id,
    ...(name && name !== id ? { name } : {}),
    ...(provider ? { provider } : {}),
    ...(ownedBy ? { ownedBy } : {}),
    ...(description ? { description } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
    ...(supportedParameters ? { supportedParameters } : {}),
    ...(pricing ? { pricing } : {}),
  };
  const tags = modelEntryTags(id, record, pricing);
  if (tags) entry.tags = tags;
  return entry;
}

/** Paginated or cache-truncated listings cannot prove a model retired. */
export function modelListPayloadIsComplete(payload: unknown, modelCount: number): boolean {
  if (modelCount >= MAX_CACHED_LLM_MODEL_IDS) return false;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return true;
  const record = payload as Record<string, unknown>;
  if (record.has_more === true) return false;
  return !["next_page_token", "nextPageToken"].some((key) => {
    const token = record[key];
    return typeof token === "string" ? token.trim() !== "" : token !== undefined && token !== null;
  });
}

export function parseStandardModelListEntries(payload: unknown): LlmModelListEntry[] {
  const rows = modelListRows(payload);

  const entries: LlmModelListEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const entry = modelEntryFromRow(row);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
    if (entries.length >= MAX_MODEL_IDS) break;
  }

  if (entries.length === 0) {
    throw new ModelListError(
      "invalid-model-list-response",
      "model list response did not contain model ids",
    );
  }
  return entries;
}

export function parseStandardModelListResponse(payload: unknown): string[] {
  const ids = parseStandardModelListEntries(payload).map((entry) => entry.id);
  return ids;
}

async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new ModelListError(
        "model-list-response-too-large",
        "model list response is too large",
      );
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new ModelListError(
        "model-list-response-too-large",
        "model list response is too large",
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ModelListError(
          "model-list-response-too-large",
          "model list response is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export async function listLlmModelsFromSettings(
  settingsService: SettingsService,
  request: LlmModelListRequest,
  options: LlmModelListFetchOptions,
): Promise<LlmModelListResult> {
  if (!isLLMVendor(request.vendor)) {
    return {
      ok: false,
      error: "invalid-provider",
      message: "Unknown LLM provider.",
    };
  }
  if (!modelDiscoveryPolicyAllowsFetch(request.modelDiscoveryPolicy)) {
    return {
      ok: false,
      error: "model-list-not-supported",
      message: "This provider uses a static or manually configured model list.",
    };
  }
  const resolved = resolveModelListBaseUrl(
    settingsService,
    request.vendor,
    request.baseUrl,
    request.credentialScope,
  );
  // Report credential-scope refusal before unresolved endpoint errors so the actual boundary is clear.
  const credentialScopeError = validateModelListCredentialScope(
    settingsService,
    request.vendor,
    resolved,
    request.credentialScope,
  );
  if (credentialScopeError) return credentialScopeError;
  if (!resolved.baseUrl) {
    return {
      ok: false,
      error: "model-list-not-supported",
      message: "This provider does not expose a standard model list endpoint.",
    };
  }

  let endpoint: string;
  try {
    endpoint = modelListEndpointFromBaseUrl(resolved.baseUrl);
  } catch (err) {
    if (err instanceof ModelListError) {
      return { ok: false, error: err.code, message: err.message };
    }
    throw err;
  }

  const apiKey = storedCredentialForModelList(
    settingsService,
    request.vendor,
    resolved,
    request.credentialScope,
  );
  // Private and credentialed HTTP trust applies only to saved self-hosted routes, never drafts or presets.
  const isSavedSelfHostedEndpoint = isSavedSelfHostedModelListEndpoint(
    settingsService,
    request.vendor,
    resolved,
    request.credentialScope,
  );
  const networkAccess = isSavedSelfHostedEndpoint && resolved.baseUrl
    ? configuredModelProviderNetworkAccess(resolved.baseUrl)
    : keylessMarketplaceModelListNetworkAccess(
      settingsService,
      request.vendor,
      resolved,
      apiKey,
      request.credentialScope,
    );
  if (apiKey && endpoint.startsWith("http:") && !isSavedSelfHostedEndpoint) {
    return {
      ok: false,
      error: "invalid-model-list-endpoint",
      endpoint,
      message: "Credentialed model list endpoints must use https.",
    };
  }
  const wire = request.vendor === "openai-compatible" && !request.credentialScope
    ? customProviderWire(request.wire ?? (resolved.isDraftEndpoint
      ? undefined
      : getLlmVendorSettings(settingsService.get("llm").vendors, "openai-compatible").wire))
    : undefined;
  const listingVendor = wire === "anthropic-messages" ? "claude"
    : wire === "google-gemini" ? "gemini" : request.vendor;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...modelListAuthHeaders(listingVendor, apiKey),
  };

  let requestEndpoint = endpoint;
  try {
    // DNS-validate configured endpoints; the request wrapper must also guard redirects.
    requestEndpoint = (await (options.ensurePublicUrl ?? ensurePublicHttpUrl)(
      endpoint,
      {
        ...networkAccess,
      },
    )).toString();
    const rows: unknown[] = [];
    let cursor: string | null = null;
    let lastPayload: unknown;
    for (let page = 0; page < MAX_MODEL_LIST_PAGES; page += 1) {
      const pageUrl = modelListPageUrl(listingVendor, requestEndpoint, cursor);
      const response = await (
        options.fetchPublicHttpResponseImpl ?? fetchPublicHttpResponse
      )(pageUrl, {
        method: "GET",
        headers,
        fetchImpl: options.fetchImpl,
        maxRedirects: 0,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...networkAccess,
      });
      if (!response.ok) {
        return {
          ok: false,
          error: "model-list-fetch-failed",
          endpoint: requestEndpoint,
          status: response.status,
          message: `Model list request failed with HTTP ${response.status}.`,
        };
      }

      const text = await readResponseTextLimited(
        response,
        options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      );
      try {
        lastPayload = JSON.parse(text) as unknown;
      } catch {
        throw new ModelListError(
          "invalid-model-list-response",
          "model list response must be valid JSON",
        );
      }
      rows.push(...modelListPageRows(listingVendor, lastPayload));
      cursor = modelListNextCursor(listingVendor, lastPayload);
      if (cursor === null || rows.length >= MAX_MODEL_IDS) break;
    }
    const modelEntries = parseStandardModelListEntries({ data: rows });
    // Page or ID caps leave a listing incomplete and cannot prove retirement.
    const complete = cursor === null && modelListPayloadIsComplete(lastPayload, modelEntries.length);
    return {
      ok: true,
      vendor: request.vendor,
      endpoint: requestEndpoint,
      models: modelEntries.map((entry) => entry.id),
      modelEntries,
      ...(complete ? { complete: true as const } : {}),
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof ModelListError) {
      return { ok: false, error: err.code, endpoint, message: err.message };
    }
    if (err instanceof NetworkGuardError) {
      return {
        ok: false,
        error: "invalid-model-list-endpoint",
        endpoint,
        message: err.message,
      };
    }
    return {
      ok: false,
      error: "model-list-fetch-failed",
      endpoint: requestEndpoint,
      message:
        err instanceof Error && err.name === "AbortError"
          ? "Model list request timed out."
          : errorMessageWithCauseCode(err),
    };
  }
}

// Cache reported capacity for six hours to limit probes while noticing same-day redeploys.
export const MODEL_LIST_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;

const modelListProbeAttempted = new Set<string>();

export function resetModelListProbeStateForTesting(): void {
  modelListProbeAttempted.clear();
}

function modelListEntryIsFresh(
  entry: { fetchedAt?: string } | undefined,
  now: number,
): boolean {
  if (!entry?.fetchedAt) return false;
  const fetchedAt = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  return now - fetchedAt < MODEL_LIST_REFRESH_TTL_MS;
}

/** Refresh capacity from the active endpoint without requiring a settings window.
 * Unreachable endpoints retain existing knowledge and never throw from this probe. */
export async function refreshRouteModelList(params: {
  settingsService: SettingsService;
  fetchOptions: LlmModelListFetchOptions;
  address: LlmRouteCatalogAddress;
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
  now?: number;
}): Promise<boolean> {
  const { settingsService, fetchOptions, address } = params;
  // Project/location selects this endpoint; the standard reader would resolve an unrelated baseUrl.
  if (address.vendor === "vertex-ai") return false;
  const now = params.now ?? Date.now();
  // Static and manual presets forbid probing; check before consuming the route probe slot.
  if (!modelDiscoveryPolicyAllowsFetch(params.modelDiscoveryPolicy)) return false;
  const key = llmModelListCacheKey(address.vendor, address.baseUrl, address.credentialScope);
  if (modelListProbeAttempted.has(key)) return false;
  if (modelListEntryIsFresh(settingsService.get("llm").modelListCache?.[key], now)) return false;
  modelListProbeAttempted.add(key);
  log.info(
    `model list: asking ${address.vendor} what it serves — no usable catalogue entry for this route`,
  );
  const result = await listLlmModelsFromSettings(
    settingsService,
    {
      vendor: address.vendor,
      ...(address.baseUrl ? { baseUrl: address.baseUrl } : {}),
      ...(address.credentialScope ? { credentialScope: address.credentialScope } : {}),
      ...(params.modelDiscoveryPolicy ? { modelDiscoveryPolicy: params.modelDiscoveryPolicy } : {}),
    },
    fetchOptions,
  );
  if (!result.ok) {
    log.info(`model list: ${address.vendor} did not answer (${result.error})`);
    return false;
  }
  // Re-read after network I/O so a shallow patch cannot erase concurrent cache updates.
  const cache = settingsService.get("llm").modelListCache ?? {};
  await settingsService.patch({
    llm: {
      modelListCache: {
        ...cache,
        [key]: {
          vendor: result.vendor,
          ...(address.baseUrl ? { baseUrl: address.baseUrl } : {}),
          ...(address.credentialScope ? { credentialScope: address.credentialScope } : {}),
          endpoint: result.endpoint,
          models: result.models,
          ...(result.modelEntries ? { modelEntries: result.modelEntries } : {}),
          ...(result.complete ? { complete: true } : {}),
          fetchedAt: result.fetchedAt,
        },
      },
    },
  });
  return true;
}
