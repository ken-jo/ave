import { useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import { APP_RESTART_ERROR_KEYS, type AppRelaunchError } from "../../../shared/app-relaunch.js";
import { getApi } from "../api-client.js";

/** A pending next-launch change stays visible until main's boot inputs match again. */
export function RestartRequiredRow({ pending }: { pending: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppRelaunchError | null>(null);
  if (!pending) return null;
  const handleRestart = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await getApi().relaunchApp();
      if (!result.ok) setError(result.error);
    } catch {
      setError("relaunch-failed");
    } finally {
      setBusy(false);
    }
  };
  return <div className="space-y-2 rounded-md border border-warning p-3" data-testid="settings-restart-required">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 flex-1 text-sm">{t("settingsRestart.pending")}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleRestart()}>{t("permissionsTab.sandboxRestartNow")}</Button>
    </div>
    {error !== null ? <p role="alert" className="text-sm text-destructive">{t(APP_RESTART_ERROR_KEYS[error])}</p> : null}
  </div>;
}

/** Marks the specific startup value that differs from main's boot snapshot. */
export function RestartRequiredChip({ pending }: { pending: boolean }) {
  const { t } = useTranslation();
  return pending ? <span className="inline-flex rounded border border-warning px-1.5 py-0.5 text-xs text-warning" data-testid="setting-restart-chip">{t("settingsRestart.required")}</span> : null;
}
