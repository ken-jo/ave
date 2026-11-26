import { workBoardDecisionProps } from "../../../../shared/work-board-decision-intent.js";
import { WORK_BOARD } from "../../../../shared/ipc-channels.js";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { useTranslation } from "../../../../i18n/react.js";
import { revealHiddenCharacters } from "../../../../shared/display-safe-text.js";
import type { WorkBoardCancelIpcResult, WorkItemResolved } from "../../../../shared/work-board-types.js";
import { workflowDecisionHistoryKey } from "../../../../shared/workflow-run-view.js";
import type { TemplateVersion } from "../../../../shared/workflow-template-types.js";
import type { WorkItemRunState, WorkflowStageUpdate } from "../../hooks/use-work-board-run.js";
import type { AveApi } from "../../types.js";
import { WorkflowDecisionCard, workflowDecisionKey } from "./WorkflowDecisionCard.js";
import { WorkflowRunEvidence, WorkflowStageEvidence } from "./WorkflowRunEvidence.js";
import { stageDisplayName, WorkflowStageGraph } from "./workflow-template-graph.js";

const STAGE_STATE_KEYS = {
  executing: "workflowTemplates.stageRunning",
  stage_gate: "workflowTemplates.stageGate",
  stage_passed: "workflowTemplates.stagePassed",
  stage_failed: "workflowTemplates.stageFailed",
} as const;

export function WorkflowRunDialog({ api, item, run, requestedVersion, approvals, onStop, onRetry, onComplete, onHistory, onClose, restoreFocus }: {
  api: Pick<AveApi, "getWorkBoardItem" | "getWorkflowTemplate" | "onWorkBoardItemChanged" | "decideWorkStage" | "decideWorkJoin" | "openWorkBoardJoin">;
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
  const [inspectedRun, setInspectedRun] = useState<string>();
  const [detail, setDetail] = useState<{ item: WorkItemResolved; inspectedRun?: string; requestedAt: string }>();
  const [readError, setReadError] = useState(false);
  const refreshRun = useRef<() => void>(() => {});
  const [resolvedVersion, setResolvedVersion] = useState<TemplateVersion>();
  const activeDetail = detail?.inspectedRun === inspectedRun && detail?.item.runId === item.runId ? detail : undefined;
  const readItem = activeDetail?.item ?? item;
  const showingHistory = inspectedRun !== undefined;
  const storedRun = activeDetail?.item.workflowRun ?? (showingHistory ? undefined : item.workflowRun);
  const liveRun = !showingHistory && run?.workflowRun && run.workflowRun.runId === item.runId
    && (!activeDetail || (run.workflowRunAt ?? "") >= activeDetail.requestedAt) ? run.workflowRun : undefined;
  const snapshot = liveRun && storedRun ? {
    ...liveRun,
    decisions: [
      ...storedRun.decisions.filter(old => !liveRun.decisions.some(next => workflowDecisionHistoryKey(next) === workflowDecisionHistoryKey(old))),
      ...liveRun.decisions,
    ].sort((a, b) => a.at.localeCompare(b.at)),
  } : liveRun ?? storedRun;
  const pin = snapshot?.pin ?? (showingHistory
    ? item.workflowRunPins?.find(entry => entry.runId === inspectedRun)?.pin
    : item.runPin ?? readItem.runPin);
  const graph = resolvedVersion && pin && resolvedVersion.templateId === pin.templateId && resolvedVersion.version === pin.version
    && resolvedVersion.graphHash === pin.graphHash ? resolvedVersion : !pin && !showingHistory ? requestedVersion : undefined;
  const stageName = (id: string) => stageDisplayName(graph?.stages.find(stage => stage.id === id)?.name ?? id);
  const updates = run?.stageUpdates ?? {};
  const selectedStage = graph?.stages.find(stage => stage.id === selected);
  const selectedSnapshot = snapshot?.stages.find(stage => stage.stageId === selected);
  const selectedSaved = storedRun?.stages.find(stage => stage.stageId === selected && stage.attempt === selectedSnapshot?.attempt
    && stage.childSessionId === selectedSnapshot.childSessionId);
  const lastActivity = !showingHistory && selected ? run?.stageActivity?.[selected] : undefined;
  const liveActivity = lastActivity?.runId === item.runId && lastActivity?.attempt === selectedSnapshot?.attempt
    && lastActivity?.childSessionId === selectedSnapshot?.childSessionId ? lastActivity : undefined;
  const pending = showingHistory ? [] : (readItem.pendingWorkflowDecisions ?? []).filter(review => review.binding.runId === item.runId);

  const runHeading = useRef<HTMLHeadingElement>(null);
  const focusedDecision = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!focusedDecision.current || pending.some(review => workflowDecisionKey(review) === focusedDecision.current)) return;
    focusedDecision.current = undefined;
    if (document.activeElement === document.body) runHeading.current?.focus();
  }, [pending]);

  const pinTemplateId = pin?.templateId;
  const pinVersion = pin?.version;
  const pinGraphHash = pin?.graphHash;

  useEffect(() => {
    if (!item.runId) return;
    let active = true;
    let request = 0;
    const read = async () => {
      const revision = ++request;
      const requestedAt = new Date().toISOString();
      try {
        const response = inspectedRun === undefined ? await api.getWorkBoardItem(item.id) : await api.getWorkBoardItem(item.id, inspectedRun);
        if (!active || revision !== request) return;
        if ("status" in response && response.status === "found") {
          setDetail({ item: response.item, inspectedRun, requestedAt });
          setReadError(false);
        } else setReadError(true);
      } catch {
        if (active && revision === request) setReadError(true);
      }
    };
    const unsubscribe = api.onWorkBoardItemChanged(({ itemId }) => { if (itemId === item.id || itemId === undefined) void read(); });
    refreshRun.current = () => { void read(); };
    void read();
    return () => { active = false; unsubscribe(); refreshRun.current = () => {}; };
  }, [api, item.id, item.runId, inspectedRun]);

  useEffect(() => {
    if (pinTemplateId === undefined || pinVersion === undefined || pinGraphHash === undefined) return;
    if (requestedVersion?.templateId === pinTemplateId && requestedVersion.version === pinVersion && requestedVersion.graphHash === pinGraphHash) {
      setResolvedVersion(requestedVersion);
      return;
    }
    let active = true;
    void api.getWorkflowTemplate(pinTemplateId).then(result => {
      if (!active || !result.ok) return;
      setResolvedVersion(result.value.versions.find(candidate => candidate.templateId === pinTemplateId
        && candidate.version === pinVersion && candidate.graphHash === pinGraphHash));
    }).catch(() => { if (active) setResolvedVersion(undefined); });
    return () => { active = false; };
  }, [api, pinTemplateId, pinVersion, pinGraphHash, requestedVersion]);
  const selectedUpdate = selected ? updates[selected] : undefined;
  const stopped = run?.phase === "cancelled" || item.runStatus === "cancelled";
  const stageUpdates = Object.values(updates);
  const parked = item.templateRunState === "awaiting_review";
  const settled = stopped || run?.phase === "done" || run?.phase === "denied" || run?.phase === "error";
  const canStop = !showingHistory && !settled && (item.templateRunState !== undefined || run?.phase === "executing");
  const canComplete = !showingHistory && item.runStatus === "completed" && item.status !== "completed";
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
      const result = await onRetry(item.id, { runId, stageId: update.stageId, attempt: update.attempt });
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
            <DialogTitle ref={runHeading} tabIndex={-1} className="break-words">{stageDisplayName(item.title)}</DialogTitle>
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
        {!!item.workflowRunPins?.some(entry => entry.runId !== item.runId) && (
          <label className="flex flex-wrap items-center gap-2 text-sm">
            {t("workBoard.runHistoryHeading")}
            <select className="rounded-md border border-input bg-background p-1" value={inspectedRun ?? ""}
              onChange={event => { setInspectedRun(event.target.value || undefined); setSelected(undefined); }}>
              <option value="">{t("workflowTemplates.currentRun")}</option>
              {item.workflowRunPins.filter(entry => entry.runId !== item.runId).map(entry => <option key={entry.runId} value={entry.runId}>
                {t("workflowTemplates.version", { version: entry.pin.version })} · {new Date(entry.startedAt).toLocaleString()}
              </option>)}
            </select>
          </label>
        )}
        {readError && <p role="alert" className="text-sm text-destructive">{t("workflowTemplates.runReadFailed")}</p>}
        {!showingHistory && (parked || pending.length > 0) && (
          <section className="space-y-1 rounded-lg border border-warning bg-background p-3 text-sm" onFocusCapture={event => {
            focusedDecision.current = event.target.closest<HTMLElement>("[data-workflow-decision-key]")?.dataset.workflowDecisionKey;
          }}>
            <h2 className="font-semibold text-warning">{t("workflowTemplates.parked")}</h2>
            {pending.map(review => <WorkflowDecisionCard key={workflowDecisionKey(review)} review={review} itemId={item.id} api={api}
              stageName={review.kind === "stage-gate" ? stageName(review.binding.stageId) : undefined}
              onChanged={() => refreshRun.current()} />)}
            {!pending.length && <p>{t("workflowTemplates.noPendingDecision")}</p>}
          </section>
        )}
        {graph ? (
          <section className="min-w-0 space-y-2">
            <h2 className="text-base font-semibold">{t(pin ? "workflowTemplates.pinnedVersion" : "workflowTemplates.requestedVersion", { version: graph.version })}</h2>
            <WorkflowStageGraph graph={graph}
              selection={{ id: selected ?? "", onSelect: setSelected }}
              stageStatus={id => {
                const stage = snapshot?.stages.find(candidate => candidate.stageId === id);
                return stage ? t(`workflowTemplates.stageStatus.${stage.status}`) : !showingHistory && updates[id] ? t(STAGE_STATE_KEYS[updates[id].phase]) : undefined;
              }} />
            {selectedStage && (
              <div className="space-y-2 rounded-lg border bg-background p-3 text-sm">
                <h3 className="break-words font-semibold">{stageDisplayName(selectedStage.name)}</h3>
                <p className="whitespace-pre-wrap break-words">{revealHiddenCharacters(selectedStage.goal, { lineBreaks: false })}</p>
                {selectedSnapshot ? <>
                  <p>{t(`workflowTemplates.stageStatus.${selectedSnapshot.status}`)} · {t("workflowTemplates.attempt", { attempt: selectedSnapshot.attempt })}</p>
                  {selectedSnapshot.childSessionId && <p>{t("workflowTemplates.stageSession", { session: stageDisplayName(selectedSnapshot.childSessionId) })}</p>}
                  <WorkflowStageEvidence stage={{
                    ...selectedSnapshot,
                    activity: liveActivity?.activity ?? selectedSnapshot.activity ?? selectedSaved?.activity,
                    breaker: selectedSnapshot.status === "running" ? liveActivity?.breaker ?? selectedSnapshot.breaker ?? selectedSaved?.breaker : undefined,
                  }} stageName={stageName} />
                  {selectedSnapshot.status === "failed" && canStop && item.runId && (
                    <Button type="button" size="sm" variant="outline" disabled={busy || run?.stopping || retried === `${item.runId}:${selectedSnapshot.stageId}:${selectedSnapshot.attempt}`}
                      {...workBoardDecisionProps(WORK_BOARD.retryStage, item.id, { runId: item.runId, stageId: selectedSnapshot.stageId, attempt: selectedSnapshot.attempt })}
                      onClick={() => void handleRetry({ stageId: selectedSnapshot.stageId, attempt: selectedSnapshot.attempt, phase: "stage_failed", at: selectedSnapshot.endedAt ?? "" })}>
                      {t("workflowTemplates.retryStage")}
                    </Button>
                  )}
                </> : selectedUpdate && !showingHistory ? updateDetails(selectedUpdate) : <p className="text-muted-foreground">{t("workflowTemplates.waitingForStage")}</p>}
              </div>
            )}
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">{t("workflowTemplates.runGraphUnavailable")}</p>
        )}
        {!snapshot && !showingHistory && stageUpdates.length > 0 && (
          <section className="min-w-0 space-y-2" aria-label={t("workflowTemplates.stageUpdates")}>
            <h2 className="text-base font-semibold">{t("workflowTemplates.stageUpdates")}</h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {stageUpdates.map(update => (
                <li key={update.stageId} className="min-w-0 space-y-1 rounded-md border p-2 text-xs">
                  <h3 className="break-words text-sm font-medium">{stageName(update.stageId)}</h3>
                  {updateDetails(update)}
                  {update.phase === "stage_failed" && canStop && item.runId && startedAt && update.at >= startedAt && (
                    <Button type="button" size="sm" variant="outline"
                      disabled={busy || run?.stopping || retried === `${item.runId}:${update.stageId}:${update.attempt}`}
                      {...workBoardDecisionProps(WORK_BOARD.retryStage, item.id, { runId: item.runId, stageId: update.stageId, attempt: update.attempt })}
                      onClick={() => void handleRetry(update)}>{t("workflowTemplates.retryStage")}</Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {snapshot && <WorkflowRunEvidence run={snapshot} stageName={stageName} />}
        {!showingHistory && approvals && <section aria-label={t("workBoard.liveRowToolApproval")} className="grid min-w-0 gap-3 sm:grid-cols-2">{approvals}</section>}
        {!showingHistory && item.runStatus === "completed" && (
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
