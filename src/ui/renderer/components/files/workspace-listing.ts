/** The one way a file explorer asks main for a folder's listing. A call that never reached main is the listing's own
 * "could not be read" result, so both explorers show one failure state for it. */
import type { WorkspaceListDirResult } from "../../../../ipc/domains/workspace.js";

export async function listWorkspaceDir(path: string): Promise<WorkspaceListDirResult> {
  try {
    return await window.ave.workspace.listDir(path);
  } catch {
    return { ok: false, error: "read-failed" };
  }
}
