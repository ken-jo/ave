// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import { useChatScroll } from "../use-chat-scroll.js";

/** A tile that leaves the view is kept mounted but hidden (`display:none`), which zeroes its viewport's geometry and
 * `scrollTop`. Showing it again must put the transcript back where the user left it, not at the top or the bottom. */

const ENTRIES = [
  { kind: "user", text: "question", createdAt: 1 },
  { kind: "assistant", text: "answer", createdAt: 2 },
] as unknown as ChatEntry[];

type Geometry = { scrollHeight: number; clientHeight: number };

function installViewportGeometry(element: HTMLElement, geometry: Geometry): { scrollTop: () => number } {
  let top = 0;
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => geometry.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => geometry.clientHeight });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, Math.max(0, geometry.scrollHeight - geometry.clientHeight)));
    },
  });
  return { scrollTop: () => top };
}

function Transcript({ hidden }: { hidden: boolean }) {
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const { scrollViewportRef } = useChatScroll({
    entries: ENTRIES,
    currentSessionId: "session-hidden-restore",
    chatEndRef,
    viewMode: null,
    searchOpen: false,
    searchMatches: [],
    searchIdx: 0,
    hidden,
  });
  return (
    <div ref={scrollViewportRef} data-testid="viewport">
      <div ref={chatEndRef} />
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useChatScroll — a hidden tile shown again", () => {
  it("restores the position the user scrolled to before the tile was hidden", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const geometry: Geometry = { scrollHeight: 2400, clientHeight: 600 };
    // Geometry has to exist before the hook's layout effects measure it, so it is installed on the prototype for the first
    // commit and moved onto the element right after.
    const proto = HTMLDivElement.prototype;
    const restore = [
      Object.getOwnPropertyDescriptor(proto, "scrollHeight"),
      Object.getOwnPropertyDescriptor(proto, "clientHeight"),
    ];
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => geometry.scrollHeight });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => geometry.clientHeight });
    try {
      const { getByTestId, rerender } = render(<Transcript hidden={false} />);
      const viewport = getByTestId("viewport");
      const metrics = installViewportGeometry(viewport, geometry);

      act(() => {
        viewport.scrollTop = 720;
        viewport.dispatchEvent(new Event("scroll"));
      });
      expect(metrics.scrollTop()).toBe(720);

      // Hidden: display:none zeroes the geometry and the scroll offset.
      act(() => {
        geometry.scrollHeight = 0;
        geometry.clientHeight = 0;
        viewport.scrollTop = 0;
        rerender(<Transcript hidden={true} />);
      });
      // The browser can report the zeroing as a scroll; it must not be saved.
      act(() => {
        viewport.dispatchEvent(new Event("scroll"));
      });
      expect(metrics.scrollTop()).toBe(0);

      // Shown again: same transcript, same entries — only `hidden` changed.
      act(() => {
        geometry.scrollHeight = 2400;
        geometry.clientHeight = 600;
        rerender(<Transcript hidden={false} />);
      });
      expect(metrics.scrollTop()).toBe(720);
    } finally {
      for (const [index, name] of (["scrollHeight", "clientHeight"] as const).entries()) {
        const descriptor = restore[index];
        if (descriptor) Object.defineProperty(proto, name, descriptor);
        else delete (proto as unknown as Record<string, unknown>)[name];
      }
    }
  });
});
