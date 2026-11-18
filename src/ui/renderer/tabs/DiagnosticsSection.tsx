/** Diagnostics exports and log tails are redacted; map host error codes to localized messages. */
import { EmptyState } from "../../../components/ui/empty-state.js";
import { useCallback, useEffect, useState, useRef } from "react";
import { Button } from "../../../components/ui/button.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { SettingsSection } from "../components/PageShell.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatIpcError } from "../format-ipc-error.js";
import { formatBytes } from "../../../lib/turn-summary-format.js";
import { requirePersistedResult, useSettingsPersistence } from "../hooks/use-settings-persistence.js";
import { useNotifySaved } from "../context/SavedToastContext.js";
import { isIpcErrorResult, type AppSettings, type AveApi } from "../types.js";
import { isRecord, isStringArray } from "../../../shared/is-record.js";
import { useSettingsControl, useSettingsDocumentRead, useSettingsEditor } from "../context/SettingsEditorContext.js";

interface CrashDumpMeta {
  name: string;
  mtime: string;
  size: number;
}

function isCrashDumpList(value: unknown): value is CrashDumpMeta[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    const dump: unknown = value[index];
    if (!isRecord(dump) || typeof dump.name !== "string" || typeof dump.mtime !== "string"
      || typeof dump.size !== "number" || !Number.isFinite(dump.size) || dump.size < 0) return false;
  }
  return true;
}

type DiagnosticsApi = Pick<AveApi, "diagnostics" | "logs" | "getSettings" | "updateSettings" | "onSettingsUpdated">;

function api(): DiagnosticsApi {
  return (window as unknown as { aveApi: DiagnosticsApi }).aveApi;
}

const LOG_LEVELS = ["all", "error", "warn", "info", "debug"] as const;

interface DiagnosticsSectionProps {
  defaultDateFrom: string;
  defaultDateTo: string;
}

export function DiagnosticsSection({ defaultDateFrom, defaultDateTo }: DiagnosticsSectionProps) {
  const { t } = useTranslation();

  const crashDumpConsentControl = useSettingsControl({
    id: "diagnostics.includeCrashDumps", section: "audit-bundle", label: t("auditTab.bundleIncludeCrashDumps"),
  });
  const notifySaved = useNotifySaved();
  const { error: saveError, saving, persist } = useSettingsPersistence(notifySaved);
  const [includeCrashDumps, setIncludeCrashDumps] = useState<boolean | null>(null);
  const storedConsent = useRef<boolean | null>(null);
  const [consentLoading, setConsentLoading] = useState(true);
  const [consentLoadError, setConsentLoadError] = useState<string | null>(null);
  const consentRequestId = useRef(0);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);

  const [logLevel, setLogLevel] = useState<string>("all");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logErr, setLogErr] = useState<string | null>(null);
  const logRequestId = useRef(0);

  const [crashes, setCrashes] = useState<CrashDumpMeta[]>([]);
  const [crashErr, setCrashErr] = useState<string | null>(null);

  /** Map a kebab-case IPC error code to a localized string via the canonical `formatIpcError` SOT (COMMON_IPC_ERROR_MESSAGES)
   * — the same mapper every other tab uses, so the diagnostics codes cannot drift from the shared set. */
  const mapError = useCallback((code: string): string => formatIpcError(code, undefined), []);

  const applyConsent = useCallback((settings: AppSettings, expectedRevision?: number) => {
    const consent = settings?.diagnostics?.includeCrashDumps;
    if (typeof consent !== "boolean") throw new Error(t("auditTab.bundleConsentLoadFailed"));
    if (expectedRevision !== undefined && expectedRevision !== consentRequestId.current) return;
    storedConsent.current = consent;
    setIncludeCrashDumps(consent);
    setConsentLoadError(null);
  }, [t]);

  const showConsentLoadError = useCallback(() => {
    storedConsent.current = null;
    setIncludeCrashDumps(null);
    setConsentLoadError(t("auditTab.bundleConsentLoadFailed"));
  }, [t]);

  const readSettings = useSettingsDocumentRead(() => api().getSettings());
  const editorSettings = useSettingsEditor()?.settings;
  const loadConsent = useCallback(async (fresh = false) => {
    const id = ++consentRequestId.current;
    setConsentLoading(true);
    setConsentLoadError(null);
    try {
      const settings = await readSettings({ fresh });
      if (id === consentRequestId.current) applyConsent(settings);
    } catch {
      if (id === consentRequestId.current) showConsentLoadError();
    } finally {
      if (id === consentRequestId.current) setConsentLoading(false);
    }
  }, [applyConsent, readSettings, showConsentLoadError]);

  useEffect(() => {
    if (editorSettings) {
      consentRequestId.current++;
      try { applyConsent(editorSettings); } catch { showConsentLoadError(); }
      setConsentLoading(false);
    } else void loadConsent();
    const unsubscribe = api().onSettingsUpdated((settings) => {
      consentRequestId.current++;
      try {
        applyConsent(settings);
      } catch {
        showConsentLoadError();
      }
      setConsentLoading(false);
    });
    return () => { consentRequestId.current++; unsubscribe(); };
  }, [applyConsent, loadConsent, showConsentLoadError, editorSettings]);

  const handleToggleCrashDumps = useCallback(async (next: boolean) => {
    if (storedConsent.current === null || consentLoading || saving) return;
    const revision = consentRequestId.current;
    setIncludeCrashDumps(next);
    await persist(async () => {
      const settings = requirePersistedResult(await api().updateSettings({ diagnostics: { includeCrashDumps: next } }));
      applyConsent(settings, revision);
      return settings;
    }, { rollback: () => setIncludeCrashDumps(storedConsent.current) });
  }, [applyConsent, consentLoading, persist, saving]);

  const handleExport = useCallback(async () => {
    if (includeCrashDumps === null || consentLoading || saving) return;
    if (defaultDateFrom && defaultDateTo && defaultDateFrom > defaultDateTo) {
      setExportErr(t("auditTab.invalidDateRange"));
      return;
    }
    setExporting(true);
    setExportMsg(null);
    setExportErr(null);
    try {
      const res = await api().diagnostics.export({
        dateFrom: defaultDateFrom || undefined,
        dateTo: defaultDateTo || undefined,
        includeCrashDumps,
      });
      if (isIpcErrorResult(res)) {
        setExportErr(mapError(res.error));
      } else if (isRecord(res) && res.ok === false && res.canceled === true) {
        setExportMsg(t("auditTab.bundleExportCanceled"));
      } else if (isRecord(res) && res.ok === true && typeof res.path === "string" && res.path.length > 0
        && typeof res.bytes === "number" && Number.isSafeInteger(res.bytes) && res.bytes >= 0) {
        setExportMsg(t("auditTab.bundleExportSuccess", { bytes: formatBytes(res.bytes) }));
      } else {
        setExportErr(t("auditTab.errExportFailed"));
      }
    } catch {
      setExportErr(t("auditTab.errExportFailed"));
    } finally {
      setExporting(false);
    }
  }, [defaultDateFrom, defaultDateTo, includeCrashDumps, consentLoading, saving, mapError, t]);

  const refreshLogs = useCallback(async () => {
    const id = ++logRequestId.current;
    setLogErr(null);
    setLogLines([]);
    try {
      const res = await api().logs.tail({ lines: 200, level: logLevel });
      if (id !== logRequestId.current) return;
      if (isIpcErrorResult(res)) setLogErr(mapError(res.error));
      else if (isRecord(res) && res.ok === true && isStringArray(res.lines)) setLogLines(res.lines);
      else setLogErr(t("auditTab.errLogsTailFailed"));
    } catch {
      if (id === logRequestId.current) setLogErr(t("auditTab.errLogsTailFailed"));
    }
  }, [logLevel, mapError, t]);

  useEffect(() => {
    void refreshLogs();
    return () => { logRequestId.current++; };
  }, [refreshLogs]);

  const refreshCrashes = useCallback(async () => {
    setCrashErr(null);
    setCrashes([]);
    try {
      const res = await api().diagnostics.crashList();
      if (isIpcErrorResult(res)) setCrashErr(mapError(res.error));
      else if (isRecord(res) && res.ok === true && isCrashDumpList(res.dumps)) setCrashes(res.dumps);
      else setCrashErr(t("auditTab.errCrashListFailed"));
    } catch {
      setCrashErr(t("auditTab.errCrashListFailed"));
    }
  }, [mapError, t]);

  useEffect(() => {
    void refreshCrashes();
  }, [refreshCrashes]);

  return (
    <>
      {/* ── Bundle export ── */}
      <SettingsSection data-settings-section="audit-bundle" title={t("auditTab.bundleSectionTitle")}>
        <p className="text-dense text-muted-foreground">{t("auditTab.bundleSectionDesc")}</p>
        <p data-testid="diagnostics-export-range" className="text-dense text-muted-foreground">{t("auditTab.bundleDateRange", { from: defaultDateFrom || t("auditTab.bundleAllDates"), to: defaultDateTo || t("auditTab.bundleAllDates") })}</p>
        <label className="flex items-center gap-2 text-xs">
          <input
            {...crashDumpConsentControl}
            type="checkbox"
            checked={includeCrashDumps === true}
            disabled={includeCrashDumps === null || consentLoading || saving || exporting}
            aria-busy={consentLoading || saving}
            onChange={(e) => void handleToggleCrashDumps(e.target.checked)}
          />
          {t("auditTab.bundleIncludeCrashDumps")}
        </label>
        {consentLoading && <p role="status" className="text-dense text-muted-foreground">{t("auditTab.bundleConsentLoading")}</p>}
        {consentLoadError && (
          <div className="space-y-2">
            <p role="alert" className="text-dense text-destructive">{consentLoadError}</p>
            <Button data-settings-transient="true" size="sm" variant="outline" onClick={() => void loadConsent(true)} disabled={consentLoading}>{t("common.retry")}</Button>
          </div>
        )}
        {saveError && <p role="alert" className="text-dense text-destructive">{saveError}</p>}
        {includeCrashDumps === true && (
          <p className="text-dense text-warning">{t("auditTab.bundleCrashDumpWarning")}</p>
        )}
        <div className="flex items-center gap-2">
          <Button data-settings-transient="true" size="sm" className="h-8" onClick={() => void handleExport()} disabled={exporting || saving || consentLoading || includeCrashDumps === null}>
            {exporting ? t("auditTab.bundleExporting") : t("auditTab.bundleExportButton")}
          </Button>
          {exportMsg && <span className="text-dense text-muted-foreground">{exportMsg}</span>}
        </div>
        {exportErr && (
          <div className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive">
            {exportErr}
          </div>
        )}
      </SettingsSection>

      {/* ── Log tail viewer ── */}
      <SettingsSection
        data-settings-section="audit-log-file"
        title={t("auditTab.logSectionTitle")}
        actions={
          <div className="flex items-center gap-2">
            <NativeSelect
              size="sm"
              className="w-28"
              data-settings-transient="true"
              aria-label={t("auditTab.logLevel")}
              value={logLevel}
              onChange={(e) => setLogLevel(e.target.value)}
            >
              <NativeSelectOption value="all">{t("auditTab.logLevelAll")}</NativeSelectOption>
              {LOG_LEVELS.filter((l) => l !== "all").map((l) => (
                <NativeSelectOption key={l} value={l}>
                  {l}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button data-settings-transient="true" size="sm" className="h-8" variant="outline" onClick={() => void refreshLogs()}>
              {t("auditTab.logRefresh")}
            </Button>
          </div>
        }
      >
        {logErr && (
          <div className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive">
            {logErr}
          </div>
        )}
        {logLines.length === 0 && !logErr ? (
          <EmptyState align="center" className="px-0 py-3" title={t("auditTab.logEmpty")} />
        ) : (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/(--opacity-medium) p-2 text-tiny font-mono">
            {logLines.join("\n")}
          </pre>
        )}
      </SettingsSection>

      {/* ── Crash list ── */}
      <SettingsSection
        data-settings-section="audit-crash"
        title={t("auditTab.crashSectionTitle")}
        actions={
          <Button data-settings-transient="true" size="sm" className="h-8" variant="outline" onClick={() => void refreshCrashes()}>
            {t("auditTab.logRefresh")}
          </Button>
        }
      >
        {crashErr && (
          <div className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive">
            {crashErr}
          </div>
        )}
        {crashes.length === 0 && !crashErr ? (
          <EmptyState align="center" className="px-0 py-3" title={t("auditTab.crashEmpty")} />
        ) : (
          <div className="rounded-md border text-xs">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-muted/(--opacity-medium)">
                  <th className="px-3 py-2 text-left font-medium">{t("auditTab.crashColName")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("auditTab.crashColTime")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("auditTab.crashColSize")}</th>
                </tr>
              </thead>
              <tbody>
                {crashes.map((c) => (
                  <tr key={c.name} className="border-b last:border-0">
                    <td className="px-3 py-1.5 font-mono text-tiny">{c.name}</td>
                    <td className="px-3 py-1.5 text-muted-foreground font-mono text-tiny whitespace-nowrap">
                      {c.mtime.slice(0, 19).replace("T", " ")}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatBytes(c.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>
    </>
  );
}
