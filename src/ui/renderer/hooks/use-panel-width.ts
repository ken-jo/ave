import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, DeepPartial, AveApi } from "../types.js";
import { isIpcErrorResult } from "../types.js";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDE_PANEL_DEFAULT_WIDTH,
  clampSidebarWidth,
  FILE_TREE_DEFAULT_WIDTH,
  clampFileTreeWidth,
} from "../../../shared/side-panel.js";

/** The `SystemSettings` numeric keys that hold a durable panel width (px). */
type PanelWidthSettingsKey = "sidebarWidth" | "sidePanelWidth" | "sidePanelFileTreeWidth";

type SystemPatch = NonNullable<DeepPartial<AppSettings>["system"]>;

/** Per-panel configuration for {@link usePanelWidth}; shell panels and workspace columns share the persistence lifecycle. */
export interface PanelWidthPref {
  /** `SystemSettings` key this width is seeded from and persisted to. */
  readonly settingsKey: PanelWidthSettingsKey;
  /** Width used before the settings seed lands, and when it is absent/invalid. */
  readonly defaultWidth: number;
  /**
   * Applied to every value entering state or persistence. The sidebar has a
   * fixed [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH] box, so it clamps here; the
   * side panel's ceiling is viewport-relative and is enforced by
   * `useEdgeResize`'s live `max` instead, so it passes values through.
   */
  readonly clamp: (px: number) => number;
  /**
   * Whether `commitWidth` also pushes the value into state. The sidebar's
   * commit is self-sufficient (keyboard steps and double-click reset call only
   * commit); the side panel's owner re-emits `setWidth` alongside every commit,
   * so its commit is persist-only.
   */
  readonly commitUpdatesState: boolean;
}

/** Pass-through clamp for a panel whose bounds are enforced by the resize primitive. */
function passThroughWidth(px: number): number {
  return px;
}

/** Primary (left) navigation sidebar. Width is clamped to the fixed [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH] box by the
 * shared `clampSidebarWidth`, matching the settings-store validation floor/ceiling. */
export const SIDEBAR_WIDTH_PREF: PanelWidthPref = {
  settingsKey: "sidebarWidth",
  defaultWidth: SIDEBAR_DEFAULT_WIDTH,
  clamp: clampSidebarWidth,
  commitUpdatesState: true,
};

/** Right-docked ChatSidePanel. Bounds live in the `EdgeResizeBar` wiring (`sidePanelLayout`'s range for the tile) rather
 * than here, so this pref clamps nothing and its commit is persist-only. */
export const SIDE_PANEL_WIDTH_PREF: PanelWidthPref = {
  settingsKey: "sidePanelWidth",
  defaultWidth: SIDE_PANEL_DEFAULT_WIDTH,
  clamp: passThroughWidth,
  commitUpdatesState: false,
};

export const FILE_TREE_WIDTH_PREF: PanelWidthPref = {
  settingsKey: "sidePanelFileTreeWidth",
  defaultWidth: FILE_TREE_DEFAULT_WIDTH,
  clamp: clampFileTreeWidth,
  commitUpdatesState: true,
};

export interface UsePanelWidthResult {
  /** Current panel width in px (drag-live). */
  width: number;
  /** Update width during a drag — state only, no IPC (per-move). */
  setWidth: (px: number) => void;
  /** Persist width to host settings (drag-end / keyboard step / double-click reset — the shared EdgeResizeBar commits its
   * reset width through this same setter), no-op guarded. */
  commitWidth: (px: number) => void;
}

/** Persist width only on release, keyboard change or reset with no-op guards; per-move updates remain local. */
export function usePanelWidth(api: AveApi, pref: PanelWidthPref): UsePanelWidthResult {
  const [width, setWidthState] = useState<number>(pref.defaultWidth);
  const persistedRef = useRef<number | undefined>(pref.defaultWidth);
  const requestRef = useRef(0);

  useEffect(() => {
    requestRef.current++;
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const seeded = settings?.system?.[pref.settingsKey];
        if (typeof seeded === "number" && Number.isFinite(seeded)) {
          const clamped = pref.clamp(seeded);
          persistedRef.current = clamped;
          setWidthState(clamped);
        }
      })
      .catch(() => {
        // Non-fatal: fall back to the default width. The next commit persists.
      });
    return () => {
      cancelled = true;
      requestRef.current++;
    };
  }, [api, pref]);

  const setWidth = useCallback(
    (px: number) => {
      setWidthState(pref.clamp(px));
    },
    [pref],
  );

  const commitWidth = useCallback(
    (px: number) => {
      const clamped = pref.clamp(px);
      if (pref.commitUpdatesState) setWidthState(clamped);
      if (clamped === persistedRef.current) return;
      persistedRef.current = clamped;
      const request = ++requestRef.current;
      const patch: SystemPatch = {};
      patch[pref.settingsKey] = clamped;
      const releaseFailedSave = () => {
        // Keep the local column position, but allow a retry after a refused or failed save.
        if (requestRef.current === request) persistedRef.current = undefined;
      };
      void api.updateSettings({ system: patch }).then((result) => {
        if (isIpcErrorResult(result)) releaseFailedSave();
      }, releaseFailedSave);
    },
    [api, pref],
  );

  return { width, setWidth, commitWidth };
}
