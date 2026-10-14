/**
 * The system prompt is a reusable prefix: two consecutive turns of one session
 * send it byte-for-byte identical, even though the clock moved, the input
 * changed, and the memory notes ranked against that input differ. What does
 * change per turn travels as a request-only row after the conversation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { SystemPromptBuilder } from "../../prompts/system-prompt-builder.js";
import { makePromptMemorySource } from "../../prompts/__tests__/test-helpers.js";

class RecordingProvider implements LLMProvider {
  readonly vendor = "claude" as const;
  readonly requests: StreamTurnParams[] = [];

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.requests.push(input);
    yield { type: "text_delta", text: `answer ${this.requests.length}` };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

function makeLoop(provider: LLMProvider): ConversationLoop {
  const builder = new SystemPromptBuilder({
    memoryManager: makePromptMemorySource({
      getAgentsMd: () => "# Project rules",
      getPromptMemoryIndex: () => "- [Release](./release.md)",
      selectRelevantMemories: (query: string) => ({
        entries: [],
        context: query.length > 0 ? `note ranked for: ${query}` : "",
        usedTokens: 0,
      }),
    }),
    toolRegistry: new ToolRegistry(),
  });
  const loop = new ConversationLoop({
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: builder,
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
    disableSessionPersistence: true,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

const isRequestOnly = (m: GenericMessage) => m.meta?.requestOnly === true;

describe("system prompt stability across turns", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends identical system prompt bytes on two consecutive turns of one session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T09:30:05Z"));
    const provider = new RecordingProvider();
    const loop = makeLoop(provider);

    await loop.runTurn("plan the release budget", undefined, undefined, { inputOrigin: "user-keyboard" });
    vi.setSystemTime(new Date("2026-10-15T09:41:47Z"));
    await loop.runTurn("now draft the changelog", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(provider.requests).toHaveLength(2);
    const [first, second] = provider.requests as [StreamTurnParams, StreamTurnParams];
    expect(Buffer.from(second.systemPrompt, "utf8").equals(Buffer.from(first.systemPrompt, "utf8"))).toBe(true);
    expect(first.systemPrompt).not.toContain("Time:");
    expect(first.systemPrompt).not.toContain("note ranked for");
    expect(first.systemPrompt).not.toContain("<environment>");
  });

  it("carries the clock, environment and ranked notes in a trailing request-only row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T09:30:05Z"));
    const provider = new RecordingProvider();
    const loop = makeLoop(provider);

    await loop.runTurn("plan the release budget", undefined, undefined, { inputOrigin: "user-keyboard" });
    vi.setSystemTime(new Date("2026-10-15T09:41:47Z"));
    await loop.runTurn("now draft the changelog", undefined, undefined, { inputOrigin: "user-keyboard" });

    const [first, second] = provider.requests as [StreamTurnParams, StreamTurnParams];
    const firstTail = first.messages[first.messages.length - 1]!;
    const secondTail = second.messages[second.messages.length - 1]!;
    expect(isRequestOnly(firstTail)).toBe(true);
    expect(firstTail.content).toContain("<environment>");
    expect(firstTail.content).toContain("note ranked for: plan the release budget");
    expect(secondTail.content).toContain("note ranked for: now draft the changelog");
    // Minute precision: no seconds field before the offset.
    expect(String(firstTail.content)).toMatch(/Time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2} /);

    // The first turn's conversation rows are an exact prefix of the second
    // request: the per-turn row never entered history.
    const firstConversation = first.messages.filter((m) => !isRequestOnly(m));
    expect(second.messages.slice(0, firstConversation.length)).toEqual(firstConversation);
    expect(loop.history.getMessages().some(isRequestOnly)).toBe(false);
  });
});
