import { DocumentSettingsContent } from "./DocumentSettingsContent.js";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Brain, Cpu, FolderOpen } from "lucide-react";
import { Switch } from "../../../components/ui/switch.js";
import { useSettingsSnapshot } from "../hooks/use-settings-snapshot.js";
import { formatIpcError } from "../format-ipc-error.js";
import { isIpcErrorResult, type AppSettings, type AveApi } from "../types.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import type { BootSettingsSnapshot } from "../../../shared/restart-settings.js";

export interface AboutTabProps {
  api: AveApi;
}

export interface AppInfo extends BootSettingsSnapshot {
  version: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  v8Version: string;
  platform: NodeJS.Platform;
  arch: string;
  userDataPath: string;
}

/** Map `process.platform` to a user-friendly label. */
function platformLabel(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

/**
 * AboutTab — the emptied-out former General tab, now holding only System Info
 * (OS / app version / tech stack / data path). Account, workspace stats, and
 * auth management were relocated to the Model + Usage surfaces. System-Info
 * testids are kept stable (general-tab-*) for continuity with existing specs.
 */
/** The app's own identity (version, paths) as main reports it. One reader for every settings surface that names the
 * version, so a label can never drift from what is actually running. */
export function useAppInfo(api: Pick<AveApi, "getAppInfo">): AppInfo | null {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const info = await api.getAppInfo();
        if (alive) setAppInfo(info);
      } catch {
        /* getAppInfo only errors on IPC failure — non-fatal */
      }
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  return appInfo;
}

export function AboutTab({ api }: AboutTabProps) {
  const { t } = useTranslation();
  const appInfo = useAppInfo(api);
  const [autoCheckEnabled, setAutoCheckEnabled] = useState<boolean | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateChecked, setUpdateChecked] = useState(false);
  const applySettings = useCallback((settings: AppSettings) => setAutoCheckEnabled(settings.updates?.autoCheckEnabled ?? true), []);
  useSettingsSnapshot(api, applySettings);
  const handleAutoCheckChange = async (enabled: boolean) => {
    setUpdateError(null);
    setUpdateBusy(true);
    try {
      const result = await api.updateSettings({ updates: { autoCheckEnabled: enabled } });
      if (isIpcErrorResult(result)) throw new Error(formatIpcError(result.error, result.message));
      setAutoCheckEnabled(result.updates?.autoCheckEnabled ?? true);
    } catch {
      setUpdateError(t("aboutUpdates.saveFailed"));
    } finally {
      setUpdateBusy(false);
    }
  };
  const handleCheck = async () => {
    setUpdateError(null);
    setUpdateChecked(false);
    setUpdateBusy(true);
    try {
      const result = await api.checkForAppUpdates();
      if (!result.ok) setUpdateError(t(result.reason === "updater-unavailable" ? "aboutUpdates.unavailable" : "aboutUpdates.checkFailed"));
      else setUpdateChecked(true);
    } catch {
      setUpdateError(t("aboutUpdates.checkFailed"));
    } finally {
      setUpdateBusy(false);
    }
  };

  const copyDataPath = useCallback(() => {
    if (!appInfo) return;
    void navigator.clipboard?.writeText(appInfo.userDataPath);
  }, [appInfo]);

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("settingsContent.tabAbout")}
        description={t("generalTab.systemInfoDescription")}
      />

      <SettingsSection data-settings-section="about-updates" title={t("aboutUpdates.title")} description={t("aboutUpdates.description")}>
        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0 flex-1 text-sm">{t("aboutUpdates.autoCheck")}</span>
          <Switch aria-label={t("aboutUpdates.autoCheck")} checked={autoCheckEnabled === true} disabled={autoCheckEnabled === null || updateBusy}
            onCheckedChange={(enabled) => void handleAutoCheckChange(enabled)} data-testid="about-auto-check-updates" />
        </div>
        <Button className="mt-3" variant="outline" disabled={updateBusy} onClick={() => void handleCheck()} data-testid="about-check-updates">{t("aboutUpdates.checkNow")}</Button>
        {updateError !== null ? <p role="alert" className="mt-2 text-sm text-destructive">{updateError}</p> : null}
        {updateChecked ? <p role="status" className="mt-2 text-sm text-muted-foreground">{t("aboutUpdates.checked")}</p> : null}
      </SettingsSection>
      {/* ── 시스템 정보 ─────────────────────────────── */}
      <SettingsSection data-settings-section="about-system-info" title={t("generalTab.systemInfoTitle")}>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className="flex items-start gap-3 rounded-md border bg-card/(--opacity-half) p-3">
            <Cpu className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
            <div className="min-w-0">
              <dt className="text-dense uppercase tracking-wide text-muted-foreground">{t("generalTab.osLabel")}</dt>
              <dd className="font-medium">
                {appInfo ? `${platformLabel(appInfo.platform)} · ${appInfo.arch}` : t("generalTab.loading")}
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border bg-card/(--opacity-half) p-3">
            <Brain className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
            <div className="min-w-0">
              <dt className="text-dense uppercase tracking-wide text-muted-foreground">{t("generalTab.appVersionLabel")}</dt>
              <dd className="font-mono text-xs" data-testid="general-tab-app-version">
                {appInfo ? `v${appInfo.version}` : t("generalTab.loading")}
              </dd>
            </div>
          </div>
          <div
            className="flex items-start gap-3 rounded-md border bg-card/(--opacity-half) p-3 sm:col-span-2"
            data-testid="general-tab-stack-info"
          >
            <Cpu className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
            <div className="min-w-0 flex-1">
              <dt className="text-dense uppercase tracking-wide text-muted-foreground">{t("generalTab.techStackLabel")}</dt>
              <dd className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-dense sm:grid-cols-4">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-muted-foreground">Electron</span>
                  <span data-testid="general-tab-stack-electron">
                    {appInfo?.electronVersion ? `v${appInfo.electronVersion}` : "—"}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-muted-foreground">Node</span>
                  <span data-testid="general-tab-stack-node">
                    {appInfo?.nodeVersion ? `v${appInfo.nodeVersion}` : "—"}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-muted-foreground">Chromium</span>
                  <span data-testid="general-tab-stack-chrome">
                    {appInfo?.chromeVersion ? `v${appInfo.chromeVersion}` : "—"}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-muted-foreground">V8</span>
                  <span data-testid="general-tab-stack-v8">
                    {appInfo?.v8Version ? `v${appInfo.v8Version}` : "—"}
                  </span>
                </div>
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border bg-card/(--opacity-half) p-3 sm:col-span-2">
            <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
            <div className="min-w-0 flex-1">
              <dt className="text-dense uppercase tracking-wide text-muted-foreground">{t("generalTab.dataPathLabel")}</dt>
              <dd className="flex items-center gap-2">
                <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {appInfo?.userDataPath ?? t("generalTab.loading")}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 px-2 text-dense"
                  onClick={copyDataPath}
                  disabled={!appInfo}
                  aria-label={t("generalTab.copyDataPathAriaLabel")}
                >
                  {t("generalTab.copyButton")}
                </Button>
              </dd>
            </div>
          </div>
        </dl>
      </SettingsSection>
      <DocumentSettingsContent />
    </div>
  );
}
