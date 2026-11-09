import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor, type ActionTarget } from "../browser-actions.js";

function page(loading: () => boolean, signal = new AbortController().signal): ActionTarget {
  return { tabId: "tab-1", signal, isLoading: loading, assertCurrent: vi.fn(), cdp: { send: vi.fn(async () => ({})) } } as unknown as ActionTarget;
}
afterEach(() => vi.useRealTimers());
describe("browser document wait", () => {
  it("returns immediately for an already loaded document instead of sleeping until the cap", async () => {
    vi.useFakeTimers();
    const pending = waitFor(page(() => false), { timeMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ found: true, reason: "load-complete", loading: false, waitedMs: 0 });
  });
  it("finishes when pending loading ends before its cap", async () => {
    vi.useFakeTimers();
    const began = Date.now();
    const pending = waitFor(page(() => Date.now() - began < 350), { timeMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ reason: "load-complete", loading: false });
    expect((await pending).waitedMs).toBeLessThan(600);
  });
  it("reports a timeout while the page keeps loading", async () => {
    vi.useFakeTimers();
    const pending = waitFor(page(() => true), { timeMs: 250 });
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toMatchObject({ found: false, reason: "timeout", loading: true, waitedMs: 250 });
  });
  it("retains text-search matching and discards the search handle", async () => {
    const target = page(() => true);
    const send = vi.spyOn(target.cdp, "send").mockImplementation(async method => method === "DOM.performSearch" ? { searchId: "search", resultCount: 1 } : {});
    expect(await waitFor(target, { text: "Ready", timeMs: 1_000 })).toMatchObject({ found: true, reason: "text-found", loading: true });
    expect(send).toHaveBeenCalledWith("DOM.discardSearchResults", { searchId: "search" });
  });
  it("rejects cancellation without consuming the remaining cap", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = waitFor(page(() => true, controller.signal), { timeMs: 2_000 }).then(() => "finished", error => error.code);
    controller.abort(new Error("turn ended"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });
});
