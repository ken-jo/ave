// Picking a path identifies user intent without widening the filesystem envelope; writes still require an existing grant. The host owns the native
// dialog and its title identifies the requesting plugin.
import { dialog } from "electron";
import type { BrowserWindow } from "electron";
import { t } from "../../i18n/index.js";

// What one plugin gets back. A cancel is an ANSWER, not a failure.
export interface PickFoldersResult {
  // True when the user dismissed the chooser without picking.
  readonly canceled: boolean;
  // Absolute paths the OS reported. Empty whenever `canceled`.
  readonly folders: readonly string[];
}

// What the picker needs from the host it runs in.
export interface PickFoldersDeps {
  // The window the sheet attaches to, or `null` for an unparented dialog.
  readonly parentWindow: () => BrowserWindow | null;
}

// Refuse a second chooser per plugin instead of queuing or replacing the user’s active dialog.
const inFlight = new Set<string>();

// Raised when a plugin asks for a second chooser while its first is open.
export class FolderPickerBusyError extends Error {
  constructor(pluginId: string) {
    super(`[pick-folders] ${pluginId} already has a folder chooser open`);
    this.name = "FolderPickerBusyError";
  }
}

/**
 * Show the user a folder chooser on one plugin's behalf.
 *
 * @param pluginId  the caller, closed over by the host-api factory and never
 *                  passed in by the plugin — a plugin that could name the
 *                  caller could attribute its dialog to a different one.
 */
export async function pickFoldersForPlugin(
  pluginId: string,
  deps: PickFoldersDeps,
): Promise<PickFoldersResult> {
  if (inFlight.has(pluginId)) throw new FolderPickerBusyError(pluginId);
  inFlight.add(pluginId);
  try {
    // Attribute the picker to the validated unique plugin ID, never the freely authored display name.
    const title = t("mainDialog.pluginPickFolderTitle", { plugin: pluginId });
    const parent = deps.parentWindow();
    // Parented where there is a window so the sheet belongs to it, unparented otherwise — an unparented chooser still works, and refusing to ask because no
    // window happens to be up would turn a UX detail into a failure.
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          title,
          properties: ["openDirectory", "multiSelections"],
        })
      : await dialog.showOpenDialog({
          title,
          properties: ["openDirectory", "multiSelections"],
        });
    // Electron reports a dismissal as `canceled`, and an empty selection is the same answer wearing different clothes — both mean the user named nothing.
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, folders: [] };
    }
    return { canceled: false, folders: [...result.filePaths] };
  } finally {
    inFlight.delete(pluginId);
  }
}

export function resetFolderPickersForTest(): void {
  inFlight.clear();
}
