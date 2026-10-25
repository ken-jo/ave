import { useEffect, useState, type RefObject } from "react";
import { SIDE_PANEL_MIN_RESERVE } from "../../../shared/side-panel.js";

export interface UseContainerNarrowResult {
  /** True when the observed container is too narrow to dock the side panel. */
  isNarrow: boolean;
  /** Latest observed content-box inline size (px); Infinity until first measure. */
  width: number;
}

/**
 * Minimum transcript column width that must survive beside the docked side
 * panel (card plus its insets) for docking to be usable. Below this the panel would crush the chat
 * transcript, so the panel floats over it instead; at or above it both panes
 * stay interactive side by side.
 */
export const MIN_DOCKED_TRANSCRIPT_WIDTH = 320;

/** Derive docking from panel reserve plus transcript floor so chat-mode reserved window space can dock without a spurious
 * overlay. */
export const DOCK_ENTER_WIDTH = SIDE_PANEL_MIN_RESERVE + MIN_DOCKED_TRANSCRIPT_WIDTH;
/** Every narrow threshold exits this much above where it enters, so a drag that hovers on the boundary cannot flip-flop the
 * layout. */
const NARROW_DEAD_BAND_PX = 60;
export const DOCK_EXIT_WIDTH = DOCK_ENTER_WIDTH + NARROW_DEAD_BAND_PX;

/** Settings panel width below which its sidebar + content master-detail is too cramped and collapses to a two-depth stack
 * (≈ Tailwind `sm`). Panel width, not viewport: the inline Settings panel can be narrow on a wide display. */
export const SETTINGS_NARROW_ENTER_WIDTH = 640;
export const SETTINGS_NARROW_EXIT_WIDTH = SETTINGS_NARROW_ENTER_WIDTH + NARROW_DEAD_BAND_PX;

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

/** Observe the parent so layout decisions cannot change their own measurement; use a 60px hysteresis band and treat missing
 * ResizeObserver as unmeasured wide layout. */
export function useContainerNarrow(
  ref: RefObject<HTMLElement | null>,
  { enter = DOCK_ENTER_WIDTH, exit = DOCK_EXIT_WIDTH }: { enter?: number; exit?: number } = {},
): UseContainerNarrowResult {
  const [state, setState] = useState<UseContainerNarrowResult>({ isNarrow: false, width: Infinity });

  useEffect(() => {
    const el = ref.current;
    const ResizeObserverImpl = typeof window !== "undefined" ? window.ResizeObserver : undefined;
    if (!el || typeof ResizeObserverImpl !== "function") return;
    const observer = new ResizeObserverImpl((entries) => {
      const entry = entries[0];
      const width = entry?.contentBoxSize?.[0]?.inlineSize ?? entry?.contentRect.width ?? Infinity;
      setState((prev) => ({
        width,
        isNarrow: prev.isNarrow ? width < exit : width < enter,
      }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enter, exit]);

  return state;
}
