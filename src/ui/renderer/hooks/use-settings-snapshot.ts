/** Keep applySnapshot referentially stable to avoid resubscribing and re-seeding on every render; follow broadcasts after
 * the initial snapshot. */
import { useEffect } from "react";
import { useSettingsEditor } from "../context/SettingsEditorContext.js";
import type { AppSettings, AveApi } from "../types.js";

export type SettingsSnapshotApi = Pick<AveApi, "getSettings" | "onSettingsUpdated">;

export function useSettingsSnapshot(
  api: SettingsSnapshotApi,
  applySnapshot: (settings: AppSettings) => void,
): void {
  // Inside the settings view the editor already reads and follows the settings document; a section that mounts there, by
  // being opened or by a search that shows every panel, takes the editor's copy instead of reading the document again.
  const editor = useSettingsEditor();
  const inEditor = editor !== null;
  const editorSettings = editor?.settings ?? null;
  useEffect(() => {
    if (inEditor) {
      if (editorSettings) applySnapshot(editorSettings);
      return;
    }
    let alive = true;
    void api.getSettings().then((s) => { if (alive) applySnapshot(s); });
    const unsub = api.onSettingsUpdated((s) => applySnapshot(s));
    return () => { alive = false; unsub(); };
  }, [api, applySnapshot, inEditor, editorSettings]);
}
