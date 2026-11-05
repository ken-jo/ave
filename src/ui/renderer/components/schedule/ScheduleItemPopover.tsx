// The body of a schedule item's popover: provenance, the editable fields, next run, the missed-run rule, recent runs and the
// item's own actions. Every action is the user's own and applies at once; 삭제 is undone from the panel's toast, not confirmed.
import { useState } from "react";
import { AlertCircle, Check, Pause, Play, Trash2, X } from "lucide-react";
import { t } from "../../../../i18n/runtime.js";
import { Button } from "../../../../components/ui/button.js";
import { Input } from "../../../../components/ui/input.js";
import { Textarea } from "../../../../components/ui/textarea.js";
import { formatMediumDateTime } from "../../../../shared/format-time.js";
import type { RepeatKind, RoutineEditPatch, RoutineRecord, RoutineRepeat, RoutineRun } from "../../../../shared/routines-types.js";
import { isValidCronExpression } from "../../../../routines/cron-evaluator.js";
import { describeSchedule } from "../RoutinePanel.js";
import { ChatLinkField, type ChatChoice } from "./chat-link.js";

const REPEATS: Array<{ kind: Exclude<RepeatKind, "cron">; labelKey: string }> = [
  { kind: "none", labelKey: "routinePanel.repeatNone" },
  { kind: "daily", labelKey: "routinePanel.repeatDaily" },
  { kind: "weekly", labelKey: "routinePanel.repeatWeekly" },
  { kind: "monthly", labelKey: "routinePanel.repeatMonthly" },
  { kind: "interval", labelKey: "routinePanel.repeatInterval" },
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function routineTitle(routine: RoutineRecord): string {
  return routine.title || routine.notificationTitle || routine.prePrompt?.slice(0, 30) || routine.id.slice(0, 8);
}

export interface ScheduleItemPopoverProps {
  routine: RoutineRecord;
  /** The next projected fire inside the loaded range, if any. */
  nextAt?: string;
  /** This item's runs inside the loaded range, newest first. */
  recentRuns: readonly RoutineRun[];
  running: boolean;
  /** A one-shot whose time passed while paused: it does not run until 지금 실행 or a new time. */
  missed?: boolean;
  /** Which plugin template the item came from, or that the template is gone. */
  templateNote?: string;
  onClose: () => void;
  onSave: (patch: RoutineEditPatch) => Promise<string | null>;
  onPause: () => void;
  onResume: () => void;
  onRunNow: () => void;
  onDelete: () => void;
  onOpenSession?: (sessionId: string) => void;
  /** What the user has typed so far, held by the panel so a popover re-anchored after a refresh keeps it. */
  draft?: ScheduleItemDraft;
  onDraftChange?: (draft: ScheduleItemDraft) => void;
  /** The project's chats a scheduled turn can be connected to. */
  chats?: readonly ChatChoice[];
}

/** The popover's editable fields, as the user typed them. */
export interface ScheduleItemDraft {
  title?: string;
  text?: string;
  date?: string;
  time?: string;
  repeat?: RepeatKind;
  intervalMinutes?: string;
  cron?: string;
  /** The connected chat's session id; "" runs in a new chat. */
  chat?: string;
}

export function ScheduleItemPopover(props: ScheduleItemPopoverProps) {
  const { routine } = props;
  const scheduled = routine.trigger === "schedule";
  const repeat = routine.schedule?.repeat;
  const isCron = repeat?.kind === "cron";
  const at = routine.schedule?.at ? new Date(routine.schedule.at) : null;
  const initial = {
    title: routine.title ?? "",
    text: routine.execution === "llm-session" ? routine.prePrompt ?? "" : routine.notificationTitle ?? "",
    date: at ? localDate(at) : "",
    time: at ? localTime(at) : "09:00",
    repeat: (repeat?.kind ?? "none") as RepeatKind,
    intervalMinutes: repeat?.kind === "interval" ? String(Math.round(repeat.intervalMs / 60_000)) : "60",
    cron: repeat?.kind === "cron" ? repeat.expression : "",
    chat: routine.targetSessionId ?? "",
  };
  type FormKey = keyof typeof initial;
  // Only what the user typed is held here. Every other field follows the latest record, so a refresh after the item fires
  // (which moves `at` forward) neither marks the form dirty nor sends the old time back.
  const [localEdits, setLocalEdits] = useState<ScheduleItemDraft>({});
  const edits = props.draft ?? localEdits;
  const setEdits = (next: ScheduleItemDraft) => (props.onDraftChange ?? setLocalEdits)(next);
  const form = { ...initial, ...edits };
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const changed = (key: FormKey) => edits[key] !== undefined && edits[key] !== initial[key];
  const dirty = (Object.keys(initial) as FormKey[]).some(changed);
  const set = <K extends FormKey>(key: K, value: (typeof initial)[K]) => setEdits({ ...edits, [key]: value });

  const buildPatch = (): RoutineEditPatch | null => {
    const patch: RoutineEditPatch = {};
    if (changed("title")) patch.title = form.title.trim() ? form.title.trim() : null;
    if (changed("text")) {
      if (!form.text.trim()) return null;
      if (routine.execution === "llm-session") patch.prePrompt = form.text.trim();
      else patch.notificationTitle = form.text.trim();
    }
    if (changed("chat")) patch.targetSessionId = form.chat === "" ? null : form.chat;
    const scheduleChanged = (["date", "time", "repeat", "intervalMinutes", "cron"] as const).some(changed);
    if (scheduled && scheduleChanged) {
      if (form.repeat === "cron") {
        if (!isValidCronExpression(form.cron.trim())) return null;
        patch.schedule = { repeat: { kind: "cron", expression: form.cron.trim() } };
      } else {
        const parsed = new Date(`${form.date}T${form.time}:00`);
        if (!form.date || Number.isNaN(parsed.getTime())) return null;
        let next: RoutineRepeat = { kind: form.repeat } as RoutineRepeat;
        if (form.repeat === "interval") {
          const ms = Number.parseInt(form.intervalMinutes, 10) * 60_000;
          if (!Number.isFinite(ms) || ms <= 0) return null;
          next = { kind: "interval", intervalMs: ms };
        }
        patch.schedule = { at: parsed.toISOString(), repeat: next };
      }
    }
    return patch;
  };

  const save = async () => {
    const patch = buildPatch();
    if (!patch) {
      setError(t("routinePanel.errorInvalidSchedule"));
      return;
    }
    setSaving(true);
    setError("");
    const failure = await props.onSave(patch);
    setSaving(false);
    if (failure) setError(failure);
    else setEdits({});
  };

  const attention = routine.needsAttention
    ? t(routine.lastSkippedReason === "plugins-missing" ? "routinePanel.pluginsMissing" : "routinePanel.pluginsPartlyMissing", {
      plugins: routine.needsAttention.missingPluginIds.join(", "),
    })
    : null;
  const failure = routine.lastFailure && !routine.lastFailure.acknowledgedAt ? routine.lastFailure : null;
  // Only a scheduled turn has a chat to enter; a notification or a quit-time run has none.
  const connectable = scheduled && routine.execution === "llm-session";

  return (
    <div className="flex max-h-[min(80vh,640px)] flex-col gap-3 overflow-y-auto text-sm" data-testid="schedule-item-popover">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold">{routineTitle(routine)}</div>
          <div className="text-xs text-muted-foreground" data-testid="schedule-provenance">
            {t(routine.createdBy === "agent" ? "schedulePanel.addedByAgent" : "schedulePanel.addedByUser", {
              when: formatMediumDateTime(routine.createdAt),
            })}
          </div>
        </div>
        <Button size="sm" variant="ghost" className="h-7 w-7 shrink-0 p-0" aria-label={t("routinePanel.closeAriaLabel")} onClick={props.onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {props.templateNote && <p className="text-xs text-muted-foreground" data-testid="schedule-template-note">{props.templateNote}</p>}
      {routine.pausedAt && (
        <p className="rounded-md bg-muted px-2 py-1.5 text-xs" role="status" data-testid="schedule-paused-note">
          {t(routine.pausedBy === "agent" ? "schedulePanel.pausedByAgent" : "schedulePanel.pausedByUser", {
            when: formatMediumDateTime(routine.pausedAt),
          })}
          {" "}{t("schedulePanel.resumeRule")}
        </p>
      )}
      {props.missed && (
        <p className="rounded-md bg-muted px-2 py-1.5 text-xs text-warning" role="status" data-testid="schedule-missed-note">{t("schedulePanel.missedWhilePaused")}</p>
      )}
      {routine.orphanedAt && (
        <p className="rounded-md bg-muted px-2 py-1.5 text-xs text-warning" role="status" data-testid="schedule-orphaned-note">{t("schedulePanel.orphanedNote")}</p>
      )}
      {routine.lastSkippedReason === "chat-busy" && routine.lastFiredAt && (
        <p className="break-words text-xs text-warning" role="status" data-testid="schedule-chat-busy-note">
          {t("schedulePanel.chatBusySkipped", { when: formatMediumDateTime(routine.lastFiredAt) })}
        </p>
      )}
      {attention && <p className="break-words text-xs text-warning" role="status">{attention}</p>}
      {failure && (
        <p className="flex items-start gap-1 break-words text-xs text-destructive" role="status">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {failure.kind === "error" ? t("schedulePanel.lastRunFailed", { reason: failure.reason }) : t("schedulePanel.lastRunTimedOut")}
        </p>
      )}

      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t("routinePanel.titleLabel")}</span>
        <Input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder={t("routinePanel.titlePlaceholder")} />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t(routine.execution === "llm-session" ? "routinePanel.llmPromptLabel" : "routinePanel.notificationTitleLabel")}
        </span>
        {routine.execution === "llm-session"
          ? <Textarea rows={3} value={form.text} onChange={(e) => set("text", e.target.value)} data-testid="schedule-edit-prompt" />
          : <Input value={form.text} onChange={(e) => set("text", e.target.value)} />}
      </label>

      {connectable && (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <ChatLinkField value={form.chat} onChange={(value) => set("chat", value)} chats={props.chats ?? []}
              missing={Boolean(routine.orphanedAt) && form.chat === routine.targetSessionId} />
          </div>
          {routine.targetSessionId && !routine.orphanedAt && props.onOpenSession && (
            <Button size="sm" variant="outline" className="h-8 shrink-0" onClick={() => props.onOpenSession?.(routine.targetSessionId!)}>
              {t("schedulePanel.openChat")}
            </Button>
          )}
        </div>
      )}

      {scheduled && (isCron ? (
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("routinePanel.cronExpressionLabel")}</span>
          <Input value={form.cron} onChange={(e) => setEdits({ ...edits, cron: e.target.value, repeat: "cron" })} />
        </label>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-[minmax(0,1fr)_8.5rem] gap-2">
            <label className="min-w-0 space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("routinePanel.dateLabel")}</span>
              <Input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("routinePanel.timeLabel")}</span>
              <Input type="time" value={form.time} onChange={(e) => set("time", e.target.value)} />
            </label>
          </div>
          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("routinePanel.repeatLabel")}</span>
            <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1" role="radiogroup" aria-label={t("routinePanel.repeatLabel")}>
              {REPEATS.map(({ kind, labelKey }) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={form.repeat === kind}
                  className={`flex-1 rounded px-2 py-1 text-xs ${form.repeat === kind ? "bg-background font-medium shadow-sm" : "text-muted-foreground"}`}
                  onClick={() => set("repeat", kind)}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
            {form.repeat === "interval" && (
              <Input type="number" min="1" value={form.intervalMinutes} onChange={(e) => set("intervalMinutes", e.target.value)}
                aria-label={t("routinePanel.intervalMinutesLabel")} />
            )}
          </div>
        </div>
      ))}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("schedulePanel.nextRun")}</dt>
        <dd data-testid="schedule-next-run">
          {routine.pausedAt ? t("schedulePanel.nextRunPaused")
            : props.nextAt ? formatMediumDateTime(props.nextAt) : describeSchedule(routine)}
        </dd>
        {scheduled && (
          <>
            <dt className="text-muted-foreground">{t("schedulePanel.missedLabel")}</dt>
            <dd>{t(isCron ? "schedulePanel.missedRuleCron" : "schedulePanel.missedRule")}</dd>
          </>
        )}
      </dl>

      {props.recentRuns.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">{t("schedulePanel.recentRuns")}</div>
          <ul className="space-y-1 text-xs" data-testid="schedule-recent-runs">
            {props.recentRuns.slice(0, 3).map((run) => (
              <li key={run.firedAt} className="flex items-center gap-2">
                {run.status === "failed"
                  ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                  : <Check className="h-3.5 w-3.5 shrink-0 text-success" />}
                <span className="min-w-0 flex-1 truncate">{formatMediumDateTime(run.firedAt)}</span>
                <span className={run.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                  {t(run.status === "failed" ? "schedulePanel.runFailed" : "schedulePanel.runDone")}
                </span>
                {run.sessionId && props.onOpenSession && (
                  <button type="button" className="underline" onClick={() => props.onOpenSession?.(run.sessionId!)}>
                    {t("schedulePanel.openChat")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        {routine.pausedAt
          ? <Button size="sm" variant="outline" onClick={props.onResume}><Play className="mr-1 h-3.5 w-3.5" />{t("schedulePanel.resume")}</Button>
          : <Button size="sm" variant="outline" onClick={props.onPause}><Pause className="mr-1 h-3.5 w-3.5" />{t("schedulePanel.pause")}</Button>}
        <Button size="sm" variant="outline" disabled={Boolean(routine.pausedAt) || Boolean(routine.orphanedAt) || props.running} onClick={props.onRunNow}>
          <Play className="mr-1 h-3.5 w-3.5" />{t("routinePanel.triggerNowButton")}
        </Button>
        <Button size="sm" variant="outline" className="text-destructive" onClick={props.onDelete}>
          <Trash2 className="mr-1 h-3.5 w-3.5" />{t("routinePanel.deleteButton")}
        </Button>
        <Button size="sm" className="ml-auto" disabled={!dirty || saving} onClick={() => void save()}>
          {t("schedulePanel.save")}
        </Button>
      </div>
    </div>
  );
}
