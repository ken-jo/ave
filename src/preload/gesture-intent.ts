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

/** True only for a token this preload minted during a user gesture, unexpired and not yet consumed. A missing, forged, consumed or expired
 * token is never rescued by the browser's current activation, which lingers after the gesture and would let a replay pass. */
export function consumeUserKeyboardIntent(userIntent?: UserKeyboardIntentSnapshot): boolean {
  if (!userIntent || userIntent.inputOrigin !== "user-keyboard" || typeof userIntent.token !== "string" || userIntent.token.length === 0) return false;
  const expiresAt = userKeyboardIntentTokens.get(userIntent.token);
  userKeyboardIntentTokens.delete(userIntent.token);
  return typeof expiresAt === "number" && expiresAt > Date.now();
}

export function ipcUserKeyboardIntent(): UserKeyboardIntent | { inputOrigin: "user-keyboard"; userActivation: false } {
  return {
    inputOrigin: "user-keyboard",
    userActivation: hasActiveUserGesture(),
  };
}
