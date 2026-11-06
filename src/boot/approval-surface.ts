import type { WebContents } from "electron";
import { approvalSurfaceRegistry, updateApprovalSurface, type ApprovalSurfaceRegistry } from "../permissions/approval-surface-registry.js";
import type { ApprovalSurfaceResolver } from "../permissions/approval-gate.js";

/** Read explicit host registrations; run kinds and chat holders never imply consent authority. */
export function approvalSurfaceResolver(
  registry?: Readonly<Pick<ApprovalSurfaceRegistry, "resolve" | "observeOwnerReleased" | "unobserveOwnerReleased">>,
): ApprovalSurfaceResolver {
  return Object.assign(
    (sessionId: string | undefined, terminalTabId?: string) => (registry ?? approvalSurfaceRegistry).resolve(sessionId, terminalTabId),
    { observeOwnerReleased: (listener: (owner: WebContents) => void) => {
      updateApprovalSurface({ kind: "observe-owner-release", listener, registry });
      return () => updateApprovalSurface({ kind: "unobserve-owner-release", listener, registry });
    } },
  );
}
