// Rejected guidance must stay visible to the caller; capped turns report unapplied entries.
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { endTurnScript } from "./conversation-loop-test-helpers.js";
import { makeBasicConversationLoopDeps } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  // Queue after the controller is set, before the first stream event.
  beforeNextTurn?: () => void;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    this.beforeNextTurn?.();
    this.beforeNextTurn = undefined;
    yield* this.turns[this.index++] ?? [];
  }
}

function makeLoop(
  provider: LLMProvider,
  overrides: Record<string, unknown> = {},
  configureTools?: (toolRegistry: ToolRegistry) => void,
): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createDynamicTool({
    name: "noop_tool",
    description: "no-op",
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", isError: false }),
  }),
  );
  configureTools?.(toolRegistry);
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({
    toolRegistry,
    ...overrides,
  }));
  (loop as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

function getHistory(loop: ConversationLoop) {
  return (loop as unknown as { history: { getMessages: () => Array<{ role: string; content: unknown }> };
    }).history.getMessages();
}

function cloneHistoryLikeAppliedCompaction(loop: ConversationLoop): void {
  const history = (loop as unknown as {
    history: {
      getMessages: () => GenericMessage[];
      restore: (messages: GenericMessage[]) => void;
    };
  }).history;
  history.restore(history.getMessages().map((message) => ({
    ...message,
    ...(message.meta ? { meta: { ...message.meta } } : {}),
  })),
  );
}

class DeferredGate<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

describe("ConversationLoop guidance queue + boundary inject", () => {
  it("queues guide text and injects it at the next round boundary (between tool rounds)", async () => {
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "보고를 시작합니다." } as StreamEvent,
        { type: "tool_call", id: "t1", name: "noop_tool", input: {},
        } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "방향 반영 결과." } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    provider.beforeNextTurn = () => {
    };
    const loop = makeLoop(provider);
    const injected: string[] = [];
    const dispositions: string[] = [];
    let injectedAckFinished = false;

    const turnPromise = loop.runTurn(
      "긴 보고서 만들어줘",
      { onGuidanceInjected: (t) => injected.push(t) },
      undefined,
      { ...userKeyboardTurn() },
    );
    await Promise.resolve();
    loop.queueGuidanceWithDisposition("더 짧게 요약", {
      onInjected: async () => {
        await Promise.resolve();
        dispositions.push("injected");
        injectedAckFinished = true;
      },
      onDropped: (reason) => dispositions.push(`dropped:${reason}`),
    });
    await turnPromise;

    expect(injected).toEqual(["더 짧게 요약"]);
    expect(dispositions).toEqual(["injected"]);
    expect(injectedAckFinished).toBe(true);
    const userMessages = getHistory(loop).filter((m) => m.role === "user");
    expect(
      userMessages.some(
        (m) =>
          typeof m.content === "string" && m.content.includes("더 짧게 요약"),
      ),
    ).toBe(true);
  });

  it("marks the injected row as host-minted, whoever the batch came from", async () => {
    // Stamp host injections so child reports cannot be mistaken for parent-authored text.
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "t1", name: "noop_tool", input: {} } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "done" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);

    const turnPromise = loop.runTurn("start", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    await Promise.resolve();
    loop.queueGuidance("mid-turn guide");
    await turnPromise;

    const injectedRow = getHistory(loop).find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("mid-turn guide"),
    ) as { meta?: { hostInjectionId?: string } } | undefined;
    expect(injectedRow?.meta?.hostInjectionId).toBeTruthy();
  });

  it("joins multiple queued utterances at the same boundary with blank-line separators", async () => {
    const provider = new FakeProvider([
      [
        {
          type: "tool_call",
          id: "t1",
          name: "noop_tool",
          input: {},
        } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "done" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    const injected: string[] = [];
    const turnPromise = loop.runTurn(
      "작업 시작",
      { onGuidanceInjected: (t) => injected.push(t) },
      undefined,
      { ...userKeyboardTurn() },
    );
    await Promise.resolve();
    loop.queueGuidance("첫번째 지시");
    loop.queueGuidance("두번째 지시");
    await turnPromise;

    expect(injected).toHaveLength(1);
    expect(injected[0]).toBe("첫번째 지시\n\n두번째 지시");
  });

  it("extends a 1-round turn by one round to deliver queued guide BEFORE end-turn", async () => {
    // Pending guidance must affect the turn before end_turn, subject to the round cap.
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "원래 답" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "수정 답" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    const injected: string[] = [];
    const dropped: string[] = [];
    const turnPromise = loop.runTurn(
      "질문",
      {
        onGuidanceInjected: (t) => injected.push(t),
        onGuidanceDropped: (t) => dropped.push(t),
      },
      undefined,
      { ...userKeyboardTurn() },
    );
    await Promise.resolve();
    loop.queueGuidance("더 짧게");
    await turnPromise;

    expect(injected).toEqual(["더 짧게"]);
    expect(dropped).toEqual([]);
  });

  it("propagates injected A2A provenance to receiver ApprovalGate on the next round", async () => {
    const provider = new FakeProvider([
      [
        {
          type: "tool_call",
          id: "t1",
          name: "noop_tool",
          input: {},
        } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        {
          type: "tool_call",
          id: "t2",
          name: "noop_tool",
          input: {},
        } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "done" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const dir = mkdtempSync(join(tmpdir(), "ave-a2a-guidance-gate-"));
    const permissionManager = new PermissionManager(
      join(dir, "permissions.json"),
    );
    permissionManager.setMode("allow");
    const approvalGate = {
      requestAndWait: vi.fn(async (request: { id: string }) => ({
        requestId: request.id,
        choice: "allow-once" as const,
      })),
    };
    const loop = makeLoop(provider, {
      permissionManager,
      approvalGate,
    });

    try {
      const turnPromise = loop.runTurn("start", undefined, undefined, {
        ...userKeyboardTurn(),
      });
      await Promise.resolve();
      expect(
        loop.queueGuidanceWithDisposition("[Sub-Agent: researcher] finished", {
          approvalReasonPrefix: "[Sub-Agent: researcher]",
        }),
      ).toBe("queued");
      await turnPromise;

      expect(approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
      expect(approvalGate.requestAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.stringContaining("[Sub-Agent: researcher]"),
          forceExplicit: true,
        }),
      );
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("gates intercepted request_plugin and tool_search calls with A2A provenance", async () => {
    const provider = new FakeProvider([
      [
        {
          type: "tool_call",
          id: "meta-1",
          name: "request_plugin",
          input: { pluginId: "missing" },
        } as StreamEvent,
        {
          type: "tool_call",
          id: "meta-2",
          name: "tool_search",
          input: { query: "noop_tool" },
        } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "done" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const approvalGate = {
      requestAndWait: vi.fn(async (request: { id: string }) => ({
        requestId: request.id,
        choice: "allow-once" as const,
      })),
    };
    const loop = makeLoop(provider, { approvalGate }, (toolRegistry) => {
      for (const name of ["request_plugin", "tool_search"]) {
        toolRegistry.register(
          createDynamicTool({
            name,
            description: name,
            source: "builtin",
            category: "read",
            isReadOnly: () => true,
            jsonSchema: { type: "object", properties: {} },
            execute: async () => ({
              output: "interception-regressed",
              isError: true,
            }),
          }),
        );
      }
    });

    await loop.runTurn("start", undefined, undefined, {
      inputOrigin: "agent-message",
      initialGuidance: "[Sub-Agent: researcher] delivered work",
      approvalReasonPrefix: "[Sub-Agent: researcher]",
    });

    expect(approvalGate.requestAndWait).toHaveBeenCalledTimes(2);
    const requests = approvalGate.requestAndWait.mock.calls.map(
      ([request]) => request,
    );
    expect(requests.map((request) => request.toolName).sort()).toEqual([
      "request_plugin",
      "tool_search",
    ]);
    for (const request of requests) {
      expect(request).toMatchObject({
        toolCategory: "meta",
      });
      expect(request.reason).toContain("[Sub-Agent: researcher]");
    }
  });
  it("rejects empty / oversized / no-active-turn cases by return code", () => {
    const provider = new FakeProvider([]);
    const loop = makeLoop(provider);
    expect(loop.queueGuidance("뭔가")).toBe("no-active-turn");
    (
      loop as { currentAbortController: AbortController | null }
    ).currentAbortController = new AbortController();
    expect(loop.queueGuidance("")).toBe("empty");
    expect(loop.queueGuidance("   \n\t  ")).toBe("empty");
    expect(loop.queueGuidance("a".repeat(8_001))).toBe("too-long");
    expect(loop.queueGuidance("ok")).toBe("queued");
  });

  it("queue-full rejection at GUIDE_MAX_ENTRIES (16)", () => {
    const loop = makeLoop(new FakeProvider([]));
    (
      loop as { currentAbortController: AbortController | null }
    ).currentAbortController = new AbortController();
    for (let i = 0; i < 16; i++) {
      expect(loop.queueGuidance(`g${i}`)).toBe("queued");
    }
    expect(loop.queueGuidance("overflow")).toBe("queue-full");
  });

  it("fires onGuidanceDropped when round-cap blocks the extension", async () => {
    // At the round cap, drop queued guidance visibly instead of silently losing it.
    const provider = new FakeProvider(endTurnScript("응답"));
    const loop = makeLoop(provider);
    const injected: string[] = [];
    const dropped: string[] = [];
    const dispositions: string[] = [];
    const turnPromise = loop.runTurn(
      "q",
      {
        onGuidanceInjected: (t) => injected.push(t),
        onGuidanceDropped: (t) => dropped.push(t),
      },
      undefined,
      { ...userKeyboardTurn(), maxRounds: 1 },
    );
    await Promise.resolve();
    loop.queueGuidanceWithDisposition("late", {
      onInjected: () => dispositions.push("injected"),
      onDropped: (reason) => dispositions.push(`dropped:${reason}`),
    });
    await turnPromise;

    expect(injected).toEqual([]);
    expect(dropped).toEqual(["late"]);
    expect(dispositions).toEqual(["dropped:turn-ended"]);
  });

  it("`hasActiveTurn()` reflects in-flight runTurn for IPC gate", async () => {
    const provider = new FakeProvider(endTurnScript("ok"));
    const loop = makeLoop(provider);
    expect(loop.hasActiveTurn()).toBe(false);
    const p = loop.runTurn("test", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    await p;
    expect(loop.hasActiveTurn()).toBe(false);
  });
  it("drops guidance queued during a deferred prompt denial and never leaks it into session B", async () => {
    const provider = new FakeProvider(endTurnScript("session B response"));
    const skillOverlay = { clear: vi.fn() };
    const loop = makeLoop(provider, { skillOverlay });
    const gate = new DeferredGate<{
      decision: "allow" | "deny";
      reason: string;
    }>();
    const gateEntered = new DeferredGate<void>();
    const promptSpy = vi
      .spyOn(loop, "fireUserPromptSubmit")
      .mockImplementation(() => {
        gateEntered.resolve(undefined);
        return gate.promise;
      });
    const disposition = vi.fn();
    const rendererDropped = vi.fn();

    const deniedTurn = loop.runTurn(
      "session A",
      { onGuidanceDropped: rendererDropped },
      undefined,
      { ...userKeyboardTurn() },
    );
    await gateEntered.promise;
    expect(
      loop.queueGuidanceWithDisposition("A-only guidance", {
        onDropped: disposition,
      }),
    ).toBe("queued");
    loop.turnAdditionalDirectories = ["temporary-grant"];
    gate.resolve({ decision: "deny", reason: "policy deny" });

    await expect(deniedTurn).resolves.toMatchObject({ stopReason: "blocked" });
    expect(disposition).toHaveBeenCalledTimes(1);
    expect(disposition).toHaveBeenCalledWith("turn-ended");
    expect(rendererDropped).toHaveBeenCalledTimes(1);
    expect(rendererDropped).toHaveBeenCalledWith("A-only guidance");
    expect(loop.guidanceQueue).toEqual([]);
    expect(loop.turnAdditionalDirectories).toEqual([]);
    expect(loop.hasActiveTurn()).toBe(false);

    promptSpy.mockResolvedValue({ decision: "allow", reason: "allowed" });
    const injectedInB = vi.fn();
    await loop.runTurn(
      "session B",
      { onGuidanceInjected: injectedInB },
      undefined,
      { ...userKeyboardTurn() },
    );

    expect(injectedInB).not.toHaveBeenCalled();
    expect(
      getHistory(loop).some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("A-only guidance"),
      ),
    ).toBe(false);
    // Turn cleanup must preserve the conversation-scoped read-skill registry.
    expect(skillOverlay.clear).not.toHaveBeenCalled();
  });

  it("cleans queued guidance when SessionStart throws before the prompt gate", async () => {
    const loop = makeLoop(new FakeProvider([]));
    const lifecycleGate = new DeferredGate<void>();
    const lifecycleEntered = new DeferredGate<void>();
    vi.spyOn(loop, "fireLifecycleEvent").mockImplementation(() => {
      lifecycleEntered.resolve(undefined);
      return lifecycleGate.promise;
    });
    const disposition = vi.fn();
    const rendererDropped = vi.fn();

    const turn = loop.runTurn(
      "session start failure",
      { onGuidanceDropped: rendererDropped },
      undefined,
      { ...userKeyboardTurn() },
    );
    await lifecycleEntered.promise;
    expect(
      loop.queueGuidanceWithDisposition("queued during SessionStart", {
        onDropped: disposition,
      }),
    ).toBe("queued");
    lifecycleGate.reject(new Error("SessionStart failure"));

    await expect(turn).rejects.toThrow("SessionStart failure");
    expect(disposition).toHaveBeenCalledTimes(1);
    expect(rendererDropped).toHaveBeenCalledTimes(1);
    expect(loop.guidanceQueue).toEqual([]);
    expect(loop.hasActiveTurn()).toBe(false);
  });

  it("cleans queued guidance when preflight throws before queryLoop", async () => {
    const loop = makeLoop(new FakeProvider([]));
    const preflightGate = new DeferredGate<boolean>();
    const preflightEntered = new DeferredGate<void>();
    vi.spyOn(loop, "runPreflightGuard").mockImplementation(() => {
      preflightEntered.resolve(undefined);
      return preflightGate.promise;
    });
    const disposition = vi.fn();
    const rendererDropped = vi.fn();

    const turn = loop.runTurn(
      "preflight failure",
      { onGuidanceDropped: rendererDropped },
      undefined,
      { ...userKeyboardTurn() },
    );
    await preflightEntered.promise;
    expect(
      loop.queueGuidanceWithDisposition("queued during preflight", {
        onDropped: disposition,
      }),
    ).toBe("queued");
    preflightGate.reject(new Error("preflight failure"));

    await expect(turn).rejects.toThrow("preflight failure");
    expect(disposition).toHaveBeenCalledTimes(1);
    expect(rendererDropped).toHaveBeenCalledTimes(1);
    expect(loop.guidanceQueue).toEqual([]);
    expect(loop.hasActiveTurn()).toBe(false);
  });

  it("drops drained guidance when its round-boundary preflight throws", async () => {
    const provider = new FakeProvider([
      [
        {
          type: "tool_call",
          id: "t1",
          name: "noop_tool",
          input: {},
        } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    const injectionPreflight = new DeferredGate<boolean>();
    const injectionPreflightEntered = new DeferredGate<void>();
    let preflightCalls = 0;
    vi.spyOn(loop, "runPreflightGuard").mockImplementation(() => {
      preflightCalls += 1;
      if (preflightCalls === 1) return Promise.resolve(false);
      injectionPreflightEntered.resolve(undefined);
      return injectionPreflight.promise;
    });
    const disposition = vi.fn();
    const rendererDropped = vi.fn();

    const turn = loop.runTurn(
      "injection preflight failure",
      { onGuidanceDropped: rendererDropped },
      undefined,
      { ...userKeyboardTurn() },
    );
    await Promise.resolve();
    expect(
      loop.queueGuidanceWithDisposition("drained before preflight", {
        onDropped: disposition,
      }),
    ).toBe("queued");
    await injectionPreflightEntered.promise;
    injectionPreflight.reject(new Error("injection preflight failure"));

    await expect(turn).rejects.toThrow("injection preflight failure");
    expect(disposition).toHaveBeenCalledTimes(1);
    expect(disposition).toHaveBeenCalledWith("turn-ended");
    expect(rendererDropped).toHaveBeenCalledTimes(1);
    expect(loop.guidanceQueue).toEqual([]);
    expect(
      getHistory(loop).some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("drained before preflight"),
      ),
    ).toBe(false);
  });

  it("acknowledges running guidance only after a successful provider round commit", async () => {
    const provider = new FakeProvider([
      [
        {
          type: "tool_call",
          id: "t1",
          name: "noop_tool",
          input: {},
        } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [{ type: "error", error: "synthetic provider failure" } as StreamEvent],
      [
        { type: "text_delta", text: "retry base response" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "retry consumed guidance" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    const injected = vi.fn();
    const dropped = vi.fn();
    const rendererInjected = vi.fn();
    const rendererDropped = vi.fn();

    const failedTurn = loop.runTurn(
      "first attempt",
      {
        onGuidanceInjected: rendererInjected,
        onGuidanceDropped: rendererDropped,
      },
      undefined,
      { ...userKeyboardTurn() },
    );
    await Promise.resolve();
    expect(
      loop.queueGuidanceWithDisposition("durable child result", {
        onInjected: injected,
        onDropped: dropped,
      }),
    ).toBe("queued");

    await expect(failedTurn).resolves.toMatchObject({
      stopReason: "stream-error",
    });
    expect(injected).not.toHaveBeenCalled();
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledWith("turn-ended");
    expect(rendererInjected).not.toHaveBeenCalled();
    expect(rendererDropped).toHaveBeenCalledTimes(1);
    expect(
      getHistory(loop).some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("durable child result"),
      ),
    ).toBe(false);

    const retriedTurn = loop.runTurn(
      "second attempt",
      { onGuidanceInjected: rendererInjected },
      undefined,
      { ...userKeyboardTurn() },
    );
    await Promise.resolve();
    expect(
      loop.queueGuidanceWithDisposition("durable child result", {
        onInjected: injected,
        onDropped: dropped,
      }),
    ).toBe("queued");
    await expect(retriedTurn).resolves.toMatchObject({
      stopReason: "end_turn",
    });

    expect(injected).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(rendererInjected).toHaveBeenCalledTimes(1);
    // Live injection bubbles must identify the same row as a reloaded transcript.
    expect(rendererInjected).toHaveBeenCalledWith(
      "durable child result",
      { messageId: expect.any(String) },
    );
    expect(
      getHistory(loop).filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("durable child result"),
      ),
    ).toHaveLength(1);
  });

  it("rolls back failed initialGuidance after an applied-compaction clone and retains one successful reinjection", async () => {
    const provider = new FakeProvider([
      [
        {
          type: "error",
          error: "initial guidance provider failure",
        } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "consumed" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    vi.spyOn(loop, "runPreflightGuard").mockImplementation(async () => {
      cloneHistoryLikeAppliedCompaction(loop);
      return true;
    });
    const initialGuidance = "[Sub-Agent: Researcher]\ndurable child result";

    await expect(
      loop.runTurn("parent request", undefined, undefined, {
        ...userKeyboardTurn(),
        initialGuidance,
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      }),
    ).resolves.toMatchObject({ stopReason: "stream-error" });
    expect(
      getHistory(loop).filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("durable child result"),
      ),
    ).toHaveLength(0);

    await expect(
      loop.runTurn("parent request", undefined, undefined, {
        ...userKeyboardTurn(),
        initialGuidance,
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });

    const guidanceHistory = getHistory(loop).filter(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("durable child result"),
    );
    expect(guidanceHistory).toHaveLength(1);
  });

  it("rolls back a drained mid-turn guide after an applied-compaction clone", async () => {
    // Compaction can replace the injected row before commit; removal must survive identity changes.
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "t1", name: "noop_tool", input: {} } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        { type: "error", error: "rate limited" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    const dropped = vi.fn();
    vi.spyOn(loop, "shouldAutoCompactForRateLimit").mockReturnValue(true);
    vi.spyOn(loop, "runPreflightGuard").mockImplementation(async (_ctx, _signal, _cb, options) => {
      if (options?.forceReason !== "rate-limit") return false;
      cloneHistoryLikeAppliedCompaction(loop);
      return true;
    });
    provider.beforeNextTurn = () => {
      loop.queueGuidanceWithDisposition("guide across a compaction", { onDropped: dropped });
    };

    await loop.runTurn("start the agent turn", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(
      getHistory(loop).filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("guide across a compaction"),
      ),
    ).toHaveLength(0);
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(loop.guidanceQueue).toEqual([]);
  });

  it("runs one preflight on a round that both drained a guide and crossed the threshold", async () => {
    // Guidance draining and round preflight must not both spend a compaction on the same round.
    process.env.AVE_DEV_PREFLIGHT_OVERRIDE = "1";
    try {
      const provider = new FakeProvider([
        [
          { type: "tool_call", id: "t1", name: "noop_tool", input: {} } as StreamEvent,
          { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
        ],
        [
          { type: "text_delta", text: "done" } as StreamEvent,
          { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
        ],
      ]);
      const loop = makeLoop(provider);
      const intraTurnCalls: boolean[] = [];
      vi.spyOn(loop, "runPreflightGuard").mockImplementation(async (_ctx, _signal, _cb, options) => {
        intraTurnCalls.push(options?.intraTurn === true);
        return false;
      });
      provider.beforeNextTurn = () => {
        loop.queueGuidance("adjust course");
      };

      await loop.runTurn("start the agent turn", undefined, undefined, {
        ...userKeyboardTurn(),
      });

      expect(intraTurnCalls.filter(Boolean)).toHaveLength(0);
      expect(intraTurnCalls.length).toBeGreaterThan(0);
    } finally {
      delete process.env.AVE_DEV_PREFLIGHT_OVERRIDE;
    }
  });

  it("rolls back a failed agent-message input after an applied-compaction clone and retains one successful retry", async () => {
    const provider = new FakeProvider([
      [
        {
          type: "error",
          error: "agent message provider failure",
        } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "consumed" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    vi.spyOn(loop, "runPreflightGuard").mockImplementation(async () => {
      cloneHistoryLikeAppliedCompaction(loop);
      return true;
    });
    const mailboxInput =
      "[Sub-Agent: Researcher]\ndurable autonomous wake result";

    await expect(
      loop.runTurn(mailboxInput, undefined, undefined, {
        inputOrigin: "agent-message",
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      }),
    ).resolves.toMatchObject({ stopReason: "stream-error" });
    expect(
      getHistory(loop).filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("durable autonomous wake result"),
      ),
    ).toHaveLength(0);

    await expect(
      loop.runTurn(mailboxInput, undefined, undefined, {
        inputOrigin: "agent-message",
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });

    expect(
      getHistory(loop).filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("durable autonomous wake result"),
      ),
    ).toHaveLength(1);
  });

  it.each([
    {
      label: "initialGuidance",
      input: "parent request",
      injectedText: "durable post-turn guidance",
      options: {
        ...userKeyboardTurn(),
        initialGuidance: "[Sub-Agent: Researcher]\ndurable post-turn guidance",
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      },
    },
    {
      label: "agent-message",
      input: "[Sub-Agent: Researcher]\ndurable post-turn wake result",
      injectedText: "durable post-turn wake result",
      options: {
        inputOrigin: "agent-message" as const,
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      },
    },
  ])(
    "durably rolls back $label when post-turn fails after saving the injected row",
    async ({ input, injectedText, options }) => {
      const dir = mkdtempSync(join(tmpdir(), "ave-host-injection-rollback-"));
      const memoryManager = new MemoryManager({ aveDir: dir });
      memoryManager.load();
      const provider = new FakeProvider(endTurnScript("completed before post-turn failure"));
      let dirtySnapshotSaved = false;
      const loop = makeLoop(provider, {
        memoryManager,
        postTurnHookChain: {
          run: async ({
            sessionId,
            messages,
          }: {
            sessionId: string;
            messages: GenericMessage[];
          }) => {
            expect(
              messages.some(
                (message) =>
                  typeof message.content === "string" &&
                  message.content.includes(injectedText),
              ),
            ).toBe(true);
            await memoryManager.saveSession(sessionId, messages);
            dirtySnapshotSaved = true;
            throw new Error("synthetic post-turn failure");
          },
        },
      });

      try {
        await expect(
          loop.runTurn(input, undefined, undefined, options),
        ).rejects.toThrow("synthetic post-turn failure");
        expect(dirtySnapshotSaved).toBe(true);

        const persisted = memoryManager.loadSession(loop.getSessionId()) ?? [];
        expect(
          persisted.some((message) => {
            if (message === null || typeof message !== "object") return false;
            const content = (message as { content?: unknown }).content;
            return (
              typeof content === "string" && content.includes(injectedText)
            );
          }),
        ).toBe(false);
        expect(
          getHistory(loop).some(
            (message) =>
              typeof message.content === "string" &&
              message.content.includes(injectedText),
          ),
        ).toBe(false);
      } finally {
        await cleanupTmpDir(dir);
      }
    },
  );
});
