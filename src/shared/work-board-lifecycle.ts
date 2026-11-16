import type { WorkItem, WorkItemResolved, WorkItemStatusStored } from "./work-board-types.js";

/** Review is a read-time projection; the board file keeps its three lifecycle values. */
export type WorkBoardStage = WorkItemStatusStored | "review";

export const WORK_BOARD_STAGES: readonly WorkBoardStage[] = ["planned", "in_progress", "review", "completed"];

export function workBoardReviewKind(item: WorkItem): "plan" | "result" | null {
  if (item.status === "completed") return null;
  if (item.runStatus === "awaiting_approval" && item.planApproval?.status === "pending"
    && typeof item.runId === "string" && item.runId.length > 0 && item.runId === item.planApproval.runId && item.plan?.trim()) return "plan";
  if (item.runStatus === "completed" && item.output?.trim()) return "result";
  return null;
}

export function workBoardStage(item: WorkItem & Pick<WorkItemResolved, "templateRunState">): WorkBoardStage {
  switch (item.status) {
    case "planned": case "in_progress": case "completed": break;
    default: throw new Error(`Unknown stored work item status: ${String(item.status)}`);
  }
  // A template run that waits at a stage gate or on a join: the host says so on read; the row itself still says executing.
  if (item.status !== "completed" && item.templateRunState === "awaiting_review") return "review";
  if (item.status !== "completed" && (item.runStatus === "planning" || item.runStatus === "executing")) return "in_progress";
  return workBoardReviewKind(item) === null ? item.status : "review";
}

/** A stage move never starts a run or decides a plan. Those operations retain their own approval gates. */
export function workBoardMoveRefusal(item: WorkItem, target: WorkBoardStage): "moveRunActive" | "moveReviewDerived" | "movePlanDecision" | "moveResultDecision" | null {
  workBoardStage(item);
  if (!WORK_BOARD_STAGES.includes(target)) throw new Error(`Unknown work board stage: ${String(target)}`);
  if (item.runStatus === "planning" || item.runStatus === "executing") return "moveRunActive";
  if (workBoardReviewKind(item) === "plan" || item.runStatus === "awaiting_approval") return "movePlanDecision";
  if (target === "review") {
    if (item.status === "completed" && item.runStatus === "completed" && item.output?.trim()) return null;
    return "moveReviewDerived";
  }
  if (workBoardReviewKind(item) === "result" && target !== "completed") return "moveResultDecision";
  // Reopening a completed result keeps the same output, so its derived destination is Review.
  if (item.status === "completed" && item.runStatus === "completed" && item.output?.trim()) return "moveResultDecision";
  return null;
}
