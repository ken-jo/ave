import { WORK_BOARD } from "../../../../shared/ipc-channels.js";
import { workBoardDecisionProps } from "../../../../shared/work-board-decision-intent.js";
import { useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { useTranslation } from "../../../../i18n/react.js";
import { revealHiddenCharacters } from "../../../../shared/display-safe-text.js";
import { WorkflowTemplateDetails } from "./workflow-template-details.js";
import { WorkflowDraftReview } from "./WorkflowDraftReview.js";
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
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<"workflowTemplates.unavailable" | "workflowTemplates.saveFailed" | undefined>();
  const trigger = useRef<HTMLButtonElement>(null);
  const id = completed && name === WORKFLOW_TEMPLATE_PROPOSE_TOOL ? proposalIdFromResult(result) : undefined;
  if (!id) return null;

  async function openProposal(proposalId: string) {
    setProposal(undefined);
    setEditing(false);
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

  if (saved) return <p className="px-3 text-sm" role="status" tabIndex={-1} ref={element => { element?.focus(); }}>{t("workflowTemplates.saved")}</p>;
  return (
    <>
      <Button ref={trigger} type="button" variant="outline" size="sm" className="m-2" disabled={busy} onClick={() => void openProposal(id)}>
        {t("workflowTemplates.review")}
      </Button>
      <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
        <DialogContent size={editing ? "2xl" : "lg"} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>{proposal ? revealHiddenCharacters(proposal.draft.name, { lineBreaks: true }) : t("workflowTemplates.review")}</DialogTitle>
            <DialogDescription>{t("workflowTemplates.confirmationDescription")}</DialogDescription>
          </DialogHeader>
          {proposal && editing ? (
            <WorkflowDraftReview api={window.aveApi} templateId={null} initialDraft={proposal.draft} projects={[]}
              onBusyChange={setBusy} onSaved={() => { setSaved(true); setOpen(false); }} />
          ) : (
            <>
              {proposal && <WorkflowTemplateDetails {...proposal} />}
              {busy && <p role="status" className="text-sm">{t(proposal ? "workflowTemplates.saving" : "workBoard.loadingLabel")}</p>}
              {error && <p role="alert" className="text-sm text-destructive">{t(error)}</p>}
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t("workBoard.cancelButton")}</Button>
            {!editing && <>
              {proposal && <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(true)}>{t("workflowTemplates.editProposal")}</Button>}
              <Button type="button" {...(proposal && workBoardDecisionProps(WORK_BOARD.templateConfirm, proposal.id, { expectedGraphHash: proposal.graphHash, expectedDraftRevision: proposal.id }))} onClick={() => void handleConfirm()} disabled={!proposal || busy}>
                {t("workflowTemplates.confirmSave")}
              </Button>
            </>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
