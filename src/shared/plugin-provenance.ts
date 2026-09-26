import type { TranslateFn } from "../i18n/translate.js";

// Direction controls in a display name can visually reorder the adjacent
// canonical id. The id remains ASCII and is never derived from this label.
const DIRECTION_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function resolvePluginDisplayName(pluginId: string, name?: string): string {
  return name?.replace(DIRECTION_CONTROLS, "").trim() || pluginId;
}

export function formatPluginProvenance(t: TranslateFn, pluginId: string, name: string): string {
  return name === pluginId
    ? t("alerts.pluginIdOnly", { id: pluginId })
    : t("alerts.pluginProvenance", { id: pluginId, name });
}
