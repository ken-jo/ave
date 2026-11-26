import type { WebContents } from "electron";
import type { MainWindow } from "../main/main-window-host.js";
import { findWorkBoardProjectRecipient, workBoardProjectAllows } from "../ipc/work-board-project-scope.js";
import { approvalSurfaceRegistry, updateApprovalSurface, type ApprovalSurfaceRegistry } from "../permissions/approval-surface-registry.js";
import type { ApprovalSurfaceResolver } from "../permissions/approval-gate.js";

/** Read explicit host registrations; run kinds and chat holders never imply consent authority. */
export function approvalSurfaceResolver(
  registry?: Readonly<Pick<ApprovalSurfaceRegistry, "resolve" | "projectOf" | "observeOwnerReleased" | "unobserveOwnerReleased">>,
  windows?: () => Array<MainWindow | null | undefined>,
): ApprovalSurfaceResolver {
  return Object.assign(
    (sessionId: string | undefined, terminalTabId?: string) => (registry ?? approvalSurfaceRegistry).resolve(sessionId, terminalTabId),
    {
      projectOf: (sessionId: string | undefined) => (registry ?? approvalSurfaceRegistry).projectOf(sessionId),
      findProjectRecipient: (root: string | undefined) => findWorkBoardProjectRecipient(windows?.() ?? [], root),
      projectAllows: (recipient: WebContents, root: string | undefined) =>
        workBoardProjectAllows(recipient, root)
        && windows?.().some(window => window && !window.isDestroyed() && window.webContents === recipient) === true,
      observeOwnerReleased: (listener: (owner: WebContents) => void) => {
        updateApprovalSurface({ kind: "observe-owner-release", listener, registry });
        return () => updateApprovalSurface({ kind: "unobserve-owner-release", listener, registry });
      },
    },
  );
}
