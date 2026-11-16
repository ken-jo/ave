import { mintHostDecisionProof } from "../main/workflow-template-decision.js";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "./gated.js";
import { broadcastToAppWindows } from "./window-fanout.js";
import type { IpcDeps } from "./types.js";
import { WORK_BOARD } from "../shared/ipc-channels.js";
import { hasUserKeyboardIntent } from "../shared/chat-origin.js";
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
  const load = async (id: unknown) => {
    requireTemplate(isTemplateId(id));
    const record = await store!.get(id);
    requireTemplate(authorizedScope(record.template.scope), "template-not-found"); return record;
  };
  const handle = <T>(channel: string, action: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T>) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<WorkflowTemplateIpcResult<T>> => {
      if (!validateHostRendererSender(event)) { auditUnauthorized(deps.auditLogger, channel, event); return { ...UNAUTHORIZED_FRAME, ok: false }; }
      if (!store) return { ok: false, error: "no-store" };
      try { return { ok: true, value: await action(event, ...args) }; }
      catch (error) { return { ok: false, ...(error instanceof WorkflowTemplateError && error.refusals ? { refusals: error.refusals } : {}), error: error instanceof WorkflowTemplateError || error instanceof TemplateGestureError || error instanceof TemplateFrameError ? error.code : "storage-error" }; }
    });
  };
  handle(WORK_BOARD.templateList, async (_event, ...args) => {
    requireTemplate(args.length === 0); return (await store!.list()).filter(t => authorizedScope(t.scope));
  });
  handle(WORK_BOARD.templateGet, async (_event, id, ...args) => { requireTemplate(args.length === 0); return load(id); });
  handle(WORK_BOARD.templateDraft, async (_event, id, raw, ...args) => {
    requireTemplate(args.length === 0 && (id === null || isTemplateId(id)));
    const input = parseTemplateDraft(raw); requireTemplate(authorizedScope(input.scope));
    if (id !== null) await load(id);
    return store!.draft(id as string | null, input);
  });
  const requireLocalGesture = (event: IpcMainInvokeEvent, intent: unknown, channel: string) => {
    if (!hasUserKeyboardIntent(intent)) throw new TemplateGestureError();
    const sender = event.sender;
    const windows = deps.getAppWindows?.() ?? [deps.getMainWindow()];
    if (!sender || sender.isDestroyed() || event.senderFrame !== sender.mainFrame || !windows.some(w => w && !w.isDestroyed() && w.webContents === sender)) {
      auditUnauthorized(deps.auditLogger, channel, event); throw new TemplateFrameError();
    }
  };
  handle(WORK_BOARD.templateAttachSchedule, async (event, raw, intent, ...args) => {
    requireTemplate(args.length === 0 && hasTemplateKeys(raw, ["templateId", "version", "graphHash", "scheduleId"]) && isTemplateId(raw.templateId) && isTemplateVersion(raw.version) && isGraphHash(raw.graphHash) && isTemplateId(raw.scheduleId));
    requireLocalGesture(event, intent, WORK_BOARD.templateAttachSchedule);
    await load(raw.templateId);
    const proof = mintHostDecisionProof("local-desktop");
    const result = await store!.attachSchedule(raw as unknown as ScheduleAttachmentInput, proof);
    deps.auditLogger.log({ timestamp: result.at, sessionId: "work-board:" + result.templateId, type: "approval", output: JSON.stringify({ event: "template_schedule_attached", ...result, auditId: proof.auditId }) });
    return result;
  });
  handle(WORK_BOARD.templateDetachSchedule, async (event, id, intent, ...args) => {
    requireTemplate(args.length === 0 && isTemplateId(id));
    requireLocalGesture(event, intent, WORK_BOARD.templateDetachSchedule);
    const attachment = await store!.getAttachment(id); requireTemplate(attachment, "template-not-found");
    await load(attachment.templateId);
    const proof = mintHostDecisionProof("local-desktop");
    const detached = await store!.detachSchedule(id, proof);
    if (detached) deps.auditLogger.log({ timestamp: proof.decidedAt, sessionId: "work-board:" + attachment.templateId, type: "approval", output: JSON.stringify({ event: "template_schedule_detached", attachmentId: id, ...proof }) });
    return detached;
  });
  handle(WORK_BOARD.templateConfirm, async (event, id, raw, intent, ...args) => {
    requireTemplate(args.length === 0 && isTemplateId(id) && hasTemplateKeys(raw, ["expectedGraphHash"]) && isGraphHash(raw.expectedGraphHash));
    requireLocalGesture(event, intent, WORK_BOARD.templateConfirm);
    const record = await load(id);
    if (record.draft) requireTemplate(authorizedScope(record.draft.scope));
    const result = await store!.confirm(id, raw as unknown as WorkflowTemplateConfirmInput, { who: "user", origin: "local-desktop" });
    deps.auditLogger.log({ timestamp: result.confirmedAt, sessionId: "work-board:" + id, type: "approval", output: JSON.stringify({ event: "template_confirmed", templateId: id, version: result.version, graphHash: result.graphHash, origin: "local-desktop" }) });
    return result;
  });
  handle(WORK_BOARD.templateArchive, async (_event, id, ...args) => { requireTemplate(args.length === 0); const record = await load(id); await store!.archive(record.template.id); return null; });
}
class TemplateGestureError extends Error { readonly code = "user-gesture-required"; }
class TemplateFrameError extends Error { readonly code = "unauthorized-frame"; }
