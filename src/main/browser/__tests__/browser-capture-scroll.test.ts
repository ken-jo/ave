import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { captureScrollParameters } from "../browser-capture-scroll.js";

function scrollWorld(x = 0, y = 0) {
  const events = new EventTarget();
  const window = {
    addEventListener: vi.fn(events.addEventListener.bind(events)),
    removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    scrollTo: vi.fn((position: { left: number; top: number }) => { x = position.left; y = Math.min(100, position.top); }),
  };
  const scroll = (left: number, top: number): Promise<{ x: number; y: number }> => {
    const parameters = captureScrollParameters({ executionContextId: 1, x: left, y: top });
    return runInNewContext(`(${parameters.functionDeclaration})(left, top)`, {
      window, get scrollX() { return x; }, get scrollY() { return y; }, left, top,
    });
  };
  return { window, scroll, events };
}

describe("capture scroll completion", () => {
  it("does not release readback when coordinates change before scrolling completes", async () => {
    const { window, scroll, events } = scrollWorld();
    const pending = scroll(0, 80);
    let settled = false;
    void Promise.resolve(pending).then(() => { settled = true; });
    await Promise.resolve();
    expect(window.scrollTo).toHaveBeenCalledWith({ left: 0, top: 80, behavior: "instant" });
    expect(settled).toBe(false);
    events.dispatchEvent(new Event("scrollend"));
    await expect(pending).resolves.toEqual({ x: 0, y: 80 });
    expect(window.removeEventListener).toHaveBeenCalledOnce();
  });

  it.each([{ x: 0, y: 0, requested: 0 }, { x: 0, y: 100, requested: 200 }])(
    "finishes without an event when clamping leaves the scroll unchanged at $y",
    async ({ x, y, requested }) => {
      const { window, scroll } = scrollWorld(x, y);
      await expect(scroll(x, requested)).resolves.toEqual({ x, y });
      expect(window.removeEventListener).toHaveBeenCalledOnce();
    },
  );
});
