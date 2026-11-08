import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";
import { createBrowserTabActivity } from "../browser-tab-activity.js";

const guests = new Set<EventEmitter>();
afterEach(() => {
  for (const page of guests) page.emit("destroyed");
  guests.clear();
  vi.useRealTimers();
});

function guest(id: number) {
  let throttled = true;
  const page = Object.assign(new EventEmitter(), {
    id, isDestroyed: (): boolean => false, getBackgroundThrottling: () => throttled,
    setBackgroundThrottling: vi.fn((enabled: boolean) => { throttled = enabled; }),
  });
  guests.add(page);
  return page;
}

it("keeps a guest awake when an earlier adapter's grace expires during a later action", async () => {
  vi.useFakeTimers();
  const firstAwake = vi.fn(() => true);
  const secondAwake = vi.fn(() => true);
  const first = createBrowserTabActivity(firstAwake);
  const second = createBrowserTabActivity(secondAwake);
  const page = guest(1);
  await first(page, new AbortController().signal, async () => true, async () => {});
  await vi.advanceTimersByTimeAsync(500);
  const finish = deferred<void>();
  const action = second(page, new AbortController().signal, async () => true, () => finish.promise);
  try {
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs * 2);
    expect(page.getBackgroundThrottling()).toBe(false);
    expect(firstAwake).not.toHaveBeenCalledWith(1, false);
    expect(secondAwake).not.toHaveBeenCalledWith(1, false);
  } finally {
    finish.resolve();
    await action;
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs);
  }
});

it("restores the original throttling only after the final independent adapter finishes", async () => {
  vi.useFakeTimers();
  const first = createBrowserTabActivity(() => true);
  const second = createBrowserTabActivity(() => true);
  const page = guest(1);
  const finishFirst = deferred<void>();
  const finishSecond = deferred<void>();
  const one = first(page, new AbortController().signal, async () => true, () => finishFirst.promise);
  const two = second(page, new AbortController().signal, async () => true, () => finishSecond.promise);
  await vi.advanceTimersByTimeAsync(0);
  finishFirst.resolve();
  await one;
  await vi.advanceTimersByTimeAsync(500);
  finishSecond.resolve();
  await two;
  await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs);
  expect(page.getBackgroundThrottling()).toBe(true);
  expect(page.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
});

it("does not put a shared guest to sleep when only one adapter is cancelled", async () => {
  vi.useFakeTimers();
  const setAwake = vi.fn((_id: number, _awake: boolean) => true);
  const first = createBrowserTabActivity(setAwake);
  const second = createBrowserTabActivity((id, awake) => setAwake(id, awake));
  const page = guest(1);
  const finish = deferred<void>();
  const action = first(page, new AbortController().signal, async () => true, () => finish.promise);
  const controller = new AbortController();
  const cancelled = second(page, controller.signal, async () => false, vi.fn());
  const rejection = expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
  controller.abort(new Error("caller cancelled"));
  try {
    await rejection;
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs * 2);
    expect(page.getBackgroundThrottling()).toBe(false);
    expect(setAwake).not.toHaveBeenCalledWith(1, false);
  } finally {
    finish.resolve();
    await action;
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs);
  }
  expect(page.getBackgroundThrottling()).toBe(true);
});

it("shares the awake guest capacity across independently constructed adapters", async () => {
  vi.useFakeTimers();
  const first = createBrowserTabActivity(() => true);
  const second = createBrowserTabActivity(() => true);
  const finish = deferred<void>();
  const actions = Array.from({ length: 8 }, (_, index) => (index < 4 ? first : second)(
    guest(index + 1), new AbortController().signal, async () => true, () => finish.promise,
  ));
  try {
    await expect(second(guest(9), new AbortController().signal, async () => true, async () => {}))
      .rejects.toMatchObject({ code: "browser-layout-busy" });
  } finally {
    finish.resolve();
    await Promise.all(actions);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs);
  }
});

it("disposes one shared wake on guest destruction without scheduling later idle work", async () => {
  vi.useFakeTimers();
  const setAwake = vi.fn((_id: number, _awake: boolean) => true);
  const first = createBrowserTabActivity(setAwake);
  const second = createBrowserTabActivity((id, awake) => setAwake(id, awake));
  const page = guest(1);
  let destroyed = false;
  page.isDestroyed = () => destroyed;
  const finish = deferred<void>();
  const actions = [first, second].map(withActivity => withActivity(
    page, new AbortController().signal, async () => true, () => finish.promise,
  ));
  await vi.advanceTimersByTimeAsync(0);
  destroyed = true;
  page.emit("destroyed");
  finish.resolve();
  await Promise.all(actions);
  expect(setAwake.mock.calls).toEqual([[1, true], [1, false]]);
  expect(page.listenerCount("destroyed")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("wakes a sleeping tab before acting and reuses it until the idle grace ends", async () => {
  vi.useFakeTimers();
  const setAwake = vi.fn(() => true);
  const withActivity = createBrowserTabActivity(setAwake);
  const page = guest(1);
  const ready = vi.fn(async () => setAwake.mock.calls.length > 0);
  const act = vi.fn(async () => "clicked");
  await expect(withActivity(page, new AbortController().signal, ready, act)).resolves.toBe("clicked");
  expect(setAwake).toHaveBeenCalledWith(1, true);
  expect(page.setBackgroundThrottling).toHaveBeenCalledWith(false);
  await vi.advanceTimersByTimeAsync(500);
  await withActivity(page, new AbortController().signal, ready, act);
  expect(setAwake).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs);
  expect(setAwake).toHaveBeenLastCalledWith(1, false);
  expect(page.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
});

it("keeps concurrent guests awake independently through their complete actions", async () => {
  vi.useFakeTimers();
  const setAwake = vi.fn(() => true);
  const withActivity = createBrowserTabActivity(setAwake);
  const first = deferred<string>();
  const second = deferred<string>();
  const one = withActivity(guest(1), new AbortController().signal, async () => true, () => first.promise);
  const two = withActivity(guest(2), new AbortController().signal, async () => true, () => second.promise);
  await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs * 2);
  expect(setAwake.mock.calls).toEqual([[1, true], [2, true]]);
  first.resolve("one"); second.resolve("two");
  await expect(Promise.all([one, two])).resolves.toEqual(["one", "two"]);
  await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs);
  expect(setAwake.mock.calls).toContainEqual([1, false]);
  expect(setAwake.mock.calls).toContainEqual([2, false]);
});

it("fails a zero-size or unresponsive guest with an actionable layout error", async () => {
  vi.useFakeTimers();
  const withActivity = createBrowserTabActivity(() => true);
  const act = vi.fn();
  const task = withActivity(guest(1), new AbortController().signal, async () => false, act);
  const result = expect(task).rejects.toMatchObject({ code: "tab-not-laid-out", message: expect.stringContaining("show the tab") });
  await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutWakeMs);
  await result;
  expect(act).not.toHaveBeenCalled();
  const stalled = withActivity(guest(2), new AbortController().signal, () => new Promise(() => {}), act);
  const stalledResult = expect(stalled).rejects.toMatchObject({ code: "tab-not-laid-out" });
  await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutWakeMs);
  await stalledResult;
});

it("cancels waiting on takeover and does not hold a closed guest awake", async () => {
  vi.useFakeTimers();
  const setAwake = vi.fn(() => true);
  const withActivity = createBrowserTabActivity(setAwake);
  const page = guest(1);
  const controller = new AbortController();
  const act = vi.fn();
  const task = withActivity(page, controller.signal, async () => false, act);
  const result = expect(task).rejects.toThrow();
  controller.abort(new Error("human takeover"));
  await result;
  page.emit("destroyed");
  expect(setAwake).toHaveBeenLastCalledWith(1, false);
  expect(act).not.toHaveBeenCalled();
});
