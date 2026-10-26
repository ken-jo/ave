import { useCallback, useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import {
  SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
  clampSidePanelSplitPercent,
} from "../../../shared/side-panel.js";

/** The `SystemSettings` fields that persist a workspace-rail vertical split. One per tab kind whose body is a
 * list-over-viewer layout. */
export type VerticalSplitStorageKey =
  | "sidePanelSplitPreviewPercent"
  | "sidePanelSplitSubagentPercent";

export interface UseVerticalSplitResult {
  /** Current TOP-pane percent (drag-live), clamped to the pane range. */
  topPercent: number;
  /** Update the percent during a drag / keyboard step — state only, no IPC. */
  setTopPercent: (percent: number) => void;
  /** Persist the percent to host settings (drag-end / keyboard step), guarded. */
  commitTopPercent: (percent: number) => void;
}

/** Persist split ratios independently from panel widths and keep drag cleanup refs separate; clamp both panes above zero. */
export function useVerticalSplit(
  api: AveApi,
  storageKey: VerticalSplitStorageKey,
): UseVerticalSplitResult {
  const [topPercent, setTopPercentState] = useState<number>(SIDE_PANEL_SPLIT_DEFAULT_PERCENT);
  const persistedRef = useRef<number>(SIDE_PANEL_SPLIT_DEFAULT_PERCENT);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const raw = settings?.system?.[storageKey];
        if (typeof raw === "number" && Number.isFinite(raw)) {
          const clamped = clampSidePanelSplitPercent(raw);
          persistedRef.current = clamped;
          setTopPercentState(clamped);
        }
      })
      .catch(() => {
        // Non-fatal: keep the default; the next commit persists.
      });
    return () => {
      cancelled = true;
    };
  }, [api, storageKey]);

  const setTopPercent = useCallback((percent: number) => {
    setTopPercentState(clampSidePanelSplitPercent(percent));
  }, []);

  const commitTopPercent = useCallback(
    (percent: number) => {
      const clamped = clampSidePanelSplitPercent(percent);
      if (clamped === persistedRef.current) return;
      persistedRef.current = clamped;
      void api.updateSettings({ system: { [storageKey]: clamped } });
    },
    [api, storageKey],
  );

  return { topPercent, setTopPercent, commitTopPercent };
}
