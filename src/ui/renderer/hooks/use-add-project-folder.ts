import { useCallback, useState } from "react";
import { projectBasename, type WorkspaceRootIdentity } from "../../../shared/project-identity.js";

export interface PendingRootWarning {
  path: string;
  warnings: string[];
  ackToken: string;
}

/**
 * How a project surface hands a refused mutation — or a project list the
 * backend could not vouch for — to the app-level toast.
 *
 * The operation is passed rather than a ready-made sentence because the code
 * usually resolves to a localized message on its own; the operation only names
 * the context for a code the shared IPC table does not know.
 */
export type ProjectErrorReporter = (
  operation: "add" | "remove" | "list" | "new-chat",
  error?: string,
  message?: string,
) => void;

/** Keep cancelled, warning, added and failed outcomes distinct; only failed carries a localized IPC error code. */
export type AddProjectFolderOutcome =
  | { status: "added"; roots: WorkspaceRootIdentity[]; added: string | null }
  | { status: "canceled" }
  | { status: "needs-acknowledgement" }
  | { status: "failed"; error?: string };

export interface UseAddProjectFolderResult {
  /** Adjacency warnings awaiting acknowledgement — null when idle. */
  pendingWarning: PendingRootWarning | null;
  /** Open the native folder picker (`workspace.pickRoot`). The caller owns what happens to the resulting root list (e.g.
   * switch the active project, refresh a project list) AND surfacing a `failed` outcome. */
  addFolder: () => Promise<AddProjectFolderOutcome>;
  /** Echo the pending warning's ackToken to confirm the add despite adjacency warnings. */
  confirmPendingFolder: () => Promise<AddProjectFolderOutcome>;
  /** Dismiss the pending warning without adding the folder. */
  cancelPendingFolder: () => void;
  /** Raw setter — for producers that resolve a pending warning through a
   *  different IPC round trip than `pickRoot` (e.g. ChatSidePanel's drag-drop
   *  add-root, which validates via `workspace.dropPrepare` first). All
   *  producers still funnel into this ONE state + the same
   *  `confirmPendingFolder`/`cancelPendingFolder` resolution path. */
  setPendingWarning: (warning: PendingRootWarning | null) => void;
}

/** Share the pickRoot acknowledgement-token state machine across entry points; callers own list refresh and selection after
 * success. */
export function useAddProjectFolder(): UseAddProjectFolderResult {
  const [pendingWarning, setPendingWarning] = useState<PendingRootWarning | null>(null);

  const addFolder = useCallback(async (): Promise<AddProjectFolderOutcome> => {
    const res = await window.ave.workspace.pickRoot();
    if (!res.ok) return { status: "failed", ...(res.error ? { error: res.error } : {}) };
    if (res.requiresAcknowledgement && res.pendingPath && res.ackToken) {
      setPendingWarning({ path: res.pendingPath, warnings: res.warnings ?? [], ackToken: res.ackToken });
      return { status: "needs-acknowledgement" };
    }
    // `ok` without a root list is the dialog being dismissed — main answers a cancel with `{ ok: true, canceled: true, roots
    // }`, so an absent list can only mean the pick produced nothing to apply.
    if (!res.roots) return { status: "canceled" };
    return { status: "added", roots: res.roots, added: res.added ?? null };
  }, []);

  const confirmPendingFolder = useCallback(async (): Promise<AddProjectFolderOutcome> => {
    const pending = pendingWarning;
    if (!pending) return { status: "canceled" };
    // Second, explicit confirmation — echo the one-time token (never a path). Main persists the token-bound dialog path and
    // still hard-refuses a sensitive/root path even when acknowledged.
    const res = await window.ave.workspace.pickRoot({ ackToken: pending.ackToken });
    setPendingWarning(null);
    if (!res.ok) return { status: "failed", ...(res.error ? { error: res.error } : {}) };
    if (!res.roots) return { status: "canceled" };
    return { status: "added", roots: res.roots, added: res.added ?? null };
  }, [pendingWarning]);

  const cancelPendingFolder = useCallback(() => {
    setPendingWarning(null);
  }, []);

  return { pendingWarning, addFolder, confirmPendingFolder, cancelPendingFolder, setPendingWarning };
}

/** Display basename for an added root path, falling back to the raw path. */
export function addedRootDisplayName(path: string): string {
  return projectBasename(path) || path;
}
