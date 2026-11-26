import { useEffect, useId, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import { t } from "../../../../i18n/runtime.js";
import type { RoutineRecord } from "../../../../shared/routines-types.js";
import type { WorkflowTemplate, WorkflowTemplateRecord } from "../../../../shared/workflow-template-types.js";
import type { AveApi } from "../../types.js";

interface AttachWorkflowScheduleDialogProps {
  api: AveApi;
  routine?: RoutineRecord;
  onClose: () => void;
  onAttached: () => void;
}

export function AttachWorkflowScheduleDialog({ api, routine, onClose, onAttached }: AttachWorkflowScheduleDialogProps) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [id, setId] = useState("");
  const [record, setRecord] = useState<WorkflowTemplateRecord | null>(null);
  const [at, setAt] = useState("");
  const [repeat, setRepeat] = useState<"none" | "daily" | "weekly" | "monthly">("none");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const firstFireId = useId();

  useEffect(() => {
    let cancelled = false;
    void api.listWorkflowTemplates().then(result => {
      if (cancelled) return;
      if (result.ok) setTemplates(result.value.filter(template => template.currentVersion > 0));
      else setError(t("workflowSchedule.unavailable"));
    }, () => { if (!cancelled) setError(t("workflowSchedule.unavailable")); });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    void api.getWorkflowTemplate(id).then(result => {
      if (cancelled) return;
      if (result.ok) setRecord(result.value);
      else setError(t("workflowSchedule.unavailable"));
    }, () => { if (!cancelled) setError(t("workflowSchedule.unavailable")); });
    return () => { cancelled = true; };
  }, [api, id]);

  const template = record?.template.id === id ? record.template : undefined;
  const pin = template && record?.versions.find(version => version.version === template.currentVersion);
  const submit = async () => {
    if (!template || !pin || saving) return;
    const date = new Date(at);
    if (!routine && !Number.isFinite(date.getTime())) {
      setError(t("routinePanel.errorInvalidSchedule"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await api.attachWorkflowTemplateSchedule({
        templateId: pin.templateId, version: pin.version, graphHash: pin.graphHash, expectedScope: template.scope,
        ...(routine ? { scheduleId: routine.id } : { schedule: { at: date.toISOString(), repeat: { kind: repeat } } }),
      });
      if (result.ok) onAttached();
      else {
        const known = result.error === "schedule-requires-read-only" || result.error === "scope-changed"
          || result.error === "scope-not-authorised" || result.error === "template-archived" || result.error === "not-current-version";
        setError(known ? t(`reasonCodes.${result.error}`) : t("workflowSchedule.unavailable"));
      }
    } catch {
      setError(t("workflowSchedule.unavailable"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t("workflowSchedule.attach")}</DialogTitle>
          <DialogDescription>{t("workflowSchedule.approvalDescription")}</DialogDescription>
        </DialogHeader>
        <label className="grid gap-1 text-sm">
          {t("workflowSchedule.template")}
          <select className="h-9 rounded-md border bg-background px-2" value={id} disabled={saving} onChange={event => {
            setRecord(null);
            setError("");
            setId(event.target.value);
          }}>
            <option value="">{t("workflowSchedule.chooseTemplate")}</option>
            {templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {pin && template && (
          <div className="grid gap-1 text-sm">
            <p>{t("workflowSchedule.version", { version: pin.version })}</p>
            <p className="break-words">{template.scope.kind === "project" ? template.scope.projectRoot : t("workflowSchedule.noProject")}</p>
          </div>
        )}
        {!routine && (
          <>
            <div className="grid gap-1 text-sm">
              <label htmlFor={firstFireId}>{t("workflowSchedule.firstFire")}</label>
              <Input id={firstFireId} type="datetime-local" value={at} onChange={event => setAt(event.target.value)} />
            </div>
            <label className="grid gap-1 text-sm">
              {t("routinePanel.repeatLabel")}
              <select className="h-9 rounded-md border bg-background px-2" value={repeat} onChange={event => setRepeat(event.target.value as typeof repeat)}>
                <option value="none">{t("routinePanel.repeatNone")}</option>
                <option value="daily">{t("routinePanel.repeatDaily")}</option>
                <option value="weekly">{t("routinePanel.repeatWeekly")}</option>
                <option value="monthly">{t("routinePanel.repeatMonthly")}</option>
              </select>
            </label>
          </>
        )}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="button" disabled={!pin || saving || (!routine && !at)} onClick={() => void submit()}>{t("workflowSchedule.approveAttach")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
