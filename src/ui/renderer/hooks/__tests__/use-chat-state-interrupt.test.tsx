import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChatState } from "../use-chat-state.js";
import type { AveApi } from "../../types.js";
import type { StreamEvent } from "../../../../lib/chat-stream-state.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";

function setup() {
  const { api, emitChatStream } = makeMockAveApi();
  const { result } = renderHook(() => useChatState(api as unknown as AveApi));
  const dispatch = (ev: StreamEvent) => act(() => emitChatStream(ev));
  return { result, dispatch };
}

describe("useChatState — a turn interrupted by the next send", () => {
  it("keeps the interrupted entry open until its own closing frame, which lands after the new question", () => {
    const { result, dispatch } = setup();

    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "partial answer" });
    act(() => result.current.markLastAssistantInterrupted());
    act(() => result.current.appendUserEntry("second"));

    expect(result.current.entries.map((e) => e.kind)).toEqual(["user", "assistant", "user"]);
    expect(result.current.entries[1]).toMatchObject({ interrupted: true, streaming: true });

    dispatch({ type: "done", streamId: 1 });

    expect(result.current.entries.map((e) => e.kind)).toEqual(["user", "assistant", "user"]);
    expect(result.current.entries[1]).toMatchObject({
      kind: "assistant",
      text: "partial answer",
      interrupted: true,
      streaming: false,
    });
  });
});
