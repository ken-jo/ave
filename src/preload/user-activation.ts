import type { UserKeyboardIntent } from "../shared/chat-origin.js";

export function hasActiveUserGesture(): boolean {
  return globalThis.navigator?.userActivation?.isActive === true;
}

/** Capture activation for a user action; main must verify its native input separately. */
export function ipcUserKeyboardIntent(): UserKeyboardIntent | { inputOrigin: "user-keyboard"; userActivation: false } {
  return { inputOrigin: "user-keyboard", userActivation: hasActiveUserGesture() };
}
