import { describe, expect, it, vi } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { NotificationService } from "../../main/notification-service.js";
import { issueAuthorizationRequiredControl } from "../../shared/authorization-required.js";
import { makeBasicConversationLoopDeps } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

function makeHarness(notificationService?: NotificationService): { loop: ConversationLoop; toolRegistry: ToolRegistry } {
  const toolRegistry = new ToolRegistry();
  const inputClassifier = new InputClassifier();
  const routeEngine = new RouteEngine();

  const loop = new ConversationLoop(makeBasicConversationLoopDeps({
    notificationService,
    inputClassifier,
    routeEngine,
    toolRegistry,
  }));

  return { loop, toolRegistry };
}

function makeLoop(): ConversationLoop {
  return makeHarness().loop;
}

describe("ConversationLoop currentAbortController lifecycle", () => {
  it("clears currentAbortController and surfaces a stream error when provider iteration throws", async () => {
    const loop = makeLoop();
    // Mid-stream provider throws must emit stream_error rather than reject the IPC turn.
    (loop as { provider: LLMProvider }).provider = {
      vendor: "openai" as const,
      // eslint-disable-next-line require-yield
      async *streamTurn(): AsyncIterable<StreamEvent> {
        throw new Error("synthetic provider failure");
      },
    };

    const errors: string[] = [];
    const result = await loop.runTurn("ask", { onError: (message) => errors.push(message) }, undefined, { ...userKeyboardTurn() },
    );
    expect(result.text).toContain("synthetic provider failure");
    expect(errors[0]).toContain("synthetic provider failure");
    expect(loop.currentAbortController).toBeNull();
  });

  it.each<{ label: string; events: StreamEvent[] }>([
    { label: "empty response", events: [] },
    { label: "partial text", events: [{ type: "text_delta", text: "I will update the files." }] },
    { label: "partial reasoning", events: [{ type: "reasoning_delta", text: "I need to run a command." }] },
    { label: "pending tool", events: [{ type: "tool_call", id: "t1", name: "noop_tool", input: {} }] },
  ])("surfaces a stream error for $label without message_complete", async ({ events }) => {
    const loop = makeLoop();
    (loop as { provider: LLMProvider }).provider = {
      vendor: "openai" as const,
      async *streamTurn(): AsyncIterable<StreamEvent> {
        yield* events;
      },
    };

    const errors: string[] = [];
    const result = await loop.runTurn("ask", { onError: (message) => errors.push(message) }, undefined, { ...userKeyboardTurn() },
    );

    expect(result.stopReason).toBe("stream-error");
    expect(result.text).toContain("모델 응답이 완료 신호 없이 종료");
    expect(errors[0]).toContain("모델 응답이 완료 신호 없이 종료");
    expect(loop.getHistory().getMessages().some((message) => message.role === "tool"),
    ).toBe(false);
  });
});

describe("ConversationLoop abort (B4)", () => {
  it("abort mid-stream saves partial text and returns stopReason=interrupted", async () => {
    const loop = makeLoop();

    (loop as { provider: LLMProvider }).provider = {
      vendor: "openai" as const,
      async *streamTurn(params) {
        yield { type: "text_delta", text: "Hello " } as StreamEvent;
        yield { type: "text_delta", text: "world" } as StreamEvent;
        yield { type: "message_complete", stopReason: "end_turn",
        } as StreamEvent;
      },
    };

    const ac = new AbortController();
    ac.abort();

    const textDeltas: string[] = [];
    const result = await loop.runTurn("hi", {
      onTextDelta: (t) => textDeltas.push(t),
    }, ac.signal, { ...userKeyboardTurn() },
    );

    expect(result.stopReason).toBe("interrupted");
    // Preserve streamed prose; interruption belongs in renderer metadata.
    expect(result.text).not.toContain("[중단됨]");

    const history = loop.getHistory().getMessages();
    const assistant = history.find((m) => m.role === "assistant");
    expect(assistant?.content).not.toContain("[중단됨]");
    expect(assistant?.meta?.interrupted).toBe(true);
  });

  it("abort before tool_use via abortCurrentTurn → no tool executed", async () => {
    const loop = makeLoop();
    let toolExecuted = false;

    (loop as { provider: LLMProvider }).provider = {
      vendor: "openai" as const,
      async *streamTurn() {
        yield { type: "tool_call", id: "t1", name: "noop_tool", input: {},
        } as StreamEvent;
        yield { type: "message_complete", stopReason: "tool_use",
        } as StreamEvent;
        toolExecuted = true;
      },
    };

    const ac = new AbortController();
    ac.abort();

    const result = await loop.runTurn("go", undefined, ac.signal, { ...userKeyboardTurn(),
    });
    expect(result.stopReason).toBe("interrupted");
    expect(toolExecuted).toBe(false);
  });

  it("abort during tool execution records cancelled tool_result and stops before another LLM round", async () => {
    const { loop, toolRegistry } = makeHarness();
    let streamCalls = 0;
    let toolEntered = false;

    toolRegistry.register(createDynamicTool({
      name: "stuck_tool",
      description: "A tool that ignores abort for regression coverage.",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => {
        toolEntered = true;
        loop.abortCurrentTurn();
        return new Promise<never>(() => {});
      },
    }),
    );

    (loop as { provider: LLMProvider }).provider = {
      vendor: "openai" as const,
      async *streamTurn(): AsyncIterable<StreamEvent> {
        streamCalls += 1;
        yield { type: "tool_call", id: "t1", name: "stuck_tool", input: {},
        } as StreamEvent;
        yield { type: "message_complete", stopReason: "tool_use",
        } as StreamEvent;
      },
    };

    const textDeltas: string[] = [];
    const result = await loop.runTurn("go", {
      onTextDelta: (delta) => textDeltas.push(delta),
    }, undefined, { ...userKeyboardTurn() },
    );

    expect(toolEntered).toBe(true);
    expect(streamCalls).toBe(1);
    expect(result.stopReason).toBe("interrupted");
    // Tool-phase interruptions persist an empty assistant row with metadata, never synthetic prose.
    expect(result.text).toBe("");
    expect(textDeltas.join("")).not.toContain("[중단됨]");

    const history = loop.getHistory().getMessages();
    const toolResult = history.find((message) => message.role === "tool_result",
    );
    expect(toolResult?.content).toContain("취소");
    const lastAssistant = history.filter((message) => message.role === "assistant").at(-1);
    expect(lastAssistant?.content).toBe("");
    expect(lastAssistant?.meta?.interrupted).toBe(true);
  });

  it("abort after stream complete → no-op, normal result", async () => {
    const loop = makeLoop();

    (loop as { provider: LLMProvider }).provider = {
      vendor: "openai" as const,
      async *streamTurn() {
        yield { type: "text_delta", text: "Done." } as StreamEvent;
        yield { type: "message_complete", stopReason: "end_turn",
        } as StreamEvent;
      },
    };

    const result = await loop.runTurn("hi", undefined, undefined, { ...userKeyboardTurn(),
    });
    loop.abortCurrentTurn();

    expect(result.text).toContain("Done.");
    expect(result.stopReason).not.toBe("interrupted");
  });

  it("reports a provider AbortError when the caller has not cancelled", async () => {
    const loop = makeLoop();

    (loop as { provider: LLMProvider }).provider = {
      vendor: "openai" as const,
      async *streamTurn() {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        throw err;
      },
    };

    const errors: string[] = [];
    const result = await loop.runTurn("hi", { onError: (message) => errors.push(message) }, undefined, { ...userKeyboardTurn(),
    });
    expect(result.stopReason).toBe("stream-error");
    expect(errors).toHaveLength(1);
    expect(loop.currentAbortController).toBeNull();
  });

  it("Issue 3: error with 'abort' substring but wrong name is NOT treated as abort", async () => {
    const loop = makeLoop();

    (loop as { provider: LLMProvider }).provider = {
      vendor: "openai" as const,
      async *streamTurn() {
        const err = new Error("Surgical abortion operation timeout");
        err.name = "TimeoutError";
        throw err;
      },
    };

    let errorCalled = false;
    const result = await loop.runTurn("hi", { onError: () => { errorCalled = true; },
      }, undefined, { ...userKeyboardTurn() },
    );
    expect(result.stopReason).not.toBe("interrupted");
    expect(result.text).toContain("네트워크 연결 문제");
    expect(errorCalled).toBe(true);
  });

  it("abortCurrentTurn() aborts in-flight controller", () => {
    const loop = makeLoop();

    expect(() => loop.abortCurrentTurn()).not.toThrow();

    const ac = new AbortController();
    (loop as { currentAbortController: AbortController | null }).currentAbortController = ac;
    loop.abortCurrentTurn();
    expect(ac.signal.aborted).toBe(true);
  });
});

describe("turn completion notification sound delivery", () => {
  it.each([
    { outcome: "complete", masterEnabled: true, enabled: true, focused: false, count: 1, silent: false },
    { outcome: "complete", masterEnabled: true, enabled: false, focused: false, count: 1, silent: true },
    { outcome: "complete", masterEnabled: false, enabled: true, focused: false, count: 0 },
    { outcome: "complete", masterEnabled: false, enabled: false, focused: false, count: 0 },
    { outcome: "complete", masterEnabled: true, enabled: true, focused: true, count: 0 },
    { outcome: "interrupted", masterEnabled: true, enabled: true, focused: false, count: 0 },
    { outcome: "stream-error", masterEnabled: true, enabled: true, focused: false, count: 0 },
    { outcome: "context-error", masterEnabled: true, enabled: true, focused: false, count: 0 },
    { outcome: "authorization-required", masterEnabled: true, enabled: true, focused: false, count: 0 },
    { outcome: "empty", masterEnabled: true, enabled: true, focused: false, count: 0 },
  ])("$outcome, master=$masterEnabled, sound=$enabled, focused=$focused", async ({ outcome, masterEnabled, enabled, focused, count, silent }) => {
    const show = vi.fn();
    const notificationFactory = vi.fn(() => ({ show, on: vi.fn() }));
    const notificationService = new NotificationService({
      getMainWindow: () => ({ isDestroyed: () => false, isMinimized: () => false }) as Electron.BrowserWindow,
      notificationFactory,
      isTurnCompletionSoundEnabled: () => enabled,
      isOsNotificationsEnabled: () => masterEnabled,
      isAnyWindowFocused: () => focused,
      isReady: () => true,
      isTestEnv: () => false,
    });
    const { loop, toolRegistry } = makeHarness(notificationService);
    toolRegistry.register(createDynamicTool({
      name: "authorization_probe",
      description: "Return a host-issued authorization terminal",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({
        output: "Authorization required",
        isError: true,
        authorizationRequired: issueAuthorizationRequiredControl({
          kind: "tool",
          toolName: "authorization_probe",
          source: "builtin",
          category: "read",
          reason: "approval-surface-unavailable",
        }),
      }),
    }));
    const abort = new AbortController();
    (loop as { provider: LLMProvider }).provider = {
      vendor: "openai",
      async *streamTurn(): AsyncIterable<StreamEvent> {
        if (outcome !== "empty") yield { type: "text_delta", text: "Completed response" };
        if (outcome === "interrupted") { abort.abort(); return; }
        if (outcome === "stream-error") { yield { type: "error", error: "synthetic stream failure" }; return; }
        if (outcome === "context-error") {
          yield { type: "error", error: "prompt is too long for this model" };
          return;
        }
        if (outcome === "authorization-required") {
          yield { type: "tool_call", id: "authorization-probe", name: "authorization_probe", input: {} };
          yield { type: "message_complete", stopReason: "tool_use" };
          return;
        }
        yield { type: "message_complete", stopReason: "end_turn" };
      },
    };
    const result = await loop.runTurn("hi", {}, abort.signal, { ...userKeyboardTurn() });
    if (["interrupted", "stream-error", "context-error", "authorization-required"].includes(outcome)) expect(result.stopReason).toBe(outcome);
    if (outcome === "authorization-required") expect(result.text).not.toBe("");
    expect(notificationFactory).toHaveBeenCalledTimes(count);
    expect(show).toHaveBeenCalledTimes(count);
    if (count) expect(notificationFactory).toHaveBeenCalledWith(expect.objectContaining({ silent, urgency: "normal" }));
  });
});
