import { useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";
import type { AppRelaunchError } from "../../../shared/app-relaunch.js";
import { getApi } from "../api-client.js";

const RESTART_ERROR_KEYS: Record<AppRelaunchError, string> = {
  "unauthorized-frame": "permissionsTab.sandboxRestartUnauthorized",
  "user-keyboard-required": "permissionsTab.sandboxRestartGestureRequired",
  "plugin-install-in-progress": "permissionsTab.sandboxRestartPluginBusy",
  "update-install-in-progress": "permissionsTab.sandboxRestartUpdateBusy",
  "relaunch-in-progress": "permissionsTab.sandboxRestartBusy",
  "relaunch-unsupported": "permissionsTab.sandboxRestartUnsupported",
  "relaunch-failed": "permissionsTab.sandboxRestartFailed",
};

export function SandboxRestartDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const laterButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppRelaunchError | null>(null);

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

  return <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
    <DialogContent size="sm" onOpenAutoFocus={(event) => {
      event.preventDefault();
      setError(null);
      laterButton.current?.focus();
    }}>
      <DialogHeader>
        <DialogTitle>{t("permissionsTab.sandboxRestartTitle")}</DialogTitle>
        <DialogDescription>{t("permissionsTab.sandboxRestartDescription")}</DialogDescription>
      </DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{t(RESTART_ERROR_KEYS[error])}</p>}
      <DialogFooter>
        <Button ref={laterButton} variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>{t("permissionsTab.sandboxRestartLater")}</Button>
        <Button disabled={busy} onClick={() => void handleRestart()}>{t("permissionsTab.sandboxRestartNow")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
