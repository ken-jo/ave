import { describe, expect, it } from "vitest";
import { chatColumnsLayout, CHAT_THUMBNAIL_WIDTH } from "../chat-columns-layout.js";
import { MIN_DOCKED_TRANSCRIPT_WIDTH } from "../../hooks/use-container-narrow.js";
import { SIDE_PANEL_MIN_RESERVE } from "../../../../shared/side-panel.js";

describe("chat column geometry", () => {
  it("reserves independent columns and clamps a saved work width to leave the transcript floor", () => {
    for (const thumbnailsOpen of [false, true]) for (const panelOpen of [false, true]) {
      const layout = chatColumnsLayout(1400, thumbnailsOpen, panelOpen, 2000);
      expect(layout.thumbnailVisible).toBe(thumbnailsOpen);
      expect(layout.panelVisible).toBe(panelOpen);
      expect(layout.panelLayout.mode).toBe("docked");
      expect(1400 - (thumbnailsOpen ? CHAT_THUMBNAIL_WIDTH : 0) - layout.panelWidth)
        .toBe(MIN_DOCKED_TRANSCRIPT_WIDTH);
    }
  });

  it("yields thumbnails first, then the work panel, without an overlay", () => {
    const bothFloor = MIN_DOCKED_TRANSCRIPT_WIDTH + SIDE_PANEL_MIN_RESERVE + CHAT_THUMBNAIL_WIDTH;
    expect(chatColumnsLayout(bothFloor, true, true, 500).thumbnailVisible).toBe(true);
    const narrow = chatColumnsLayout(bothFloor - 1, true, true, 500);
    expect(narrow.thumbnailVisible).toBe(false);
    expect(narrow.panelVisible).toBe(true);
    const smallest = chatColumnsLayout(MIN_DOCKED_TRANSCRIPT_WIDTH + SIDE_PANEL_MIN_RESERVE - 1, true, true, 500);
    expect(smallest.thumbnailVisible).toBe(false);
    expect(smallest.panelVisible).toBe(false);
    expect(smallest.panelLayout.mode).toBe("docked");
    expect(chatColumnsLayout(bothFloor, true, true, 500).thumbnailVisible).toBe(true);
  });

  it("allows thumbnails alone when only their floor fits", () => {
    const width = MIN_DOCKED_TRANSCRIPT_WIDTH + CHAT_THUMBNAIL_WIDTH;
    expect(chatColumnsLayout(width, true, false, 500).thumbnailVisible).toBe(true);
    expect(chatColumnsLayout(width - 1, true, false, 500).thumbnailVisible).toBe(false);
  });
});
