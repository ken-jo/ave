// The chat header chip for the schedule items connected to this chat (routine case 15). Every action is the user's own and applies
// at once; 삭제 is undone from the chip's own notice, not confirmed.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AlarmClock, AlertCircle, CalendarDays, ChevronDown, Pause, Pencil, Play, Trash2, Unlink } from "lucide-react";
import { t } from "../../../../i18n/runtime.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../../components/ui/dropdown-menu.js";
import type { RoutineRecord } from "../../../../shared/routines-types.js";
import { formatLocalClock, formatMediumDateTime } from "../../../../shared/format-time.js";
import type { AveApi } from "../../types.js";
import { formatIpcError } from "../../format-ipc-error.js";
import { describeSchedule } from "../RoutinePanel.js";
import { routineTitle } from "./ScheduleItemPopover.js";

/** As long as the panel's: the delete commits when it runs out. */
const CHIP_UNDO_MS = 6_000;

type ChipApi = Pick<AveApi,
  | "listRoutines" | "pauseRoutine" | "resumeRoutine" | "triggerRoutineNow" | "updateRoutine" | "removeRoutine"
  | "onRoutineFired" | "onRoutineRunningStarted" | "onRoutineRunningFinished" | "onRoutineFailed">;

/** "매일 09:00": the item's repeat and time, short enough for a header chip. */
function chipSchedule(routine: Pick<RoutineRecord, "schedule" | "trigger">): string {
  const s = routine.schedule;
  if (s?.repeat?.kind === "cron") return t("schedulePanel.chipCron");
  if (!s?.at) return describeSchedule(routine);
  const time = formatLocalClock(s.at);
  const at = new Date(s.at);
  switch (s.repeat?.kind) {
    case "daily": return t("schedulePanel.chipDaily", { time });
    case "weekly": return t("schedulePanel.chipWeekly", { weekday: t(`schedulePanel.weekday${at.getDay()}`), time });
    case "monthly": return t("schedulePanel.chipMonthly", { day: String(at.getDate()), time });
    case "interval": return t("schedulePanel.chipInterval", { mins: String(Math.round(s.repeat.intervalMs / 60_000)) });
    default: return t("schedulePanel.chipOnce", { date: `${at.getMonth() + 1}/${at.getDate()}`, time });
  }
}

const failed = (r: RoutineRecord) => Boolean(r.lastFailure && !r.lastFailure.acknowledgedAt);

/** The items connected to `sessionId`, read from the host. Read again on every schedule event and whenever `refreshKey` changes
 * (a turn ended: the agent may have added one). */
function useConnectedItems(api: ChipApi, sessionId: string | null | undefined, refreshKey: unknown) {
  const [items, setItems] = useState<RoutineRecord[]>([]);
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const refresh = useCallback(async () => {
    if (!sessionId) { setItems([]); return; }
    try {
      const list = await api.listRoutines();
      if (mounted.current) setItems(list.routines.filter((r) => r.targetSessionId === sessionId && !r.dismissedAt));
    } catch {
      if (mounted.current) setItems([]);
    }
  }, [api, sessionId]);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);
  useEffect(() => {
    const unsubs = [
      api.onRoutineFired?.(() => void refresh()),
      api.onRoutineFailed?.(() => void refresh()),
      api.onRoutineRunningStarted?.(({ routineId }) => { setRunning((prev) => new Set(prev).add(routineId)); void refresh(); }),
      api.onRoutineRunningFinished?.((routineId) => {
        setRunning((prev) => { const next = new Set(prev); next.delete(routineId); return next; });
        void refresh();
      }),
    ];
    return () => { for (const off of unsubs) off?.(); };
  }, [api, refresh]);
  return { items, running, refresh };
}

export function ScheduleChatChip({ api, sessionId, refreshKey, onOpenRoutine }: {
  api: ChipApi;
  sessionId: string | null | undefined;
  refreshKey?: unknown;
  /** Open the schedule panel on this item: 스케줄에서 보기, and 시각·프롬프트 편집 in its popover. */
  onOpenRoutine: (routineId: string) => void;
}) {
  const { items, running, refresh } = useConnectedItems(api, sessionId, refreshKey);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const pendingRef = useRef<string | null>(null);
  pendingRef.current = pendingDelete;
  const commitDelete = useCallback(async (id: string) => {
    const result = await api.removeRoutine(id);
    setPendingDelete((current) => (current === id ? null : current));
    if (!result.ok) setNotice(result.error ? formatIpcError(result.error, undefined) : t("schedulePanel.errorActionFailed"));
    void refresh();
  }, [api, refresh]);
  useEffect(() => {
    if (!pendingDelete) return undefined;
    const timer = setTimeout(() => void commitDelete(pendingDelete), CHIP_UNDO_MS);
    return () => clearTimeout(timer);
  }, [pendingDelete, commitDelete]);
  // The user already chose it: leaving the chat does not bring the item back.
  useEffect(() => () => { if (pendingRef.current) void api.removeRoutine(pendingRef.current); }, [api]);

  const runAction = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setNotice("");
    const result = await action();
    if (!result.ok) {
      setNotice(result.error === "paused" ? t("schedulePanel.errorPaused")
        : result.error ? formatIpcError(result.error, undefined) : t("schedulePanel.errorActionFailed"));
    }
    void refresh();
  };
  const startDelete = (id: string) => {
    if (pendingDelete && pendingDelete !== id) void commitDelete(pendingDelete);
    setPendingDelete(id);
  };

  const shown = items.filter((r) => r.id !== pendingDelete);
  const undo = pendingDelete ? (
    <span role="status" className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground" data-testid="schedule-chip-undo">
      {t("schedulePanel.deleted")}
      <button type="button" className="font-semibold text-foreground underline" onClick={() => setPendingDelete(null)}>{t("schedulePanel.undo")}</button>
    </span>
  ) : null;
  const noticeRow = notice ? (
    <span role="alert" className="max-w-56 shrink truncate text-xs text-destructive" title={notice} data-testid="schedule-chip-notice">{notice}</span>
  ) : null;
  if (shown.length === 0) return undo || noticeRow ? <>{undo}{noticeRow}</> : null;

  const one = shown.length === 1 ? shown[0] : null;
  const anyRunning = shown.some((r) => running.has(r.id));
  const anyFailed = shown.some(failed);
  const allPaused = shown.every((r) => r.pausedAt);
  const label = anyRunning ? t("schedulePanel.chipRunning")
    : anyFailed ? t("schedulePanel.chipFailed")
    : allPaused ? t("schedulePanel.chipPaused")
    : one ? t("schedulePanel.chip", { when: chipSchedule(one) })
    : t("schedulePanel.chipCount", { count: String(shown.length) });
  const tone = anyFailed && !anyRunning ? "border-destructive/(--opacity-strong) text-destructive"
    : allPaused && !anyRunning ? "border-border text-muted-foreground"
    : "border-info/(--opacity-medium) bg-info/(--opacity-subtle) text-info";
  const Icon = anyFailed && !anyRunning ? AlertCircle : allPaused && !anyRunning ? Pause : AlarmClock;

  return (
    <>
      <DropdownMenu onOpenChange={(open) => { if (open) void refresh(); }}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium ${tone}`}
            aria-label={t("schedulePanel.chipAriaLabel", { label })}
            data-testid="schedule-chat-chip"
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            <span className="truncate">{label}</span>
            <ChevronDown className="h-3 w-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80" data-testid="schedule-chat-chip-menu">
          {shown.map((routine, index) => (
            <Fragment key={routine.id}>
              {index > 0 && <DropdownMenuSeparator />}
              <div className="space-y-0.5 px-2 py-1.5">
                <div className="flex items-center gap-1 text-sm font-semibold text-info">
                  <AlarmClock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{routineTitle(routine)} · {chipSchedule(routine)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {routine.pausedAt ? t("schedulePanel.nextRunPaused")
                    : routine.schedule?.at ? t("schedulePanel.chipNext", { when: formatMediumDateTime(routine.schedule.at) })
                    : describeSchedule(routine)}
                  {" · "}{t("schedulePanel.chipConnected")}
                </p>
                {routine.prePrompt ? <p className="line-clamp-2 text-xs text-foreground">{routine.prePrompt}</p> : null}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onOpenRoutine(routine.id)}>
                <CalendarDays className="mr-2 h-4 w-4" aria-hidden />{t("schedulePanel.chipOpenInSchedule")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runAction(() => api.triggerRoutineNow(routine.id))}>
                <Play className="mr-2 h-4 w-4" aria-hidden />
                <span className="flex flex-col"><span>{t("schedulePanel.chipRunNow")}</span><span className="text-xs text-muted-foreground">{t("schedulePanel.chipRunNowHint")}</span></span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runAction(() => routine.pausedAt ? api.resumeRoutine(routine.id) : api.pauseRoutine(routine.id))}>
                {routine.pausedAt ? <Play className="mr-2 h-4 w-4" aria-hidden /> : <Pause className="mr-2 h-4 w-4" aria-hidden />}
                {t(routine.pausedAt ? "schedulePanel.resume" : "schedulePanel.pause")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOpenRoutine(routine.id)}>
                <Pencil className="mr-2 h-4 w-4" aria-hidden />{t("schedulePanel.chipEdit")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runAction(() => api.updateRoutine(routine.id, { targetSessionId: null }))}>
                <Unlink className="mr-2 h-4 w-4" aria-hidden />
                <span className="flex flex-col"><span>{t("schedulePanel.chipUnlink")}</span><span className="text-xs text-muted-foreground">{t("schedulePanel.chipUnlinkHint")}</span></span>
              </DropdownMenuItem>
              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => startDelete(routine.id)}>
                <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                <span className="flex flex-col"><span>{t("schedulePanel.chipDelete")}</span><span className="text-xs text-muted-foreground">{t("schedulePanel.chipDeleteHint")}</span></span>
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {undo}
      {noticeRow}
    </>
  );
}
