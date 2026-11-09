import type { BrowserWindow, WebContents } from "electron";
import { getIsPackaged, isConfigured, isE2eTestRuntime, isPackagedElectronProcess } from "../boot/dev-flags.js";

export function isBackgroundE2eRuntime(): boolean {
  const packaged = isConfigured() ? getIsPackaged() : isPackagedElectronProcess();
  return !packaged && isE2eTestRuntime() && process.env.AVE_NATIVE_FIXTURE_MODE !== "foreground";
}

export function showWindowForRuntime(window: BrowserWindow): void {
  if (isBackgroundE2eRuntime()) window.showInactive();
  else window.show();
}

const focusEmulated = new WeakSet<WebContents>();
const focusEmulationWaiters = new WeakMap<WebContents, Array<() => void>>();

/** Recorded by the background test policy once the page has confirmed CDP focus emulation. */
export function markFocusEmulated(contents: WebContents): void {
  focusEmulated.add(contents);
  const waiters = focusEmulationWaiters.get(contents) ?? [];
  focusEmulationWaiters.delete(contents);
  for (const waiter of waiters) waiter();
}

/**
 * Background test windows never take OS focus; the page counts as focused once focus emulation is in force. Resolves false
 * when the page is destroyed first.
 */
export function whenFocusEmulated(contents: WebContents): Promise<boolean> {
  if (focusEmulated.has(contents)) return Promise.resolve(true);
  if (contents.isDestroyed()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const destroyed = (): void => resolve(false);
    contents.once("destroyed", destroyed);
    const waiters = focusEmulationWaiters.get(contents) ?? [];
    waiters.push(() => { contents.removeListener("destroyed", destroyed); resolve(true); });
    focusEmulationWaiters.set(contents, waiters);
  });
}
