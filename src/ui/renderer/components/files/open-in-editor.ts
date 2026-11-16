/** "Open in editor" for a project file: main starts the editor command the user set. Call `openInEditor` straight from a
 * click or key handler; its first statement is the IPC call, so the user gesture is still active when preload reads it. */
import type { WorkspaceOpenInEditorResult } from "../../../../ipc/domains/workspace.js";

/** The notice for "no editor command is set"; a host that shows it also offers the way to the setting. */
export const EDITOR_NOT_CONFIGURED_KEY = "folderView.editorNotConfigured";

/** Where the editor command is set. */
export const EDITOR_COMMAND_SETTINGS_PATH = { tab: "about", section: "chat-documents" } as const;

type Refusal = Extract<WorkspaceOpenInEditorResult, { ok: false }>["error"];

function refusalKey(error: Refusal): string {
  switch (error) {
    case "not-configured": return EDITOR_NOT_CONFIGURED_KEY;
    case "invalid-command": return "folderView.editorInvalidCommand";
    case "launch-failed": return "folderView.editorLaunchFailed";
    case "network-target":
    case "outside-project": return "folderView.openRefusedOutside";
    case "not-found":
    case "changed": return "folderView.openRefusedChanged";
    case "user-keyboard-required": return "folderView.openRefusedGesture";
    case "sensitive-path":
    case "path-not-allowed":
    case "root-not-registered": return "folderView.openRefusedScope";
    default: return "folderView.editorFailed";
  }
}

/** Ask main to open `path` in the user's editor. Resolves to null when the editor started, else the i18n key of why not. */
export function openInEditor(projectRoot: string, path: string, line?: number): Promise<string | null> {
  return window.ave.workspace.openInEditor(projectRoot, path, line).then(
    (result) => (result.ok ? null : refusalKey(result.error)),
    () => "folderView.editorFailed",
  );
}
