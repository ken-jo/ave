import { useEffect, useState } from "react";
import { t } from "../../../i18n/runtime.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { ChatLinkField, useProjectChats } from "./schedule/chat-link.js";
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
import { isValidCronExpression } from "../../../routines/cron-evaluator.js";
import { formatMediumDateTime } from "../../../shared/format-time.js";
import { packageRoutineSource, type AgentPluginRoutineTemplate } from "../../../shared/agent-plugin-routine-template.js";

import { errorMessage } from "../../../shared/error-message.js";

export function describeSchedule(routine: Pick<RoutineRecord, "schedule" | "trigger">): string {
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
export function InvalidRoutineRow({ routine, onRemove }: { routine: InvalidRoutine; onRemove: (id: string) => void }) {
  return (
    <div className="rounded-lg border border-destructive/(--opacity-strong) bg-destructive/(--opacity-subtle) p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="invalid-routine-row" data-routine-id={routine.id} tabIndex={-1} role="alert">
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
  /** The slot the user clicked in the schedule grid; prefills date and time. */
  initialAt?: Date;
  /** The project the schedule panel lists the new item under. */
  projectRoot?: string;
}

// Exported for renderer tests — the modal owns the button → scope-payload mapping that we want to lock down (empty
// selection MUST map to `{ mode: "deny-all" }`, not "inherit" / "allow all").
export function AddRoutineModal({ api, onClose, onAdded, template, initialAt: slotAt, projectRoot }: AddRoutineModalProps) {
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
  const initialAt = template?.schedule?.at ? new Date(template.schedule.at) : slotAt ?? null;
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
  // Optional: the chat the item enters when it fires. Only a scheduled turn has a chat to enter.
  const chats = useProjectChats(api, projectRoot);
  const [targetSessionId, setTargetSessionId] = useState("");
  const connects = trigger === "schedule" && execution === "llm-session" && targetSessionId !== "";

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

    const input: Omit<AddRoutineInput, "createdBy"> = {
      projectRoot: projectRoot ?? "",
      trigger,
      execution,
      ...(schedule ? { schedule: schedule as RoutineSchedule } : {}),
      ...(template ? { source: packageRoutineSource(template) } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(connects ? { targetSessionId } : {}),
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

            {trigger === "schedule" && (
              <ChatLinkField value={targetSessionId} onChange={setTargetSessionId} chats={chats} disabled={execution !== "llm-session"} />
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
