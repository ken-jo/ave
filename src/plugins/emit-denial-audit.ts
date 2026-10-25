/** HostApi and webview emit denials must share audit records and lifecycle logging. */
import type { AuditEntry } from "../audit/audit-logger.js";
import { requiredCapabilityForEmit } from "./capabilities.js";
import { logPluginLifecycle, PluginPhase } from "./lifecycle-log.js";

/** Use the emit lane as sessionId so audits distinguish HostApi calls from webview calls. */
export type PluginEmitLane = "plugin" | "ipc-bridge";

/** Return the internal namespace label for wire errors; reserved/private denials have no capability label. */
export function auditPluginEmitDenial(params: {
  auditLogger: { log: (entry: AuditEntry) => void };
  lane: PluginEmitLane;
  pluginId: string;
  eventType: string;
  declaredEmittedEvents: readonly string[];
}): string | undefined {
  const { auditLogger, lane, pluginId, eventType, declaredEmittedEvents } = params;
  const requiredCapability = requiredCapabilityForEmit(eventType);
  try {
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: lane,
      type: "error",
      input: `[plugin:${pluginId}] plugin_emit_capability_denied eventType=${eventType} required=${requiredCapability} declaredEmittedEvents=${declaredEmittedEvents.join("|")}`,
    });
  } catch { /* audit must not break host */ }
  logPluginLifecycle(
    "warn",
    {
      pluginId,
      phase: PluginPhase.CAPABILITY_DENY,
      capability: requiredCapability ?? eventType,
      eventType,
      reason: "missing_capability",
    },
    "capability denied",
  );
  return requiredCapability;
}
