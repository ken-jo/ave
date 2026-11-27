import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatMediumDateTime } from "../../../shared/format-time.js";
import type { SkillMemoryApi, SkillMemoryDecision, SkillMemoryLesson } from "../../../shared/skill-memory-types.js";

type SkillMemorySnapshot = Extract<Awaited<ReturnType<SkillMemoryApi["list"]>>, { ok: true }>;

function SkillMemoryLessonText({ lesson }: { lesson: SkillMemoryLesson }) {
  const { t } = useTranslation();
  const source = {
    attended: t("skillMemory.attended"),
    headless: t("skillMemory.headless"),
    scheduled: t("skillMemory.scheduled"),
  };
  return <>
    <h4 className="break-words text-sm font-medium">{lesson.description}</h4>
    <p className="whitespace-pre-wrap break-words text-sm">{lesson.body}</p>
    <p className="text-xs text-muted-foreground">{source[lesson.origin.runKind]}</p>
  </>;
}

export function SkillMemoryContent({ api }: { api: SkillMemoryApi }) {
  const { t, locale } = useTranslation();
  const [snapshot, setSnapshot] = useState<SkillMemorySnapshot | null>();
  const [decisionFailed, setDecisionFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<{ scopeId: string; lesson: SkillMemoryLesson } | null>(null);
  const requests = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requests.current;
    try {
      const result = await api.list();
      if (request !== requests.current) return;
      setSnapshot(result.ok ? result : null);
    } catch {
      if (request === requests.current) setSnapshot(null);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    return () => { requests.current++; };
  }, [refresh]);

  const handleDecision = async (decision: SkillMemoryDecision) => {
    setBusy(true);
    setDecisionFailed(false);
    try {
      const result = await api.decide(decision);
      setDecisionFailed(!result.ok);
    } catch {
      setDecisionFailed(true);
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  const actions = {
    activate: t("skillMemory.activated"),
    stage: t("skillMemory.staged"),
    apply: t("skillMemory.applied"),
    reject: t("skillMemory.rejected"),
    undo: t("skillMemory.undone"),
    delete: t("skillMemory.deleted"),
  };
  const retry = <Button size="sm" variant="outline" disabled={busy} onClick={() => {
    setDecisionFailed(false);
    void refresh();
  }}>{t("memoryMap.retry")}</Button>;
  const renderUndo = (scopeId: string, changeId: string | undefined, digest: string) => changeId && <Button
    size="sm"
    variant="outline"
    disabled={busy}
    onClick={() => void handleDecision({ scopeId, action: "undo", changeId, digest })}
  >{t("skillMemory.undo")}</Button>;
  const renderLessonActions = (scopeId: string, lesson: SkillMemoryLesson, changeId: string | undefined) => <div className="flex flex-wrap gap-2">
    {renderUndo(scopeId, changeId, lesson.digest)}
    <Button size="sm" variant="outline" disabled={busy} onClick={() => setDeleting({ scopeId, lesson })}>
      {t("skillMemory.delete")}
    </Button>
  </div>;
  return <div className="min-h-0 flex-1 space-y-4 overflow-auto rounded-lg border p-4">
    {(snapshot === null || decisionFailed) && <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm text-destructive" role="alert">{t(snapshot === null ? "skillMemory.storeUnavailable" : "skillMemory.unavailable")}</p>
      {retry}
    </div>}
    {snapshot?.review === "unavailable" && <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
      <p className="text-sm" role="status">{t("skillMemory.reviewUnavailable")}</p>
      {!decisionFailed && retry}
    </div>}
    {snapshot?.review === "off" && <div className="rounded-md border p-3">
      <p className="text-sm" role="status">{t("skillMemory.reviewOff")}</p>
    </div>}
    {snapshot?.review === "capacity" && <div className="rounded-md border p-3">
      <p className="text-sm" role="status">{t("skillMemory.reviewCapacity")}</p>
    </div>}
    {snapshot === undefined && <p className="text-sm" role="status">{t("skillMemory.loading")}</p>}
    {snapshot?.groups.length === 0 && <p className="text-sm text-muted-foreground">{t("skillMemory.empty")}</p>}
    {snapshot?.groups.map(({ scope, active, staged, retired, history, undo }) => <section key={scope.id} className="space-y-4 rounded-lg border p-4">
      <header>
        <h2 className="break-words font-semibold">{scope.skill}</h2>
        <p className="break-all text-xs text-muted-foreground">{scope.projectRoot}</p>
      </header>
      {staged.length > 0 && <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("skillMemory.needsReview")}</h3>
        {staged.map(lesson => <article key={lesson.id} className="space-y-2 rounded-md border p-3">
          <SkillMemoryLessonText lesson={lesson} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void handleDecision({
              scopeId: scope.id, action: "apply", lessonId: lesson.id, digest: lesson.digest,
            })}>{t("skillMemory.apply")}</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleDecision({
              scopeId: scope.id, action: "reject", lessonId: lesson.id, digest: lesson.digest,
            })}>{t("skillMemory.reject")}</Button>
          </div>
        </article>)}
      </section>}
      {active.length > 0 && <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("skillMemory.active")}</h3>
        {active.map(lesson => <article key={lesson.id} className="space-y-2 rounded-md border p-3">
          <SkillMemoryLessonText lesson={lesson} />
          {renderLessonActions(scope.id, lesson, undo[lesson.digest])}
        </article>)}
      </section>}
      {retired.length > 0 && <details>
        <summary className="cursor-pointer text-sm font-semibold">{t("skillMemory.retired")}</summary>
        <p className="my-2 text-sm text-muted-foreground">{t("skillMemory.retiredHint")}</p>
        {retired.map(lesson => <article key={lesson.digest} className="my-2 space-y-2 rounded-md border p-3">
          <SkillMemoryLessonText lesson={lesson} />
          {renderLessonActions(scope.id, lesson, undo[lesson.digest])}
        </article>)}
      </details>}
      <details>
        <summary className="cursor-pointer text-sm font-semibold">{t("skillMemory.history")}</summary>
        <ul className="mt-2 space-y-2">
          {history.toReversed().map(change => {
            const lesson = change.after ?? change.before;
            return <li key={change.id} className="space-y-2 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">{actions[change.action]} · <time dateTime={change.at}>{formatMediumDateTime(change.at, locale)}</time></p>
              {lesson && <SkillMemoryLessonText lesson={lesson} />}
              {change.action === "delete" && change.before && undo[change.before.digest] === change.id
                && renderUndo(scope.id, change.id, change.before.digest)}
            </li>;
          })}
        </ul>
      </details>
    </section>)}
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open) setDeleting(null); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t("skillMemory.delete")}</DialogTitle>
          <DialogDescription>{t("skillMemory.deleteDescription", { lesson: deleting?.lesson.description ?? "" })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button autoFocus variant="secondary" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
          <Button variant="destructive" disabled={busy} onClick={() => {
            if (!deleting) return;
            const { scopeId, lesson } = deleting;
            setDeleting(null);
            void handleDecision({ scopeId, action: "delete", lessonId: lesson.id, digest: lesson.digest });
          }}>{t("skillMemory.delete")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
