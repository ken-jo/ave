import type { TranslateFn } from "../i18n/translate.js";
import { isRecord } from "./is-record.js";
import type { ToolCategory } from "./permission-review-status.js";

interface ApprovalAction {
  toolName: string;
  toolCategory?: ToolCategory;
  args: unknown;
  target?: { filePath?: string };
  kind?: string;
  outOfAllowedDir?: { candidatePath: string };
}

/** Describe the requested effect from structured input, never the policy adjudication reason. */
export function approvalActionSummary(request: ApprovalAction, translate: TranslateFn): string {
  const args = isRecord(request.args) ? request.args : {};
  const path = request.target?.filePath
    || request.outOfAllowedDir?.candidatePath
    || (typeof args.path === "string" ? args.path : "")
    || (typeof args.filePath === "string" ? args.filePath : "");
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  if (request.kind === "out-of-allowed-dir") {
    return translate("approvalAction.outsideDirectory", { target: name });
  }
  if (name) {
    if (request.toolName === "write_file" || request.toolName === "append_file") {
      return translate("approvalAction.writeFile", { target: name });
    }
    if (request.toolName === "edit_file") return translate("approvalAction.editFile", { target: name });
    if (request.toolName === "read_file") return translate("approvalAction.readFile", { target: name });
  }
  switch (request.toolCategory) {
    case "read": return translate("toolApprovalDialog.impactRead");
    case "write": return translate("toolApprovalDialog.impactWrite");
    case "network": return translate("toolApprovalDialog.impactNetwork");
    case "shell": return translate("toolApprovalDialog.impactShell");
    default: return translate("toolApprovalDialog.impactMeta");
  }
}
