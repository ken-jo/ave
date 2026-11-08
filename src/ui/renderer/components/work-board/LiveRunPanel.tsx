import { Loader } from "../../../../components/ui/loader.js";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Pin,
  Square,
  X,
  XCircle,
} from "lucide-react";
import { t } from "../../../../i18n/runtime.js";
import { Button } from "../../../../components/ui/button.js";
import type { ApprovalRequest } from "../../types.js";
import type { WorkBoardCancelIpcResult, WorkBoardSteerIpcResult, WorkItemResolved } from "../../../../shared/work-board-types.js";
import type { WorkBoardToolApprovalSurface } from "../../../../shared/work-board-types.js";
import type { UserKeyboardIntentSnapshot } from "../../../../shared/chat-origin.js";
import { PARENT_DIRECTIVE_MAX_CHARS } from "../../../../shared/parent-directive-limits.js";
import { errorMessage } from "../../../../shared/error-message.js";
import {
  currentPhaseTurn,
  formatElapsed,
  isRunInFlight,
  useNowTick,
  type RunSteer,
  type RunToolStep,
  type RunTurn,
  type WorkItemRunState,
} from "../../hooks/use-work-board-run.js";

export const LIVE_STEP_PANEL_ID = "live-step-panel";

/** One run the panel can show: the item, its live state, and the tool approvals the board draws for it. */
export interface LiveRunEntry {
  item: WorkItemResolved;
  run: WorkItemRunState;
  approvals: readonly ApprovalRequest[];
}

type SteerReply = WorkBoardSteerIpcResult | { ok: false; error: string };
type StopReply = WorkBoardCancelIpcResult | { ok: false; error: string };

export interface LiveRunPanelProps {
  entries: readonly LiveRunEntry[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  autoFollow: boolean;
  onAutoFollowChange: (next: boolean) => void;
  pinned: boolean;
  onPinnedChange: (next: boolean) => void;
  onClose: () => void;
  approvalSurface: WorkBoardToolApprovalSurface;
  /** Draws `entry`'s head tool approval with the window's approval card (chat mode only). */
  renderApproval: (entry: LiveRunEntry) => ReactNode;
  onSteer: (id: number, text: string, userIntent: UserKeyboardIntentSnapshot) => Promise<SteerReply>;
  onStop: (id: number) => Promise<StopReply>;
  onRerun: (id: number) => void;
  /** Open the item's detail on its latest run record. */
  onOpenRecord: (id: number) => void;
  /** Append `text` to the item's description; resolves false when the update was refused. */
  onAppendToDetail: (id: number, text: string) => Promise<boolean>;
  /** The keyboard intent of the gesture now being handled. */
  captureIntent: () => UserKeyboardIntentSnapshot;
}

function localClock(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The item's current run history entry, when the listed item carries it. */
function currentHistory(item: WorkItemResolved) {
  const last = item.runHistory?.at(-1);
  return last && last.runId === item.runId ? last : undefined;
}

function executingTurns(run: WorkItemRunState): RunTurn[] {
  return run.turns.filter((turn) => turn.phase === "executing");
}

function lastExecutingTurn(run: WorkItemRunState): number {
  return executingTurns(run).at(-1)?.turn ?? 0;
}

/** The phase word for a run-list row. Exhaustive over the phases, so a new one must decide how its row reads. */
function rowStatus(entry: LiveRunEntry): { text: string; tone: "live" | "attention" | "neutral" | "danger" | "success" } {
  const { run } = entry;
  if (run.stopping) return { text: t("workBoard.liveRowStopping"), tone: "neutral" };
  if (entry.approvals.length > 0) return { text: t("workBoard.liveRowToolApproval"), tone: "attention" };
  const phase = run.phase;
  switch (phase) {
    case undefined:
      return { text: t("workBoard.liveChipStarting"), tone: "live" };
    case "planning": {
      const turn = currentPhaseTurn(run);
      return { text: turn === undefined ? t("workBoard.liveChipPlanning") : t("workBoard.liveRowPlanningTurn", { turn }), tone: "live" };
    }
    case "awaiting_approval":
      return { text: t("workBoard.liveRowPlanApproval"), tone: "attention" };
    case "executing": {
      const turn = currentPhaseTurn(run);
      return { text: turn === undefined ? t("workBoard.liveChipExecuting") : t("workBoard.liveChipTurn", { turn }), tone: "live" };
    }
    case "done":
      return { text: t("workBoard.liveRowDone"), tone: "success" };
    case "denied":
      return { text: t("workBoard.runDenied"), tone: "danger" };
    case "error":
      return { text: t("workBoard.liveRowFailed"), tone: "danger" };
    case "cancelled":
      return { text: t("workBoard.runCancelled"), tone: "neutral" };
    default: {
      const unhandled: never = phase;
      throw new Error(`unhandled work board run phase: ${String(unhandled)}`);
    }
  }
}

const TONE_TEXT: Record<ReturnType<typeof rowStatus>["tone"], string> = {
  live: "text-muted-foreground",
  attention: "text-warning",
  neutral: "text-muted-foreground",
  danger: "text-destructive",
  success: "text-success",
};

function RowIcon({ entry }: { entry: LiveRunEntry }) {
  const { run } = entry;
  if (run.stopping) return <Loader size={14} className="text-muted-foreground" />;
  if (entry.approvals.length > 0 || run.phase === "awaiting_approval") {
    return <span aria-hidden="true" className="mx-[3px] h-2 w-2 shrink-0 rounded-full bg-warning" />;
  }
  switch (run.phase) {
    case "done":
      return <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-success" />;
    case "cancelled":
      return <CircleStop aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
    case "error":
      return <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-destructive" />;
    case "denied":
      return <XCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-destructive" />;
    default:
      return <Loader size={14} className="text-muted-foreground" />;
  }
}

/** "12:21 시작 · 경과 4:12 · 실행 2턴째 · 지시 1" while in flight; start, end, length and turns once it settled. */
function SummaryLine({ entry }: { entry: LiveRunEntry }) {
  const { item, run } = entry;
  const inFlight = isRunInFlight(run);
  const now = useNowTick(inFlight);
  const history = currentHistory(item);
  const startedAt = history?.startedAt;
  const startMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const parts: string[] = [];
  if (startedAt) parts.push(t("workBoard.liveSummaryStarted", { time: localClock(startedAt) }));
  if (inFlight) {
    if (Number.isFinite(startMs)) parts.push(t("workBoard.liveSummaryElapsed", { elapsed: formatElapsed(now - startMs) }));
    const turn = currentPhaseTurn(run);
    if (turn !== undefined) {
      parts.push(run.phase === "planning"
        ? t("workBoard.liveRowPlanningTurn", { turn })
        : t("workBoard.liveSummaryTurn", { turn }));
    }
  } else {
    const endedAt = history?.endedAt;
    if (endedAt) {
      parts.push(run.phase === "cancelled"
        ? t("workBoard.liveSummaryStopped", { time: localClock(endedAt) })
        : t("workBoard.liveSummaryEnded", { time: localClock(endedAt) }));
      const endMs = Date.parse(endedAt);
      if (Number.isFinite(startMs) && Number.isFinite(endMs)) parts.push(formatElapsed(endMs - startMs));
    }
    const turns = lastExecutingTurn(run);
    if (turns > 0) parts.push(t("workBoard.liveSummaryTurns", { count: turns }));
  }
  if (run.steers.length > 0) parts.push(t("workBoard.liveSummarySteers", { count: run.steers.length }));
  return (
    <p className="truncate text-dense tabular-nums text-muted-foreground" data-testid="live-step-summary" title={parts.join(" · ")}>
      {parts.join(" · ")}
    </p>
  );
}

type Segment = { label: string; state: "done" | "active" | "idle" | "attention" | "stopping" | "danger" | "stopped" };

function segments(entry: LiveRunEntry): [Segment, Segment, Segment] {
  const { run } = entry;
  const phase = run.phase;
  const planDone: Segment = { label: t("workBoard.liveStepPlanDone"), state: "done" };
  const approved: Segment = { label: t("workBoard.liveStepApproved"), state: "done" };
  switch (phase) {
    case undefined:
    case "planning":
      return [
        { label: t("workBoard.liveStepPlan"), state: "active" },
        { label: t("workBoard.liveStepApproval"), state: "idle" },
        { label: t("workBoard.liveStepExecute"), state: "idle" },
      ];
    case "awaiting_approval":
      return [planDone, { label: t("workBoard.liveStepApproval"), state: "attention" }, { label: t("workBoard.liveStepExecute"), state: "idle" }];
    case "executing":
      if (run.stopping) return [planDone, approved, { label: t("workBoard.liveStepStopping"), state: "stopping" }];
      if (entry.approvals.length > 0) return [planDone, approved, { label: t("workBoard.liveStepToolApproval"), state: "attention" }];
      return [planDone, approved, { label: t("workBoard.liveStepExecuting"), state: "active" }];
    case "done":
      return [planDone, approved, { label: t("workBoard.liveStepDone"), state: "done" }];
    case "denied":
      return [planDone, { label: t("workBoard.liveStepDenied"), state: "danger" }, { label: t("workBoard.liveStepExecute"), state: "idle" }];
    case "error":
      return [planDone, approved, { label: t("workBoard.liveStepFailed"), state: "danger" }];
    case "cancelled":
      return [planDone, approved, { label: t("workBoard.runCancelled"), state: "stopped" }];
    default: {
      const unhandled: never = phase;
      throw new Error(`unhandled work board run phase: ${String(unhandled)}`);
    }
  }
}

const SEGMENT_BAR: Record<Segment["state"], string> = {
  done: "bg-foreground",
  active: "bg-foreground animate-pulse motion-reduce:animate-none",
  idle: "bg-border",
  attention: "bg-warning",
  stopping: "bg-muted-foreground",
  danger: "bg-destructive",
  stopped: "bg-muted-foreground",
};

function StepBar({ entry }: { entry: LiveRunEntry }) {
  return (
    <ol className="mt-2 grid grid-cols-3 gap-1.5" data-testid="live-step-bar">
      {segments(entry).map((segment, index) => (
        <li key={index} className="min-w-0" data-state={segment.state}>
          <span aria-hidden="true" className={`block h-0.5 rounded-full ${SEGMENT_BAR[segment.state]}`} />
          <span
            className={`mt-1 block truncate text-tiny ${
              segment.state === "attention" ? "text-warning" : segment.state === "danger" ? "text-destructive" : segment.state === "idle" ? "text-muted-foreground" : "font-medium text-foreground"
            }`}
          >
            {segment.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function formatToolDuration(ms: number): string {
  if (ms < 60_000) return t("workBoard.liveToolSeconds", { seconds: (Math.round(ms / 100) / 10).toFixed(1) });
  return formatElapsed(ms);
}

function toolStatusText(status: RunToolStep["status"]): string {
  switch (status) {
    case "running":
      return t("workBoard.liveToolRunning");
    case "done":
      return t("workBoard.liveToolDone");
    case "error":
      return t("workBoard.liveToolError");
    case "cancelled":
      return t("workBoard.liveToolCancelled");
    default: {
      const unhandled: never = status;
      throw new Error(`unhandled work board tool step status: ${String(unhandled)}`);
    }
  }
}

function ToolStepRow({ step }: { step: RunToolStep }) {
  const running = step.status === "running";
  const now = useNowTick(running);
  const started = step.startedAt;
  const elapsed = running && started !== undefined ? formatElapsed(now - started) : step.durationMs !== undefined ? formatToolDuration(step.durationMs) : "";
  const icon = running
    ? <Loader size={12} className="text-muted-foreground" />
    : step.status === "done"
    ? <Check aria-hidden="true" className="h-3 w-3 shrink-0 text-success" />
    : step.status === "error"
    ? <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0 text-destructive" />
    : <CircleStop aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />;
  const label = step.label ?? step.name;
  return (
    <li className="flex min-w-0 items-center gap-1.5 text-dense text-muted-foreground" data-testid="live-step-tool" data-status={step.status}>
      {icon}
      <span className="sr-only">{toolStatusText(step.status)}</span>
      <span className="min-w-0 flex-1 truncate font-mono" title={label}>{label}</span>
      {elapsed && <span className="shrink-0 tabular-nums">{elapsed}</span>}
    </li>
  );
}

function SteerBubble({ steer }: { steer: RunSteer }) {
  const status = steer.status === "delivered"
    ? t("workBoard.liveSteerDelivered", { turn: steer.turn ?? 0 })
    : steer.status === "dropped"
    ? steer.reason === "joined-limit" ? t("workBoard.liveSteerDroppedJoinedLimit") : t("workBoard.liveSteerDroppedTurnEnded")
    : t("workBoard.liveSteerSent");
  return (
    <li className="ml-6 min-w-0 rounded-md border border-primary/(--opacity-medium) bg-primary/(--opacity-subtle) px-2.5 py-1.5" data-testid="live-step-steer" data-status={steer.status}>
      <p className="text-tiny font-medium text-primary">
        <span className="tabular-nums">{localClock(steer.sentAt)}</span> · {t("workBoard.liveSteerYou")}
      </p>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-foreground [overflow-wrap:anywhere]">{steer.text}</p>
      <p className={`mt-1 text-tiny ${steer.status === "dropped" ? "text-destructive" : "text-muted-foreground"}`}>{status}</p>
    </li>
  );
}

function TurnRow({ turn, current, tools }: { turn: RunTurn; current: boolean; tools: readonly RunToolStep[] }) {
  const [expanded, setExpanded] = useState(false);
  const textId = useId();
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [turn.text, expanded, current]);
  return (
    <li className="relative min-w-0 pl-4" data-testid="live-step-turn" data-current={current ? "true" : undefined}>
      <span
        aria-hidden="true"
        className={`absolute left-0 top-1 h-2 w-2 rounded-full border ${current ? "border-foreground bg-foreground" : "border-muted-foreground bg-background"}`}
      />
      <p className={`text-dense tabular-nums ${current ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
        {localClock(turn.at)} · {t("workBoard.liveTurnLabel", { turn: turn.turn })}
        {current && ` · ${t("workBoard.liveTurnNow")}`}
      </p>
      <p
        id={textId}
        ref={textRef}
        className={`mt-0.5 whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere] ${
          current ? "rounded-md bg-muted px-2 py-1.5 text-foreground" : "text-muted-foreground"
        } ${expanded ? "" : current ? "line-clamp-4" : "line-clamp-1"}`}
        title={current ? undefined : turn.text}
      >
        {turn.text}
      </p>
      {current && (overflows || expanded) && (
        <button
          type="button"
          className="mt-0.5 text-dense text-primary underline-offset-2 hover:underline"
          aria-expanded={expanded}
          aria-controls={textId}
          onClick={() => setExpanded((v) => !v)}
          data-testid="live-step-turn-expand"
        >
          {expanded ? t("workBoard.liveTurnCollapse") : t("workBoard.liveTurnExpand")}
        </button>
      )}
      {tools.length > 0 && (
        <ul className="mt-1 space-y-0.5" aria-label={t("workBoard.liveToolsLabel")}>
          {tools.map((step) => <ToolStepRow key={step.toolUseId} step={step} />)}
        </ul>
      )}
    </li>
  );
}

function PlanRow({ entry }: { entry: LiveRunEntry }) {
  const { item, run } = entry;
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const planningTurns = run.turns.filter((turn) => turn.phase === "planning");
  const planText = run.plan?.text ?? item.plan;
  const planTools = run.tools.filter((step) => step.phase === "planning");
  const firstLine = planText?.split("\n").find((line) => line.trim() !== "")?.trim();
  const from = planningTurns[0]?.at ?? run.phaseAt.planning;
  const to = run.plan?.at ?? run.phaseAt.awaiting_approval;
  const range = [localClock(from), localClock(to)].filter(Boolean).join("–");
  return (
    <div className="rounded-md border bg-muted/(--opacity-light)" data-testid="live-step-plan">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left text-dense"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight aria-hidden="true" className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="font-semibold text-foreground">{t("workBoard.livePlanRow")}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {[planningTurns.length > 0 ? t("workBoard.livePlanTurns", { count: planningTurns.length }) : null, firstLine].filter(Boolean).join(" · ")}
        </span>
        {range && <span className="shrink-0 tabular-nums text-muted-foreground">{range}</span>}
      </button>
      {open && (
        <div id={bodyId} className="space-y-2 border-t px-2 py-2">
          {planText && (
            <p className="whitespace-pre-wrap break-words text-xs text-foreground [overflow-wrap:anywhere]" data-testid="live-step-plan-text">{planText}</p>
          )}
          {planningTurns.length > 0 && (
            <ol className="space-y-1.5">
              {planningTurns.map((turn) => (
                <TurnRow key={turn.turn} turn={turn} current={false} tools={planTools.filter((step) => step.turn === turn.turn)} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/** The run's step log: plan, the approval decision, then each executing turn with its tool steps and the steers it took. */
function StepLog({ entry, approvalSurface, renderApproval }: Pick<LiveRunPanelProps, "approvalSurface" | "renderApproval"> & { entry: LiveRunEntry }) {
  const { run } = entry;
  const phase = run.phase;
  const turns = executingTurns(run);
  const lastTurn = turns.at(-1)?.turn;
  const live = isRunInFlight(run);
  const pastPlanning = phase !== undefined && phase !== "planning";
  const approvedPlan = phase === "executing" || phase === "done" || phase === "error" || phase === "cancelled";
  const steersBefore = (turn: number) => run.steers.filter((steer) => steer.status === "delivered" && steer.turn === turn);
  const trailingSteers = run.steers.filter((steer) => steer.status !== "delivered" || lastTurn === undefined || (steer.turn ?? 0) > lastTurn);
  const showApproval = approvalSurface === "chat" && entry.approvals.length > 0;
  return (
    <div className="space-y-2" data-testid="live-step-log">
      {pastPlanning ? (
        <PlanRow entry={entry} />
      ) : (
        <PlanningLog run={run} />
      )}
      {phase === "awaiting_approval" && (
        <p className="flex items-center gap-1.5 text-dense text-warning" data-testid="live-step-plan-awaiting">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />
          {t("workBoard.livePlanAwaiting")}
        </p>
      )}
      {approvedPlan && (
        <p className="flex items-center gap-1.5 text-dense text-muted-foreground" data-testid="live-step-plan-approved">
          <Check aria-hidden="true" className="h-3 w-3" />
          {run.phaseAt.executing && <span className="tabular-nums">{localClock(run.phaseAt.executing)} ·</span>}
          {t("workBoard.livePlanApproved")}
        </p>
      )}
      {phase === "denied" && (
        <p className="text-dense text-destructive" data-testid="live-step-plan-denied">{t("workBoard.liveDeniedNarration")}</p>
      )}
      {approvedPlan && (
        <section aria-label={t("workBoard.liveExecHeading")}>
          <h4 className="mb-1 text-dense font-semibold text-muted-foreground">{t("workBoard.liveExecHeading")}</h4>
          <ol className="space-y-2">
            {turns.map((turn) => (
              <TurnBlock key={turn.turn} turn={turn} steers={steersBefore(turn.turn)} current={live && turn.turn === lastTurn} tools={run.tools.filter((step) => step.phase === "executing" && step.turn === turn.turn)} />
            ))}
            {turns.length === 0 && live && (
              <li className="rounded-md border border-dashed px-2 py-2 text-dense text-muted-foreground">{t("workBoard.liveNarrationWaiting")}</li>
            )}
            {trailingSteers.map((steer) => <SteerBubble key={steer.messageId} steer={steer} />)}
          </ol>
        </section>
      )}
      {showApproval && (
        <div className="space-y-1.5" data-testid="live-step-approval">
          <p className="text-dense text-warning">{t("workBoard.liveApprovalWaiting")}</p>
          {renderApproval(entry)}
        </div>
      )}
      {run.stopping && (
        <p className="text-dense text-muted-foreground" data-testid="live-step-stop-requested">{t("workBoard.liveStopRequested")}</p>
      )}
      <SettledFooter entry={entry} />
    </div>
  );
}

function TurnBlock({ turn, steers, current, tools }: { turn: RunTurn; steers: readonly RunSteer[]; current: boolean; tools: readonly RunToolStep[] }) {
  return (
    <>
      {steers.map((steer) => <SteerBubble key={steer.messageId} steer={steer} />)}
      <TurnRow turn={turn} current={current} tools={tools} />
    </>
  );
}

/** Before the plan is ready, the planning turns are the log. */
function PlanningLog({ run }: { run: WorkItemRunState }) {
  const turns = run.turns.filter((turn) => turn.phase === "planning");
  const tools = run.tools.filter((step) => step.phase === "planning");
  if (turns.length === 0) {
    return <p className="rounded-md border border-dashed px-2 py-2 text-dense text-muted-foreground" data-testid="live-step-waiting">{t("workBoard.liveNarrationWaiting")}</p>;
  }
  const last = turns.at(-1)?.turn;
  return (
    <ol className="space-y-2">
      {turns.map((turn) => (
        <TurnRow key={turn.turn} turn={turn} current={turn.turn === last} tools={tools.filter((step) => step.turn === turn.turn)} />
      ))}
    </ol>
  );
}

function SettledFooter({ entry }: { entry: LiveRunEntry }) {
  const { item, run } = entry;
  const turns = lastExecutingTurn(run);
  switch (run.phase) {
    case "cancelled":
      return (
        <p className="rounded-md bg-muted px-2 py-1.5 text-dense text-muted-foreground" data-testid="live-step-cancelled">
          {t("workBoard.liveCancelledNarration", { turns })}
        </p>
      );
    case "error":
      return (
        <div className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-2 py-1.5 text-dense" data-testid="live-step-failed">
          {run.reason && <p className="break-words text-destructive [overflow-wrap:anywhere]">{run.reason}</p>}
          <p className="mt-0.5 text-muted-foreground">{t("workBoard.liveFailedNote", { turns })}</p>
        </div>
      );
    case "done":
      return item.output ? (
        <div className="rounded-md border px-2 py-1.5" data-testid="live-step-result">
          <p className="text-dense font-semibold text-foreground">{t("workBoard.liveResultHeading")}</p>
          <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{item.output}</p>
        </div>
      ) : null;
    default:
      return null;
  }
}

/** Refusal copy for a steer the host did not queue (spec table G5). `user-gesture-required` is a programming error: the composer only
 * sends from a key or a click, so it is thrown, never shown. */
function steerRefusalText(reply: Extract<SteerReply, { ok: false }>): string {
  if ("error" in reply) return t("workBoard.liveSteerFailed", { reason: reply.error });
  switch (reply.reason) {
    case "not-executing":
      return t("workBoard.liveSteerDisabled");
    case "recipient-unavailable":
      return t("workBoard.liveSteerRefusedUnavailable");
    case "pending-cap":
      return t("workBoard.liveSteerRefusedPendingCap");
    case "message-too-long":
      return t("workBoard.liveSteerRefusedTooLong", { max: PARENT_DIRECTIVE_MAX_CHARS });
    case "invalid-message":
    case "empty-text":
      return t("workBoard.liveSteerRefusedEmpty");
    case "file-reference-while-running":
    case "file-reference-invalid":
      return t("workBoard.liveSteerRefusedFile");
    case "not-found":
    case "unknown-recipient":
      return t("workBoard.liveSteerRefusedNotFound");
    case "user-gesture-required":
      throw new Error("work board steer was sent without a user gesture");
    default: {
      const unhandled: never = reply.reason;
      throw new Error(`unhandled work board steer refusal: ${String(unhandled)}`);
    }
  }
}

type ComposerStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; redactedCount: number }
  | { kind: "rejected"; message: string }
  | { kind: "appended" }
  | { kind: "append-failed" };

/** The "실행 중 지시" composer and the stop control. Collapsed to one line until focused; Enter sends, Shift+Enter breaks a line, Esc
 * collapses an empty composer. A refused steer keeps its text and offers to add it to the task description instead. */
function SteerComposer({ entry, onSteer, onStop, onAppendToDetail, captureIntent }: Pick<LiveRunPanelProps, "onSteer" | "onStop" | "onAppendToDetail" | "captureIntent"> & { entry: LiveRunEntry }) {
  const { item, run } = entry;
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [status, setStatus] = useState<ComposerStatus>({ kind: "idle" });
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const [stopPending, setStopPending] = useState(false);
  const inputId = useId();
  const noteId = useId();
  const itemId = item.id;

  const executing = run.phase === "executing";
  const stopping = run.stopping || stopPending;
  const canSteer = executing && !stopping;
  const expanded = focused || text !== "" || status.kind === "rejected";
  const tooLong = text.length > PARENT_DIRECTIVE_MAX_CHARS;
  const rejected = status.kind === "rejected";

  const send = (userIntent: UserKeyboardIntentSnapshot) => {
    const body = text;
    if (!canSteer || body.trim() === "" || tooLong || status.kind === "sending") return;
    setStatus({ kind: "sending" });
    void onSteer(itemId, body, userIntent).then((reply) => {
      if (reply.ok) {
        setText("");
        setStatus({ kind: "sent", redactedCount: reply.redactedCount ?? 0 });
      } else {
        setStatus({ kind: "rejected", message: steerRefusalText(reply) });
      }
    }, (err: unknown) => {
      setStatus({ kind: "rejected", message: t("workBoard.liveSteerFailed", { reason: errorMessage(err) }) });
    });
  };

  const append = () => {
    const body = text;
    void onAppendToDetail(itemId, body).then((ok) => {
      if (ok) {
        setText("");
        setStatus({ kind: "appended" });
      } else {
        setStatus({ kind: "append-failed" });
      }
    }, () => setStatus({ kind: "append-failed" }));
  };

  const stop = () => {
    setStopNotice(null);
    setStopPending(true);
    void onStop(itemId).then((reply) => {
      if (reply.ok) return;
      setStopNotice("error" in reply
        ? t("workBoard.liveStopFailed", { reason: reply.error })
        : reply.reason === "not-running"
        ? t("workBoard.liveStopNotRunning")
        : reply.reason === "not-executing"
        ? t("workBoard.liveStopPlanningNote")
        : t("workBoard.liveStopFailed", { reason: reply.reason }));
    }, (err: unknown) => {
      setStopNotice(t("workBoard.liveStopFailed", { reason: errorMessage(err) }));
    }).finally(() => setStopPending(false));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!rejected) send(captureIntent());
      return;
    }
    if (event.key === "Escape" && text === "") {
      event.currentTarget.blur();
    }
  };

  const note = !executing
    ? t("workBoard.liveStopPlanningNote")
    : entry.approvals.length > 0
    ? t("workBoard.liveApprovalNote")
    : t("workBoard.liveSteerNote");

  return (
    <div className="space-y-1.5" data-testid="live-step-composer">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-dense font-semibold text-foreground">{t("workBoard.liveSteerLabel")}</label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-dense"
          disabled={!executing || stopping}
          aria-busy={stopping || undefined}
          onClick={stop}
          data-testid="live-step-stop"
        >
          {stopping ? <Loader size={12} className="mr-1" /> : <Square aria-hidden="true" className="mr-1 h-3 w-3 fill-current" />}
          {stopping ? t("workBoard.liveStopping") : t("workBoard.liveStop")}
        </Button>
      </div>
      <div
        className={`rounded-md border bg-background ${rejected ? "border-destructive" : focused ? "ring-2 ring-ring" : "border-border"}`}
      >
        <textarea
          id={inputId}
          className="block w-full resize-none bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          rows={expanded ? 2 : 1}
          value={text}
          disabled={!canSteer && !rejected}
          placeholder={canSteer ? t("workBoard.liveSteerPlaceholder") : t("workBoard.liveSteerDisabled")}
          aria-describedby={noteId}
          aria-invalid={rejected || tooLong || undefined}
          onChange={(event) => {
            setText(event.target.value);
            if (status.kind !== "sending") setStatus({ kind: "idle" });
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          data-testid="live-step-steer-input"
        />
        {expanded && (
          <div className="flex items-center justify-between gap-2 border-t px-2 py-1">
            <span className={`text-tiny tabular-nums ${tooLong ? "text-destructive" : "text-muted-foreground"}`} data-testid="live-step-steer-count">
              {t("workBoard.liveSteerCounter", { count: text.length, max: PARENT_DIRECTIVE_MAX_CHARS })}
            </span>
            {rejected ? (
              <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-dense" disabled={text.trim() === ""} onClick={append} data-testid="live-step-append">
                {t("workBoard.liveAppendToDetail")}
              </Button>
            ) : (
              <span className="flex items-center gap-2">
                <span className="text-tiny text-muted-foreground">{t("workBoard.liveSteerEnterHint")}</span>
                <Button
                  type="button"
                  size="sm"
                  className="h-6 px-2 text-dense"
                  disabled={!canSteer || text.trim() === "" || tooLong || status.kind === "sending"}
                  onClick={() => send(captureIntent())}
                  data-testid="live-step-steer-send"
                >
                  {t("workBoard.liveSteerSend")}
                </Button>
              </span>
            )}
          </div>
        )}
      </div>
      <p id={noteId} className="text-tiny text-muted-foreground" data-testid="live-step-composer-note">{note}</p>
      {status.kind === "sent" && (
        <p className="text-dense text-muted-foreground" role="status" data-testid="live-step-steer-sent">
          {status.redactedCount > 0 ? t("workBoard.liveSteerSentRedacted", { count: status.redactedCount }) : t("workBoard.liveSteerSentNotice")}
        </p>
      )}
      {status.kind === "rejected" && (
        <p className="text-dense text-destructive" role="alert" data-testid="live-step-steer-error">{status.message}</p>
      )}
      {status.kind === "appended" && (
        <p className="text-dense text-muted-foreground" role="status" data-testid="live-step-appended">{t("workBoard.liveAppendDone")}</p>
      )}
      {status.kind === "append-failed" && (
        <p className="text-dense text-destructive" role="alert" data-testid="live-step-append-error">{t("workBoard.liveAppendFailed")}</p>
      )}
      {stopNotice && <p className="text-dense text-muted-foreground" role="status" data-testid="live-step-stop-notice">{stopNotice}</p>}
    </div>
  );
}

/** Settled runs end with what to do next instead of a composer. */
function SettledActions({ entry, onRerun }: { entry: LiveRunEntry; onRerun: (id: number) => void }) {
  const { item, run } = entry;
  return (
    <div className="space-y-1.5" data-testid="live-step-settled-actions">
      {run.phase === "cancelled" && <p className="text-dense text-muted-foreground">{t("workBoard.liveCancelledFooter")}</p>}
      {item.status !== "completed" && (
        <Button type="button" size="sm" variant="outline" className="h-7 w-full text-xs" onClick={() => onRerun(item.id)} data-testid="live-step-rerun">
          {t("workBoard.liveRerun")}
        </Button>
      )}
    </div>
  );
}

/**
 * The live step panel beside the board: the run conversation of a work item. It lists the runs in flight (and the followed one after it
 * settles while pinned), and shows the selected run's plan, turns, tool steps, steers, its tool approval card in chat mode, and the steer
 * composer with the stop control.
 */
export function LiveRunPanel(props: LiveRunPanelProps) {
  const { entries, selectedId, onSelect, autoFollow, onAutoFollowChange, pinned, onPinnedChange, onClose, onRerun, onOpenRecord } = props;
  const selected = entries.find((entry) => entry.item.id === selectedId) ?? null;
  const autoFollowId = useId();
  return (
    <aside
      id={LIVE_STEP_PANEL_ID}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
      aria-label={t("workBoard.liveStepsPanelTitle")}
      data-testid="live-step-panel"
    >
      <header className="flex shrink-0 items-center gap-1 border-b px-3 py-2">
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold">{t("workBoard.liveStepsPanelTitle")}</h3>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={`h-6 w-6 ${pinned ? "bg-muted" : ""}`}
          aria-pressed={pinned}
          aria-label={t("workBoard.liveStepsPin")}
          title={t("workBoard.liveStepsPin")}
          onClick={() => onPinnedChange(!pinned)}
          data-testid="live-step-pin"
        >
          <Pin className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label={t("workBoard.liveStepsClose")}
          title={t("workBoard.liveStepsClose")}
          onClick={onClose}
          data-testid="live-step-close"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>
      <div className="shrink-0 border-b px-2 py-1.5">
        {entries.length === 0 ? (
          <p className="px-1 py-1 text-dense text-muted-foreground" data-testid="live-step-empty">{t("workBoard.liveStepsEmpty")}</p>
        ) : (
          <ul className="max-h-40 space-y-0.5 overflow-y-auto" aria-label={t("workBoard.liveStepsRunList")} data-testid="live-step-runs">
            {entries.map((entry) => {
              const status = rowStatus(entry);
              const current = entry.item.id === selectedId;
              return (
                <li key={entry.item.id}>
                  <button
                    type="button"
                    className={`flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left text-xs ${current ? "bg-muted font-medium" : "hover:bg-muted/(--opacity-half)"}`}
                    aria-current={current ? "true" : undefined}
                    onClick={() => onSelect(entry.item.id)}
                    data-testid="live-step-run-row"
                    data-item-id={entry.item.id}
                  >
                    <RowIcon entry={entry} />
                    <span className="min-w-0 flex-1 truncate">{entry.item.title}</span>
                    <span className={`shrink-0 text-tiny ${TONE_TEXT[status.tone]}`}>{status.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <label htmlFor={autoFollowId} className="mt-1 flex items-center gap-1.5 px-1 text-dense text-muted-foreground">
          <input
            id={autoFollowId}
            type="checkbox"
            className="h-3 w-3 accent-current"
            checked={autoFollow}
            onChange={(event) => onAutoFollowChange(event.target.checked)}
            data-testid="live-step-auto-follow"
          />
          {t("workBoard.liveStepsAutoFollow")}
        </label>
      </div>
      {selected && (
        <>
          <div className="shrink-0 border-b px-3 py-2">
            <p className="truncate text-xs font-semibold" title={selected.item.title}>{selected.item.title}</p>
            <SummaryLine entry={selected} />
            <StepBar entry={selected} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="live-step-body">
            <StepLog entry={selected} approvalSurface={props.approvalSurface} renderApproval={props.renderApproval} />
          </div>
          <footer className="shrink-0 space-y-2 border-t px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="text-dense text-foreground underline underline-offset-2"
                onClick={() => onOpenRecord(selected.item.id)}
                data-testid="live-step-open-record"
              >
                {t("workBoard.liveOpenRecord")}
              </button>
              {selected.run.phase === "done" && selected.item.output && (
                <button
                  type="button"
                  className="text-dense text-primary underline-offset-2 hover:underline"
                  onClick={() => onOpenRecord(selected.item.id)}
                  data-testid="live-step-open-result"
                >
                  {t("workBoard.liveOpenResult")}
                </button>
              )}
            </div>
            {isRunInFlight(selected.run) ? (
              // Keyed by run: another run's composer is a new one, so a late reply to this one's steer or stop cannot land on it.
              <SteerComposer
                key={`${selected.item.id}:${selected.item.runId ?? ""}`}
                entry={selected}
                onSteer={props.onSteer}
                onStop={props.onStop}
                onAppendToDetail={props.onAppendToDetail}
                captureIntent={props.captureIntent}
              />
            ) : (
              <SettledActions entry={selected} onRerun={onRerun} />
            )}
          </footer>
        </>
      )}
    </aside>
  );
}
