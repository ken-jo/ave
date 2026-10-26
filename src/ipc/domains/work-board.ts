// Work-board mutations use the store's lifecycle; execution and reports require their separately wired services.
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { broadcastToAppWindows } from "../window-fanout.js";
import type { IpcDeps } from "../types.js";
import type {
  WorkBoardBriefingKind,
  WorkBoardBriefingResult,
  WorkItemRunResult,
} from "../../shared/work-board-types.js";
import { errorMessage } from "../../shared/error-message.js";
import { WORK_BOARD } from "../../shared/ipc-channels.js";
import { createDirStorage } from "../../work-board/storage.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { readRunTranscript } from "../../work-board/run-transcript.js";
import type {
  WorkItemCreateInput,
  WorkItemUpdateInput,
  WorkItemListFilter,
  WorkItemStatusStored,
  WorkItemChangedEventPayload,
  WorkItemGetResult,
  WorkItemResolved,
  WorkProposalChangedEventPayload,
} from "../../main/work-board-store.js";
import { resolveAuthorizedWorkspaceProject } from "../../main/project-root-authorization.js";

const NO_STORE = { ok: false, error: "no-store" as const };
const NO_ENGINE = { ok: false, error: "no-engine" as const };
const NO_REPORTER = { ok: false, error: "no-reporter" as const };
const UNAUTHORIZED_PROJECT_ROOT = "__ave_unauthorized_project_root__";
const PROJECT_NOT_ALLOWED_REASON = "project root is not authorized";

function normalizeProjectListFilter(filter?: WorkItemListFilter): WorkItemListFilter {
  const resolved = resolveAuthorizedWorkspaceProject(filter?.projectRoot);
  if (!resolved.authorized || !resolved.project) {
    return {
      ...filter,
      projectRoot: UNAUTHORIZED_PROJECT_ROOT,
      includeUnscoped: false,
    };
  }
  return {
    ...filter,
    projectRoot: resolved.project.projectRoot,
    includeUnscoped: resolved.project.isDefault === true,
  };
}

function normalizeCreateInputProject(input: WorkItemCreateInput):
  | { ok: true; input: WorkItemCreateInput }
  | { ok: false; result: { status: "invalid"; reason: string } } {
  const resolved = resolveAuthorizedWorkspaceProject(input?.projectRoot, input?.projectName);
  if (!resolved.authorized || !resolved.project) {
    return { ok: false, result: { status: "invalid", reason: PROJECT_NOT_ALLOWED_REASON } };
  }
  return {
    ok: true,
    input: {
      ...input,
      projectRoot: resolved.project.projectRoot,
      projectName: resolved.project.projectName,
    },
  };
}

function isAuthorizedStoredWorkItem(item: WorkItemResolved): boolean {
  if (!item.projectRoot) return true;
  const resolved = resolveAuthorizedWorkspaceProject(item.projectRoot, item.projectName);
  return resolved.authorized && resolved.project !== null;
}

export function registerWorkBoardHandlers(deps: IpcDeps): void {
  const { workBoardStore, workBoardEngine, workBoardReport, auditLogger } = deps;

  const isBoardOwnerFrame = (event: IpcMainInvokeEvent): boolean => {
    const sender = event.sender;
    if (!sender || sender.isDestroyed() || event.senderFrame !== sender.mainFrame) return false;
    const windows = deps.getAppWindows?.() ?? [deps.getMainWindow()];
    return windows.some((window) => window && !window.isDestroyed() && window.webContents === sender);
  };

  const broadcastItemChanged = (
    itemId: number,
    change: WorkItemChangedEventPayload["change"],
  ): void => {
    const payload: WorkItemChangedEventPayload = {
      itemId,
      change,
      changedAt: new Date().toISOString(),
    };
    broadcastToAppWindows(deps, WORK_BOARD.itemChanged, payload);
  };

  const loadAuthorizedItem = async (id: number): Promise<WorkItemGetResult> => {
    if (!workBoardStore) return { status: "not_found", itemId: id };
    const result = await workBoardStore.get(id);
    if (result.status !== "found") return result;
    return isAuthorizedStoredWorkItem(result.item) ? result : { status: "not_found", itemId: id };
  };

  ipcMain.handle(WORK_BOARD.list, async (e, filter?: WorkItemListFilter) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.list, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    return workBoardStore.list(normalizeProjectListFilter(filter));
  });

  ipcMain.handle(WORK_BOARD.get, async (e, id: number) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.get, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    return loadAuthorizedItem(id);
  });

  ipcMain.handle(WORK_BOARD.add, async (e, input: WorkItemCreateInput) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.add, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const normalized = normalizeCreateInputProject(input);
    if (!normalized.ok) return normalized.result;
    const result = await workBoardStore.create(normalized.input);
    if (result.status === "created") broadcastItemChanged(result.itemId, "created");
    return result;
  });

  ipcMain.handle(WORK_BOARD.update, async (e, id: number, patch: WorkItemUpdateInput) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.update, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    const result = await workBoardStore.update(id, patch);
    if (result.status === "updated") broadcastItemChanged(result.itemId, "updated");
    return result;
  });

  ipcMain.handle(WORK_BOARD.transition, async (e, id: number, to: WorkItemStatusStored) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.transition, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    const result = await workBoardStore.transition(id, to);
    if (result.status === "transitioned") broadcastItemChanged(result.itemId, "transitioned");
    return result;
  });

  ipcMain.handle(WORK_BOARD.complete, async (e, id: number) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.complete, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    const result = await workBoardStore.complete(id);
    if (result.status === "completed") broadcastItemChanged(result.itemId, "completed");
    return result;
  });

  ipcMain.handle(WORK_BOARD.reopen, async (e, id: number) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.reopen, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    const result = await workBoardStore.reopen(id);
    if (result.status === "reopened") broadcastItemChanged(result.itemId, "reopened");
    return result;
  });

  ipcMain.handle(WORK_BOARD.remove, async (e, id: number) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.remove, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    const result = await workBoardStore.remove(id);
    if (result.status === "deleted") broadcastItemChanged(result.itemId, "removed");
    return result;
  });

  // Run returns a terminal result while progress events update the renderer.
  ipcMain.handle(WORK_BOARD.run, async (e, id: number, opts?: { agentName?: string }) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.run, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardEngine) return NO_ENGINE;
    if (!workBoardStore) return { status: "error", reason: "no-store" } satisfies WorkItemRunResult;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return { status: "not_found" } satisfies WorkItemRunResult;
    if (!isBoardOwnerFrame(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.run, e);
      return UNAUTHORIZED_FRAME;
    }

    broadcastToAppWindows(deps, WORK_BOARD.runStarted, {
      itemId: id,
      at: new Date().toISOString(),
    });
    try {
      const result: WorkItemRunResult = await workBoardEngine.runItem(
        id,
        { ...(opts?.agentName ? { agentName: opts.agentName } : {}), approvalSurface: e.sender },
      );
      broadcastToAppWindows(deps, WORK_BOARD.runFinished, {
        itemId: id,
        status: result.status,
        at: new Date().toISOString(),
      });
      return result;
    } catch (err) {
      const reason = errorMessage(err);
      broadcastToAppWindows(deps, WORK_BOARD.runFailed, {
        itemId: id,
        reason,
        at: new Date().toISOString(),
      });
      // Convert engine failures to its stable error envelope; do not throw across IPC.
      return { status: "error", reason } satisfies WorkItemRunResult;
    }
  });

  // Preserve the reporter's ok/empty result and map provider failure to the public error envelope.
  ipcMain.handle(
    WORK_BOARD.generateReport,
    async (
      e,
      kind: "daily" | "weekly",
      input?: { date?: string; weekIso?: string; weekOffset?: number; projectRoot?: string; includeUnscoped?: boolean },
    ) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, WORK_BOARD.generateReport, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!workBoardReport) return NO_REPORTER;
      try {
        return await workBoardReport.generate(kind === "weekly" ? "weekly" : "daily", normalizeProjectListFilter(input));
      } catch (err) {
        const reason = errorMessage(err);
        return { status: "error" as const, kind, reason };
      }
    },
  );

  ipcMain.handle(WORK_BOARD.runTranscript, async (e, itemId: number, runId: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.runTranscript, e);
      return UNAUTHORIZED_FRAME;
    }
    // Validate run UUIDs before interpolating transcript paths to prevent traversal.
    if (typeof runId !== "string" || !/^[A-Za-z0-9_-]+$/.test(runId)) return { events: [] };
    if (!workBoardStore) return { events: [] };
    const existing = await loadAuthorizedItem(itemId);
    if (existing.status !== "found") return { events: [] };
    const storage = createDirStorage(openFeatureNamespace("work-board").dir);
    return { events: await readRunTranscript(storage, itemId, runId) };
  });

  // Plugins propose through HostApi; renderer actions may read and answer proposals but cannot create them.

  const broadcastProposalChanged = (
    proposalId: string,
    change: WorkProposalChangedEventPayload["change"],
  ): void => {
    const payload: WorkProposalChangedEventPayload = {
      proposalId,
      change,
      changedAt: new Date().toISOString(),
    };
    broadcastToAppWindows(deps, WORK_BOARD.proposalChanged, payload);
  };

  ipcMain.handle(WORK_BOARD.listProposals, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.listProposals, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    return workBoardStore.listProposals();
  });

  // Resolve the active project when accepting; unscoped proposals do not choose project identity.
  ipcMain.handle(WORK_BOARD.acceptProposal, async (e, proposalId: string, projectRoot?: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.acceptProposal, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    if (typeof proposalId !== "string" || proposalId.length === 0) {
      return { status: "invalid", reason: "proposalId is required" };
    }
    const resolved = resolveAuthorizedWorkspaceProject(projectRoot);
    if (!resolved.authorized || !resolved.project) {
      return { status: "invalid", reason: PROJECT_NOT_ALLOWED_REASON };
    }
    const result = await workBoardStore.acceptProposal(proposalId, {
      projectRoot: resolved.project.projectRoot,
      projectName: resolved.project.projectName,
    });
    if (result.status === "accepted") {
      broadcastItemChanged(result.itemId, "created");
      broadcastProposalChanged(proposalId, "accepted");
    }
    return result;
  });

  ipcMain.handle(WORK_BOARD.dismissProposal, async (e, proposalId: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.dismissProposal, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const result = await workBoardStore.dismissProposal(proposalId);
    if (result.status === "dismissed") broadcastProposalChanged(proposalId, "dismissed");
    return result;
  });

  // Briefing surveys through a read-only child and creates proposals rather than executing work.
  ipcMain.handle(
    WORK_BOARD.runBriefing,
    async (e, kind: WorkBoardBriefingKind, projectRoot?: string) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, WORK_BOARD.runBriefing, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!workBoardEngine) return NO_ENGINE;
      const briefingKind: WorkBoardBriefingKind = kind === "weekly" ? "weekly" : "daily";
      const resolved = resolveAuthorizedWorkspaceProject(projectRoot);
      if (!resolved.authorized || !resolved.project) {
        return {
          status: "error",
          kind: briefingKind,
          reason: PROJECT_NOT_ALLOWED_REASON,
        } satisfies WorkBoardBriefingResult;
      }
      if (!isBoardOwnerFrame(e)) {
        auditUnauthorized(auditLogger, WORK_BOARD.runBriefing, e);
        return UNAUTHORIZED_FRAME;
      }
      try {
        const result = await workBoardEngine.runBriefing(briefingKind, {
          projectRoot: resolved.project.projectRoot,
          includeUnscoped: resolved.project.isDefault === true,
          approvalSurface: e.sender,
        });
        if (result.status === "ok") {
          for (const id of [...result.filed, ...result.refreshed]) {
            broadcastProposalChanged(id, "posted");
          }
        }
        return result;
      } catch (err) {
        const reason = errorMessage(err);
        return { status: "error", kind: briefingKind, reason } satisfies WorkBoardBriefingResult;
      }
    },
  );
}
