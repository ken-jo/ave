import { useTranslation } from "../../../i18n/react.js";
import { localDateKey, shiftLocalDateKey } from "../../../shared/local-date.js";
import { SettingsPageHeader } from "../components/PageShell.js";
import { DiagnosticsSection } from "./DiagnosticsSection.js";
import { TelemetrySection } from "./TelemetrySection.js";

export function DiagnosticsTab() {
  const { t } = useTranslation();
  const today = localDateKey(new Date());
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-5">
      <SettingsPageHeader title={t("diagnosticsTab.diagnosticsTitle")} description={t("diagnosticsTab.diagnosticsDescription")} />
      <DiagnosticsSection defaultDateFrom={shiftLocalDateKey(today, -7)} defaultDateTo={today} />
      <TelemetrySection />
    </div>
  );
}
