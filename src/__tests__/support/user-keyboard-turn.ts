import { mintUserKeyboardIntent, type VerifiedUserKeyboardIntent } from "../../shared/chat-origin.js";

/** RunTurn options for a turn the user typed: main mints the verified intent exactly as chat.send does after preload consumed a gesture
 * token. Each call mints a fresh single-use intent, so one helper call backs exactly one runTurn. */
export function userKeyboardTurn(): { inputOrigin: "user-keyboard"; userKeyboardIntent: VerifiedUserKeyboardIntent } {
  const userKeyboardIntent = mintUserKeyboardIntent({ inputOrigin: "user-keyboard", userActivation: true });
  if (userKeyboardIntent === undefined) throw new Error("mintUserKeyboardIntent refused a consumed keyboard gesture");
  return { inputOrigin: "user-keyboard", userKeyboardIntent };
}
