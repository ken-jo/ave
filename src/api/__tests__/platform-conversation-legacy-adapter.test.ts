import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import { createPlatformConversationTimeline } from "../../engine/conversation-platform-protocol.js";
import {
  createPlatformConversationLegacyStreamAdapter,
  createPlatformTurnId,
  createLegacyChatStreamEventSink,
} from "../platform-conversation-legacy-adapter.js";

describe("platform conversation legacy adapter", () => {
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
    sink({ kind: "user.message", origin: "user-keyboard", ownerDetail: { text: "hello", messageId: "row-1" } });
    sink({ kind: "assistant.text.delta", text: "answer" });

    expect(send).toHaveBeenNthCalledWith(1, CHANNELS.sidechat.stream, {
      streamId: 9, type: "user_message", sessionId: "side-session",
      sendRequestId: "side-request",
      origin: "user-keyboard", text: "hello", messageId: "row-1",
    });
    expect(send).toHaveBeenNthCalledWith(2, CHANNELS.sidechat.stream, {
      streamId: 9, type: "text_delta", text: "answer",
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
