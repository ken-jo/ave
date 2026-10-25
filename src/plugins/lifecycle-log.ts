/** Use structured plugin lifecycle logs with pluginId, phase and branch reasons so failures remain attributable. */
import { createLogger } from "../lib/logger.js";

const log = createLogger("plugin-lifecycle");

/** Phase labels distinguish area, transition and outcome; preserve these persisted diagnostic spellings. */
export const PluginPhase = {
  DISCOVERY_START: "lifecycle:discovery:start",
  DISCOVERY_OK: "lifecycle:discovery:ok",
  DISCOVERY_SKIP: "lifecycle:discovery:skip",
  DISCOVERY_FAIL: "lifecycle:discovery:fail",

  VALIDATION_START: "lifecycle:validation:start",
  VALIDATION_OK: "lifecycle:validation:ok",
  VALIDATION_FAIL: "lifecycle:validation:fail",

  LOAD_START: "lifecycle:load:start",
  LOAD_OK: "lifecycle:load:ok",
  LOAD_FAIL: "lifecycle:load:fail",

  REGISTER_TOOL_OK: "lifecycle:register:tool:ok",
  REGISTER_TOOL_SKIP: "lifecycle:register:tool:skip",
  REGISTER_TOOL_FAIL: "lifecycle:register:tool:fail",

  START_OK: "lifecycle:start:ok",
  START_FAIL: "lifecycle:start:fail",
  START_SLOW: "lifecycle:start:slow",

  INVOKE_START: "lifecycle:invoke:start",
  INVOKE_OK: "lifecycle:invoke:ok",
  INVOKE_FAIL: "lifecycle:invoke:fail",

  EVENT_EMIT: "lifecycle:event:emit",
  EVENT_LISTEN: "lifecycle:event:listen",
  EVENT_FAIL: "lifecycle:event:fail",

  WEBVIEW_REGISTER: "lifecycle:webview:register",
  WEBVIEW_ATTACH: "lifecycle:webview:attach",
  WEBVIEW_REJECT: "lifecycle:webview:reject",
  WEBVIEW_LOAD_OK: "lifecycle:webview:load:ok",
  WEBVIEW_LOAD_FAIL: "lifecycle:webview:load:fail",

  RESTART_REQUEST: "lifecycle:restart:request",
  RESTART_STOP_FAIL: "lifecycle:restart:stop:fail",
  RESTART_RELOAD_OK: "lifecycle:restart:reload:ok",
  RESTART_RELOAD_FAIL: "lifecycle:restart:reload:fail",
  RESTART_START_OK: "lifecycle:restart:start:ok",
  RESTART_START_FAIL: "lifecycle:restart:start:fail",

  STOP_OK: "lifecycle:stop:ok",
  STOP_FAIL: "lifecycle:stop:fail",

  CAPABILITY_CHECK: "lifecycle:capability:check",
  CAPABILITY_DENY: "lifecycle:capability:deny",
} as const;

export type PluginPhaseValue = (typeof PluginPhase)[keyof typeof PluginPhase];

/** pluginId and phase are required; skip/failure branches also need a reason. */
export interface PluginLogContext {
  pluginId: string;
  phase: PluginPhaseValue;
  toolName?: string;
  eventType?: string;
  reason?: string;
  /** Use err so the logger preserves the error stack. */
  err?: unknown;
  [key: string]: unknown;
}

/** Use debug for transitions, warn for recoverable skips, and error when a plugin is marked failed. */
export function logPluginLifecycle(
  level: "debug" | "info" | "warn" | "error",
  ctx: PluginLogContext,
  msg: string,
): void {
  log[level](ctx, msg);
}
