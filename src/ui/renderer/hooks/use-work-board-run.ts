import { useCallback, useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import type {
  RunProgressEventPayload,
  RunTranscriptEvent,
  WorkBoardCancelIpcResult,
  WorkBoardRunToolStep,
  WorkBoardSteerAck,
  WorkBoardSteerIpcResult,
  WorkItemResolved,
  WorkItemRunResult,
  WorkItemRunStatus,
} from "../../../shared/work-board-types.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
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

/** One tool step of a phase's child, as the host reported it: a short masked label, never the tool's input. */
export interface RunToolStep extends WorkBoardRunToolStep {
  phase: TurnPhase;
}

/** A steer the user sent this run. The text is the renderer's own copy of what it sent; the status comes only from the host: `sent` is
 * queued, `delivered` names the turn that took it, `dropped` says the child's turn ended (or its joined limit was reached) first. */
export interface RunSteer {
  messageId: string;
  text: string;
  sentAt: string;
  status: "sent" | "delivered" | "dropped";
  turn?: number;
  reason?: Extract<WorkBoardSteerAck, { status: "dropped" }>["reason"];
  redactedCount?: number;
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
  /** Every phase child's session this run reported, in link order: the sessions whose tool approvals the board draws. */
  sessionIds: string[];
  /** Tool steps of both phases, in the order they started. */
  tools: RunToolStep[];
  /** Steers sent during this run, oldest first. */
  steers: RunSteer[];
  /** The user's stop was accepted and the run has not settled yet. Renderer-local: the host reports nothing between the two (G6). */
  stopping: boolean;
  /** The approved-or-pending plan, once the transcript carried it. */
  plan?: { text: string; at: string };
  /** When each phase began, from the first event this board saw in it. */
  phaseAt: Partial<Record<RunPhase, string>>;
}

export type RunStateMap = Record<number, WorkItemRunState | undefined>;

const EMPTY_RUN: WorkItemRunState = { busy: false, turns: [], sessionIds: [], tools: [], steers: [], stopping: false, phaseAt: {} };

/** Keep only the last this many tool steps per phase, as the host does. */
const TOOL_STEPS_PER_PHASE = 40;

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

/** Merge tool steps by phase and id: a step already listed is updated in place, a new one is appended; each phase keeps its latest
 * {@link TOOL_STEPS_PER_PHASE}. */
function mergeTools(existing: readonly RunToolStep[], incoming: readonly RunToolStep[]): RunToolStep[] {
  const key = (step: RunToolStep) => `${step.phase}:${step.toolUseId}`;
  const byKey = new Map(existing.map((step) => [key(step), step]));
  for (const step of incoming) byKey.set(key(step), step);
  const merged = [...byKey.values()];
  const kept: RunToolStep[] = [];
  for (const phase of ["planning", "executing"] as const) {
    kept.push(...merged.filter((step) => step.phase === phase).slice(-TOOL_STEPS_PER_PHASE));
  }
  return kept;
}

function withSession(ids: readonly string[], id: string | undefined): string[] {
  return id === undefined || ids.includes(id) ? [...ids] : [...ids, id];
}

function applySteerAck(steers: readonly RunSteer[], ack: WorkBoardSteerAck): RunSteer[] {
  return steers.map((steer) => {
    if (steer.messageId !== ack.messageId) return steer;
    return ack.status === "delivered"
      ? { ...steer, status: "delivered", turn: ack.turn, reason: undefined }
      : { ...steer, status: "dropped", reason: ack.reason, turn: undefined };
  });
}

function transcriptTools(events: readonly RunTranscriptEvent[]): RunToolStep[] {
  const rows: RunToolStep[] = [];
  for (const ev of events) {
    if (ev.kind !== "tool" || ev.tool === undefined || !isActivePhase(ev.phase)) continue;
    rows.push({ ...ev.tool, phase: ev.phase });
  }
  return rows;
}

function transcriptPlan(events: readonly RunTranscriptEvent[]): { text: string; at: string } | undefined {
  const plan = events.findLast((ev) => ev.kind === "plan" && typeof ev.text === "string");
  return plan ? { text: plan.text ?? "", at: plan.ts } : undefined;
}

function transcriptPhaseAt(events: readonly RunTranscriptEvent[]): Partial<Record<RunPhase, string>> {
  const at: Partial<Record<RunPhase, string>> = {};
  for (const ev of events) at[ev.phase] ??= ev.ts;
  return at;
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
 * Which steer acknowledgements a board can still apply. It tracks only the steers this board sent: an ack is held early (it can race
 * ahead of its steer's own reply) only while this board has a steer to that item in flight, and is dropped once no reply of this board
 * can claim it. A recorded steer leaves once its ack arrives, once its item's next run starts, or when the board unmounts. It is kept past
 * its run's end, because a steer dropped as the turn ended can be acknowledged after the run settled. Held outside React state: an
 * updater runs only at flush, and a reply landing before that flush must still find the early ack.
 */
export class SteerAckBook {
  private readonly early = new Map<string, { itemId: number; ack: WorkBoardSteerAck }>();
  private readonly recorded = new Map<string, number>();
  private readonly inFlight = new Map<number, number>();

  beginSend(itemId: number): void {
    this.inFlight.set(itemId, (this.inFlight.get(itemId) ?? 0) + 1);
  }

  /** The send's reply came back (or threw). Once none of this board's sends to the item is in flight, held acks were another board's. */
  endSend(itemId: number): void {
    const left = (this.inFlight.get(itemId) ?? 0) - 1;
    if (left > 0) {
      this.inFlight.set(itemId, left);
      return;
    }
    this.inFlight.delete(itemId);
    for (const [messageId, entry] of this.early) if (entry.itemId === itemId) this.early.delete(messageId);
  }

  /** The reply named this send's message: returns the ack that already arrived for it, or records it to await one. */
  onReply(itemId: number, messageId: string): WorkBoardSteerAck | undefined {
    const early = this.early.get(messageId)?.ack;
    this.early.delete(messageId);
    if (early === undefined) this.recorded.set(messageId, itemId);
    return early;
  }

  /** "apply" for a recorded steer of this board (delivered and dropped are both final, so it leaves); "held" while a send to the item is in
   * flight; "ignored" for another board's steer. */
  onAck(itemId: number, ack: WorkBoardSteerAck): "apply" | "held" | "ignored" {
    if (this.recorded.delete(ack.messageId)) return "apply";
    if ((this.inFlight.get(itemId) ?? 0) > 0) {
      this.early.set(ack.messageId, { itemId, ack });
      return "held";
    }
    return "ignored";
  }

  forgetItem(itemId: number): void {
    for (const [messageId, entry] of this.early) if (entry.itemId === itemId) this.early.delete(messageId);
    for (const [messageId, owner] of this.recorded) if (owner === itemId) this.recorded.delete(messageId);
  }

  clear(): void {
    this.early.clear();
    this.recorded.clear();
    this.inFlight.clear();
  }

  /** Entries still held, for the bound's test. */
  get size(): number {
    return this.early.size + this.recorded.size + this.inFlight.size;
  }
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
  /** Send a steer to the item's execute child. A queued steer is recorded as `sent`; a refusal records nothing. */
  steer: (
    id: number,
    text: string,
    userIntent: UserKeyboardIntentSnapshot | undefined,
  ) => Promise<WorkBoardSteerIpcResult | { ok: false; error: string }>;
  /** Ask the host to stop the item's execution. An accepted stop holds `stopping` until the run settles. */
  stop: (id: number) => Promise<WorkBoardCancelIpcResult | { ok: false; error: string }>;
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
  // Acknowledgements that arrived before their steer's own reply, applied when the reply records the steer. Which steers the reply already
  // recorded is tracked here too, outside any state updater: an updater runs only at flush, so a reply landing between an ack and that
  // flush would find no early ack and leave the steer "sent" forever.
  const steerBookRef = useRef(new SteerAckBook());
  useEffect(() => {
    const book = steerBookRef.current;
    return () => book.clear();
  }, []);
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
      // The previous run's steers are no longer drawn: nothing can be acknowledged onto them.
      steerBookRef.current.forgetItem(id);
      update(id, () => ({ ...EMPTY_RUN, ...next }));
    },
    [update],
  );

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    if (typeof api.onWorkBoardRunProgress === "function") {
      unsubs.push(
        api.onWorkBoardRunProgress((ev: RunProgressEventPayload) => {
          // A steer acknowledgement reports nothing else, and may arrive after the run settled: never the run's phase.
          const ack = ev.steer;
          if (ack !== undefined) {
            if (steerBookRef.current.onAck(ev.itemId, ack) === "apply") {
              update(ev.itemId, (cur) => ({ ...cur, steers: applySteerAck(cur.steers, ack) }));
            }
            return;
          }
          // A tool step update is not a phase entry either; it only revises that phase's steps.
          const tools = ev.tools;
          if (tools !== undefined) {
            const phase = ev.phase;
            if (!isActivePhase(phase)) throw new Error(`work-board tool steps reported in phase ${phase}`);
            update(ev.itemId, (cur) => ({ ...cur, tools: mergeTools(cur.tools, tools.map((step) => ({ ...step, phase }))) }));
            return;
          }
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
              sessionIds: withSession(cur.sessionIds, ev.runSessionId),
              phaseAt: cur.phaseAt[phase] === undefined ? { ...cur.phaseAt, [phase]: ev.at } : cur.phaseAt,
              // A terminal phase ends the in-flight window even if runFinished is late.
              busy: !isTerminalPhase(phase),
              stopping: isTerminalPhase(phase) ? false : cur.stopping,
            };
          });
          // A child's link event (it carries the session and no turn) is not a phase entry: the phase's own entry event already re-listed.
          if (ev.turn === undefined && ev.runSessionId === undefined && (isActivePhase(ev.phase) || ev.phase === "awaiting_approval")) {
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
          patch(itemId, { busy: false, stopping: false, phase: phaseForRunResult(status) });
        }),
      );
    }
    if (typeof api.onWorkBoardRunFailed === "function") {
      unsubs.push(
        api.onWorkBoardRunFailed(({ itemId, reason }) => {
          patch(itemId, { busy: false, stopping: false, phase: "error", reason });
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
          const events = "events" in result ? result.events : [];
          update(itemId, (cur) => {
            const seeded = cur.phase === undefined ? { busy: true, phase: storedPhase } : {};
            return {
              ...cur,
              ...seeded,
              turns: mergeTurns(cur.turns, transcriptTurns(events)),
              // Live steps are newer than the transcript's finished rows, so they win.
              tools: mergeTools(transcriptTools(events), cur.tools),
              plan: cur.plan ?? transcriptPlan(events),
              phaseAt: { ...transcriptPhaseAt(events), ...cur.phaseAt },
            };
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

  const steer = useCallback(
    async (id: number, text: string, userIntent: UserKeyboardIntentSnapshot | undefined) => {
      if (typeof api.steerWorkBoardRun !== "function") throw new Error("steerWorkBoardRun is not exposed to this window");
      const sentAt = new Date().toISOString();
      const book = steerBookRef.current;
      book.beginSend(id);
      try {
        const result = await api.steerWorkBoardRun(id, text, userIntent);
        if (result.ok) {
          const { messageId } = result;
          const early = book.onReply(id, messageId);
          update(id, (cur) => {
            const sent: RunSteer = { messageId, text, sentAt, status: "sent", redactedCount: result.redactedCount };
            const steers = [...cur.steers, sent];
            return { ...cur, steers: early ? applySteerAck(steers, early) : steers };
          });
        }
        return result;
      } finally {
        book.endSend(id);
      }
    },
    [api, update],
  );

  const stop = useCallback(
    async (id: number) => {
      if (typeof api.cancelWorkBoardRun !== "function") throw new Error("cancelWorkBoardRun is not exposed to this window");
      const result = await api.cancelWorkBoardRun(id);
      if (result.ok) {
        // The terminal phase may already have landed while the stop was in flight; only a live run starts stopping.
        update(id, (cur) => (isRunInFlight(cur) ? { ...cur, stopping: true } : cur));
      }
      return result;
    },
    [api, update],
  );

  return { runState, runItem, steer, stop };
}
