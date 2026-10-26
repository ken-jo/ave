import { createProvider, secretKeyFor } from "../llm/provider-factory.js";
import { FallbackProvider } from "../llm/vercel/fallback-chain.js";
import type { LLMProvider, ProviderConfig } from "../llm/types.js";
import type { SettingsService } from "../../data/settings-store.js";
import {
  canUseLlmVendorWithoutApiKey,
  getLlmVendorSettings,
  activeLlmRouteModel,
} from "../../shared/llm-vendor-defaults.js";
import { marketplaceProviderPresetSecretKey } from "../../shared/marketplace-package-assets.js";
import type { AiProviderPingResult } from "../../shared/ai-provider-ping.js";
import { selectProviderRuntimeFetch } from "../llm/marketplace-provider-fetch.js";
import type { ConversationLoopDeps } from "./types.js";
import {
  MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH,
  subscriptionAcceptsModelOverride,
  type ActiveChatRuntime,
  type SubscriptionChatRuntimeSelection,
} from "../../shared/subscription-runtime.js";
import { stripSuggestedReplies } from "../suggested-replies.js";
import { t } from "../../i18n/index.js";
import { estimateTokens } from "../../shared/token-estimate.js";
import { clampBackgroundOutputTokenLimit } from "../llm/output-token-limit.js";

export const AI_PROVIDER_PING_TIMEOUT_MS = 8_000;

// Export the probe prompt so fixtures recognize the actual request without a drifting copy.
export const PROVIDER_PING_SYSTEM_PROMPT =
  "You are a connectivity probe. Reply with PONG only.";

export interface GenerateTextOptions {
  // Validate and clamp internal output limits before transport.
  outputTokenLimit?: number;
  modelOverride?: string;
}

// Native transports may need estimated local output bounds; adding an ellipsis would exceed the cap.
function truncateTextToOutputTokenLimit(value: string, tokenLimit: number): string {
  if (estimateTokens(value) <= tokenLimit) return value;
  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const candidate = codePoints.slice(0, midpoint).join("");
    if (estimateTokens(candidate) <= tokenLimit) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return codePoints.slice(0, low).join("");
}

/** Accept only trimmed, bounded model IDs without control characters; invalid IDs are never forwarded. */
export function cleanModelOverride(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  if (
    model.length === 0
    || model.length > MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(model)
  ) {
    return undefined;
  }
  return model;
}

export { subscriptionAcceptsModelOverride } from "../../shared/subscription-runtime.js";

function selectionWithModelOverride(
  selection: SubscriptionChatRuntimeSelection,
  modelOverride: string | undefined,
): SubscriptionChatRuntimeSelection {
  // Runtimes owning their default model must not receive unsupported profile selections.
  if (!subscriptionAcceptsModelOverride(selection)) return selection;
  const model = cleanModelOverride(modelOverride);
  return model ? Object.freeze({ ...selection, model }) : selection;
}

/** Match the active authentication boundary, not model equality; stale API-key transports are forbidden. */
export function providerMatchesActiveChatRuntime(
  provider: LLMProvider | null,
  activeChatRuntime: ActiveChatRuntime | undefined,
): boolean {
  if (!provider) return false;
  if (activeChatRuntime?.kind !== "subscription") {
    return provider.subscriptionRuntime === undefined;
  }
  return provider.subscriptionRuntime?.provider === activeChatRuntime.provider;
}

export function buildProvider(
  deps: ConversationLoopDeps,
  { fallbackEnabled = true }: { fallbackEnabled?: boolean } = {},
): LLMProvider | null {
    const llmSettings = deps.settingsService.get("llm");
    const activeChatRuntime = llmSettings.activeChatRuntime;
    if (activeChatRuntime?.kind === "subscription") {
      try {
        const selection = selectionWithModelOverride(activeChatRuntime, deps.modelOverride);
        // Validate model candidates against the live catalog; the caller controls parent-model fallback.
        const fallbackSelection = !fallbackEnabled || selection.model === activeChatRuntime.model
          ? undefined
          : activeChatRuntime;
        const candidate = fallbackSelection
          ? deps.subscriptionProviderFactory?.(selection, fallbackSelection) ?? null
          : deps.subscriptionProviderFactory?.(selection) ?? null;
        const marker = candidate?.subscriptionRuntime;
        if (
          !marker
          || marker.provider !== selection.provider
          || marker.model !== selection.model
        ) {
          return null;
        }
        // Subscription retries stay on the selected runtime and never consult API-key fallbacks or credentials.
        return new FallbackProvider(candidate, [], () => "");
      } catch {
        // Subscription bootstrap failure must not fall through to an earlier API-key provider.
        return null;
      }
    }
    // Removed-vendor profiles remain unconfigured until selection; stored default-vendor keys are not consent.
    if (llmSettings.retiredProvider) {
      return null;
    }
    const vendor = llmSettings.provider;
    const block = getLlmVendorSettings(llmSettings.vendors, vendor);
    const hasMarketplaceProviderPresetSelection =
      vendor === "openai-compatible" && Boolean(llmSettings.marketplaceProviderPresetId);
    const marketplaceProviderPreset = hasMarketplaceProviderPresetSelection
      ? (deps.settingsService.get("marketplace").installedProviderPresets ?? [])
        .find((preset) => preset.providerId === llmSettings.marketplaceProviderPresetId)
      : undefined;
    if (hasMarketplaceProviderPresetSelection && !marketplaceProviderPreset) {
      return null;
    }
    const apiKey = deps.settingsService.getSecret(
      marketplaceProviderPreset
        ? marketplaceProviderPresetSecretKey(marketplaceProviderPreset.providerId)
        : secretKeyFor(vendor),
    );
    const effectiveBaseUrl = marketplaceProviderPreset
      ? marketplaceProviderPreset.baseUrl
      : block.baseUrl;

    // Project-authenticated routes require a project; configured self-hosted routes may be keyless.
    const isVertex = vendor === "vertex-ai";
    const canUseWithoutApiKey = marketplaceProviderPreset
      ? marketplaceProviderPreset.requiresApiKey === false && Boolean(effectiveBaseUrl?.trim())
      : canUseLlmVendorWithoutApiKey(vendor, block);
    if (!apiKey && !isVertex && !canUseWithoutApiKey) {
      return null;
    }
    if (isVertex && !block.vertexProject && !process.env.GOOGLE_CLOUD_PROJECT && !process.env.GCLOUD_PROJECT) {
      return null;
    }

    // A credential connects the route; only a selected model configures chat.
    const effectiveModel = activeLlmRouteModel(llmSettings, deps.modelOverride);
    if (!effectiveModel) {
      return null;
    }

    const providerApiKey = apiKey ?? "";

    try {
      const createLoopProvider = (config: ProviderConfig): LLMProvider => {
        const providerFetch = selectProviderRuntimeFetch({
          vendor: config.vendor,
          baseUrl: config.baseUrl,
          providerMetadata: config.providerMetadata,
          llmFetch: deps.llmFetch,
          networkFetch: deps.networkFetch,
        });
        return createProvider({
          ...config,
          ...(providerFetch ? { fetch: providerFetch } : {}),
        });
      };

      const primary = createLoopProvider({
        vendor,
        apiKey: providerApiKey,
        // Child model overrides take precedence; absent overrides retain the configured vendor model.
        model: effectiveModel,
        ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
        ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
        ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
        ...(marketplaceProviderPreset ? { providerMetadata: marketplaceProviderPreset } : {}),
      });
      const chain = (fallbackEnabled ? llmSettings.fallbackChain : [])
        .filter((e) =>
          e.provider &&
          e.model &&
          !(marketplaceProviderPreset && e.provider === "openai-compatible")
        )
        .map((entry) => {
          const fallbackBlock = getLlmVendorSettings(
            llmSettings.vendors,
            entry.provider,
          );
          return {
            ...entry,
            ...(fallbackBlock?.baseUrl ? { baseUrl: fallbackBlock.baseUrl } : {}),
            ...(fallbackBlock?.vertexProject ? { vertexProject: fallbackBlock.vertexProject } : {}),
            ...(fallbackBlock?.vertexLocation ? { vertexLocation: fallbackBlock.vertexLocation } : {}),
          };
        });
      return new FallbackProvider(
        primary,
        chain,
        (v) => deps.settingsService.getSecret(secretKeyFor(v)) ?? "",
        createLoopProvider,
      );
    } catch {
      return null;
    }
}

export function resolveVendorName(provider: LLMProvider | null): string {
    return provider?.subscriptionRuntime
      ? `subscription:${provider.subscriptionRuntime.provider}`
      : provider?.vendor ?? "none";
}

export async function generateText(
  provider: LLMProvider | null,
  settingsService: SettingsService,
  prompt: string,
  systemPrompt = t("be_conversationLoop.generateTextSystemPrompt"),
  abortSignal?: AbortSignal,
  options?: GenerateTextOptions,
): Promise<string> {
    const llm = settingsService.get("llm");
    const model = provider?.subscriptionRuntime
      ? provider.subscriptionRuntime.model ?? "default"
      : activeLlmRouteModel(llm, cleanModelOverride(options?.modelOverride));
    if (!provider || !model || !providerMatchesActiveChatRuntime(provider, llm.activeChatRuntime)) {
      throw new Error("LLM provider not configured");
    }
    if (abortSignal?.aborted) throw new Error("LLM generation aborted");
    // This background caller owns its ceiling; applying it in shared transport would also clamp chat.
    const outputTokenLimit = clampBackgroundOutputTokenLimit(options?.outputTokenLimit);
    const outputLimitController = outputTokenLimit === undefined
      ? undefined
      : new AbortController();
    const providerAbortSignal = outputLimitController
      ? abortSignal
        ? AbortSignal.any([abortSignal, outputLimitController.signal])
        : outputLimitController.signal
      : abortSignal;
    let outputLimitReached = false;
    let text = "";
    try {
    for await (const ev of provider.streamTurn({
      systemPrompt,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      model,
      ...(outputTokenLimit === undefined ? {} : { outputTokenLimit }),
      abortSignal: providerAbortSignal,
    })) {
      if (abortSignal?.aborted) throw new Error("LLM generation aborted");
      if (ev.type === "text_delta" && ev.text) {
        const nextText = text + ev.text;
        if (outputTokenLimit === undefined) {
          text = nextText;
        } else {
          text = truncateTextToOutputTokenLimit(nextText, outputTokenLimit);
          if (
            text.length < nextText.length
            || estimateTokens(text) >= outputTokenLimit
          ) {
            outputLimitReached = true;
            outputLimitController?.abort();
            break;
          }
        }
      }
      if (ev.type === "message_complete") break;
      if (ev.type === "error") throw new Error(`LLM stream error: ${ev.error}`);
    }
    } catch (error) {
      if (!outputLimitReached || abortSignal?.aborted) throw error;
    }
    if (abortSignal?.aborted) throw new Error("LLM generation aborted");
    // Strip reply markup because plugins and routines consume the returned text verbatim.
    return stripSuggestedReplies(text).trim();
}

export async function pingProvider(
  provider: LLMProvider | null,
  settingsService: SettingsService,
  timeoutMs = AI_PROVIDER_PING_TIMEOUT_MS,
): Promise<AiProviderPingResult> {
    const llm = settingsService.get("llm");
    const selectedSubscription =
      llm.activeChatRuntime?.kind === "subscription"
        ? llm.activeChatRuntime
        : undefined;
    const subscription = provider?.subscriptionRuntime ?? selectedSubscription;
    const vendor = subscription
      ? `subscription:${subscription.provider}`
      : llm.provider;
    const model = subscription
      ? subscription.model || "default"
      : activeLlmRouteModel(llm);
    if (!provider || !model || !providerMatchesActiveChatRuntime(provider, llm.activeChatRuntime)) {
      return {
        configured: false,
        online: false,
        vendor,
        ...(model ? { model } : {}),
        error: "not-configured",
      };
    }

    const startedAt = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      for await (const ev of provider.streamTurn({
        systemPrompt: PROVIDER_PING_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "ping" }],
        tools: [],
        model,
        abortSignal: ctrl.signal,
      })) {
        if (ev.type === "error") {
          return {
            configured: true,
            online: false,
            vendor,
            model,
            error: ev.error,
            latencyMs: Date.now() - startedAt,
          };
        }
        if (ev.type === "message_complete") {
          return {
            configured: true,
            online: true,
            vendor,
            model,
            latencyMs: Date.now() - startedAt,
          };
        }
      }
      return {
        configured: true,
        online: false,
        vendor,
        model,
        error: "stream-ended",
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        configured: true,
        online: false,
        vendor,
        model,
        error: ctrl.signal.aborted ? "timeout" : (err as Error).message,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
}
