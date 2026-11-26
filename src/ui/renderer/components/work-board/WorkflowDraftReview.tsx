import { WORK_BOARD } from "../../../../shared/ipc-channels.js";
import { workBoardDecisionProps } from "../../../../shared/work-board-decision-intent.js";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";
import type { TemplateVersion, WorkflowTemplateDraftInput, WorkflowTemplateRecord } from "../../../../shared/workflow-template-types.js";
import type { AveApi } from "../../types.js";
import { WorkflowTemplateEditor } from "./WorkflowTemplateEditor.js";
import { WorkflowTemplateDetails } from "./workflow-template-details.js";
import { stageDisplayName } from "./workflow-template-graph.js";

export function draftFromRecord(record: WorkflowTemplateRecord, version: TemplateVersion): WorkflowTemplateDraftInput {
  return {
    name: record.template.name, description: record.template.description, scope: record.template.scope,
    stages: version.stages, edges: version.edges, setupCommands: version.setupCommands, basedOn: version.version,
  };
}

export function editableDraft({ graphHash: _hash, revision: _revision, updatedAt: _updatedAt, ...draft }: NonNullable<WorkflowTemplateRecord["draft"]>): WorkflowTemplateDraftInput {
  return draft;
}

function VersionChanges({ previous, draft }: { previous: TemplateVersion; draft: WorkflowTemplateDraftInput }) {
  const { t } = useTranslation();
  const changes = [
    ...draft.stages.flatMap(stage => {
      const prior = previous.stages.find(candidate => candidate.id === stage.id);
      if (prior && JSON.stringify(prior) === JSON.stringify(stage)) return [];
      return [{ id: stage.id, label: t(prior ? "workflowTemplates.stageEdited" : "workflowTemplates.stageAdded", { stage: stageDisplayName(stage.name) }) }];
    }),
    ...previous.stages.filter(stage => !draft.stages.some(candidate => candidate.id === stage.id)).map(stage => ({
      id: stage.id, label: t("workflowTemplates.stageRemoved", { stage: stageDisplayName(stage.name) }),
    })),
  ];
  if (JSON.stringify(previous.edges) !== JSON.stringify(draft.edges)) {
    changes.push({ id: "", label: t("workflowTemplates.dependenciesEdited") });
  }
  return (
    <section className="space-y-2 rounded-md border p-3 text-sm">
      <h3 className="font-semibold">{t("workflowTemplates.graphChanges", { version: previous.version })}</h3>
      {changes.length > 0
        ? <ul className="list-disc space-y-1 pl-5">{changes.map(change => <li key={change.id}>{change.label}</li>)}</ul>
        : <p>{t("workflowTemplates.sameGraph")}</p>}
      <p className="text-muted-foreground">{t("workflowTemplates.versionPins")}</p>
    </section>
  );
}

export function WorkflowDraftReview({ api, templateId, initialDraft, projects, onSaved, onBusyChange }: {
  api: AveApi;
  templateId: string | null;
  initialDraft: WorkflowTemplateDraftInput;
  projects: readonly ProjectIdentity[];
  onSaved: (version: TemplateVersion) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [recordId, setRecordId] = useState(templateId);
  const [draft, setDraft] = useState(initialDraft);
  const [review, setReview] = useState<WorkflowTemplateRecord>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profilesUnavailable, setProfilesUnavailable] = useState(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  useEffect(() => {
    let active = true;
    void api.listAgentProfiles().then(
      result => { if (active) setProfiles(result.agents.map(agent => agent.name)); },
      () => { if (active) setProfilesUnavailable(true); },
    );
    return () => { active = false; };
  }, [api]);

  function changeBusy(next: boolean) {
    busyRef.current = next;
    setBusy(next);
    onBusyChange(next);
  }

  async function handleReview(input: WorkflowTemplateDraftInput) {
    if (busyRef.current) return;
    changeBusy(true);
    setError(undefined);
    try {
      const result = await api.draftWorkflowTemplate(recordId, input);
      if (!result.ok || !result.value.draft) {
        setError("workflowTemplates.draftFailed");
        return;
      }
      setRecordId(result.value.template.id);
      setReview(result.value);
      setDraft(editableDraft(result.value.draft));
    } catch {
      setError("workflowTemplates.draftFailed");
    } finally {
      changeBusy(false);
    }
  }

  async function handleConfirm() {
    if (!review?.draft || busyRef.current || conflict) return;
    changeBusy(true);
    setError(undefined);
    try {
      const result = await api.confirmWorkflowTemplate(review.template.id, {
        expectedGraphHash: review.draft.graphHash,
        expectedDraftRevision: review.draft.revision,
      });
      if (result.ok) {
        onSaved(result.value);
      } else if (result.error === "stale-draft" || result.error === "no-draft") {
        setConflict(true);
        setError("workflowTemplates.staleDraft");
      } else {
        setError(result.error === "scope-not-authorised" ? "reasonCodes.scope-not-authorised" : "workflowTemplates.refused");
      }
    } catch {
      setError("workflowTemplates.saveFailed");
    } finally {
      changeBusy(false);
    }
  }

  const reviewed = review?.draft;
  const previous = review?.versions.find(version => version.version === reviewed?.basedOn);
  return (
    <div className="min-w-0 space-y-3">
      {review && reviewed ? (
        <>
          <h2 className="text-base font-semibold" tabIndex={-1} ref={reviewHeading}>{t("workflowTemplates.reviewVersion")}</h2>
          <p className="text-sm text-muted-foreground">{t("workflowTemplates.confirmationDescription")}</p>
          {previous && <VersionChanges previous={previous} draft={reviewed} />}
          <WorkflowTemplateDetails draft={reviewed} graphHash={reviewed.graphHash} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy || conflict} onClick={() => { setReview(undefined); setError(undefined); }}>
              {t("workflowTemplates.backToEditing")}
            </Button>
            <Button type="button" {...workBoardDecisionProps(WORK_BOARD.templateConfirm, review.template.id, { expectedGraphHash: reviewed.graphHash, expectedDraftRevision: reviewed.revision })} disabled={busy || conflict} onClick={() => void handleConfirm()}>
              {t("workflowTemplates.confirmVersion", { version: review.template.currentVersion + 1 })}
            </Button>
          </div>
        </>
      ) : <WorkflowTemplateEditor draft={draft} projects={projects} profiles={profiles} profilesUnavailable={profilesUnavailable}
        onChange={setDraft} onReview={input => void handleReview(input)} disabled={busy} />}
      {busy && <p role="status" className="text-sm text-muted-foreground">{t("workflowTemplates.saving")}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{t(error)}</p>}
    </div>
  );
}
