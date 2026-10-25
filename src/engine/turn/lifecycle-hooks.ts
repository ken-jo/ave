import type { LifecycleHookEvent } from "../../hooks/script-hook-types.js";
import { stopHookBlockFeedback } from "../../hooks/hook-contract.js";
import type { ConversationLoopDeps } from "./types.js";
import { createLogger } from "../../lib/logger.js";
import { errorMessage } from "../../shared/error-message.js";

const log = createLogger("ave");

export async function fireLifecycleEvent(
  deps: ConversationLoopDeps,
  sessionId: string,
  event: LifecycleHookEvent,
  payload: import("../../hooks/script-hook-types.js").LifecycleEventPayload = {},
  sessionIdOverride?: string,
): Promise<void> {
    const manager = deps.scriptHookManager;
    if (!manager) return;
    try {
      await manager.runLifecycleEvent(
        event,
        sessionIdOverride ?? sessionId,
        // Session lifecycle hooks use unknown origin and cannot enroll or mutate trust.
        "unknown",
        payload,
      );
    } catch (err) {
      log.warn(
        `lifecycle event ${event} dispatch failed (non-blocking, ignored): ${errorMessage(err)}`,
      );
    }
}

/** Stop feedback may continue a clean run; unexpected errors remain fail-soft and end it normally. */
export async function fireContinuableStop(
  deps: ConversationLoopDeps,
  sessionId: string,
  event: "Stop" | "SubagentStop",
  payload: import("../../hooks/script-hook-types.js").LifecycleEventPayload,
  sessionIdOverride?: string,
): Promise<string | undefined> {
    const manager = deps.scriptHookManager;
    if (!manager) return undefined;
    try {
      return stopHookBlockFeedback(
        await manager.runLifecycleEvent(event, sessionIdOverride ?? sessionId, "unknown", payload),
      );
    } catch (err) {
      log.warn(`lifecycle event ${event} dispatch failed (non-blocking, ignored): ${errorMessage(err)}`);
      return undefined;
    }
}

export async function fireUserPromptSubmit(
  deps: ConversationLoopDeps,
  sessionId: string,
  payload: import("../../hooks/script-hook-types.js").UserPromptSubmitPayload,
  sessionIdOverride?: string,
): Promise<{ decision: "allow" | "deny"; reason: string }> {
    const manager = deps.scriptHookManager;
    if (!manager) return { decision: "allow", reason: "no script hook manager" };
    try {
      const result = await manager.runUserPromptSubmit(
        sessionIdOverride ?? sessionId,
        // Preserve input origin in the payload; hook trust origin stays unknown without enrollment rights.
        "unknown",
        payload,
      );
      return { decision: result.decision, reason: result.reason };
    } catch (err) {
      // Blocking prompt hooks must deny on unexpected errors.
      const message = errorMessage(err);
      log.error(
        `UserPromptSubmit dispatch threw — failing closed (deny): ${message}`,
      );
      return {
        decision: "deny",
        reason: `UserPromptSubmit dispatch error (fail-closed → deny): ${message}`,
      };
    }
}
