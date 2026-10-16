/**
 * The remembered-approval scope an invocation was authorized under, handed
 * to the tool at execute time.
 *
 * The executor derives `approvalMemoryScope` once, from the final input,
 * before any prompt is shown; the prompt describes that scope and a
 * remembered allow is matched against it. A tool whose target can change
 * between that moment and execution (a browser tab that navigates while the
 * user reads the card) compares the scope it was authorized under with the
 * live target, and refuses to act on a target nobody approved.
 *
 * Host-written only: the key is set by the executor from its own identity
 * derivation, never from tool input.
 */
import type { ApprovalMemoryScope } from "../shared/permissions-events.js";
import type { ToolExecutionContext } from "./types.js";

export const APPROVAL_MEMORY_SCOPE_METADATA_KEY = "approvalMemoryScope";

/** The scope this invocation was authorized under, or undefined when the tool keys on exact arguments. */
export function authorizedApprovalMemoryScope(
  ctx: Pick<ToolExecutionContext, "metadata"> | undefined,
): ApprovalMemoryScope | undefined {
  const value = ctx?.metadata?.[APPROVAL_MEMORY_SCOPE_METADATA_KEY];
  if (value === undefined || value === null || typeof value !== "object") return undefined;
  return value as ApprovalMemoryScope;
}
