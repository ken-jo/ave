import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { TURN_SPAN_NAME } from "../telemetry/tracing.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { subscriptionTransportFailure } from "../../main/subscription-transport-error-diagnostics.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

let exporter: InMemorySpanExporter;
let spanProvider: TracerProvider;
beforeEach(() => {
  exporter = new InMemorySpanExporter();
  spanProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});
afterEach(async () => { await spanProvider.shutdown(); context.disable(); });

function steps() {
  return exporter.getFinishedSpans().flatMap(span => span.events)
    .filter(event => event.name === "ave.step");
}

function makeLoop(provider: LLMProvider) {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(
    createDynamicTool({
      name: "list_directory",
      description: "List files",
      source: "builtin",
      category: "read",
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      isReadOnly: () => true,
      execute: async () => ({ output: "src\npackage.json", isError: false }),
    }),
  );

  const loop = new ConversationLoop({
    tracer: spanProvider.getTracer("test"),
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system" },
    toolRegistry,
    memoryManager: {
      sessions: {
        saveSession: () => {},
        listSessions: () => [],
      },
    },
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

describe("conversation step spans", () => {
  it("drops transport diagnostics and user content at the span boundary", async () => {
    const diagnostics = subscriptionTransportFailure({ phase: "process-exit", kind: "process", exitCode: null, signal: "SIGKILL" });
    const loop = makeLoop(new FakeProvider([[{
      type: "error", error: "private-provider-error", classification: "subscription-chat-unavailable", providerError: diagnostics,
    }]]));
    await loop.runTurn("private-user-input", undefined, undefined, { ...userKeyboardTurn() });
    expect(steps()).toContainEqual(expect.objectContaining({ attributes: expect.objectContaining({ "ave.step": "LLM_STREAM_ERROR" }) }));
    const raw = JSON.stringify(steps());
    expect(raw).not.toContain("private-user-input");
    expect(raw).not.toContain("private-provider-error");
    expect(raw).not.toContain("providerError");
    expect(raw).not.toContain("request");
  });

  it("emits all canonical steps inside the same turn span with bounded scalar metadata", async () => {
    const loop = makeLoop(new FakeProvider([
      [
        { type: "reasoning_delta", text: "private-thought" },
        { type: "tool_call", id: "t1", name: "list_directory", input: { path: "private-path" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [{ type: "text_delta", text: "private-answer" }, { type: "message_complete", stopReason: "end_turn" }],
    ]));
    await loop.runTurn("private-prompt", undefined, undefined, { ...userKeyboardTurn() });
    const spans = exporter.getFinishedSpans();
    expect(spans.filter(span => span.name === TURN_SPAN_NAME)).toHaveLength(1);
    expect(spans.some(span => span.name === "ave.step")).toBe(false);
    const names = steps().map(event => event.attributes?.["ave.step"]);
    for (const name of ["REQUEST_ENTRY", "ROUTE_RESOLVE", "TURN_ORCHESTRATE", "HISTORY_APPEND", "PROMPT_ASSEMBLE", "LLM_STREAM", "REASONING_ACCUMULATE", "TOOL_EXECUTE", "ROUND_COMMIT", "POST_TURN"]) {
      expect(names).toContain(name);
    }
    expect(steps()).toContainEqual(expect.objectContaining({ attributes: expect.objectContaining({ "ave.step": "POST_TURN", "ave.step.toolCallCount": 1 }) }));
    expect(JSON.stringify(steps())).not.toContain("private-");
  });
});
