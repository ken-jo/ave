/** "Open in default app" for a project file. Call `run` straight from a click or key handler: preload reads the user-gesture
 * flag at the moment of the call, and main refuses the open without it. */
import { useCallback, useState } from "react";
import type { WorkspaceOpenPathResult } from "../../../../ipc/domains/workspace.js";

type OpenRefusal = Extract<WorkspaceOpenPathResult, { ok: false }>["error"];

/** One message per refusal a user can act on differently; the rest say the open failed. */
function openRefusalKey(error: OpenRefusal): string {
  switch (error) {
    case "denied_extension":
    case "executable": return "folderView.openRefusedExecutable";
    case "outside-project": return "folderView.openRefusedOutside";
    case "not-found":
    case "changed": return "folderView.openRefusedChanged";
    case "user-keyboard-required": return "folderView.openRefusedGesture";
    case "sensitive-path":
    case "path-not-allowed":
    case "root-not-registered": return "folderView.openRefusedScope";
    default: return "folderView.openFailed";
  }
}

export function useOpenInDefaultApp(projectRoot: string): { run: (path: string) => Promise<void>; pending: boolean; error: string | null } {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (path: string) => {
    setError(null);
    setPending(true);
    try {
      // Synchronous up to the IPC call, so the gesture is still active when preload reads it.
      const result = await window.ave.workspace.openPath(projectRoot, path);
      if (!result.ok) setError(openRefusalKey(result.error));
    } catch {
      setError("folderView.openFailed");
    } finally {
      setPending(false);
    }
  }, [projectRoot]);
  return { run, pending, error };
}
