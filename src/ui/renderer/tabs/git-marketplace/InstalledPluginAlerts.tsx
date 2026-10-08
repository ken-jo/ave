import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import { useAlertKinds } from "../../hooks/use-alert-kinds.js";
import type { AveApi } from "../../types.js";

/** Install and update share the same result view and read current choices. */
export function InstalledPluginAlerts({ api, pluginId, onOpen }: { api: AveApi; pluginId: string; onOpen: (pluginId: string) => void }) {
  const { t } = useTranslation();
  const { rows, loaded, failed } = useAlertKinds(api);
  const kinds = rows.filter((row) => row.pluginId === pluginId);
  if (!api.alerts || (!failed && (!loaded || kinds.length === 0))) return null;
  const allOff = kinds.length > 0 && kinds.every((row) => !row.choice.enabled);
  return <div className="space-y-1 pt-2" data-testid="installed-plugin-alerts">
    <p className="text-xs">{failed ? t("alerts.loadFailed") : t(allOff ? "alerts.availableAllOff" : "alerts.available", { count: kinds.length })}</p>
    <Button variant="outline" size="sm" onClick={() => onOpen(pluginId)}>{t("alerts.openSettings")}</Button>
  </div>;
}
