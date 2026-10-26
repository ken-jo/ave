// Verify stream accumulation, tool grouping and completion through shared chat state.
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, waitFor, fireEvent } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { submitChatMessage } from "./helpers.js";


describe("Chat stream sequencing (Phase 3.2 regression net)", () => {
  it("text_delta events accumulate into the streaming assistant entry", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submitChatMessage(container, "ask");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitChatStream({ type: "text_delta", text: "Part A " });
      emitChatStream({ type: "text_delta", text: "Part B" });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Part A Part B");
    });
  });

  it("reasoning_delta events render a (collapsed) reasoning card", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submitChatMessage(container, "think");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitChatStream({ type: "reasoning_delta", text: "inner reasoning chain" });
    });
    await waitFor(() => {
      // Reasoning starts collapsed even while streaming; the header remains visible.
      expect(container.textContent).toContain("생각 중...");
      expect(container.textContent).not.toContain("inner reasoning chain");
    });
  });

  it("tool_start renders a tool group card for the tool call", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submitChatMessage(container, "use tool");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitChatStream({
        type: "tool_start",
        groupId: "g1",
        toolUseId: "t1",
        displayOrder: 0,
        name: "index_search",
        input: { query: "hello" },
      });
    });
    // Single tools render inline; unknown plugin names use generic labels.
    await waitFor(() => {
      expect(container.textContent).toContain("index search");
    });
  });

  it("assistant_round + done finalize the streaming entry", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submitChatMessage(container, "complete");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitChatStream({ type: "text_delta", text: "final text" });
      emitChatStream({
        type: "assistant_round",
        text: "final text",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({ type: "done" });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("final text");
      expect(container.textContent).not.toContain("응답을 작성하는 중...");
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
