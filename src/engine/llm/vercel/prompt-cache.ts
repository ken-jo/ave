/**
 * Prompt-prefix cache markers for transports whose provider caches only up to
 * explicit breakpoints.
 *
 * A request is laid out tools → system → messages, and the provider caches a
 * prefix only where a block carries a breakpoint. Three are placed, one below
 * the provider's limit of four:
 *
 *   1. the last tool definition — the tool list changes only with scope;
 *   2. the system prompt, sent as one block — it changes only when a source
 *      it is built from does (project instructions, skills, memory, scope);
 *   3. the last user or tool message of the conversation — every earlier
 *      round's prefix is a prefix of this one, so the next round reads it.
 *
 * Rows marked `meta.requestOnly` (per-turn context, a round nudge) trail the
 * conversation in this request only. A breakpoint on them would hash content
 * the next request does not repeat, so the third marker stops before them.
 *
 * The system prompt stays ONE block on purpose: the provider looks back a
 * bounded number of blocks from each breakpoint, so splitting the prompt into
 * sections only shortens how far back a later breakpoint can find a hit.
 */
import type { ModelMessage, SystemModelMessage, tool } from "ai";
import type { GenericMessage } from "../types.js";

const EPHEMERAL_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

type SdkTool = ReturnType<typeof tool>;

/** The system prompt as a single cached block. */
export function cachedSystemPrompt(systemPrompt: string): SystemModelMessage {
  return { role: "system", content: systemPrompt, providerOptions: EPHEMERAL_BREAKPOINT };
}

/** Marks the last tool definition, which caches the whole tool list. */
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

/**
 * Splits wire rows into the conversation prefix and the trailing request-only
 * rows. Only TRAILING rows are split off: a request-only row that somehow sat
 * before a conversation row would otherwise reorder the request.
 */
export function splitRequestOnlyTail(messages: GenericMessage[]): {
  conversation: GenericMessage[];
  requestOnlyTail: GenericMessage[];
} {
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.meta?.requestOnly === true) start -= 1;
  return { conversation: messages.slice(0, start), requestOnlyTail: messages.slice(start) };
}

/**
 * How many blocks the provider walks back from a breakpoint looking for an
 * earlier cache entry, the breakpoint's own block included.
 */
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

/**
 * Marks the conversation's reusable prefix and appends the request-only tail
 * unmarked.
 *
 * The breakpoint sits on the last user or tool message. An assistant row is
 * never marked: its last block can be a reasoning block, which the provider
 * refuses to carry a breakpoint, and a request ends on an assistant row only
 * on continuation paths, where the row before it is the stable prefix anyway.
 *
 * `requestOnlyParts` counts content parts at the end of the last message that
 * this request alone carries (the turn context); the breakpoint goes on the
 * message's last part before them, so next request's identical message, sent
 * without them, still matches the cached prefix.
 *
 * When one round adds more blocks than the provider looks back over (a round
 * with many parallel tool calls), the previous round's breakpoint position is
 * marked as well, so the new breakpoint still finds that entry. At most two
 * message breakpoints, so a request carries at most four.
 */
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

  // The previous round's breakpoint: the last user/tool message before the
  // assistant turn that precedes the target.
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
