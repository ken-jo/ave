import type { TranslateFn } from "../i18n/translate.js";

// Direction controls in a display name can visually reorder the adjacent
// canonical id. The id remains ASCII and is never derived from this label.
const DIRECTION_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const FIELD_MARKERS = /[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\u00b7\u2022\u22c5:：|｜]/gu;

export function resolvePluginDisplayName(pluginId: string, name?: string): string {
  return name?.replace(DIRECTION_CONTROLS, "").replace(/\s+/gu, " ").trim() || pluginId;
}

function neutralizeNotificationField(value: string): string {
  return value.replace(DIRECTION_CONTROLS, "").replace(FIELD_MARKERS, " ").replace(/\s+/gu, " ").trim();
}

export function formatPluginNotificationTitle(
  t: TranslateFn,
  pluginId: string,
  displayName: string,
  title: string,
): string {
  const name = neutralizeNotificationField(displayName);
  const subject = neutralizeNotificationField(title);
  return name && name !== pluginId
    ? t("alerts.pluginNotificationTitle", { id: pluginId, name, title: subject })
    : t("alerts.pluginNotificationIdOnly", { id: pluginId, title: subject });
}
