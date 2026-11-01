import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
// Establish the remote-controller extension boundary before asynchronous lifecycle dispatch.
import { describe, expect, it, vi } from "vitest";

import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { areExternalTurnHooksAllowed } from "../../shared/turn-extension-policy.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { makeBasicConversationLoopDeps } from "./support/conversation-loop-fixtures.js";

class SingleTurnProvider implements LLMProvider {
  readonly vendor = "openai" as const;

  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "ok" };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

function buildLoop(scriptHookManager: ScriptHookManager): ConversationLoop {
  return new ConversationLoop(makeBasicConversationLoopDeps({
    systemPromptBuilder: { build: () => "system", setActiveRolePrompt: vi.fn() },
    memoryManager: {
      saveSession: () => Promise.resolve(),
      listSessions: () => [],
      loadSessionMetadata: () => null,
    },
    disableSessionPersistence: true,
    scriptHookManager,
  }));
}

describe("ConversationLoop Tailnet extension policy", () => {
  it("propagates ordinary external hooks through an asynchronous lifecycle dispatch", async () => {
    const provider = new SingleTurnProvider();
    const manager = new ScriptHookManager();
    const lifecycleDispatch = vi.spyOn(manager, "runLifecycleEvent").mockImplementation(async () => {
      expect(areExternalTurnHooksAllowed()).toBe(true);
      return { decision: "allow", reason: "observed", results: [] };
    });
    const promptDispatch = vi.spyOn(manager, "runUserPromptSubmit");
    const loop = buildLoop(manager);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("tailnet request", undefined, undefined, {
      inputOrigin: "tailnet-surface",
      remoteControllerAuthority: bindRemoteControllerToSession({
        kind: "tailnet-controller",
        actorId: "tailnet:conversation-loop-policy-test",
      }, loop.getSessionId()),
    });

    expect(result.text).toBe("ok");
    expect(loop.history.getUserQuoteTexts(loop.getSessionId())).toEqual(["tailnet request"]);
    expect(promptDispatch).toHaveBeenCalled();
    expect(lifecycleDispatch.mock.calls.some((call) => call[0] === "Stop")).toBe(true);
  });
});
