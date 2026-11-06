// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import { useChatScroll, type ChatMessageRevealRequest } from "../use-chat-scroll.js";

const ENTRIES: ChatEntry[] = [
  { kind: "user", text: "source", messageId: "source-message", createdAt: 1 },
  { kind: "assistant", text: "answer", messageId: "answer-message", createdAt: 2 },
];
const TARGET: ChatMessageRevealRequest = { sessionId: "memory-source-session", messageId: "source-message", nonce: 1 };

function Transcript({ hidden = false, sessionId = TARGET.sessionId, target = TARGET, entries = ENTRIES, onHandled }: {
  hidden?: boolean;
  sessionId?: string;
  target?: ChatMessageRevealRequest;
  entries?: ChatEntry[];
  onHandled: (nonce: number) => void;
}) {
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const { scrollViewportRef } = useChatScroll({
    entries, currentSessionId: sessionId, chatEndRef, viewMode: null,
    searchOpen: false, searchMatches: [], searchIdx: 0, hidden,
    revealMessage: target, onMessageRevealHandled: onHandled,
  });
  return <div ref={scrollViewportRef} data-testid="viewport">
    {entries.map((entry, index) => <div key={index} data-chat-entry-index={index}>{entry.kind === "user" ? entry.text : "answer"}</div>)}
    <div ref={chatEndRef} />
  </div>;
}

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const scrollIntoView = vi.fn(function (this: HTMLElement) {
  if (this.parentElement) this.parentElement.scrollTop = 180;
});
function flushFrames() {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  });
}

beforeEach(() => {
  frames = new Map(); nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", { configurable: true, get: () => 2400 });
  Object.defineProperty(HTMLDivElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  scrollIntoView.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView;
  delete (HTMLDivElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  delete (HTMLDivElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

describe("message anchor navigation", () => {
  it("reveals the source message after restore and cancels the queued bottom pin", () => {
    const onHandled = vi.fn();
    const { getByTestId, rerender } = render(<Transcript onHandled={onHandled} />);
    flushFrames();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
    expect(scrollIntoView.mock.instances[0]?.getAttribute("data-chat-entry-index")).toBe("0");
    expect(getByTestId("viewport").scrollTop).toBe(180);
    expect(onHandled).toHaveBeenCalledWith(1);
    rerender(<Transcript onHandled={onHandled} entries={[...ENTRIES]} />);
    flushFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    rerender(<Transcript onHandled={onHandled} target={{ ...TARGET, nonce: 2 }} />);
    flushFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("waits for the correct visible session and leaves unrelated conversations alone", () => {
    const onHandled = vi.fn();
    const { rerender } = render(<Transcript onHandled={onHandled} sessionId="other-session" />);
    flushFrames();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(onHandled).not.toHaveBeenCalled();
    rerender(<Transcript onHandled={onHandled} hidden />);
    flushFrames();
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(<Transcript onHandled={onHandled} />);
    flushFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("retires a hidden request when the tile navigates away, and a missing message never jumps elsewhere", () => {
    const onHandled = vi.fn();
    const { rerender } = render(<Transcript onHandled={onHandled} hidden />);
    rerender(<Transcript onHandled={onHandled} sessionId="new-session" />);
    flushFrames();
    expect(onHandled).toHaveBeenCalledWith(1);
    rerender(<Transcript onHandled={onHandled} />);
    flushFrames();
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(<Transcript onHandled={onHandled} target={{ ...TARGET, nonce: 2, messageId: "deleted-message" }} />);
    flushFrames();
    expect(onHandled).toHaveBeenCalledWith(2);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
