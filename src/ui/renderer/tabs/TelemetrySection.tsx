/** The consent level describes every reporting destination and can be withdrawn immediately. */
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { SettingsSection } from "../components/PageShell.js";
import { SettingsTextField } from "../components/SettingsTextField.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import { isIpcErrorResult, type AppSettings } from "../types.js";
import { useSettingsSnapshot } from "../hooks/use-settings-snapshot.js";
import { formatIpcError } from "../format-ipc-error.js";
import { TELEMETRY_LEVELS, isTelemetryLevel, telemetryLevel, telemetryLevelFlags, validateTelemetryEndpoint, type TelemetryLevel } from "../../../shared/telemetry-policy.js";

type TelemetryPatch = Partial<NonNullable<AppSettings["telemetry"]>>;

export function TelemetrySection() {
  const { t } = useTranslation();
  const api = getApi();
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [level, setLevel] = useState<TelemetryLevel>("off");
  const [legacyCrashDisabled, setLegacyCrashDisabled] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [crashReportEndpoint, setCrashReportEndpoint] = useState("");
  const [allowedHosts, setAllowedHosts] = useState<readonly string[]>([]);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applySnapshot = useCallback((s: AppSettings) => {
    setLevel(telemetryLevel(s.telemetry));
    setLegacyCrashDisabled(telemetryLevel(s.telemetry) !== "off" && s.telemetry.crashReportingEnabled !== true);
    setEndpoint(s.telemetry.endpoint ?? "");
    setCrashReportEndpoint(s.telemetry.crashReportEndpoint ?? "");
    setLoaded(true);
  }, []);
  useSettingsSnapshot(api, applySnapshot);

  useEffect(() => {
    let alive = true;
    void api.telemetryAllowedHosts().then((hosts) => {
      if (alive) { setAllowedHosts(hosts); setHostsLoaded(true); }
    }).catch(() => { if (alive) setError(t("auditTab.telemetryLoadFailed")); });
    return () => { alive = false; };
  }, [api, t]);

  const persist = useCallback(async (next: TelemetryPatch) => {
    setError(null);
    setSaving(true);
    try {
      const result = await api.updateSettings({ telemetry: next });
      if (isIpcErrorResult(result)) {
        setError(formatIpcError(result.error, result.message));
        return;
      }
      applySnapshot(result);
    } catch {
      setError(t("auditTab.telemetrySaveFailed"));
    } finally { setSaving(false); }
  }, [api, applySnapshot, t]);

  const commitEndpoint = useCallback((key: "endpoint" | "crashReportEndpoint", next: string) => {
    if (next !== "" && !validateTelemetryEndpoint(next, { isPackaged: false, allowedHosts }).valid) {
      setError(t("auditTab.telemetryInvalidEndpoint"));
      return;
    }
    void persist({ [key]: next });
  }, [allowedHosts, persist, t]);

  return (
    <SettingsSection data-settings-section="audit-telemetry" title={t("auditTab.telemetrySectionTitle")} description={t("auditTab.telemetrySectionDesc")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="min-w-0 text-sm font-medium" htmlFor="telemetry-level">{t("auditTab.telemetryLevelLabel")}</label>
        <NativeSelect id="telemetry-level" data-testid="telemetry-level" value={level} disabled={!loaded || saving} onChange={(event) => {
          const next = event.target.value;
          if (isTelemetryLevel(next) && next !== level) void persist({ level: next, ...telemetryLevelFlags(next), telemetryPromptAnswered: true });
        }}>
          {TELEMETRY_LEVELS.map((value) => <NativeSelectOption key={value} value={value}>{t(`auditTab.telemetryLevel.${value}`)}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <p className="mt-2 text-xs text-muted-foreground" data-testid="telemetry-enabled-help">{t("auditTab.telemetryEnabledHelp")}</p>
      <p className="mt-2 text-xs text-muted-foreground" data-testid="telemetry-level-help">{t(`auditTab.telemetryLevelHelp.${level}`)}</p>
      {legacyCrashDisabled ? <div className="mt-2 space-y-2" data-testid="telemetry-legacy-consent"><p className="text-xs text-muted-foreground">{t("auditTab.telemetryLegacyConsent")}</p><Button type="button" size="sm" disabled={saving} onClick={() => void persist({ level, ...telemetryLevelFlags(level), telemetryPromptAnswered: true })}>{t("auditTab.telemetryConfirmLevel")}</Button></div> : null}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
      <SettingsTextField id="telemetry-endpoint" label={t("auditTab.telemetryEndpointLabel")} help={t("auditTab.telemetryEndpointHelp")} value={endpoint} onCommit={(next) => commitEndpoint("endpoint", next)} disabled={!loaded || !hostsLoaded || saving} placeholder="https://" className="mt-4">
        <p className="text-xs text-muted-foreground" data-testid="telemetry-allowed-hosts">{allowedHosts.length > 0 ? t("auditTab.telemetryAllowedHosts", { hosts: allowedHosts.join(", ") }) : t("auditTab.telemetryNoAllowedHosts")}</p>
      </SettingsTextField>
      <SettingsTextField id="telemetry-crash-endpoint" label={t("auditTab.telemetryCrashEndpointLabel")} help={t("auditTab.telemetryCrashEndpointHelp")} value={crashReportEndpoint} onCommit={(next) => commitEndpoint("crashReportEndpoint", next)} disabled={!loaded || !hostsLoaded || saving} placeholder="https://" className="mt-4" />
      <p className="mt-2 text-xs text-muted-foreground" data-testid="telemetry-crash-reporting-help">{t("auditTab.telemetryCrashReportingHelp")}</p>
    </SettingsSection>
  );
}
