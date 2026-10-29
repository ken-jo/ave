// Wire stubbing must bound per-round growth while keeping older results verbatim in memory.
import { afterEach, describe, expect, it } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import { estimateMessagesTokens } from "../auto-compact.js";
import type { LLMProvider, StreamEvent, StreamTurnParams,
} from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { makeBasicConversationLoopDeps } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

// Match the loop protect window so plateau assertions cross the same boundary.
const INTRA_TURN_PRESERVE_RECENT_RESULTS = 16;

class RecordingToolLoopProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  readonly perRoundWireTokens: number[] = [];

  constructor(private readonly toolRounds: number) {}

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.perRoundWireTokens.push(estimateMessagesTokens(input.messages));
    const round = this.index++;
    if (round < this.toolRounds) {
      yield { type: "text_delta", text: `round ${round}` };
      yield {
        type: "tool_call",
        id: `tu-${round}`,
        name: "probe",
        input: { n: round },
      };
      yield { type: "message_complete", stopReason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

class KimiSubscriptionToolLoopProvider extends RecordingToolLoopProvider {
  readonly subscriptionRuntime = { kind: "subscription", provider: "kimi-code" } as const;
}

describe("ConversationLoop intra-turn tool-result stubbing (issue #1171)", () => {
  afterEach(() => {
    delete process.env.AVE_DEV_PREFLIGHT_OVERRIDE;
  });

  it("plateaus per-round wire input after the protect window fills instead of growing monotonically", async () => {
    // Lower the threshold to activate stubbing before the protected window fills.
    process.env.AVE_DEV_PREFLIGHT_OVERRIDE = "2000";

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      createDynamicTool({
        name: "probe",
        description: "returns a sizeable result",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: { n: { type: "number" } } },
        execute: async () => ({
          output: "RESULT " + "x".repeat(400),
          isError: false,
        }),
      }),
    );

    const TOOL_ROUNDS = 24;
    const provider = new RecordingToolLoopProvider(TOOL_ROUNDS);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      toolRegistry,
      disableSessionPersistence: true,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("deep tool loop", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    const tokens = provider.perRoundWireTokens;
    expect(tokens.length).toBeGreaterThan(
      INTRA_TURN_PRESERVE_RECENT_RESULTS + 4,
    );

    // Once the protected window fills, stubbing must sharply reduce per-round token growth.
    const deltas = tokens.slice(1).map((t, i) => t - tokens[i]);
    const fillingDeltas = deltas.slice(
      2,
      INTRA_TURN_PRESERVE_RECENT_RESULTS - 2,
    );
    const stubbingDeltas = deltas.slice(-4);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const fillingSlope = avg(fillingDeltas);
    const stubbingSlope = avg(stubbingDeltas);

    expect(stubbingSlope).toBeLessThan(fillingSlope * 0.6);

    const noStubLastRound = tokens[0] + fillingSlope * (tokens.length - 1);
    const last = tokens[tokens.length - 1];
    expect(last).toBeLessThan(noStubLastRound);
  });

  it("uses the active Kimi subscription budget rather than an inactive API-key provider", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      createDynamicTool({
        name: "probe",
        description: "returns a sizeable result",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: { n: { type: "number" } } },
        // These results cross the selected model threshold but stay below the inactive provider threshold.
        execute: async () => ({
          output: "RESULT " + "x".repeat(4_000),
          isError: false,
        }),
      }),
    );

    const settings = {
      ...fakeLlmSettings({ provider: "claude", model: "claude-sonnet-4-6" }),
      activeChatRuntime: { kind: "subscription" as const, provider: "kimi-code" as const },
    };
    const provider = new KimiSubscriptionToolLoopProvider(17);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: {
        get: () => settings,
        getSecret: () => "test-key",
      },
      toolRegistry,
      disableSessionPersistence: true,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("deep tool loop", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    const history = (loop as unknown as {
      history: { getMessages: () => Array<{ role: string; meta?: { compactedAt?: string } }> };
    }).history.getMessages();
    expect(history.some((message) =>
      message.role === "tool_result" && message.meta?.compactedAt !== undefined,
    )).toBe(true);
  });
});
