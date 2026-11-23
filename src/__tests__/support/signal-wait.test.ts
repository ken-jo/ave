import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "./deferred.js";
import { SIGNAL_WAIT_MS, untilAsserted, within } from "./signal-wait.js";

afterEach(() => { vi.useRealTimers(); });

function signal() {
  const wakes = new Set<() => void>();
  const stop = vi.fn();
  return {
    wakes, stop,
    subscribe: (wake: () => void) => { wakes.add(wake); return () => { stop(); wakes.delete(wake); }; },
    fire: () => { for (const wake of wakes) wake(); },
  };
}
const outcome = (wait: Promise<unknown>) => wait.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));

it("untilAsserted checks at once, reruns only on a signal, and unsubscribes once the assertion passes", async () => {
  const s = signal();
  let value = 0;
  const assertion = vi.fn(() => expect(value).toBe(2));
  const wait = outcome(untilAsserted(s.subscribe, assertion));
  await setImmediate();
  expect(assertion).toHaveBeenCalledTimes(1);
  value = 1;
  s.fire();
  await setImmediate();
  expect(assertion).toHaveBeenCalledTimes(2);
  value = 2;
  await setImmediate();
  // A change without a signal is not looked at.
  expect(assertion).toHaveBeenCalledTimes(2);
  s.fire();
  expect(await wait).toBe("resolved");
  expect(assertion).toHaveBeenCalledTimes(3);
  expect(s.stop).toHaveBeenCalledOnce();
  expect(s.wakes.size).toBe(0);
});

it("untilAsserted never overlaps runs: signals during a run queue one more run", async () => {
  const s = signal();
  const gate = deferred<void>();
  let running = 0;
  let overlapped = false;
  let calls = 0;
  const wait = untilAsserted(s.subscribe, async () => {
    calls += 1;
    running += 1;
    overlapped ||= running > 1;
    if (calls === 1) await gate.promise;
    running -= 1;
    expect(calls).toBe(2);
  });
  s.fire();
  s.fire();
  s.fire();
  gate.resolve();
  await wait;
  expect(overlapped).toBe(false);
  expect(calls).toBe(2);
});

it("untilAsserted is bounded by default: at the signal-wait bound it unsubscribes and rejects with the last failure", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const s = signal();
  const wait = outcome(untilAsserted(s.subscribe, () => expect("pending").toBe("done")));
  await vi.advanceTimersByTimeAsync(SIGNAL_WAIT_MS - 1);
  expect(await Promise.race([wait, setImmediate("still pending")])).toBe("still pending");
  await vi.advanceTimersByTimeAsync(1);
  expect(await wait).toMatch(/expected 'pending' to be 'done'/);
  expect(s.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("within settles as its work does and clears its bound, or rejects naming what it waited for once the bound passes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  expect(await within(Promise.resolve("value"), "a value")).toBe("value");
  expect(await outcome(within(Promise.reject(new Error("own failure")), "a failure"))).toBe("own failure");
  expect(vi.getTimerCount()).toBe(0);
  const never = outcome(within(new Promise(() => undefined), "the release signal"));
  await vi.advanceTimersByTimeAsync(SIGNAL_WAIT_MS - 1);
  expect(await Promise.race([never, setImmediate("still pending")])).toBe("still pending");
  await vi.advanceTimersByTimeAsync(1);
  expect(await never).toBe("timed out waiting for the release signal");
});
