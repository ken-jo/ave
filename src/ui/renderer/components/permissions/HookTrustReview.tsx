import { useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { HookTrustRow } from "../../types.js";
import type { HookTrustReviewRequest, HookTrustReviewResult } from "../../../../shared/hook-trust-review.js";

interface HookTrustReviewProps {
  rows: readonly HookTrustRow[];
  refresh: () => Promise<void>;
  review?: (request: HookTrustReviewRequest) => Promise<HookTrustReviewResult>;
}

const SOURCE_KEYS = {
  user: "permissionsTab.hookSourceUser",
  system: "permissionsTab.hookSourceSystem",
  project: "permissionsTab.hookSourceProject",
  managed: "permissionsTab.hookSourceManaged",
  plugin: "permissionsTab.hookSourcePlugin",
} as const;

const STATE_KEYS = {
  new: "permissionsTab.hookStateNew",
  changed: "permissionsTab.hookStateChanged",
  trusted: "permissionsTab.hookStateTrusted",
  managed: "permissionsTab.hookStateManaged",
  disabled: "permissionsTab.hookStateDisabled",
  removed: "permissionsTab.hookStateRemoved",
} as const;

export function HookTrustReview({ rows, refresh, review = (request) => window.ave.permission.hookTrustReview(request) }: HookTrustReviewProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReview = async (row: HookTrustRow, action: HookTrustReviewRequest["action"]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await review({ sourceId: row.sourceId ?? "user", fileName: row.fileName,
        expectedSha256: row.sha256, action });
      if (!result.ok) setError(result.error === "hook-review-stale"
        ? t("permissionsTab.hookReviewStale") : result.error === "managed-hook-policy"
          ? t("permissionsTab.hookReviewManaged") : t("permissionsTab.hookReviewFailed"));
      await refresh();
    } catch {
      setError(t("permissionsTab.hookReviewFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="hook-trust-review" className="space-y-3 rounded-lg border p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{t("permissionsTab.hookReviewTitle")}</h3>
          <p className="mt-1 text-muted-foreground">{t("permissionsTab.hookReviewDescription")}</p>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
          {t("permissionsTab.refreshButton")}
        </Button>
      </div>
      {rows.length === 0 && <p className="text-muted-foreground">{t("permissionsTab.hookReviewEmpty")}</p>}
      <ul className="space-y-3">
        {rows.map((row) => {
          const managed = row.hookSource === "managed" || row.state === "managed";
          const source = row.hookSource ?? "user";
          return (
            <li key={`${row.sourceId ?? source}:${row.fileName}`} data-testid="hook-trust-row" data-state={row.state}
              className="space-y-2 rounded border p-3 [overflow-wrap:anywhere]">
              <p className="font-mono text-xs">{row.fileName}</p>
              <p className="text-muted-foreground">{t("permissionsTab.hookReviewSource", { source: t(SOURCE_KEYS[source]) })}</p>
              {source === "project" && row.sourceId && (
                <p data-testid="hook-trust-project-identity" className="font-mono text-xs text-muted-foreground">{row.sourceId}</p>
              )}
              <p data-testid="hook-trust-state">{t(STATE_KEYS[row.state])}
                {row.hashState && row.hashState !== row.state ? ` · ${t(STATE_KEYS[row.hashState])}` : ""}</p>
              <p data-testid="hook-trust-hash" className="font-mono text-xs">SHA-256: {row.sha256}</p>
              {row.previousSha256 && <p className="font-mono text-xs text-muted-foreground">
                {t("permissionsTab.hookReviewPreviousHash", { hash: row.previousSha256 })}</p>}
              {row.entries?.map((entry) => <p key={entry.id ?? `${entry.event}:${entry.matcher ?? ""}:${entry.command}`} className="font-mono text-xs">
                {entry.event}{entry.matcher ? ` (${entry.matcher})` : ""}: {entry.command}
              </p>)}
              {row.hookSource === "project" && row.projectTrusted === false && (
                <div className="space-y-2">
                  <p className="text-muted-foreground">{t("permissionsTab.hookProjectUntrusted")}</p>
                  <Button size="sm" variant="outline" disabled={busy} data-testid="hook-trust-project"
                    onClick={() => void handleReview(row, "trust-project")}>{t("permissionsTab.hookTrustProject")}</Button>
                </div>
              )}
              {managed ? <p className="text-muted-foreground">{t("permissionsTab.hookReviewManaged")}</p> : (
                <div className="flex flex-wrap gap-2">
                  {row.state !== "trusted" && row.state !== "removed" && (
                    <Button size="sm" disabled={busy || row.projectTrusted === false} data-testid="hook-trust-accept" onClick={() => void handleReview(row, "accept")}>
                      {t("permissionsTab.hookReviewTrust")}
                    </Button>
                  )}
                  {row.state !== "disabled" && row.state !== "removed" && (
                    <Button size="sm" variant="outline" disabled={busy} data-testid="hook-trust-disable" onClick={() => void handleReview(row, "disable")}>
                      {t("permissionsTab.hookReviewDisable")}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error !== null && <p role="alert" className="text-destructive">{error}</p>}
    </section>
  );
}
