import { useId, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Label } from "../../../../components/ui/label.js";
import { Textarea } from "../../../../components/ui/textarea.js";
import { useTranslation } from "../../../../i18n/react.js";
import { revealHiddenCharacters } from "../../../../shared/display-safe-text.js";
import { MAX_PLAN_NOTE_LENGTH, type StageJoinDecideInput, type WorkPlanDecision } from "../../../../shared/work-board-types.js";
import type { PendingWorkflowDecision } from "../../../../shared/workflow-run-view.js";
import type { AveApi } from "../../types.js";
import { stageDisplayName } from "./workflow-template-graph.js";

export function workflowDecisionKey(review: PendingWorkflowDecision): string {
  return review.kind === "stage-gate"
    ? `${review.binding.runId}:${review.binding.stageId}:${review.binding.attempt}:${review.binding.resultHash}:${review.binding.outputHash ?? ""}`
    : `${review.binding.runId}:${review.binding.joinId}:${review.binding.conflictHash}`;
}

export function WorkflowDecisionCard({ review, itemId, stageName, api, onChanged }: {
  review: PendingWorkflowDecision;
  itemId: number;
  stageName?: string;
  api: Pick<AveApi, "decideWorkStage" | "decideWorkJoin">;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const [note, setNote] = useState("");
  const [writingNote, setWritingNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const disabled = busy || submitted;

  async function submit(decision: WorkPlanDecision | StageJoinDecideInput["decision"]) {
    if (disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = review.kind === "stage-gate" && decision !== "retry_merge"
        ? await api.decideWorkStage(itemId, { ...review.binding, decision, ...(decision === "request_changes" && { note: note.trim() }) })
        : review.kind === "join-conflict" && (decision === "retry_merge" || decision === "reject")
          ? await api.decideWorkJoin(itemId, { ...review.binding, decision })
          : undefined;
      if (result?.ok) setSubmitted(true);
      else {
        const code = result && ("reason" in result ? result.reason : "error" in result ? result.error : undefined);
        const key = code && `reasonCodes.${code.replaceAll("_", "-")}`;
        setError(key && t(key) !== key ? key : "workflowTemplates.decisionFailed");
      }
      onChanged();
    } catch {
      setError("workflowTemplates.decisionFailed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-2 rounded-md border bg-card p-3 text-sm">
      <h3 className="font-semibold" id={headingId}>{t(review.kind === "stage-gate" ? "workflowTemplates.stageGate" : "workflowTemplates.joinConflict")}</h3>
      {review.kind === "stage-gate" ? <>
        <p>{stageDisplayName(stageName ?? review.binding.stageId)} · {t("workflowTemplates.attempt", { attempt: review.binding.attempt })}</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2">{revealHiddenCharacters(review.result, { lineBreaks: false })}</pre>
        {review.outputs?.length ? <ul aria-label={t("workflowTemplates.requestedOutputs")} className="list-disc ps-5">
          {review.outputs.map(output => <li key={output.id}>{stageDisplayName(output.summary)}</li>)}
        </ul> : null}
        {writingNote && <Label className="grid gap-1">
          {t("workflowTemplates.changeNote")}
          <Textarea autoFocus maxLength={MAX_PLAN_NOTE_LENGTH} value={note} onChange={event => setNote(event.target.value)} disabled={disabled} />
        </Label>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => void submit("approve")} disabled={disabled}>{t("workflowTemplates.approveStage")}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => {
            if (writingNote) void submit("request_changes");
            else setWritingNote(true);
          }} disabled={disabled || (writingNote && !note.trim())}>{t("workflowTemplates.requestChanges")}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void submit("reject")} disabled={disabled}>{t("workflowTemplates.rejectStage")}</Button>
        </div>
      </> : <>
        <p>{t(`workflowTemplates.joinReason.${review.evidence.reason}`)}</p>
        {review.evidence.files.length > 0 && <ul className="list-disc break-words ps-5">
          {review.evidence.files.map(file => <li key={file.path}>{stageDisplayName(file.path)} · {file.stageIds.map(stageDisplayName).join(", ")}</li>)}
        </ul>}
        {review.evidence.excerpt && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{revealHiddenCharacters(review.evidence.excerpt, { lineBreaks: false })}</pre>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => void submit("retry_merge")} disabled={disabled}>{t("workflowTemplates.retryJoin")}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void submit("reject")} disabled={disabled}>{t("workflowTemplates.rejectJoin")}</Button>
        </div>
      </>}
      {error && <p role="alert" className="text-destructive">{t(error)}</p>}
    </section>
  );
}
