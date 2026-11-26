import { mintHostDecisionProof } from "../main/workflow-template-decision.js";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "./gated.js";
import { broadcastToAppWindows } from "./window-fanout.js";
import type { IpcDeps } from "./types.js";
import { WORK_BOARD } from "../shared/ipc-channels.js";
import { hasUserKeyboardIntent } from "../shared/chat-origin.js";
import { isWorkflowTemplateProposalId } from "../shared/workflow-template-types.js";
import { hasTemplateKeys, isGraphHash, isTemplateId, isTemplateVersion, parseTemplateDraft, requireTemplate, WorkflowTemplateError } from "../work-board/template-graph.js";
import { resolveAuthorizedWorkspaceProject } from "../main/project-root-authorization.js";
import type { ScheduleAttachmentInput, TemplateScope, WorkflowTemplateConfirmInput, WorkflowTemplateIpcResult } from "../shared/workflow-template-types.js";

export function registerWorkflowTemplateHandlers(deps: IpcDeps): void {
  const store = deps.workflowTemplateStore;
  store?.changed.subscribe(() => broadcastToAppWindows(deps, WORK_BOARD.templatesChanged));
  const authorizedScope = (scope: TemplateScope): boolean => {
    if (scope.kind === "all") return true;
    const resolved = resolveAuthorizedWorkspaceProject(scope.projectRoot);
    return resolved.authorized && resolved.project !== null;
  };
  const loadProposal = (id: string) => {
    requireTemplate(store, "template-not-found");
    const proposal = store.getProposal(id);
    const scope = proposal.draft.scope;
    if (scope.kind === "project") {
      const resolved = resolveAuthorizedWorkspaceProject(scope.projectRoot);
      requireTemplate(resolved.authorized && resolved.project?.projectRoot === scope.projectRoot, "scope-not-authorised");
    }
    return proposal;
  };
  const load = async (id: unknown) => {
    requireTemplate(isTemplateId(id));
    requireTemplate(store, "template-not-found");
    const record = await store.get(id);
    requireTemplate(authorizedScope(record.template.scope), "template-not-found"); return record;
  };
  const handle = <T>(channel: string, action: (store: NonNullable<IpcDeps["workflowTemplateStore"]>, event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T>) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<WorkflowTemplateIpcResult<T>> => {
      if (!validateHostRendererSender(event)) { auditUnauthorized(deps.auditLogger, channel, event); return { ...UNAUTHORIZED_FRAME, ok: false }; }
      if (!store) return { ok: false, error: "no-store" };
      try { return { ok: true, value: await action(store, event, ...args) }; }
      catch (error) { return { ok: false, ...(error instanceof WorkflowTemplateError && error.refusals ? { refusals: error.refusals } : {}), error: error instanceof WorkflowTemplateError || error instanceof TemplateGestureError || error instanceof TemplateFrameError ? error.code : "storage-error" }; }
    });
  };
  handle(WORK_BOARD.templateList, async (store, _event, ...args) => {
    requireTemplate(args.length === 0); return (await store.list()).filter(t => authorizedScope(t.scope));
  });
  handle(WORK_BOARD.templateGet, async (_store, _event, id, ...args) => { requireTemplate(args.length === 0); return load(id); });
  handle(WORK_BOARD.templateProposalGet, async (_store, _event, id, ...args) => {
    requireTemplate(args.length === 0 && isWorkflowTemplateProposalId(id));
    return loadProposal(id);
  });
  handle(WORK_BOARD.templateDraft, async (store, _event, id, raw, ...args) => {
    requireTemplate(args.length === 0 && (id === null || isTemplateId(id)));
    const input = parseTemplateDraft(raw);
    if (input.scope.kind === "project") {
      const resolved = resolveAuthorizedWorkspaceProject(input.scope.projectRoot);
      requireTemplate(resolved.authorized && resolved.project, "scope-not-authorised");
      input.scope = { kind: "project", projectRoot: resolved.project.projectRoot };
    }
    if (id !== null) await load(id);
    return store.draft(id as string | null, input);
  });
  const requireLocalGesture = (event: IpcMainInvokeEvent, intent: unknown, channel: string) => {
    if (!hasUserKeyboardIntent(intent)) throw new TemplateGestureError();
    const sender = event.sender;
    const windows = deps.getAppWindows?.() ?? [deps.getMainWindow()];
    if (!sender || sender.isDestroyed() || event.senderFrame !== sender.mainFrame || !windows.some(w => w && !w.isDestroyed() && w.webContents === sender)) {
      auditUnauthorized(deps.auditLogger, channel, event); throw new TemplateFrameError();
    }
  };
  handle(WORK_BOARD.templateAttachSchedule, async (store, event, raw, intent, ...args) => {
    requireTemplate(args.length === 0 && hasTemplateKeys(raw, ["templateId", "version", "graphHash", "scheduleId"]) && isTemplateId(raw.templateId) && isTemplateVersion(raw.version) && isGraphHash(raw.graphHash) && isTemplateId(raw.scheduleId));
    requireLocalGesture(event, intent, WORK_BOARD.templateAttachSchedule);
    const record = await store.get(raw.templateId);
    let approvedScope = record.template.scope;
    if (approvedScope.kind === "project") {
      const resolved = resolveAuthorizedWorkspaceProject(approvedScope.projectRoot);
      requireTemplate(resolved.authorized && resolved.project, "scope-not-authorised");
      approvedScope = { kind: "project", projectRoot: resolved.project.projectRoot };
    }
    const proof = mintHostDecisionProof("local-desktop");
    const result = await store.attachSchedule(raw as unknown as ScheduleAttachmentInput, proof, approvedScope);
    deps.auditLogger.log({ timestamp: result.at, sessionId: `work-board:${result.templateId}`, type: "approval", output: JSON.stringify({ event: "template_schedule_attached", ...result, auditId: proof.auditId }) });
    return result;
  });
  handle(WORK_BOARD.templateDetachSchedule, async (store, event, id, intent, ...args) => {
    requireTemplate(args.length === 0 && isTemplateId(id));
    requireLocalGesture(event, intent, WORK_BOARD.templateDetachSchedule);
    const attachment = await store.getAttachment(id); requireTemplate(attachment, "template-not-found");
    const proof = mintHostDecisionProof("local-desktop");
    const detached = await store.detachSchedule(id, proof);
    if (detached) deps.auditLogger.log({ timestamp: proof.decidedAt, sessionId: `work-board:${attachment.templateId}`, type: "approval", output: JSON.stringify({ event: "template_schedule_detached", attachmentId: id, ...proof }) });
    return detached;
  });
  handle(WORK_BOARD.templateConfirm, async (store, event, id, raw, intent, ...args) => {
    requireTemplate(args.length === 0 && isTemplateId(id) && hasTemplateKeys(raw, ["expectedGraphHash", "expectedDraftRevision"]) && isGraphHash(raw.expectedGraphHash) && isTemplateId(raw.expectedDraftRevision));
    requireLocalGesture(event, intent, WORK_BOARD.templateConfirm);
    const proposalId = isWorkflowTemplateProposalId(id) ? id : undefined;
    if (proposalId) loadProposal(proposalId);
    else {
      const { draft } = await load(id);
      if (draft) requireTemplate(authorizedScope(draft.scope), "scope-not-authorised");
    }
    const result = await store.confirmDraft(id, raw as unknown as WorkflowTemplateConfirmInput, { who: "user", origin: "local-desktop" });
    deps.auditLogger.log({ timestamp: result.confirmedAt, sessionId: `work-board:${result.templateId}`, type: "approval", output: JSON.stringify({ event: "template_confirmed", proposalId, templateId: result.templateId, version: result.version, graphHash: result.graphHash, origin: "local-desktop" }) });
    return result;
  });
  handle(WORK_BOARD.templateArchive, async (store, _event, id, ...args) => { requireTemplate(args.length === 0); const record = await load(id); await store.archive(record.template.id); return null; });
}
class TemplateGestureError extends Error { readonly code = "user-gesture-required"; }
class TemplateFrameError extends Error { readonly code = "unauthorized-frame"; }
