import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { BrowserActionError, throwIfAborted } from "./browser-action-guard.js";

interface LayoutGuest {
  readonly id: number;
  isDestroyed(): boolean;
  getBackgroundThrottling(): boolean;
  setBackgroundThrottling(enabled: boolean): void;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

interface Activity {
  users: number;
  timer?: ReturnType<typeof setTimeout>;
  sleep(): void;
}

const MAX_AWAKE_TABS = 8;
const LAYOUT_POLL_MS = 25;

/** Main owns temporary painting; visible slots always take precedence in the renderer. */
export function createBrowserTabActivity(setAwake: (guestId: number, awake: boolean) => boolean) {
  const activities = new Map<LayoutGuest, Activity>();
  return async <T>(guest: LayoutGuest, signal: AbortSignal, ready: () => Promise<boolean>, act: () => Promise<T>): Promise<T> => {
    throwIfAborted(signal);
    let activity = activities.get(guest);
    if (!activity) {
      if (activities.size >= MAX_AWAKE_TABS) {
        const idle = [...activities.values()].find((entry) => entry.users === 0);
        if (idle) idle.sleep();
        else throw new BrowserActionError("browser-layout-busy", "too many browser tabs are acting; wait for an action to finish and retry");
      }
      if (!setAwake(guest.id, true)) throw new BrowserActionError("tab-not-laid-out", "the tab is not laid out; reopen its conversation or show the tab and retry");
      const throttled = guest.getBackgroundThrottling();
      const sleep = () => {
        const current = activities.get(guest);
        if (!current) return;
        clearTimeout(current.timer);
        activities.delete(guest);
        guest.removeListener("destroyed", sleep);
        setAwake(guest.id, false);
        if (!guest.isDestroyed()) guest.setBackgroundThrottling(throttled);
      };
      activity = { users: 0, sleep };
      activities.set(guest, activity);
      guest.once("destroyed", sleep);
      guest.setBackgroundThrottling(false);
    }
    clearTimeout(activity.timer);
    activity.users++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let finished = false;
    try {
      const unavailable = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BrowserActionError("tab-not-laid-out", "the tab is not laid out; show the tab and retry")), TOOL_TIMEOUT_POLICY.browserLayoutWakeMs);
        abort = () => { try { throwIfAborted(signal); } catch (error) { reject(error); } };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      await Promise.race([unavailable, (async () => {
        while (!finished && !await ready()) {
          throwIfAborted(signal);
          if (guest.isDestroyed()) throw new BrowserActionError("tab-gone", "the tab was closed");
          await new Promise<void>((resolve) => setTimeout(resolve, LAYOUT_POLL_MS));
        }
      })()]);
      clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
      throwIfAborted(signal);
      return await act();
    } finally {
      finished = true;
      clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
      activity.users--;
      if (activity.users === 0) {
        if (signal.aborted) activity.sleep();
        else {
          activity.timer = setTimeout(activity.sleep, TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs);
          activity.timer.unref?.();
        }
      }
    }
  };
}
