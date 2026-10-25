// Host-derived approval scope is fixed before prompting; compare it with the live target at execution to prevent TOCTOU.
// Tool input must never supply this scope.
import type { ApprovalMemoryScope } from "../shared/permissions-events.js";
import type { ToolExecutionContext } from "./types.js";

export const APPROVAL_MEMORY_SCOPE_METADATA_KEY = "approvalMemoryScope";

// Undefined means approval is keyed on exact arguments.
export function authorizedApprovalMemoryScope(
  ctx: Pick<ToolExecutionContext, "metadata"> | undefined,
): ApprovalMemoryScope | undefined {
  const value = ctx?.metadata?.[APPROVAL_MEMORY_SCOPE_METADATA_KEY];
  if (value === undefined || value === null || typeof value !== "object") return undefined;
  return value as ApprovalMemoryScope;
}
