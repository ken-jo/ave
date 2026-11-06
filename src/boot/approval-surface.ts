import { approvalSurfaceRegistry, type ApprovalSurfaceRegistry } from "../permissions/approval-surface-registry.js";
import type { ApprovalSurfaceResolver } from "../permissions/approval-gate.js";

/** Read explicit host registrations; run kinds and chat holders never imply consent authority. */
export function approvalSurfaceResolver(
  registry: Readonly<Pick<ApprovalSurfaceRegistry, "resolve" | "observeOwnerReleased">> = approvalSurfaceRegistry,
): ApprovalSurfaceResolver {
  return Object.assign(
    (sessionId: string | undefined, terminalTabId?: string) => registry.resolve(sessionId, terminalTabId),
    { observeOwnerReleased: registry.observeOwnerReleased.bind(registry) },
  );
}
