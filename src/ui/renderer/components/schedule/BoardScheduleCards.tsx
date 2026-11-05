// Schedule cards drawn inside the work board's columns. They are read-only summaries: editing happens in the schedule panel,
// which a card opens.
import { useState } from "react";
import { AlertCircle, CalendarClock, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { t } from "../../../../i18n/runtime.js";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import { formatLocalClock, formatMediumDateTime } from "../../../../shared/format-time.js";
import type { RoutineRecord } from "../../../../shared/routines-types.js";
import { describeSchedule } from "../RoutinePanel.js";
import { routineTitle } from "./ScheduleItemPopover.js";
import type { PlannedScheduleCard, RunningScheduleCard, BoardScheduleCards } from "./board-schedule.js";

function runsAs(routine: RoutineRecord): string {
  return t(routine.execution === "notification-only" ? "schedulePanel.runsAsNotification" : "schedulePanel.runsInNewChat");
}

/** The repeat rule and how it runs; a one-shot's rule would only repeat its time, so it shows how it runs alone. */
function ruleLine(routine: RoutineRecord): string {
  const repeats = routine.schedule?.repeat !== undefined && routine.schedule.repeat.kind !== "none";
  return repeats ? `${describeSchedule(routine)} · ${runsAs(routine)}` : runsAs(routine);
}

function ScheduleBadge() {
  return (
    <Badge variant="outline" className="shrink-0 gap-1 px-1.5 py-0 text-[10px]">
      <CalendarClock className="h-3 w-3" aria-hidden="true" />
      {t("workBoard.scheduleBadge")}
    </Badge>
  );
}


export function PlannedScheduleCardView({ card, onOpen }: { card: PlannedScheduleCard; onOpen?: (routineId: string) => void }) {
  return (
    <button
      type="button"
      className="w-full rounded-lg border border-dashed border-border bg-background p-3 text-left shadow-sm transition-all hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid={`board-schedule-card-${card.routine.id}`}
      onClick={() => onOpen?.(card.routine.id)}
    >
      <div className="flex items-center gap-1.5">
        <ScheduleBadge />
        <span className="min-w-0 truncate text-sm font-semibold">{routineTitle(card.routine)}</span>
      </div>
      <p className="mt-1 truncate text-xs text-foreground">{t("workBoard.scheduleNextRun", { when: formatMediumDateTime(card.nextAt) })}</p>
      <p className="truncate text-xs text-muted-foreground">{ruleLine(card.routine)}</p>
    </button>
  );
}

export function RunningScheduleCardView({ card, onOpenSession }: { card: RunningScheduleCard; onOpenSession?: (sessionId: string) => void }) {
  const sessionId = card.sessionId;
  return (
    <div className="w-full rounded-lg border-2 border-primary bg-background p-3 shadow-sm" data-testid={`board-schedule-running-${card.routine.id}`}>
      <div className="flex items-center gap-1.5">
        <ScheduleBadge />
        <span className="min-w-0 truncate text-sm font-semibold">{routineTitle(card.routine)}</span>
      </div>
      <p className="mt-1 flex items-center gap-1 text-xs text-foreground">
        <Loader2 className="h-3 w-3 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
        <span className="truncate">{`${t("workBoard.scheduleRunning")} · ${t("workBoard.scheduleStartedAt", { time: formatLocalClock(card.firedAt) })} · ${
          t("workBoard.scheduleElapsed", { minutes: String(Math.max(0, Math.floor((Date.now() - Date.parse(card.firedAt)) / 60_000))) })}`}</span>
      </p>
      <p className="truncate text-xs text-muted-foreground">{ruleLine(card.routine)}</p>
      {sessionId && onOpenSession && (
        <Button type="button" size="sm" variant="outline" className="mt-2 h-7" onClick={() => onOpenSession(sessionId)}>
          {t("schedulePanel.openChat")}
        </Button>
      )}
    </div>
  );
}

export function ScheduleWeekBundle({ week, onOpen }: { week: BoardScheduleCards["week"]; onOpen?: (routineId: string) => void }) {
  const [open, setOpen] = useState(false);
  const failed = week.rows.reduce((sum, row) => sum + row.failed, 0);
  return (
    <div className="w-full rounded-lg border bg-background p-3 shadow-sm" data-testid="board-schedule-week">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        <ScheduleBadge />
        <span className="min-w-0 truncate text-sm font-semibold">{t("workBoard.scheduleWeekRuns", { count: String(week.total) })}</span>
        {failed > 0 && <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label={t("workBoard.scheduleFailedCount", { count: String(failed) })} />}
      </button>
      {open && (
        <ul className="mt-2 space-y-1 text-xs">
          {week.rows.map((row) => (
            <li key={row.routine.id} className="flex items-center gap-2" data-testid={`board-schedule-week-row-${row.routine.id}`}>
              <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => onOpen?.(row.routine.id)}>
                {routineTitle(row.routine)}
              </button>
              <span className="shrink-0 tabular-nums text-muted-foreground">{t("workBoard.scheduleRunCount", { count: String(row.count) })}</span>
              {row.failed > 0 && (
                <span className="shrink-0 text-destructive">{t("workBoard.scheduleFailedCount", { count: String(row.failed) })}</span>
              )}
            </li>
          ))}
          {week.skipped.map((routine) => (
            <li key={`skipped:${routine.id}`} className="flex flex-col gap-0.5" data-testid={`board-schedule-week-skipped-${routine.id}`}>
              <span className="flex items-center gap-2">
                <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => onOpen?.(routine.id)}>
                  {routineTitle(routine)}
                </button>
                <span className="shrink-0 text-warning">{t("workBoard.scheduleSkipped")}</span>
              </span>
              <span className="truncate text-muted-foreground">
                {t("routinePanel.pluginsMissing", { plugins: routine.needsAttention?.missingPluginIds.join(", ") ?? "" })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
