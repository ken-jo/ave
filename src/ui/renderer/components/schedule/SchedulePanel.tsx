// The schedule panel: one project's schedule items as a day, week or month grid. Chips are projected occurrences and past
// runs from ROUTINES.listOccurrences; clicking an empty slot adds an item there, clicking a chip opens its popover.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, Pause, Plus, RefreshCw, Repeat2 } from "lucide-react";
import { t } from "../../../../i18n/runtime.js";
import { Button } from "../../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../../components/ui/popover.js";
import type { AveApi } from "../../types.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";
import type {
  InvalidRoutine,
  RoutineEditPatch,
  RoutineOccurrence,
  RoutineRecord,
  RoutineRun,
} from "../../../../shared/routines-types.js";
import { MAX_PERSISTED_ROUTINES } from "../../../../shared/routines-types.js";
import { packageRoutineSource, type AgentPluginRoutineTemplate } from "../../../../shared/agent-plugin-routine-template.js";
import { useInstalledContent } from "../../installed-content.js";
import { useContainerNarrow } from "../../hooks/use-container-narrow.js";
import { usePaneActions } from "../PaneFrame.js";
import { AddRoutineModal, InvalidRoutineRow } from "../RoutinePanel.js";
import { ScheduleItemPopover, routineTitle } from "./ScheduleItemPopover.js";
import { layoutDayChips, sameDay, scheduleRange, shiftAnchor, type ScheduleViewMode } from "./schedule-layout.js";

const PX_PER_HOUR = 48;
const CHIP_PX = 22;
const TWO_LINE_PX = 40;
const MONTH_LINES = 3;
const VIEW_MODES = ["day", "week", "month"] as const satisfies readonly ScheduleViewMode[];
/** A deleted item stays restorable this long; the delete itself is the user's action and is never confirmed. */
const SCHEDULE_UNDO_MS = 6_000;
/** Below this pane width the week shows three days and the add button its short name. */
const NARROW_ENTER = 760;
const NARROW_EXIT = 820;

type EntryStatus = "scheduled" | "paused" | "missed" | "done" | "failed" | "running";

interface ScheduleEntry {
  key: string;
  routine: RoutineRecord;
  atMs: number;
  status: EntryStatus;
  sessionId?: string;
}

export interface SchedulePanelProps {
  api: AveApi;
  project?: ProjectIdentity;
  onOpenSession?: (sessionId: string) => void;
  /** An item another surface (확인 필요) asked to show: focused once the panel has loaded, then reported consumed. */
  focusRoutineId?: string | null;
  onFocusConsumed?: () => void;
  /** Tests pin the clock; the panel otherwise reads it once per render pass. */
  now?: () => Date;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function gmtLabel(d: Date): string {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `GMT${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ""}`;
}

function weekdayLabel(d: Date): string {
  return t(`schedulePanel.weekday${d.getDay()}`);
}

function rangeLabel(mode: ScheduleViewMode, days: readonly Date[], anchor: Date): string {
  const first = days[0]!;
  const last = days[days.length - 1]!;
  if (mode === "day") return t("schedulePanel.dayTitle", { month: String(first.getMonth() + 1), day: String(first.getDate()), weekday: weekdayLabel(first) });
  if (mode === "month") return t("schedulePanel.monthTitle", { year: String(anchor.getFullYear()), month: String(anchor.getMonth() + 1) });
  return t("schedulePanel.weekTitle", {
    fromMonth: String(first.getMonth() + 1), fromDay: String(first.getDate()), fromWeekday: weekdayLabel(first),
    toMonth: String(last.getMonth() + 1), toDay: String(last.getDate()), toWeekday: weekdayLabel(last),
  });
}

function statusClass(status: EntryStatus): string {
  switch (status) {
    case "done": return "border-foreground bg-foreground text-background";
    case "failed": return "border-destructive bg-destructive/(--opacity-subtle) text-destructive";
    case "running": return "border-2 border-primary bg-background text-foreground";
    case "paused": return "border-dashed border-muted-foreground bg-muted text-muted-foreground";
    case "missed": return "border-dotted border-warning bg-background text-warning";
    default: return "border-dashed border-border bg-background text-foreground";
  }
}

function StatusIcon({ status }: { status: EntryStatus }) {
  if (status === "running") return <Loader2 className="h-3 w-3 shrink-0 motion-safe:animate-spin" aria-hidden="true" />;
  if (status === "paused") return <Pause className="h-3 w-3 shrink-0" aria-hidden="true" />;
  if (status === "failed" || status === "missed") return <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />;
  return <Repeat2 className="h-3 w-3 shrink-0" aria-hidden="true" />;
}

function templateNoteFor(routine: RoutineRecord, installed: ReadonlySet<string>): { templateNote?: string } {
  const source = routine.source;
  if (!source || !(source.startsWith("agent-plugin:") || source.startsWith("extension:"))) return {};
  if (!installed.has(source)) return { templateNote: t("routinePanel.templateNoLongerInstalled") };
  return {
    templateNote: t(source.startsWith("extension:") ? "routinePanel.createdFromExtensionTemplate" : "routinePanel.createdFromPluginTemplate",
      { plugin: source.split(":")[1]! }),
  };
}

export function SchedulePanel({ api, project, onOpenSession, focusRoutineId, onFocusConsumed, now: nowFn }: SchedulePanelProps) {
  const now = useCallback(() => (nowFn ? nowFn() : new Date()), [nowFn]);
  const projectRoot = project?.projectRoot;
  const templates = useInstalledContent().routineTemplates;
  const installedTemplateSources = useMemo(() => new Set(templates.map(packageRoutineSource)), [templates]);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const { isNarrow: narrow } = useContainerNarrow(container, { enter: NARROW_ENTER, exit: NARROW_EXIT });
  const [mode, setMode] = useState<ScheduleViewMode>("week");
  const [anchor, setAnchor] = useState(() => now());
  const [records, setRecords] = useState<RoutineRecord[]>([]);
  const [invalid, setInvalid] = useState<InvalidRoutine[]>([]);
  const [occurrences, setOccurrences] = useState<RoutineOccurrence[]>([]);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState<Map<string, string>>(() => new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [dayPopover, setDayPopover] = useState<number | null>(null);
  const [morePopover, setMorePopover] = useState<string | null>(null);
  const tabIds = useId();
  const tabRefs = useRef<Partial<Record<ScheduleViewMode, HTMLButtonElement | null>>>({});
  const onTabKey = (e: React.KeyboardEvent) => {
    const index = VIEW_MODES.indexOf(mode);
    const target = e.key === "ArrowRight" ? VIEW_MODES[(index + 1) % VIEW_MODES.length]
      : e.key === "ArrowLeft" ? VIEW_MODES[(index + VIEW_MODES.length - 1) % VIEW_MODES.length]
        : e.key === "Home" ? VIEW_MODES[0]
          : e.key === "End" ? VIEW_MODES[VIEW_MODES.length - 1]
            : undefined;
    if (!target) return;
    e.preventDefault();
    setMode(target);
    tabRefs.current[target]?.focus();
  };
  const [create, setCreate] = useState<{ at?: Date; template?: AgentPluginRoutineTemplate } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const range = useMemo(() => scheduleRange(mode, anchor, narrow), [mode, anchor, narrow]);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const refresh = useCallback(async () => {
    const filter = projectRoot ? { projectRoot } : undefined;
    const [list, occ] = await Promise.all([
      api.listRoutines(filter),
      api.listRoutineOccurrences({ ...filter, from: range.from.toISOString(), to: range.to.toISOString() }),
    ]);
    if (!mounted.current) return;
    setRecords(list.routines);
    setInvalid(list.invalid);
    if (occ.ok) {
      setOccurrences(occ.occurrences);
      setRuns(occ.runs);
    }
    setLoaded(true);
  }, [api, projectRoot, range]);

  useEffect(() => {
    void refresh();
    // A skipped occurrence has no fired event; refresh while the panel is open.
    const timer = setInterval(() => void refresh(), 30_000);
    const unsubs = [
      api.onRoutineFired?.(() => void refresh()),
      api.onRoutineRunningStarted?.(({ routineId, firedAt }) => {
        setRunning((prev) => new Map(prev).set(routineId, firedAt));
        void refresh();
      }),
      api.onRoutineRunningFinished?.((routineId) => {
        setRunning((prev) => { const next = new Map(prev); next.delete(routineId); return next; });
        void refresh();
      }),
      api.onRoutineFailed?.(({ routineId }) => {
        setRunning((prev) => { const next = new Map(prev); next.delete(routineId); return next; });
        void refresh();
      }),
    ];
    return () => { clearInterval(timer); for (const unsub of unsubs) unsub?.(); };
  }, [api, refresh]);

  // The delete commits when its undo window closes, and when the panel goes away: the user already chose it.
  const pendingRef = useRef<string | null>(null);
  pendingRef.current = pendingDelete;
  const commitDelete = useCallback(async (id: string) => {
    await api.removeRoutine(id);
    if (mounted.current) {
      setPendingDelete((current) => (current === id ? null : current));
      void refresh();
    }
  }, [api, refresh]);
  useEffect(() => {
    if (!pendingDelete) return undefined;
    const timer = setTimeout(() => void commitDelete(pendingDelete), SCHEDULE_UNDO_MS);
    return () => clearTimeout(timer);
  }, [pendingDelete, commitDelete]);
  useEffect(() => () => { if (pendingRef.current) void api.removeRoutine(pendingRef.current); }, [api]);
  const startDelete = (id: string) => {
    if (pendingDelete && pendingDelete !== id) void commitDelete(pendingDelete);
    setSelected(null);
    setPendingDelete(id);
  };

  const byId = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);
  const visible = useCallback((id: string) => id !== pendingDelete && byId.has(id), [pendingDelete, byId]);
  const entries = useMemo<ScheduleEntry[]>(() => {
    const out: ScheduleEntry[] = [];
    for (const run of runs) {
      if (!visible(run.routineId)) continue;
      const isRunning = running.get(run.routineId) === run.firedAt;
      out.push({ key: `run:${run.routineId}:${run.firedAt}`, routine: byId.get(run.routineId)!, atMs: Date.parse(run.firedAt),
        status: isRunning ? "running" : run.status, ...(run.sessionId ? { sessionId: run.sessionId } : {}) });
    }
    for (const [routineId, firedAt] of running) {
      if (!visible(routineId) || runs.some((r) => r.routineId === routineId && r.firedAt === firedAt)) continue;
      out.push({ key: `run:${routineId}:${firedAt}`, routine: byId.get(routineId)!, atMs: Date.parse(firedAt), status: "running" });
    }
    for (const occ of occurrences) {
      if (!visible(occ.routineId)) continue;
      out.push({ key: `occ:${occ.routineId}:${occ.at}`, routine: byId.get(occ.routineId)!, atMs: Date.parse(occ.at), status: occ.status });
    }
    return out.sort((a, b) => a.atMs - b.atMs);
  }, [runs, occurrences, running, byId, visible]);
  const scheduledEntries = entries.filter((e) => e.routine.trigger === "schedule");
  // Show the requested item once loaded: open its popover from its chip in view, or focus its attention row when no chip is
  // drawn. A request for an item that is gone or outside the range is still consumed.
  useEffect(() => {
    if (!focusRoutineId || !loaded || !container) return;
    const selector = `[data-testid="schedule-chip"][data-routine-id="${CSS.escape(focusRoutineId)}"]`;
    const chipEl = container.querySelector<HTMLElement>(selector);
    const target = chipEl ?? container.querySelector<HTMLElement>(`[data-routine-id="${CSS.escape(focusRoutineId)}"]`);
    target?.scrollIntoView?.({ block: "nearest" });
    target?.focus();
    const key = chipEl?.getAttribute("data-selection-key");
    if (key) setSelected(key);
    onFocusConsumed?.();
  }, [focusRoutineId, loaded, container, onFocusConsumed]);

  const shutdownRecords = records.filter((r) => r.trigger === "shutdown" && visible(r.id));
  const visibleCount = records.filter((r) => visible(r.id)).length;
  const capReached = records.length >= MAX_PERSISTED_ROUTINES;

  const runAction = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    const result = await action();
    if (!result.ok) setNotice(result.error === "paused" ? t("schedulePanel.errorPaused") : result.error ?? t("schedulePanel.errorActionFailed"));
    void refresh();
  };

  usePaneActions(useMemo(() => [
    {
      id: "schedule-add",
      label: narrow ? t("schedulePanel.addShort") : t("schedulePanel.add"),
      icon: <Plus className="h-4 w-4" />,
      disabled: capReached,
      onSelect: () => setCreate({}),
      ...(templates.length > 0 ? {
        items: [
          { id: "manual", label: t("schedulePanel.addManual"), onSelect: () => setCreate({}) },
          ...templates.map((template) => ({
            id: packageRoutineSource(template),
            label: t("schedulePanel.addFromTemplate", { title: template.title, source: template.packageName }),
            onSelect: () => setCreate({ template }),
          })),
        ],
      } : {}),
    },
    { id: "schedule-refresh", label: t("routinePanel.refreshButton"), icon: <RefreshCw className="h-4 w-4" />, onSelect: () => void refresh() },
  ], [narrow, capReached, templates, refresh]));

  const popoverFor = (entry: ScheduleEntry): ReactNode => {
    const routineRuns = runs.filter((r) => r.routineId === entry.routine.id).sort((a, b) => b.firedAt.localeCompare(a.firedAt));
    const nextAt = occurrences.find((o) => o.routineId === entry.routine.id && o.status !== "missed")?.at;
    return (
      <ScheduleItemPopover
        key={entry.routine.id}
        routine={entry.routine}
        nextAt={nextAt}
        recentRuns={routineRuns}
        running={running.has(entry.routine.id)}
        missed={occurrences.some((o) => o.routineId === entry.routine.id && o.status === "missed")}
        {...templateNoteFor(entry.routine, installedTemplateSources)}
        onClose={() => setSelected(null)}
        onSave={async (patch: RoutineEditPatch) => {
          const result = await api.updateRoutine(entry.routine.id, patch);
          if (!result.ok) return result.error;
          setSelected(null);
          void refresh();
          return null;
        }}
        onPause={() => void runAction(() => api.pauseRoutine(entry.routine.id))}
        onResume={() => void runAction(() => api.resumeRoutine(entry.routine.id))}
        onRunNow={() => void runAction(() => api.triggerRoutineNow(entry.routine.id))}
        onDelete={() => startDelete(entry.routine.id)}
        {...(onOpenSession ? { onOpenSession } : {})}
      />
    );
  };

  // The same entry can be drawn on two surfaces at once (a month cell and its day popover, the grid and the day list), so a
  // selection names its surface too: only the trigger that was used opens.
  const withPopover = (entry: ScheduleEntry, surface: string, trigger: ReactElement) => {
    const key = `${surface}|${entry.key}`;
    return (
      <Popover key={key} open={selected === key} onOpenChange={(open) => setSelected(open ? key : null)}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        {/* React events bubble through the portal to the day column, whose click adds an item at that slot. */}
        <PopoverContent className="w-[min(360px,calc(100vw-32px))]" align="start" collisionPadding={16} onClick={(e) => e.stopPropagation()}>
          {popoverFor(entry)}
        </PopoverContent>
      </Popover>
    );
  };

  const chipLabel = (entry: ScheduleEntry) => t("schedulePanel.chipLabel", {
    time: entry.routine.trigger === "shutdown" ? t("schedulePanel.onShutdownRow") : hhmm(entry.atMs),
    title: routineTitle(entry.routine),
    status: t(`schedulePanel.status_${entry.status}`),
  });

  const chip = (entry: ScheduleEntry, surface: string, style: React.CSSProperties | undefined, twoLine: boolean, extraClass = "") =>
    withPopover(entry, surface, (
      <button
        type="button"
        data-testid="schedule-chip"
        data-status={entry.status}
        data-routine-id={entry.routine.id}
        data-selection-key={`${surface}|${entry.key}`}
        aria-label={chipLabel(entry)}
        style={style}
        onClick={(e) => e.stopPropagation()}
        className={`flex min-w-0 overflow-hidden rounded border px-1.5 text-left text-[11px] leading-tight ${statusClass(entry.status)} ${twoLine ? "flex-col justify-center gap-0.5" : "items-center gap-1"} ${extraClass}`}
      >
        <span className="flex min-w-0 items-center gap-1">
          <StatusIcon status={entry.status} />
          <span className="shrink-0 tabular-nums">{hhmm(entry.atMs)}</span>
          {!twoLine && <span className="min-w-0 truncate font-semibold">{routineTitle(entry.routine)}</span>}
        </span>
        {twoLine && <span className="min-w-0 truncate font-semibold">{routineTitle(entry.routine)}</span>}
      </button>
    ));

  const slotClick = (day: Date) => (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = Math.floor(((e.clientY - rect.top) / PX_PER_HOUR) * 2) * 30;
    setCreate({ at: new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60) });
  };

  // Day and week: the hour grid. Starts scrolled to 08:00, where the boards open.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scrollRef.current && mode !== "month") scrollRef.current.scrollTop = 8 * PX_PER_HOUR - 8;
  }, [mode]);
  const today = now();
  const timeGrid = (days: readonly Date[]) => (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="grid border-b text-xs" style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}>
        <div className="py-2 text-center text-[10px] text-muted-foreground">{gmtLabel(today)}</div>
        {days.map((d) => {
          const count = scheduledEntries.filter((e) => sameDay(new Date(e.atMs), d)).length;
          const isToday = sameDay(d, today);
          return (
            <div key={d.toISOString()} className={`truncate border-l py-2 text-center ${isToday ? "bg-muted font-semibold" : ""}`} data-testid="schedule-day-header">
              {weekdayLabel(d)} {d.getDate()}{isToday ? ` · ${t("schedulePanel.today")}` : ""}
              <span className="ml-1 text-muted-foreground">{t("schedulePanel.dayCount", { count: String(count) })}</span>
            </div>
          );
        })}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="relative grid" style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))`, height: 24 * PX_PER_HOUR }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute right-2 text-[10px] tabular-nums text-muted-foreground" style={{ top: h * PX_PER_HOUR - 6 }}>
                {h > 0 ? `${pad(h)}:00` : ""}
              </div>
            ))}
          </div>
          {days.map((day) => {
            const dayStart = day.getTime();
            const dayEntries = scheduledEntries.filter((e) => sameDay(new Date(e.atMs), day));
            const { chips, overflow } = layoutDayChips(dayEntries.map((e) => ({ key: e.key, startMs: e.atMs })),
              // A week column holds two side-by-side chips readably; the single day column holds three.
              { dayStartMs: dayStart, pxPerHour: PX_PER_HOUR, chipPx: CHIP_PX, maxLanes: days.length === 1 ? 3 : 2 });
            const entryByKey = new Map(dayEntries.map((e) => [e.key, e]));
            const isToday = sameDay(day, today);
            return (
              <div
                key={day.toISOString()}
                className={`relative cursor-pointer border-l ${isToday ? "bg-muted/(--opacity-light)" : ""}`}
                style={{ backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${PX_PER_HOUR - 1}px, var(--border) ${PX_PER_HOUR - 1}px, var(--border) ${PX_PER_HOUR}px)` }}
                onClick={slotClick(day)}
                data-testid="schedule-day-column"
                title={t("schedulePanel.slotHint")}
              >
                {isToday && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 h-px bg-destructive" data-testid="schedule-now-line"
                    style={{ top: ((today.getTime() - dayStart) / 3_600_000) * PX_PER_HOUR }} />
                )}
                {/* The slot click is a pointer shortcut; keyboard users add through this button, shown when focused. */}
                <button
                  type="button"
                  className="pointer-events-none absolute left-1 top-1 z-20 rounded border bg-background px-2 py-1 text-xs opacity-0 shadow-sm focus:pointer-events-auto focus:opacity-100"
                  onClick={(e) => { e.stopPropagation(); setCreate({ at: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9) }); }}
                  data-testid="schedule-day-add"
                >
                  {t("schedulePanel.addOnDay")}
                </button>
                {chips.map((c) => chip(entryByKey.get(c.key)!, "grid", {
                  position: "absolute",
                  top: c.top + 1,
                  height: c.twoLine ? TWO_LINE_PX : CHIP_PX,
                  left: `calc(${(c.lane / c.lanes) * 100}% + 2px)`,
                  width: `calc(${100 / c.lanes}% - 4px)`,
                }, c.twoLine))}
                {overflow.map((o) => (
                  // The hidden entries open from here in every layout, including the narrow day view that has no side list.
                  <Popover key={o.top} open={morePopover === `${day.getTime()}:${o.top}`}
                    onOpenChange={(open) => setMorePopover(open ? `${day.getTime()}:${o.top}` : null)}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="absolute right-0.5 z-10 rounded border bg-background px-1 text-[10px] font-semibold shadow-sm"
                        style={{ top: o.top + CHIP_PX + 2 }}
                        onClick={(e) => e.stopPropagation()}
                        data-testid="schedule-more"
                      >
                        {t("schedulePanel.more", { count: String(o.keys.length) })}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64" align="end" collisionPadding={16} onClick={(e) => e.stopPropagation()}>
                      <div className="mb-2 text-xs font-semibold">{t("schedulePanel.hiddenItems", { count: String(o.keys.length) })}</div>
                      <div className="flex flex-col gap-1" data-testid="schedule-more-list">
                        {o.keys.map((key) => chip(entryByKey.get(key)!, "more", { height: CHIP_PX }, false))}
                      </div>
                      {days.length > 1 && (
                        <Button size="sm" variant="outline" className="mt-2" onClick={() => { setMorePopover(null); setMode("day"); setAnchor(day); }}>
                          {t("schedulePanel.openDay")}
                        </Button>
                      )}
                    </PopoverContent>
                  </Popover>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {shutdownRecords.length > 0 && (
        <div className="grid border-t text-[11px]" style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }} data-testid="schedule-shutdown-row">
          <div className="py-1.5 text-center text-[10px] text-muted-foreground">{t("schedulePanel.onShutdownRow")}</div>
          {days.map((day) => {
            const ran = entries.filter((e) => e.routine.trigger === "shutdown" && sameDay(new Date(e.atMs), day));
            const pendingToday = sameDay(day, today)
              ? shutdownRecords.filter((r) => !r.pausedAt && !ran.some((e) => e.routine.id === r.id))
              : [];
            return (
              <div key={day.toISOString()} className="flex min-w-0 flex-col gap-0.5 border-l p-0.5">
                {ran.map((e) => chip(e, "shutdown", { height: CHIP_PX }, false))}
                {pendingToday.map((r) => chip({ key: `shutdown:${r.id}`, routine: r, atMs: today.getTime(), status: "scheduled" }, "shutdown", { height: CHIP_PX }, false))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const dayList = (day: Date) => {
    const list = entries.filter((e) => sameDay(new Date(e.atMs), day));
    return (
      <aside className="flex w-72 shrink-0 flex-col border-l" data-testid="schedule-day-list">
        <div className="border-b px-3 py-2 text-xs font-semibold">{t("schedulePanel.dayListTitle", { count: String(list.length) })}</div>
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 text-xs">
          {list.map((e) => (
            <li key={e.key}>
              {withPopover(e, "list", (
              <button type="button" className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-muted" aria-label={chipLabel(e)}
                data-testid="schedule-day-list-row">
                <span className="w-10 shrink-0 tabular-nums">{e.routine.trigger === "shutdown" ? t("schedulePanel.onShutdownRow") : hhmm(e.atMs)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{routineTitle(e.routine)}</span>
                  <span className="block truncate text-muted-foreground">
                    {e.routine.execution === "notification-only" ? t("schedulePanel.runsAsNotification") : t("schedulePanel.runsInNewChat")}
                  </span>
                </span>
              </button>
              ))}
            </li>
          ))}
        </ul>
      </aside>
    );
  };

  const monthGrid = (days: readonly Date[]) => (
    <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[auto_repeat(6,minmax(0,1fr))] overflow-hidden text-[11px]" data-testid="schedule-month">
      {days.slice(0, 7).map((d) => (
        <div key={`h${d.getDay()}`} className="border-b py-1.5 text-center text-xs text-muted-foreground">{weekdayLabel(d)}</div>
      ))}
      {days.map((d, index) => {
        const list = scheduledEntries.filter((e) => sameDay(new Date(e.atMs), d));
        const inMonth = d.getMonth() === anchor.getMonth();
        return (
          <div key={d.toISOString()} className={`relative flex min-w-0 flex-col gap-0.5 overflow-hidden border-b border-l p-1 ${inMonth ? "" : "text-muted-foreground"} ${sameDay(d, today) ? "bg-muted/(--opacity-light)" : ""}`}
            data-testid="schedule-month-cell">
            <div className="font-semibold">{d.getDate()}</div>
            {list.slice(0, MONTH_LINES).map((e) => chip(e, "cell", undefined, false, "h-[18px] border-0 bg-transparent px-0 text-foreground"))}
            {list.length > MONTH_LINES && (
              <Popover open={dayPopover === index} onOpenChange={(open) => setDayPopover(open ? index : null)}>
                <PopoverTrigger asChild>
                  <button type="button" className="self-start rounded bg-muted px-1 font-semibold" data-testid="schedule-month-more">
                    {t("schedulePanel.more", { count: String(list.length - MONTH_LINES) })}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-72" collisionPadding={16}>
                  <div className="mb-2 text-sm font-semibold">
                    {t("schedulePanel.dayPopoverTitle", { month: String(d.getMonth() + 1), day: String(d.getDate()), weekday: weekdayLabel(d), count: String(list.length) })}
                  </div>
                  <div className="flex flex-col gap-1">{list.map((e) => chip(e, "day-popover", { height: CHIP_PX }, false))}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => { setDayPopover(null); setMode("day"); setAnchor(d); }}>{t("schedulePanel.openDay")}</Button>
                    <Button size="sm" variant="outline" onClick={() => { setDayPopover(null); setCreate({ at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9) }); }}>
                      <Plus className="mr-1 h-3.5 w-3.5" />{t("schedulePanel.addOnDay")}
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        );
      })}
    </div>
  );

  const todayLabel = mode === "day" ? t("schedulePanel.today") : mode === "week" ? t("schedulePanel.thisWeek") : t("schedulePanel.thisMonth");
  const attention = records.filter((r) => r.needsAttention && visible(r.id));

  return (
    <div ref={setContainer} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="schedule-panel" data-narrow={narrow ? "1" : "0"}>
      <div className="flex flex-wrap items-center gap-2 border-b pb-2">
        <div className="flex gap-1" role="tablist" aria-label={t("schedulePanel.viewTabs")} onKeyDown={onTabKey}>
          {VIEW_MODES.map((m) => (
            <button key={m} type="button" role="tab" id={`${tabIds}-tab-${m}`} aria-selected={mode === m} aria-controls={`${tabIds}-panel`}
              tabIndex={mode === m ? 0 : -1}
              ref={(el) => { tabRefs.current[m] = el; }}
              className={`rounded px-2 py-1 text-sm ${mode === m ? "border-b-2 border-foreground font-semibold" : "text-muted-foreground"}`}
              onClick={() => setMode(m)}>
              {t(`schedulePanel.view_${m}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-7 w-7 p-0" aria-label={t("schedulePanel.previous")} onClick={() => setAnchor((a) => shiftAnchor(mode, a, -1, narrow))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-0 truncate px-1 text-sm font-semibold" data-testid="schedule-range-label">{rangeLabel(mode, range.days, anchor)}</span>
          <Button size="sm" variant="outline" className="h-7 w-7 p-0" aria-label={t("schedulePanel.next")} onClick={() => setAnchor((a) => shiftAnchor(mode, a, 1, narrow))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" className="h-7" onClick={() => setAnchor(now())}>{todayLabel}</Button>
        </div>
        <span className="rounded-full border px-2 text-xs text-muted-foreground" data-testid="schedule-count">{t("schedulePanel.count", { count: String(visibleCount) })}</span>
        {!narrow && mode !== "month" && <span className="min-w-0 truncate text-xs text-muted-foreground">{t("schedulePanel.slotHint")}</span>}
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <span className="inline-block h-3 w-3 rounded-sm border border-dashed border-muted-foreground" aria-hidden="true" />
          {t("schedulePanel.legendScheduled")}
        </span>
      </div>

      {(invalid.length > 0 || attention.length > 0) && (
        <div className="space-y-2 border-b py-2" data-testid="schedule-attention">
          {invalid.map((r) => <InvalidRoutineRow key={r.id} routine={r} onRemove={(id) => void commitDelete(id)} />)}
          {attention.map((r) => (
            <div key={r.id} className="flex items-start justify-between gap-2 rounded-lg border p-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="schedule-attention-row" data-routine-id={r.id} tabIndex={-1}>
              <div className="min-w-0">
                <div className="font-semibold">{routineTitle(r)}</div>
                <p className="break-words text-warning" role="status">
                  {t(r.lastSkippedReason === "plugins-missing" ? "routinePanel.pluginsMissing" : "routinePanel.pluginsPartlyMissing", {
                    plugins: r.needsAttention!.missingPluginIds.join(", "),
                  })}
                </p>
              </div>
              <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-destructive" onClick={() => startDelete(r.id)}>
                {t("routinePanel.deleteButton")}
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden" role="tabpanel" id={`${tabIds}-panel`} aria-labelledby={`${tabIds}-tab-${mode}`}>
        {mode === "month" ? monthGrid(range.days) : timeGrid(range.days)}
        {mode === "day" && !narrow && dayList(range.days[0]!)}
      </div>

      {loaded && visibleCount === 0 && invalid.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" data-testid="schedule-empty">
          <div className="pointer-events-auto max-w-sm rounded-lg border bg-background p-5 text-center shadow-e3">
            <div className="text-sm font-semibold">{t("schedulePanel.emptyTitle")}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("schedulePanel.emptyHint")}</p>
            <Button size="sm" className="mt-3" onClick={() => setCreate({})}><Plus className="mr-1 h-3.5 w-3.5" />{t("schedulePanel.add")}</Button>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div role="status" className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-foreground px-4 py-1.5 text-sm text-background shadow-lg" data-testid="schedule-undo-toast">
          <span>{t("schedulePanel.deleted")}</span>
          <button type="button" className="font-semibold underline" onClick={() => setPendingDelete(null)}>{t("schedulePanel.undo")}</button>
        </div>
      )}
      {notice && (
        <div role="alert" className="absolute bottom-3 right-3 z-30 flex max-w-sm items-center gap-2 rounded-md border bg-background px-3 py-2 text-xs shadow-lg">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" aria-label={t("routinePanel.closeAriaLabel")} onClick={() => setNotice("")}>✕</button>
        </div>
      )}

      {create && (
        <AddRoutineModal
          key={create.template ? packageRoutineSource(create.template) : create.at?.toISOString() ?? "manual"}
          api={api}
          {...(create.template ? { template: create.template } : {})}
          {...(create.at ? { initialAt: create.at } : {})}
          {...(projectRoot ? { projectRoot } : {})}
          onClose={() => setCreate(null)}
          onAdded={() => { setCreate(null); void refresh(); }}
        />
      )}
    </div>
  );
}
