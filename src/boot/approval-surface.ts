import { approvalSurfaceRegistry, type ApprovalSurfaceRegistry } from "../permissions/approval-surface-registry.js";
import type { ApprovalSurfaceResolver } from "../permissions/approval-gate.js";

/** Read explicit host registrations; run kinds and chat holders never imply consent authority. */
export function approvalSurfaceResolver(
  registry: Readonly<Pick<ApprovalSurfaceRegistry, "resolve">> = approvalSurfaceRegistry,
): ApprovalSurfaceResolver {
  return (sessionId, terminalTabId) => registry.resolve(sessionId, terminalTabId);
}
