import { mintHostDecisionProof } from "../main/workflow-template-decision.js";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "./gated.js";
import { broadcastToAppWindows } from "./window-fanout.js";
import type { IpcDeps } from "./types.js";
import { WORK_BOARD } from "../shared/ipc-channels.js";
import { hasUserKeyboardIntent } from "../shared/chat-origin.js";
import { isWorkflowTemplateProposalId } from "../shared/workflow-template-types.js";
import { attachmentScopeMatches, hasTemplateKeys, isGraphHash, isTemplateId, isTemplateScope, isTemplateVersion, parseTemplateDraft, requireTemplate, WorkflowTemplateError } from "../work-board/template-graph.js";
import { resolveAuthorizedWorkspaceProject } from "../main/project-root-authorization.js";
import { isRoutineScheduleShape } from "../routines/schedule-advance.js";
import type { RoutineSchedule } from "../shared/routines-types.js";
import type { TemplateScope, WorkflowTemplateConfirmInput, WorkflowTemplateIpcResult } from "../shared/workflow-template-types.js";

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
  const requireLocalGesture = (event: IpcMainInvokeEvent, intent: unknown, channel: string) => {
    if (!hasUserKeyboardIntent(intent)) throw new TemplateGestureError();
    const sender = event.sender;
    const windows = deps.getAppWindows?.() ?? [deps.getMainWindow()];
    if (!sender || sender.isDestroyed() || event.senderFrame !== sender.mainFrame || !windows.some(w => w && !w.isDestroyed() && w.webContents === sender)) {
      auditUnauthorized(deps.auditLogger, channel, event); throw new TemplateFrameError();
    }
  };
  handle(WORK_BOARD.templateAttachSchedule, async (store, event, raw, intent, ...args) => {
    requireTemplate(args.length === 0 && hasTemplateKeys(raw, ["templateId", "version", "graphHash", "expectedScope", "scheduleId", "schedule"])
      && isTemplateId(raw.templateId) && isTemplateVersion(raw.version) && isGraphHash(raw.graphHash) && isTemplateScope(raw.expectedScope));
    const { templateId, version, graphHash, expectedScope, scheduleId, schedule } = raw;
    requireTemplate(scheduleId === undefined ? isAttachmentSchedule(schedule) : isTemplateId(scheduleId) && schedule === undefined);
    requireLocalGesture(event, intent, WORK_BOARD.templateAttachSchedule);
    const routines = deps.routinesStore;
    if (!routines) throw new TemplateStoreUnavailableError();
    const record = await store.get(templateId);
    requireTemplate(record.template.currentVersion === version, "not-current-version");
    let approvedScope = record.template.scope;
    if (approvedScope.kind === "project") {
      const resolved = resolveAuthorizedWorkspaceProject(approvedScope.projectRoot);
      requireTemplate(resolved.authorized && resolved.project, "scope-not-authorised");
      approvedScope = { kind: "project", projectRoot: resolved.project.projectRoot };
    }
    requireTemplate(attachmentScopeMatches({ approvedScope: expectedScope }, { scope: approvedScope }).ok, "scope-changed");
    const proof = mintHostDecisionProof("local-desktop");
    const created = scheduleId === undefined ? await routines.add({
      trigger: "schedule", execution: "template-run", schedule: schedule as RoutineSchedule,
      title: record.template.name, ...(approvedScope.kind === "project" ? { projectRoot: approvedScope.projectRoot } : {}),
      createdBy: "user",
    }, proof) : undefined;
    const id = created?.id ?? scheduleId;
    requireTemplate(typeof id === "string");
    const result = await routines.withTemplateSchedule(id, async (remove) => {
      requireTemplate(routines.list().some(routine => routine.id === id && routine.execution === "template-run"), "routine-not-found");
      try {
        return await routines.writeTemplateAttachment(id, approvedScope, () =>
          store.attachSchedule({ templateId, version, graphHash, scheduleId: id }, proof, approvedScope, { requireCurrent: true }));
      } catch (error) {
        if (created) {
          try { await remove(); }
          catch {
            deps.auditLogger.log({ timestamp: proof.decidedAt, sessionId: `work-board:${templateId}`, type: "approval", output: JSON.stringify({
              event: "template_schedule_cleanup_failed", scheduleId: id, auditId: proof.auditId,
            }) });
          }
        }
        throw error;
      }
    });
    deps.auditLogger.log({ timestamp: result.at, sessionId: `work-board:${result.templateId}`, type: "approval", output: JSON.stringify({ event: "template_schedule_attached", ...result, auditId: proof.auditId }) });
    return result;
  });
  handle(WORK_BOARD.templateDetachSchedule, async (store, event, id, intent, ...args) => {
    requireTemplate(args.length === 0 && isTemplateId(id));
    requireLocalGesture(event, intent, WORK_BOARD.templateDetachSchedule);
    const attachment = await store.getAttachment(id); requireTemplate(attachment, "template-not-found");
    const proof = mintHostDecisionProof("local-desktop");
    const routines = deps.routinesStore;
    if (!routines) throw new TemplateStoreUnavailableError();
    return routines.withTemplateSchedule(attachment.scheduleId, async (remove) => {
      if (!await store.detachSchedule(id, proof)) return false;
      deps.auditLogger.log({ timestamp: proof.decidedAt, sessionId: `work-board:${attachment.templateId}`, type: "approval", output: JSON.stringify({ event: "template_schedule_detached", attachmentId: id, ...proof }) });
      await remove();
      return true;
    });
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
class TemplateStoreUnavailableError extends Error { readonly code = "no-store"; }

function isAttachmentSchedule(value: unknown): value is RoutineSchedule {
  if (!isRoutineScheduleShape(value)) return false;
  const { at, repeat } = value;
  if (!hasTemplateKeys(value, ["at", "repeat"])) return false;
  if (!repeat) return at !== undefined;
  if (repeat.kind === "cron") return hasTemplateKeys(repeat, ["kind", "expression"]);
  return at !== undefined && hasTemplateKeys(repeat, repeat.kind === "interval" ? ["kind", "intervalMs"] : ["kind"]);
}
