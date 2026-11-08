import type { TranslateFn } from "../../../../i18n/translate.js";
import { isRecord } from "../../../../shared/is-record.js";
import type { ApprovalRequest } from "../../types.js";

export function approvalAction(request: ApprovalRequest, t: TranslateFn): { title: string; primary: string | null } {
  const args = isRecord(request.args) ? request.args : {};
  if (request.browserSite) return { title: t("toolApprovalDialog.siteTitle", { origin: new URL(request.browserSite).origin }), primary: null };
  if (request.kind === "egress-host") return { title: t("egressApprovalCard.dockTitle"), primary: null };
  if (request.source === "builtin" && request.toolName === "agent_spawn") {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    return { title: title ? t("toolApprovalDialog.spawnActionTitle", { title }) : t("toolApprovalDialog.spawnActionUntitled"), primary: null };
  }
  const scope = request.approvalMemory?.kind === "key" ? request.approvalMemory.scope : undefined;
  if (request.source === "mcp" || request.source === "plugin" || request.kind === "agent-action") {
    const server = scope?.kind === "mcp-tool" ? scope.serverId : request.sourcePluginId;
    const tool = scope?.kind === "mcp-tool" ? scope.toolName : request.toolName;
    if (server) return { title: t("toolApprovalDialog.externalActionTitle", { server, tool }), primary: JSON.stringify(args, null, 2) };
  }
  if (request.source === "builtin" && (request.toolCategory === "shell" || ["bash", "powershell", "terminal_run"].includes(request.toolName))) {
    const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : null;
    return { title: t("toolApprovalDialog.commandActionTitle"), primary: command };
  }
  if (request.source === "builtin" && ["read_file", "write_file", "edit_file", "append_file"].includes(request.toolName)) {
    const path = request.target?.filePath ?? request.outOfAllowedDir?.candidatePath
      ?? (typeof args.path === "string" ? args.path : typeof args.filePath === "string" ? args.filePath : null);
    return { title: t(request.toolName === "read_file" ? "toolApprovalDialog.readActionTitle" : "toolApprovalDialog.fileActionTitle"), primary: path };
  }
  if (request.source === "builtin" && request.toolName === "copy_path") {
    const source = scope?.kind === "transfer" ? scope.sourcePath : typeof args.sourcePath === "string" ? args.sourcePath : t("toolApprovalDialog.unknown");
    const destination = scope?.kind === "transfer" ? scope.destinationPath : typeof args.destinationPath === "string" ? args.destinationPath : t("toolApprovalDialog.unknown");
    return { title: t("toolApprovalDialog.copyActionTitle"), primary: t("toolApprovalDialog.copyActionPrimary", { source, destination }) };
  }
  if (request.source === "builtin" && request.toolName === "web_fetch") {
    return { title: t("toolApprovalDialog.fetchActionTitle"), primary: typeof args.url === "string" ? args.url : null };
  }
  if (request.source === "builtin" && request.toolName === "browser_upload") {
    const destination = scope?.kind === "browser-origin" ? scope.origin : typeof args.tabId === "string" ? args.tabId : t("toolApprovalDialog.unknown");
    const ref = typeof args.ref === "string" ? args.ref : t("toolApprovalDialog.unknown");
    return { title: t("toolApprovalDialog.uploadActionTitle"), primary: t("toolApprovalDialog.uploadActionPrimary", { destination, ref }) };
  }
  return { title: t(request.kind === "agent-action" ? "toolApprovalDialog.agentActionTitle" : "toolApprovalDialog.toolApprovalTitle"), primary: null };
}
