import { useTranslation } from "../../../../i18n/react.js";
import { revealHiddenCharacters } from "../../../../shared/display-safe-text.js";
import { workflowDecisionHistoryKey, type WorkflowRunView, type WorkflowStageView } from "../../../../shared/workflow-run-view.js";
import { stageDisplayName } from "./workflow-template-graph.js";

export function WorkflowStageEvidence({ stage, stageName }: {
  stage: WorkflowStageView;
  stageName: (id: string) => string;
}) {
  const { t } = useTranslation();
  const gate = stage.gate;
  return (
    <div className="space-y-3">
      {stage.breaker && <p>
        {t(stage.breaker.open ? "workflowTemplates.breakerOpen" : "workflowTemplates.breakerClosed", {
          consecutive: stage.breaker.consecutive, total: stage.breaker.total,
        })}
      </p>}
      {stage.result !== undefined && <details>
        <summary className="cursor-pointer font-semibold">{t("workflowTemplates.stageResult")}</summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{revealHiddenCharacters(stage.result, { lineBreaks: false })}</pre>
      </details>}
      {!!stage.receivedInputs?.length && <section className="space-y-1">
        <h4 className="font-semibold">{t("workflowTemplates.receivedInputs")}</h4>
        {stage.receivedInputs.map(input => <details key={input.stageId}>
          <summary className="cursor-pointer">{stageName(input.stageId)}{input.truncated && ` · ${t("workflowTemplates.inputTruncated")}`}</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{revealHiddenCharacters(input.text, { lineBreaks: false })}</pre>
        </details>)}
      </section>}
      {gate?.type === "auto" && <section className="space-y-1">
        <h4 className="font-semibold">{t(gate.judgedBy === "model" ? "workflowTemplates.modelGate" : "workflowTemplates.verdictEvidence")}</h4>
        <pre className="whitespace-pre-wrap break-words">{revealHiddenCharacters(gate.evidence, { lineBreaks: false })}</pre>
      </section>}
      {!!stage.activity?.turns.length && <section className="space-y-1">
        <h4 className="font-semibold">{t("workflowTemplates.stageTurns")}</h4>
        <ul className="space-y-1">{stage.activity.turns.map(turn => <li key={turn.turn}>
          <span>{t("workBoard.liveChipTurn", { turn: turn.turn })}</span>
          {turn.text && <p className="whitespace-pre-wrap break-words">{revealHiddenCharacters(turn.text, { lineBreaks: false })}</p>}
        </li>)}</ul>
      </section>}
      {!!stage.activity?.tools.length && <section className="space-y-1">
        <h4 className="font-semibold">{t("workflowTemplates.stageSteps")}</h4>
        <ul className="space-y-1">{stage.activity.tools.map(step => <li key={step.toolUseId}>
          {[t("workBoard.liveChipTurn", { turn: step.turn }), stageDisplayName(step.name), step.label && stageDisplayName(step.label),
            t(`workflowTemplates.stepStatus.${step.status}`)].filter(Boolean).join(" · ")}
        </li>)}</ul>
      </section>}
    </div>
  );
}

export function WorkflowRunEvidence({ run, stageName }: { run: WorkflowRunView; stageName: (id: string) => string }) {
  const { t } = useTranslation();
  return (
    <>
      {run.joins.length > 0 && <section className="space-y-1 text-sm">
        <h3 className="font-semibold">{t("workflowTemplates.handoffHistory")}</h3>
        <ul className="space-y-1">{run.joins.map(join => <li key={join.joinId}>
          {join.stageIds.map(stageName).join(", ")} · {t(`workflowTemplates.joinStatus.${join.status}`)}
        </li>)}</ul>
      </section>}
      {run.decisions.length > 0 && <section className="space-y-1 text-sm">
        <h3 className="font-semibold">{t("workflowTemplates.gateHistory")}</h3>
        <ul className="space-y-1">{run.decisions.map(entry => <li key={workflowDecisionHistoryKey(entry)}>
          {entry.kind === "stage-gate" ? `${stageName(entry.stageId)} · ${t("workflowTemplates.attempt", { attempt: entry.attempt })}` : stageDisplayName(entry.joinId)}
          {" · "}{t(`workflowTemplates.historyDecision.${entry.decision}`)}
          {" · "}<time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
          {entry.kind === "stage-gate" && entry.note && <p className="whitespace-pre-wrap break-words">{revealHiddenCharacters(entry.note, { lineBreaks: false })}</p>}
        </li>)}</ul>
      </section>}
    </>
  );
}
