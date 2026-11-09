import type { MessageCatalogKey } from "../../../../i18n/messages/en.js";
import type { TranslateFn } from "../../../../i18n/translate.js";
import { isRecord } from "../../../../shared/is-record.js";
import { parsePatchEnvelope, patchOperationPaths } from "../../../../shared/patch-envelope.js";
import type { ApprovalRequest } from "../../types.js";

interface BuiltinAction {
  readonly title: MessageCatalogKey;
  readonly kind: "command" | "path" | "transfer" | "fields" | "spawn" | "upload" | "questions" | "patch";
  readonly fields: readonly string[];
  readonly context: MessageCatalogKey;
}

/** One presentation descriptor per registered builtin; boot-registry coverage rejects missing entries. */
export const BUILTIN_APPROVAL_ACTIONS = {
  bash: { title: "toolApprovalDialog.commandActionTitle", kind: "command", fields: ["command","cmd"], context: "toolApprovalDialog.actionContext_command" },
  powershell: { title: "toolApprovalDialog.commandActionTitle", kind: "command", fields: ["command","cmd"], context: "toolApprovalDialog.actionContext_command" },
  terminal_run: { title: "toolApprovalDialog.commandActionTitle", kind: "command", fields: ["command","cmd"], context: "toolApprovalDialog.actionContext_command" },
  read_file: { title: "toolApprovalDialog.readActionTitle", kind: "path", fields: ["path","filePath"], context: "toolApprovalDialog.actionContext_file" },
  write_file: { title: "toolApprovalDialog.fileActionTitle", kind: "path", fields: ["path","filePath"], context: "toolApprovalDialog.actionContext_file" },
  edit_file: { title: "toolApprovalDialog.fileActionTitle", kind: "path", fields: ["path","filePath"], context: "toolApprovalDialog.actionContext_file" },
  append_file: { title: "toolApprovalDialog.fileActionTitle", kind: "path", fields: ["path","filePath"], context: "toolApprovalDialog.actionContext_file" },
  multi_edit: { title: "toolApprovalDialog.fileActionTitle", kind: "path", fields: ["path","filePath"], context: "toolApprovalDialog.actionContext_file" },
  apply_patch: { title: "toolApprovalDialog.patchActionTitle", kind: "patch", fields: ["patch"], context: "toolApprovalDialog.actionContext_file" },
  copy_path: { title: "toolApprovalDialog.copyActionTitle", kind: "transfer", fields: ["sourcePath","destinationPath"], context: "toolApprovalDialog.actionContext_file" },
  extract_archive: { title: "toolApprovalDialog.extractActionTitle", kind: "transfer", fields: ["archivePath","destinationPath"], context: "toolApprovalDialog.actionContext_file" },
  move_file: { title: "toolApprovalDialog.moveActionTitle", kind: "transfer", fields: ["sourcePath","destinationPath"], context: "toolApprovalDialog.actionContext_file" },
  delete_file: { title: "toolApprovalDialog.deleteActionTitle", kind: "path", fields: ["path","filePath"], context: "toolApprovalDialog.actionContext_file" },
  view_image: { title: "toolApprovalDialog.viewImageActionTitle", kind: "path", fields: ["path","filePath"], context: "toolApprovalDialog.actionContext_file" },
  read_document: { title: "toolApprovalDialog.readDocumentActionTitle", kind: "path", fields: ["path","filePath"], context: "toolApprovalDialog.actionContext_file" },
  open_document: { title: "toolApprovalDialog.openDocumentActionTitle", kind: "path", fields: ["path","filePath"], context: "toolApprovalDialog.actionContext_file" },
  list_files: { title: "toolApprovalDialog.listFilesActionTitle", kind: "path", fields: ["path","directory"], context: "toolApprovalDialog.actionContext_file" },
  glob_files: { title: "toolApprovalDialog.findFilesActionTitle", kind: "path", fields: ["path","pattern"], context: "toolApprovalDialog.actionContext_file" },
  grep_files: { title: "toolApprovalDialog.searchFilesActionTitle", kind: "path", fields: ["path","pattern"], context: "toolApprovalDialog.actionContext_file" },
  read_tool_result_chunk: { title: "toolApprovalDialog.readResultActionTitle", kind: "fields", fields: ["toolUseId","query","offset"], context: "toolApprovalDialog.actionContext_conversation" },
  memory_write: { title: "toolApprovalDialog.saveMemoryActionTitle", kind: "fields", fields: ["title","id","scope"], context: "toolApprovalDialog.actionContext_memory" },
  memory_search: { title: "toolApprovalDialog.searchMemoryActionTitle", kind: "fields", fields: ["query"], context: "toolApprovalDialog.actionContext_memory" },
  memory_read: { title: "toolApprovalDialog.readMemoryActionTitle", kind: "fields", fields: ["id"], context: "toolApprovalDialog.actionContext_memory" },
  memory_delete: { title: "toolApprovalDialog.deleteMemoryActionTitle", kind: "fields", fields: ["id"], context: "toolApprovalDialog.actionContext_memory" },
  bash_output: { title: "toolApprovalDialog.readShellActionTitle", kind: "fields", fields: ["shellId"], context: "toolApprovalDialog.actionContext_command" },
  bash_kill: { title: "toolApprovalDialog.stopShellActionTitle", kind: "fields", fields: ["shellId"], context: "toolApprovalDialog.actionContext_command" },
  plugin_studio_draft: { title: "toolApprovalDialog.draftActionTitle", kind: "fields", fields: ["name"], context: "toolApprovalDialog.actionContext_plugin" },
  plugin_studio_read: { title: "toolApprovalDialog.readDraftActionTitle", kind: "fields", fields: ["name"], context: "toolApprovalDialog.actionContext_plugin" },
  plugin_studio_validate: { title: "toolApprovalDialog.validateDraftActionTitle", kind: "fields", fields: ["name"], context: "toolApprovalDialog.actionContext_plugin" },
  web_search: { title: "toolApprovalDialog.searchWebActionTitle", kind: "fields", fields: ["query"], context: "toolApprovalDialog.actionContext_web" },
  web_fetch: { title: "toolApprovalDialog.fetchActionTitle", kind: "fields", fields: ["url"], context: "toolApprovalDialog.actionContext_web" },
  render_html: { title: "toolApprovalDialog.renderActionTitle", kind: "fields", fields: ["title"], context: "toolApprovalDialog.actionContext_conversation" },
  ask_user_question: { title: "toolApprovalDialog.questionActionTitle", kind: "questions", fields: ["questions"], context: "toolApprovalDialog.actionContext_conversation" },
  routine_schedule: { title: "toolApprovalDialog.routineActionTitle", kind: "fields", fields: ["action","title","routineId"], context: "toolApprovalDialog.actionContext_conversation" },
  session_tasks: { title: "toolApprovalDialog.tasksActionTitle", kind: "fields", fields: ["action","steps"], context: "toolApprovalDialog.actionContext_conversation" },
  session_goal: { title: "toolApprovalDialog.goalActionTitle", kind: "fields", fields: ["goal","status"], context: "toolApprovalDialog.actionContext_conversation" },
  agent_spawn: { title: "toolApprovalDialog.spawnActionUntitled", kind: "spawn", fields: ["title","resumeId"], context: "toolApprovalDialog.actionContext_conversation" },
  agent_status: { title: "toolApprovalDialog.agentStatusActionTitle", kind: "fields", fields: ["id"], context: "toolApprovalDialog.actionContext_conversation" },
  agent_interrupt: { title: "toolApprovalDialog.interruptAgentActionTitle", kind: "fields", fields: ["id"], context: "toolApprovalDialog.actionContext_conversation" },
  agent_guide: { title: "toolApprovalDialog.guideAgentActionTitle", kind: "fields", fields: ["childSessionId"], context: "toolApprovalDialog.actionContext_conversation" },
  agent_list: { title: "toolApprovalDialog.listAgentsActionTitle", kind: "fields", fields: ["status"], context: "toolApprovalDialog.actionContext_conversation" },
  agent_send: { title: "toolApprovalDialog.sendAgentActionTitle", kind: "fields", fields: ["to"], context: "toolApprovalDialog.actionContext_conversation" },
  terminal_read: { title: "toolApprovalDialog.readTerminalActionTitle", kind: "fields", fields: ["terminalSessionId","tabId","blockId"], context: "toolApprovalDialog.actionContext_conversation" },
  browser_tabs: { title: "toolApprovalDialog.tabsActionTitle", kind: "fields", fields: ["select","scope"], context: "toolApprovalDialog.actionContext_browser" },
  browser_snapshot: { title: "toolApprovalDialog.snapshotActionTitle", kind: "fields", fields: ["tabId"], context: "toolApprovalDialog.actionContext_browser" },
  browser_screenshot: { title: "toolApprovalDialog.screenshotActionTitle", kind: "fields", fields: ["tabId"], context: "toolApprovalDialog.actionContext_browser" },
  browser_wait: { title: "toolApprovalDialog.waitPageActionTitle", kind: "fields", fields: ["tabId","text","timeMs"], context: "toolApprovalDialog.actionContext_browser" },
  browser_navigate: { title: "toolApprovalDialog.navigateActionTitle", kind: "fields", fields: ["url","tabId"], context: "toolApprovalDialog.actionContext_browser" },
  browser_click: { title: "toolApprovalDialog.clickPageActionTitle", kind: "fields", fields: ["tabId","ref"], context: "toolApprovalDialog.actionContext_browser" },
  browser_hover: { title: "toolApprovalDialog.hoverPageActionTitle", kind: "fields", fields: ["tabId","ref"], context: "toolApprovalDialog.actionContext_browser" },
  browser_drag: { title: "toolApprovalDialog.dragPageActionTitle", kind: "transfer", fields: ["sourceRef","targetRef"], context: "toolApprovalDialog.actionContext_browser" },
  browser_select: { title: "toolApprovalDialog.selectPageActionTitle", kind: "fields", fields: ["tabId","ref","value"], context: "toolApprovalDialog.actionContext_browser" },
  browser_scroll: { title: "toolApprovalDialog.scrollPageActionTitle", kind: "fields", fields: ["tabId","ref","direction","pixels"], context: "toolApprovalDialog.actionContext_browser" },
  browser_upload: { title: "toolApprovalDialog.uploadActionTitle", kind: "upload", fields: ["ref"], context: "toolApprovalDialog.actionContext_browser" },
  browser_type: { title: "toolApprovalDialog.typePageActionTitle", kind: "fields", fields: ["tabId","ref"], context: "toolApprovalDialog.actionContext_browser" },
  browser_press_key: { title: "toolApprovalDialog.pressPageActionTitle", kind: "fields", fields: ["tabId","ref","key"], context: "toolApprovalDialog.actionContext_browser" },
  browser_tab_new: { title: "toolApprovalDialog.newTabActionTitle", kind: "fields", fields: ["url"], context: "toolApprovalDialog.actionContext_browser" },
  browser_tab_close: { title: "toolApprovalDialog.closeTabActionTitle", kind: "fields", fields: ["tabId"], context: "toolApprovalDialog.actionContext_browser" },
  skill_load: { title: "toolApprovalDialog.loadSkillActionTitle", kind: "fields", fields: ["skillName"], context: "toolApprovalDialog.actionContext_conversation" },
  skill_list: { title: "toolApprovalDialog.listSkillsActionTitle", kind: "fields", fields: ["query"], context: "toolApprovalDialog.actionContext_conversation" },
  skill_read: { title: "toolApprovalDialog.readSkillActionTitle", kind: "fields", fields: ["skillName","resourcePath"], context: "toolApprovalDialog.actionContext_conversation" },
  mcp_resource_list: { title: "toolApprovalDialog.listResourcesActionTitle", kind: "fields", fields: ["serverId","serverIds"], context: "toolApprovalDialog.actionContext_conversation" },
  mcp_resource_read: { title: "toolApprovalDialog.readResourceActionTitle", kind: "fields", fields: ["serverId","uri"], context: "toolApprovalDialog.actionContext_conversation" },
  request_plugin: { title: "toolApprovalDialog.requestPluginActionTitle", kind: "fields", fields: ["name","query","pluginId"], context: "toolApprovalDialog.actionContext_plugin" },
  tool_search: { title: "toolApprovalDialog.searchToolsActionTitle", kind: "fields", fields: ["query"], context: "toolApprovalDialog.actionContext_conversation" },
} as const satisfies Record<string, BuiltinAction>;

function displayValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return value.join(", ") || undefined;
  return undefined;
}

export function builtinApprovalAction(request: ApprovalRequest, t: TranslateFn): { title: string; primary: string } {
  const args = isRecord(request.args) ? request.args : {};
  const descriptor: BuiltinAction | undefined = Object.hasOwn(BUILTIN_APPROVAL_ACTIONS, request.toolName)
    ? BUILTIN_APPROVAL_ACTIONS[request.toolName as keyof typeof BUILTIN_APPROVAL_ACTIONS] : undefined;
  if (!descriptor) {
    const subject = ["effect", "methodPath", "target", "action", "url", "path", "name", "id", "title"]
      .map(field => displayValue(args[field])).filter(Boolean).join(" · ");
    return { title: t("toolApprovalDialog.builtinActionTitle"), primary: subject || request.toolName };
  }
  const fallback = t(descriptor.context);
  const scope = request.approvalMemory?.kind === "key" ? request.approvalMemory.scope : undefined;
  let title = t(descriptor.title);
  let primary = descriptor.fields.map(field => displayValue(args[field])).filter(Boolean).join(" · ") || fallback;
  if (descriptor.kind === "path") {
    const path = request.target?.filePath ?? request.outOfAllowedDir?.candidatePath;
    if (path) primary = [path, ...descriptor.fields.filter(field => field !== "path" && field !== "filePath").map(field => displayValue(args[field]))].filter(Boolean).join(" · ");
  }
  if (descriptor.kind === "transfer") {
    const source = scope?.kind === "transfer" ? scope.sourcePath : displayValue(args[descriptor.fields[0] ?? ""]) ?? t("toolApprovalDialog.unknown");
    const destination = scope?.kind === "transfer" ? scope.destinationPath : displayValue(args[descriptor.fields[1] ?? ""]) ?? t("toolApprovalDialog.unknown");
    primary = t("toolApprovalDialog.copyActionPrimary", { source, destination });
  }
  if (descriptor.kind === "spawn") {
    const subject = displayValue(args.title);
    if (displayValue(args.resumeId)) title = t("toolApprovalDialog.resumeActionTitle");
    else if (subject) title = t("toolApprovalDialog.spawnActionTitle", { title: subject });
  }
  if (descriptor.kind === "upload") {
    const destination = scope?.kind === "browser-origin" ? scope.origin : displayValue(args.tabId) ?? fallback;
    primary = t("toolApprovalDialog.uploadActionPrimary", { destination, ref: displayValue(args.ref) ?? t("toolApprovalDialog.unknown") });
  }
  if (descriptor.kind === "questions" && Array.isArray(args.questions)) {
    primary = args.questions.filter(isRecord).map(question => displayValue(question.question) ?? displayValue(question.title)).filter(Boolean).join(" · ") || primary;
  }
  if (descriptor.kind === "patch") {
    const patch = typeof args.patch === "string" ? parsePatchEnvelope(args.patch) : undefined;
    primary = patch?.ok ? patchOperationPaths(patch.operations).join(" · ") : request.target?.filePath ?? fallback;
  }
  return { title, primary };
}
