import { describe, expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { runBrowserCapture, type BrowserCaptureOperation } from "../browser-capture-operation.js";

describe("browser capture operation", () => {
  it("does not start preparation when its deadline has already expired", async () => {
    const prepare = vi.fn(async () => "captured");
    await expect(runBrowserCapture(new AbortController().signal, 0, prepare)).rejects.toMatchObject({ code: "screenshot-timeout" });
    expect(prepare).not.toHaveBeenCalled();
  });
  it.each([false, true])("closes its scoped signal after settling without cancelling the caller (failed=%s)", async (failed) => {
    const caller = new AbortController();
    let operation: BrowserCaptureOperation | undefined;
    const pending = runBrowserCapture(caller.signal, 20, async (active) => {
      operation = active;
      if (failed) throw new Error("Preparation failed");
      return "captured";
    });
    if (failed) await expect(pending).rejects.toThrow("Preparation failed");
    else await expect(pending).resolves.toBe("captured");
    expect(operation?.signal.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });

  it("uses one original deadline through preparation, readback and pending cleanup", async () => {
    const preparation = deferred<void>(), readback = deferred<void>(), cleanup = deferred<void>();
    let operation: BrowserCaptureOperation | undefined;
    vi.useFakeTimers();
    try {
      const pending = runBrowserCapture(new AbortController().signal, 20, async (active) => {
        operation = active;
        await active.wait(preparation.promise);
        await active.wait(readback.promise);
        await active.wait(cleanup.promise);
      });
      const rejected = expect(pending).rejects.toMatchObject({ code: "screenshot-timeout" });
      await vi.advanceTimersByTimeAsync(5);
      preparation.resolve();
      await vi.advanceTimersByTimeAsync(5);
      readback.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
      expect(operation?.signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      cleanup.resolve();
    } finally { vi.useRealTimers(); }
  });
});
