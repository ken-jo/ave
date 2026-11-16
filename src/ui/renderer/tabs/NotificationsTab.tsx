import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import { ALERT_HOST_PLUGIN_ID } from "../../../shared/alerts-types.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { HiddenNoticesReset } from "../components/HiddenNoticesReset.js";
import { useAlertKinds } from "../hooks/use-alert-kinds.js";
import type { AveApi } from "../types.js";
import { AccessibilitySignalsSettings } from "./AccessibilitySignalsSettings.js";
import { PluginAlertsSection } from "./PluginAlertsSection.js";

/** Sound, operating-system delivery and hidden notices share one destination. */
export function NotificationsTab({ api }: { api: AveApi }) {
  const { t } = useTranslation();
  const alerts = useAlertKinds(api);
  const alertsApi = api.alerts;
  const pluginIds = [...new Set(alerts.rows.map((row) => row.pluginId))].filter((id) => id !== ALERT_HOST_PLUGIN_ID);
  return <div className="space-y-6">
    <SettingsPageHeader title={t("settingsContent.tabNotifications")} description={t("notificationsTab.description")} />
    <AccessibilitySignalsSettings />
    <SettingsSection data-settings-section="notifications-delivery" title={t("notificationsTab.delivery")}>
      {alerts.failed && <div role="alert" className="text-sm text-destructive">
        {t("alerts.loadFailed")} <Button size="sm" variant="outline" onClick={() => void alerts.refresh()}>{t("alerts.retry")}</Button>
      </div>}
      {alerts.loaded && alertsApi && <>
        <PluginAlertsSection pluginId={ALERT_HOST_PLUGIN_ID} rows={alerts.rows} api={alertsApi} osEnabled={alerts.osEnabled} refresh={alerts.refresh} />
        {pluginIds.map((pluginId) => <PluginAlertsSection key={pluginId} pluginId={pluginId} rows={alerts.rows} api={alertsApi} osEnabled={alerts.osEnabled} refresh={alerts.refresh} />)}
      </>}
    </SettingsSection>
    <SettingsSection data-settings-section="notifications-notices" title={t("notificationsTab.hiddenNotices")}>
      <HiddenNoticesReset />
    </SettingsSection>
  </div>;
}
