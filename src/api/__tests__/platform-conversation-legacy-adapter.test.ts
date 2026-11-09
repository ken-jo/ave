import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import { createPlatformConversationTimeline, createPlatformConversationEventSink } from "../../engine/conversation-platform-protocol.js";
import { applyToolStart, applyTranscriptFrame, type ChatStreamEvent } from "../../lib/chat-stream-state.js";
import {
  createPlatformConversationLegacyStreamAdapter,
  createPlatformTurnId,
  createLegacyChatStreamEventSink,
} from "../platform-conversation-legacy-adapter.js";

describe("platform conversation legacy adapter", () => {
  it("preserves project work revocation in the terminal owner frame", () => {
    const sink = vi.fn();
    const send = createLegacyChatStreamEventSink(sink, { streamId: 7 });
    send({ kind: "turn.completed", projectWorkRevoked: true });
    expect(sink).toHaveBeenCalledWith(CHANNELS.chat.stream, { type: "done", streamId: 7, projectWorkRevoked: true });
    const timeline = createPlatformConversationTimeline();
    createPlatformConversationLegacyStreamAdapter(timeline).subscribe(sink);
    timeline.publish({
      conversationId: "removed-project-session",
      turnId: createPlatformTurnId(8),
      event: { kind: "turn.completed", projectWorkRevoked: true },
    });
    expect(sink).toHaveBeenLastCalledWith(CHANNELS.chat.stream, { type: "done", streamId: 8, projectWorkRevoked: true });
  });
  it("fans one semantic timeline event out as the exact existing owner frame", () => {
    const timeline = createPlatformConversationTimeline();
    const electron = createPlatformConversationLegacyStreamAdapter(timeline);
    const sse = createPlatformConversationLegacyStreamAdapter(timeline);
    const electronSink = vi.fn();
    const sseSink = vi.fn();
    electron.subscribe(electronSink);
    sse.subscribe(sseSink);

    timeline.publish({
      conversationId: "main-session",
      turnId: createPlatformTurnId(41),
      event: {
        kind: "tool.started",
        tool: {
          name: "read_file",
          groupId: "group-1",
          toolUseId: "tool-1",
          displayOrder: 2,
          category: "read",
        },
        ownerDetail: { input: { path: "C:/workspace/readme.md" } },
      },
    });

    const expected = {
      streamId: 41,
      type: "tool_start",
      name: "read_file",
      groupId: "group-1",
      toolUseId: "tool-1",
      displayOrder: 2,
      toolCategory: "read",
      input: { path: "C:/workspace/readme.md" },
    };
    expect(electronSink).toHaveBeenCalledWith(CHANNELS.chat.stream, expected);
    expect(sseSink).toHaveBeenCalledWith(CHANNELS.chat.stream, expected);
  });

  it("carries a browser tool's display thumbnail from tool.completed onto the renderer tool entry", () => {
    const timeline = createPlatformConversationTimeline();
    const adapter = createPlatformConversationLegacyStreamAdapter(timeline);
    const sink = vi.fn();
    adapter.subscribe(sink);
    const browserPreview = { dataUrl: "data:image/jpeg;base64,QUdFTlQ=", width: 320, height: 180 };
    const tool = { name: "browser_snapshot", groupId: "group-1", toolUseId: "tool-1", displayOrder: 0 };
    timeline.publish({
      conversationId: "main-session",
      turnId: createPlatformTurnId(43),
      event: { kind: "tool.completed", tool, isError: false, durationMs: 5, ownerDetail: { result: "outline", browserPreview } },
    });
    const frame = sink.mock.calls[0]![1] as ChatStreamEvent;
    expect(frame).toMatchObject({ type: "tool_end", toolUseId: "tool-1", browserPreview });
    const entries = applyTranscriptFrame(applyToolStart([], { groupId: "group-1", toolUseId: "tool-1", name: "browser_snapshot" }), frame);
    expect(entries[0]).toMatchObject({ kind: "tool_group", tools: [{ status: "done", browserPreview }] });
  });

  it("fans live tool output out as a tool_output owner frame", () => {
    const timeline = createPlatformConversationTimeline();
    const adapter = createPlatformConversationLegacyStreamAdapter(timeline);
    const sink = vi.fn();
    adapter.subscribe(sink);

    timeline.publish({
      conversationId: "main-session",
      turnId: createPlatformTurnId(42),
      event: {
        kind: "tool.output.delta",
        tool: { name: "bash", groupId: "group-1", toolUseId: "tool-1", displayOrder: 0, category: "shell" },
        ownerDetail: { text: "compiling 3/10\n" },
      },
    });

    expect(sink).toHaveBeenCalledWith(CHANNELS.chat.stream, {
      streamId: 42,
      type: "tool_output",
      name: "bash",
      groupId: "group-1",
      toolUseId: "tool-1",
      displayOrder: 0,
      toolCategory: "shell",
      text: "compiling 3/10\n",
    });
  });

  it("projects the turn-input event as an owner user_message frame with its origin", () => {
    const timeline = createPlatformConversationTimeline();
    const adapter = createPlatformConversationLegacyStreamAdapter(timeline);
    const sink = vi.fn();
    adapter.subscribe(sink);

    timeline.publish({
      conversationId: "main-session",
      turnId: createPlatformTurnId(7),
      event: {
        kind: "user.message",
        origin: "platform-bridge",
        ownerDetail: { text: "bridge-submitted input", messageId: "row-bridge" },
      },
    });

    expect(sink).toHaveBeenCalledWith(CHANNELS.chat.stream, {
      streamId: 7,
      type: "user_message",
      text: "bridge-submitted input",
      origin: "platform-bridge",
      messageId: "row-bridge",
    });
  });

  it("projects the accepted request id only onto its owner prelude", () => {
    const timeline = createPlatformConversationTimeline();
    const adapter = createPlatformConversationLegacyStreamAdapter(timeline);
    const send = vi.fn();
    adapter.subscribe(send);
    const sink = createPlatformConversationEventSink(timeline, {
      conversationId: "main-session", turnId: createPlatformTurnId(8), sendRequestId: "queued-request",
    });
    sink({ kind: "user.message", origin: "queue-auto", ownerDetail: { text: "queued", messageId: "row-queue" } });
    sink({ kind: "assistant.text.delta", text: "answer" });
    expect(send).toHaveBeenNthCalledWith(1, CHANNELS.chat.stream, expect.objectContaining({ type: "user_message", sendRequestId: "queued-request" }));
    expect(send.mock.calls[1]?.[1]).not.toHaveProperty("sendRequestId");
  });

  it("keeps a pre-turn redaction notice compatible without inventing a stream id", () => {
    const timeline = createPlatformConversationTimeline();
    const adapter = createPlatformConversationLegacyStreamAdapter(timeline);
    const sink = vi.fn();
    adapter.subscribe(sink);

    timeline.publish({
      conversationId: "main-session",
      event: {
        kind: "privacy.redacted",
        count: 1,
        byKind: { email: 1 },
      },
    });

    expect(sink).toHaveBeenCalledWith(CHANNELS.chat.stream, {
      type: "redact_notice",
      count: 1,
      byKind: { email: 1 },
    });
  });

  it("announces the host's side-chat session on the existing user prelude only", () => {
    const send = vi.fn();
    const sink = createLegacyChatStreamEventSink(send, {
      streamId: 9,
      sessionId: "side-session",
      sendRequestId: "side-request",
      streamChannel: CHANNELS.sidechat.stream,
      fallbackChannel: CHANNELS.sidechat.fallback,
    });
    sink({ kind: "user.message", origin: "user-keyboard", ownerDetail: { text: "hello", messageId: "row-1", sendRequestId: "semantic-request" } });
    sink({ kind: "assistant.text.delta", text: "answer" });
    sink({ kind: "model.fallback", from: "primary/model-a", to: "secondary/model-b" });

    expect(send).toHaveBeenNthCalledWith(1, CHANNELS.sidechat.stream, {
      streamId: 9, type: "user_message", sessionId: "side-session",
      sendRequestId: "side-request",
      origin: "user-keyboard", text: "hello", messageId: "row-1",
    });
    expect(send).toHaveBeenNthCalledWith(2, CHANNELS.sidechat.stream, {
      streamId: 9, type: "text_delta", text: "answer",
    });
    expect(send).toHaveBeenNthCalledWith(3, CHANNELS.sidechat.fallback, {
      streamId: 9, from: "primary/model-a", to: "secondary/model-b",
    });
  });

  it("unsubscribes from the timeline when no owner surface remains", () => {
    const timeline = createPlatformConversationTimeline();
    const adapter = createPlatformConversationLegacyStreamAdapter(timeline);
    const first = adapter.subscribe(vi.fn());
    const second = adapter.subscribe(vi.fn());
    expect(timeline.subscriberCount()).toBe(1);

    first();
    expect(timeline.subscriberCount()).toBe(1);
    second();
    second();
    expect(timeline.subscriberCount()).toBe(0);
  });
});


describe("compaction failure owner delivery", () => {
  it("projects a nonterminal notice using the owning turn identity", () => {
    const timeline = createPlatformConversationTimeline();
    const adapter = createPlatformConversationLegacyStreamAdapter(timeline);
    const sink = vi.fn();
    adapter.subscribe(sink);
    timeline.publish({ conversationId: "main-session", turnId: createPlatformTurnId(42), event: { kind: "compaction.failed" } });
    expect(sink).toHaveBeenCalledExactlyOnceWith(CHANNELS.chat.stream, { streamId: 42, type: "compact_failed" });
  });
});
