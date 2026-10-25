import type { LLMVendor, ThinkingBlock } from "./types.js";

/** Replay only route-supported signed reasoning; unknown routes retain it for conservative estimation.
 * Display-only thought never enters request content. */
export function selectAssistantWireThinkingBlocks(
  blocks: readonly ThinkingBlock[] | undefined,
  vendor?: LLMVendor,
): ThinkingBlock[] {
  if (vendor !== undefined && vendor !== "claude") return [];
  return (blocks ?? []).filter(
    (block) => typeof block.signature === "string" && block.signature.length > 0,
  );
}
