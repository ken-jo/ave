// SessionStart and Stop are observe-only; dispatch denial must not change control flow.
import { describe, expect, it, vi } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { MAX_STOP_HOOK_CONTINUATIONS } from "../turn/query-loop.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider as FakeProvider } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

function completeTurn(): StreamEvent[] {
  return [
    { type: "text_delta", text: "ok" },
    { type: "message_complete", stopReason: "end_turn" },
  ];
}

function stubManager(
  lifecycleDecision: "allow" | "deny" = "allow",
  userPromptSubmit:
    | { mode: "allow" }
    | { mode: "deny"; reason?: string }
    | { mode: "throw" } = { mode: "allow" },
) {
  return {
    setTrustedHooks: vi.fn(),
    setTrustedRegistry: vi.fn(),
    size: () => 0,
    runPreToolUse: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [],
    })),
    runPostToolUse: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [],
    })),
    runPermissionRequest: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [],
    })),
    runLifecycleEvent: vi.fn(async () => ({
      decision: lifecycleDecision,
      reason: "lifecycle",
      results: [],
    })),
    runUserPromptSubmit: vi.fn(async () => {
      if (userPromptSubmit.mode === "throw") {
        // Unexpected blocking-hook throws must fail closed.
        throw new Error("ups dispatch boom");
      }
      if (userPromptSubmit.mode === "deny") {
        return {
          decision: "deny" as const,
          reason: userPromptSubmit.reason ?? "blocked by policy",
          results: [],
        };
      }
      return { decision: "allow" as const, reason: "no matching UserPromptSubmit hooks", results: [],
      };
    }),
  };
}

function buildLoop(
  provider: LLMProvider,
  scriptHookManager?: ReturnType<typeof stubManager>,
): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  return new ConversationLoop(makeBasicConversationLoopDeps({
    systemPromptBuilder: { build: () => "system", setActiveRolePrompt: vi.fn(),
    },
    toolRegistry,
    memoryManager: { saveSession: () => Promise.resolve(), listSessions: () => [], loadSessionMetadata: () => null,
    },
    disableSessionPersistence: true,
    ...(scriptHookManager ? { scriptHookManager } : {}),
  }));
}

describe("ConversationLoop — #811 m2 lifecycle events", () => {
  it("fires SessionStart once on the first turn, with sessionMeta", async () => {
    const provider = new FakeProvider([completeTurn(), completeTurn()]);
    const mgr = stubManager();
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("first", undefined, undefined, { ...userKeyboardTurn(),
    });
    await loop.runTurn("second", undefined, undefined, { ...userKeyboardTurn(),
    });

    const starts = mgr.runLifecycleEvent.mock.calls.filter((c) => c[0] === "SessionStart",
    );
    expect(starts).toHaveLength(1);
    const [, sessionId, , payload] = starts[0];
    expect(typeof sessionId).toBe("string");
    expect(payload).toMatchObject({ sessionSource: "startup" });
    expect((payload as { sessionMeta: Record<string, unknown> }).sessionMeta,
    ).toMatchObject({
      sessionKind: "main",
    });
  });

  it("re-fires SessionStart after newConversation() resets the once-per-session guard", async () => {
    const provider = new FakeProvider([completeTurn(), completeTurn()]);
    const mgr = stubManager();
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("first", undefined, undefined, { ...userKeyboardTurn(),
    });
    await loop.newConversation();
    await loop.runTurn("second", undefined, undefined, { ...userKeyboardTurn(),
    });

    const starts = mgr.runLifecycleEvent.mock.calls.filter((c) => c[0] === "SessionStart",
    );
    expect(starts).toHaveLength(2);
    expect((starts[1] as unknown[])[3]).toMatchObject({ sessionSource: "clear" });
  });

  it("fires Stop after each turn with stopReason + toolCount + durationMs", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const mgr = stubManager();
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("hi", undefined, undefined, { ...userKeyboardTurn(),
    });

    const stops = mgr.runLifecycleEvent.mock.calls.filter((c) => c[0] === "Stop",
    );
    expect(stops).toHaveLength(1);
    const payload = stops[0][3] as { stopReason?: string; toolCount: number; durationMs: number;
    };
    expect(payload.stopReason).toBe("end_turn");
    expect(payload.toolCount).toBe(0);
    expect(typeof payload.durationMs).toBe("number");
  });

  it("a lifecycle hook deny does NOT change control flow — the turn still completes", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const mgr = stubManager("deny");
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { ...userKeyboardTurn(),
    });
    expect(result.text).toBe("ok");
    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "SessionStart"),
    ).toBe(true);
    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "Stop")).toBe(true,
    );
  });

  it("back-compat: no scriptHookManager ⇒ no lifecycle dispatch, turn unchanged", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const loop = buildLoop(provider);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { ...userKeyboardTurn(),
    });
    expect(result.text).toBe("ok");
  });
});

describe("ConversationLoop — Stop hook continuation", () => {
  type StopDispatch = { decision: "allow" | "deny"; reason: string; results: Array<{ blockFeedback?: string }> };
  const BLOCK: StopDispatch = { decision: "deny", reason: "hook blocked", results: [{ blockFeedback: "Run the focused tests first." }] };
  const ALLOW: StopDispatch = { decision: "allow", reason: "noop", results: [] };

  function countingProvider() {
    const provider = {
      vendor: "openai" as const,
      calls: 0,
      async *streamTurn(): AsyncIterable<StreamEvent> {
        provider.calls += 1;
        yield { type: "text_delta", text: `answer ${provider.calls}` };
        yield { type: "message_complete", stopReason: "end_turn" };
      },
    };
    return provider;
  }

  function stopManager(stop: (call: number) => StopDispatch, stopEvent = "Stop") {
    const mgr = stubManager();
    let stops = 0;
    const runLifecycleEvent = vi.fn(async (event: string, _sessionId: string, _origin: string, _payload?: Record<string, unknown>) =>
      event === stopEvent ? stop(++stops) : ALLOW);
    return { ...mgr, runLifecycleEvent };
  }

  it("continues a sub-agent turn through SubagentStop and leaves its Stop observe-only", async () => {
    const provider = countingProvider();
    const mgr = stopManager((call) => (call === 1 ? BLOCK : ALLOW), "SubagentStop");
    const loop = buildLoop(provider, mgr as unknown as ReturnType<typeof stubManager>);
    (loop as { provider: LLMProvider | null }).provider = provider;
    const onDispatched = vi.fn();
    await loop.runTurn("child task", undefined, undefined, {
      inputOrigin: "llm-tool-arg", spawnDepth: 1, subagentStop: { agentId: "child-1", agentType: "worker", onDispatched },
    });
    expect(provider.calls).toBe(2);
    const events = mgr.runLifecycleEvent.mock.calls.map((c) => [c[0], c[3]?.stopHookActive]);
    expect(events.filter(([event]) => event === "SubagentStop")).toEqual([["SubagentStop", false], ["SubagentStop", true]]);
    expect(events.filter(([event]) => event === "Stop")).toHaveLength(1);
    expect(onDispatched).toHaveBeenCalled();
  });

  async function run(provider: LLMProvider, mgr: ReturnType<typeof stopManager>, signal?: AbortSignal, onError?: (message: string) => void) {
    const loop = buildLoop(provider, mgr as unknown as ReturnType<typeof stubManager>);
    (loop as { provider: LLMProvider | null }).provider = provider;
    const result = await loop.runTurn("finish the change", onError ? { onError } : undefined, signal, { ...userKeyboardTurn() });
    const stops = mgr.runLifecycleEvent.mock.calls.filter((c) => c[0] === "Stop");
    return { loop, result, stops };
  }

  it("continues once on a block, feeding the reason back as the next input", async () => {
    const provider = countingProvider();
    const { loop, result, stops } = await run(provider, stopManager((call) => (call === 1 ? BLOCK : ALLOW)));
    expect(provider.calls).toBe(2);
    expect(result).toMatchObject({ text: "answer 2", stopReason: "end_turn" });
    expect(stops).toHaveLength(2);
    const feedback = loop.history.getMessages().filter((m) => m.meta?.displayText === "Run the focused tests first.");
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({ role: "user", meta: { hostInjectionId: expect.any(String) } });
  });

  it("sets stopHookActive only while a continuation is in progress", async () => {
    const { stops } = await run(countingProvider(), stopManager((call) => (call === 1 ? BLOCK : ALLOW)));
    expect(stops.map((c) => c[3]?.stopHookActive)).toEqual([false, true]);
  });

  it("stops at the continuation cap and surfaces a notice", async () => {
    const provider = countingProvider();
    const onError = vi.fn();
    const { result, stops } = await run(provider, stopManager(() => BLOCK), undefined, onError);
    expect(provider.calls).toBe(MAX_STOP_HOOK_CONTINUATIONS + 1);
    expect(stops).toHaveLength(MAX_STOP_HOOK_CONTINUATIONS + 1);
    expect(result.stopReason).toBe("end_turn");
    expect(onError.mock.calls.map((c) => c[0])).toEqual([expect.stringContaining(String(MAX_STOP_HOOK_CONTINUATIONS))]);
  });

  it("does not continue when the turn is cancelled during the stop hook", async () => {
    const provider = countingProvider();
    const controller = new AbortController();
    await run(provider, stopManager(() => { controller.abort(); return BLOCK; }), controller.signal);
    expect(provider.calls).toBe(1);
  });

  it("ends normally on an allow or a hook failure", async () => {
    for (const outcome of [ALLOW, { decision: "deny" as const, reason: "hook exited non-zero (1)", results: [{}] }]) {
      const provider = countingProvider();
      const { result, stops } = await run(provider, stopManager(() => outcome));
      expect(provider.calls).toBe(1);
      expect(stops).toHaveLength(1);
      expect(result).toMatchObject({ text: "answer 1", stopReason: "end_turn" });
    }
  });
});

describe("ConversationLoop — #811 m2 UserPromptSubmit (BLOCKING, fail-closed)", () => {
  it("an ALLOWING UserPromptSubmit hook → the turn proceeds (queryLoop runs)", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const mgr = stubManager("allow", { mode: "allow" });
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hello", undefined, undefined, { ...userKeyboardTurn(),
    });
    expect(result.text).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
    expect(mgr.runUserPromptSubmit).toHaveBeenCalledTimes(1);
    const [sessionId, trustOrigin, payload] = mgr.runUserPromptSubmit.mock.calls[0];
    expect(typeof sessionId).toBe("string");
    expect(trustOrigin).toBe("unknown");
    expect(payload).toMatchObject({
      inputText: "hello",
      inputOrigin: "user-keyboard",
      route: "llm",
      classification: "general",
    });
  });

  it("a DENYING UserPromptSubmit hook REFUSES the turn — queryLoop NOT entered, blocked result", async () => {
    const turns = vi.fn(() => completeTurn());
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn() {
        turns();
        throw new Error("queryLoop must NOT run when the prompt is refused");
      },
    };
    const mgr = stubManager("allow", { mode: "deny", reason: "policy: blocked term",
    });
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("blocked term", undefined, undefined, { ...userKeyboardTurn(),
    });
    expect(result.stopReason).toBe("blocked");
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toContain("policy: blocked term");
    expect(turns).not.toHaveBeenCalled();
    // Stop must not fire when the query loop never started.
    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "Stop")).toBe(false,
    );
  });

  it("a UserPromptSubmit dispatch THROW → fail-closed (turn refused, NOT allowed)", async () => {
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn() {
        throw new Error("queryLoop must NOT run when dispatch fails closed");
      },
    };
    const mgr = stubManager("allow", { mode: "throw" });
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { ...userKeyboardTurn(),
    });
    expect(result.stopReason).toBe("blocked");
    expect(result.text).toContain("fail-closed");
  });

  it("NO hooks (manager returns allow / no match) ⇒ turn proceeds (back-compat)", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const mgr = stubManager("allow", { mode: "allow" });
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { ...userKeyboardTurn(),
    });
    expect(result.text).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
  });

  it("no scriptHookManager ⇒ UserPromptSubmit never dispatched, turn proceeds (byte-identical to today)", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const loop = buildLoop(provider);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { ...userKeyboardTurn(),
    });
    expect(result.text).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
  });
});
