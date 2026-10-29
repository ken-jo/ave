import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { t } from "../../../i18n/runtime.js";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Textarea } from "../../../components/ui/textarea.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import type { AveApi, PluginCardSummary } from "../types.js";
import type { AddRoutineInput, InvalidRoutine, RoutineRecord, RoutineExecution, RepeatKind, RoutineSchedule } from "../../../shared/routines-types.js";
import { MAX_PERSISTED_ROUTINES, MAX_LLM_SESSION_ROUTINES } from "../../../shared/routines-types.js";
import { isValidCronExpression } from "../../../routines/cron-evaluator.js";
import { formatMediumDateTime, formatRelativeSessionTime } from "../../../shared/format-time.js";
import type { RoutineRunRow } from "../../../shared/session-lookup.js";
import { packageRoutineSource, type AgentPluginRoutineTemplate } from "../../../shared/agent-plugin-routine-template.js";
import { useInstalledContent } from "../installed-content.js";

/** A run row as this panel holds it: the shared conversation row, with the routine's own title resolved. The panel fetches
 * runs one routine at a time, so the routine naming each row is known before the row is built. */
type RoutineRunListRow = RoutineRunRow & { routineTitle: string };

/**
 * When a run happened. `routineFiredAt` is what the scheduler wrote at fire
 * time; a session persisted before that field existed answers with its last
 * write instead of dropping out of the list. The label and the sort read the
 * same instant so a row never sorts by one time and reads as another.
 */
function runInstant(row: RoutineRunRow): string {
  return row.routineFiredAt ?? row.modifiedAt;
}
import { errorMessage } from "../../../shared/error-message.js";
import { usePaneActions } from "./PaneFrame.js";

export interface RoutinePanelProps {
  api: AveApi;
  onOpenSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
}

function ExecutionBadge({ execution }: { execution: RoutineExecution }) {
  return (
    <Badge variant={execution === "llm-session" ? "default" : "outline"}>
      {execution === "llm-session" ? "LLM" : t("routinePanel.notificationBadge")}
    </Badge>
  );
}

interface RoutineRowProps {
  routine: RoutineRecord;
  installedTemplateSources: ReadonlySet<string>;
  onDismiss: (id: string) => void;
  onRemove: (id: string) => void;
  onTriggerNow: (id: string) => void;
  recentlyFired: boolean;
}

function describeSchedule(routine: Pick<RoutineRecord, "schedule" | "trigger">): string {
  const s = routine.schedule;
  if (!s) return routine.trigger === "shutdown" ? t("routinePanel.onShutdown") : t("routinePanel.noSchedule");
  const repeatKind = s.repeat?.kind;
  const atStr = s.at ? formatMediumDateTime(s.at) : "";
  if (repeatKind === "cron") {
    const expr = (s.repeat as { kind: "cron"; expression: string }).expression;
    return t("routinePanel.cronSchedule", { expr });
  }
  if (repeatKind === "daily") return t("routinePanel.scheduleDaily", { atStr });
  if (repeatKind === "weekly") return t("routinePanel.scheduleWeekly", { atStr });
  if (repeatKind === "monthly") return t("routinePanel.scheduleMonthly", { atStr });
  if (repeatKind === "interval") {
    const ms = (s.repeat as { kind: "interval"; intervalMs: number }).intervalMs;
    const mins = Math.round(ms / 60000);
    return atStr
      ? t("routinePanel.scheduleIntervalWithNext", { mins: String(mins), atStr })
      : t("routinePanel.scheduleInterval", { mins: String(mins) });
  }
  return atStr || t("routinePanel.scheduleOnce");
}

/** A stored routine the host holds back: shown as an error with its reason and a remove action. */
function InvalidRoutineRow({ routine, onRemove }: { routine: InvalidRoutine; onRemove: (id: string) => void }) {
  return (
    <div className="rounded-lg border border-destructive/(--opacity-strong) bg-destructive/(--opacity-subtle) p-3" data-testid="invalid-routine-row" role="alert">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold leading-snug text-foreground">{routine.id.slice(0, 8)}</span>
          <p className="mt-1 break-words text-xs text-destructive">
            {t("routinePanel.invalidPluginId", { value: routine.value, field: routine.field })}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-[11px] text-destructive"
          onClick={() => onRemove(routine.id)}
        >
          {t("routinePanel.deleteButton")}
        </Button>
      </div>
    </div>
  );
}

function RoutineRow({ routine, installedTemplateSources, onDismiss, onRemove, onTriggerNow, recentlyFired }: RoutineRowProps) {
  const templateSource = routine.source?.startsWith("agent-plugin:") || routine.source?.startsWith("extension:") ? routine.source : null;
  return (
    <div
      className={`rounded-lg border bg-background p-3 shadow-sm transition-shadow hover:shadow-md ${recentlyFired ? "border-warning/(--opacity-strong) bg-warning/(--opacity-subtle)" : ""}`}
      data-testid="routine-row"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold leading-snug text-foreground">{routine.title || routine.notificationTitle || routine.prePrompt?.slice(0, 30) || routine.id.slice(0, 8)}</span>
            <ExecutionBadge execution={routine.execution} />
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {describeSchedule(routine)}
          </div>
          {templateSource && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {installedTemplateSources.has(templateSource)
                ? t(templateSource.startsWith("extension:") ? "routinePanel.createdFromExtensionTemplate" : "routinePanel.createdFromPluginTemplate",
                  { plugin: templateSource.split(":")[1]! })
                : t("routinePanel.templateNoLongerInstalled")}
            </p>
          )}
          {routine.needsAttention && (
            <p className="mt-1 break-words text-xs text-warning" role="status">
              {t(routine.lastSkippedReason === "plugins-missing"
                ? "routinePanel.pluginsMissing" : "routinePanel.pluginsPartlyMissing", {
                plugins: routine.needsAttention.missingPluginIds.join(", "),
              })}
            </p>
          )}
          {routine.prePrompt && (
            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
              {routine.prePrompt}
            </p>
          )}
          {routine.notificationBody && (
            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
              {routine.notificationBody}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={() => onTriggerNow(routine.id)}
          >
            {t("routinePanel.triggerNowButton")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={() => onDismiss(routine.id)}
          >
            {t("routinePanel.dismissButton")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px] text-destructive"
            onClick={() => onRemove(routine.id)}
          >
            {t("routinePanel.deleteButton")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One run of a routine. The row is the sidebar's row — same fields, same time label — because it is the same session; only
 * the opening snippet is drawn here, where there is room for it. */
function RoutineSessionRow({ session, onOpen }: { session: RoutineRunListRow; onOpen: (sessionId: string) => void }) {
  return (
    <button
      type="button"
      className="w-full rounded-lg border bg-background px-3 py-2 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="routine-session-row"
      onClick={() => onOpen(session.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="line-clamp-1 text-sm font-semibold leading-snug text-foreground">{session.routineTitle}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {formatRelativeSessionTime(runInstant(session), t)}
          </div>
          {session.preview && (
            <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {session.preview}
            </div>
          )}
        </div>
        <Badge variant="outline">{t("routinePanel.openSessionBadge")}</Badge>
      </div>
    </button>
  );
}

type InputTab = "form" | "cron" | "natural";

const REPEAT_OPTIONS: Array<{ value: RepeatKind; labelKey: string }> = [
  { value: "none", labelKey: "routinePanel.repeatNone" },
  { value: "daily", labelKey: "routinePanel.repeatDaily" },
  { value: "weekly", labelKey: "routinePanel.repeatWeekly" },
  { value: "monthly", labelKey: "routinePanel.repeatMonthly" },
  { value: "interval", labelKey: "routinePanel.repeatInterval" },
];

interface AddRoutineModalProps {
  api: AveApi;
  onClose: () => void;
  onAdded: () => void;
  template?: AgentPluginRoutineTemplate;
}

// Exported for renderer tests — the modal owns the button → scope-payload mapping that we want to lock down (empty
// selection MUST map to `{ mode: "deny-all" }`, not "inherit" / "allow all").
export function AddRoutineModal({ api, onClose, onAdded, template }: AddRoutineModalProps) {
  const [tab, setTab] = useState<InputTab>(template?.schedule?.repeat?.kind === "cron" ? "cron" : "form");
  const [trigger, setTrigger] = useState<"schedule" | "shutdown">(template?.trigger ?? "schedule");
  const [execution, setExecution] = useState<RoutineExecution>(template?.execution ?? "llm-session");
  const [title, setTitle] = useState(template?.title ?? "");
  const [prePrompt, setPrePrompt] = useState(template?.prePrompt ?? "");
  const [notificationTitle, setNotificationTitle] = useState(template?.notificationTitle ?? "");
  const [notificationBody, setNotificationBody] = useState(template?.notificationBody ?? "");
  const [pluginCards, setPluginCards] = useState<PluginCardSummary[]>([]);
  const [allowedPluginIds, setAllowedPluginIds] = useState<string[]>([]);
  const [pluginScopeError, setPluginScopeError] = useState("");

  // Form tab fields
  const initialAt = template?.schedule?.at ? new Date(template.schedule.at) : null;
  const [atDate, setAtDate] = useState(initialAt ? `${initialAt.getFullYear()}-${String(initialAt.getMonth() + 1).padStart(2, "0")}-${String(initialAt.getDate()).padStart(2, "0")}` : "");
  const [atTime, setAtTime] = useState(initialAt ? `${String(initialAt.getHours()).padStart(2, "0")}:${String(initialAt.getMinutes()).padStart(2, "0")}` : "09:00");
  const [repeatKind, setRepeatKind] = useState<RepeatKind>(template?.schedule?.repeat?.kind ?? "none");
  const [intervalMinutes, setIntervalMinutes] = useState(template?.schedule?.repeat?.kind === "interval" ? String(template.schedule.repeat.intervalMs / 60_000) : "60");

  const [cronExpression, setCronExpression] = useState(template?.schedule?.repeat?.kind === "cron" ? template.schedule.repeat.expression : "0 9 * * 1-5");
  const [cronError, setCronError] = useState("");

  // Natural language tab
  const [naturalInput, setNaturalInput] = useState("");
  const [naturalParsing, setNaturalParsing] = useState(false);
  const [naturalError, setNaturalError] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.listPluginCards()
      .then((cards) => {
        if (cancelled) return;
        setPluginCards(
          cards
            .filter((card) => card.loadStatus === "loaded" && card.tools.length > 0)
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        setPluginScopeError("");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = errorMessage(err);
        setPluginScopeError(message || t("routinePanel.errorLoadPlugins"));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const toggleAllowedPlugin = (pluginId: string) => {
    setAllowedPluginIds((prev) => (
      prev.includes(pluginId)
        ? prev.filter((id) => id !== pluginId)
        : [...prev, pluginId]
    ));
  };

  const buildSchedulePayload = (): Record<string, unknown> | null => {
    if (tab === "form") {
      if (!atDate) return null;
      // ISO normalize: local datetime string → UTC ISO string before IPC.
      const localDateTimeStr = `${atDate}T${atTime}:00`;
      const parsed = new Date(localDateTimeStr);
      if (Number.isNaN(parsed.getTime())) return null;
      const at = parsed.toISOString();
      const repeat: Record<string, unknown> = { kind: repeatKind };
      if (repeatKind === "interval") {
        const ms = Number.parseInt(intervalMinutes, 10) * 60_000;
        if (!Number.isFinite(ms) || ms <= 0) return null;
        repeat.intervalMs = ms;
      }
      return { at, repeat };
    }
    if (trigger === "schedule" && tab === "cron") {
      const expr = cronExpression.trim();
      if (!expr) return null;
      // Client-side cron validation — reject invalid expressions before IPC.
      if (!isValidCronExpression(expr)) return null;
      return { repeat: { kind: "cron", expression: expr } };
    }
    return null;
  };

  const handleSubmit = async () => {
    if (tab === "natural") {
      // Natural language tab has its own submit button; this branch is unreachable from the main submit button (which is hidden
      // for tab === "natural").
      return;
    }

    // Cron-specific inline error before generic schedule check.
    if (tab === "cron") {
      const expr = cronExpression.trim();
      if (!expr || !isValidCronExpression(expr)) {
        setCronError(t("routinePanel.errorInvalidCron"));
        return;
      }
      setCronError("");
    }

    const schedule = trigger === "schedule" ? buildSchedulePayload() : undefined;
    if (trigger === "schedule" && !schedule) {
      setError(t("routinePanel.errorInvalidSchedule"));
      return;
    }

    if (execution === "llm-session" && !prePrompt.trim()) {
      setError(t("routinePanel.errorPromptRequired"));
      return;
    }

    if (execution === "notification-only" && !notificationTitle.trim()) {
      setError(t("routinePanel.errorNotificationTitleRequired"));
      return;
    }

    const input: AddRoutineInput = {
      trigger,
      execution,
      ...(schedule ? { schedule: schedule as RoutineSchedule } : {}),
      ...(template ? { source: packageRoutineSource(template) } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(execution === "llm-session"
        ? {
            prePrompt: prePrompt.trim(),
            // Permission policy Layer 4 — RoutinePanel always emits an explicit scope: empty plugin selection = deny-all (matches the
            // panel's "허용 안 함" semantic); non-empty = explicit allow-list.
            scope: {
              pluginIds:
                allowedPluginIds.length > 0
                  ? { mode: "allow", ids: allowedPluginIds }
                  : { mode: "deny-all" },
              forcedPluginIds: [],
              directories: [],
            },
          }
        : {
            ...(notificationTitle.trim() ? { notificationTitle: notificationTitle.trim() } : {}),
            ...(notificationBody.trim() ? { notificationBody: notificationBody.trim() } : {}),
          }),
    };

    setSubmitting(true);
    setError("");
    try {
      const result = await api.addRoutine(input);
      if (result.ok) {
        onAdded();
        onClose();
      } else {
        setError(result.error ?? t("routinePanel.errorAddRoutineFailed"));
      }
    } catch (err) {
      setError(errorMessage(err) || t("routinePanel.errorAddRoutineFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleNaturalLanguageParse = async () => {
    // Captured inside the click: main runs the request as the user's turn only with this gesture's consumed token.
    const userIntent = api.captureUserKeyboardIntent();
    if (!naturalInput.trim()) return;
    setNaturalParsing(true);
    setNaturalError("");
    try {
      // Natural language → LLM parses and calls routine_schedule directly. Fence the user input so it cannot influence the
      // system prompt region. Cap at 1000 chars to prevent oversized payloads.
      const fencedInput = naturalInput.trim().slice(0, 1000);
      await api.chatSend(
        t("routinePanel.naturalRoutinePrompt", { input: fencedInput }),
        undefined,
        "user-keyboard",
        userIntent,
      );
      onAdded();
      onClose();
    } catch (err) {
      setNaturalError(errorMessage(err) || t("routinePanel.errorNaturalParseFailed"));
    } finally {
      setNaturalParsing(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md" data-testid="add-routine-modal">
        <DialogHeader className="flex flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-base">{t("routinePanel.addRoutineTitle")}</DialogTitle>
          <DialogClose asChild>
            <Button size="sm" variant="ghost" className="-mr-2 h-7 w-7 p-0" aria-label={t("routinePanel.closeAriaLabel")}>✕</Button>
          </DialogClose>
        </DialogHeader>

        {template?.suggestedScope && (
          <p className="mb-3 text-xs text-muted-foreground" data-testid="routine-template-scope-suggestion">
            {t("routinePanel.templateSuggestedScope", { plugins: template.suggestedScope.pluginIds.join(", ") })}
          </p>
        )}

        <Label className="mb-3 space-y-1">
          <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.triggerLabel")}</div>
          <NativeSelect value={trigger} onChange={(event) => { setTrigger(event.target.value as "schedule" | "shutdown"); if (event.target.value === "shutdown") setTab("form"); }}>
            <NativeSelectOption value="schedule">{t("routinePanel.triggerSchedule")}</NativeSelectOption>
            <NativeSelectOption value="shutdown">{t("routinePanel.onShutdown")}</NativeSelectOption>
          </NativeSelect>
        </Label>

        {/* Tab selector for the three routine input styles. */}
        {trigger === "schedule" && <div className="mb-4 flex gap-1 rounded-md border p-1 bg-muted/(--opacity-muted)" role="tablist">
          {(["form", "cron", "natural"] as InputTab[]).map((tabKey) => (
            <button
              key={tabKey}
              type="button"
              role="tab"
              aria-selected={tab === tabKey}
              className={`flex-1 rounded px-3 py-1.5 text-sm transition-colors ${
                tab === tabKey ? "bg-background font-medium shadow-sm" : "text-muted-foreground"
              }`}
              onClick={() => setTab(tabKey)}
            >
              {tabKey === "form" ? t("routinePanel.tabForm") : tabKey === "cron" ? t("routinePanel.tabCron") : t("routinePanel.tabNatural")}
            </button>
          ))}
        </div>}

        {/* Shared: execution mode + title */}
        {tab !== "natural" && (
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.executionModeLabel")}</div>
              <NativeSelect
                className="w-full"
                value={execution}
                onChange={(e) => setExecution(e.target.value as RoutineExecution)}
              >
                <NativeSelectOption value="llm-session">{t("routinePanel.executionLlmSession")}</NativeSelectOption>
                <NativeSelectOption value="notification-only">{t("routinePanel.executionNotificationOnly")}</NativeSelectOption>
              </NativeSelect>
            </Label>
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.titleLabel")}</div>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("routinePanel.titlePlaceholder")} />
            </Label>
          </div>
        )}

        {/* Form tab */}
        {trigger === "schedule" && tab === "form" && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Label className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.dateLabel")}</div>
                <Input type="date" value={atDate} onChange={(e) => setAtDate(e.target.value)} />
              </Label>
              <Label className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.timeLabel")}</div>
                <Input type="time" value={atTime} onChange={(e) => setAtTime(e.target.value)} />
              </Label>
            </div>
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.repeatLabel")}</div>
              <NativeSelect
                className="w-full"
                value={repeatKind}
                onChange={(e) => setRepeatKind(e.target.value as RepeatKind)}
              >
                {REPEAT_OPTIONS.map((o) => (
                  <NativeSelectOption key={o.value} value={o.value}>{t(o.labelKey)}</NativeSelectOption>
                ))}
              </NativeSelect>
            </Label>
            {repeatKind === "interval" && (
              <Label className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.intervalMinutesLabel")}</div>
                <Input
                  type="number"
                  min="1"
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(e.target.value)}
                />
              </Label>
            )}
          </div>
        )}

        {/* Cron tab */}
        {trigger === "schedule" && tab === "cron" && (
          <div className="space-y-3">
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                {t("routinePanel.cronExpressionLabel")}
              </div>
              <Input
                value={cronExpression}
                onChange={(e) => {
                  setCronExpression(e.target.value);
                  setCronError("");
                }}
                placeholder="0 9 * * 1-5"
                data-testid="cron-input"
                aria-invalid={cronError ? "true" : undefined}
              />
              {cronError && (
                <p className="text-sm text-destructive" data-testid="cron-error">{cronError}</p>
              )}
              <div className="text-[11px] text-muted-foreground">
                {t("routinePanel.cronExamplePrefix")} <code>0 9 * * 1-5</code> = {t("routinePanel.cronExample1")} &nbsp;·&nbsp;
                <code>*/30 * * * *</code> = {t("routinePanel.cronExample2")} &nbsp;·&nbsp;
                <code>0 18 * * 5</code> = {t("routinePanel.cronExample3")}
              </div>
            </Label>
          </div>
        )}

        {/* Natural language tab */}
        {trigger === "schedule" && tab === "natural" && (
          <div className="space-y-3">
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                {t("routinePanel.naturalLanguageLabel")}
              </div>
              <Textarea
                value={naturalInput}
                onChange={(e) => setNaturalInput(e.target.value)}
                placeholder={t("routinePanel.naturalLanguagePlaceholder")}
                rows={3}
                data-testid="natural-input"
              />
            </Label>
            <div className="text-[11px] text-muted-foreground">
              {t("routinePanel.naturalLanguageHint")}
            </div>
            {naturalError && (
              <p className="text-sm text-destructive">{naturalError}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={onClose}>{t("routinePanel.cancelButton")}</Button>
              <Button
                size="sm"
                disabled={naturalParsing || !naturalInput.trim()}
                onClick={() => void handleNaturalLanguageParse()}
              >
                {naturalParsing ? t("routinePanel.processingLabel") : t("routinePanel.submitButton")}
              </Button>
            </div>
          </div>
        )}

        {/* LLM session prompt / notification fields */}
        {tab !== "natural" && (
          <div className="mt-3 space-y-3">
            {execution === "llm-session" ? (
              <div className="space-y-3">
                <Label className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.llmPromptLabel")}</div>
                  <Textarea
                    value={prePrompt}
                    onChange={(e) => setPrePrompt(e.target.value)}
                    placeholder={t("routinePanel.llmPromptPlaceholder")}
                    rows={3}
                    data-testid="pre-prompt-input"
                  />
                </Label>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.allowedPluginsLabel")}</div>
                    {allowedPluginIds.length > 0 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => setAllowedPluginIds([])}
                        data-testid="routine-clear-allowed-plugins"
                      >
                        {t("routinePanel.clearPluginsButton")}
                      </Button>
                    )}
                  </div>
                  {pluginScopeError ? (
                    <p className="text-sm text-destructive">{pluginScopeError}</p>
                  ) : pluginCards.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">{t("routinePanel.noPluginsAvailable")}</p>
                  ) : (
                    <div className="grid max-h-32 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
                      {pluginCards.map((plugin) => (
                        <Label
                          key={plugin.id}
                          className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/(--opacity-strong)"
                        >
                          <Checkbox
                            checked={allowedPluginIds.includes(plugin.id)}
                            onCheckedChange={() => toggleAllowedPlugin(plugin.id)}
                            data-testid={`routine-allowed-plugin-${plugin.id}`}
                          />
                          <span className="min-w-0 line-clamp-1">{plugin.name}</span>
                        </Label>
                      ))}
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {t("routinePanel.pluginDenyAllHint")}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Label className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.notificationTitleLabel")}</div>
                  <Input
                    value={notificationTitle}
                    onChange={(e) => setNotificationTitle(e.target.value)}
                    placeholder={t("routinePanel.notificationTitlePlaceholder")}
                  />
                </Label>
                <Label className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.notificationBodyLabel")}</div>
                  <Input
                    value={notificationBody}
                    onChange={(e) => setNotificationBody(e.target.value)}
                    placeholder={t("routinePanel.notificationBodyPlaceholder")}
                  />
                </Label>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={onClose}>{t("routinePanel.cancelButton")}</Button>
              <Button
                size="sm"
                disabled={submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting ? t("routinePanel.submittingLabel") : t("routinePanel.submitButton")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RoutinePanel({ api, onOpenSession }: RoutinePanelProps) {
  const templates = useInstalledContent().routineTemplates;
  const installedTemplateSources = useMemo(() => new Set(templates.map(packageRoutineSource)), [templates]);
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [invalidRoutines, setInvalidRoutines] = useState<InvalidRoutine[]>([]);
  const [routineSessions, setRoutineSessions] = useState<RoutineRunListRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [recentlyFired, setRecentlyFired] = useState<string[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<AgentPluginRoutineTemplate | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (typeof api.listRoutines !== "function") return;
    setLoading(true);
    try {
      const { routines: list, invalid } = await api.listRoutines();
      const sessions = (
        await Promise.all(
          list
            .filter((routine) => routine.execution === "llm-session")
            .map(async (routine) => {
              const records = await api.listRoutineSessions(routine.id, 10);
              // The panel groups runs BY routine, so every row it holds is named by the routine record it was fetched for rather than by
              // whatever title the session happened to persist.
              const routineTitle =
                routine.title ?? routine.notificationTitle ?? routine.prePrompt?.slice(0, 30) ?? routine.id.slice(0, 8);
              return records.map((record) => ({ ...record, routineTitle }));
            }),
        )
      )
        .flat()
        .sort((a, b) => runInstant(b).localeCompare(runInstant(a)))
        .slice(0, 30);
      if (!mountedRef.current) return;
      setRoutines(list);
      setInvalidRoutines(invalid);
      setRoutineSessions(sessions);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    // A skipped occurrence has no fired event; refresh its status while this panel is open.
    const timer = setInterval(() => void refresh(), 30_000);
    const unsub = api.onRoutineFired?.((r) => {
      setRecentlyFired((prev) => (prev.includes(r.id) ? prev : [...prev, r.id]));
      void refresh();
    });
    return () => { clearInterval(timer); unsub?.(); };
  }, [api, refresh]);

  const handleDismiss = useCallback(
    async (id: string) => {
      await api.dismissRoutine(id);
      await refresh();
    },
    [api, refresh],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      await api.removeRoutine(id);
      await refresh();
    },
    [api, refresh],
  );

  const handleTriggerNow = useCallback(
    async (id: string) => {
      const result = await api.triggerRoutineNow(id);
      if (result.ok) setRecentlyFired((prev) => (prev.includes(id) ? prev : [...prev, id]));
      await refresh();
    },
    [api, refresh],
  );

  const llmCount = routines.filter((r) => r.execution === "llm-session").length;
  const totalCapReached = routines.length >= MAX_PERSISTED_ROUTINES;

  // The panel's global controls, drawn by the pane header. The counts they act on stay in the body: a badge reports state,
  // it is not a control.
  usePaneActions(useMemo(() => [
    {
      id: "routine-add",
      label: t("routinePanel.addRoutineButton"),
      icon: <Plus className="h-4 w-4" />,
      disabled: totalCapReached,
      onSelect: () => { setSelectedTemplate(null); setShowAddModal(true); },
    },
    {
      id: "routine-refresh",
      label: t("routinePanel.refreshButton"),
      icon: <RefreshCw className="h-4 w-4" />,
      onSelect: () => void refresh(),
    },
  ], [totalCapReached, refresh]));

  return (
    <>
      <div
        className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden"
        data-testid="routine-panel"
      >
        <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <p className="min-w-0 text-sm text-muted-foreground">{t("routinePanel.panelDescription")}</p>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline" title={t("routinePanel.totalRoutineBadgeTitle")}>
              {routines.length}/{MAX_PERSISTED_ROUTINES}
            </Badge>
            <Badge variant="outline" title={t("routinePanel.llmRoutineBadgeTitle")}>
              LLM {llmCount}/{MAX_LLM_SESSION_ROUTINES}
            </Badge>
            {totalCapReached && (
              <span className="text-xs text-destructive">{t("routinePanel.capReachedLabel")}</span>
            )}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {templates.length > 0 && (
            <section className="rounded-lg border bg-muted/(--opacity-light) p-3" data-testid="routine-template-list">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("routinePanel.pluginTemplatesHeading")}</h3>
              <ScrollArea className="max-h-52">
                <div className="space-y-2">
                  {templates.map((template) => (
                    <div key={packageRoutineSource(template)} className="rounded-md border bg-background p-3" data-testid="routine-template-row">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold">{template.title} <span className="font-normal text-muted-foreground">({template.packageName})</span></div>
                          <p className="text-xs text-muted-foreground">{template.description}</p>
                          <p className="text-xs text-muted-foreground">{describeSchedule(template)}</p>
                        </div>
                        <Button size="sm" variant="outline" disabled={totalCapReached} onClick={() => { setSelectedTemplate(template); setShowAddModal(true); }}>
                          {t("routinePanel.createFromTemplate")}
                        </Button>
                      </div>
                      {template.prePrompt && <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{template.prePrompt}</pre>}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </section>
          )}
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.72fr)]">
            <section className="flex min-h-0 flex-col gap-2 rounded-lg border bg-muted/(--opacity-light) shadow-sm" data-testid="routine-list-section">
              <div className="flex items-center justify-between rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("routinePanel.routineListHeading")}</h3>
                <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
                  {routines.length}
                </span>
              </div>
              <ScrollArea className="min-h-[220px] flex-1 px-2 pb-2">
                {loading ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">{t("routinePanel.loadingLabel")}</div>
                ) : routines.length === 0 && invalidRoutines.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    {t("routinePanel.noRoutinesEmpty")}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {invalidRoutines.map((r) => (
                      <InvalidRoutineRow key={r.id} routine={r} onRemove={(id) => void handleRemove(id)} />
                    ))}
                    {routines.map((r) => (
                      <RoutineRow
                        key={r.id}
                        routine={r}
                        installedTemplateSources={installedTemplateSources}
                        onDismiss={(id) => void handleDismiss(id)}
                        onRemove={(id) => void handleRemove(id)}
                        onTriggerNow={(id) => void handleTriggerNow(id)}
                        recentlyFired={recentlyFired.includes(r.id)}
                      />
                    ))}
                  </div>
                )}
              </ScrollArea>
            </section>

            <section className="flex min-h-0 flex-col gap-2 rounded-lg border bg-muted/(--opacity-light) shadow-sm" data-testid="routine-session-list">
              <div className="flex items-center justify-between rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("routinePanel.sessionListHeading")}</h3>
                <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
                  {routineSessions.length}
                </span>
              </div>
              <ScrollArea className="min-h-[220px] flex-1 px-2 pb-2">
                {loading ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">{t("routinePanel.loadingLabel")}</div>
                ) : routineSessions.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    {t("routinePanel.noSessionsEmpty")}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {routineSessions.map((session) => (
                      <RoutineSessionRow
                        key={session.id}
                        session={session}
                        onOpen={(sessionId) => onOpenSession?.(sessionId)}
                      />
                    ))}
                  </div>
                )}
              </ScrollArea>
            </section>
          </div>
        </div>
      </div>

      {showAddModal && (
        <AddRoutineModal
          key={selectedTemplate ? packageRoutineSource(selectedTemplate) : "manual"}
          api={api}
          template={selectedTemplate ?? undefined}
          onClose={() => { setShowAddModal(false); setSelectedTemplate(null); }}
          onAdded={() => {
            setShowAddModal(false);
            setSelectedTemplate(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}
