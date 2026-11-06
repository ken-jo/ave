// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";

/** A scroll event is dispatched a frame after the offset changes. While a reply streams, the transcript can grow in that
 * frame, so the event of a bottom pin reports a gap. That gap is not the user leaving the bottom: only an offset that moved
 * up is. The geometry below replays what the e2e probe recorded (pin at 96 of 721, event read at 847). */

type Geometry = { scrollHeight: number; clientHeight: number };
type UseChatScroll = typeof import("../use-chat-scroll.js").useChatScroll;

function entries(count: number): ChatEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: index === 0 ? "user" : "assistant",
    text: `entry-${index}`,
    createdAt: index + 1,
  })) as unknown as ChatEntry[];
}

function installGeometry(geometry: Geometry): () => void {
  const proto = HTMLDivElement.prototype;
  const saved = (["scrollHeight", "clientHeight", "scrollTop"] as const).map(
    (name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const,
  );
  const tops = new WeakMap<object, number>();
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => geometry.scrollHeight });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => geometry.clientHeight });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get() {
      return tops.get(this) ?? 0;
    },
    set(value: number) {
      tops.set(this, Math.max(0, Math.min(value, Math.max(0, geometry.scrollHeight - geometry.clientHeight))));
    },
  });
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[name];
    }
  };
}

let useChatScroll: UseChatScroll;

function Transcript({ count, sessionId }: { count: number; sessionId: string }) {
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const { scrollViewportRef, showJumpToBottom } = useChatScroll({
    entries: entries(count),
    currentSessionId: sessionId,
    chatEndRef,
    viewMode: null,
    searchOpen: false,
    searchMatches: [],
    searchIdx: 0,
    hidden: false,
  });
  return (
    <div>
      <div ref={scrollViewportRef} data-testid="viewport">
        <div ref={chatEndRef} />
      </div>
      {showJumpToBottom ? <button type="button" data-testid="jump-to-bottom" /> : null}
    </div>
  );
}

let restoreGeometry: (() => void) | null = null;

beforeEach(async () => {
  // The saved-position store is module state; each case starts from a fresh one.
  vi.resetModules();
  ({ useChatScroll } = await import("../use-chat-scroll.js"));
  frames = new Map();
  let nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

let frames = new Map<number, FrameRequestCallback>();

/** Runs the animation frames queued so far, and any they queue, inside `act`. */
function flushFrames(): void {
  act(() => {
    for (let guard = 0; frames.size > 0 && guard < 20; guard++) {
      const pending = [...frames.values()];
      frames.clear();
      for (const cb of pending) cb(0);
    }
  });
}

afterEach(() => {
  restoreGeometry?.();
  restoreGeometry = null;
  vi.unstubAllGlobals();
});

describe("useChatScroll — bottom follow while a reply streams", () => {
  it("keeps following when the content grows before the pin's scroll event is dispatched", () => {
    const geometry: Geometry = { scrollHeight: 721, clientHeight: 625 };
    restoreGeometry = installGeometry(geometry);
    const { getByTestId, queryByTestId, rerender } = render(<Transcript count={2} sessionId="follow-race" />);
    const viewport = getByTestId("viewport");
    flushFrames();
    expect(viewport.scrollTop).toBe(96);

    // The next delta lands before the browser dispatches the scroll event of that pin.
    act(() => {
      geometry.scrollHeight = 847;
      viewport.dispatchEvent(new Event("scroll"));
    });
    flushFrames();
    expect(viewport.scrollTop).toBe(847 - 625);
    expect(queryByTestId("jump-to-bottom")).toBeNull();

    // And the stream keeps being followed afterwards.
    act(() => {
      geometry.scrollHeight = 973;
      rerender(<Transcript count={3} sessionId="follow-race" />);
    });
    flushFrames();
    expect(viewport.scrollTop).toBe(973 - 625);
    expect(queryByTestId("jump-to-bottom")).toBeNull();
  });

  it("stops following once the user scrolls up, and stream growth leaves the offset alone", () => {
    const geometry: Geometry = { scrollHeight: 2400, clientHeight: 600 };
    restoreGeometry = installGeometry(geometry);
    const { getByTestId, queryByTestId, rerender } = render(<Transcript count={2} sessionId="user-left" />);
    const viewport = getByTestId("viewport");
    flushFrames();
    expect(viewport.scrollTop).toBe(1800);

    act(() => {
      viewport.scrollTop = 1500;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(queryByTestId("jump-to-bottom")).not.toBeNull();

    act(() => {
      geometry.scrollHeight = 2600;
      rerender(<Transcript count={3} sessionId="user-left" />);
    });
    act(() => {
      viewport.dispatchEvent(new Event("scroll"));
    });
    flushFrames();
    expect(viewport.scrollTop).toBe(1500);
    expect(queryByTestId("jump-to-bottom")).not.toBeNull();
  });
});
