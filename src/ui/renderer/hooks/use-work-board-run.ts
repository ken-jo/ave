import { useCallback, useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import type {
  RunProgressEventPayload,
  RunTranscriptEvent,
  WorkItemResolved,
  WorkItemRunResult,
  WorkItemRunStatus,
} from "../../../shared/work-board-types.js";
import { errorMessage } from "../../../shared/error-message.js";

// Run state is derived only from host events and the persisted transcript; the shared host gate owns the approval decision,
// so awaiting-approval is informational here. The board card and the step panel (LS-2) both read this one state.

export type RunPhase = RunProgressEventPayload["phase"];

/** A phase in which the child agent takes turns. */
type TurnPhase = "planning" | "executing";

/** One child-agent turn of the run. Turn numbers restart with each phase's child. */
export interface RunTurn {
  phase: TurnPhase;
  turn: number;
  text: string;
  at: string;
}

export interface WorkItemRunState {
  /** A run is in flight (between runStarted and runFinished/runFailed). */
  busy: boolean;
  /** Latest phase from the engine progress stream or the stored run status. Undefined until the run reports one. */
  phase?: RunPhase;
  /** Every turn of the current run, ordered planning before executing, then by turn number. */
  turns: RunTurn[];
  /** Terminal failure / denial reason (error / denied phase or runFailed). */
  reason?: string;
  /** Child session id, once an event or the run result carried it. */
  runSessionId?: string;
}

export type RunStateMap = Record<number, WorkItemRunState | undefined>;

const EMPTY_RUN: WorkItemRunState = { busy: false, turns: [] };

/** Phases that should show an active spinner. */
function isActivePhase(phase: RunPhase | undefined): phase is TurnPhase {
  return phase === "planning" || phase === "executing";
}

/** Terminal phases end the in-flight window; every phase is named so a new one cannot silently read as in flight or as finished.
 * `cancelled` is a run the user stopped (owner decision 2026-11-04): terminal, and never an error. */
export function isTerminalPhase(phase: RunPhase): boolean {
  switch (phase) {
    case "planning":
    case "awaiting_approval":
    case "executing":
      return false;
    case "done":
    case "denied":
    case "error":
    case "cancelled":
      return true;
    default: {
      const unhandled: never = phase;
      throw new Error(`unhandled work-board run phase: ${String(unhandled)}`);
    }
  }
}

/** The phase a terminal run result settles the card in. already_running started nothing here, so it leaves no phase. */
function phaseForRunResult(status: WorkItemRunResult["status"]): RunPhase | undefined {
  switch (status) {
    case "completed":
      return "done";
    case "denied":
      return "denied";
    case "error":
    case "not_found":
      return "error";
    case "cancelled":
      return "cancelled";
    case "already_running":
      return undefined;
    default: {
      const unhandled: never = status;
      throw new Error(`unhandled work-board run result: ${String(unhandled)}`);
    }
  }
}

/** True while the run is in flight (no terminal phase reached yet). */
export function isRunInFlight(run: WorkItemRunState | undefined): boolean {
  if (!run) return false;
  if (run.phase !== undefined && isTerminalPhase(run.phase)) return false;
  return run.busy || run.phase !== undefined;
}

const TURN_PHASE_RANK: Record<TurnPhase, number> = { planning: 0, executing: 1 };

/** Union two turn logs: one row per phase+turn (the first seen wins), planning before executing, then by turn number. */
function mergeTurns(existing: readonly RunTurn[], incoming: readonly RunTurn[]): RunTurn[] {
  const byKey = new Map<string, RunTurn>();
  for (const row of [...existing, ...incoming]) {
    const key = `${row.phase}:${row.turn}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()].sort(
    (a, b) => TURN_PHASE_RANK[a.phase] - TURN_PHASE_RANK[b.phase] || a.turn - b.turn,
  );
}

/** The most recent turn of the run, whatever its phase — the card's one-line narration. */
export function latestTurn(run: WorkItemRunState | undefined): RunTurn | undefined {
  return run?.turns.at(-1);
}

/** The turn number the current phase's child is on; undefined before it took one or outside a turn phase. */
export function currentPhaseTurn(run: WorkItemRunState | undefined): number | undefined {
  if (!run || !isActivePhase(run.phase)) return undefined;
  const last = run.turns.at(-1);
  return last && last.phase === run.phase ? last.turn : undefined;
}

/** Latest turn text of the current active phase — what the detail dialog shows live. */
export function liveTextOf(run: WorkItemRunState | undefined): string | undefined {
  return currentPhaseTurn(run) === undefined ? undefined : run?.turns.at(-1)?.text;
}

function transcriptTurns(events: readonly RunTranscriptEvent[]): RunTurn[] {
  const rows: RunTurn[] = [];
  for (const ev of events) {
    if (ev.kind !== "turn" || !isActivePhase(ev.phase) || typeof ev.turn !== "number") continue;
    rows.push({ phase: ev.phase, turn: ev.turn, text: ev.text ?? "", at: ev.ts });
  }
  return rows;
}

/** The progress phase a stored in-flight run status stands for; null when the stored run is not in flight. */
function inFlightPhaseOf(status: WorkItemRunStatus | undefined): RunPhase | null {
  switch (status) {
    case "planning":
    case "awaiting_approval":
    case "executing":
      return status;
    case undefined:
    case "idle":
    case "completed":
    case "denied":
    case "error":
    case "cancelled":
      return null;
    default: {
      const unhandled: never = status;
      throw new Error(`unhandled work item run status: ${String(unhandled)}`);
    }
  }
}

/** When the item's current run began, from its run history. Only a stored in-flight run whose last history entry is that run
 * has a start; a board still holding the previous run's history has none rather than a wrong one. */
export function runStartedAt(item: WorkItemResolved): string | undefined {
  if (inFlightPhaseOf(item.runStatus) === null) return undefined;
  const last = item.runHistory?.at(-1);
  if (!last || last.runId !== item.runId) return undefined;
  return last.startedAt;
}

/** Elapsed run time as m:ss, or h:mm:ss from an hour on. Never negative. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Wall-clock milliseconds, re-read once a second only while `active`. */
export function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Subscribe to the four host run channels in ONE effect with a single cleanup, and backfill any run the listed items say is
 * in flight from its persisted transcript. Returns the per-item run state map plus a `runItem` launcher. The launcher
 * optimistically seeds `busy` so the card shows a starting indicator instantly, even before the `runStarted` broadcast lands.
 */
export function useWorkBoardRun(
  api: AveApi,
  items: readonly WorkItemResolved[],
  /** Called when a run enters planning, plan approval or execution (a progress event with no turn): the engine has just written that
   * run's fields onto the item, so the caller re-lists. The hook owns the board's one progress subscription. */
  onPhaseEntered?: () => void,
): {
  runState: RunStateMap;
  runItem: (id: number) => void;
} {
  const [runState, setRunState] = useState<RunStateMap>({});
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Bumped whenever an item's run restarts, so a transcript read for an older run cannot land on the new one.
  const generationRef = useRef(new Map<number, number>());
  const backfilledRef = useRef(new Set<string>());
  const onPhaseEnteredRef = useRef(onPhaseEntered);
  useEffect(() => {
    onPhaseEnteredRef.current = onPhaseEntered;
  }, [onPhaseEntered]);

  const update = useCallback((id: number, fn: (cur: WorkItemRunState) => WorkItemRunState) => {
    if (!mountedRef.current) return;
    setRunState((prev) => ({ ...prev, [id]: fn(prev[id] ?? EMPTY_RUN) }));
  }, []);

  const patch = useCallback(
    (id: number, next: Partial<WorkItemRunState>) => update(id, (cur) => ({ ...cur, ...next })),
    [update],
  );

  const resetRun = useCallback(
    (id: number, next: Partial<WorkItemRunState>) => {
      const gens = generationRef.current;
      gens.set(id, (gens.get(id) ?? 0) + 1);
      update(id, () => ({ ...EMPTY_RUN, ...next }));
    },
    [update],
  );

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    if (typeof api.onWorkBoardRunProgress === "function") {
      unsubs.push(
        api.onWorkBoardRunProgress((ev: RunProgressEventPayload) => {
          update(ev.itemId, (cur) => {
            const phase = ev.phase;
            const turns =
              isActivePhase(phase) && typeof ev.turn === "number"
                ? mergeTurns(cur.turns, [{ phase, turn: ev.turn, text: ev.text ?? "", at: ev.at }])
                : cur.turns;
            return {
              ...cur,
              phase,
              turns,
              reason: phase === "error" || phase === "denied" ? ev.message : undefined,
              runSessionId: ev.runSessionId ?? cur.runSessionId,
              // A terminal phase ends the in-flight window even if runFinished is late.
              busy: !isTerminalPhase(phase),
            };
          });
          if (ev.turn === undefined && (isActivePhase(ev.phase) || ev.phase === "awaiting_approval")) {
            onPhaseEnteredRef.current?.();
          }
        }),
      );
    }
    if (typeof api.onWorkBoardRunStarted === "function") {
      unsubs.push(
        api.onWorkBoardRunStarted(({ itemId }) => {
          resetRun(itemId, { busy: true });
        }),
      );
    }
    if (typeof api.onWorkBoardRunFinished === "function") {
      unsubs.push(
        api.onWorkBoardRunFinished(({ itemId, status }) => {
          patch(itemId, {
            busy: false,
            phase: phaseForRunResult(status),
          });
        }),
      );
    }
    if (typeof api.onWorkBoardRunFailed === "function") {
      unsubs.push(
        api.onWorkBoardRunFailed(({ itemId, reason }) => {
          patch(itemId, { busy: false, phase: "error", reason });
        }),
      );
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [api, patch, resetRun, update]);

  // Backfill: a board that mounts while a run is in flight has missed its earlier turns. Read them once per run and merge
  // with whatever live events arrived meanwhile.
  useEffect(() => {
    if (typeof api.getWorkBoardRunTranscript !== "function") return;
    for (const item of items) {
      const storedPhase = inFlightPhaseOf(item.runStatus);
      if (storedPhase === null || !item.runId) continue;
      const key = `${item.id}:${item.runId}`;
      if (backfilledRef.current.has(key)) continue;
      backfilledRef.current.add(key);
      const itemId = item.id;
      const generation = generationRef.current.get(itemId) ?? 0;
      void api.getWorkBoardRunTranscript(itemId, item.runId).then(
        (result) => {
          if ((generationRef.current.get(itemId) ?? 0) !== generation) return;
          const rows = "events" in result ? transcriptTurns(result.events) : [];
          update(itemId, (cur) => {
            const seeded = cur.phase === undefined ? { busy: true, phase: storedPhase } : {};
            return { ...cur, ...seeded, turns: mergeTurns(cur.turns, rows) };
          });
        },
        (err: unknown) => {
          // The live stream still drives the card; a failed read only loses the earlier turns.
          console.warn(`[work-board] run transcript backfill failed (item ${itemId}): ${errorMessage(err)}`);
        },
      );
    }
  }, [api, items, update]);

  const runItem = useCallback(
    (id: number) => {
      if (typeof api.runWorkBoardItem !== "function") return;
      // Optimistic: show a starting indicator before runStarted lands.
      resetRun(id, { busy: true });
      void api.runWorkBoardItem(id).then((result) => {
        if (!mountedRef.current) return;
        if (result && "ok" in result && result.ok === false) {
          patch(id, { busy: false, phase: "error", reason: result.error });
          return;
        }
        if (result && "status" in result) {
          update(id, (cur) => ({
            ...cur,
            busy: false,
            phase: phaseForRunResult(result.status),
            reason: result.reason,
            runSessionId: result.runSessionId ?? cur.runSessionId,
          }));
        }
      }).catch((err: unknown) => {
        if (!mountedRef.current) return;
        patch(id, { busy: false, phase: "error", reason: errorMessage(err) });
      });
    },
    [api, patch, resetRun, update],
  );

  return { runState, runItem };
}
