import { SIDE_PANEL_MIN_RESERVE } from "../../../shared/side-panel.js";
import { MIN_DOCKED_TRANSCRIPT_WIDTH, sidePanelLayout } from "../hooks/use-container-narrow.js";

export const CHAT_THUMBNAIL_WIDTH = 280;

export interface ChatColumnsVisibility {
  thumbnailHiddenForWidth: boolean;
  panelHiddenForWidth: boolean;
}

/** Preserve preferences while yielding columns, thumbnails first, to the transcript floor. */
export function chatColumnsLayout(width: number, thumbnailsOpen: boolean, panelOpen: boolean, panelWidth: number) {
  const panelVisible = panelOpen && width >= MIN_DOCKED_TRANSCRIPT_WIDTH + SIDE_PANEL_MIN_RESERVE;
  const thumbnailVisible = thumbnailsOpen && width >= MIN_DOCKED_TRANSCRIPT_WIDTH
    + CHAT_THUMBNAIL_WIDTH + (panelOpen ? SIDE_PANEL_MIN_RESERVE : 0);
  const panelLayout = sidePanelLayout(width - (thumbnailVisible ? CHAT_THUMBNAIL_WIDTH : 0), false);
  return {
    thumbnailVisible,
    panelVisible,
    thumbnailHiddenForWidth: thumbnailsOpen && !thumbnailVisible,
    panelHiddenForWidth: panelOpen && !panelVisible,
    panelLayout,
    panelWidth: Math.min(panelLayout.max, Math.max(panelLayout.min, panelWidth)),
  };
}
