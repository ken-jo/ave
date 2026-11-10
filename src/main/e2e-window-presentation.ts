import type { BaseWindow, WebContents } from "electron";
import { getIsPackaged, isConfigured, isE2eTestRuntime, isPackagedElectronProcess } from "../boot/dev-flags.js";

export function isBackgroundE2eRuntime(): boolean {
  const packaged = isConfigured() ? getIsPackaged() : isPackagedElectronProcess();
  return !packaged && isE2eTestRuntime() && process.env.AVE_NATIVE_FIXTURE_MODE !== "foreground";
}

export function showWindowForRuntime(window: BaseWindow): void {
  if (isBackgroundE2eRuntime()) window.showInactive();
  else window.show();
}

interface FocusEmulationState {
  generation: number;
  confirmed: boolean;
  disconnected: boolean;
  destroyed: boolean;
  waiters: Set<(focused: boolean) => void>;
}
const focusEmulationStates = new WeakMap<WebContents, FocusEmulationState>();

function focusEmulationState(contents: WebContents): FocusEmulationState {
  const existing = focusEmulationStates.get(contents);
  if (existing) return existing;
  const state: FocusEmulationState = { generation: 0, confirmed: false, disconnected: false, destroyed: contents.isDestroyed(), waiters: new Set() };
  focusEmulationStates.set(contents, state);
  if (state.destroyed) return state;
  const invalidate = (): void => {
    state.generation++;
    state.confirmed = false;
    state.disconnected = true;
    for (const waiter of state.waiters) waiter(false);
    state.waiters.clear();
  };
  const debuggerApi = contents.debugger;
  debuggerApi.on("detach", invalidate);
  contents.once("destroyed", () => {
    state.destroyed = true;
    invalidate();
    debuggerApi.removeListener("detach", invalidate);
  });
  return state;
}

/** Capture the debugger generation before sending focus emulation; only its acknowledgement can confirm focus. */
export function beginFocusEmulation(contents: WebContents): () => void {
  const state = focusEmulationState(contents);
  const generation = state.generation;
  state.disconnected = false;
  return () => {
    if (state.destroyed || contents.isDestroyed() || state.generation !== generation) return;
    state.confirmed = true;
    for (const waiter of state.waiters) waiter(true);
    state.waiters.clear();
  };
}

/**
 * Background test windows never take OS focus; the page counts as focused once focus emulation is in force. Resolves false
 * when the debugger detaches or the page is destroyed first.
 */
export function whenFocusEmulated(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed()) return Promise.resolve(false);
  const state = focusEmulationState(contents);
  if (state.destroyed || state.disconnected) return Promise.resolve(false);
  if (state.confirmed) return Promise.resolve(true);
  return new Promise((resolve) => { state.waiters.add(resolve); });
}
