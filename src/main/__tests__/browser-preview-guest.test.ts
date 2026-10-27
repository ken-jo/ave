import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreencastClosedError } from "../../observation/browser-screencast.js";
import { isUniformJpeg, startBrowserPreview, type PreviewGuest } from "../browser-observation-preview.js";

function guest(attached = true) {
  const debuggerEmitter = Object.assign(new EventEmitter(), {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => { throw new Error("A preview must never attach a debugger"); }),
    sendCommand: vi.fn((_method: string, _params?: object) => new Promise<unknown>(() => {})),
  });
  const contents = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, debugger: debuggerEmitter });
  return contents;
}
const callbacks = () => ({ frame: vi.fn(), updating: vi.fn(), ended: vi.fn(), isBlank: () => false });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("agent browser preview guest wiring", () => {
  it("uses only the agent's existing in-process page session", () => {
    const detached = guest(false);
    expect(() => startBrowserPreview(detached as unknown as PreviewGuest, callbacks())).toThrow("agent's page session");
    expect(detached.debugger.attach).not.toHaveBeenCalled();
    expect(detached.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it("re-arms on main-frame commit and ignores same-document navigation", async () => {
    const contents = guest();
    contents.debugger.sendCommand.mockImplementation(async () => ({}));
    const handle = startBrowserPreview(contents as unknown as PreviewGuest, callbacks());
    contents.emit("did-navigate-in-page");
    contents.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(0);
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method))
      .toEqual(["Page.startScreencast", "Page.stopScreencast", "Page.startScreencast"]);
    await handle.stop();
    expect(contents.listenerCount("did-navigate")).toBe(0);
    expect(contents.listenerCount("destroyed")).toBe(0);
    expect(contents.debugger.listenerCount("message")).toBe(0);
    expect(contents.debugger.listenerCount("detach")).toBe(0);
  });

  it.each([
    ["debugger detach", (contents: ReturnType<typeof guest>) => contents.debugger.emit("detach", {}, "target closed"), "target closed"],
    ["guest destruction", (contents: ReturnType<typeof guest>) => contents.emit("destroyed"), "target-destroyed"],
  ])("ends at once on %s while commands are still unanswered", async (_name, close, reason) => {
    const contents = guest();
    const observed = callbacks();
    startBrowserPreview(contents as unknown as PreviewGuest, observed);
    expect(contents.debugger.sendCommand).toHaveBeenCalledOnce();
    close(contents);
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.ended).toHaveBeenCalledOnce();
    expect(observed.ended.mock.calls[0]![0]).toBeInstanceOf(ScreencastClosedError);
    expect((observed.ended.mock.calls[0]![0] as Error).message).toContain(reason);
    expect(vi.getTimerCount()).toBe(0);
    expect(contents.listenerCount("did-navigate")).toBe(0);
  });

  it("classifies uniform blank or black paints, and not real pages", () => {
    const bitmap = (pixel: (x: number, y: number) => number) => {
      const width = 48; const height = 30; const data = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.fill(pixel(x, y), (y * width + x) * 4, (y * width + x) * 4 + 3);
      return { bitmap: data, width, height };
    };
    expect(isUniformJpeg("AA==", () => bitmap(() => 0))).toBe(true);
    expect(isUniformJpeg("AA==", () => bitmap(() => 255))).toBe(true);
    expect(isUniformJpeg("AA==", () => null)).toBe(true);
    expect(isUniformJpeg("AA==", () => bitmap((x) => x < 24 ? 255 : 20))).toBe(false);
  });
});
