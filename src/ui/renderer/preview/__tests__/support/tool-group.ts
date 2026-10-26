import type { ChatEntry } from "../../../../../lib/chat-stream-state.js";

export function toolGroup(tools: Array<Record<string, unknown>>, groupId = "g1"): ChatEntry {
  return { kind: "tool_group", groupId, groupIds: [groupId], status: "done", tools: tools as never };
}
