/**
 * Who hears the host's `alert.*` events.
 *
 * The host emits them, so the ordinary owner check — which infers an event's
 * owner from the plugin that declares it — has nothing to hold on to. The
 * owner is instead the `pluginId` in the payload: a subscriber hears its own
 * alerts, and another plugin's only with a `pluginAccess` grant naming that
 * plugin and the event. A host kind's events carry `@host`, which no grant
 * can name, so they reach no plugin.
 */
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
