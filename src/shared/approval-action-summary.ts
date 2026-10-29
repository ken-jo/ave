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
export function approvalActionSummary(
  request: ApprovalAction,
  translate: TranslateFn,
  options: { maxCharacters?: number } = {},
): string {
  const args = isRecord(request.args) ? request.args : {};
  const path = request.target?.filePath
    || request.outOfAllowedDir?.candidatePath
    || (typeof args.path === "string" ? args.path : "")
    || (typeof args.filePath === "string" ? args.filePath : "");
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const describeTarget = (key: string): string => {
    const fixedCharacters = [...translate(key, { target: "" })].length;
    const available = options.maxCharacters === undefined ? Infinity : Math.max(1, options.maxCharacters - fixedCharacters);
    const target = [...name];
    const boundedTarget = target.length > available ? target.slice(0, available - 1).join("") + "…" : name;
    return translate(key, { target: boundedTarget });
  };
  if (request.kind === "out-of-allowed-dir") {
    return describeTarget("approvalAction.outsideDirectory");
  }
  if (name) {
    if (request.toolName === "write_file" || request.toolName === "append_file") {
      return describeTarget("approvalAction.writeFile");
    }
    if (request.toolName === "edit_file") return describeTarget("approvalAction.editFile");
    if (request.toolName === "read_file") return describeTarget("approvalAction.readFile");
  }
  if (options.maxCharacters !== undefined) {
    switch (request.toolCategory) {
      case "read": return translate("approvalAction.read");
      case "write": return translate("approvalAction.write");
      case "network": return translate("approvalAction.network");
      case "shell": return translate("approvalAction.shell");
      default: return translate("approvalAction.meta");
    }
  }
  switch (request.toolCategory) {
    case "read": return translate("toolApprovalDialog.impactRead");
    case "write": return translate("toolApprovalDialog.impactWrite");
    case "network": return translate("toolApprovalDialog.impactNetwork");
    case "shell": return translate("toolApprovalDialog.impactShell");
    default: return translate("toolApprovalDialog.impactMeta");
  }
}
