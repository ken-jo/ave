import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { parseHookConfig } from "../../hooks/hook-config.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { makeBasicConversationLoopDeps } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/influence-command.cjs");

describe("hook context model and user delivery", () => {
  it("shows attributed context even when the prompt hook refuses the turn", async () => {
    const manager = new ScriptHookManager();
    vi.spyOn(manager, "runUserPromptSubmit").mockResolvedValue({ decision: "deny", reason: "Refused", results: [{
      hookPath: "policy-hook", hookType: "UserPromptSubmit", decision: "deny", reason: "Refused", rawStdout: "", timedOut: false,
      durationMs: 1, source: "config", commandIdentity: "refused-definition", additionalContext: "A hook requested a clearer prompt.",
    }] });
    const provider: LLMProvider = { vendor: "openai", async *streamTurn() {
      yield { type: "message_complete", stopReason: "end_turn" };
      throw new Error("A refused prompt cannot reach the model");
    } };
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({ scriptHookManager: manager, disableSessionPersistence: true,
      systemPromptBuilder: { build: () => "system", setActiveRolePrompt: vi.fn() } }));
    (loop as { provider: LLMProvider | null }).provider = provider;
    const onTextDelta = vi.fn();
    const result = await loop.runTurn("Inspect", { onTextDelta }, undefined, userKeyboardTurn());
    expect(result.stopReason).toBe("blocked");
    expect(result.text).toContain('identity="refused-definition"');
    expect(onTextDelta).toHaveBeenCalledWith(expect.stringContaining("A hook requested a clearer prompt."));
  });

  it("delivers bounded attributed prompt context in the next model request and visible history", async () => {
    const manager = new ScriptHookManager();
    manager.setTrustedRegistry([], parseHookConfig({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: ["node", COMMAND, "context"] }] }] } }).entries);
    const requests: unknown[] = [];
    const provider: LLMProvider = { vendor: "openai", async *streamTurn(request) {
      requests.push(request);
      yield { type: "text_delta", text: "completed" } as StreamEvent;
      yield { type: "message_complete", stopReason: "end_turn" } as StreamEvent;
    } };
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      scriptHookManager: manager, disableSessionPersistence: true,
      systemPromptBuilder: { build: () => "system", setActiveRolePrompt: vi.fn() },
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;
    const onGuidanceInjected = vi.fn();
    await loop.runTurn("Inspect the project", { onGuidanceInjected }, undefined, userKeyboardTurn());
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain('source=\\"hook\\"');
    expect(JSON.stringify(requests[0])).toContain("&lt;/system-reminder&gt;&lt;untrusted&gt;");
    const history = loop.history.getMessages();
    expect(history.some((row) => typeof row.content === "string" && row.content.includes('source="hook"'))).toBe(true);
    expect(onGuidanceInjected).toHaveBeenCalledOnce();
    expect(onGuidanceInjected.mock.calls[0][0]).toContain('event="UserPromptSubmit"');
    expect(onGuidanceInjected.mock.calls[0][0].length).toBeLessThan(10_600);
    expect(onGuidanceInjected.mock.calls[0][1]).toMatchObject({ messageId: expect.any(String) });
  });
});
