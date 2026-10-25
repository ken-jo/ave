/** Public task identity is its 1-based position; persisted IDs only stabilize keys across reorders. */
import { isRecord } from "./is-record.js";

const SESSION_TASK_STATUSES = ["pending", "in_progress", "completed"] as const;

export type SessionTaskStatus = (typeof SESSION_TASK_STATUSES)[number];

export interface SessionTaskItem {
  id: string;
  content: string;
  status: SessionTaskStatus;
}

function isSessionTaskStatus(value: unknown): value is SessionTaskStatus {
  return typeof value === "string" && SESSION_TASK_STATUSES.includes(value as SessionTaskStatus);
}

export function isSessionTaskItem(value: unknown): value is SessionTaskItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.content === "string" &&
    isSessionTaskStatus(value.status)
  );
}
