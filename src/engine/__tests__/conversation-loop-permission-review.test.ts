// Persist permission verdicts on tool results so transcript reload retains them.
import { describe, expect, it } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider as FakeProvider } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

function oneToolRound(): FakeProvider {
  return new FakeProvider([
    [
      { type: "tool_call", id: "t1", name: "noop_tool", input: {} } as StreamEvent,
      { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
    ],
    [
      { type: "text_delta", text: "done" } as StreamEvent,
      { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
    ],
  ]);
}

function makeLoop(review: PermissionReviewEvent): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(
    createDynamicTool({
      name: "noop_tool",
      description: "no-op",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "ok", isError: false }),
    }),
  );
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({
    toolRegistry,
    disableSessionPersistence: true,
  }));
  (loop as { provider: LLMProvider | null }).provider = oneToolRound();

  const executor = (
    loop as unknown as {
      toolExecutor: {
        executeAll: (
          uses: unknown,
          opts: { callbacks?: { onPermissionReview?: (event: PermissionReviewEvent) => void } },
        ) => Promise<unknown>;
      };
    }
  ).toolExecutor;
  const original = executor.executeAll.bind(executor);
  executor.executeAll = (uses, opts) => {
    opts.callbacks?.onPermissionReview?.(review);
    return original(uses, opts);
  };
  return loop;
}

function toolResults(loop: ConversationLoop): GenericMessage[] {
  return (loop as unknown as { history: { getMessages: () => GenericMessage[] } })
    .history.getMessages()
    .filter((message) => message.role === "tool_result");
}

describe("permission review verdict persistence", () => {
  it("stamps the review onto the tool_result it belongs to", async () => {
    const loop = makeLoop({
      status: "auto_approved",
      toolName: "noop_tool",
      groupId: "g1",
      toolUseId: "t1",
      displayOrder: 0,
      verdictLevel: "low",
      reason: "read-only",
    });

    await loop.runTurn("도구 써줘", {}, undefined, { ...userKeyboardTurn() });

    const results = toolResults(loop);
    expect(results).toHaveLength(1);
    expect(results[0]?.meta?.permissionReview).toEqual({
      status: "auto_approved",
      verdictLevel: "low",
      reason: "read-only",
    });
  });

  it("leaves tool results untouched when no review ran", async () => {
    const loop = makeLoop({
      status: "auto_approved",
      toolName: "noop_tool",
      groupId: "g1",
      toolUseId: "other-tool",
      displayOrder: 0,
    });

    await loop.runTurn("도구 써줘", {}, undefined, { ...userKeyboardTurn() });

    const results = toolResults(loop);
    expect(results).toHaveLength(1);
    expect(results[0]?.meta).not.toHaveProperty("permissionReview");
  });
});
