import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceFakeClock, realDelay, waitOnRealClock } from "./fake-clock-wait.js";

// Each pair is one body that outlives its timeout, and then the test that runs while that body is still going.
// The order is fixed: the second test observes what the first one leaves behind.
describe("a timed-out body leaves the next test's fake clock alone", { shuffle: false }, () => {
  const ZOMBIE_TIMEOUT_MS = 100;
  const ZOMBIE_RUNS_FOR_MS = 300;
  const OBSERVE_FOR_MS = 800;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.fails("times out before it advances the clock", { timeout: ZOMBIE_TIMEOUT_MS }, async ({ signal }) => {
    await realDelay(ZOMBIE_RUNS_FOR_MS);
    await advanceFakeClock(15_000, signal);
  });

  it("keeps its clock after the advance above", async () => {
    const fired = vi.fn();
    setTimeout(fired, 15_000);
    const start = Date.now();
    await realDelay(OBSERVE_FOR_MS);
    expect(fired).not.toHaveBeenCalled();
    expect(Date.now()).toBe(start);
  });

  it.fails("times out while it waits", { timeout: ZOMBIE_TIMEOUT_MS }, async ({ signal }) => {
    await waitOnRealClock(() => { throw new Error("never ready"); }, { signal, timeout: 5_000 });
  });

  it("keeps its clock while the wait above polls", async () => {
    const start = Date.now();
    await realDelay(OBSERVE_FOR_MS);
    expect(Date.now()).toBe(start);
  });
});

describe("waitOnRealClock", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("returns once the check passes and leaves an installed fake clock where it was", async ({ signal }) => {
    vi.useFakeTimers();
    const start = Date.now();
    let polls = 0;
    await expect(waitOnRealClock(() => {
      polls += 1;
      if (polls < 3) throw new Error("not yet");
      return "ready";
    }, { signal, timeout: 5_000, interval: 10 })).resolves.toBe("ready");
    expect(polls).toBe(3);
    expect(Date.now()).toBe(start);
  });

  it("rethrows the last check failure at its deadline", async ({ signal }) => {
    await expect(waitOnRealClock(() => { throw new Error("still missing"); }, { signal, timeout: 30, interval: 10 }))
      .rejects.toThrow("still missing");
  });

  it("stops at once when the signal has aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("test timed out"));
    const check = vi.fn();
    await expect(waitOnRealClock(check, { signal: controller.signal, timeout: 5_000 })).rejects.toThrow("test timed out");
    expect(check).not.toHaveBeenCalled();
  });
});
