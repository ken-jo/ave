import { useCallback, useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Trash2, X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import type { DocumentEngineApi, DocumentEngineApiError } from "../../../shared/document-engine-api.js";
import type { DocumentEngineInstallationState } from "../../../shared/document-engine.js";
import { DOCUMENT_ENGINE_IMPORTER } from "../../../shared/document-engine-importer.js";
import { getApi } from "../api-client.js";

const INSTALLATION_POLL_MS = 500;
const ACTIVE_INSTALL_PHASES: readonly DocumentEngineInstallationState["phase"][] = Object.freeze([
  "downloading", "verifying", "installing", "cancelling", "verifying-installation",
]);

function installationErrorKey(error: DocumentEngineApiError): string {
  switch (error) {
    case "download-failed": return "documentEngine.downloadFailed";
    case "integrity-failed": return "documentEngine.integrityFailed";
    case "signature-failed": return "documentEngine.signatureFailed";
    case "unsupported-platform": return "documentEngine.unsupported";
    case "cancelled": return "documentEngine.cancelled";
    case "busy": return "documentEngine.busy";
    case "unauthorized":
    case "bad-request":
    case "install-failed": return "documentEngine.installFailed";
  }
}

/** Optional installation is a direct user action and grants no document write authority. */
export function DocumentEngineInstallContent({ onDismiss, api = getApi().documentEngine }: {
  onDismiss?: () => void;
  api?: DocumentEngineApi;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<DocumentEngineInstallationState>();
  const [error, setError] = useState<DocumentEngineApiError>();
  const [statusReadFailed, setStatusReadFailed] = useState(false);
  const [sourceOpenFailed, setSourceOpenFailed] = useState(false);
  const [acting, setActing] = useState(false);
  const active = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);

  const refresh = useCallback(async function readState(): Promise<void> {
    const current = ++generation.current;
    clearTimeout(timer.current);
    try {
      const result = await api.status();
      if (!active.current || current !== generation.current) return;
      if (!result.ok) { setError(result.error); setStatusReadFailed(true); return; }
      setState(result.state);
      setError(result.state.error);
      setStatusReadFailed(false);
      if (ACTIVE_INSTALL_PHASES.includes(result.state.phase)) {
        timer.current = setTimeout(() => { void readState(); }, INSTALLATION_POLL_MS);
      }
    } catch {
      if (active.current && current === generation.current) { setError("install-failed"); setStatusReadFailed(true); }
    }
  }, [api]);

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      generation.current += 1;
      clearTimeout(timer.current);
    };
  }, [refresh]);

  const handleAction = async (action: "install" | "cancel" | "uninstall"): Promise<void> => {
    setActing(true);
    setError(undefined);
    try {
      const result = await api[action]();
      if (!active.current) return;
      if (!result.ok) setError(result.error);
      else await refresh();
    } catch {
      if (active.current) setError("install-failed");
    } finally {
      if (active.current) setActing(false);
    }
  };

  const handleOpenProvenance = async (url: string): Promise<void> => {
    setSourceOpenFailed(false);
    try {
      const result = await getApi().openExternalUrl(url);
      if (active.current && !result.ok) setSourceOpenFailed(true);
    } catch {
      if (active.current) setSourceOpenFailed(true);
    }
  };

  const working = state !== undefined && ACTIVE_INSTALL_PHASES.includes(state.phase);
  const ready = state?.phase === "ready";
  const supported = state?.phase !== "unsupported";
  const percent = state && state.downloadBytes > 0
    ? Math.min(100, Math.floor(100 * state.downloadedBytes / state.downloadBytes)) : 0;
  const mebibytes = (bytes: number): string => (bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const phaseKey = state?.phase === "downloading" ? "documentEngine.downloading"
    : state?.phase === "verifying" ? "documentEngine.verifying"
      : state?.phase === "verifying-installation" ? "documentEngine.verifyingInstallation"
        : state?.phase === "cancelling" ? "documentEngine.cancelling" : "documentEngine.installing";
  // Runtime admission of an installed engine is not an install operation and cannot be cancelled.
  const cancellable = working && state?.phase !== "verifying-installation";

  return <section className="space-y-3 rounded-lg border border-border bg-background p-4" data-testid="document-engine-install">
    <div className="flex items-start gap-3">
      <Download aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="text-sm font-medium">{t("documentEngine.title")} <span className="font-normal text-muted-foreground">{t("documentEngine.optional")}</span></h3>
        <p className="text-xs text-muted-foreground">{t("documentEngine.description")}</p>
      </div>
      {onDismiss ? <Button variant="ghost" size="icon-xs" aria-label={t("documentEngine.later")} onClick={onDismiss}>
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </Button> : null}
    </div>
    {state ? <p className="text-xs text-muted-foreground" data-testid="document-engine-size">{t("documentEngine.size", {
      download: mebibytes(state.downloadBytes), installed: mebibytes(state.installedBytes), version: state.version,
    })}</p> : <p role="status" className="text-xs text-muted-foreground">{t("documentEngine.loading")}</p>}
    <p className="text-xs text-muted-foreground">{t("documentEngine.localOnly")}</p>
    <p className="text-xs text-muted-foreground">{t("documentEngine.hwpRuntime")}</p>
    <div className="flex flex-wrap gap-3 text-xs">
      <a className="underline underline-offset-2" href={DOCUMENT_ENGINE_IMPORTER.source} rel="noreferrer"
        onClick={(event) => { event.preventDefault(); void handleOpenProvenance(DOCUMENT_ENGINE_IMPORTER.source); }}>{t("documentEngine.importerSource")}</a>
      <a className="underline underline-offset-2" href={DOCUMENT_ENGINE_IMPORTER.license} rel="noreferrer"
        onClick={(event) => { event.preventDefault(); void handleOpenProvenance(DOCUMENT_ENGINE_IMPORTER.license); }}>{t("documentEngine.importerLicense")}</a>
    </div>
    {sourceOpenFailed ? <p role="alert" className="text-xs text-destructive">{t("documentEngine.sourceOpenFailed")}</p> : null}
    <p className="text-xs text-muted-foreground">{t("documentEngine.platformAvailability")}</p>
    {working && <div className="space-y-1" role="status" aria-live="polite">
      <div className="flex items-center gap-1.5 text-xs"><LoaderCircle aria-hidden="true" className="h-3 w-3 motion-safe:animate-spin" />
        {t(phaseKey)}{state?.phase === "downloading" ? ` · ${percent}%` : ""}</div>
      {state?.phase === "downloading" && <progress className="h-1.5 w-full accent-primary" max={state.downloadBytes || 1}
        value={state.downloadedBytes} aria-label={t("documentEngine.downloading")} />}
    </div>}
    {ready && <p role="status" className="text-xs text-muted-foreground">{t("documentEngine.ready")}</p>}
    {error && <p role={error === "cancelled" ? "status" : "alert"} className="text-xs text-destructive">{t(installationErrorKey(error))}</p>}
    {statusReadFailed && error === "integrity-failed" ? <p className="text-xs text-muted-foreground">{t("documentEngine.repairRequired")}</p> : null}
    {!supported && !error && <p role="status" className="text-xs text-muted-foreground">{t("documentEngine.unsupported")}</p>}
    <div className="flex flex-wrap gap-2">
      {statusReadFailed ? <Button type="button" size="sm" variant="outline" disabled={acting} onClick={() => void refresh()}>
        {t("documentEngine.checkAgain")}</Button>
        : cancellable ? <Button type="button" size="sm" variant="outline" disabled={acting || state?.phase === "cancelling"}
        onClick={() => void handleAction("cancel")}>{t("documentEngine.cancel")}</Button>
        : working ? null
        : ready ? <Button type="button" size="sm" variant="outline" disabled={acting} onClick={() => void handleAction("uninstall")}>
          <Trash2 aria-hidden="true" className="mr-1 h-3.5 w-3.5" />{t("documentEngine.uninstall")}</Button>
          : <Button type="button" size="sm" disabled={acting || (!state && !error) || !supported} onClick={() => void handleAction("install")}>
            {t(error ? "documentEngine.retry" : "documentEngine.install")}</Button>}
      {!statusReadFailed && !working && !ready && (error === "integrity-failed" || error === "signature-failed")
        ? <Button type="button" size="sm" variant="outline" disabled={acting} onClick={() => void handleAction("uninstall")}>
          <Trash2 aria-hidden="true" className="mr-1 h-3.5 w-3.5" />{t("documentEngine.uninstall")}</Button> : null}
      {onDismiss ? <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>{t("documentEngine.later")}</Button> : null}
    </div>
  </section>;
}
