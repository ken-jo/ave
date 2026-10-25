import type {
  GenericMessage,
  LLMProvider,
  ProviderRequestInputProjection,
  ProviderRequestInputProjectionParams,
  ToolSchema,
} from "./llm/types.js";
import { estimateMessagesTokens, estimateTokens } from "./auto-compact.js";
import { isNonNegativeSafeInteger } from "../shared/safe-integer.js";

export interface RequestInputProjection extends ProviderRequestInputProjection {
  totalTokens: number;
  systemPromptTokens: number;
  messageTokens: number;
  toolSchemaTokens: number;
}

export interface RequestInputProjectionInput extends ProviderRequestInputProjectionParams {
  systemPrompt: string;
  messages: GenericMessage[];
  toolSchemas: ToolSchema[];
}

function isValidProviderRequestInputProjection(value: unknown): value is RequestInputProjection {
  if (!value || typeof value !== "object") return false;
  const {
    totalTokens,
    systemPromptTokens,
    messageTokens,
    toolSchemaTokens,
  } = value as Partial<ProviderRequestInputProjection>;
  return isNonNegativeSafeInteger(totalTokens)
    && isNonNegativeSafeInteger(systemPromptTokens)
    && isNonNegativeSafeInteger(messageTokens)
    && isNonNegativeSafeInteger(toolSchemaTokens)
    && totalTokens === systemPromptTokens + messageTokens + toolSchemaTokens;
}

// Compute pressure in the engine from the exact prompt, wire messages, and exposed schemas sent.
export function estimateRequestInputProjection(
  input: RequestInputProjectionInput,
  provider?: Pick<LLMProvider, "projectRequestInput"> & Partial<Pick<LLMProvider, "vendor">>,
): RequestInputProjection {
  try {
    const providerProjection = provider?.projectRequestInput?.(input);
    if (isValidProviderRequestInputProjection(providerProjection)) return providerProjection;
  } catch {
    // Projection hooks are advisory and must not introduce preflight or compaction failures.
  }
  const systemPromptTokens = input.systemPrompt.trim().length > 0
    ? estimateTokens(JSON.stringify({ role: "system", content: input.systemPrompt }))
    : 0;
  // Independent transports own projection; shared API estimates count live images, never compacted stubs.
  const messageTokens = estimateMessagesTokens(input.messages, provider?.vendor);
  const toolSchemaTokens = input.toolSchemas.length > 0
    ? estimateTokens(JSON.stringify({ tools: input.toolSchemas }))
    : 0;
  return {
    totalTokens: systemPromptTokens + messageTokens + toolSchemaTokens,
    systemPromptTokens,
    messageTokens,
    toolSchemaTokens,
  };
}

export function projectNextTurnInputTokens(params: {
  providerInputTokens: number;
  lastRoundProjection: RequestInputProjection;
  postTurnProjection: RequestInputProjection;
}): number {
  if (params.providerInputTokens <= 0) return params.postTurnProjection.totalTokens;
  const projectedDelta =
    params.postTurnProjection.totalTokens - params.lastRoundProjection.totalTokens;
  return Math.max(0, params.providerInputTokens + projectedDelta);
}
