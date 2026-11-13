import { describe, expect, it, vi } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { sendRendererEvent, withPageWindow } from "../e2e/ui/renderer-events.js";

describe("page-owned renderer event delivery", () => {
  it("delivers to the tested page even when a different window is first or visible", async () => {
    const send = vi.fn();
    const otherSend = vi.fn();
    const window = { isDestroyed: () => false, webContents: { send } };
    const target = { evaluate: vi.fn(async (callback, event) => callback(window, event)), dispose: vi.fn() };
    const page = {} as Page;
    const app = { browserWindow: vi.fn(async () => target), evaluate: vi.fn(() => otherSend()) };
    const payload = { id: "owned-request", sessionId: "owned-conversation" };
    await sendRendererEvent(app as unknown as ElectronApplication, page, "ave:approval:request", payload);
    expect(app.browserWindow).toHaveBeenCalledWith(page);
    expect(send).toHaveBeenCalledWith("ave:approval:request", payload);
    expect(app.evaluate).not.toHaveBeenCalled();
    expect(otherSend).not.toHaveBeenCalled();
    expect(target.dispose).toHaveBeenCalledOnce();
  });

  it("fails instead of dropping a request when its page window closes", async () => {
    const send = vi.fn();
    const target = {
      evaluate: vi.fn(async (callback, event) => callback({ isDestroyed: () => true, webContents: { send } }, event)),
      dispose: vi.fn(),
    };
    const app = { browserWindow: vi.fn(async () => target) };
    await expect(sendRendererEvent(app as unknown as ElectronApplication, {} as Page, "ave:approval:request", {}))
      .rejects.toThrow("Test page window is unavailable");
    expect(send).not.toHaveBeenCalled();
    expect(target.dispose).toHaveBeenCalledOnce();
  });
});

describe("page-owned native actions", () => {
  it("returns the native action result and always releases its handle", async () => {
    const window = { isDestroyed: () => false, getBounds: () => ({ width: 1200 }) };
    const target = { evaluate: vi.fn(async (callback, arg) => callback(window, arg)), dispose: vi.fn() };
    const app = { browserWindow: vi.fn(async () => target) };
    const page = {} as Page;
    const result = await withPageWindow(app as unknown as ElectronApplication, page, (owned, offset) => owned.getBounds().width + offset, 4);
    expect(result).toBe(1204);
    expect(app.browserWindow).toHaveBeenCalledWith(page);
    expect(target.dispose).toHaveBeenCalledOnce();
    await expect(withPageWindow(app as unknown as ElectronApplication, page, () => { throw new Error("Action failed"); }))
      .rejects.toThrow("Action failed");
    expect(target.dispose).toHaveBeenCalledTimes(2);
  });
});
