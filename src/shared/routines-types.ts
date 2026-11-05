/** Shared routine contracts must remain renderer-safe; the main store re-exports them without pulling filesystem modules into renderer bundles. */

export const MAX_PERSISTED_ROUTINES = 50;

/** Session routines have a tighter cap because each fire starts a model loop and can incur cost. */
export const MAX_LLM_SESSION_ROUTINES = 10;

/** Bound source identity at both the scheduling tool and store to prevent persisted-file bloat. */
export const MAX_ROUTINE_SOURCE_LENGTH = 140;

export type RoutineExecution = "llm-session" | "notification-only";

/** Bound a persisted failure reason so a long provider error cannot bloat routines.json. */
export const MAX_ROUTINE_FAILURE_REASON_LENGTH = 500;

/**
 * The latest fire whose run did not complete. `error`: the run threw; `reason` is the masked, home-redacted, bounded message.
 * `shutdown-timeout`: a shutdown routine was cut off at quit; the renderer words it. A later successful run of a newer fire clears it;
 * acknowledging that same fire's result marks it seen.
 */
export type RoutineFailure =
  & {
    /** lastFiredAt of the failed occurrence; outcomes and acknowledgements for any other fire are ignored. */
    firedAt: string;
    /** When the failure was recorded. */
    at: string;
    acknowledgedAt?: string;
  }
  & ({ kind: "error"; reason: string } | { kind: "shutdown-timeout" });

/** How one fire's run ended, as reported to the store. */
export type RoutineRunOutcome = { ok: true } | { ok: false; kind: "error"; reason: string } | { ok: false; kind: "shutdown-timeout" };

/** Missing plugin scope means deny-all; inherit must be explicit and snapshots active plugins at fire time. */
type RoutinePluginScope =
  | { mode: "deny-all" }
  | { mode: "allow"; ids: string[] }
  | { mode: "inherit" };

/** Never copy allowed plugin IDs into forcedPluginIds: allowed plugins may be inactive, while forced plugins must activate. */
export interface RoutineScope {
  pluginIds: RoutinePluginScope;
  forcedPluginIds: string[];
  directories: string[];
}

export type RepeatKind =
  | "none"
  | "daily"
  | "weekly"
  | "monthly"
  | "interval"
  | "cron";

export type RoutineRepeat =
  | { kind: "none" }
  | { kind: "daily" }
  | { kind: "weekly" }
  | { kind: "monthly" }
  | { kind: "interval"; intervalMs: number }
  | { kind: "cron"; expression: string };

export interface RoutineSchedule {
  /** ISO timestamp for the first (or one-time) fire. */
  at?: string;
  repeat?: RoutineRepeat;
}

export interface RoutineRecord {
  id: string;
  trigger: "shutdown" | "schedule";
  schedule?: RoutineSchedule;
  execution: RoutineExecution;
  /** System prompt injected when execution === "llm-session". */
  prePrompt?: string;
  title?: string;
  /** Shown as OS notification title when execution === "notification-only". */
  notificationTitle?: string;
  /** Shown as OS notification body when execution === "notification-only". */
  notificationBody?: string;
  /** Missing scope normalizes to deny-all; the store rejects non-canonical scope fields. */
  scope?: RoutineScope;
  createdAt: string;
  lastFiredAt?: string;
  /** Latest scheduled occurrence skipped because every named plugin was absent. */
  lastSkippedReason?: "plugins-missing";
  /** UTC minute of a skipped cron occurrence; distinct from a completed fire. */
  lastSkippedMinuteUTC?: string;
  /** Installed registry ids are checked independently of runtime load state. */
  needsAttention?: { missingPluginIds: string[] };
  /** If this differs from lastFiredAt, rehydrate the unseen result card on next launch. */
  lastResultAcknowledgedAt?: string;
  /** Persisted run failure; the scheduler only logged failures before, so a restart lost them. */
  lastFailure?: RoutineFailure;
  /** Clear on fire and set only after session creation; result rehydration must not guess a session by date. */
  lastRoutineSessionId?: string;
  dismissedAt?: string;
  /** Persist the UTC-minute dedup key so restart cannot fire the same cron occurrence again. */
  lastFiredMinuteUTC?: string;
  /** Origin doubles as idempotency identity; suggestions use suggestion:<pluginId>:<intent>, and manual creation leaves it unset. */
  source?: string;
  /** The project the schedule panel lists this item under. Items stored before projects existed have none and show in every project. */
  projectRoot?: string;
  /** Who added it. Records stored before this field have none. */
  createdBy?: RoutineActor;
  /** Pause is reversible, unlike dismissedAt: a paused item is never due and does not catch up when resumed. */
  pausedAt?: string;
  pausedBy?: RoutineActor;
  /** When the item was last resumed. A one-shot whose time is at or before it was missed while paused: it is not due, the grid
   * shows it as missed, and only 지금 실행 or a new time runs it. */
  resumedAt?: string;
  /** 대화에 연결: the chat a run enters as a turn instead of opening a new chat. Only an LLM item on a schedule has one. */
  targetSessionId?: string;
  /** Set when the connected chat was deleted (대화 없음). The item never runs until the user relinks it, unlinks it to run in a new
   * chat, or deletes it; there is no silent switch to a new chat. */
  orphanedAt?: string;
}

export type RoutineActor = "user" | "agent";

/** A user edit from the schedule panel. `title: null` clears the title; a schedule replaces the whole schedule. */
export interface RoutineEditPatch {
  title?: string | null;
  prePrompt?: string;
  notificationTitle?: string;
  notificationBody?: string;
  schedule?: RoutineSchedule;
  /** A chat to connect (or relink) to; null unlinks, so runs open a new chat again. */
  targetSessionId?: string | null;
}

/** One projected future fire for the schedule grids. */
export interface RoutineOccurrence {
  routineId: string;
  at: string;
  status: "scheduled" | "paused" | "missed" | "orphaned";
}

/** One past fire for the schedule grids; `failed` when the item's lastFailure names this fire. */
export interface RoutineRun {
  routineId: string;
  firedAt: string;
  status: "done" | "failed";
  sessionId?: string;
}

export type RoutineOccurrencesResult =
  | { ok: true; occurrences: RoutineOccurrence[]; runs: RoutineRun[]; running: Array<{ routineId: string; firedAt: string }> }
  | { ok: false; error: string };

export interface AddRoutineInput {
  trigger: "shutdown" | "schedule";
  schedule?: RoutineSchedule;
  execution: RoutineExecution;
  prePrompt?: string;
  title?: string;
  notificationTitle?: string;
  notificationBody?: string;
  /** Omitted scope defaults to deny-all with empty forced plugins and directories; inheritance requires explicit opt-in. */
  scope?: RoutineScope;
  source?: string;
  /** Required on every new item; only records stored before projects existed have none. */
  projectRoot: string;
  /** The renderer path always records "user"; the routine_schedule tool records "agent". */
  createdBy: RoutineActor;
  /** 대화에 연결 (optional): the chat each run enters. */
  targetSessionId?: string;
}

/** Allow-list renderer payload fields; spreading the record could expose prePrompt and other private data. */
export interface RoutineFiredPayload {
  id: string;
  trigger: "shutdown" | "schedule";
  execution: RoutineExecution;
  firedAt: string;
  title: string;
  summary: string;
  routineSessionId?: string;
}

/** Invalid plugin IDs block execution; retain the stored routine unchanged until user removal. */
export interface InvalidRoutine {
  id: string;
  field: string;
  value: string;
  reason: "invalid-plugin-id";
}

export interface RoutineListResult {
  routines: RoutineRecord[];
  invalid: InvalidRoutine[];
}
