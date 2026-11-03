import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { AveHomeTrustReason, AveHomeTrustReview, AveHomeTrustRow } from "../../../../shared/ave-home-trust.js";
import { isIpcErrorResult } from "../../types.js";
import { SandboxRestartDialog } from "../SandboxRestartDialog.js";

const REASON_KEYS: Record<AveHomeTrustReason, string> = {
  new: "permissionsTab.homeTrustReasonNew",
  changed: "permissionsTab.homeTrustReasonChanged",
  link: "permissionsTab.homeTrustReasonLink",
  unreadable: "permissionsTab.homeTrustReasonUnreadable",
  "foreign-owner": "permissionsTab.homeTrustReasonForeignOwner",
  "foreign-access": "permissionsTab.homeTrustReasonForeignAccess",
  "home-refused": "permissionsTab.homeTrustReasonHomeRefused",
  "home-recovery": "permissionsTab.homeTrustReasonHomeRecovery",
};

/**
 * The home content review (slice 3): items in the Ave folder that Ave did not write or the user has not approved stay unloaded,
 * and extensions run confined, until each is approved or removed here. Approval records the hash this card showed; the item
 * loads after a restart. "Approve all" appears only when the host offers it (a clean folder from an earlier Ave version).
 */
export function HomeContentReview() {
  const { t } = useTranslation();
  const [review, setReview] = useState<AveHomeTrustReview | null>(null);
  const [busy, setBusy] = useState(false);
  // The host's own refusal message, or "" for the generic failure text.
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AveHomeTrustRow | null>(null);
  const [approvedThisSession, setApprovedThisSession] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await window.ave.permission.homeTrustReview();
      if (isIpcErrorResult(result)) { setError(result.message ?? ""); return; }
      setReview(result);
    } catch {
      setError("");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (run: () => Promise<{ ok: true } | { ok: false; error: string; message?: string }>, approved: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await run();
      if (!result.ok) setError(result.message ?? "");
      else if (approved) setApprovedThisSession(true);
    } catch {
      setError("");
    } finally {
      setBusy(false);
      await load();
    }
  };

  if (review === null || (review.rows.length === 0 && review.unavailable === undefined && !approvedThisSession)) {
    return error !== null ? <p role="alert" data-testid="home-trust-error" className="text-sm text-destructive">{error || t("permissionsTab.homeTrustActionFailed")}</p> : null;
  }
  const snapshotId = review.snapshotId;
  return (
    <section data-testid="home-trust-review" className="space-y-2 rounded-lg border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) p-3 text-sm">
      <h3 className="font-semibold">{t("permissionsTab.homeTrustTitle")}</h3>
      {review.unavailable !== undefined ? (
        <p data-testid="home-trust-unavailable">{t(review.unavailable === "recovery" ? "permissionsTab.homeTrustUnavailableRecovery" : "permissionsTab.homeTrustUnavailablePermissions")}</p>
      ) : review.rows.length === 0 ? (
        <p data-testid="home-trust-done">{t("permissionsTab.homeTrustDone")}</p>
      ) : (
        <>
          <p>{t("permissionsTab.homeTrustDescription")}</p>
          {review.approveAllOffered && (
            <div className="space-y-1">
              <p>{t("permissionsTab.homeTrustApproveAllHint")}</p>
              <Button size="sm" data-testid="home-trust-approve-all" disabled={busy}
                onClick={() => void act(() => window.ave.permission.homeTrustApprove(snapshotId), true)}>
                {t("permissionsTab.homeTrustApproveAll", { count: review.rows.length })}
              </Button>
            </div>
          )}
          <ul className="space-y-2">
            {review.rows.map((row) => (
              <li key={row.key} data-testid="home-trust-row" data-key={row.key} className="space-y-1 rounded border border-border p-2">
                <p className="break-all font-mono text-xs">{row.key}</p>
                <p className="text-xs text-muted-foreground">{t(REASON_KEYS[row.reason])}</p>
                {row.summary !== undefined && <p data-testid="home-trust-summary" className="break-all text-xs">{row.summary}</p>}
                {row.hash !== undefined && <p className="font-mono text-[11px] text-muted-foreground">sha256 {row.hash.slice(0, 16)}</p>}
                <div className="flex gap-2">
                  {row.approvable && (
                    <Button size="sm" variant="outline" data-testid="home-trust-approve" disabled={busy}
                      onClick={() => void act(() => window.ave.permission.homeTrustApprove(snapshotId, [row.key]), true)}>
                      {t("permissionsTab.homeTrustApprove")}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" data-testid="home-trust-remove" disabled={busy} onClick={() => setRemoving(row)}>
                    {t("permissionsTab.homeTrustRemove")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {approvedThisSession && review.pendingAtBoot && (
        <div className="space-y-1">
          <p data-testid="home-trust-restart-hint">{t("permissionsTab.homeTrustRestartHint")}</p>
          <Button size="sm" variant="outline" onClick={() => setRestartOpen(true)}>{t("permissionsTab.sandboxRestartNow")}</Button>
        </div>
      )}
      {error !== null && <p role="alert" data-testid="home-trust-error" className="text-sm text-destructive">{error || t("permissionsTab.homeTrustActionFailed")}</p>}
      <Dialog open={removing !== null} onOpenChange={(next) => { if (!next && !busy) setRemoving(null); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("permissionsTab.homeTrustRemoveTitle")}</DialogTitle>
            <DialogDescription className="break-all">{t("permissionsTab.homeTrustRemoveDescription", { path: removing?.path ?? "" })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" disabled={busy} onClick={() => setRemoving(null)}>{t("permissionsTab.homeTrustRemoveCancel")}</Button>
            <Button variant="destructive" data-testid="home-trust-remove-confirm" disabled={busy} onClick={() => {
              const row = removing;
              setRemoving(null);
              if (row) void act(() => window.ave.permission.homeTrustRemove(snapshotId, row.key), false);
            }}>{t("permissionsTab.homeTrustRemoveConfirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SandboxRestartDialog open={restartOpen} onOpenChange={setRestartOpen} />
    </section>
  );
}
