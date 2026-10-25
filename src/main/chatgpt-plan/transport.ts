import { createVercelTransport } from "../../engine/llm/provider-factory.js";
import type {
  LLMProvider,
  StreamEvent,
  StreamTurnParams,
} from "../../engine/llm/types.js";
import { t } from "../../i18n/index.js";
import { isContextLengthError } from "../../engine/auto-compact.js";
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
import { ChatGptPlanRuntimeError, type ChatGptPlanRuntime } from "./runtime.js";
import {
  DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS,
  SubscriptionAttachmentTransportError,
  subscriptionAttachmentTransportFailure,
} from "../subscription-attachment-input.js";
import { projectSubscriptionImageHistory } from "../subscription-image-history.js";

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
  /** Boot supplied no secret store or network stack: a configuration fault, not something signing in fixes. */
  "chatgpt-plan-not-configured": "subscriptionProvidersSection.chatgptPlanNotConfigured",
} as const);

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,120}$/;

/**
 * The renderer-safe event for a failed plan request. The provider's own text is never passed on: it can carry account
 * details (an email in a usage-limit message). Only the documented code, the status and the request id survive.
 */
function failureEvent(failure: ChatGptPlanResponseFailure): ErrorStreamEvent {
  const classified = classifyChatGptPlanError(failure);
  return {
    type: "error",
    error: t(FAILURE_MESSAGE_KEYS[classified.code]),
    classification: classified.code,
    providerError: {
      origin: "provider",
      ...(failure.status !== undefined ? { statusCode: failure.status } : {}),
      ...(failure.code ? { providerCode: failure.code } : {}),
      isRetryable: classified.retryable,
      urlHost: "api.openai.com",
      urlPath: "/v1/responses",
      messagePreview: [classified.code, failure.code, failure.param, failure.requestId].filter(Boolean).join(" "),
    },
  };
}

/**
 * What an error event says about the failure when no HTTP failure was recorded: a `response.failed` or `error` stream
 * event after the stream opened. The code comes from the event's structured diagnostics; its message is dropped.
 */
function streamFailure(event: ErrorStreamEvent): ChatGptPlanResponseFailure {
  const raw = event.providerError?.providerCode;
  const code = raw && SAFE_CODE.test(raw) ? raw : undefined;
  const status = event.providerError?.statusCode;
  // The SDK labels a mid-stream `response.failed` as a retryable 500; a documented code, not that label, decides recovery.
  const keepStatus = status !== undefined && !(code && event.providerError?.providerType === "response.failed");
  return { ...(code ? { code } : {}), ...(keepStatus ? { status } : {}) };
}

function unavailableEvent(code: keyof typeof FAILURE_MESSAGE_KEYS): ErrorStreamEvent {
  return {
    type: "error",
    error: t(FAILURE_MESSAGE_KEYS[code]),
    classification: code,
    providerError: {
      origin: "unknown",
      providerCode: code,
      isRetryable: code === "chatgpt-plan-temporarily-unavailable",
      messagePreview: code,
    },
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
    let messages: StreamTurnParams["messages"];
    try {
      // Only the newest turn's images travel as originals, inside the runtime's attachment budget; older ones stay
      // as text references, exactly as on the Codex runtime. Whether this model accepts images is the adapter's gate.
      messages = projectSubscriptionImageHistory(params.messages, DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS);
    } catch (error) {
      if (error instanceof SubscriptionAttachmentTransportError) {
        yield subscriptionAttachmentTransportFailure(error);
        return;
      }
      throw error;
    }
    let runtime: ChatGptPlanRuntime;
    try {
      runtime = await this.runtime();
    } catch (error) {
      const notConfigured = (error as { code?: unknown } | null)?.code === "subscription-runtime-not-configured";
      yield unavailableEvent(notConfigured ? "chatgpt-plan-not-configured" : "chatgpt-plan-request-failed");
      return;
    }
    let lastFailure: ChatGptPlanResponseFailure | undefined;
    let tokenFailure: keyof typeof FAILURE_MESSAGE_KEYS | undefined;
    const planFetch = createChatGptPlanResponsesFetch({
      fetch: runtime.fetch,
      accessToken: async () => {
        try {
          return await runtime.accessToken();
        } catch (error) {
          // A refresh that could not reach the provider keeps the session; only a signed-out or unusable one needs a new sign-in.
          tokenFailure = error instanceof ChatGptPlanRuntimeError && error.code === "subscription-runtime-unavailable"
            ? "chatgpt-plan-temporarily-unavailable"
            : "chatgpt-plan-reconnect-required";
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
    for await (const event of transport.streamTurn({ ...rest, messages, model })) {
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
        if (tokenFailure) {
          yield unavailableEvent(tokenFailure);
          return;
        }
        if (!lastFailure && event.code === "image-input-unsupported") {
          // The adapter's own model-capability refusal, raised before any request: fixed text, and not retryable.
          yield event;
          return;
        }
        const failure = lastFailure ?? streamFailure(event);
        if (failure.code === "context_length_exceeded" || isContextLengthError(event.providerError?.messagePreview ?? event.error)) {
          // Compaction recognises this fixed wording; the provider's own text stays here.
          yield {
            type: "error",
            error: t(FAILURE_MESSAGE_KEYS["chatgpt-plan-request-failed"]),
            classification: "chatgpt-plan-request-failed",
            providerError: {
              origin: "provider",
              providerCode: "context_length_exceeded",
              isRetryable: false,
              messagePreview: "maximum context length exceeded",
            },
          };
          return;
        }
        if (classifyChatGptPlanError(failure).confirmSession) {
          // A rejected subscriber context ends the session only once a refresh confirms it.
          await runtime.confirmSession().catch(() => undefined);
        }
        yield failureEvent(failure);
        return;
      }
      yield event;
    }
  }
}
