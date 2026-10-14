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
 * Marks the last user or tool message of the conversation; the request-only
 * tail follows it unmarked. An assistant row is never marked: its last block
 * can be a reasoning block, which the provider refuses to carry a breakpoint,
 * and a request ends on an assistant row only on continuation paths, where the
 * user or tool row before it is the stable prefix anyway.
 */
export function withCachedConversationPrefix(
  conversation: ModelMessage[],
  requestOnlyTail: ModelMessage[],
): ModelMessage[] {
  let index = conversation.length - 1;
  while (index >= 0 && conversation[index]!.role !== "user" && conversation[index]!.role !== "tool") index -= 1;
  if (index < 0) return [...conversation, ...requestOnlyTail];
  const target = conversation[index]!;
  const marked = {
    ...target,
    providerOptions: { ...(target.providerOptions ?? {}), ...EPHEMERAL_BREAKPOINT },
  } as ModelMessage;
  return [...conversation.slice(0, index), marked, ...conversation.slice(index + 1), ...requestOnlyTail];
}
