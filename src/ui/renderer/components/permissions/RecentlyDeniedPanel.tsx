import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { RecentlyDeniedEntry } from "../../../../shared/recently-denied.js";

export function RecentlyDeniedPanel({ showEmpty = false, onRerun }: { showEmpty?: boolean; onRerun?: () => void }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<RecentlyDeniedEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const result = await window.ave?.permission.recentlyDeniedList();
      if (result?.ok) { setEntries(result.entries); setError(false); }
      else setError(true);
    } catch { setError(true); }
  }, []);
  useEffect(() => {
    void refresh();
    return window.ave?.permission.onRecentlyDeniedChanged(() => { void refresh(); });
  }, [refresh]);
  const handleRerun = async (id: string) => {
    setBusy(id);
    onRerun?.();
    try {
      const result = await window.ave?.permission.recentlyDeniedRerun(id);
      setError(!result?.ok);
      await refresh();
      if (!result?.ok) setError(true);
    } catch { setError(true); }
    finally { setBusy(null); }
  };
  if (!entries.length && !showEmpty && !error) return null;
  return <section className="min-w-0 space-y-3" data-testid="recently-denied-panel">
    <h3 className="text-base font-semibold">{t("recentlyDenied.title")}</h3>
    <p className="text-sm text-muted-foreground">{t("recentlyDenied.description")}</p>
    {error && <p role="alert" className="text-sm text-destructive">{t("recentlyDenied.error")}</p>}
    {!entries.length && <p className="text-sm text-muted-foreground">{t("recentlyDenied.empty")}</p>}
    <ul className="space-y-3">{entries.map((entry) => <li key={entry.id} data-testid={`recently-denied-entry-${entry.id}`} className="min-w-0 rounded border p-3 space-y-2">
      <div className="flex justify-between gap-2"><code>{entry.toolName}</code><time className="text-xs text-muted-foreground" dateTime={entry.ts}>{new Date(entry.ts).toLocaleString()}</time></div>
      <p className="text-sm">{entry.reason}</p>
      <pre data-testid="recently-denied-input" className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all text-xs">{entry.inputSummary}</pre>
      <Button size="sm" disabled={busy !== null || !entry.rerunAvailable} onClick={() => { void handleRerun(entry.id); }}>{t("recentlyDenied.rerun")}</Button>
      <p className="text-xs text-muted-foreground">{t(entry.rerunAvailable ? "recentlyDenied.freshApproval" : "recentlyDenied.unavailable")}</p>
    </li>)}</ul>
  </section>;
}
