/** Shared routine contracts must remain renderer-safe; the main store re-exports them without pulling filesystem modules into renderer bundles. */

export const MAX_PERSISTED_ROUTINES = 50;

/** Session routines have a tighter cap because each fire starts a model loop and can incur cost. */
export const MAX_LLM_SESSION_ROUTINES = 10;

/** Bound source identity at both the scheduling tool and store to prevent persisted-file bloat. */
export const MAX_ROUTINE_SOURCE_LENGTH = 140;

export type RoutineExecution = "llm-session" | "notification-only";

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
  /** Clear on fire and set only after session creation; result rehydration must not guess a session by date. */
  lastRoutineSessionId?: string;
  dismissedAt?: string;
  /** Persist the UTC-minute dedup key so restart cannot fire the same cron occurrence again. */
  lastFiredMinuteUTC?: string;
  /** Origin doubles as idempotency identity; suggestions use suggestion:<pluginId>:<intent>, and manual creation leaves it unset. */
  source?: string;
}

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
