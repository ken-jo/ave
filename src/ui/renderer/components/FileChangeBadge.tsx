import { cn } from "../../../lib/utils.js";
import type { WorkspaceChangeFile } from "../preview/workspace-changes.js";
import { FILE_CHANGE_ADDED_CLASS, FILE_CHANGE_REMOVED_CLASS, fileChangeBadgeClass, fileChangeLetter } from "./file-change-style.js";

interface FileChangeBadgeProps {
  change: Pick<WorkspaceChangeFile, "added" | "removed" | "countsKnown" | "operation">;
  operationTitle: string;
}

export function FileChangeBadge({ change, operationTitle }: FileChangeBadgeProps) {
  return <>
    <span className="shrink-0 font-mono text-[11px]" data-testid="chat-side-panel-file-change-counts"><span className={FILE_CHANGE_ADDED_CLASS}>+{change.countsKnown ? change.added : "—"}</span>{" "}<span className={FILE_CHANGE_REMOVED_CLASS}>−{change.countsKnown ? change.removed : "—"}</span></span>
    <span title={operationTitle} data-testid="chat-side-panel-file-change-operation" className={cn("flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold", fileChangeBadgeClass(change.operation))}>{fileChangeLetter(change.operation)}</span>
  </>;
}
