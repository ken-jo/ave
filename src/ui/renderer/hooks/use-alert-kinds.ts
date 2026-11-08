import { useCallback, useEffect, useRef, useState } from "react";
import type { AlertKindRow } from "../../../shared/alerts-types.js";
import type { AveApi } from "../types.js";

/** Fetch after subscribing, and discard responses superseded by a newer read. */
export function useAlertKinds(api: AveApi | null | undefined) {
  const [rows, setRows] = useState<AlertKindRow[]>([]);
  const [osEnabled, setOsEnabled] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!api?.alerts) return;
    const request = ++generation.current;
    try {
      const [kinds, settings] = await Promise.all([api.alerts.listKinds(), api.getSettings()]);
      if (request !== generation.current) return;
      if (!Array.isArray(kinds)) throw new Error("Invalid alert kinds response");
      setRows(kinds);
      setOsEnabled(settings.alerts.osNotificationsEnabled);
      setFailed(false);
      setLoaded(true);
    } catch {
      if (request === generation.current) setFailed(true);
    }
  }, [api]);
  useEffect(() => {
    const unsubscribe = api?.alerts?.onKindsChanged(() => void refresh());
    void refresh();
    return () => { ++generation.current; unsubscribe?.(); };
  }, [api, refresh]);
  return { rows, osEnabled, failed, loaded, refresh };
}
