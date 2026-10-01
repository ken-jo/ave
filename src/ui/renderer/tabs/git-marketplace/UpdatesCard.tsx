/**
 * The Updates card in Settings → Marketplace → Maintenance (design §18.9):
 * when Ave checks for package updates, how the last check ended, *Check
 * now*, and each update with its state. Read-only: it changes no switch, and
 * an update installs through its review (§15.6), which *Review* opens.
 *
 * It reads `updates:status` once and then follows `marketplace:update-status`.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { GitMarketplaceApi, GitMarketplaceFailure, PackageKeyView, UpdateStatusView } from "../../../../shared/git-marketplace.js";
import { kindLabel, relativeTime, updateStateLabel } from "./labels.js";
import { MarketplaceProblem } from "./MarketplaceProblem.js";

export interface UpdatesCardProps {
  api: Pick<GitMarketplaceApi, "updateStatus" | "checkUpdates" | "onUpdateStatus">;
  /** Open a package's update review (§15.6). */
  onReview: (key: PackageKeyView) => void;
  /** Open the Sources view, where each unreachable source says why. */
  onShowSources: () => void;
}

export function UpdatesCard({ api, onReview, onShowSources }: UpdatesCardProps) {
  const { t, locale } = useTranslation();
  const [status, setStatus] = useState<UpdateStatusView | null>(null);
  const [failure, setFailure] = useState<GitMarketplaceFailure | null>(null);
  const [checking, setChecking] = useState(false);
  // A pushed status is newer than an answer still on its way.
  const pushed = useRef(false);

  useEffect(() => {
    let alive = true;
    void api.updateStatus().then((result) => {
      if (!alive || pushed.current) return;
      if (result.ok) setStatus(result.value);
      else setFailure(result);
    });
    const off = api.onUpdateStatus((next) => {
      pushed.current = true;
      setStatus(next);
      setFailure(null);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  const checkNow = async () => {
    setChecking(true);
    setFailure(null);
    try {
      const result = await api.checkUpdates();
      if (result.ok) setStatus(result.value);
      else setFailure(result);
    } finally {
      setChecking(false);
    }
  };

  const running = checking || status?.running === true;
  const discovery = status?.discovery ?? null;
  const lastChecked = discovery?.lastSuccessAt ? relativeTime(discovery.lastSuccessAt, locale) : null;

  return (
    <div className="space-y-2" data-testid="git-marketplace:updates">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("gitMarketplace.updates.title")}</span>
        <Button size="sm" variant="outline" disabled={running || status === null} onClick={() => void checkNow()} data-testid="git-marketplace:updates:check">
          {running ? t("gitMarketplace.updates.checking") : t("gitMarketplace.updates.checkNow")}
        </Button>
      </div>
      {/* The scheduler's own sentence; main's message is behind Copy details, scrubbed. */}
      {failure && (
        <MarketplaceProblem tone="error" text={t("gitMarketplace.updates.unavailable")} details={`${failure.code}\n${failure.message}`} testId="git-marketplace:updates:error" />
      )}
      {status === null ? (
        failure === null && <p className="text-xs text-muted-foreground">{t("gitMarketplace.loading")}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="git-marketplace:updates:cadence">
            {t("gitMarketplace.updates.cadence")}
            {" · "}
            {lastChecked === null ? t("gitMarketplace.updates.neverChecked") : t("gitMarketplace.updates.lastChecked", { time: lastChecked })}
            {!running && ` · ${t("gitMarketplace.updates.next", { time: relativeTime(status.discovery.nextAt, locale) })}`}
          </p>
          {status.historyReset && (
            <p className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs" data-testid="git-marketplace:updates:history-reset">
              {t("gitMarketplace.updates.historyReset")}
            </p>
          )}
          {!running && discovery?.result === "offline" && (
            <p className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs" data-testid="git-marketplace:updates:offline">
              {lastChecked === null ? t("gitMarketplace.updates.offlineNever") : t("gitMarketplace.updates.offline", { time: lastChecked })}
            </p>
          )}
          {!running && discovery?.result === "partial" && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs" data-testid="git-marketplace:updates:partial">
              <span className="min-w-0 flex-1">{t("gitMarketplace.updates.partial")}</span>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onShowSources}>
                {t("gitMarketplace.updates.showSources")}
              </Button>
            </div>
          )}
          {!running && discovery?.result === "error" && (
            <p className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-soft) px-3 py-2 text-xs text-destructive" data-testid="git-marketplace:updates:failed">
              {t("gitMarketplace.updates.error")}
            </p>
          )}
          {status.packages.length === 0 ? (
            discovery?.result === "ok" && <p className="text-xs text-muted-foreground" data-testid="git-marketplace:updates:none">{t("gitMarketplace.updates.none")}</p>
          ) : (
            <ul className="divide-y rounded-md border" data-testid="git-marketplace:updates:list">
              {status.packages.map((update) => (
                <li
                  key={`${update.key.sourceId}:${update.key.kind}:${update.key.name}`}
                  className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
                  data-testid={`git-marketplace:updates:row:${update.key.sourceId}:${update.key.kind}:${update.key.name}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{update.displayName}</span>
                    <span className="text-muted-foreground">
                      {kindLabel(t, update.key.kind)} · <span className="font-mono">{update.from} → {update.to}</span>
                    </span>
                    {update.stale && (
                      <span className="block text-muted-foreground" data-testid="git-marketplace:updates:stale">
                        {t("gitMarketplace.updates.stale")}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground" data-testid="git-marketplace:updates:state">{updateStateLabel(t, update.state)}</span>
                  {(update.state === "manual" || update.state === "needs-review") && (
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => onReview(update.key)}>
                      {t("gitMarketplace.updates.review")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
