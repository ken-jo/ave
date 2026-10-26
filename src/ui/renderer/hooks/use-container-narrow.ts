import { useEffect, useState } from "react";
import { SIDE_PANEL_MIN_RESERVE } from "../../../shared/side-panel.js";
import { DOCK_ENTER_WIDTH, DOCK_EXIT_WIDTH, MIN_DOCKED_TRANSCRIPT_WIDTH } from "../../../shared/shell-geometry.js";

export interface UseContainerNarrowResult {
  /** True below the enter threshold, until the width reaches the exit threshold. */
  isNarrow: boolean;
  /** Latest observed content-box inline size (px); Infinity until first measure. */
  width: number;
}

type SidePanelLayoutMode = "docked" | "overlay";

export interface SidePanelLayout {
  /**
   * The panel is the same raised card in both — the floating sidebar's shape.
   * `docked`: the card is a column beside the transcript and pushes it.
   * `overlay`: the container cannot hold both pixel floors, so the card keeps
   * its own floor and floats over the transcript's right edge inside the
   * container — the transcript keeps its layout underneath instead of being
   * crushed into a strip nobody could use. Never a window-level sheet.
   */
  mode: SidePanelLayoutMode;
  /** The range the split bar moves in. */
  min: number;
  max: number;
}

/** Use the shared hysteresis verdict for panel layout; unmeasured Infinity containers dock at pixel floors. */
export function sidePanelLayout(width: number, narrow: boolean): SidePanelLayout {
  if (!Number.isFinite(width)) return { mode: "docked", min: SIDE_PANEL_MIN_RESERVE, max: Number.POSITIVE_INFINITY };
  if (!narrow) {
    return { mode: "docked", min: SIDE_PANEL_MIN_RESERVE, max: Math.max(SIDE_PANEL_MIN_RESERVE, width - MIN_DOCKED_TRANSCRIPT_WIDTH) };
  }
  return { mode: "overlay", min: Math.min(SIDE_PANEL_MIN_RESERVE, width), max: width };
}

/** Observe a state-held parent node so replacements reconnect after subtree recovery; layout decisions cannot change their
 * own measurement. Use a 60px hysteresis band and treat missing ResizeObserver as unmeasured wide layout. */
export function useContainerNarrow(
  element: HTMLElement | null,
  { enter = DOCK_ENTER_WIDTH, exit = DOCK_EXIT_WIDTH }: { enter?: number; exit?: number } = {},
): UseContainerNarrowResult {
  const [state, setState] = useState<UseContainerNarrowResult>({ isNarrow: false, width: Infinity });

  useEffect(() => {
    const ResizeObserverImpl = typeof window !== "undefined" ? window.ResizeObserver : undefined;
    if (!element || typeof ResizeObserverImpl !== "function") return;
    let active = true;
    const observer = new ResizeObserverImpl((entries) => {
      if (!active) return;
      const entry = entries[0];
      const width = entry?.contentBoxSize?.[0]?.inlineSize ?? entry?.contentRect.width ?? Infinity;
      setState((prev) => ({
        width,
        isNarrow: prev.isNarrow ? width < exit : width < enter,
      }));
    });
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [element, enter, exit]);

  return state;
}
