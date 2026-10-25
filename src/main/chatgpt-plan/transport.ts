import { createVercelTransport } from "../../engine/llm/provider-factory.js";
import type {
  LLMProvider,
  StreamEvent,
  StreamTurnParams,
} from "../../engine/llm/types.js";
import { t } from "../../i18n/index.js";
import { classifyChatGptPlanError } from "../../shared/chatgpt-plan.js";
import {
  normalizeSubscriptionUsageTelemetry,
  type SubscriptionChatRuntimeSelection,
} from "../../shared/subscription-runtime.js";
import { CHATGPT_PLAN_API_BASE_URL } from "./endpoints.js";
import {
  CHATGPT_PLAN_SDK_CREDENTIAL_PLACEHOLDER,
  createChatGptPlanResponsesFetch,
  type ChatGptPlanResponseFailure,
} from "./responses-fetch.js";
import type { ChatGptPlanRuntime } from "./runtime.js";

type ErrorStreamEvent = Extract<StreamEvent, { type: "error" }>;
type CreateTransport = (config: Parameters<typeof createVercelTransport>[0]) => Pick<LLMProvider, "streamTurn">;

/** The renderer-safe text for each plan-usage outcome; the request id stays in diagnostics. */
const FAILURE_MESSAGE_KEYS = Object.freeze({
  "chatgpt-plan-not-eligible": "subscriptionProvidersSection.chatgptPlanErrorNotEligible",
  "chatgpt-plan-usage-limit": "subscriptionProvidersSection.chatgptPlanErrorUsageLimit",
  "chatgpt-plan-temporarily-unavailable": "subscriptionProvidersSection.chatgptPlanErrorTemporarilyUnavailable",
  "chatgpt-plan-unsupported-capability": "subscriptionProvidersSection.chatgptPlanErrorUnsupportedCapability",
  "chatgpt-plan-permission-denied": "subscriptionProvidersSection.chatgptPlanErrorPermissionDenied",
  "chatgpt-plan-reconnect-required": "subscriptionProvidersSection.chatgptPlanErrorReconnectRequired",
  "chatgpt-plan-model-unavailable": "subscriptionProvidersSection.chatgptPlanErrorModelUnavailable",
  "chatgpt-plan-request-failed": "subscriptionProvidersSection.chatgptPlanErrorRequestFailed",
} as const);

function failureEvent(failure: ChatGptPlanResponseFailure | undefined, fallback: ErrorStreamEvent): ErrorStreamEvent {
  if (!failure) return fallback;
  const classified = classifyChatGptPlanError(failure);
  return {
    type: "error",
    error: t(FAILURE_MESSAGE_KEYS[classified.code]),
    classification: classified.code,
    providerError: {
      origin: "provider",
      statusCode: failure.status,
      ...(failure.code ? { providerCode: failure.code } : {}),
      isRetryable: classified.retryable,
      urlHost: "api.openai.com",
      urlPath: "/v1/responses",
      messagePreview: [classified.code, failure.code, failure.param, failure.requestId].filter(Boolean).join(" "),
    },
  };
}

function unavailableEvent(code: keyof typeof FAILURE_MESSAGE_KEYS): ErrorStreamEvent {
  return {
    type: "error",
    error: t(FAILURE_MESSAGE_KEYS[code]),
    classification: code,
    providerError: { origin: "unknown", providerCode: code, isRetryable: false, messagePreview: code },
  };
}

/**
 * Inference over ChatGPT plan usage: the shared Vercel Responses wire, pinned
 * to Responses, with the session's token swapped in per request by the plan
 * fetch. Provider usage leaves as non-billable subscription telemetry, never
 * as API-key `usage`, and nothing here falls back to an API key.
 */
export class ChatGptPlanTransport implements Pick<LLMProvider, "streamTurn" | "listSubscriptionModels"> {
  private readonly selection: SubscriptionChatRuntimeSelection & { provider: "chatgpt-plan" };

  constructor(
    selection: SubscriptionChatRuntimeSelection,
    private readonly runtime: () => Promise<ChatGptPlanRuntime>,
    private readonly createTransport: CreateTransport = createVercelTransport,
  ) {
    if (selection.provider !== "chatgpt-plan") throw new Error("invalid ChatGPT plan selection");
    this.selection = Object.freeze({ ...selection, provider: "chatgpt-plan" });
  }

  async listSubscriptionModels(): Promise<readonly string[]> {
    const runtime = await this.runtime();
    const catalog = await runtime.listModels();
    if (!catalog.status.capabilities.chat) throw new Error("subscription-chat-unavailable");
    return catalog.models.map((model) => model.id);
  }

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    const model = this.selection.model;
    // Plan usage has no runtime default model; a selection without one is not configured.
    if (!model) {
      yield unavailableEvent("chatgpt-plan-model-unavailable");
      return;
    }
    let runtime: ChatGptPlanRuntime;
    try {
      runtime = await this.runtime();
    } catch {
      yield unavailableEvent("chatgpt-plan-reconnect-required");
      return;
    }
    let lastFailure: ChatGptPlanResponseFailure | undefined;
    let tokenUnavailable = false;
    const planFetch = createChatGptPlanResponsesFetch({
      fetch: runtime.fetch,
      accessToken: async () => {
        try {
          return await runtime.accessToken();
        } catch (error) {
          tokenUnavailable = true;
          throw error;
        }
      },
      onFailure: (failure) => {
        lastFailure = failure;
      },
    });
    const transport = this.createTransport({
      vendor: "openai",
      apiKey: CHATGPT_PLAN_SDK_CREDENTIAL_PLACEHOLDER,
      model,
      baseUrl: CHATGPT_PLAN_API_BASE_URL,
      fetch: planFetch,
      openaiWire: "responses",
    });
    // `max_output_tokens` is refused on this route. Background callers keep their ceiling: generateText stops the
    // stream locally at the same limit. Chat turns on subscription runtimes never carry one.
    const { outputTokenLimit: _outputTokenLimit, requestedOutputTokenLimit: _requested, ...rest } = params;
    for await (const event of transport.streamTurn({ ...rest, model })) {
      if (event.type === "message_complete") {
        const { usage, ...complete } = event;
        const subscriptionUsage = usage
          ? normalizeSubscriptionUsageTelemetry({
              provider: "chatgpt-plan",
              model,
              source: "provider-reported",
              billable: false,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.inputTokens + usage.outputTokens,
              ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
              ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
              ...(usage.reasoningTokens !== undefined ? { reasoningOutputTokens: usage.reasoningTokens } : {}),
            })
          : undefined;
        yield { ...complete, ...(subscriptionUsage ? { subscriptionUsage } : {}) };
        continue;
      }
      if (event.type === "error") {
        if (tokenUnavailable) {
          yield unavailableEvent("chatgpt-plan-reconnect-required");
          return;
        }
        const failure = lastFailure;
        if (failure && classifyChatGptPlanError(failure).confirmSession) {
          // A rejected subscriber context ends the session only once a refresh confirms it.
          await runtime.confirmSession().catch(() => undefined);
        }
        yield failureEvent(failure, event);
        return;
      }
      yield event;
    }
  }
}
