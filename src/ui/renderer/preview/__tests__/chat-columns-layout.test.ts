import { describe, expect, it } from "vitest";
import { chatColumnsLayout, CHAT_THUMBNAIL_WIDTH } from "../chat-columns-layout.js";
import { DOCK_ENTER_WIDTH, MIN_DOCKED_TRANSCRIPT_WIDTH } from "../../../../shared/shell-geometry.js";
import { SIDE_PANEL_MIN_RESERVE } from "../../../../shared/side-panel.js";

describe("chat column geometry", () => {
  it("keeps a requested panel visible as an overlay when its dock cannot fit", () => {
    for (const width of [360, 600, DOCK_ENTER_WIDTH - 1]) {
      const layout = chatColumnsLayout(width, true, true, 500, true);
      expect(layout).toMatchObject({
        panelVisible: true, thumbnailVisible: false, panelHiddenForWidth: false, thumbnailHiddenForWidth: true,
        panelLayout: { mode: "overlay" },
      });
      expect(layout.panelWidth).toBeLessThanOrEqual(width);
    }
  });

  it("honors the observed hysteresis verdict within the docking dead band", () => {
    const width = DOCK_ENTER_WIDTH + 20;
    expect(chatColumnsLayout(width, false, true, 500, true).panelLayout.mode).toBe("overlay");
    expect(chatColumnsLayout(width, false, true, 500, false).panelLayout.mode).toBe("docked");
  });

  it("reserves independent columns and clamps a saved panel width to leave the transcript floor", () => {
    for (const thumbnailsOpen of [false, true]) for (const panelOpen of [false, true]) {
      const layout = chatColumnsLayout(1400, thumbnailsOpen, panelOpen, 2000, false);
      expect(layout.thumbnailVisible).toBe(thumbnailsOpen);
      expect(layout.panelVisible).toBe(panelOpen);
      expect(layout.panelLayout.mode).toBe("docked");
      expect(1400 - (thumbnailsOpen ? CHAT_THUMBNAIL_WIDTH : 0) - layout.panelWidth)
        .toBe(MIN_DOCKED_TRANSCRIPT_WIDTH);
    }
  });

  it("yields thumbnails before replacing the panel dock with an overlay", () => {
    const bothFloor = MIN_DOCKED_TRANSCRIPT_WIDTH + SIDE_PANEL_MIN_RESERVE + CHAT_THUMBNAIL_WIDTH;
    expect(chatColumnsLayout(bothFloor, true, true, 500, false).thumbnailVisible).toBe(true);
    const narrow = chatColumnsLayout(bothFloor - 1, true, true, 500, false);
    expect(narrow.thumbnailVisible).toBe(false);
    expect(narrow.panelVisible).toBe(true);
    expect(narrow.panelLayout.mode).toBe("docked");
    const smallest = chatColumnsLayout(DOCK_ENTER_WIDTH - 1, true, true, 500, true);
    expect(smallest.thumbnailVisible).toBe(false);
    expect(smallest.panelVisible).toBe(true);
    expect(smallest.panelLayout.mode).toBe("overlay");
    expect(chatColumnsLayout(bothFloor, true, true, 500, false).thumbnailVisible).toBe(true);
  });

  it("allows thumbnails alone when only their floor fits", () => {
    const width = MIN_DOCKED_TRANSCRIPT_WIDTH + CHAT_THUMBNAIL_WIDTH;
    expect(chatColumnsLayout(width, true, false, 500, true).thumbnailVisible).toBe(true);
    expect(chatColumnsLayout(width - 1, true, false, 500, true).thumbnailVisible).toBe(false);
  });

  it("keeps closed columns closed without width warnings", () => {
    expect(chatColumnsLayout(360, false, false, 500, true)).toMatchObject({
      panelVisible: false, thumbnailVisible: false, panelHiddenForWidth: false, thumbnailHiddenForWidth: false,
    });
  });
});
