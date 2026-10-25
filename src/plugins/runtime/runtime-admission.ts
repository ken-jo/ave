/** Tool and card calls share runtime admission; callers format refusals without duplicating the predicate. */
import { manifestIntegrityState } from "../../permissions/manifest-integrity.js";
import { sessionContext } from "../../engine/session-context.js";

/** Null means admitted. */
export type PluginRuntimeAdmissionRefusal = "inactive" | "integrity-disabled";

export interface PluginRuntimeAdmissionState {
  isPluginEnabled(pluginId: string): boolean;
  isSessionActivated(sessionId: string, pluginId: string): boolean;
}

// Require registry enablement or activation for this session, and no integrity disable.
// Missing session context grants no session-only access.
export function checkRuntimeAdmission(
  runtime: PluginRuntimeAdmissionState,
  pluginId: string,
): PluginRuntimeAdmissionRefusal | null {
  const sessionId = sessionContext.getStore()?.sessionId;
  if (
    !runtime.isPluginEnabled(pluginId) &&
    !(sessionId !== undefined && runtime.isSessionActivated(sessionId, pluginId))
  ) {
    return "inactive";
  }
  if (manifestIntegrityState.isDisabled(pluginId)) return "integrity-disabled";
  return null;
}
