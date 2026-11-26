import { useState, type ReactNode } from "react";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { useTranslation } from "../../../../i18n/react.js";
import { revealHiddenCharacters } from "../../../../shared/display-safe-text.js";
import type { WorkBoardCancelIpcResult, WorkItemResolved } from "../../../../shared/work-board-types.js";
import type { TemplateVersion } from "../../../../shared/workflow-template-types.js";
import type { WorkItemRunState, WorkflowStageUpdate } from "../../hooks/use-work-board-run.js";
import type { AveApi } from "../../types.js";
import { stageDisplayName, WorkflowStageGraph } from "./workflow-template-graph.js";

const STAGE_STATE_KEYS = {
  executing: "workflowTemplates.stageRunning",
  stage_gate: "workflowTemplates.stageGate",
  stage_passed: "workflowTemplates.stagePassed",
  stage_failed: "workflowTemplates.stageFailed",
} as const;

export function WorkflowRunDialog({ item, run, requestedVersion, approvals, onStop, onRetry, onComplete, onHistory, onClose, restoreFocus }: {
  item: WorkItemResolved;
  run?: WorkItemRunState;
  requestedVersion?: TemplateVersion;
  approvals: ReactNode;
  onStop: (id: number) => Promise<WorkBoardCancelIpcResult | { ok: false; error: string }>;
  onRetry: AveApi["retryWorkStage"];
  onComplete: (id: number) => Promise<void>;
  onHistory: () => void;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [retried, setRetried] = useState<string>();
  const updates = run?.stageUpdates ?? {};
  const selectedStage = requestedVersion?.stages.find(stage => stage.id === selected);
  const selectedUpdate = selected ? updates[selected] : undefined;
  const stopped = run?.phase === "cancelled" || item.runStatus === "cancelled";
  const stageUpdates = Object.values(updates);
  const parked = item.templateRunState === "awaiting_review";
  const settled = stopped || run?.phase === "done" || run?.phase === "denied" || run?.phase === "error";
  const canStop = !settled && (item.templateRunState !== undefined || run?.phase === "executing");
  const canComplete = item.runStatus === "completed" && item.status !== "completed";
  const startedAt = item.runHistory?.find(entry => entry.runId === item.runId)?.startedAt;

  async function handleStop() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await onStop(item.id);
      if (!result.ok) setError("workflowTemplates.stopFailed");
    } catch {
      setError("workflowTemplates.stopFailed");
    } finally {
      setBusy(false);
    }
  }

  async function handleComplete() {
    setBusy(true);
    setError(undefined);
    try {
      await onComplete(item.id);
    } catch {
      setError("workflowTemplates.completeFailed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRetry(update: WorkflowStageUpdate) {
    const runId = item.runId;
    if (!runId) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await onRetry(item.id, { runId, stageId: update.stageId });
      if (result.ok) setRetried(`${runId}:${update.stageId}:${update.attempt}`);
      else {
        const key = "reason" in result ? `reasonCodes.${result.reason.replaceAll("_", "-")}` : "";
        setError(key && t(key) !== key ? key : "workflowTemplates.retryFailed");
      }
    } catch {
      setError("workflowTemplates.retryFailed");
    } finally {
      setBusy(false);
    }
  }

  function updateDetails(update: WorkflowStageUpdate) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{t(STAGE_STATE_KEYS[update.phase])}</Badge>
        <span>{t("workflowTemplates.attempt", { attempt: update.attempt })}</span>
        {update.judgedBy === "model" && <Badge variant="secondary">{t("workflowTemplates.modelGate")}</Badge>}
        {update.sessionId && <span>{t("workflowTemplates.stageSession", { session: stageDisplayName(update.sessionId) })}</span>}
      </div>
    );
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent size="2xl" className="min-w-0" onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DialogTitle className="break-words">{stageDisplayName(item.title)}</DialogTitle>
            <div className="flex flex-wrap gap-2">
              {!!item.runHistory?.length && <Button type="button" size="sm" variant="outline" onClick={onHistory}>{t("workBoard.runHistoryHeading")}</Button>}
              {canStop && <Button type="button" size="sm" variant="outline" onClick={() => void handleStop()} disabled={busy || run?.stopping}>{t("workBoard.liveStop")}</Button>}
              <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={busy}>{t("workBoard.closeAriaLabel")}</Button>
            </div>
          </div>
          <DialogDescription>{[item.projectName, item.runId].flatMap(value => value ? [stageDisplayName(value)] : []).join(" · ") || t("workflowTemplates.openRun")}</DialogDescription>
        </DialogHeader>
        {run?.phase === "error" && <p role="alert" className="text-sm text-destructive">{run.reason ?? t("workflowTemplates.runFailed")}</p>}
        {run?.busy && !item.runId && <p role="status" className="text-sm">{t("workBoard.loadingLabel")}</p>}
        {parked && (
          <section className="space-y-1 rounded-lg border border-warning bg-background p-3 text-sm">
            <h2 className="font-semibold text-warning">{t("workflowTemplates.parked")}</h2>
            <p>{t("workflowTemplates.gateDetailsUnavailable")}</p>
          </section>
        )}
        {requestedVersion ? (
          <section className="min-w-0 space-y-2">
            <h2 className="text-base font-semibold">{t("workflowTemplates.requestedVersion", { version: requestedVersion.version })}</h2>
            <WorkflowStageGraph graph={requestedVersion}
              selection={{ id: selected ?? "", onSelect: setSelected }}
              stageStatus={id => updates[id] ? t(STAGE_STATE_KEYS[updates[id].phase]) : undefined} />
            {selectedStage && (
              <div className="space-y-2 rounded-lg border bg-background p-3 text-sm">
                <h3 className="break-words font-semibold">{stageDisplayName(selectedStage.name)}</h3>
                <p className="whitespace-pre-wrap break-words">{revealHiddenCharacters(selectedStage.goal, { lineBreaks: false })}</p>
                {selectedUpdate ? updateDetails(selectedUpdate) : <p className="text-muted-foreground">{t("workflowTemplates.waitingForStage")}</p>}
              </div>
            )}
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">{t("workflowTemplates.runGraphUnavailable")}</p>
        )}
        {stageUpdates.length > 0 && (
          <section className="min-w-0 space-y-2" aria-label={t("workflowTemplates.stageUpdates")}>
            <h2 className="text-base font-semibold">{t("workflowTemplates.stageUpdates")}</h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {stageUpdates.map(update => (
                <li key={update.stageId} className="min-w-0 space-y-1 rounded-md border p-2 text-xs">
                  <h3 className="break-words text-sm font-medium">{stageDisplayName(requestedVersion?.stages.find(stage => stage.id === update.stageId)?.name ?? update.stageId)}</h3>
                  {updateDetails(update)}
                  {update.phase === "stage_failed" && canStop && item.runId && startedAt && update.at >= startedAt && (
                    <Button type="button" size="sm" variant="outline"
                      disabled={busy || run?.stopping || retried === `${item.runId}:${update.stageId}:${update.attempt}`}
                      onClick={() => void handleRetry(update)}>{t("workflowTemplates.retryStage")}</Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {approvals && <section aria-label={t("workBoard.liveRowToolApproval")} className="grid min-w-0 gap-3 sm:grid-cols-2">{approvals}</section>}
        {item.runStatus === "completed" && (
          <section className="space-y-2 rounded-lg border bg-background p-3 text-sm">
            <h2 className="font-semibold">{t("workBoard.reviewInspector")}</h2>
            {item.output && <pre className="whitespace-pre-wrap break-words">{revealHiddenCharacters(item.output, { lineBreaks: false })}</pre>}
            {canComplete && <Button type="button" onClick={() => void handleComplete()} disabled={busy}>{t("workBoard.completeButton")}</Button>}
          </section>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{t(error)}</p>}
      </DialogContent>
    </Dialog>
  );
}
