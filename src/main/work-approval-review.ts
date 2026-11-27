import { maskWorkflowText } from "../work-board/workflow/run-read-projection.js";
import { isDecidablePlan, isReplanningPlan } from "./work-board-store.js";
import { projectRootEquals } from "../shared/project-identity.js";
import type { WorkItem, WorkItemResolved } from "../shared/work-board-types.js";
import type { WorkApprovalProject, WorkPlanApprovalView, WorkflowApprovalView } from "../shared/work-approvals-types.js";

// A plan belongs to its item's project, or is shared when the item has none. A plan whose project is no longer authorized (the user removed
// it) has no scope, and is neither listed nor counted anywhere.
export function planScope(item: WorkItem, projects: readonly WorkApprovalProject[]): WorkPlanApprovalView["scope"] | null {
  if (!item.projectRoot) return { type: "unscoped" };
  const project = projects.find((entry) => projectRootEquals(entry.projectRoot, item.projectRoot));
  if (!project) return null;
  return { type: "project", projectRoot: project.projectRoot, isDefault: project.isDefault };
}

export function planView(item: WorkItemResolved, projects: readonly WorkApprovalProject[]): WorkPlanApprovalView | null {
  const pending = isDecidablePlan(item);
  if (!pending && !isReplanningPlan(item)) return null;
  const approval = item.planApproval;
  if (!approval || !item.runId) return null;
  const scope = planScope(item, projects);
  if (scope === null) return null;
  return {
    kind: "plan",
    key: `plan:${item.id}`,
    scope,
    title: maskWorkflowText(item.title),
    arrivedAt: approval.requestedAt,
    itemId: item.id,
    runId: item.runId,
    planHash: approval.planHash,
    plan: maskWorkflowText(item.plan ?? ""),
    revision: approval.revision,
    ...(approval.agentName !== undefined ? { agentName: approval.agentName } : {}),
    phase: pending ? "pending" : "replanning",
    // The store's own judgement, the same one the item's detail shows.
    stale: pending && item.planStale === true,
    // The plan this card is about: the waiting one, or the one being made after a change request.
    planNumber: approval.revision + (pending ? 1 : 2),
    ...(!pending && approval.note !== undefined ? { changeRequest: maskWorkflowText(approval.note) } : {}),
  };
}

export function workflowApprovalViews(item: WorkItemResolved, projects: readonly WorkApprovalProject[]): WorkflowApprovalView[] {
  const scope = planScope(item, projects);
  if (scope === null) return [];
  return (item.pendingWorkflowDecisions ?? []).map(decision => ({
    ...decision, scope, itemId: item.id, title: maskWorkflowText(item.title),
    key: decision.kind === "stage-gate"
      ? `stage:${item.id}:${decision.binding.runId}:${decision.binding.stageId}:${decision.binding.attempt}`
      : `join:${item.id}:${decision.binding.runId}:${decision.binding.joinId}:${decision.binding.generation}`,
  }));
}
