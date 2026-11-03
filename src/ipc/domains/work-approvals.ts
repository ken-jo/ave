// Work approvals ("확인 필요"): a read-only projection over the stores that own each work-level decision. Every action (accept or dismiss a proposal,
// approve or discard a memory candidate, open or acknowledge a routine) stays on that source's own channel; this domain only lists and signals.
import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { broadcastToAppWindows } from "../window-fanout.js";
import type { IpcDeps } from "../types.js";
import { WORK_APPROVALS } from "../../shared/ipc-channels.js";
import { hasOnlyKeys } from "../../shared/is-record.js";
import {
  listAuthorizedWorkspaceProjects,
  resolveAuthorizedWorkspaceProject,
} from "../../main/project-root-authorization.js";
import { isDefaultWorkspaceRoot } from "../../main/default-workspace-root.js";
import type { RoutineRecord, InvalidRoutine } from "../../shared/routines-types.js";
import type { WorkProposal } from "../../shared/work-board-types.js";
import type { NoteEntry } from "../../memory/memory-manager.js";
import type {
  MemoryCandidateApprovalView,
  RoutineAttentionApprovalView,
  RoutineAttentionReason,
  WorkApprovalListResult,
  WorkApprovalView,
  WorkProposalApprovalView,
} from "../../shared/work-approvals-types.js";

type ListRequest = { ok: true; projectRoot: string | undefined } | { ok: false };

// Accept only `{ projectRoot?: string }` so renderer input cannot smuggle store options.
function parseListRequest(raw: unknown): ListRequest {
  if (raw === undefined) return { ok: true, projectRoot: undefined };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const record = raw as Record<string, unknown>;
  if (!hasOnlyKeys(record, ["projectRoot"])) return { ok: false };
  if (record.projectRoot !== undefined && typeof record.projectRoot !== "string") return { ok: false };
  return { ok: true, projectRoot: record.projectRoot as string | undefined };
}

function proposalView(proposal: WorkProposal): WorkProposalApprovalView {
  return {
    kind: "proposal",
    key: `proposal:${proposal.id}`,
    scope: { type: "unscoped" },
    title: proposal.title,
    arrivedAt: proposal.updatedAt,
    proposalId: proposal.id,
    summary: proposal.summary,
    pluginLabel: proposal.pluginLabel,
    priority: proposal.priority,
    expiresAt: proposal.expiresAt,
  };
}

function memoryCandidateView(entry: NoteEntry & { id: string }): MemoryCandidateApprovalView {
  return {
    kind: "memory-candidate",
    key: `memory-candidate:${entry.id}`,
    scope: entry.projectRoot
      ? { type: "project", projectRoot: entry.projectRoot, isDefault: isDefaultWorkspaceRoot(entry.projectRoot) }
      : { type: "global" },
    title: entry.title,
    arrivedAt: entry.createdAt ?? null,
    memoryId: entry.id,
  };
}

function routineTitle(routine: RoutineRecord): string {
  return routine.title ?? routine.notificationTitle ?? routine.id.slice(0, 8);
}

// One view per routine; every reason that applies rides on it, so the badge counts the routine once. Missing plugins come from active routines (the
// routine list's own rule); an unseen result also counts for a dismissed routine, matching the pending-results rehydration.
function routineView(routine: RoutineRecord): RoutineAttentionApprovalView | null {
  const reasons: RoutineAttentionReason[] = [];
  const pluginsMissing = routine.dismissedAt === undefined && routine.needsAttention !== undefined;
  if (pluginsMissing) reasons.push("plugins-missing");
  const resultUnseen = routine.lastFiredAt !== undefined && routine.lastResultAcknowledgedAt !== routine.lastFiredAt;
  if (resultUnseen) reasons.push("result-unseen");
  if (reasons.length === 0) return null;
  return {
    kind: "routine-attention",
    key: `routine:${routine.id}`,
    scope: { type: "global" },
    title: routineTitle(routine),
    arrivedAt: routine.lastFiredAt ?? routine.createdAt,
    routineId: routine.id,
    reasons,
    ...(pluginsMissing ? { missingPluginIds: [...routine.needsAttention!.missingPluginIds] } : {}),
    ...(resultUnseen ? { firedAt: routine.lastFiredAt } : {}),
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

function hasMemoryId(entry: NoteEntry): entry is NoteEntry & { id: string } {
  return typeof entry.id === "string";
}

export function registerWorkApprovalsHandlers(deps: IpcDeps): void {
  const { workBoardStore, routinesStore, memoryManager, auditLogger } = deps;

  // Every source store signals after its own write, whichever path made it (IPC, plugin HostApi, scheduler, model tool), so the stack never polls.
  const broadcastChanged = (): void => {
    broadcastToAppWindows(deps, WORK_APPROVALS.changed);
  };
  workBoardStore?.proposalsChanged.subscribe(broadcastChanged);
  routinesStore?.changed.subscribe(broadcastChanged);
  memoryManager.candidatesChanged.subscribe(broadcastChanged);

  ipcMain.handle(WORK_APPROVALS.list, async (e, raw?: unknown): Promise<WorkApprovalListResult | typeof UNAUTHORIZED_FRAME> => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_APPROVALS.list, e);
      return UNAUTHORIZED_FRAME;
    }
    const request = parseListRequest(raw);
    if (!request.ok) return { ok: false, error: "invalid-input" };
    const resolved = resolveAuthorizedWorkspaceProject(request.projectRoot);
    if (!resolved.authorized || !resolved.project) return { ok: false, error: "project-not-allowed" };
    if (!workBoardStore) return { ok: false, error: "source-unavailable", source: "proposal" };
    if (!routinesStore) return { ok: false, error: "source-unavailable", source: "routine-attention" };

    const proposals = await workBoardStore.listProposals();
    if (proposals.status !== "ok") return { ok: false, error: "source-unavailable", source: "proposal" };
    const proposalViews = proposals.proposals.map(proposalView);

    const project = resolved.project;
    const candidateViews = memoryManager
      .listMemoryCandidates({
        projectRoot: project.projectRoot,
        projectName: project.projectName,
        ...(project.isDefault === true ? { includeUnscoped: true } : {}),
      })
      .filter(hasMemoryId)
      .map(memoryCandidateView);
    const allCandidateCount = memoryManager.countMemoryCandidates(
      listAuthorizedWorkspaceProjects().map((authorized) => authorized.projectRoot),
    );

    const routineViews = [
      ...routinesStore.list().map(routineView).filter((view): view is RoutineAttentionApprovalView => view !== null),
      ...routinesStore.listInvalid().map(invalidRoutineView),
    ];

    const items: WorkApprovalView[] = [...proposalViews, ...candidateViews, ...routineViews];
    // Proposals and routines are never project-scoped, so only memory candidates differ between the visible list and the total.
    const total = proposalViews.length + routineViews.length + allCandidateCount;
    return { ok: true, items, total };
  });
}
