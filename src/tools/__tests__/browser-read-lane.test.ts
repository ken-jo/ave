import { deferred } from "../../__tests__/support/deferred.js";
import { describe, expect, it, vi } from "vitest";
import { runBrowserReadInLane } from "../browser-read-lane.js";


describe("physical browser read lane", () => {
  it("runs separate guests together and orders one guest", async () => {
    const firstGuest = {};
    const secondGuest = {};
    const pending = deferred<void>();
    const calls: string[] = [];
    const first = runBrowserReadInLane(firstGuest, undefined, async () => { calls.push("first"); await pending.promise; });
    const queued = runBrowserReadInLane(firstGuest, undefined, async () => { calls.push("queued"); });
    const other = runBrowserReadInLane(secondGuest, undefined, async () => { calls.push("other"); });
    await other;
    try { expect(calls).toEqual(["first", "other"]); }
    finally { pending.resolve(); }
    await Promise.all([first, queued]);
    expect(calls).toEqual(["first", "other", "queued"]);
  });

  it("rejects a cancelled queued read before its predecessor settles and never dispatches it", async () => {
    const guest = {};
    const pending = deferred<void>();
    const first = runBrowserReadInLane(guest, undefined, () => pending.promise);
    const controller = new AbortController();
    const work = vi.fn(async () => {});
    const queued = runBrowserReadInLane(guest, controller.signal, work);
    const rejected = expect(queued).rejects.toThrow("Read cancelled");
    controller.abort(new Error("Read cancelled"));
    await rejected;
    expect(work).not.toHaveBeenCalled();
    pending.resolve();
    await first;
    await runBrowserReadInLane(guest, undefined, async () => {});
    expect(work).not.toHaveBeenCalled();
  });

  it("keeps an active cancelled read pending until its cleanup settles", async () => {
    const guest = {};
    const pending = deferred<void>();
    const controller = new AbortController();
    const started = deferred<void>();
    const first = runBrowserReadInLane(guest, controller.signal, async () => { started.resolve(); await pending.promise; controller.signal.throwIfAborted(); });
    await started.promise;
    const rejected = expect(first).rejects.toThrow("Read cancelled");
    controller.abort(new Error("Read cancelled"));
    let finished = false;
    void first.catch(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    const work = vi.fn(async () => {});
    const queued = runBrowserReadInLane(guest, undefined, work);
    await Promise.resolve();
    expect(work).not.toHaveBeenCalled();
    pending.resolve();
    await rejected;
    await queued;
    expect(work).toHaveBeenCalledOnce();
  });

  it("releases the lane after a rejected operation", async () => {
    const guest = {};
    const first = runBrowserReadInLane(guest, undefined, async () => { throw new Error("Read failed"); });
    const second = runBrowserReadInLane(guest, undefined, async () => "next read");
    await expect(first).rejects.toThrow("Read failed");
    await expect(second).resolves.toBe("next read");
  });

  it("never queues a read whose signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Read cancelled"));
    const work = vi.fn(async () => {});
    await expect(runBrowserReadInLane({}, controller.signal, work)).rejects.toThrow("Read cancelled");
    expect(work).not.toHaveBeenCalled();
  });
});
