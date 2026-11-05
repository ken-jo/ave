// Work approvals ("확인 필요"): a read-only projection over the stores that own each work-level decision. The change broadcast is wired at boot
// (boot/steps/work-approvals-wiring.ts). Every action (accept or dismiss a proposal,
// open or acknowledge a routine) stays on that source's own channel; this domain only lists and signals.
import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { WORK_APPROVALS } from "../../shared/ipc-channels.js";
import { hasOnlyKeys } from "../../shared/is-record.js";
import { maskSensitiveData } from "../../shared/dlp.js";
import { listAuthorizedWorkspaceProjects, resolveAuthorizedWorkspaceProject } from "../../main/project-root-authorization.js";
import { isDecidablePlan, isReplanningPlan, itemDigestOf } from "../../main/work-board-store.js";
import { projectRootEquals } from "../../shared/project-identity.js";
import type { RoutineRecord, InvalidRoutine, RoutineFailure } from "../../shared/routines-types.js";
import type { WorkItem, WorkProposal } from "../../shared/work-board-types.js";
import type {
  RoutineAttentionApprovalView,
  WorkApprovalListResult,
  WorkApprovalProject,
  WorkApprovalView,
  WorkPlanApprovalView,
  WorkProposalApprovalView,
} from "../../shared/work-approvals-types.js";

type ListRequest =
  | { ok: true; mode: "project"; projectRoot: string | undefined }
  | { ok: true; mode: "all" }
  | { ok: false };

// Accept only `{ projectRoot?: string }` or `{ allProjects: true }` so renderer input cannot smuggle store options.
function parseListRequest(raw: unknown): ListRequest {
  if (raw === undefined) return { ok: true, mode: "project", projectRoot: undefined };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const record = raw as Record<string, unknown>;
  if (hasOnlyKeys(record, ["allProjects"]) && "allProjects" in record) {
    return record.allProjects === true ? { ok: true, mode: "all" } : { ok: false };
  }
  if (!hasOnlyKeys(record, ["projectRoot"])) return { ok: false };
  if (record.projectRoot !== undefined && typeof record.projectRoot !== "string") return { ok: false };
  return { ok: true, mode: "project", projectRoot: record.projectRoot as string | undefined };
}

// Titles and summaries are model- or plugin-written text; mask secrets and PII before they reach a renderer, as tool results are.
function masked(text: string): string {
  return maskSensitiveData(text).masked;
}

function proposalView(proposal: WorkProposal): WorkProposalApprovalView {
  return {
    kind: "proposal",
    key: `proposal:${proposal.id}`,
    scope: { type: "unscoped" },
    title: masked(proposal.title),
    arrivedAt: proposal.updatedAt,
    proposalId: proposal.id,
    summary: masked(proposal.summary),
    pluginLabel: proposal.pluginLabel,
    priority: proposal.priority,
    expiresAt: proposal.expiresAt,
    state: masked(proposal.state),
    evidence: proposal.evidence.map((row) => ({ label: masked(row.label), detail: masked(row.detail) })),
    blockers: proposal.blockers.map((row) => ({
      reason: masked(row.reason),
      ...(row.resolution !== undefined ? { resolution: masked(row.resolution) } : {}),
    })),
  };
}

// A plan belongs to its item's project, or is shared when the item has none. A plan whose project is no longer authorized (the user removed
// it) has no scope, and is neither listed nor counted anywhere.
function planScope(item: WorkItem, projects: readonly WorkApprovalProject[]): WorkPlanApprovalView["scope"] | null {
  if (!item.projectRoot) return { type: "unscoped" };
  const project = projects.find((entry) => projectRootEquals(entry.projectRoot, item.projectRoot));
  if (!project) return null;
  return { type: "project", projectRoot: project.projectRoot, isDefault: project.isDefault };
}

function planView(item: WorkItem, projects: readonly WorkApprovalProject[]): WorkPlanApprovalView | null {
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
    title: masked(item.title),
    arrivedAt: approval.requestedAt,
    itemId: item.id,
    runId: item.runId,
    planHash: approval.planHash,
    plan: masked(item.plan ?? ""),
    revision: approval.revision,
    ...(approval.agentName !== undefined ? { agentName: approval.agentName } : {}),
    phase: pending ? "pending" : "replanning",
    stale: pending && approval.itemDigest !== itemDigestOf(item),
    ...(!pending && approval.note !== undefined ? { changeRequest: masked(approval.note) } : {}),
  };
}

function isCounted(view: WorkApprovalView): boolean {
  return view.kind !== "plan" || view.phase === "pending";
}

function routineTitle(routine: RoutineRecord): string {
  return routine.title ?? routine.notificationTitle ?? routine.id.slice(0, 8);
}

function failureView(failure: RoutineFailure): RoutineFailure {
  return failure.kind === "error"
    ? { kind: "error", firedAt: failure.firedAt, at: failure.at, reason: masked(failure.reason) }
    : { kind: "shutdown-timeout", firedAt: failure.firedAt, at: failure.at };
}

// One view per routine; every reason that applies rides on it, so the badge counts the routine once. A routine counts for a broken
// configuration (missing plugins on an active routine, the routine list's own rule; or a held-back invalid plugin id) or for an
// unacknowledged failed run. A failure counts even on a dismissed record: a shutdown routine stays dismissed after it fails, so its
// failure would otherwise never be seen. A successful or notify-only result is not a decision and never enters the list.
function routineView(routine: RoutineRecord): RoutineAttentionApprovalView | null {
  const pluginsMissing = routine.dismissedAt === undefined && routine.needsAttention !== undefined;
  const failure = routine.lastFailure && routine.lastFailure.acknowledgedAt === undefined ? routine.lastFailure : undefined;
  if (!pluginsMissing && !failure) return null;
  return {
    kind: "routine-attention",
    key: `routine:${routine.id}`,
    scope: { type: "global" },
    title: masked(routineTitle(routine)),
    arrivedAt: failure?.at ?? routine.lastFiredAt ?? routine.createdAt,
    routineId: routine.id,
    reasons: [...(pluginsMissing ? (["plugins-missing"] as const) : []), ...(failure ? (["run-failed"] as const) : [])],
    ...(pluginsMissing && routine.needsAttention ? { missingPluginIds: [...routine.needsAttention.missingPluginIds] } : {}),
    ...(failure ? { failure: failureView(failure) } : {}),
  };
}

function invalidRoutineView(invalid: InvalidRoutine): RoutineAttentionApprovalView {
  return {
    kind: "routine-attention",
    key: `routine:${invalid.id}`,
    scope: { type: "global" },
    title: invalid.id,
    arrivedAt: null,
    routineId: invalid.id,
    reasons: ["invalid-plugin-id"],
  };
}

export function registerWorkApprovalsHandlers(deps: IpcDeps): void {
  const { workBoardStore, routinesStore, auditLogger } = deps;

  ipcMain.handle(WORK_APPROVALS.list, async (e, raw?: unknown): Promise<WorkApprovalListResult | typeof UNAUTHORIZED_FRAME> => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_APPROVALS.list, e);
      return UNAUTHORIZED_FRAME;
    }
    const request = parseListRequest(raw);
    if (!request.ok) return { ok: false, error: "invalid-input" };
    let homeRoot: string | null = null;
    if (request.mode === "project") {
      const project = resolveAuthorizedWorkspaceProject(request.projectRoot);
      if (!project.authorized || !project.project) return { ok: false, error: "project-not-allowed" };
      homeRoot = project.project.projectRoot;
    }
    const projects: WorkApprovalProject[] = listAuthorizedWorkspaceProjects().map((project) => ({
      projectRoot: project.projectRoot,
      projectName: project.projectName,
      isDefault: project.isDefault === true,
    }));
    if (!workBoardStore) return { ok: false, error: "work-approvals-source-unavailable", source: "proposal" };
    if (!routinesStore) return { ok: false, error: "work-approvals-source-unavailable", source: "routine-attention" };

    const proposals = await workBoardStore.listProposals();
    if (proposals.status !== "ok") return { ok: false, error: "work-approvals-source-unavailable", source: "proposal" };
    const proposalViews = proposals.proposals.map(proposalView);

    const routineViews = [
      ...routinesStore.list().map(routineView).filter((view): view is RoutineAttentionApprovalView => view !== null),
      ...routinesStore.listInvalid().map(invalidRoutineView),
    ];

    const board = await workBoardStore.list();
    if (board.status !== "ok") return { ok: false, error: "work-approvals-source-unavailable", source: "plan" };
    const planViews = board.items.map((item) => planView(item, projects)).filter((view): view is WorkPlanApprovalView => view !== null);

    // Proposals (unscoped), routines (global) and plans with no project belong to every project's list; a project's plans only to its own.
    const everything: WorkApprovalView[] = [...planViews, ...proposalViews, ...routineViews];
    const items = homeRoot === null
      ? everything
      : everything.filter((view) => view.scope.type !== "project" || projectRootEquals(view.scope.projectRoot, homeRoot));
    const total = everything.filter(isCounted).length;
    return { ok: true, items, total, projects };
  });
}
