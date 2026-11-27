import { workBoardProjectAllows } from "../work-board-project-scope.js";
// Work approvals ("확인 필요"): a read-only projection over the stores that own each work-level decision. The change broadcast is wired at boot
// (boot/steps/work-approvals-wiring.ts). Every action (accept or dismiss a proposal,
// open or acknowledge a routine) stays on that source's own channel; this domain only lists and signals.
import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { WORK_APPROVALS } from "../../shared/ipc-channels.js";
import { hasOnlyKeys } from "../../shared/is-record.js";
import { maskWorkflowText } from "../../work-board/workflow/run-read-projection.js";
import { listAuthorizedWorkspaceProjects, resolveAuthorizedWorkspaceProject } from "../../main/project-root-authorization.js";
import { planScope, planView, workflowApprovalViews } from "../../main/work-approval-review.js";
import { projectRootEquals } from "../../shared/project-identity.js";
import type { RoutineRecord, InvalidRoutine, RoutineFailure } from "../../shared/routines-types.js";
import type { WorkItem, WorkProposal } from "../../shared/work-board-types.js";
import type {
  RoutineAttentionApprovalView,
  WorkApprovalListResult,
  WorkApprovalNavigationView,
  WorkApprovalProject,
  WorkApprovalView,
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
  return maskWorkflowText(text);
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

function toNavigation(view: Exclude<WorkApprovalView, WorkApprovalNavigationView>): WorkApprovalNavigationView {
  const { key, scope, title, kind } = view;
  return { kind: "navigation", targetKind: kind, key, scope, title, phase: kind === "plan" ? view.phase : "pending" };
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
  const { workBoardStore, workBoardEngine, routinesStore, auditLogger } = deps;

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

    const board = await workBoardStore.readApprovalItems();
    if (board === undefined) return { ok: false, error: "work-approvals-source-unavailable", source: "plan" };
    const scopedRows = board.filter(item => {
      const scope = planScope(item, projects);
      return scope !== null && (homeRoot === null || scope.type !== "project" || projectRootEquals(scope.projectRoot, homeRoot));
    });
    const canReadRun = (item: WorkItem) => homeRoot !== null && e.senderFrame === e.sender?.mainFrame && workBoardProjectAllows(e.sender, item.projectRoot);
    const workflowRows = scopedRows.filter(item => item.templateId !== undefined);
    if (workflowRows.some(item => item.runId !== undefined) && !workBoardEngine) {
      return { ok: false, error: "work-approvals-source-unavailable", source: "stage-gate" };
    }
    const workflowItems = workBoardEngine && workflowRows.length ? await workBoardEngine.readTemplateRuns(workflowRows) : [];
    const planViews = scopedRows.flatMap(item => {
      const view = planView(item, projects);
      return view ? [canReadRun(item) ? view : toNavigation(view)] : [];
    });
    const workflowViews = workflowItems.flatMap(item => workflowApprovalViews(item, projects)
      .map(view => canReadRun(item) ? view : toNavigation(view)));

    const sharedViews = [...proposalViews, ...routineViews];
    const items: WorkApprovalView[] = [...planViews, ...workflowViews, ...(homeRoot === null ? sharedViews.map(toNavigation) : sharedViews)];
    const total = items.filter(item => !("phase" in item) || item.phase === "pending").length;
    return { ok: true, items, total, projects };
  });
}
