// Both surfaces must share one gesture-token map so minting, reporting, and consumption enforce the same intent.
import { randomUUID } from "node:crypto";
import type {
  UserKeyboardIntent,
  UserKeyboardIntentSnapshot,
} from "../shared/chat-origin.js";

function hasActiveUserGesture(): boolean {
  return globalThis.navigator?.userActivation?.isActive === true;
}

const USER_KEYBOARD_INTENT_TTL_MS = 5_000;
const userKeyboardIntentTokens = new Map<string, number>();

function pruneExpiredUserKeyboardIntents(now = Date.now()): void {
  for (const [token, expiresAt] of userKeyboardIntentTokens) {
    if (expiresAt <= now) userKeyboardIntentTokens.delete(token);
  }
}

export function captureUserKeyboardIntent(): UserKeyboardIntentSnapshot {
  if (!hasActiveUserGesture()) {
    return { inputOrigin: "user-keyboard", token: "" };
  }
  const now = Date.now();
  pruneExpiredUserKeyboardIntents(now);
  const token = randomUUID();
  userKeyboardIntentTokens.set(token, now + USER_KEYBOARD_INTENT_TTL_MS);
  return { inputOrigin: "user-keyboard", token };
}

export function consumeUserKeyboardIntent(userIntent?: UserKeyboardIntentSnapshot): boolean {
  const activeGesture = hasActiveUserGesture();
  if (userIntent && userIntent.inputOrigin === "user-keyboard" && typeof userIntent.token === "string") {
    const expiresAt = userKeyboardIntentTokens.get(userIntent.token);
    userKeyboardIntentTokens.delete(userIntent.token);
    if (typeof expiresAt === "number" && expiresAt > Date.now()) return true;
  }
  return activeGesture;
}

export function ipcUserKeyboardIntent(): UserKeyboardIntent | { inputOrigin: "user-keyboard"; userActivation: false } {
  return {
    inputOrigin: "user-keyboard",
    userActivation: hasActiveUserGesture(),
  };
}
