



import type { ApprovalRequest } from "../permissions/approval-gate.js";

export const DEFAULT_APPROVAL_QUEUE_MAX = 50;

export type ApprovalQueueAction =
  | { type: "push"; req: ApprovalRequest; max?: number }
  | { type: "shift" }
  /** Remove host-settled prompts whose buttons can no longer answer anything. */
  | { type: "drop"; ids: readonly string[] }
  | { type: "clear" };

export function approvalQueueReducer(
  state: ApprovalRequest[],
  action: ApprovalQueueAction,
): ApprovalRequest[] {
  switch (action.type) {
    case "push": {
      const max = action.max ?? DEFAULT_APPROVAL_QUEUE_MAX;
      // Drop the newest request at capacity to preserve the current prompt and resist flooding.
      if (state.length >= max) {
        return state;
      }
      return [...state, action.req];
    }
    case "shift":
      return state.slice(1);
    case "drop": {
      const dropped = new Set(action.ids);
      const next = state.filter((req) => !dropped.has(req.id));
      return next.length === state.length ? state : next;
    }
    case "clear":
      // Queue reset is administrative only; user approvals must remain individual.
      return [];
  }


  return state;
}
