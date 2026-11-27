import { logPermissionEvent, permissionLogId } from "../lib/permission-log.js";
import { attachWorkflowSchedule } from "../main/workflow-schedule-attachment.js";
import { parseScheduleAttachmentRequest } from "../work-board/schedule-attachment-input.js";
import { parseTemplateConfirmInput } from "../work-board/work-decision-input.js";
import { mintHostDecisionProof } from "../main/workflow-template-decision.js";
import { createToolEffectResolver } from "../permissions/tool-effect-evidence.js";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "./gated.js";
import { broadcastToAppWindows } from "./window-fanout.js";
import type { IpcDeps } from "./types.js";
import { WORK_BOARD } from "../shared/ipc-channels.js";
import { securitySettingsGestures } from "./security-settings-gesture.js";
import { isWorkflowTemplateProposalId } from "../shared/workflow-template-types.js";
import { isTemplateId, parseTemplateDraft, requireTemplate, WorkflowTemplateError } from "../work-board/template-graph.js";
import { resolveAuthorizedWorkspaceProject } from "../main/project-root-authorization.js";
import type { TemplateScope, WorkflowTemplateIpcResult } from "../shared/workflow-template-types.js";

export function registerWorkflowTemplateHandlers(
  deps: IpcDeps,
  isBoardOwnerFrame: (event: IpcMainInvokeEvent) => boolean,
  spendConfirmation: (event: IpcMainInvokeEvent, channel: typeof WORK_BOARD.templateConfirm, id: unknown, input: unknown, token: unknown) => boolean,
): void {
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
      catch (error) { return { ok: false, ...(error instanceof WorkflowTemplateError && error.refusals ? { refusals: error.refusals } : {}), error: error instanceof WorkflowTemplateError || error instanceof TemplateGestureError || error instanceof TemplateFrameError || error instanceof TemplateStoreUnavailableError ? error.code : "storage-error" }; }
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
  const requireOwnerFrame = (event: IpcMainInvokeEvent, channel: string) => {
    if (!isBoardOwnerFrame(event)) {
      auditUnauthorized(deps.auditLogger, channel, event);
      throw new TemplateFrameError();
    }
  };
  handle(WORK_BOARD.templateAttachSchedule, async (store, event, raw, ...args) => {
    const request = parseScheduleAttachmentRequest(raw);
    requireTemplate(args.length === 0 && request);
    requireOwnerFrame(event, WORK_BOARD.templateAttachSchedule);
    if (!securitySettingsGestures.consume(event.sender, { channel: WORK_BOARD.templateAttachSchedule, payload: raw }, "keyboard")) {
      throw new TemplateGestureError("user-keyboard-required");
    }
    const routines = deps.routinesStore;
    if (!routines) throw new TemplateStoreUnavailableError();
    const { attachment: result } = await attachWorkflowSchedule(store, routines, request, () => mintHostDecisionProof("local-desktop"), deps.auditLogger);
    logPermissionEvent("template_schedule_attached", { sessionId: permissionLogId(`work-board:${result.templateId}`) });
    return result;
  });
  handle(WORK_BOARD.templateDetachSchedule, async (store, event, id, ...args) => {
    requireTemplate(args.length === 0 && isTemplateId(id));
    requireOwnerFrame(event, WORK_BOARD.templateDetachSchedule);
    if (!securitySettingsGestures.consume(event.sender, { channel: WORK_BOARD.templateDetachSchedule, payload: id })) throw new TemplateGestureError();
    const attachment = await store.getAttachment(id); requireTemplate(attachment, "template-not-found");
    const proof = mintHostDecisionProof("local-desktop");
    const routines = deps.routinesStore;
    if (!routines) throw new TemplateStoreUnavailableError();
    return routines.withTemplateSchedule(attachment.scheduleId, async (remove) => {
      if (!await store.detachSchedule(id, proof)) return false;
      logPermissionEvent("template_schedule_detached", { sessionId: permissionLogId(`work-board:${attachment.templateId}`), attachmentId: permissionLogId(id) });
      await remove();
      return true;
    });
  });
  handle(WORK_BOARD.templateConfirm, async (store, event, id, raw, intent, ...args) => {
    const input = parseTemplateConfirmInput(raw);
    requireTemplate(args.length === 0 && isTemplateId(id) && input);
    requireOwnerFrame(event, WORK_BOARD.templateConfirm);
    if (!spendConfirmation(event, WORK_BOARD.templateConfirm, id, raw, intent)) throw new TemplateGestureError();
    const proposalId = isWorkflowTemplateProposalId(id) ? id : undefined;
    if (proposalId) loadProposal(proposalId);
    else {
      const { draft } = await load(id);
      if (draft) requireTemplate(authorizedScope(draft.scope), "scope-not-authorised");
    }
    const result = await store.confirmDraft(id, input, { who: "user", origin: "local-desktop" }, createToolEffectResolver(deps.toolRegistry));
    const { version } = result;
    logPermissionEvent("template_confirmed", { sessionId: permissionLogId(`work-board:${version.templateId}`), templateId: permissionLogId(version.templateId), version: version.version });
    return result;
  });
  handle(WORK_BOARD.templateArchive, async (store, _event, id, ...args) => { requireTemplate(args.length === 0); const record = await load(id); await store.archive(record.template.id); return null; });
}
class TemplateGestureError extends Error {
  constructor(readonly code: "user-gesture-required" | "user-keyboard-required" = "user-gesture-required") {
    super(code === "user-keyboard-required" ? "A desktop keyboard gesture is required" : "A desktop user gesture is required");
  }
}
class TemplateFrameError extends Error { readonly code = "unauthorized-frame"; }
class TemplateStoreUnavailableError extends Error { readonly code = "no-store"; }
