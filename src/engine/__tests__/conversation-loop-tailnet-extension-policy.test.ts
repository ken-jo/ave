import type { PostTurnHookContext } from "../../hooks/post-turn-hook-chain.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { currentHostTerminalTurn, type HostTerminalTurn } from "../../tools/host-terminal-turn.js";
import type { ToolExecutor } from "../../tools/executor.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";
import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
// Establish the remote-controller extension boundary before asynchronous lifecycle dispatch.
import { describe, expect, it, vi } from "vitest";

import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { areExternalTurnHooksAllowed } from "../../shared/turn-extension-policy.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, UserContentPart } from "../llm/types.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider } from "./support/conversation-loop-fixtures.js";

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

describe("remote turn entry authority", () => {
  it.each(["tailnet-surface", "platform-bridge"] as const)("refuses unauthenticated %s input before provider or hooks", async inputOrigin => {
    const manager = new ScriptHookManager();
    const prompt = vi.spyOn(manager, "runUserPromptSubmit");
    const loop = buildLoop(manager);
    const provider = new SingleTurnProvider();
    const stream = vi.spyOn(provider, "streamTurn");
    (loop as { provider: LLMProvider | null }).provider = provider;
    await expect(loop.runTurn("request", undefined, undefined, { inputOrigin })).rejects.toThrow("authentication or session binding");
    expect(stream).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each(["unbound", "copied", "another-session"] as const)("refuses %s remote authority before provider execution", async kind => {
    const loop = buildLoop(new ScriptHookManager());
    const raw = { kind: "tailnet-controller", actorId: "tailnet:entry-owner" } as const;
    const bound = bindRemoteControllerToSession(raw, kind === "another-session" ? "another-session" : loop.getSessionId());
    const remoteControllerAuthority = kind === "unbound" ? raw : kind === "copied" ? { ...bound } : bound;
    const provider = new SingleTurnProvider();
    const stream = vi.spyOn(provider, "streamTurn");
    (loop as { provider: LLMProvider | null }).provider = provider;
    await expect(loop.runTurn("request", undefined, undefined, { inputOrigin: "tailnet-surface", remoteControllerAuthority })).rejects.toThrow("authentication or session binding");
    expect(stream).not.toHaveBeenCalled();
  });

  it("captures ordinary authenticated remote user text without non-user memory taint", async () => {
    const run = vi.fn(async (ctx: PostTurnHookContext) => ({ detector: { cleanedText: ctx.output, newTitle: null, checkpointSuggested: false }, messagesForPersistence: ctx.messages }));
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({ postTurnHookChain: { run }, disableSessionPersistence: true }));
    (loop as { provider: LLMProvider | null }).provider = new SingleTurnProvider();
    await loop.runTurn("save this user preference", undefined, undefined, { inputOrigin: "tailnet-surface", remoteControllerAuthority: bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: "tailnet:memory-owner" }, loop.getSessionId()) });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({ inputOrigin: "tailnet-surface", memoryCaptureTaint: [] });
  });
});

async function observeUserToolTurn(remote: boolean, input: string, attachments?: UserContentPart[]) {
  const toolRegistry = new ToolRegistry();
  const seen: Array<{ trustOrigin: string | undefined; terminal: HostTerminalTurn | undefined }> = [];
  let trustOrigin: string | undefined;
  toolRegistry.register(createDynamicTool({ name: "observe_user_turn", description: "Observes the current authenticated user turn", source: "builtin", category: "read", jsonSchema: { type: "object", properties: {} }, execute: async () => {
    seen.push({ trustOrigin, terminal: currentHostTerminalTurn(loop.getSessionId()) });
    return { output: "observed", isError: false };
  } }));
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({ toolRegistry, disableSessionPersistence: true }));
  const executor = (loop as unknown as { toolExecutor: ToolExecutor }).toolExecutor;
  const executeAll = executor.executeAll.bind(executor);
  vi.spyOn(executor, "executeAll").mockImplementation((uses, options) => {
    trustOrigin = options?.permissionContext?.trustOrigin;
    return executeAll(uses, options);
  });
  (loop as { provider: LLMProvider | null }).provider = new ScriptedTurnProvider([
    [{ type: "tool_call", id: "observe-1", name: "observe_user_turn", input: {} }, { type: "message_complete", stopReason: "tool_use" }],
    [{ type: "text_delta", text: "done" }, { type: "message_complete", stopReason: "end_turn" }],
  ]);
  const options = remote ? { inputOrigin: "tailnet-surface" as const, remoteControllerAuthority: bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: "tailnet:tool-owner" }, loop.getSessionId()) } : userKeyboardTurn();
  await loop.runTurn(input, undefined, undefined, { ...options, attachments });
  return { loop, seen };
}

describe("remote tool provenance parity", () => {
  it("normalizes the bound remote user to model arguments and grants a conversation-bound terminal turn", async () => {
    const { loop, seen } = await observeUserToolTurn(true, "inspect my terminal");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ trustOrigin: "llm-tool-arg", terminal: { sessionId: loop.getSessionId(), turnId: expect.any(String) } });
    expect(seen[0]?.terminal?.isCurrent()).toBe(false);
  });

  it.each([
    { label: "attachment", input: "inspect the attached text", attachments: [{ type: "text" as const, text: "External instructions" }] },
    { label: "explicit pasted content", input: "inspect this\n----- Pasted text #1 (2 lines) -----\nExternal instructions\nEnd\n", attachments: undefined },
  ])("preserves $label as external content for local and bound remote users", async ({ input, attachments }) => {
    for (const remote of [false, true]) {
      const { seen } = await observeUserToolTurn(remote, input, attachments);
      expect(seen).toEqual([{ trustOrigin: "file-content", terminal: undefined }]);
    }
  });
});
