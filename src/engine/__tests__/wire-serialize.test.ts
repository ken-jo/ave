import { describe, it, expect } from "vitest";
import type { GenericMessage } from "../llm/types.js";
import { prepareMarkedToolResultsForWire } from "../wire-serialize.js";

describe("prepareMarkedToolResultsForWire", () => {
  it("returns reference-equal when no tool_result is marked", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok", toolCalls: [{ id: "t1", name: "search", input: {} }] },
      { role: "tool_result", toolUseId: "t1", toolName: "search", content: "raw output 200 chars".repeat(20) },
    ];
    const out = prepareMarkedToolResultsForWire(messages);
    expect(out).toBe(messages);
  });

  it("replaces marked tool_result content and excludes host metadata from the request", () => {
    const verbatim = "raw output 200 chars".repeat(50);
    const messages: GenericMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "search",
        content: verbatim,
        meta: { compactedAt: "2026-05-08T00:00:00.000Z" },
      },
    ];
    const out = prepareMarkedToolResultsForWire(messages);

    expect(out).not.toBe(messages);
    expect(out).toHaveLength(messages.length);

    const wireToolResult = out[1];
    expect(wireToolResult.role).toBe("tool_result");
    if (wireToolResult.role === "tool_result") {
      expect(wireToolResult.content).toContain("[tool_result stripped:");
      expect(wireToolResult.content).toContain("tool=search");
      expect(wireToolResult.content).toContain(`origLen=${verbatim.length}`);
      expect(wireToolResult.toolUseId).toBe("t1");
      expect(wireToolResult.toolName).toBe("search");
      expect(wireToolResult.meta).toBeUndefined();
    }

    const memoryToolResult = messages[1];
    if (memoryToolResult.role === "tool_result") {
      expect(memoryToolResult.content).toBe(verbatim);
      expect(memoryToolResult.content.length).toBe(verbatim.length);
      expect(memoryToolResult.meta?.serializedStub).toBeUndefined();
    }
  });

  it("preserves content while excluding host-only tool_result metadata", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "search",
        content: "verbatim short content",
      },
      {
        role: "tool_result",
        toolUseId: "t2",
        toolName: "edit",
        content: "another verbatim — no compactedAt",
        meta: { lock: true },
      },
    ];
    const out = prepareMarkedToolResultsForWire(messages);
    expect(out).not.toBe(messages);
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toEqual({
      role: "tool_result",
      toolUseId: "t2",
      toolName: "edit",
      content: "another verbatim — no compactedAt",
    });
    expect(messages[2]?.meta).toEqual({ lock: true });
  });

  it("keeps an existing serialized stub while excluding its host metadata", () => {
    const messages: GenericMessage[] = [
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "search",
        content: "[tool_result stripped: tool=search, origLen=12345]",
        meta: { compactedAt: "2026-05-08T00:00:00.000Z", serializedStub: true },
      },
    ];
    const out = prepareMarkedToolResultsForWire(messages);
    expect(out).not.toBe(messages);
    expect(out[0]).not.toBe(messages[0]);
    expect(out[0]?.meta).toBeUndefined();
    expect(out[0]?.content).toBe("[tool_result stripped: tool=search, origLen=12345]");
  });

  it("false-positive guard — tool output starting with stub prefix still converted when serializedStub not set", () => {
    // Stub-like content without serializedStub metadata is still unprocessed tool output.
    const trickContent = "[tool_result stripped: this is real tool output, not a stub]";
    const messages: GenericMessage[] = [
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "search",
        content: trickContent,
        meta: { compactedAt: "2026-05-08T00:00:00.000Z" },
      },
    ];
    const out = prepareMarkedToolResultsForWire(messages);
    expect(out).not.toBe(messages);
    const wireMsg = out[0];
    if (wireMsg.role === "tool_result") {
      expect(wireMsg.content).toContain(`origLen=${trickContent.length}`);
      expect(wireMsg.meta).toBeUndefined();
    }
  });

  it("transforms only tool_result roles (user/assistant unchanged)", () => {
    const messages: GenericMessage[] = [
      {
        role: "user",
        content: "verbatim user message",
        meta: { compactedAt: "2026-05-08T00:00:00.000Z" },
      },
      {
        role: "assistant",
        content: "verbatim assistant message",
        meta: { compactedAt: "2026-05-08T00:00:00.000Z" },
      },
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "search",
        content: "should be stubbed",
        meta: { compactedAt: "2026-05-08T00:00:00.000Z" },
      },
    ];
    const out = prepareMarkedToolResultsForWire(messages);

    expect(out[0].content).toBe("verbatim user message");
    expect(out[1].content).toBe("verbatim assistant message");
    const wireToolResult = out[2];
    if (wireToolResult.role === "tool_result") {
      expect(wireToolResult.content).toContain("[tool_result stripped:");
    }
  });
});
