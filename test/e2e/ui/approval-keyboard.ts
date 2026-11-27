import { setTimeout } from "node:timers/promises";

export function waitForApprovalArming(): Promise<void> {
  // The renderer keeps the 500 ms arming deadline private. Call after the request is visible.
  return setTimeout(500);
}
