// Exported traces may contain result sizes, never tool output.
import { describe, expect, it, vi } from "vitest";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import type { TurnDecisionEvent } from "../turn/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { TOOL_SPAN_PREFIX, TURN_SPAN_NAME } from "../telemetry/tracing.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider as ScriptedProvider } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

const SECRET_RESULT = "SECRET-TOOL-OUTPUT-THAT-MUST-NOT-BE-EXPORTED";

function toolThenAnswer(): StreamEvent[][] {
  return [
    [
      { type: "tool_call", id: "tu-1", name: "read_thing", input: { path: "src" } },
      { type: "message_complete", stopReason: "tool_use" },
    ],
    [
      { type: "text_delta", text: "answered" },
      { type: "message_complete", stopReason: "end_turn" },
    ],
  ];
}

function makeLoop(provider: LLMProvider, tracer?: unknown) {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createDynamicTool({
    name: "read_thing",
    description: "Read a thing",
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isReadOnly: () => true,
    execute: async () => ({ output: SECRET_RESULT, isError: false }),
  }));
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({
    toolRegistry,
    ...(tracer ? { tracer } : {}),
  }));
  (loop as unknown as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

function collectDecisions() {
  const decisions: TurnDecisionEvent[] = [];
  return {
    decisions,
    onDecision: (event: TurnDecisionEvent) => { decisions.push(event); },
  };
}

describe("ConversationLoop — loop decisions", () => {
  it("reports the tool batch it dispatched, with the sizes the branch turned on", async () => {
    const loop = makeLoop(new ScriptedProvider(toolThenAnswer()));
    const { decisions, onDecision } = collectDecisions();

    await loop.runTurn("go", { onDecision }, undefined, { ...userKeyboardTurn() });

    expect(decisions).toContainEqual(expect.objectContaining({
      kind: "tool_batch",
      branch: "single",
      data: expect.objectContaining({ size: 1, executable: 1 }),
    }));
  });

  it("counts the branches onto the turn summary so a reloaded transcript keeps them", async () => {
    const loop = makeLoop(new ScriptedProvider(toolThenAnswer()));
    const onTurnSummary = vi.fn();

    await loop.runTurn("go", { onTurnSummary }, undefined, { ...userKeyboardTurn() });

    expect(onTurnSummary).toHaveBeenCalledTimes(1);
    const summary = onTurnSummary.mock.calls[0][0] as {
      decisionCounts?: Record<string, number>;
    };
    expect(summary.decisionCounts?.tool_batch).toBe(1);
  });

  it("reports the round-cap exit with the budget that ended the turn", async () => {
    const loop = makeLoop(new ScriptedProvider(toolThenAnswer()));
    const { decisions, onDecision } = collectDecisions();

    await loop.runTurn("go", { onDecision }, undefined, {
      ...userKeyboardTurn(),
      maxRounds: 1,
    });

    expect(decisions).toContainEqual(expect.objectContaining({
      kind: "early_exit",
      branch: "round-cap",
      data: expect.objectContaining({ effectiveMaxRounds: 1 }),
    }));
  });

  it("does not change what the turn returns when nobody is listening", async () => {
    const withListener = await makeLoop(new ScriptedProvider(toolThenAnswer()))
      .runTurn("go", collectDecisions(), undefined, { ...userKeyboardTurn() });
    const withoutListener = await makeLoop(new ScriptedProvider(toolThenAnswer()))
      .runTurn("go", undefined, undefined, { ...userKeyboardTurn() });

    expect(withoutListener.text).toBe(withListener.text);
    expect(withoutListener.stopReason).toBe(withListener.stopReason);
  });
});

describe("ConversationLoop — turn tracing", () => {
  it("opens one turn span with the tool call nested under it, and no result text anywhere", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });
    const tracer = provider.getTracer("test");
    const loop = makeLoop(new ScriptedProvider(toolThenAnswer()), tracer);

    await loop.runTurn("go", {}, undefined, { ...userKeyboardTurn() });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const turnSpan = spans.find((span) => span.name === TURN_SPAN_NAME);
    const toolSpan = spans.find((span) => span.name === `${TOOL_SPAN_PREFIX}read_thing`);
    expect(turnSpan).toBeDefined();
    expect(toolSpan).toBeDefined();

    expect(toolSpan!.parentSpanContext?.spanId).toBe(turnSpan!.spanContext().spanId);
    expect(toolSpan!.attributes["gen_ai.tool.name"]).toBe("read_thing");
    expect(toolSpan!.attributes["gen_ai.tool.call.id"]).toBe("tu-1");
    expect(toolSpan!.attributes["ave.tool.source"]).toBe("builtin");
    expect(toolSpan!.attributes["ave.tool.category"]).toBe("read");
    expect(toolSpan!.attributes["ave.tool.is_error"]).toBe(false);
    expect(toolSpan!.attributes["ave.tool.result_chars"]).toBe(SECRET_RESULT.length);

    expect(turnSpan!.attributes["ave.session_id"]).toBe(loop.getSessionId());
    expect(turnSpan!.attributes["ave.input_origin"]).toBe("user-keyboard");
    expect(turnSpan!.attributes["ave.turn.stop_reason"]).toBe("end_turn");
    expect(turnSpan!.attributes["ave.turn.tool_count"]).toBe(1);
    expect(turnSpan!.attributes["ave.decision.tool_batch"]).toBe(1);

    const exported = JSON.stringify(spans.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
      status: span.status,
    })));
    expect(exported).not.toContain(SECRET_RESULT);
    await provider.shutdown();
  });

  it("records each decision as a span event on the turn span", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });
    const loop = makeLoop(new ScriptedProvider(toolThenAnswer()), provider.getTracer("test"));

    await loop.runTurn("go", {}, undefined, { ...userKeyboardTurn(), maxRounds: 1 });
    await provider.forceFlush();

    const turnSpan = exporter.getFinishedSpans()
      .find((span) => span.name === TURN_SPAN_NAME);
    expect(turnSpan!.events).toContainEqual(expect.objectContaining({
      name: "ave.decision",
      attributes: expect.objectContaining({
        "ave.decision.kind": "early_exit",
        "ave.decision.branch": "round-cap",
      }),
    }));
    await provider.shutdown();
  });
});
