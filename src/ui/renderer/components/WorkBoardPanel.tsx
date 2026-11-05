import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleStop, ListTree, Loader2, PanelRight, Play, Plus, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { t } from "../../../i18n/runtime.js";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";
import { MARKDOWN_SAFE_COMPONENTS, markdownUrlTransform } from "../utils/markdown-safe.js";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Textarea } from "../../../components/ui/textarea.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import type { AveApi } from "../types.js";
import type {
  RunTranscriptEvent,
  WorkBoardBriefingKind,
  WorkBoardBriefingResult,
  WorkBoardReportResult,
  WorkItemCreateInput,
  WorkItemPriority,
  WorkItemResolved,
  WorkItemStatusStored,
  WorkItemUpdateInput,
} from "../../../shared/work-board-types.js";
import type { WorkBoardToolApprovalSurface } from "../../../shared/work-board-types.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
import { localDateKey, localDayStart } from "../../../shared/local-date.js";
import { formatLocalClock } from "../../../shared/format-time.js";
import { errorMessage } from "../../../shared/error-message.js";
import { shortSessionId } from "../../../shared/session-lookup.js";
import { usePaneActions } from "./PaneFrame.js";
import { ApprovalDock, ApprovalLaneCard } from "./permissions/ApprovalDock.js";
import { VerticalSplitLayout } from "./VerticalSplitLayout.js";
import { LiveRunPanel, LIVE_STEP_PANEL_ID, type LiveRunEntry } from "./work-board/LiveRunPanel.js";
import { useBoardApprovals, useToolApprovalSurface } from "./work-board/use-board-approvals.js";
import type { ApprovalRequest } from "../types.js";
import { useScheduleData } from "./schedule/use-schedule-data.js";
import { boardScheduleCards, weekStart } from "./schedule/board-schedule.js";
import { PlannedScheduleCardView, RunningScheduleCardView, ScheduleWeekBundle } from "./schedule/BoardScheduleCards.js";
import {
  currentPhaseTurn,
  formatElapsed,
  isRunInFlight,
  isTerminalPhase,
  latestTurn,
  liveTextOf,
  runStartedAt,
  useNowTick,
  useWorkBoardRun,
  type RunPhase,
  type RunStateMap,
  type WorkItemRunState,
} from "../hooks/use-work-board-run.js";
import { WorkApprovalStack, type WorkApprovalActions } from "./work-approvals/WorkApprovalStack.js";
import { PlanDecisionControls } from "./work-approvals/PlanDecisionControls.js";

export interface WorkBoardPanelProps {
  api: AveApi;
  project?: ProjectIdentity;
  /** An item another surface asked the board to open — the sidebar's conversation row. The board opens the item's detail with
   * its latest run transcript expanded, then reports the request consumed. */
  focusItemId?: number | null;
  onFocusConsumed?: () => void;
  /** A 확인 필요 item the title-bar popover asked the stack to show and focus; reported consumed once handled. */
  approvalFocusKey?: string | null;
  onApprovalFocusConsumed?: () => void;
  /** The popover's 전체 보기: open the stack in all-projects mode; reported consumed once handled. */
  approvalShowAll?: boolean;
  onApprovalShowAllConsumed?: () => void;
  /** Open the schedule (routine) surface focused on one routine. */
  onOpenRoutine?: (routineId: string) => void;
  /** Opens the schedule panel: the "스케줄 열기" link and every schedule card lead there. */
  onOpenSchedule?: () => void;
  /** Opens the chat a running schedule item writes to. */
  onOpenSession?: (sessionId: string) => void;
}

/** Below this panel width the stack and the lanes become tabs instead of stacking (case board 17). */
const NARROW_PANEL_WIDTH = 900;
/** The open step panel's column beside the board: its 300px width plus its 12px gap. */
const STEPS_COLUMN_WIDTH = 312;
/** The narrowest board body that still holds three readable lanes beside the open step panel (the spec draws ~650px at a 958px pane). */
const BOARD_BODY_MIN_WIDTH = 600;

/** The one layout verdict: narrow when the panel is under 900px, or when the board body left beside an open step panel is under 600px.
 * The body is measured as the panel minus the steps column, not from the body itself, so docking the panel below (which widens the body)
 * cannot flip the verdict back. */
function boardIsNarrow(panelWidth: number, stepsOpen: boolean): boolean {
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) return false;
  if (panelWidth < NARROW_PANEL_WIDTH) return true;
  return stepsOpen && panelWidth - STEPS_COLUMN_WIDTH < BOARD_BODY_MIN_WIDTH;
}

/** The panel's measured width; Infinity until the first measurement (and where ResizeObserver is missing). */
function usePanelWidth(node: HTMLElement | null): number {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined && next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return width;
}


/** Schedule cards are shown unless the user turned them off for this project; a per-viewer convenience only. */
const SHOW_SCHEDULE_KEY = "ave.workBoard.showSchedule:";

function readShowSchedule(projectRoot: string | undefined): boolean {
  try {
    return window.localStorage.getItem(SHOW_SCHEDULE_KEY + (projectRoot ?? "")) !== "false";
  } catch {
    return true;
  }
}

function writeShowSchedule(projectRoot: string | undefined, show: boolean): void {
  try {
    window.localStorage.setItem(SHOW_SCHEDULE_KEY + (projectRoot ?? ""), String(show));
  } catch {
    // Storage can be unavailable; the toggle still applies for this view.
  }
}

const TITLE_MAX = 256;
const DESCRIPTION_MAX = 16384;
const DEFAULT_PRIORITY: WorkItemPriority = "medium";

//
// Domain priority (high/medium/low) is surfaced as P0/P1/P2 chips. The chip
// variant maps severity to the host token palette: high → destructive accent,
// medium → default, low → muted outline.

const PRIORITY_CHIP_LABEL: Record<WorkItemPriority, string> = {
  high: "priorityHigh",
  medium: "priorityMedium",
  low: "priorityLow",
};

const PRIORITY_FULL_LABEL: Record<WorkItemPriority, string> = {
  high: "priorityHighLabel",
  medium: "priorityMediumLabel",
  low: "priorityLowLabel",
};

const PRIORITY_OPTIONS: WorkItemPriority[] = ["high", "medium", "low"];

function PriorityChip({ priority }: { priority: WorkItemPriority }) {
  const cls =
    priority === "high"
      ? "border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) text-destructive"
      : priority === "medium"
        ? "border-primary/(--opacity-medium) bg-primary/(--opacity-subtle) text-primary"
        : "text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none border ${cls}`}
      title={t(`workBoard.${PRIORITY_FULL_LABEL[priority]}`)}
    >
      {t(`workBoard.${PRIORITY_CHIP_LABEL[priority]}`)}
    </span>
  );
}

// Use the shared day projection so board dates and work-report grouping agree.

/** Project a stored instant to the local civil day the `<input type="date">` speaks. */
function isoToLocalDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return localDateKey(d);
}

/** The wire form of a picked due date: the instant that calendar day begins, locally. Absolute and self-describing, which
 * is what the store persists and what `localDayBounds` compares a report window against. */
function dueAtForPickedDay(dayKey: string): string | null {
  return localDayStart(dayKey)?.toISOString() ?? null;
}

function formatDue(iso: string | undefined): string {
  const date = isoToLocalDate(iso);
  return date ? t("workBoard.dueLabel", { date }) : t("workBoard.noDueDate");
}

/** In-flight label; undefined is the optimistic start before the first progress event. Terminal phases never count as in flight. */
function inFlightLabel(phase: RunPhase | undefined): string {
  switch (phase) {
    case undefined:
      return t("workBoard.runStartingLabel");
    case "planning":
      return t("workBoard.runPlanning");
    case "awaiting_approval":
      return t("workBoard.runAwaitingApproval");
    case "executing":
      return t("workBoard.runExecuting");
    case "done":
    case "denied":
    case "error":
    case "cancelled":
      throw new Error(`work-board run phase ${phase} reached the in-flight indicator`);
    default: {
      const unhandled: never = phase;
      throw new Error(`unhandled work-board run phase: ${String(unhandled)}`);
    }
  }
}

/** How long the item's current run took, once its history records the end. */
function settledDuration(item: WorkItemResolved | undefined): string | undefined {
  const last = item?.runHistory?.at(-1);
  if (!item || !last || last.runId !== item.runId || !last.endedAt) return undefined;
  const ms = Date.parse(last.endedAt) - Date.parse(last.startedAt);
  return Number.isFinite(ms) ? formatElapsed(ms) : undefined;
}

function RunIndicator({ run, item }: { run: WorkItemRunState | undefined; item?: WorkItemResolved }) {
  if (!run) return null;
  const duration = settledDuration(item);
  const inFlight = isRunInFlight(run);
  const phase = run.phase;

  // Settled states of a run this board saw: done, rejected, failed or stopped, each with its own chip (livestep cases 10-12). Every phase
  // is named so a new one cannot fall through to "no chip" unnoticed.
  if (!inFlight) {
    switch (phase) {
      case undefined:
        return null;
      case "done":
        return (
          <span
            className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums border border-success/(--opacity-medium) bg-success/(--opacity-subtle) text-success"
            data-testid="work-board-run-done"
          >
            <CheckCircle2 className="h-3 w-3" />
            {duration ? `${t("workBoard.liveChipDone")} · ${duration}` : t("workBoard.liveChipDone")}
          </span>
        );
      case "denied":
        return (
          <span
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) text-destructive"
            data-testid="work-board-run-denied"
          >
            <XCircle className="h-3 w-3" />
            {t("workBoard.runDenied")}
          </span>
        );
      case "error":
        return (
          <span
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) text-destructive"
            title={run.reason}
            data-testid="work-board-run-error"
          >
            <AlertTriangle className="h-3 w-3" />
            {t("workBoard.runError")}
          </span>
        );
      // The user stopped it (owner decision 2026-11-04): a neutral chip, never the error treatment, so it does not read as something to fix.
      case "cancelled":
        return (
          <span
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none border border-border bg-muted text-muted-foreground"
            data-testid="work-board-run-cancelled"
          >
            <CircleStop className="h-3 w-3" />
            {duration ? `${t("workBoard.runCancelled")} · ${duration}` : t("workBoard.runCancelled")}
          </span>
        );
      case "planning":
      case "awaiting_approval":
      case "executing":
        // isRunInFlight is true for every non-terminal phase, so reaching here is a broken invariant, not a state to hide.
        throw new Error(`work-board run phase ${phase} reached the settled indicator`);
      default: {
        const unhandled: never = phase;
        throw new Error(`unhandled work-board run phase: ${String(unhandled)}`);
      }
    }
  }

  const label = inFlightLabel(phase);

  // `awaiting_approval` uses the accent (primary) token with a ring so it reads
  // as "needs you" without reaching for a raw palette color (theme-token rule).
  // The standard host ApprovalGate dialog renders the actual approve/reject; the
  // label here points the user at that surfaced prompt.
  const awaiting = phase === "awaiting_approval";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none border border-primary/(--opacity-medium) bg-primary/(--opacity-subtle) text-primary ${
        awaiting ? "ring-1 ring-primary/(--opacity-medium)" : ""
      }`}
      data-testid="work-board-run-indicator"
      data-phase={phase ?? "starting"}
    >
      {awaiting ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <Loader2 className="h-3 w-3 animate-spin" />
      )}
      {label}
    </span>
  );
}

/** The compact card's phase word; null for a run that is not in flight. Exhaustive over the run phases so a new phase must
 * decide how its card reads. */
function liveChipLabel(phase: RunPhase | undefined): string | null {
  switch (phase) {
    case undefined:
      return t("workBoard.liveChipStarting");
    case "planning":
      return t("workBoard.liveChipPlanning");
    case "awaiting_approval":
      return t("workBoard.liveChipAwaitingApproval");
    case "executing":
      return t("workBoard.liveChipExecuting");
    case "done":
    case "denied":
    case "error":
    case "cancelled":
      return null;
    default: {
      const unhandled: never = phase;
      throw new Error(`unhandled work board run phase: ${String(unhandled)}`);
    }
  }
}

/** "실행 중 · N턴째 · m:ss" — phase, the current phase's turn (once it took one), and the time since the run began (once the
 * listed item carries this run's start). The chip owns the 1s clock, so the tick re-renders only the chip, not the board or an
 * open detail dialog. */
function LiveRunChip({
  run,
  startedAt,
  toolApprovalPending,
}: {
  run: WorkItemRunState;
  startedAt: string | undefined;
  /** One of the run's tool approvals waits for the user: the run is paused on it. */
  toolApprovalPending: boolean;
}) {
  const now = useNowTick(true);
  const label = liveChipLabel(run.phase);
  if (label === null) return null;
  const turn = currentPhaseTurn(run);
  const startMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  // Stopping and a waiting tool approval outrank the phase word: they are what the run is doing now.
  const state = run.stopping ? "stopping" : toolApprovalPending ? "tool-approval" : (run.phase ?? "starting");
  const parts = [run.stopping ? t("workBoard.liveChipStopping") : toolApprovalPending ? t("workBoard.liveChipToolApproval") : label];
  if (!run.stopping && turn !== undefined) parts.push(t("workBoard.liveChipTurn", { turn }));
  if (!run.stopping && !toolApprovalPending && Number.isFinite(startMs)) parts.push(formatElapsed(now - startMs));
  const awaiting = run.phase === "awaiting_approval";
  const tone = run.stopping
    ? "border-border bg-muted text-muted-foreground"
    : toolApprovalPending
    ? "border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) text-warning"
    : `border-primary/(--opacity-medium) bg-primary/(--opacity-subtle) text-primary ${awaiting ? "ring-1 ring-primary/(--opacity-medium)" : ""}`;
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums border ${tone}`}
      data-testid="work-board-live-chip"
      data-phase={run.phase ?? "starting"}
      data-state={state}
    >
      {toolApprovalPending && !run.stopping ? (
        <ShieldAlert className="h-3 w-3 shrink-0" />
      ) : awaiting ? (
        <CheckCircle2 className="h-3 w-3 shrink-0" />
      ) : (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      )}
      <span className="min-w-0 truncate">{parts.join(" · ")}</span>
    </span>
  );
}


/** What every card on the board can do, and what the board knows about each card's run beyond its run state. */
interface CardActions {
  onStart: (id: number) => void;
  onComplete: (id: number) => void;
  onReopen: (id: number) => void;
  onRun: (id: number) => void;
  onOpenDetail: (id: number) => void;
  /** Open the live step panel on the item's run. */
  onShowSteps: (id: number) => void;
  /** The item the open step panel shows, or null when it is closed. */
  stepsShowingId: number | null;
  /** The head tool approval each item's run waits on, for items whose run waits on one. */
  toolApprovals: ReadonlyMap<number, readonly ApprovalRequest[]>;
  approvalSurface: WorkBoardToolApprovalSurface;
}

interface WorkItemCardProps {
  item: WorkItemResolved;
  run: WorkItemRunState | undefined;
  actions: CardActions;
}

function WorkItemCard({ item, run, actions }: WorkItemCardProps) {
  const { onStart, onComplete, onReopen, onRun, onOpenDetail, onShowSteps } = actions;
  const overdue = item.status_resolved === "overdue";
  const isCompleted = item.status === "completed";
  const live = run !== undefined && isRunInFlight(run) ? run : undefined;
  const narration = latestTurn(live);
  const toolApproval = live ? actions.toolApprovals.get(item.id)?.[0] : undefined;
  const stepsShowing = actions.stepsShowingId === item.id;
  const narrationLine = (className: string) => (
    toolApproval ? (
      // A waiting tool approval takes the narration's line, so the card keeps its height. In chat mode the line links to the run's
      // step panel, where the approval card is; in dialog mode the card is already over the board.
      <p className={className} data-testid="work-board-live-narration" title={toolApproval.toolName}>
        {actions.approvalSurface === "chat" ? (
          <span
            role="link"
            tabIndex={0}
            className="text-warning underline underline-offset-2"
            onClick={(event) => {
              event.stopPropagation();
              onShowSteps(item.id);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onShowSteps(item.id);
            }}
            data-testid="work-board-approve-in-chat"
          >
            {t("workBoard.liveApproveInChat")}
          </span>
        ) : (
          <span className="text-warning">{t("workBoard.liveApprovalInDialog")}</span>
        )}
        {` · ${toolApproval.toolName}`}
      </p>
    ) : (
      <p className={className} data-testid="work-board-live-narration" title={narration?.text}>
        {narration ? (
          <>
            <span className="tabular-nums">{formatLocalClock(narration.at)}</span>
            {` · ${narration.text}`}
          </>
        ) : (
          t("workBoard.liveNarrationWaiting")
        )}
      </p>
    )
  );
  return (
    <button
      type="button"
      className={`w-full rounded-lg border bg-background p-3 text-left shadow-sm transition-all hover:border-border hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        overdue ? "border-destructive/(--opacity-half) bg-destructive/(--opacity-faint)" : "border-border/(--opacity-strong)"
      }`}
      data-testid="work-board-card"
      onClick={() => onOpenDetail(item.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <PriorityChip priority={item.priority} />
            <span className={`min-w-0 line-clamp-1 text-sm font-semibold leading-snug ${isCompleted ? "text-muted-foreground line-through" : "text-foreground"}`}>
              {item.title}
            </span>
          </div>
          {live ? (
            // A running card keeps its footprint. The chip takes the due line's row, and one line of narration takes the
            // description's place: the description stays in the layout, invisible, so the block is exactly as tall as it was
            // before the run. A card without a description has no line to give, so its narration shares the chip's row.
            // Turns streaming in never resize the card. `contain: inline-size` keeps the unwrapped narration and chip from
            // widening the card past its column (the scroll area sizes its content to fit).
            <>
              <div
                className="mt-2 flex min-w-0 items-center gap-1.5 overflow-hidden [contain:inline-size]"
                data-testid="work-board-live-row"
              >
                {overdue && (
                  <Badge variant="outline" className="shrink-0 border-destructive/(--opacity-half) text-destructive">
                    {t("workBoard.overdueBadge")}
                  </Badge>
                )}
                <LiveRunChip run={live} startedAt={runStartedAt(item)} toolApprovalPending={toolApproval !== undefined} />
                {/* A strut in the due line's type, so this row is exactly as tall as the due line it replaces. */}
                <span aria-hidden="true" className="invisible w-0 text-[11px]">{"\u200b"}</span>
                {!item.detail && narrationLine("min-w-0 flex-1 truncate text-[11px] text-muted-foreground")}
              </div>
              {item.detail && (
                <div className="mt-1.5 grid [contain:inline-size]">
                  <p
                    aria-hidden="true"
                    className="invisible col-start-1 row-start-1 line-clamp-2 break-words text-[11px] leading-relaxed [overflow-wrap:anywhere]"
                  >
                    {item.detail}
                  </p>
                  {narrationLine("col-start-1 row-start-1 truncate text-[11px] leading-relaxed text-muted-foreground")}
                </div>
              )}
            </>
          ) : (
            <>
              {item.detail && (
                <p className="mt-1.5 line-clamp-2 break-words text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {overdue && (
                  <Badge variant="outline" className="border-destructive/(--opacity-half) text-destructive">
                    {t("workBoard.overdueBadge")}
                  </Badge>
                )}
                <span className="text-[11px] text-muted-foreground">{formatDue(item.due_at)}</span>
                <RunIndicator run={run} item={item} />
              </div>
            </>
          )}
        </div>
      </div>
      {/* Inline lifecycle actions. stopPropagation so the card's open-detail
          click does not also fire when the user only wanted to transition. */}
      <div className="mt-2.5 flex flex-wrap justify-end gap-1">
        {live && (
          <Button
            size="sm"
            variant={stepsShowing ? "secondary" : "ghost"}
            className="mr-auto h-6 px-2 text-[11px]"
            aria-pressed={stepsShowing}
            aria-controls={LIVE_STEP_PANEL_ID}
            onClick={(e) => {
              e.stopPropagation();
              onShowSteps(item.id);
            }}
            data-testid="work-board-show-steps"
          >
            <PanelRight className="mr-1 h-3 w-3" />
            {t("workBoard.liveStepsShow")}
          </Button>
        )}
        {!isCompleted && !live && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              onRun(item.id);
            }}
            data-testid="work-board-run"
          >
            <Play className="mr-1 h-3 w-3" />
            {run?.phase === "cancelled" || run?.phase === "error" ? t("workBoard.liveRerun") : t("workBoard.runButton")}
          </Button>
        )}
        {item.status === "planned" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              onStart(item.id);
            }}
            data-testid="work-board-start"
          >
            {t("workBoard.startButton")}
          </Button>
        )}
        {(item.status === "planned" || item.status === "in_progress") && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              onComplete(item.id);
            }}
            data-testid="work-board-complete"
          >
            {t("workBoard.completeButton")}
          </Button>
        )}
        {item.status === "completed" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              onReopen(item.id);
            }}
            data-testid="work-board-reopen"
          >
            {t("workBoard.reopenButton")}
          </Button>
        )}
      </div>
    </button>
  );
}

interface BoardColumnProps {
  heading: string;
  items: WorkItemResolved[];
  runState: RunStateMap;
  emptyLabel: string;
  loading: boolean;
  actions: CardActions;
  testId: string;
  /** The narrow board shows one column at a time, its cards two abreast and without the column's own heading (the tab carries it). */
  narrow?: boolean;
  /** Schedule cards placed among the work items by time (a work item by its due time), and how many schedule entries they stand for. */
  schedule?: { cards: Array<{ key: string; atMs: number; node: ReactNode }>; count: number; countKey: "workBoard.columnCountWithSchedule" | "workBoard.columnCountWithScheduleRuns" };
}

type ColumnEntry = { kind: "item"; item: WorkItemResolved } | { kind: "schedule"; node: ReactNode };

/** Work items keep their order; each schedule card goes before the first item due later than it. An item without a due time sorts
 * last, so a column of undated items lists the schedule cards first. */
function columnOrder(items: readonly WorkItemResolved[], cards: ReadonlyArray<{ atMs: number; node: ReactNode }>): ColumnEntry[] {
  const pending = [...cards].sort((a, b) => a.atMs - b.atMs);
  const out: ColumnEntry[] = [];
  for (const item of items) {
    const due = item.due_at ? Date.parse(item.due_at) : Number.POSITIVE_INFINITY;
    while (pending.length > 0 && pending[0]!.atMs <= due) out.push({ kind: "schedule", node: pending.shift()!.node });
    out.push({ kind: "item", item });
  }
  for (const card of pending) out.push({ kind: "schedule", node: card.node });
  return out;
}

function BoardColumn({
  heading,
  items,
  runState,
  emptyLabel,
  loading,
  actions,
  testId,
  narrow = false,
  schedule,
}: BoardColumnProps) {
  const hasSchedule = schedule !== undefined && schedule.cards.length > 0;
  // The list takes whatever height the section is given and scrolls. Its floor belongs to the grid that sizes the
  // section (see WorkBoardPanel), not to the list: a min-height on the inner list left the section free to shrink to its
  // header while the list was clipped below it.
  return (
    <section className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-lg border bg-muted/(--opacity-light) shadow-sm" data-testid={testId}>
      <div className={`items-center justify-between rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2 ${narrow ? "hidden" : "flex"}`}>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{heading}</h3>
        <span
          className="flex h-5 min-w-[20px] items-center justify-center whitespace-nowrap rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground"
          data-testid={`${testId}-count`}
        >
          {hasSchedule && schedule.count > 0 ? t(schedule.countKey, { items: String(items.length), schedules: String(schedule.count) }) : items.length}
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-2 pb-2" data-testid={`${testId}-list`}>
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t("workBoard.loadingLabel")}</div>
        ) : items.length === 0 && !hasSchedule ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{emptyLabel}</div>
        ) : (
          <div className={narrow ? "grid grid-cols-2 gap-2 pt-2" : "space-y-2"}>
            {columnOrder(items, hasSchedule ? schedule.cards : []).map((entry) => (entry.kind === "schedule" ? entry.node : (
              <WorkItemCard key={entry.item.id} item={entry.item} run={runState[entry.item.id]} actions={actions} />
            )))}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

function PriorityPicker({
  value,
  onChange,
  disabled,
}: {
  value: WorkItemPriority;
  onChange: (p: WorkItemPriority) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label={t("workBoard.priorityLabel")}>
      {PRIORITY_OPTIONS.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt)}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
              active ? "border-primary bg-primary/(--opacity-subtle) font-medium" : "text-muted-foreground hover:bg-muted/(--opacity-strong)"
            }`}
            data-testid={`work-board-priority-${opt}`}
          >
            <PriorityChip priority={opt} />
            <span>{t(`workBoard.${PRIORITY_FULL_LABEL[opt]}`)}</span>
          </button>
        );
      })}
    </div>
  );
}

interface CreateDialogProps {
  api: AveApi;
  project?: ProjectIdentity;
  onClose: () => void;
  onCreated: () => void;
}

function defaultDueIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return localDateKey(d);
}

function WorkItemCreateDialog({ api, project, onClose, onCreated }: CreateDialogProps) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [dueDate, setDueDate] = useState(defaultDueIso());
  const [noDeadline, setNoDeadline] = useState(false);
  const [priority, setPriority] = useState<WorkItemPriority>(DEFAULT_PRIORITY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    const titleTrimmed = title.trim();
    if (!titleTrimmed) {
      setError(t("workBoard.errorTitleRequired"));
      return;
    }
    const input: WorkItemCreateInput = { title: titleTrimmed };
    if (detail.trim()) input.detail = detail.trim();
    // Local midnight, so the stored instant is the start of the calendar day the user actually picked on their own calendar.
    if (!noDeadline && dueDate) {
      const dueAt = dueAtForPickedDay(dueDate);
      if (dueAt) input.due_at = dueAt;
    }
    if (priority !== DEFAULT_PRIORITY) input.priority = priority;
    if (project?.projectRoot) {
      input.projectRoot = project.projectRoot;
      input.projectName = project.projectName;
    }

    setSubmitting(true);
    setError("");
    try {
      const result = await api.addWorkBoardItem(input);
      if ("status" in result && result.status === "created") {
        onCreated();
        onClose();
      } else {
        const reason = "reason" in result ? result.reason : "error" in result ? result.error : undefined;
        setError(reason ?? t("workBoard.errorAddFailed"));
      }
    } catch (err) {
      setError(errorMessage(err) || t("workBoard.errorAddFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md" data-testid="work-board-create-dialog">
        <DialogHeader className="flex flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-base">{t("workBoard.createTitle")}</DialogTitle>
          <DialogClose asChild>
            <Button size="sm" variant="ghost" className="-mr-2 h-7 w-7 p-0" aria-label={t("workBoard.closeAriaLabel")}>✕</Button>
          </DialogClose>
        </DialogHeader>

        <div className="space-y-3">
          <Label className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{t("workBoard.titleRequiredLabel")}</div>
            <Input
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("workBoard.titlePlaceholder")}
              data-testid="work-board-create-title"
              autoFocus
            />
          </Label>
          <Label className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{t("workBoard.detailFieldLabel")}</div>
            <Textarea
              value={detail}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) => setDetail(e.target.value)}
              rows={3}
              data-testid="work-board-create-detail"
            />
          </Label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("workBoard.dueDateLabel")}</div>
              <Input
                type="date"
                value={dueDate}
                disabled={noDeadline}
                onChange={(e) => setDueDate(e.target.value)}
                data-testid="work-board-create-due"
              />
            </Label>
            <Label className="flex items-end gap-2 pb-1.5 text-xs">
              <Checkbox
                checked={noDeadline}
                onCheckedChange={(c) => setNoDeadline(c === true)}
                data-testid="work-board-create-no-deadline"
              />
              <span>{t("workBoard.noDeadlineLabel")}</span>
            </Label>
          </div>
          <Label className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{t("workBoard.priorityLabel")}</div>
            <PriorityPicker value={priority} onChange={setPriority} disabled={submitting} />
          </Label>
          <p className="text-[11px] text-muted-foreground">{t("workBoard.createHint")}</p>
          {error && <p className="text-sm text-destructive" data-testid="work-board-create-error">{error}</p>}
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>{t("workBoard.cancelButton")}</Button>
          <Button
            size="sm"
            disabled={submitting || !title.trim()}
            onClick={() => void handleSubmit()}
            data-testid="work-board-create-submit"
          >
            {submitting ? t("workBoard.submittingLabel") : t("workBoard.submitButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DetailDialogProps {
  api: AveApi;
  itemId: number;
  run: WorkItemRunState | undefined;
  /** Expand the newest run's transcript as soon as the item loads. */
  openLatestRun?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onRun: (id: number) => void;
}

//
// Renders the captured plan + execution result. Source precedence: the live run
// state's terminal session id / liveText (current run) layered over the item's
// persisted `plan` / `output` fields (last completed run). A monospace,
// scrollable block keeps long agent output readable inside the modal.

function RunOutputPanel({
  item,
  run,
}: {
  item: WorkItemResolved;
  run: WorkItemRunState | undefined;
}) {
  const inFlight = isRunInFlight(run);
  const plan = item.plan;
  const output = item.output;
  const liveText = inFlight ? liveTextOf(run) : undefined;
  const sessionId = run?.runSessionId ?? item.runSessionId;

  // Nothing to show: never run AND no live activity.
  if (!plan && !output && !liveText && !run) return null;

  return (
    <div className="space-y-2 rounded-md border bg-muted/(--opacity-light) p-2.5" data-testid="work-board-run-output">
      <div className="flex items-center justify-between">
        <RunIndicator run={run} />
        {sessionId && (
          <span className="text-[10px] text-muted-foreground" title={sessionId}>
            {t("workBoard.runSessionLabel", { id: shortSessionId(sessionId) })}
          </span>
        )}
      </div>
      {liveText && (
        <div data-testid="work-board-run-live">
          <div className="text-[11px] font-medium text-muted-foreground">{t("workBoard.runLiveHeading")}</div>
          <div className="mt-1 max-h-32 overflow-auto rounded bg-background/(--opacity-strong) p-3">
            <div className="prose prose-sm ave-prose max-w-none break-words [overflow-wrap:anywhere]">
              <ReactMarkdown
                remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                urlTransform={markdownUrlTransform}
                components={MARKDOWN_SAFE_COMPONENTS}
              >{liveText}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
      {plan && (
        <div data-testid="work-board-run-plan">
          <div className="text-[11px] font-medium text-muted-foreground">{t("workBoard.runPlanHeading")}</div>
          <div className="mt-1 max-h-48 overflow-auto rounded bg-background/(--opacity-strong) p-3">
            <div className="prose prose-sm ave-prose max-w-none break-words [overflow-wrap:anywhere]">
              <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{plan}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
      {output && (
        <div data-testid="work-board-run-result">
          <div className="text-[11px] font-medium text-muted-foreground">{t("workBoard.runOutputHeading")}</div>
          <div className="mt-1 max-h-48 overflow-auto rounded bg-background/(--opacity-strong) p-3">
            <div className="prose prose-sm ave-prose max-w-none break-words [overflow-wrap:anywhere]">
              <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{output}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// The detail's copy of the plan decision; the 확인 필요 plan card shows the same controls.
function PlanDecisionPanel({ api, item, onDecided }: { api: AveApi; item: WorkItemResolved; onDecided: () => void }) {
  const approval = item.planApproval;
  if (item.runStatus !== "awaiting_approval" || approval?.status !== "pending" || !item.runId) return null;
  return (
    <section className="space-y-2 rounded-md border border-primary/(--opacity-medium) p-2.5" data-testid="work-board-plan-decision">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold">{t("workBoard.planDecisionHeading")}</h4>
        {approval.revision > 0 && (
          <span className="text-[11px] text-muted-foreground">{t("workBoard.planDecisionRevision", { count: approval.revision })}</span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">{t("workBoard.planDecisionToolNote")}</p>
      <PlanDecisionControls
        key={`${item.runId}:${approval.planHash}`}
        api={api}
        itemId={item.id}
        runId={item.runId}
        planHash={approval.planHash}
        stale={item.planStale === true}
        onDecided={onDecided}
        onGone={onDecided}
        testIdPrefix="work-board-plan"
      />
    </section>
  );
}

const STATUS_LABEL: Record<WorkItemResolved["status_resolved"], string> = {
  planned: "columnPlanned",
  in_progress: "columnInProgress",
  completed: "columnCompleted",
  overdue: "overdueBadge",
};

//
// `item.runHistory` is the board-persisted index (newest last); each entry's
// transcript (the plan+execute conversation) is fetched on demand from
// `sessions/<id>/<runId>.jsonl` via getWorkBoardRunTranscript. This makes the
// accumulation visible — re-runs add rows here instead of wiping prior work.
function RunHistorySection({
  api,
  item,
  initialOpenRunId,
}: {
  api: AveApi;
  item: WorkItemResolved;
  /** A run to show expanded on mount — the newest one when the item was reached from its conversation row. */
  initialOpenRunId?: string;
}) {
  const history = item.runHistory ?? [];
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [events, setEvents] = useState<RunTranscriptEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (runId: string) => {
    setOpenRun(runId);
    setEvents([]);
    if (typeof api.getWorkBoardRunTranscript !== "function") return;
    setLoading(true);
    try {
      const r = await api.getWorkBoardRunTranscript(item.id, runId);
      if ("events" in r) setEvents(r.events);
    } finally {
      setLoading(false);
    }
  }, [api, item.id]);

  useEffect(() => {
    if (initialOpenRunId === undefined) return;
    void load(initialOpenRunId);
  }, [initialOpenRunId, load]);

  if (history.length === 0) return null;

  const toggle = async (runId: string) => {
    if (openRun === runId) {
      setOpenRun(null);
      return;
    }
    await load(runId);
  };

  return (
    <section className="rounded-lg border bg-muted/(--opacity-light) shadow-sm" data-testid="work-board-run-history">
      <div className="flex items-center justify-between rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("workBoard.runHistoryHeading")}
        </h4>
        <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
          {history.length}
        </span>
      </div>
      <ul className="space-y-1 p-2.5">
        {[...history].reverse().map((h) => (
          <li key={h.runId} className="text-[11px]">
            <button
              type="button"
              onClick={() => void toggle(h.runId)}
              className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-muted"
            >
              <span className="min-w-0 line-clamp-1">
                {t(`workBoard.run_${h.status}`)} · {isoToLocalDate(h.startedAt)}
              </span>
              <span className="text-muted-foreground">{openRun === h.runId ? "▲" : "▼"}</span>
            </button>
            {openRun === h.runId && (
              <div className="mt-1 rounded bg-background/(--opacity-strong) p-2">
                {loading ? (
                  <span className="text-muted-foreground">…</span>
                ) : events.length === 0 ? (
                  <span className="text-muted-foreground">{t("workBoard.runHistoryEmpty")}</span>
                ) : (
                  <div className="max-h-48 overflow-auto">
                    <div className="prose prose-sm ave-prose max-w-none break-words [overflow-wrap:anywhere]">
                      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
                        {events
                          .map((e) => `[${e.phase}${e.turn ? `#${e.turn}` : ""}] ${e.text ?? e.message ?? ""}`)
                          .join("\n\n")}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorkItemDetailDialog({ api, itemId, run, openLatestRun, onClose, onChanged, onRun }: DetailDialogProps) {
  const [item, setItem] = useState<WorkItemResolved | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [noDeadline, setNoDeadline] = useState(false);
  const [priority, setPriority] = useState<WorkItemPriority>(DEFAULT_PRIORITY);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setLoadError("");
    setActionError("");
    void (async () => {
      try {
        const result = await api.getWorkBoardItem(itemId);
        if (cancelled) return;
        if ("status" in result && result.status === "found") {
          const it = result.item;
          setItem(it);
          setTitle(it.title);
          setDetail(it.detail ?? "");
          const due = isoToLocalDate(it.due_at);
          setDueDate(due);
          setNoDeadline(!it.due_at);
          setPriority(it.priority);
        } else {
          const reason = "error" in result ? result.error : undefined;
          setLoadError(reason ?? t("workBoard.errorLoadFailed"));
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(errorMessage(err) || t("workBoard.errorLoadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, itemId, reloadKey]);

  // When the in-flight run reaches a terminal phase, re-fetch so the persisted `plan` / `output` / `runSessionId` written by
  // the engine land in the item. A plan reaching awaiting_approval re-fetches too: its stored decision object is what the
  // decision panel binds to, and the dialog may have been open since before the run started.
  const settledPhase = run?.phase !== undefined && (isTerminalPhase(run.phase) || run.phase === "awaiting_approval") ? run.phase : null;
  useEffect(() => {
    if (settledPhase !== null) setReloadKey((k) => k + 1);
  }, [settledPhase]);

  const dirty = useMemo(() => {
    if (!item) return false;
    if (title.trim() !== item.title.trim()) return true;
    if ((detail.trim() || "") !== (item.detail?.trim() ?? "")) return true;
    if (noDeadline !== !item.due_at) return true;
    if (!noDeadline && dueDate !== isoToLocalDate(item.due_at)) return true;
    if (priority !== item.priority) return true;
    return false;
  }, [item, title, detail, dueDate, noDeadline, priority]);

  const canSave = !!item && dirty && title.trim().length > 0 && !busy;

  // A mutation either lands (close, let the board reload) or explains itself in the dialog; the host's refusal reads the
  // same for every operation.
  const settleMutation = (ok: boolean, result: object) => {
    if (ok) {
      onChanged();
      onClose();
      return;
    }
    const reason = "reason" in result ? result.reason : "error" in result ? result.error : undefined;
    setActionError(typeof reason === "string" ? reason : t("workBoard.errorSaveFailed"));
  };

  const handleSave = async () => {
    if (!item || !canSave) return;
    const patch: WorkItemUpdateInput = {};
    const titleTrimmed = title.trim();
    if (titleTrimmed !== item.title.trim()) patch.title = titleTrimmed;
    const newDetail = detail.trim();
    const oldDetail = item.detail?.trim() ?? "";
    if (newDetail !== oldDetail) patch.detail = newDetail ? newDetail : null;
    const origNoDeadline = !item.due_at;
    if (noDeadline !== origNoDeadline || (!noDeadline && isoToLocalDate(item.due_at) !== dueDate)) {
      patch.due_at = noDeadline || !dueDate ? null : dueAtForPickedDay(dueDate);
    }
    if (priority !== item.priority) patch.priority = priority;

    setBusy(true);
    setActionError("");
    try {
      const result = await api.updateWorkBoardItem(item.id, patch);
      settleMutation("status" in result && result.status === "updated", result);
    } catch (err) {
      setActionError(errorMessage(err) || t("workBoard.errorSaveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const runLifecycle = async (op: "complete" | "reopen" | "delete") => {
    if (!item) return;
    setBusy(true);
    setActionError("");
    try {
      const result =
        op === "complete"
          ? await api.completeWorkBoardItem(item.id)
          : op === "reopen"
            ? await api.reopenWorkBoardItem(item.id)
            : await api.removeWorkBoardItem(item.id);
      const ok =
        "status" in result &&
        (result.status === "completed" || result.status === "reopened" || result.status === "deleted");
      settleMutation(ok, result);
    } catch (err) {
      setActionError(errorMessage(err) || t("workBoard.errorSaveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const isCompleted = item?.status === "completed";

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md" data-testid="work-board-detail-dialog">
        <DialogHeader className="flex flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-base">{t("workBoard.detailTitle")}</DialogTitle>
          <DialogClose asChild>
            <Button size="sm" variant="ghost" className="-mr-2 h-7 w-7 p-0" aria-label={t("workBoard.closeAriaLabel")}>✕</Button>
          </DialogClose>
        </DialogHeader>

        {loadError ? (
          <p className="text-sm text-destructive" data-testid="work-board-detail-load-error">{loadError}</p>
        ) : !item ? (
          <div className="py-8 text-center text-sm text-muted-foreground" data-testid="work-board-detail-loading">
            {t("workBoard.loadingLabel")}
          </div>
        ) : (
          <div className="space-y-3">
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("workBoard.titleLabel")}</div>
              <Input
                value={title}
                maxLength={TITLE_MAX}
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
                data-testid="work-board-detail-title"
              />
            </Label>
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("workBoard.detailFieldLabel")}</div>
              <Textarea
                value={detail}
                maxLength={DESCRIPTION_MAX}
                disabled={busy}
                onChange={(e) => setDetail(e.target.value)}
                rows={3}
                data-testid="work-board-detail-detail"
              />
            </Label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Label className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">{t("workBoard.dueDateLabel")}</div>
                <Input
                  type="date"
                  value={dueDate}
                  disabled={busy || noDeadline}
                  onChange={(e) => setDueDate(e.target.value)}
                  data-testid="work-board-detail-due"
                />
              </Label>
              <Label className="flex items-end gap-2 pb-1.5 text-xs">
                <Checkbox
                  checked={noDeadline}
                  disabled={busy}
                  onCheckedChange={(c) => setNoDeadline(c === true)}
                  data-testid="work-board-detail-no-deadline"
                />
                <span>{t("workBoard.noDeadlineLabel")}</span>
              </Label>
            </div>
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("workBoard.priorityLabel")}</div>
              <PriorityPicker value={priority} onChange={setPriority} disabled={busy} />
            </Label>
            <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] text-muted-foreground">
              <span>
                {t("workBoard.statusLabel")}: <strong>{t(`workBoard.${STATUS_LABEL[item.status_resolved]}`)}</strong>
              </span>
              <span>
                {t("workBoard.metaCreated", { date: isoToLocalDate(item.created_at) })} ·{" "}
                {t("workBoard.metaUpdated", { date: isoToLocalDate(item.updated_at) })}
              </span>
            </div>
            {actionError && <p className="text-sm text-destructive" data-testid="work-board-detail-error">{actionError}</p>}
            <RunOutputPanel item={item} run={run} />
            <PlanDecisionPanel api={api} item={item} onDecided={() => { setReloadKey((k) => k + 1); onChanged(); }} />
            <RunHistorySection
              api={api}
              item={item}
              initialOpenRunId={openLatestRun ? item.runHistory?.at(-1)?.runId : undefined}
            />
          </div>
        )}

        {item && (
          <DialogFooter className="sm:justify-between">
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={() => void runLifecycle("delete")}
              data-testid="work-board-detail-delete"
            >
              {t("workBoard.deleteButton")}
            </Button>
            <div className="flex gap-2">
              {!isCompleted && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || isRunInFlight(run)}
                  onClick={() => onRun(item.id)}
                  data-testid="work-board-detail-run"
                >
                  {isRunInFlight(run) ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="mr-1 h-3 w-3" />
                  )}
                  {isRunInFlight(run) ? t("workBoard.runBusyShort") : t("workBoard.runButton")}
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>
                {t("workBoard.cancelButton")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void runLifecycle(isCompleted ? "reopen" : "complete")}
                data-testid="work-board-detail-toggle"
              >
                {isCompleted ? t("workBoard.reopenButton") : t("workBoard.completeButton")}
              </Button>
              <Button
                size="sm"
                disabled={!canSave}
                onClick={() => void handleSave()}
                data-testid="work-board-detail-save"
              >
                {busy ? t("workBoard.submittingLabel") : t("workBoard.saveButton")}
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Reports summarize board state; briefings survey read-only and file findings as separately reviewed proposals.

function ReportsSection({ api, project }: { api: AveApi; project?: ProjectIdentity }) {
  const [generating, setGenerating] = useState<"daily" | "weekly" | null>(null);
  const [result, setResult] = useState<
    WorkBoardReportResult | { ok: false; error: string } | null
  >(null);
  const [briefing, setBriefing] = useState<WorkBoardBriefingKind | null>(null);
  const [briefingResult, setBriefingResult] = useState<
    WorkBoardBriefingResult | { ok: false; error: string } | null
  >(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const run = useCallback(
    async (kind: "daily" | "weekly") => {
      if (typeof api.generateWorkBoardReport !== "function") return;
      setGenerating(kind);
      setResult(null);
      try {
        const r = await api.generateWorkBoardReport(kind, project?.projectRoot
          ? { projectRoot: project.projectRoot, includeUnscoped: project.isDefault === true }
          : undefined);
        if (mountedRef.current) setResult(r);
      } finally {
        if (mountedRef.current) setGenerating(null);
      }
    },
    [api, project],
  );

  const survey = useCallback(
    async (kind: WorkBoardBriefingKind) => {
      if (typeof api.runWorkBoardBriefing !== "function") return;
      setBriefing(kind);
      setBriefingResult(null);
      try {
        const r = await api.runWorkBoardBriefing(kind, project?.projectRoot);
        if (mountedRef.current) setBriefingResult(r);
      } finally {
        if (mountedRef.current) setBriefing(null);
      }
    },
    [api, project],
  );

  return (
    <section className="rounded-lg border bg-muted/(--opacity-light) shadow-sm" data-testid="work-board-reports">
      <div className="flex items-center justify-between rounded-t-lg border-b bg-muted/(--opacity-medium) px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("workBoard.reportsHeading")}</h3>
      </div>
      <div className="p-4">
      <p className="text-[11px] text-muted-foreground">{t("workBoard.reportPlaceholder")}</p>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={generating !== null}
          onClick={() => void run("daily")}
          data-testid="work-board-report-daily"
        >
          {generating === "daily" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {t("workBoard.reportDaily")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={generating !== null}
          onClick={() => void run("weekly")}
          data-testid="work-board-report-weekly"
        >
          {generating === "weekly" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {t("workBoard.reportWeekly")}
        </Button>
      </div>
      {result && <ReportResultBlock result={result} onClose={() => setResult(null)} />}

      <div className="mt-4 border-t pt-4">
        <p className="text-[11px] text-muted-foreground">{t("workBoard.briefingHint")}</p>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={briefing !== null}
            onClick={() => void survey("daily")}
            data-testid="work-board-briefing-daily"
          >
            {briefing === "daily" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {t("workBoard.briefingDaily")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={briefing !== null}
            onClick={() => void survey("weekly")}
            data-testid="work-board-briefing-weekly"
          >
            {briefing === "weekly" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {t("workBoard.briefingWeekly")}
          </Button>
        </div>
        {briefing !== null && (
          <p className="mt-2 text-[11px] text-muted-foreground" data-testid="work-board-briefing-running">
            {t("workBoard.briefingRunning")}
          </p>
        )}
        {briefing === null && briefingResult && <BriefingResultLine result={briefingResult} />}
      </div>
      </div>
    </section>
  );
}

// The briefing's own result line. The cards themselves render in the recommended-work band, so this says only how many
// arrived — or, when the survey found nothing new, that there is nothing to look at.
function BriefingResultLine({
  result,
}: {
  result: WorkBoardBriefingResult | { ok: false; error: string };
}) {
  if ("ok" in result) {
    return (
      <p className="mt-2 text-[11px] text-destructive" data-testid="work-board-briefing-error">
        {t("workBoard.briefingFailed")}: {result.error}
      </p>
    );
  }
  if (result.status === "error") {
    return (
      <p className="mt-2 text-[11px] text-destructive" data-testid="work-board-briefing-error">
        {t("workBoard.briefingFailed")}: {result.reason}
      </p>
    );
  }
  // An `ok` run that refreshed existing cards and added none is, to the user, the same answer as a survey that found
  // nothing: no new work arrived.
  if (result.status === "empty" || result.filed.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground" data-testid="work-board-briefing-empty">
        {t("workBoard.briefingNothing")}
      </p>
    );
  }
  return (
    <p className="mt-2 text-[11px] text-muted-foreground" data-testid="work-board-briefing-filed">
      {t("workBoard.briefingFiled", { count: result.filed.length })}
    </p>
  );
}

// Render the discriminated report result: `ok` → period heading + markdown, `empty` → muted reason, `error` / `{ok:false}`
// → destructive reason.
function ReportResultBlock({
  result,
  onClose,
}: {
  result: WorkBoardReportResult | { ok: false; error: string };
  onClose: () => void;
}) {
  if ("ok" in result) {
    return (
      <p className="mt-2 text-[11px] text-destructive" data-testid="work-board-report-error">
        {t("workBoard.reportFailed")}: {result.error}
      </p>
    );
  }
  if (result.status === "error") {
    return (
      <p className="mt-2 text-[11px] text-destructive" data-testid="work-board-report-error">
        {t("workBoard.reportFailed")}: {result.reason}
      </p>
    );
  }
  if (result.status === "empty") {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground" data-testid="work-board-report-empty">
        {result.reason}
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-1" data-testid="work-board-report-result">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t("workBoard.reportResultHeading")} · {result.period}
        </span>
        <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={onClose}>
          {t("workBoard.reportClose")}
        </Button>
      </div>
      <div className="max-h-48 overflow-auto rounded bg-background/(--opacity-strong) p-3">
        <div className="prose prose-sm ave-prose max-w-none break-words [overflow-wrap:anywhere]">
          <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{result.markdown}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

export function WorkBoardPanel({
  api, project, focusItemId, onFocusConsumed, approvalFocusKey, onApprovalFocusConsumed, approvalShowAll, onApprovalShowAllConsumed,
  onOpenRoutine, onOpenSchedule, onOpenSession,
}: WorkBoardPanelProps) {
  const projectRoot = project?.projectRoot;
  const [showSchedule, setShowSchedule] = useState(() => readShowSchedule(projectRoot));
  useEffect(() => { setShowSchedule(readShowSchedule(projectRoot)); }, [projectRoot]);
  // This week (for the finished-runs bundle) through the next five weeks (so a monthly item still has a next run). Recomputed when
  // the day turns over: every refresh re-renders, so an open board moves to the new day and week on its own.
  const today = localDateKey(new Date());
  const scheduleRange = useMemo(() => {
    const now = new Date();
    return { from: weekStart(now), to: new Date(now.getTime() + 35 * 24 * 60 * 60 * 1000) };
  }, [today]);
  const scheduleData = useScheduleData(api, projectRoot, scheduleRange,
    showSchedule && typeof api.listRoutineOccurrences === "function");
  const scheduleCards = boardScheduleCards({ ...scheduleData, now: new Date() });
  // A card opens the schedule on that item when the host can focus one, else the schedule itself.
  const openScheduleItem = (routineId: string) => (onOpenRoutine ? onOpenRoutine(routineId) : onOpenSchedule?.());
  const [items, setItems] = useState<WorkItemResolved[]>([]);
  const [panelNode, setPanelNode] = useState<HTMLDivElement | null>(null);
  const panelWidth = usePanelWidth(panelNode);
  // The live step panel's visibility is declared here because the layout verdict reads it.
  const [stepsOpen, setStepsOpen] = useState(false);
  const narrow = boardIsNarrow(panelWidth, stepsOpen);
  const [approvalCount, setApprovalCount] = useState<number | null>(null);
  // Narrow layout opens 확인 필요 first while it has items; the user's own tab choice then sticks.
  const [narrowTabChoice, setNarrowTabChoice] = useState<"overview" | "approvals" | null>(null);
  const narrowTab = narrowTabChoice ?? (approvalCount !== null && approvalCount > 0 ? "approvals" : "overview");
  const setNarrowTab = setNarrowTabChoice;
  const stackHidden = narrow && narrowTab !== "approvals";
  // A badge-popover navigation names an item in the stack; on a narrow panel that means showing the stack's tab. A wide panel shows the
  // stack anyway, so nothing is stored there: a choice stored while wide would open an empty 확인 필요 tab after a later shrink.
  useEffect(() => {
    if (narrow && ((approvalFocusKey !== undefined && approvalFocusKey !== null) || approvalShowAll)) setNarrowTabChoice("approvals");
  }, [approvalFocusKey, approvalShowAll, narrow]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  // True while the open detail was reached from a conversation row: that arrival is about the run, so the latest transcript
  // opens with it.
  const [detailOpensLatestRun, setDetailOpensLatestRun] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Set once the first list read settled, so a focus request can see which item it names and what that item's run waits on.
  const [listedOnce, setListedOnce] = useState(false);

  const refresh = useCallback(async () => {
    if (typeof api.listWorkBoard !== "function") {
      setListedOnce(true);
      return;
    }
    setLoading(true);
    try {
      const result = await api.listWorkBoard(project?.projectRoot
        ? {
            projectRoot: project.projectRoot,
            includeUnscoped: project.isDefault === true,
          }
        : undefined);
      if (!mountedRef.current) return;
      if ("status" in result && result.status === "ok") {
        setItems(result.items);
      } else {
        setItems([]);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setListedOnce(true);
      }
    }
  }, [api, project]);

  useEffect(() => {
    void refresh();
    if (typeof api.onWorkBoardItemChanged !== "function") return undefined;
    const unsub = api.onWorkBoardItemChanged(() => {
      void refresh();
    });
    return unsub;
  }, [api, refresh]);

  const handleTransition = useCallback(
    async (id: number, to: WorkItemStatusStored) => {
      await api.transitionWorkBoardItem(id, to);
      await refresh();
    },
    [api, refresh],
  );

  const handleComplete = useCallback(
    async (id: number) => {
      await api.completeWorkBoardItem(id);
      await refresh();
    },
    [api, refresh],
  );

  const handleReopen = useCallback(
    async (id: number) => {
      await api.reopenWorkBoardItem(id);
      await refresh();
    },
    [api, refresh],
  );

  // Bucket by stored status. `overdue` is a projection over planned/in_progress so those items stay in their lifecycle
  // column with an overdue badge.
  const planned = useMemo(() => items.filter((i) => i.status === "planned"), [items]);
  const inProgress = useMemo(() => items.filter((i) => i.status === "in_progress"), [items]);
  const completed = useMemo(() => items.filter((i) => i.status === "completed"), [items]);

  // Agent-orchestration run state + launcher. Subscribes to the four host run channels in a single effect (cleanup inside
  // the hook).
  // A run entering a phase has just written its run fields (runId, runHistory, runStatus) to the item. Re-list so the card's elapsed
  // time reads this run's start rather than the previous run's; turn events do not re-list.
  const { runState, runItem, steer, stop } = useWorkBoardRun(api, items, refresh);
  const { byItem: toolApprovals, surface: approvalSurfaceValue } = useBoardApprovals(items, runState);
  const approvalSurface = useToolApprovalSurface(api);

  // The live step panel: which run it follows, whether it jumps to a newly started run, and whether a settled run stays listed.
  const [stepsItemId, setStepsItemId] = useState<number | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [pinned, setPinned] = useState(false);
  const liveEntries = useMemo<LiveRunEntry[]>(() => {
    const inFlightIds = new Set(items.filter((item) => isRunInFlight(runState[item.id])).map((item) => item.id));
    const entries: LiveRunEntry[] = [];
    for (const item of items) {
      const run = runState[item.id];
      if (!run) continue;
      // A settled run stays listed while it is the one being followed and the panel is pinned, or while nothing else is in flight.
      const followedSettled = item.id === stepsItemId && run.phase !== undefined && (pinned || inFlightIds.size === 0);
      if (!inFlightIds.has(item.id) && !followedSettled) continue;
      entries.push({ item, run, approvals: toolApprovals.get(item.id) ?? [] });
    }
    return entries;
  }, [items, runState, toolApprovals, stepsItemId, pinned]);

  // Auto-follow: a run that just started takes the panel. Tracked by the set of in-flight items, so a re-render is not a start.
  const inFlightRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const now = new Set(Object.entries(runState).filter(([, run]) => isRunInFlight(run)).map(([id]) => Number(id)));
    const started = [...now].filter((id) => !inFlightRef.current.has(id));
    inFlightRef.current = now;
    if (autoFollow && started.length > 0) setStepsItemId(started.at(-1)!);
  }, [runState, autoFollow]);
  // The panel always shows a run when it lists one.
  useEffect(() => {
    if (liveEntries.length === 0) return;
    if (stepsItemId === null || !liveEntries.some((entry) => entry.item.id === stepsItemId)) {
      setStepsItemId(liveEntries[0]!.item.id);
    }
  }, [liveEntries, stepsItemId]);

  const showSteps = useCallback((id: number) => {
    setStepsItemId(id);
    setStepsOpen(true);
  }, []);

  // A conversation row brought the user here. That arrival is about the item's run: a run parked on a tool approval opens its step
  // panel, where (or over which) the card is drawn; any other opens the item's detail on its latest run. This is the path to a card
  // whose row carried the attention dot while no board was open to claim it.
  const approvalQueue = approvalSurfaceValue.queue;
  // One arrival is handled once, even while the caller still holds the request; a later arrival for the same item starts after null.
  const handledFocusRef = useRef<number | null>(null);
  useEffect(() => {
    if (focusItemId === undefined || focusItemId === null) {
      handledFocusRef.current = null;
      return;
    }
    if (!listedOnce || handledFocusRef.current === focusItemId) return;
    handledFocusRef.current = focusItemId;
    const item = items.find((each) => each.id === focusItemId);
    const sessions = new Set([item?.runSessionId, ...(runState[focusItemId]?.sessionIds ?? [])].filter((id): id is string => id !== undefined));
    if (item && approvalQueue.some((request) => request.sessionId !== undefined && sessions.has(request.sessionId))) {
      showSteps(focusItemId);
    } else {
      setDetailId(focusItemId);
      setDetailOpensLatestRun(true);
    }
    onFocusConsumed?.();
  }, [focusItemId, onFocusConsumed, listedOnce, items, runState, approvalQueue, showSteps]);

  const appendToDetail = useCallback(async (id: number, text: string): Promise<boolean> => {
    const item = items.find((each) => each.id === id);
    if (!item) return false;
    const detail = item.detail ? `${item.detail}\n\n${text}` : text;
    if (detail.length > DESCRIPTION_MAX) return false;
    const result = await api.updateWorkBoardItem(id, { detail });
    if ("ok" in result && result.ok === false) return false;
    await refresh();
    return true;
  }, [api, items, refresh]);

  // A finished run may have written engine fields (plan/output/runStatus) onto
  // the item; re-list so the board view reflects the persisted run result.
  // The engine does NOT emit `itemChanged` for run-field writes (those are not
  // board-lifecycle mutations), so the run terminal markers drive this refresh.
  useEffect(() => {
    if (typeof api.onWorkBoardRunFinished !== "function") return undefined;
    const unsub = api.onWorkBoardRunFinished(() => {
      void refresh();
    });
    return unsub;
  }, [api, refresh]);

  // 확인 필요 actions. Proposals go through their own accept/dismiss channels; an accepted proposal becomes an ordinary item, and
  // "추가하고 계획" hands its id to the host's plan → approve → execute run (the plugin supplied nothing executable).
  const approvalActions = useMemo<WorkApprovalActions>(() => ({
    acceptProposal: async (proposalId, projectRoot) => {
      if (typeof api.acceptWorkProposal !== "function") return { ok: false, error: "no-store" };
      const result = await api.acceptWorkProposal(proposalId, projectRoot);
      if (mountedRef.current) await refresh();
      if ("status" in result && result.status === "accepted") return { ok: true, itemId: result.itemId };
      // The store's invalid reason is its own sentence (an item limit, a project refusal); a missing proposal has a code of its own.
      if ("status" in result && result.status === "invalid") return { ok: false, error: "proposal-refused", message: result.reason };
      if ("status" in result) return { ok: false, error: "proposal-not-found" };
      return { ok: false, error: result.error };
    },
    dismissProposal: async (proposalId) => {
      if (typeof api.dismissWorkProposal !== "function") return { ok: false, error: "no-store" };
      const result = await api.dismissWorkProposal(proposalId);
      if ("status" in result && result.status === "dismissed") return { ok: true };
      if ("status" in result) return { ok: false, error: "proposal-not-found" };
      return { ok: false, error: result.error };
    },
    runItem: (itemId) => runItem(itemId),
    openRoutine: (routineId) => onOpenRoutine?.(routineId),
    acknowledgeRoutineFailure: async (routineId, failureFiredAt) => {
      if (typeof api.acknowledgeRoutineFailure !== "function") return { ok: false, error: "no-store" };
      return api.acknowledgeRoutineFailure(routineId, failureFiredAt);
    },
  }), [api, onOpenRoutine, refresh, runItem]);

  const onStart = useCallback((id: number) => void handleTransition(id, "in_progress"), [handleTransition]);
  const onComplete = useCallback((id: number) => void handleComplete(id), [handleComplete]);
  const onReopen = useCallback((id: number) => void handleReopen(id), [handleReopen]);
  const onRun = useCallback((id: number) => runItem(id), [runItem]);
  const onOpenDetail = useCallback((id: number) => setDetailId(id), []);
  const onOpenRecord = useCallback((id: number) => {
    setDetailId(id);
    setDetailOpensLatestRun(true);
  }, []);
  const cardActions = useMemo<CardActions>(() => ({
    onStart,
    onComplete,
    onReopen,
    onRun,
    onOpenDetail,
    onShowSteps: showSteps,
    stepsShowingId: stepsOpen ? stepsItemId : null,
    toolApprovals,
    approvalSurface,
  }), [onStart, onComplete, onReopen, onRun, onOpenDetail, showSteps, stepsOpen, stepsItemId, toolApprovals, approvalSurface]);

  // Below the narrow panel width the overview's columns become status tabs and the step panel docks below the board.
  const [statusTab, setStatusTab] = useState<"planned" | "in-progress" | "completed">("in-progress");
  // The board's share of a narrow pane; the docked panel takes the rest and needs room for its run list, log and composer.
  const [dockPercent, setDockPercent] = useState(40);

  // The board's own global controls. They sat beside the heading this panel no longer draws; the pane's header carries them
  // now. What is left in the body is the state they act on — the count — not a control.
  usePaneActions(useMemo(() => [
    {
      id: "work-board-live-steps",
      label: t("workBoard.liveStepsPanelTitle"),
      icon: <ListTree className="h-4 w-4" />,
      active: stepsOpen,
      onSelect: () => setStepsOpen((open) => !open),
    },
    {
      id: "work-board-add",
      label: t("workBoard.addItemButton"),
      icon: <Plus className="h-4 w-4" />,
      onSelect: () => setShowCreate(true),
    },
    {
      id: "work-board-refresh",
      label: t("workBoard.refreshButton"),
      icon: <RefreshCw className="h-4 w-4" />,
      onSelect: () => void refresh(),
    },
  ], [refresh, stepsOpen]));

  // Schedule cards for each column; the board shows them unless 스케줄 같이 보기 is off for this project.
  const plannedSchedule: BoardColumnProps["schedule"] = {
    count: scheduleCards.planned.length,
    countKey: "workBoard.columnCountWithSchedule",
    cards: scheduleCards.planned.map((card) => ({
      key: card.routine.id,
      atMs: Date.parse(card.nextAt),
      node: <PlannedScheduleCardView key={`schedule:${card.routine.id}`} card={card} onOpen={openScheduleItem} />,
    })),
  };
  const runningSchedule: BoardColumnProps["schedule"] = {
    count: scheduleCards.running.length,
    countKey: "workBoard.columnCountWithSchedule",
    cards: scheduleCards.running.map((card) => ({
      key: card.routine.id,
      atMs: Date.parse(card.firedAt),
      node: <RunningScheduleCardView key={`schedule:${card.routine.id}`} card={card} onOpenSession={onOpenSession} />,
    })),
  };
  const weekSchedule: BoardColumnProps["schedule"] = {
    count: scheduleCards.week.total,
    countKey: "workBoard.columnCountWithScheduleRuns",
    // This week's summary leads the column.
    cards: scheduleCards.week.total === 0 && scheduleCards.week.skipped.length === 0 ? [] : [{
      key: "week", atMs: Number.NEGATIVE_INFINITY,
      node: <ScheduleWeekBundle key="schedule:week" week={scheduleCards.week} onOpen={openScheduleItem} />,
    }],
  };

  const renderColumn = (
    heading: string,
    columnItems: WorkItemResolved[],
    emptyLabel: string,
    testId: string,
    schedule?: BoardColumnProps["schedule"],
    narrow = false,
  ) => (
    <BoardColumn
      heading={heading}
      items={columnItems}
      runState={runState}
      emptyLabel={emptyLabel}
      loading={loading}
      actions={cardActions}
      testId={testId}
      narrow={narrow}
      schedule={showSchedule ? schedule : undefined}
    />
  );

  // The window's one decision path for every card the board draws: the same request, the same signed decide, wherever it is shown.
  const decideHead = (head: ApprovalRequest) => (choice: Parameters<typeof approvalSurfaceValue.decide>[1], pattern?: string, extras?: Parameters<typeof approvalSurfaceValue.decide>[3]) => {
    void approvalSurfaceValue.decide(head.id, choice, pattern, extras);
  };
  const renderApproval = (entry: LiveRunEntry) => {
    const head = entry.approvals[0];
    if (!head) return null;
    return (
      <ApprovalLaneCard
        queue={entry.approvals}
        conversationLabel={entry.item.title}
        proposedChoice={approvalSurfaceValue.proposal?.requestId === head.id ? approvalSurfaceValue.proposal.choice : null}
        onDecide={decideHead(head)}
        onOpenPermanentDeny={approvalSurfaceValue.openPermanentDeny}
        interactionLocked={approvalSurfaceValue.lockedRequestId === head.id}
        reviewerSuggestion={approvalSurfaceValue.reviewerSuggestion}
      />
    );
  };
  // Dialog mode: one card over the board for every run's approvals, in the window queue's order.
  const dialogQueue = approvalSurface === "dialog"
    ? approvalSurfaceValue.queue.filter((request) => [...toolApprovals.values()].some((list) => list.includes(request)))
    : [];
  const dialogHead = dialogQueue[0];
  const dialogItem = dialogHead ? items.find((item) => toolApprovals.get(item.id)?.includes(dialogHead)) : undefined;

  const stepsPanel = stepsOpen ? (
    <LiveRunPanel
      entries={liveEntries}
      selectedId={stepsItemId}
      onSelect={setStepsItemId}
      autoFollow={autoFollow}
      onAutoFollowChange={setAutoFollow}
      pinned={pinned}
      onPinnedChange={setPinned}
      onClose={() => setStepsOpen(false)}
      approvalSurface={approvalSurface}
      renderApproval={renderApproval}
      onSteer={steer}
      onStop={stop}
      onRerun={onRun}
      onOpenRecord={onOpenRecord}
      onAppendToDetail={appendToDetail}
      captureIntent={() => api.captureUserKeyboardIntent()}
    />
  ) : null;

  const columns = narrow ? (
    <div className="flex min-h-[20rem] flex-1 flex-col gap-2" data-testid="work-board-columns" data-layout="tabs">
      <div role="tablist" aria-label={t("workBoard.panelTitle")} data-testid="work-board-status-tabs" className="flex shrink-0 gap-1">
        {([
          ["planned", t("workBoard.columnPlanned"), planned.length],
          ["in-progress", t("workBoard.columnInProgress"), inProgress.length],
          ["completed", t("workBoard.columnCompleted"), completed.length],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={statusTab === key}
            className={`rounded-md px-2.5 py-1 text-xs ${statusTab === key ? "bg-muted font-semibold text-foreground" : "text-muted-foreground hover:bg-muted/(--opacity-half)"}`}
            onClick={() => setStatusTab(key)}
            data-testid={`work-board-tab-${key}`}
          >
            {label} <span className="tabular-nums">{count}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {statusTab === "planned" && renderColumn(t("workBoard.columnPlanned"), planned, t("workBoard.emptyPlanned"), "work-board-column-planned", plannedSchedule, true)}
        {statusTab === "in-progress" && renderColumn(t("workBoard.columnInProgress"), inProgress, t("workBoard.emptyInProgress"), "work-board-column-in-progress", runningSchedule, true)}
        {statusTab === "completed" && renderColumn(t("workBoard.columnCompleted"), completed, t("workBoard.emptyCompleted"), "work-board-column-completed", weekSchedule, true)}
      </div>
    </div>
  ) : (
    // The columns fill whatever height the proposals and reports leave (flex-1) but never drop below a usable floor; when the bands
    // take the room, the scroller overflows and scrolls instead. The floor must be explicit: with min-h-0 the grid absorbed the whole
    // deficit and squashed the columns to their headers, and with no min-height the grid's content minimum grows it to every card so
    // the columns never scroll internally. The breakpoint is the board's own width (container query), not the window's: a split tile
    // or a narrow window holds three columns only when the board itself is wide enough. Stacked below it, each column gets its own
    // fixed row.
    <div
      className="grid flex-1 auto-rows-[20rem] gap-3 @2xl:min-h-[20rem] @2xl:auto-rows-auto @2xl:grid-cols-3"
      data-testid="work-board-columns"
    >
      {renderColumn(t("workBoard.columnPlanned"), planned, t("workBoard.emptyPlanned"), "work-board-column-planned", plannedSchedule)}
      {renderColumn(t("workBoard.columnInProgress"), inProgress, t("workBoard.emptyInProgress"), "work-board-column-in-progress", runningSchedule)}
      {renderColumn(t("workBoard.columnCompleted"), completed, t("workBoard.emptyCompleted"), "work-board-column-completed", weekSchedule)}
    </div>
  );

  const boardBody = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <p className="min-w-0 text-sm text-muted-foreground">{t("workBoard.panelDescription")}</p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Label className="flex items-center gap-1.5 whitespace-nowrap text-xs">
            <Checkbox
              checked={showSchedule}
              onCheckedChange={(c) => {
                const show = c === true;
                setShowSchedule(show);
                writeShowSchedule(projectRoot, show);
              }}
              data-testid="work-board-show-schedule"
            />
            <span>{t("workBoard.showSchedule")}</span>
          </Label>
          {onOpenSchedule && (
            <Button type="button" variant="link" size="sm" className="h-auto px-0 text-xs" onClick={onOpenSchedule}>
              {t("workBoard.openSchedule")}
            </Button>
          )}
          <Badge variant="outline" className="whitespace-nowrap" title={t("workBoard.panelTitle")} data-testid="work-board-item-count">
            {t("workBoard.itemCount", { count: items.length })}
          </Badge>
        </div>
      </div>
      <div className="@container flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {narrow && (
          <div role="tablist" className="flex gap-1" data-testid="work-board-tabs">
            {/* Spec case 17: [개요 | 확인 필요 N]; which one is selected first is decided above, not by the order. */}
            <Button
              role="tab"
              size="sm"
              variant={narrowTab === "overview" ? "default" : "outline"}
              aria-selected={narrowTab === "overview"}
              onClick={() => setNarrowTab("overview")}
              data-testid="work-board-tab-overview"
            >
              {t("workApprovals.tabOverview")}
            </Button>
            <Button
              role="tab"
              size="sm"
              variant={narrowTab === "approvals" ? "default" : "outline"}
              aria-selected={narrowTab === "approvals"}
              onClick={() => setNarrowTab("approvals")}
              data-testid="work-board-tab-approvals"
            >
              {t("workApprovals.tabApprovals", { count: approvalCount ?? 0 })}
            </Button>
          </div>
        )}
        {/* The stack stays mounted on the overview tab, only hidden: it owns the list subscription that counts the tab, and unmounting
            it before its first response would leave the count empty and the tab stuck on overview. It takes a focus request only while
            shown; the request itself switches the narrow layout to this tab first. */}
        <div hidden={stackHidden} data-testid="work-board-approvals-region">
          <WorkApprovalStack
            api={api}
            project={project}
            actions={approvalActions}
            focusKey={stackHidden ? undefined : approvalFocusKey}
            onFocusConsumed={onApprovalFocusConsumed}
            showAllRequest={stackHidden ? undefined : approvalShowAll}
            onShowAllConsumed={onApprovalShowAllConsumed}
            onCountChange={setApprovalCount}
          />
        </div>
        {(!narrow || narrowTab === "overview") && (
          <>
            {columns}
            <div className="border-t pt-4">
              <ReportsSection api={api} project={project} />
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <>
      <div
        ref={setPanelNode}
        className={`relative mx-auto flex min-h-0 min-w-0 flex-1 w-full overflow-hidden ${stepsOpen ? "" : "max-w-6xl"} ${narrow ? "flex-col" : "flex-row"}`}
        data-testid="work-board-panel"
        data-narrow={narrow ? "true" : undefined}
        data-layout={narrow ? "narrow" : "wide"}
      >
        {stepsPanel && narrow ? (
          <VerticalSplitLayout
            topPercent={dockPercent}
            onDragChange={setDockPercent}
            onCommit={setDockPercent}
            top={boardBody}
            bottom={stepsPanel}
            ariaLabel={t("workBoard.liveStepsResize")}
            testId="work-board-docked"
            separatorTestId="work-board-dock-separator"
          />
        ) : (
          <>
            {boardBody}
            {stepsPanel && (
              <div className="ml-3 flex w-[300px] shrink-0 flex-col overflow-hidden rounded-lg border" data-testid="work-board-steps-column">
                {stepsPanel}
              </div>
            )}
          </>
        )}
        {dialogHead && (
          <ApprovalDock
            queue={dialogQueue}
            conversationLabel={dialogItem?.title ?? t("workBoard.panelTitle")}
            proposedChoice={approvalSurfaceValue.proposal?.requestId === dialogHead.id ? approvalSurfaceValue.proposal.choice : null}
            onDecide={decideHead(dialogHead)}
            onOpenPermanentDeny={approvalSurfaceValue.openPermanentDeny}
            interactionLocked={approvalSurfaceValue.lockedRequestId === dialogHead.id}
            reviewerSuggestion={approvalSurfaceValue.reviewerSuggestion}
          />
        )}
      </div>

      {showCreate && (
        <WorkItemCreateDialog
          api={api}
          project={project}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      )}
      {detailId !== null && (
        <WorkItemDetailDialog
          api={api}
          itemId={detailId}
          run={runState[detailId]}
          openLatestRun={detailOpensLatestRun}
          onClose={() => {
            setDetailId(null);
            setDetailOpensLatestRun(false);
          }}
          onChanged={() => {
            setDetailId(null);
            setDetailOpensLatestRun(false);
            void refresh();
          }}
          onRun={onRun}
        />
      )}
    </>
  );
}
