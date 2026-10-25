/** Keep applySnapshot referentially stable to avoid resubscribing and re-seeding on every render; follow broadcasts after
 * the initial snapshot. */
import { useEffect } from "react";
import type { AppSettings, AveApi } from "../types.js";

export type SettingsSnapshotApi = Pick<AveApi, "getSettings" | "onSettingsUpdated">;

export function useSettingsSnapshot(
  api: SettingsSnapshotApi,
  applySnapshot: (settings: AppSettings) => void,
): void {
  useEffect(() => {
    let alive = true;
    void api.getSettings().then((s) => { if (alive) applySnapshot(s); });
    const unsub = api.onSettingsUpdated((s) => applySnapshot(s));
    return () => { alive = false; unsub(); };
  }, [api, applySnapshot]);
}
