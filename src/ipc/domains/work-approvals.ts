// Work approvals ("확인 필요"): a read-only projection over the stores that own each work-level decision. The change broadcast is wired at boot
// (boot/steps/work-approvals-wiring.ts). Every action (accept or dismiss a proposal,
// approve or discard a memory candidate, open or acknowledge a routine) stays on that source's own channel; this domain only lists and signals.
import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { WORK_APPROVALS } from "../../shared/ipc-channels.js";
import { hasOnlyKeys } from "../../shared/is-record.js";
import { maskSensitiveData } from "../../shared/dlp.js";
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
  WorkApprovalListResult,
  WorkApprovalView,
  WorkProposalApprovalView,
} from "../../shared/work-approvals-types.js";

type ListRequest =
  | { ok: true; mode: "project"; projectRoot: string | undefined }
  | { ok: true; mode: "all-projects" }
  | { ok: false };

// Accept only `{ projectRoot?: string }` or `{ allProjects: true }` so renderer input cannot smuggle store options.
function parseListRequest(raw: unknown): ListRequest {
  if (raw === undefined) return { ok: true, mode: "project", projectRoot: undefined };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const record = raw as Record<string, unknown>;
  if (hasOnlyKeys(record, ["allProjects"]) && record.allProjects === true) return { ok: true, mode: "all-projects" };
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
  };
}

function memoryCandidateView(entry: NoteEntry & { id: string }): MemoryCandidateApprovalView {
  return {
    kind: "memory-candidate",
    key: `memory-candidate:${entry.id}`,
    scope: entry.projectRoot
      ? { type: "project", projectRoot: entry.projectRoot, isDefault: isDefaultWorkspaceRoot(entry.projectRoot) }
      : { type: "global" },
    title: masked(entry.title),
    arrivedAt: entry.createdAt ?? null,
    memoryId: entry.id,
  };
}

function routineTitle(routine: RoutineRecord): string {
  return routine.title ?? routine.notificationTitle ?? routine.id.slice(0, 8);
}

// One view per routine; every reason that applies rides on it, so the badge counts the routine once. A routine counts only for a broken
// configuration: missing plugins on an active routine (the routine list's own rule) or a held-back invalid plugin id. A successful or
// notify-only result is not a decision and never enters the list.
function routineView(routine: RoutineRecord): RoutineAttentionApprovalView | null {
  if (routine.dismissedAt !== undefined || routine.needsAttention === undefined) return null;
  return {
    kind: "routine-attention",
    key: `routine:${routine.id}`,
    scope: { type: "global" },
    title: masked(routineTitle(routine)),
    arrivedAt: routine.lastFiredAt ?? routine.createdAt,
    routineId: routine.id,
    reasons: ["plugins-missing"],
    missingPluginIds: [...routine.needsAttention.missingPluginIds],
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

  ipcMain.handle(WORK_APPROVALS.list, async (e, raw?: unknown): Promise<WorkApprovalListResult | typeof UNAUTHORIZED_FRAME> => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_APPROVALS.list, e);
      return UNAUTHORIZED_FRAME;
    }
    const request = parseListRequest(raw);
    if (!request.ok) return { ok: false, error: "invalid-input" };
    // All-projects mode (owner-approved views: the 전체 프로젝트 list and the badge popover) needs no project; project mode resolves one.
    const project = request.mode === "project" ? resolveAuthorizedWorkspaceProject(request.projectRoot) : null;
    if (project && (!project.authorized || !project.project)) return { ok: false, error: "project-not-allowed" };
    if (!workBoardStore) return { ok: false, error: "work-approvals-source-unavailable", source: "proposal" };
    if (!routinesStore) return { ok: false, error: "work-approvals-source-unavailable", source: "routine-attention" };

    const proposals = await workBoardStore.listProposals();
    if (proposals.status !== "ok") return { ok: false, error: "work-approvals-source-unavailable", source: "proposal" };
    const proposalViews = proposals.proposals.map(proposalView);

    // Only authorized projects: a removed or unauthorized project's candidates never appear, in either mode.
    const allCandidates = memoryManager
      .listMemoryCandidatesForProjects(listAuthorizedWorkspaceProjects().map((authorized) => authorized.projectRoot))
      .filter(hasMemoryId);
    const visibleCandidates = project?.project
      ? memoryManager
          .listMemoryCandidates({
            projectRoot: project.project.projectRoot,
            projectName: project.project.projectName,
            ...(project.project.isDefault === true ? { includeUnscoped: true } : {}),
          })
          .filter(hasMemoryId)
      : allCandidates;
    const candidateViews = visibleCandidates.map(memoryCandidateView);

    const routineViews = [
      ...routinesStore.list().map(routineView).filter((view): view is RoutineAttentionApprovalView => view !== null),
      ...routinesStore.listInvalid().map(invalidRoutineView),
    ];

    const items: WorkApprovalView[] = [...proposalViews, ...candidateViews, ...routineViews];
    // Proposals and routines are never project-scoped, so only memory candidates differ between the visible list and the total.
    const total = proposalViews.length + routineViews.length + allCandidates.length;
    return { ok: true, items, total };
  });
}
