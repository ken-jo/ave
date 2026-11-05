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
import { isRecord } from "../../../../shared/is-record.js";
import { formatLocalClock, formatMediumDateTime } from "../../../../shared/format-time.js";
import type { AveApi } from "../../types.js";
import { formatIpcError } from "../../format-ipc-error.js";
import { describeSchedule } from "../RoutinePanel.js";
import { routineTitle } from "./ScheduleItemPopover.js";

/** As long as the panel's: the delete commits when it runs out. */
const CHIP_UNDO_MS = 6_000;
/** As often as the schedule panel re-reads: an item added or changed from the panel has no event of its own. */
const CHIP_REFRESH_MS = 30_000;

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

/** The items connected to `sessionId`, read from the host. Read again on every schedule event, every 30 seconds, and whenever
 * `refreshKey` changes (a turn ended, or the chat came back into view). */
function useConnectedItems(api: ChipApi, sessionId: string | null | undefined, refreshKey: unknown, onRead: () => void) {
  const [items, setItems] = useState<RoutineRecord[]>([]);
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const refresh = useCallback(async () => {
    if (!sessionId) { setItems([]); return; }
    try {
      const list = await api.listRoutines();
      if (!mounted.current) return;
      setItems(list.routines.filter((r) => r.targetSessionId === sessionId && !r.dismissedAt));
      onReadRef.current();
    } catch {
      if (mounted.current) setItems([]);
    }
  }, [api, sessionId]);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);
  useEffect(() => {
    if (!sessionId) return undefined;
    const timer = setInterval(() => void refresh(), CHIP_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, sessionId]);
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
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  // A successful read clears an old error: whatever failed is now shown as it stands.
  const { items, running, refresh } = useConnectedItems(api, sessionId, refreshKey, () => setNotice(""));

  const pendingRef = useRef<string | null>(null);
  pendingRef.current = pendingDelete;
  const commitDelete = useCallback(async (id: string) => {
    const result = await api.removeRoutine(id);
    setPendingDelete((current) => (current === id ? null : current));
    await refresh();
    if (!result.ok) setNotice(result.error ? formatIpcError(result.error, undefined) : t("schedulePanel.errorActionFailed"));
  }, [api, refresh]);
  useEffect(() => {
    if (!pendingDelete) return undefined;
    const timer = setTimeout(() => void commitDelete(pendingDelete), CHIP_UNDO_MS);
    return () => clearTimeout(timer);
  }, [pendingDelete, commitDelete]);
  // The user already chose it: leaving the chat does not bring the item back.
  useEffect(() => () => { if (pendingRef.current) void api.removeRoutine(pendingRef.current); }, [api]);
  // Another chat in this tile: the delete the user chose commits now, and this chat's notice goes with it.
  useEffect(() => {
    const pending = pendingRef.current;
    if (pending) {
      void api.removeRoutine(pending);
      setPendingDelete(null);
    }
    setNotice("");
  }, [api, sessionId]);

  const runAction = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setNotice("");
    const result = await action();
    await refresh();
    if (!result.ok) {
      setNotice(result.error === "paused" ? t("schedulePanel.errorPaused")
        : result.error ? formatIpcError(result.error, undefined) : t("schedulePanel.errorActionFailed"));
    }
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

/** Under a routine_schedule add's tool row (boards 15 and 21): "스케줄 추가됨 · 이 대화에 연결 · 다음 …" with 스케줄에서 보기. A
 * change, a removal and a failed call keep only their tool row. */
export function ScheduleToolResultLine({ name, input, result, failed, onOpenRoutine }: {
  name: string;
  input: unknown;
  result: unknown;
  failed: boolean;
  onOpenRoutine?: (routineId: string) => void;
}) {
  if (name !== "routine_schedule" || failed || typeof result !== "string") return null;
  const action = isRecord(input) ? input.action : undefined;
  if (action !== undefined && action !== "add") return null;
  let value: unknown;
  try { value = JSON.parse(result); } catch { return null; }
  if (!isRecord(value) || typeof value.routineId !== "string") return null;
  const routineId = value.routineId;
  const at = isRecord(value.schedule) && typeof value.schedule.at === "string" ? value.schedule.at : undefined;
  const parts = [
    t("schedulePanel.toolLineAdded"),
    ...(value.connectedToThisChat === true ? [t("schedulePanel.chipConnected")] : []),
    ...(at ? [t("schedulePanel.chipNext", { when: formatMediumDateTime(at) })] : []),
  ];
  return (
    <div className="mx-3 my-1 flex min-w-0 items-center gap-2 rounded-md border border-info/(--opacity-medium) bg-info/(--opacity-subtle) px-2 py-1 text-xs text-info">
      <AlarmClock className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate" data-testid="schedule-tool-line">{parts.join(" · ")}</span>
      {onOpenRoutine ? (
        <button type="button" className="shrink-0 font-medium underline" onClick={() => onOpenRoutine(routineId)}>
          {t("schedulePanel.chipOpenInSchedule")}
        </button>
      ) : null}
    </div>
  );
}
