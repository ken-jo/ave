import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import { Textarea } from "../../../../components/ui/textarea.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";
import type { TemplateStage, WorkflowTemplateDraftInput } from "../../../../shared/workflow-template-types.js";
import { stageAncestors, stageDisplayName, WorkflowStageGraph } from "./workflow-template-graph.js";

const SELECT_CLASS = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring";

function newStage(): TemplateStage {
  return { id: crypto.randomUUID().replaceAll("-", ""), name: "", goal: "", inputs: [], toolScope: "read", allowSubAgents: false, gate: { type: "auto", pass: { kind: "stage_ok" } } };
}

export function emptyWorkflowDraft(): WorkflowTemplateDraftInput {
  return { name: "", scope: { kind: "all" }, stages: [newStage()], edges: [] };
}

export function WorkflowTemplateEditor({ draft, projects, profiles, profilesUnavailable, onChange, onReview, disabled }: {
  draft: WorkflowTemplateDraftInput;
  projects: readonly ProjectIdentity[];
  profiles: readonly string[];
  profilesUnavailable: boolean;
  onChange: (draft: WorkflowTemplateDraftInput) => void;
  onReview: (input: WorkflowTemplateDraftInput) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(draft.stages[0].id);
  const [invalid, setInvalid] = useState(false);
  const profileOptions = useId();
  const name = useRef<HTMLInputElement>(null);
  const stage = draft.stages.find(candidate => candidate.id === selectedId) ?? draft.stages[0];
  const ancestors = stageAncestors(draft, stage.id);
  const canDependOn = draft.stages.filter(candidate => candidate.id !== stage.id && !stageAncestors(draft, candidate.id).has(stage.id));
  const currentRoot = draft.scope.kind === "project" ? draft.scope.projectRoot : "";
  const scopeOptions = new Map<string, string>();
  if (currentRoot) scopeOptions.set(currentRoot, currentRoot);
  for (const project of projects) scopeOptions.set(project.projectRoot, project.projectName);

  function patchStage(patch: Partial<TemplateStage>) {
    onChange({ ...draft, stages: draft.stages.map(candidate => candidate.id === stage.id ? { ...candidate, ...patch } : candidate) });
  }

  function addStage() {
    const next = newStage();
    onChange({ ...draft, stages: [...draft.stages, next], edges: [...draft.edges, { from: stage.id, to: next.id }] });
    setSelectedId(next.id);
    name.current?.focus();
  }

  function removeStage() {
    const stages = draft.stages.filter(candidate => candidate.id !== stage.id);
    const edges = draft.edges.filter(edge => edge.from !== stage.id && edge.to !== stage.id);
    const graph = { ...draft, stages, edges };
    onChange({
      ...graph,
      stages: stages.map(candidate => {
        const upstream = stageAncestors(graph, candidate.id);
        return {
          ...candidate,
          inputs: candidate.inputs.filter(id => upstream.has(id)),
          ...(candidate.inputFiles && { inputFiles: candidate.inputFiles.filter(input => input.from === "project" || upstream.has(input.stageId)) }),
        };
      }),
    });
    setSelectedId(stages[0].id);
    name.current?.focus();
  }

  function togglePrerequisite(id: string, selected: boolean) {
    const edges = selected ? [...draft.edges, { from: id, to: stage.id }] : draft.edges.filter(edge => edge.from !== id || edge.to !== stage.id);
    onChange({ ...draft, edges });
  }

  function handleReview(event: FormEvent) {
    event.preventDefault();
    const valid = draft.name.trim() && draft.stages.every(candidate => {
      const upstream = stageAncestors(draft, candidate.id);
      return candidate.name.trim() && candidate.goal.trim() && candidate.inputs.every(id => upstream.has(id))
        && (candidate.inputFiles ?? []).every(input => input.from === "project" || upstream.has(input.stageId));
    });
    setInvalid(!valid);
    if (!valid) return;
    onReview({
      ...draft,
      name: draft.name.trim(),
      stages: draft.stages.map(({ kind: _kind, ...candidate }) => candidate),
    });
  }

  return (
    <form className="min-w-0 space-y-4" onSubmit={handleReview}>
      <fieldset disabled={disabled} className="min-w-0 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Label className="grid gap-1">{t("workflowTemplates.templateName")}
            <Input autoFocus value={draft.name} maxLength={60} onChange={event => onChange({ ...draft, name: event.target.value })} />
          </Label>
          <Label className="grid gap-1">{t("workflowTemplates.scope")}
            <select className={SELECT_CLASS} value={currentRoot} onChange={event => onChange({
              ...draft, scope: event.target.value ? { kind: "project", projectRoot: event.target.value } : { kind: "all" },
            })}>
              <option value="">{t("workflowTemplates.allProjects")}</option>
              {[...scopeOptions].map(([root, label]) => <option key={root} value={root}>{t("workflowTemplates.projectScope", { project: stageDisplayName(label) })}</option>)}
            </select>
          </Label>
          <Label className="grid gap-1 sm:col-span-2">{t("workflowTemplates.templateDescription")}
            <Textarea rows={2} value={draft.description ?? ""} maxLength={8192} onChange={event => onChange({ ...draft, description: event.target.value })} />
          </Label>
        </div>
        <div className="grid min-w-0 items-start gap-4 sm:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <WorkflowStageGraph graph={draft} selection={{ id: stage.id, onSelect: setSelectedId }} />
            <Button type="button" variant="outline" size="sm" onClick={addStage} disabled={draft.stages.length >= 12}>{t("workflowTemplates.addStage")}</Button>
          </div>
          <section aria-label={t("workflowTemplates.stageSettings")} className="min-w-0 space-y-3 rounded-lg border p-3">
            <Label className="grid gap-1">{t("workflowTemplates.stageName")}
              <Input ref={name} value={stage.name} maxLength={40} onChange={event => patchStage({ name: event.target.value })} />
            </Label>
            <Label className="grid gap-1">{t("workflowTemplates.goal")}
              <Textarea rows={3} value={stage.goal} maxLength={400} onChange={event => patchStage({ goal: event.target.value })} />
            </Label>
            <Label className="grid gap-1">{t("workflowTemplates.profile")}
              <Input value={stage.agentName ?? ""} placeholder={t("workflowTemplates.defaultProfile")} maxLength={128}
                list={profileOptions} onChange={event => patchStage({ agentName: event.target.value || undefined })} />
            </Label>
            <datalist id={profileOptions}>{profiles.map(profile => <option key={profile} value={profile} />)}</datalist>
            {profilesUnavailable && <p role="status" className="text-xs text-muted-foreground">{t("workflowTemplates.profilesUnavailable")}</p>}
            <Label className="grid gap-1">{t("workflowTemplates.toolScope")}
              <select className={SELECT_CLASS} value={stage.toolScope}
                onChange={event => patchStage({ toolScope: event.target.value === "all" ? "all" : "read" })}>
                <option value="read">{t("workflowTemplates.readTools")}</option>
                <option value="all">{t("workflowTemplates.allTools")}</option>
              </select>
            </Label>
            <Label className="flex items-center gap-2">
              <input type="checkbox" checked={stage.allowSubAgents} onChange={event => patchStage({ allowSubAgents: event.target.checked })} />
              {t("workflowTemplates.subAgents")}
            </Label>
            <Label className="grid gap-1">{t("workflowTemplates.gate")}
              <select className={SELECT_CLASS} value={stage.gate.type === "human" ? "human" : stage.gate.pass.kind} onChange={event => {
                const value = event.target.value;
                if (value === "human") patchStage({ gate: { type: "human" } });
                if (value === "stage_ok" || value === "model_verdict") patchStage({ gate: { type: "auto", pass: { kind: value } } });
              }}>
                <option value="human">{t("workflowTemplates.humanGate")}</option>
                <option value="stage_ok">{t("workflowTemplates.successGate")}</option>
                <option value="model_verdict">{t("workflowTemplates.modelGate")}</option>
              </select>
            </Label>
            {canDependOn.length > 0 && <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("workflowTemplates.requires")}</legend>
              <p className="text-xs text-muted-foreground">{t("workflowTemplates.requiresHelp")}</p>
              {canDependOn.map(candidate => <Label key={candidate.id} className="flex gap-2">
                <input type="checkbox" checked={draft.edges.some(edge => edge.to === stage.id && edge.from === candidate.id)}
                  onChange={event => togglePrerequisite(candidate.id, event.target.checked)} />
                {stageDisplayName(candidate.name) || t("workflowTemplates.unnamedStage")}
              </Label>)}
            </fieldset>}
            {(ancestors.size > 0 || stage.inputs.length > 0) && <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("workflowTemplates.stageInputs")}</legend>
              {draft.stages.filter(candidate => ancestors.has(candidate.id) || stage.inputs.includes(candidate.id)).map(candidate => (
                <Label key={candidate.id} className="flex gap-2">
                  <input type="checkbox" checked={stage.inputs.includes(candidate.id)} disabled={!ancestors.has(candidate.id) && !stage.inputs.includes(candidate.id)}
                    onChange={event => patchStage({ inputs: event.target.checked ? [...stage.inputs, candidate.id] : stage.inputs.filter(id => id !== candidate.id) })} />
                  {stageDisplayName(candidate.name) || t("workflowTemplates.unnamedStage")}
                </Label>
              ))}
            </fieldset>}
            <Button type="button" variant="outline" size="sm" onClick={removeStage} disabled={draft.stages.length <= 1}>{t("workflowTemplates.removeStage")}</Button>
          </section>
        </div>
        {invalid && <p role="alert" className="text-sm text-destructive">{t("workflowTemplates.invalidGraph")}</p>}
        <div className="flex justify-end">
          <Button type="submit">{t("workflowTemplates.reviewVersion")}</Button>
        </div>
      </fieldset>
    </form>
  );
}
