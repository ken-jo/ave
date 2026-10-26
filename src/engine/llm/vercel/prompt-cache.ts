// Cache the last tool, one system block, and reusable conversation prefix; exclude request-only tails.
// Keep the system block whole so bounded lookback can reach earlier cached content.
import type { ModelMessage, SystemModelMessage, tool } from "ai";
import type { GenericMessage } from "../types.js";

const EPHEMERAL_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

type SdkTool = ReturnType<typeof tool>;

export function cachedSystemPrompt(systemPrompt: string): SystemModelMessage {
  return { role: "system", content: systemPrompt, providerOptions: EPHEMERAL_BREAKPOINT };
}

export function withCachedToolList(
  tools: Record<string, SdkTool> | undefined,
): Record<string, SdkTool> | undefined {
  if (!tools) return tools;
  const names = Object.keys(tools);
  const last = names[names.length - 1];
  if (last === undefined) return tools;
  const lastTool = tools[last]!;
  return {
    ...tools,
    [last]: {
      ...lastTool,
      providerOptions: { ...(lastTool.providerOptions ?? {}), ...EPHEMERAL_BREAKPOINT },
    } as SdkTool,
  };
}

// Split only trailing request-only rows to avoid reordering content inside the conversation.
export function splitRequestOnlyTail(messages: GenericMessage[]): {
  conversation: GenericMessage[];
  requestOnlyTail: GenericMessage[];
} {
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.meta?.requestOnly === true) start -= 1;
  return { conversation: messages.slice(0, start), requestOnlyTail: messages.slice(start) };
}

// Provider lookback includes the breakpoint block itself.
const CACHE_LOOKBACK_BLOCKS = 20;

function blockCount(message: ModelMessage): number {
  return typeof message.content === "string" ? 1 : message.content.length;
}

function withMessageBreakpoint(message: ModelMessage): ModelMessage {
  return {
    ...message,
    providerOptions: { ...(message.providerOptions ?? {}), ...EPHEMERAL_BREAKPOINT },
  } as ModelMessage;
}

/** Mark user/tool content before request-only parts; reasoning-ending assistant rows cannot be marked.
 * Retain the previous breakpoint after large rounds, keeping the total at four or fewer. */
export function withCachedConversationPrefix(
  conversation: ModelMessage[],
  requestOnlyTail: ModelMessage[],
  requestOnlyParts = 0,
): ModelMessage[] {
  const isPrefixEnd = (m: ModelMessage) => m.role === "user" || m.role === "tool";
  let target = conversation.length - 1;
  while (target >= 0 && !isPrefixEnd(conversation[target]!)) target -= 1;
  if (target < 0) return [...conversation, ...requestOnlyTail];

  const out = conversation.slice();
  const targetMessage = conversation[target]!;
  const tailParts = target === conversation.length - 1 ? requestOnlyParts : 0;
  let targetBlocks = blockCount(targetMessage);
  if (tailParts > 0 && Array.isArray(targetMessage.content) && targetMessage.content.length > tailParts) {
    const content = targetMessage.content.slice();
    const at = content.length - 1 - tailParts;
    const part = content[at]!;
    const partOptions = (part as { providerOptions?: Record<string, unknown> }).providerOptions;
    content[at] = { ...part, providerOptions: { ...(partOptions ?? {}), ...EPHEMERAL_BREAKPOINT } } as typeof part;
    out[target] = { ...targetMessage, content } as ModelMessage;
    targetBlocks -= tailParts;
  } else {
    out[target] = withMessageBreakpoint(targetMessage);
  }

  // Find the previous reusable breakpoint before the assistant turn preceding this target.
  let assistant = target - 1;
  while (assistant >= 0 && conversation[assistant]!.role !== "assistant") assistant -= 1;
  let previous = assistant - 1;
  while (previous >= 0 && !isPrefixEnd(conversation[previous]!)) previous -= 1;
  if (previous >= 0) {
    let distance = targetBlocks;
    for (let i = previous + 1; i < target; i++) distance += blockCount(conversation[i]!);
    if (distance >= CACHE_LOOKBACK_BLOCKS) out[previous] = withMessageBreakpoint(conversation[previous]!);
  }
  return [...out, ...requestOnlyTail];
}
