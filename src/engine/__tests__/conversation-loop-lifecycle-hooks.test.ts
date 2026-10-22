/**
 * #811 milestone-2 — NON-BLOCKING lifecycle events fired from ConversationLoop.
 *
 * Spec ref: docs/architecture/hook-runtime-expansion-design.md §5.
 *
 * Covers the loop-side fire points:
 *   - SessionStart fires ONCE per session, on the first turn
 *   - Stop fires after the query loop resolves, with stopReason/toolCount/duration
 *   - a lifecycle hook deny does NOT change control flow (turn still completes)
 *   - back-compat: no scriptHookManager ⇒ no lifecycle dispatch, turn unchanged
 *
 * PreCompact/PostCompact loop fire points are covered by the manager-level
 * lifecycle test (`src/hooks/__tests__/lifecycle-hook-manager.test.ts`) plus the
 * preflight scenarios; here we focus on the per-turn SessionStart/Stop wiring.
 */
import { describe, expect, it, vi } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { MAX_STOP_HOOK_CONTINUATIONS } from "../turn/query-loop.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

function completeTurn(): StreamEvent[] {
  return [
    { type: "text_delta", text: "ok" },
    { type: "message_complete", stopReason: "end_turn" },
  ];
}

/** A stub manager whose lifecycle dispatch we can assert on. */
function stubManager(
  lifecycleDecision: "allow" | "deny" = "allow",
  /** #811 m2 — control the BLOCKING UserPromptSubmit dispatch behavior. */
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
        // The loop's fire helper must treat an unexpected throw as fail-closed.
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
  return new ConversationLoop({
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system", setActiveRolePrompt: vi.fn(),
    },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry,
    memoryManager: { saveSession: () => Promise.resolve(), listSessions: () => [], loadSessionMetadata: () => null,
    },
    disableSessionPersistence: true,
    ...(scriptHookManager ? { scriptHookManager } : {}),
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
}

describe("ConversationLoop — #811 m2 lifecycle events", () => {
  it("fires SessionStart once on the first turn, with sessionMeta", async () => {
    const provider = new FakeProvider([completeTurn(), completeTurn()]);
    const mgr = stubManager();
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("first", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    await loop.runTurn("second", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    const starts = mgr.runLifecycleEvent.mock.calls.filter((c) => c[0] === "SessionStart",
    );
    // SessionStart fires exactly once across two turns of the same session.
    expect(starts).toHaveLength(1);
    const [, sessionId, , payload] = starts[0];
    expect(typeof sessionId).toBe("string");
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

    await loop.runTurn("first", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    await loop.newConversation(); // resets sessionStartFiredFor → the next turn re-announces.
    await loop.runTurn("second", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    const starts = mgr.runLifecycleEvent.mock.calls.filter((c) => c[0] === "SessionStart",
    );
    expect(starts).toHaveLength(2);
  });

  it("fires Stop after each turn with stopReason + toolCount + durationMs", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const mgr = stubManager();
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard",
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
    const mgr = stubManager("deny"); // every lifecycle dispatch denies.
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    // No throw, and the turn returns its normal assistant text despite the deny.
    const result = await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    expect(result.text).toBe("ok");
    // Both SessionStart and Stop still fired (observe-only — deny ignored).
    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "SessionStart"),
    ).toBe(true);
    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "Stop")).toBe(true,
    );
  });

  it("back-compat: no scriptHookManager ⇒ no lifecycle dispatch, turn unchanged", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const loop = buildLoop(provider); // no manager
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    expect(result.text).toBe("ok");
  });
});

describe("ConversationLoop — Stop hook continuation", () => {
  type StopDispatch = { decision: "allow" | "deny"; reason: string; results: Array<{ blockFeedback?: string }> };
  const BLOCK: StopDispatch = { decision: "deny", reason: "hook blocked", results: [{ blockFeedback: "Run the focused tests first." }] };
  const ALLOW: StopDispatch = { decision: "allow", reason: "noop", results: [] };

  /** Every round ends cleanly; counts how often the model was asked. */
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
    const result = await loop.runTurn("finish the change", onError ? { onError } : undefined, signal, { inputOrigin: "user-keyboard" });
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

    const result = await loop.runTurn("hello", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    // The turn reached the LLM and returned its normal assistant text.
    expect(result.text).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
    // The blocking hook was dispatched with the prompt-shaped payload.
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
    // A provider that THROWS if streamTurn is ever called — proves queryLoop never runs.
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

    const result = await loop.runTurn("blocked term", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    expect(result.stopReason).toBe("blocked");
    expect(result.toolCalls).toEqual([]);
    // The refusal text surfaces the hook's reason; the LLM was never called.
    expect(result.text).toContain("policy: blocked term");
    expect(turns).not.toHaveBeenCalled();
    // Stop should NOT fire — the turn never started its query loop.
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

    const result = await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    // Fail-closed: an unexpected dispatch error refuses the turn.
    expect(result.stopReason).toBe("blocked");
    expect(result.text).toContain("fail-closed");
  });

  it("NO hooks (manager returns allow / no match) ⇒ turn proceeds (back-compat)", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const mgr = stubManager("allow", { mode: "allow" });
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    expect(result.text).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
  });

  it("no scriptHookManager ⇒ UserPromptSubmit never dispatched, turn proceeds (byte-identical to today)", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const loop = buildLoop(provider); // no manager at all
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    expect(result.text).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
  });
});
