import { SIDE_PANEL_MIN_RESERVE } from "../../../shared/side-panel.js";
import { MIN_DOCKED_TRANSCRIPT_WIDTH } from "../../../shared/shell-geometry.js";
import { sidePanelLayout } from "../hooks/use-container-narrow.js";

export const CHAT_THUMBNAIL_WIDTH = 280;

export interface ChatColumnsVisibility {
  thumbnailHiddenForWidth: boolean;
  panelHiddenForWidth: boolean;
}

/** Yield thumbnails to the transcript floor and keep a narrow panel inside its tile as an overlay. */
export function chatColumnsLayout(width: number, thumbnailsOpen: boolean, panelOpen: boolean, panelWidth: number, narrow: boolean) {
  const panelVisible = panelOpen;
  const thumbnailVisible = thumbnailsOpen && width >= MIN_DOCKED_TRANSCRIPT_WIDTH
    + CHAT_THUMBNAIL_WIDTH + (panelOpen ? SIDE_PANEL_MIN_RESERVE : 0);
  const panelLayout = sidePanelLayout(width - (thumbnailVisible ? CHAT_THUMBNAIL_WIDTH : 0), narrow);
  return {
    thumbnailVisible,
    panelVisible,
    thumbnailHiddenForWidth: thumbnailsOpen && !thumbnailVisible,
    panelHiddenForWidth: false,
    panelLayout,
    panelWidth: Math.min(panelLayout.max, Math.max(panelLayout.min, panelWidth)),
  };
}
