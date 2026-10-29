// Every streamed turn announces its input once so non-submitting surfaces can render the same row.
import { describe, expect, it, vi } from "vitest";
import type { PlatformConversationEvent } from "../../../engine/conversation-platform-protocol.js";
import { runStreamedTurn } from "../chat-stream.js";
import { userKeyboardTurn } from "../../../__tests__/support/user-keyboard-turn.js";
import { makeLoop } from "./chat-stream-test-helpers.js";

function eventsOf(sink: ReturnType<typeof vi.fn>): PlatformConversationEvent[] {
  return sink.mock.calls.map((call) => call[0] as PlatformConversationEvent);
}

describe("runStreamedTurn user.message emission", () => {
  it("publishes the turn input with its host-resolved origin right after turn.started", async () => {
    const { loop } = makeLoop();
    const sink = vi.fn();

    await runStreamedTurn(loop, "안녕, 데스크톱", sink, {
      inputOrigin: "platform-bridge",
    });

    const events = eventsOf(sink);
    expect(events[0]).toEqual({ kind: "turn.started" });
    expect(events[1]).toMatchObject({
      kind: "user.message",
      origin: "platform-bridge",
      ownerDetail: { text: "안녕, 데스크톱" },
    });
    const announced = events[1] as { ownerDetail: { messageId?: unknown } };
    expect(typeof announced.ownerDetail.messageId).toBe("string");
  });

  it("emits uniformly for desktop keyboard turns too — one stream, two origins", async () => {
    const { loop } = makeLoop();
    const sink = vi.fn();

    await runStreamedTurn(loop, "local question", sink, userKeyboardTurn());

    expect(eventsOf(sink)).toContainEqual(expect.objectContaining({
      kind: "user.message",
      origin: "user-keyboard",
      ownerDetail: expect.objectContaining({ text: "local question" }),
    }));
  });

  it("prefers the caller-supplied displayText so folded replay rows keep what the user saw", async () => {
    const { loop } = makeLoop();
    const sink = vi.fn();

    await runStreamedTurn(loop, "summarize [Resource #1]\n<fenced resource body>", sink, {
      ...userKeyboardTurn(),
      displayText: "summarize [Resource #1]",
    });

    expect(eventsOf(sink)).toContainEqual(expect.objectContaining({
      kind: "user.message",
      origin: "user-keyboard",
      ownerDetail: expect.objectContaining({ text: "summarize [Resource #1]" }),
    }));
  });
});
