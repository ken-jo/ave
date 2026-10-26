import type { WorkspaceFileItem } from "../preview/preview-targets.js";

export const FILE_CHANGE_ADDED_CLASS = "text-(--file-change-add-fg)";
export const FILE_CHANGE_REMOVED_CLASS = "text-(--file-change-delete-fg)";
export const SESSION_FILE_BADGE_CLASS = "bg-(--file-change-session-bg) text-(--file-change-session-fg)";
export const FILE_CHANGE_FOLDER_BADGE_CLASS = "bg-(--file-change-modify-bg) text-(--file-change-modify-fg)";
export const FILE_CHANGE_SELECTED_CLASS = "bg-(--file-change-selection-bg) text-foreground";
export function fileChangeLetter(operation: WorkspaceFileItem["operation"]): string {
  return operation === "create" ? "A" : operation === "delete" ? "D" : operation === "move" ? "R" : "M";
}
export function fileChangeBadgeClass(operation: WorkspaceFileItem["operation"]): string {
  return operation === "create" ? "bg-(--file-change-add-bg) text-(--file-change-add-fg)"
    : operation === "delete" ? "bg-(--file-change-delete-bg) text-(--file-change-delete-fg)"
      : operation === "move" ? SESSION_FILE_BADGE_CLASS : FILE_CHANGE_FOLDER_BADGE_CLASS;
}
