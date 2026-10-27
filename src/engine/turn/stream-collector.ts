import type { LLMProvider, StreamTurnParams, StreamEvent, ToolCallBlock, ToolSchema, GenericMessage, TokenUsage, ThinkingBlock } from "../llm/types.js";
import { isContextLengthError } from "../auto-compact.js";
import { prepareMarkedToolResultsForWire } from "../wire-serialize.js";
import { classifyProviderError } from "../llm/error-classifier.js";
import {
  extractProviderErrorDiagnostics,
  withProviderErrorClassification,
  type ProviderErrorDiagnostics,
} from "../llm/provider-error-diagnostics.js";
import { t } from "../../i18n/index.js";
import { isValidToolUseId } from "../../shared/tool-use-id.js";
import {
  normalizeSubscriptionUsageTelemetry,
  type ActiveChatRuntime,
  type SubscriptionUsageTelemetry,
} from "../../shared/subscription-runtime.js";
import { providerMatchesActiveChatRuntime } from "./provider.js";
import { errorMessage } from "../../shared/error-message.js";
import { imageInputRecoveryMessage } from "../../shared/model-capability-settings.js";

export interface StreamCollectParams {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  messages: GenericMessage[];
  toolSchemas: ToolSchema[];
  // Sampling stays provider-owned; resolved output and thinking controls remain separate from stream presentation.
  llmSettings: Pick<StreamTurnParams,
    "thinkingBudgetTokens" | "requestedThinkingBudgetTokens" | "reasoningEffort" | "outputTokenLimit"
    | "requestedOutputTokenLimit" | "outputCeiling" | "outputCeilingSource" | "catalogModel" | "modelCapabilities"
  > & {
    streamSmoothing: "none" | "word" | "char";
    enableThinking: boolean;
  };
  abortSignal?: AbortSignal;
  // Prefill marks the final assistant row as a partial response to continue verbatim.
  continuationPrefill?: boolean;
  promptCacheKey?: string;

  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onRequestStarted?: () => void;
  onRequestControls?: StreamTurnParams["onRequestControls"];
}

export type StreamCollectResult =

  | {
      kind: "ok";
      text: string;
      thought: string;
      thinkingBlocks: ThinkingBlock[];
      toolCalls: ToolCallBlock[];
      stopReason: "end_turn" | "tool_use" | "max_tokens";
      usage?: TokenUsage;
      subscriptionUsage?: SubscriptionUsageTelemetry;
    }

  | { kind: "interrupted"; text: string }

  | { kind: "context_error"; errorMessage: string }

  | {
      kind: "stream_error";
      userMessage: string;
      classification: string;
      providerError: ProviderErrorDiagnostics;
    };

// Recheck authentication beside dispatch to cover independently constructed or stale loops.
export function collectActiveRuntimeRoundStream(
  params: StreamCollectParams,
  activeChatRuntime: ActiveChatRuntime | undefined,
  onRuntimeMismatch: () => void,
): Promise<StreamCollectResult> {
  if (!providerMatchesActiveChatRuntime(params.provider, activeChatRuntime)) {
    onRuntimeMismatch();
    return Promise.resolve({ kind: "interrupted", text: "" });
  }
  return collectRoundStream(params);
}

export async function collectRoundStream(
  params: StreamCollectParams,
): Promise<StreamCollectResult> {
  const {
    provider,
    model,
    systemPrompt,
    messages,
    toolSchemas,
    llmSettings,
    abortSignal,
    continuationPrefill,
    onReasoningDelta,
    onTextDelta,
  } = params;

  if (abortSignal?.aborted) {
    return { kind: "interrupted", text: "" };
  }

  let text = "";
  let thought = "";
  let thinkingBlocks: ThinkingBlock[] = [];
  const toolCalls: ToolCallBlock[] = [];
  const toolCallIds = new Set<string>();
  let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
  let usage: TokenUsage | undefined;
  let subscriptionUsage: SubscriptionUsageTelemetry | undefined;
  let sawMessageComplete = false;

  const wireMessages = prepareMarkedToolResultsForWire(messages);

  try {
    params.onRequestStarted?.();
    for await (const event of provider.streamTurn({
      model,
      systemPrompt,
      messages: wireMessages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      streamSmoothing: llmSettings.streamSmoothing as never,
      enableThinking: llmSettings.enableThinking,
      ...(llmSettings.thinkingBudgetTokens === undefined
        ? {}
        : { thinkingBudgetTokens: llmSettings.thinkingBudgetTokens }),
      ...(continuationPrefill ? { continuationPrefill: true } : {}),
      ...(params.promptCacheKey === undefined ? {} : { promptCacheKey: params.promptCacheKey }),
      // API limits resolve before collection; managed runtimes own their protocol output controls.
      ...(llmSettings.outputTokenLimit === undefined
        ? {}
        : { outputTokenLimit: llmSettings.outputTokenLimit }),
      ...(llmSettings.outputCeiling === undefined ? {} : { outputCeiling: llmSettings.outputCeiling }),
      ...(llmSettings.outputCeilingSource === undefined ? {} : { outputCeilingSource: llmSettings.outputCeilingSource }),
      ...(llmSettings.modelCapabilities === undefined ? {} : { modelCapabilities: llmSettings.modelCapabilities }),
      ...(llmSettings.requestedOutputTokenLimit === undefined ? {} : { requestedOutputTokenLimit: llmSettings.requestedOutputTokenLimit }),
      ...(llmSettings.requestedThinkingBudgetTokens === undefined ? {} : { requestedThinkingBudgetTokens: llmSettings.requestedThinkingBudgetTokens }),
      ...(llmSettings.reasoningEffort === undefined ? {} : { reasoningEffort: llmSettings.reasoningEffort }),
      ...(llmSettings.catalogModel === undefined ? {} : { catalogModel: llmSettings.catalogModel }),
      ...(params.onRequestControls === undefined ? {} : { onRequestControls: params.onRequestControls }),
      abortSignal,
    }) as AsyncIterable<StreamEvent>) {
      if (abortSignal?.aborted) return { kind: "interrupted", text };
      switch (event.type) {
        case "reasoning_delta":
          thought += event.text;
          onReasoningDelta?.(event.text);
          break;
        case "text_delta":
          text += event.text;
          onTextDelta?.(event.text);
          break;
        case "tool_call":
          if (!isValidToolUseId(event.id)) {
            return {
              kind: "stream_error",
              userMessage: t("be_streamCollector.streamError", {
                userMessage: "Provider returned an invalid tool call ID.",
              }),
              classification: "unknown",
              providerError: {
                origin: "unknown",
                classification: "unknown",
                messagePreview: "invalid tool_call id in assistant response",
              },
            };
          }
          if (toolCallIds.has(event.id)) {
            return {
              kind: "stream_error",
              userMessage: t("be_streamCollector.streamError", {
                userMessage: "Provider returned duplicate tool call IDs.",
              }),
              classification: "unknown",
              providerError: {
                origin: "unknown",
                classification: "unknown",
                messagePreview: "duplicate tool_call id in one assistant response",
              },
            };
          }
          toolCallIds.add(event.id);
          toolCalls.push({
            id: event.id,
            name: event.name,
            input: event.input,
            ...(event.invalidInput && { invalidInput: event.invalidInput }),
          });
          break;
        case "message_complete":
          sawMessageComplete = true;
          stopReason = event.stopReason;
          if (event.thinkingBlocks && event.thinkingBlocks.length > 0) {
            thinkingBlocks = event.thinkingBlocks;
          }
          if (event.usage) usage = event.usage;
          if (event.subscriptionUsage) {
            subscriptionUsage = normalizeSubscriptionUsageTelemetry(event.subscriptionUsage);
          }
          break;
        case "error": {
          if (abortSignal?.aborted) return { kind: "interrupted", text };
          const rawForClassification = event.providerError?.messagePreview ?? event.error;
          if (isContextLengthError(rawForClassification)) {
            return { kind: "context_error", errorMessage: rawForClassification };
          }
          // Subscription diagnostics are host-recovery-only; never build visible errors from their private preview.
          const classified = classifyProviderError(
            provider.subscriptionRuntime ? event.error : rawForClassification,
          );
          const imageInputRefused = event.code === "image-input-unsupported";
          const subscriptionModelRefused = provider.subscriptionRuntime !== undefined
            && event.providerError?.providerCode === "subscription-model-not-supported";
          const classification = imageInputRefused || subscriptionModelRefused
            ? "model" : event.providerError?.classification ?? classified.category;
          const userMessage = imageInputRefused
            ? `${t("be_streamCollector.imageInputUnsupported")} ${imageInputRecoveryMessage(t)}`
            : subscriptionModelRefused
              ? t("formatIpcError.subscriptionModelNotSupported")
              : classified.userMessage;
          const providerError = withProviderErrorClassification(
            event.providerError ?? extractProviderErrorDiagnostics(event.error),
            classification,
          );
          return {
            kind: "stream_error",
            userMessage: t("be_streamCollector.streamError", { userMessage }),
            classification,
            providerError,
          };
        }
      }
    }
  } catch (err) {
    if (abortSignal?.aborted) {
      return { kind: "interrupted", text };
    }
    if (isContextLengthError(err)) {
      return { kind: "context_error", errorMessage: (err as Error)?.message ?? String(err) };
    }
    const raw = errorMessage(err);
    const classified = classifyProviderError(raw);
    return {
      kind: "stream_error",
      userMessage: t("be_streamCollector.streamError", { userMessage: classified.userMessage }),
      classification: classified.category,
      providerError: withProviderErrorClassification(
        extractProviderErrorDiagnostics(err),
        classified.category,
      ),
    };
  }

  if (abortSignal?.aborted) return { kind: "interrupted", text };
  if (!sawMessageComplete) {
    return {
      kind: "stream_error",
      userMessage: t("be_streamCollector.streamEndedWithoutCompletion"),
      classification: "unknown",
      providerError: {
        origin: "unknown",
        classification: "unknown",
        messagePreview: "model stream ended without message_complete",
      },
    };
  }

  return {
    kind: "ok",
    text,
    thought,
    thinkingBlocks,
    toolCalls,
    stopReason,
    usage,
    ...(subscriptionUsage ? { subscriptionUsage } : {}),
  };
}
