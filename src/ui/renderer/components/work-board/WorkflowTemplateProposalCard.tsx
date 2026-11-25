import { useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { useTranslation } from "../../../../i18n/react.js";
import { revealHiddenCharacters } from "../../../../shared/display-safe-text.js";
import { isRecord } from "../../../../shared/is-record.js";
import { isWorkflowTemplateProposalId, WORKFLOW_TEMPLATE_PROPOSE_TOOL, type WorkflowTemplateProposal } from "../../../../shared/workflow-template-types.js";

function proposalIdFromResult(result: unknown): string | undefined {
  if (typeof result !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(result);
    if (isRecord(value) && value.status === "pending-confirmation" && isWorkflowTemplateProposalId(value.proposalId)) {
      return value.proposalId;
    }
  } catch {
    return undefined;
  }
}

export function WorkflowTemplateProposalCard({ name, result, completed }: {
  name: string;
  result: unknown;
  completed: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [proposal, setProposal] = useState<WorkflowTemplateProposal>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<"workflowTemplates.unavailable" | "workflowTemplates.saveFailed" | undefined>();
  const id = completed && name === WORKFLOW_TEMPLATE_PROPOSE_TOOL ? proposalIdFromResult(result) : undefined;
  if (!id) return null;

  async function openProposal(proposalId: string) {
    setProposal(undefined);
    setError(undefined);
    setBusy(true);
    setOpen(true);
    try {
      const response = await window.aveApi.getWorkflowTemplateProposal(proposalId);
      if (response.ok && response.value.id === proposalId) setProposal(response.value);
      else setError("workflowTemplates.unavailable");
    } catch {
      setError("workflowTemplates.unavailable");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!proposal || proposal.id !== id || busy) return;
    setError(undefined);
    setBusy(true);
    try {
      const response = await window.aveApi.confirmWorkflowTemplate(proposal.id, {
        expectedGraphHash: proposal.graphHash,
        expectedDraftRevision: proposal.id,
      });
      if (response.ok) {
        setSaved(true);
        setOpen(false);
      } else if (response.error === "no-draft" || response.error === "stale-draft" || response.error === "scope-not-authorised") {
        setError("workflowTemplates.unavailable");
        setProposal(undefined);
      } else setError("workflowTemplates.saveFailed");
    } catch {
      setError("workflowTemplates.saveFailed");
    } finally {
      setBusy(false);
    }
  }

  if (saved) return <p className="px-3 text-sm" role="status">{t("workflowTemplates.saved")}</p>;
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="m-2" disabled={busy} onClick={() => void openProposal(id)}>
        {t("workflowTemplates.review")}
      </Button>
      <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{proposal ? revealHiddenCharacters(proposal.draft.name, { lineBreaks: true }) : t("workflowTemplates.review")}</DialogTitle>
            <DialogDescription>{t("workflowTemplates.confirmationDescription")}</DialogDescription>
          </DialogHeader>
          {proposal && <ProposalDetails proposal={proposal} />}
          {busy && <p role="status" className="text-sm">{t(proposal ? "workflowTemplates.saving" : "workBoard.loadingLabel")}</p>}
          {error && <p role="alert" className="text-sm text-destructive">{t(error)}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t("workBoard.cancelButton")}</Button>
            <Button type="button" onClick={() => void handleConfirm()} disabled={!proposal || busy}>
              {t("workflowTemplates.confirmSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProposalDetails({ proposal }: { proposal: WorkflowTemplateProposal }) {
  const { t } = useTranslation();
  const { draft, graphHash } = proposal;
  const sendsInputs = draft.stages.some(stage => [
    ...stage.envelope?.mcpGenerationTools ?? [],
    ...stage.envelope?.pluginGenerationTools ?? [],
  ].some(tool => tool.dataSent));
  return (
    <div className="max-h-[55vh] space-y-3 overflow-auto break-words text-sm">
      {draft.description && <p className="whitespace-pre-wrap">{revealHiddenCharacters(draft.description, { lineBreaks: false })}</p>}
      <p>{draft.scope.kind === "all" ? t("workflowTemplates.allProjects") : revealHiddenCharacters(draft.scope.projectRoot, { lineBreaks: true })}</p>
      <ul className="space-y-2">
        {draft.stages.map(stage => {
          const dependencies = draft.edges.filter(edge => edge.to === stage.id).map(edge => edge.from);
          const gate = stage.gate.type === "human" ? "workflowTemplates.humanGate"
            : stage.gate.pass.kind === "model_verdict" ? "workflowTemplates.modelGate" : "workflowTemplates.successGate";
          return (
            <li key={stage.id} className="rounded border p-2">
              <p className="font-medium">{revealHiddenCharacters(stage.name, { lineBreaks: true })} <code>({stage.id})</code></p>
              <p className="whitespace-pre-wrap">{revealHiddenCharacters(stage.goal, { lineBreaks: false })}</p>
              <p>{t(stage.toolScope === "read" ? "workflowTemplates.readTools" : "workflowTemplates.allTools")} · {t(gate)}</p>
              {stage.agentName && <p>{t("workflowTemplates.agentProfile", { name: revealHiddenCharacters(stage.agentName, { lineBreaks: true }) })}</p>}
              {!!dependencies.length && <p>{t("workflowTemplates.afterStages", { stages: dependencies.join(", ") })}</p>}
            </li>
          );
        })}
      </ul>
      {sendsInputs && <p className="text-warning">{t("workflowTemplates.sendsInputs")}</p>}
      <details>
        <summary>{t("workflowTemplates.graphDetails")}</summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-xs">
          {revealHiddenCharacters(JSON.stringify(draft, null, 2), { lineBreaks: false })}
        </pre>
      </details>
      <p>{t("workflowTemplates.graphHash")} <code className="break-all">{graphHash}</code></p>
    </div>
  );
}
