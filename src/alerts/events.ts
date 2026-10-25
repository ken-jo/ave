/** Alert payload pluginId owns the event; cross-plugin delivery requires an explicit grant and host alerts reach no plugin. */
import type { PluginAccessSpec } from "../plugins/public-contract.js";
import { ALERT_HOST_PLUGIN_ID } from "../shared/alerts-types.js";
import { isRecord } from "../shared/is-record.js";

export function isAlertEvent(type: string): boolean {
  return type === "alert" || type.startsWith("alert.");
}

export function alertEventReaches(
  subscriberId: string,
  type: string,
  payload: unknown,
  grant: PluginAccessSpec | undefined,
): boolean {
  const owner = isRecord(payload) && typeof payload.pluginId === "string" ? payload.pluginId : null;
  if (owner === null || owner === ALERT_HOST_PLUGIN_ID) return false;
  if (owner === subscriberId) return true;
  return grant?.plugins.some((rule) => rule.pluginId === owner && rule.events?.includes(type) === true) ?? false;
}
