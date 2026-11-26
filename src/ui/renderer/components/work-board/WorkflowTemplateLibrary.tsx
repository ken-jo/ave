import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Badge } from "../../../../components/ui/badge.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import { Textarea } from "../../../../components/ui/textarea.js";
import { formatMediumDateTime } from "../../../../shared/format-time.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { UserKeyboardIntentSnapshot } from "../../../../shared/chat-origin.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";
import type { WorkItemResolved } from "../../../../shared/work-board-types.js";
import type { TemplateVersion, WorkflowTemplate, WorkflowTemplateDraftInput, WorkflowTemplateRecord } from "../../../../shared/workflow-template-types.js";
import type { AveApi } from "../../types.js";
import { WorkflowDraftReview, draftFromRecord, editableDraft } from "./WorkflowDraftReview.js";
import { emptyWorkflowDraft } from "./WorkflowTemplateEditor.js";
import { WorkflowTemplateDetails } from "./workflow-template-details.js";
import { stageDisplayName, WorkflowStageGraph } from "./workflow-template-graph.js";

interface WorkflowTemplateLibraryProps {
  api: AveApi;
  project?: ProjectIdentity;
  projects: readonly ProjectIdentity[];
  existingItem?: WorkItemResolved;
  onClose: () => void;
  restoreFocus: () => void;
  onLaunch: (item: WorkItemResolved, version: TemplateVersion, intent: UserKeyboardIntentSnapshot) => void;
}

export function WorkflowTemplateLibrary({ api, project, projects, existingItem, onClose, restoreFocus, onLaunch }: WorkflowTemplateLibraryProps) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<WorkflowTemplate[]>();
  const [listError, setListError] = useState(false);
  const [selection, setSelection] = useState(() => existingItem?.templateId ? { id: existingItem.templateId } : undefined);
  const selectedId = selection?.id;
  const [record, setRecord] = useState<WorkflowTemplateRecord>();
  const [selectedVersion, setSelectedVersion] = useState<number>();
  const [pinnedItems, setPinnedItems] = useState<WorkItemResolved[]>([]);
  const [pinListError, setPinListError] = useState(false);
  const [editor, setEditor] = useState<{ id: string | null; draft: WorkflowTemplateDraftInput }>();
  const [starting, setStarting] = useState(existingItem !== undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const newTemplateButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let revision = 0;
    let active = true;
    const refresh = async () => {
      const current = ++revision;
      try {
        const result = await api.listWorkflowTemplates();
        if (!active || revision !== current) return;
        if (result.ok) {
          setTemplates(result.value);
          setListError(false);
        } else setListError(true);
      } catch {
        if (active && revision === current) setListError(true);
      }
    };
    const unsubscribe = api.onWorkflowTemplatesChanged(() => void refresh());
    void refresh();
    return () => { active = false; unsubscribe(); };
  }, [api]);

  useEffect(() => {
    if (!selection) return;
    const { id } = selection;
    let active = true;
    setRecord(undefined);
    setError(false);
    void api.getWorkflowTemplate(id).then(result => {
      if (!active) return;
      if (!result.ok || result.value.template.id !== id) setError(true);
      else {
        setRecord(result.value);
        setSelectedVersion(result.value.template.currentVersion);
      }
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [api, selection]);

  useEffect(() => {
    if (editor || starting) return;
    if (record) detailsHeading.current?.focus();
    else if (!selectedId) newTemplateButton.current?.focus();
  }, [editor, record, selectedId, starting]);

  useEffect(() => {
    if (!selectedId || starting || editor) return;
    let active = true;
    let sequence = 0;
    const read = async () => {
      const current = ++sequence;
      try {
        const result = await api.listWorkBoard();
        if (!active || current !== sequence) return;
        if ("status" in result && result.status === "ok") {
          setPinnedItems(result.items.filter(item => item.templateId === selectedId));
          setPinListError(false);
        } else setPinListError(true);
      } catch {
        if (active && current === sequence) setPinListError(true);
      }
    };
    const unsubscribe = api.onWorkBoardItemChanged(() => void read());
    void read();
    return () => { active = false; unsubscribe(); };
  }, [api, selectedId, starting, editor]);

  const version = record?.versions.find(entry => entry.version === selectedVersion);
  const current = record?.versions.find(entry => entry.version === record.template.currentVersion);
  const loading = selectedId ? !record && !error : !templates && !listError;
  const list = templates?.filter(template => !project || template.scope.kind === "all" || template.scope.projectRoot === project.projectRoot);

  function leaveDetails() {
    if (existingItem) {
      onClose();
      return;
    }
    setSelection(undefined);
    setSelectedVersion(undefined);
    setRecord(undefined);
    setStarting(false);
    setEditor(undefined);
    setError(false);
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent size="2xl" className="min-w-0"
        onOpenAutoFocus={event => {
          if (!newTemplateButton.current) return;
          event.preventDefault();
          newTemplateButton.current.focus();
        }}
        onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DialogTitle>{t("workflowTemplates.library")}</DialogTitle>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>{t("workBoard.cancelButton")}</Button>
          </div>
          <DialogDescription>{t("workflowTemplates.libraryDescription")}</DialogDescription>
        </DialogHeader>
        {editor ? (
          <>
            <Button type="button" variant="ghost" className="justify-self-start" disabled={busy}
              onClick={() => { setEditor(undefined); if (selectedId) setSelection({ id: selectedId }); }}>
              {t("workflowTemplates.backToTemplates")}
            </Button>
            <WorkflowDraftReview api={api} templateId={editor.id} initialDraft={editor.draft} projects={projects}
              onBusyChange={setBusy} onSaved={confirmed => {
                setEditor(undefined);
                setSelection({ id: confirmed.templateId });
              }} />
          </>
        ) : starting && record && current && !record.template.archivedAt ? (
          <>
            <Button type="button" variant="ghost" className="justify-self-start" onClick={() => { if (existingItem) onClose(); else setStarting(false); }} disabled={busy}>
              {t("workflowTemplates.backToTemplates")}
            </Button>
            <WorkflowStartForm api={api} template={record.template} version={current} project={project} projects={projects} existingItem={existingItem}
              onBusyChange={setBusy} onLaunch={onLaunch} />
          </>
        ) : selectedId ? (
          <>
            <Button type="button" variant="ghost" className="justify-self-start" onClick={leaveDetails}>{t("workflowTemplates.backToTemplates")}</Button>
            {record && (
              <section className="min-w-0 space-y-3">
                <h2 className="break-words text-base font-semibold" tabIndex={-1} ref={detailsHeading}>{stageDisplayName(record.template.name)}</h2>
                {record.template.archivedAt && <p role="status" className="text-sm">{t("reasonCodes.template-archived")}</p>}
                {record.template.description && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{stageDisplayName(record.template.description)}</p>}
                {record.versions.length > 0 && <Label className="flex flex-wrap items-center gap-2">
                  {t("workflowTemplates.versions")}
                  <select className="rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring"
                    value={selectedVersion} onChange={event => setSelectedVersion(Number(event.target.value))}>
                    {[...record.versions].reverse().map(entry => <option key={entry.version} value={entry.version}>{t("workflowTemplates.version", { version: entry.version })}</option>)}
                  </select>
                </Label>}
                {version && <>
                  <WorkflowStageGraph graph={version} />
                  <section className="space-y-1 text-sm">
                    <h3 className="font-semibold">{t("workflowTemplates.pinnedRuns")}</h3>
                    {pinListError
                      ? <p role="alert" className="text-destructive">{t("workflowTemplates.runReadFailed")}</p>
                      : <ul aria-label={t("workflowTemplates.pinnedRuns")} className="space-y-1">
                        {pinnedItems.flatMap(item => (item.workflowRunPins ?? [])
                          .filter(entry => entry.pin.templateId === version.templateId && entry.pin.version === version.version && entry.pin.graphHash === version.graphHash)
                          .map(entry => <li key={entry.runId} className="break-words">
                            {stageDisplayName(item.title)} · <time dateTime={entry.startedAt}>{formatMediumDateTime(entry.startedAt)}</time>
                          </li>))}
                      </ul>}
                  </section>
                  <details className="space-y-2 text-sm">
                    <summary className="cursor-pointer rounded-sm focus-visible:ring-2 focus-visible:ring-ring">{t("workflowTemplates.versionDetails")}</summary>
                    <WorkflowTemplateDetails draft={draftFromRecord(record, version)} graphHash={version.graphHash} />
                  </details>
                </>}
                <div className="flex flex-wrap gap-2">
                  {!record.template.archivedAt && record.draft && <Button size="sm" variant="outline" onClick={() => {
                    if (record.draft) setEditor({ id: selectedId, draft: editableDraft(record.draft) });
                  }}>{t("workflowTemplates.resumeDraft")}</Button>}
                  {!record.template.archivedAt && version && !record.draft && <Button size="sm" variant="outline" onClick={() => setEditor({ id: selectedId, draft: draftFromRecord(record, version) })}>
                    {t("workflowTemplates.editVersion")}
                  </Button>}
                  {!record.template.archivedAt && current && version?.version === current.version && (
                    <Button size="sm" onClick={() => setStarting(true)}>{t("workflowTemplates.startRun")}</Button>
                  )}
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <Button ref={newTemplateButton} type="button" onClick={() => setEditor({ id: null, draft: emptyWorkflowDraft() })}>{t("workflowTemplates.newTemplate")}</Button>
              <p className="text-sm text-muted-foreground">{t("workflowTemplates.proposalHint")}</p>
            </div>
            {list?.length === 0 && !listError && <p className="text-sm text-muted-foreground">{t("workflowTemplates.empty")}</p>}
            <ul className="space-y-2">
              {list?.map(template => (
                <li key={template.id} className="min-w-0 space-y-2 rounded-lg border bg-background p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Button type="button" variant="ghost" className="h-auto whitespace-normal text-left" onClick={() => setSelection({ id: template.id })}>{stageDisplayName(template.name)}</Button>
                    <Badge variant="outline">{template.currentVersion > 0 ? t("workflowTemplates.version", { version: template.currentVersion }) : t("workflowTemplates.draftVersion")}</Badge>
                  </div>
                  {template.description && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{stageDisplayName(template.description)}</p>}
                  <p className="break-words text-xs text-muted-foreground">
                    {template.scope.kind === "all" ? t("workflowTemplates.allProjects") : t("workflowTemplates.projectScope", { project: stageDisplayName(template.scope.projectRoot) })}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
        {loading && <p role="status" className="text-sm">{t("workBoard.loadingLabel")}</p>}
        {(error || (!selectedId && listError)) && <p role="alert" className="text-sm text-destructive">{t("workflowTemplates.loadFailed")}</p>}
      </DialogContent>
    </Dialog>
  );
}

function WorkflowStartForm({ api, template, version, project, projects, existingItem, onLaunch, onBusyChange }: {
  api: AveApi;
  template: WorkflowTemplate;
  version: TemplateVersion;
  project?: ProjectIdentity;
  projects: readonly ProjectIdentity[];
  existingItem?: WorkItemResolved;
  onLaunch: WorkflowTemplateLibraryProps["onLaunch"];
  onBusyChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const scope = template.scope;
  const options = scope.kind === "project" ? projects.filter(entry => entry.projectRoot === scope.projectRoot) : projects;
  const [root, setRoot] = useState(project && options.some(entry => entry.projectRoot === project.projectRoot) ? project.projectRoot : options[0]?.projectRoot ?? "");
  const chosen = options.find(entry => entry.projectRoot === root);
  const [title, setTitle] = useState(existingItem?.title ?? "");
  const [detail, setDetail] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [error, setError] = useState<string>();
  const eligible = existingItem ? scope.kind === "all" || scope.projectRoot === existingItem.projectRoot : chosen !== undefined;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (sendingRef.current || !eligible || !title.trim() || template.archivedAt) return;
    const intent = api.captureUserKeyboardIntent();
    if (!intent.token) {
      setError("reasonCodes.user-gesture-required");
      return;
    }
    if (existingItem) {
      onLaunch(existingItem, version, intent);
      return;
    }
    if (!chosen) return;
    sendingRef.current = true;
    setSending(true);
    onBusyChange(true);
    setError(undefined);
    try {
      const result = await api.addWorkBoardItem({
        templateId: template.id, title: title.trim(), ...(detail.trim() && { detail: detail.trim() }),
        projectRoot: chosen.projectRoot, projectName: chosen.projectName,
      });
      if ("status" in result && result.status === "created") {
        if (result.item.projectRoot !== chosen.projectRoot || result.item.templateId !== template.id) {
          setError("workflowTemplates.runFailed");
        } else onLaunch(result.item, version, intent);
      } else setError("workBoard.errorAddFailed");
    } catch {
      setError("workflowTemplates.runFailed");
    } finally {
      sendingRef.current = false;
      setSending(false);
      onBusyChange(false);
    }
  }

  return (
    <form className="min-w-0 space-y-3" onSubmit={event => void handleSubmit(event)}>
      <h2 className="break-words text-base font-semibold">{stageDisplayName(template.name)} · {t("workflowTemplates.version", { version: version.version })}</h2>
      <p className="text-sm text-muted-foreground">{t("workflowTemplates.runDescription")}</p>
      <WorkflowStageGraph graph={version} />
      <p className="break-all text-xs text-muted-foreground">{t("workflowTemplates.graphHash")} <code>{version.graphHash}</code></p>
      {existingItem ? (
        <p className="break-words text-sm">{stageDisplayName(existingItem.title)} · {stageDisplayName(existingItem.projectName ?? existingItem.projectRoot ?? "")}</p>
      ) : (
        <fieldset disabled={sending} className="grid min-w-0 gap-3">
          <Label className="grid gap-1">{t("workflowTemplates.workTitle")}
            <Input autoFocus required value={title} maxLength={256} onChange={event => setTitle(event.target.value)} />
          </Label>
          <Label className="grid gap-1">{t("workflowTemplates.scope")}
            <select className="rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring"
              value={root} onChange={event => setRoot(event.target.value)}>
              {!options.length && <option value="">{t("workflowTemplates.noProject")}</option>}
              {options.map(entry => <option key={entry.projectRoot} value={entry.projectRoot}>{stageDisplayName(entry.projectName)}</option>)}
            </select>
          </Label>
          <Label className="grid gap-1">{t("workBoard.detailFieldLabel")}
            <Textarea rows={3} maxLength={16384} value={detail} onChange={event => setDetail(event.target.value)} />
          </Label>
        </fieldset>
      )}
      {!eligible && <p role="status" className="text-sm text-muted-foreground">{t("workflowTemplates.projectMismatch")}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{t(error)}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={!eligible || sending || !title.trim()}>
          {t(existingItem ? "workflowTemplates.startRun" : "workflowTemplates.createAndRun")}
        </Button>
      </div>
    </form>
  );
}
