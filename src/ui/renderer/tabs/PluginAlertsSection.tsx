import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Switch } from "../../../components/ui/switch.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";
import { localeText } from "../../../alerts/render.js";
import { ALERT_HOST_PLUGIN_ID, type AlertKindRow, type AlertKindPatch } from "../../../shared/alerts-types.js";
import type { AveApi } from "../types.js";
import { formatIpcError } from "../format-ipc-error.js";

type AlertsApi = NonNullable<AveApi["alerts"]>;

function AlertKindControl({ row, api, refresh }: { row: AlertKindRow; api: AlertsApi; refresh: () => Promise<void> }) {
  const { t, locale } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const acknowledged = useRef(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const label = localeText(row.declaration.label, locale);
  const save = useCallback(async (patch: AlertKindPatch) => {
    setWorking(true); setError(null);
    try {
      const result = await api.setKind(row.kindKey, patch);
      if ("error" in result) {
        setError(formatIpcError(result.error, undefined));
        return { ok: false };
      }
      await refresh();
      return { ok: true };
    } catch { setError(t("alerts.saveFailed")); return { ok: false }; }
    finally { setWorking(false); }
  }, [api, row.kindKey, refresh, t]);

  // Prefetching a plugin's kinds is not a visit. A row must reach the viewport.
  useEffect(() => {
    if (row.choice.seenByUser || acknowledged.current || !root.current) return;
    let visible = false;
    const observer = new IntersectionObserver((entries) => {
      const intersecting = entries.some((entry) => entry.isIntersecting);
      const entered = intersecting && !visible;
      visible = intersecting;
      if (!entered || acknowledged.current) return;
      acknowledged.current = true;
      void save({}).then((result) => {
        if (result.ok) observer.disconnect();
        else acknowledged.current = false;
      });
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [row.choice.seenByUser, save]);

  async function remove() {
    setWorking(true); setError(null);
    try {
      const result = await api.removePredecessor(row.kindKey);
      if (!result.ok) setError(formatIpcError(result.error, undefined));
      else { setConfirming(false); await refresh(); }
    } catch { setError(t("alerts.predecessorRemovalFailed")); }
    finally { setWorking(false); }
  }

  return <div ref={root} data-testid={`alert-kind:${row.kindKey}`} className="min-w-0 space-y-2 rounded-md border border-border p-3">
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0 break-words [overflow-wrap:anywhere]">
        <span className="text-sm font-medium">{label}</span>
        {!row.choice.seenByUser && <span className="ml-2 text-xs text-primary">{t("alerts.new")}</span>}
        {row.pluginId === ALERT_HOST_PLUGIN_ID && row.reasoning && <p className="mt-1 text-xs text-muted-foreground">{row.reasoning}</p>}
        {row.declaration.description && <p className="mt-1 text-xs text-muted-foreground">{localeText(row.declaration.description, locale)}</p>}
      </div>
      <Switch className="shrink-0" aria-label={t("alerts.enabledLabel", { label })} checked={row.choice.enabled} disabled={working} onCheckedChange={(enabled) => void save({ enabled })} />
    </div>
    {row.declaration.osNotification && <label className="flex min-w-0 items-center justify-between gap-3 text-xs">
      <span className="min-w-0 break-words">{t("alerts.osNotification")}</span>
      <Switch className="shrink-0" aria-label={t("alerts.osLabel", { label })} checked={row.choice.osNotification} disabled={working} onCheckedChange={(osNotification) => void save({ osNotification })} />
    </label>}
    {row.blockedByPredecessor && <div className="space-y-1 break-words [overflow-wrap:anywhere] text-xs text-muted-foreground" data-testid={`alert-predecessor:${row.kindKey}`}>
      <p>{t("alerts.waiting", { label: row.predecessor?.label ?? row.blockedByPredecessor })}</p>
      {row.predecessor?.locked && <p>{t("alerts.managed")}</p>}
      {row.predecessor?.restartRequired && <p>{t("alerts.restart")}</p>}
      {row.predecessor?.removable && <Button size="sm" variant="outline" disabled={working} onClick={() => setConfirming(true)}>{t("alerts.remove")}</Button>}
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <Dialog open={confirming} onOpenChange={(open) => !working && setConfirming(open)}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("alerts.removeTitle")}</DialogTitle><DialogDescription>{t("alerts.removeDescription", { label: row.predecessor?.label ?? row.blockedByPredecessor ?? "" })}</DialogDescription></DialogHeader>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter><Button variant="secondary" disabled={working} onClick={() => setConfirming(false)}>{t("alerts.cancel")}</Button><Button variant="destructive" disabled={working} onClick={() => void remove()}>{t("alerts.remove")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

export function PluginAlertsSection({ pluginId, rows, api, osEnabled, refresh }: {
  pluginId: string; rows: AlertKindRow[]; api: AlertsApi; osEnabled: boolean; refresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const kinds = rows.filter((row) => row.pluginId === pluginId);
  const builtIn = pluginId === ALERT_HOST_PLUGIN_ID;
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!builtIn && kinds.length === 0) return null;
  async function setMaster(enabled: boolean) {
    setWorking(true); setError(null);
    try {
      const result = await api.setOsNotificationsEnabled(enabled);
      if ("error" in result) setError(formatIpcError(result.error, undefined));
      else await refresh();
    } catch { setError(t("alerts.saveFailed")); }
    finally { setWorking(false); }
  }
  return <section data-testid={`plugin-alerts:${pluginId}`} className="min-w-0 space-y-3 border-t border-border pt-3">
    <h3 className="text-sm font-semibold">{t(builtIn ? "alerts.builtIn" : "alerts.title")}</h3>
    {builtIn && <label className="flex items-center justify-between gap-3 text-xs"><span>{t("alerts.osMaster")}</span><Switch className="shrink-0" aria-label={t("alerts.osMaster")} checked={osEnabled} disabled={working} onCheckedChange={(enabled) => void setMaster(enabled)} /></label>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {!builtIn && kinds[0]?.reasoning && <p className="break-words [overflow-wrap:anywhere] text-xs text-muted-foreground">{kinds[0].reasoning}</p>}
    {kinds.map((row) => <AlertKindControl key={`${row.kindKey}:${row.declaration.visibility}`} row={row} api={api} refresh={refresh} />)}
  </section>;
}
