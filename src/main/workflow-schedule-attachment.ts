import { logPermissionEvent, permissionLogId } from "../lib/permission-log.js";
import type { ScheduleAttachmentRequest } from "../shared/workflow-template-types.js";
import type { ToolEffectResolver } from "../permissions/tool-effect-evidence.js";
import { attachmentScopeMatches, requireTemplate } from "../work-board/template-graph.js";
import { WorkDecisionAuthorityError } from "../work-board/work-decision-authority.js";
import { resolveAuthorizedWorkspaceProject } from "./project-root-authorization.js";
import type { RoutinesStore } from "./routines-store.js";
import type { HostDecisionProof } from "./workflow-template-decision.js";
import type { WorkflowTemplateStore } from "./workflow-template-store.js";

export async function attachWorkflowSchedule(
  store: WorkflowTemplateStore,
  routines: RoutinesStore,
  request: ScheduleAttachmentRequest,
  effects: ToolEffectResolver,
  mintProof: () => HostDecisionProof,
) {
  const { templateId, version, graphHash, expectedScope } = request;
  const record = await store.get(templateId);
  requireTemplate(record.template.currentVersion === version, "not-current-version");
  let approvedScope = record.template.scope;
  if (approvedScope.kind === "project") {
    const resolved = resolveAuthorizedWorkspaceProject(approvedScope.projectRoot);
    requireTemplate(resolved.authorized && resolved.project, "scope-not-authorised");
    approvedScope = { kind: "project", projectRoot: resolved.project.projectRoot };
  }
  requireTemplate(attachmentScopeMatches({ approvedScope: expectedScope }, { scope: approvedScope }).ok, "scope-changed");

  const proof = mintProof();
  if (proof.origin === "tailnet-surface" && !await proof.remote.authority.refreshCurrent()) throw new WorkDecisionAuthorityError();
  const created = "schedule" in request ? await routines.add({
    trigger: "schedule", execution: "template-run", schedule: request.schedule,
    title: record.template.name, ...(approvedScope.kind === "project" ? { projectRoot: approvedScope.projectRoot } : {}),
    createdBy: "user",
  }, proof) : undefined;
  const id = "scheduleId" in request ? request.scheduleId : created?.id;
  requireTemplate(typeof id === "string");

  const attachment = await routines.withTemplateSchedule(id, async remove => {
    try {
      requireTemplate(routines.list().some(routine => routine.id === id && routine.execution === "template-run"), "routine-not-found");
      return await routines.writeTemplateAttachment(id, approvedScope, () =>
        store.attachSchedule({ templateId, version, graphHash, scheduleId: id }, proof, approvedScope, { requireCurrent: true, effects }));
    } catch (error) {
      if (created) {
        try { await remove(); }
        catch {
          logPermissionEvent("template_schedule_cleanup_failed", { sessionId: permissionLogId(`work-board:${templateId}`) }, "warn");
        }
      }
      throw error;
    }
  });
  return { attachment, auditId: proof.auditId };
}
