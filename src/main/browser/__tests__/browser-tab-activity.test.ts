import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";
import { createBrowserTabActivity } from "../browser-tab-activity.js";

afterEach(() => vi.useRealTimers());

function guest(id: number) {
  return Object.assign(new EventEmitter(), {
    id, isDestroyed: () => false, getBackgroundThrottling: () => true, setBackgroundThrottling: vi.fn(),
  });
}

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
