import type { TranslateFn } from "../../../../i18n/translate.js";
import { isRecord } from "../../../../shared/is-record.js";
import type { ApprovalRequest } from "../../types.js";
import { builtinApprovalAction } from "./builtin-approval-action.js";

export function approvalAction(request: ApprovalRequest, t: TranslateFn): { title: string; primary: string | null } {
  const args = isRecord(request.args) ? request.args : {};
  if (request.browserSite) return { title: t("toolApprovalDialog.siteTitle", { origin: new URL(request.browserSite).origin }), primary: null };
  if (request.kind === "egress-host") return { title: t("egressApprovalCard.dockTitle"), primary: null };
  if (request.source === "builtin") return builtinApprovalAction(request, t);
  const scope = request.approvalMemory?.kind === "key" ? request.approvalMemory.scope : undefined;
  if (request.source === "mcp" || request.source === "plugin" || request.kind === "agent-action") {
    const server = scope?.kind === "mcp-tool" ? scope.serverId : request.sourcePluginId;
    const tool = scope?.kind === "mcp-tool" ? scope.toolName : request.toolName;
    if (server) return { title: t("toolApprovalDialog.externalActionTitle", { server, tool }), primary: JSON.stringify(args, null, 2) };
  }
  return { title: t(request.kind === "agent-action" ? "toolApprovalDialog.agentActionTitle" : "toolApprovalDialog.toolApprovalTitle"), primary: null };
}
