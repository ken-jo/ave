/** Persist round and ceiling together so restarts retain the revival budget; derive ceiling exhaustion rather than storing a competing status. */
import { isRecord } from "./is-record.js";

const SESSION_GOAL_STATUSES = ["running", "paused", "complete"] as const;

type SessionGoalStatus = (typeof SESSION_GOAL_STATUSES)[number];

export interface SessionGoal {
  text: string;
  status: SessionGoalStatus;
  round: number;
  /** Revival budget. Raised when the user chooses to continue past it. */
  ceiling: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Revivals granted when a goal is registered, and added again each time the
 * user chooses to continue past the ceiling.
 */
export const SESSION_GOAL_CEILING = 50;

/** Longest goal text kept. Longer input is refused, never silently trimmed. */
export const MAX_SESSION_GOAL_CHARS = 2000;

function isSessionGoalStatus(value: unknown): value is SessionGoalStatus {
  return typeof value === "string"
    && (SESSION_GOAL_STATUSES as readonly string[]).includes(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isSessionGoal(value: unknown): value is SessionGoal {
  return (
    isRecord(value)
    && typeof value.text === "string"
    && value.text.length > 0
    && isSessionGoalStatus(value.status)
    && isCount(value.round)
    && isCount(value.ceiling)
    && value.ceiling > 0
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
  );
}

/** The budget is spent: the user has to say whether the session keeps going. */
export function isSessionGoalAtCeiling(goal: SessionGoal): boolean {
  return goal.round >= goal.ceiling;
}

/** Main and renderer share this predicate so the displayed running state matches actual revival eligibility. */
export function canReviveSessionGoal(goal: SessionGoal): boolean {
  return goal.status === "running" && !isSessionGoalAtCeiling(goal);
}
