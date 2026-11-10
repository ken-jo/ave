import { describe, expect, it } from "vitest";
import { BROWSER_NATIVE_CURSOR_MAX_BYTES, parseBrowserNativeInput, parseBrowserNativeInputState } from "../browser-native-input.js";
import { CURSOR_IMAGE_DATA_URL } from "../../__tests__/support/cursor-image.js";

const INPUT = { tabId: "browser:one", webContentsId: 9, epoch: 3, sequence: 1, type: "mouseDown", x: 150.5, y: 220,
  button: "left", clickCount: 1, modifiers: ["shift", "leftbuttondown"] };

describe("native browser pointer boundary", () => {
  it("copies only validated identity and pointer fields", () => {
    const result = parseBrowserNativeInput(INPUT);
    expect(result).toEqual(INPUT);
    expect(result?.modifiers).not.toBe(INPUT.modifiers);
    expect(parseBrowserNativeInput({ ...INPUT, windowId: 2 })).toBeNull();
  });

  it.each(["keyDown", "touchStart", "contextMenu", "focus"])("refuses %s outside the pointer protocol", type => {
    expect(parseBrowserNativeInput({ ...INPUT, type })).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1_000_001])("rejects unbounded coordinates %s", x => {
    expect(parseBrowserNativeInput({ ...INPUT, x })).toBeNull();
  });

  it.each([{ epoch: 0 }, { webContentsId: -1 }, { tabId: "" }, { button: "back" }, { clickCount: 4 },
    { modifiers: ["command"] }, { modifiers: ["shift", "shift"] }, { deltaX: 1 }])("refuses malformed authority or event fields %j", patch => {
    expect(parseBrowserNativeInput({ ...INPUT, ...patch })).toBeNull();
  });

  it("requires finite wheel deltas and rejects deltas on other events", () => {
    const input = { ...INPUT, type: "mouseWheel", deltaX: 2.5, deltaY: -120 };
    expect(parseBrowserNativeInput(input)).toEqual(input);
    expect(parseBrowserNativeInput({ ...input, deltaY: Infinity })).toBeNull();
    expect(parseBrowserNativeInput({ ...INPUT, type: "mouseWheel" })).toBeNull();
  });

  it("bounds capture cancellations and cursor updates without admitting arbitrary CSS", () => {
    const identity = { tabId: INPUT.tabId, webContentsId: INPUT.webContentsId, epoch: INPUT.epoch };
    expect(parseBrowserNativeInputState({ ...identity, type: "cancel", sequence: 4 })).toEqual({ ...identity, type: "cancel", sequence: 4 });
    expect(parseBrowserNativeInputState({ ...identity, type: "cancel", sequence: 0 })).toBeNull();
    expect(parseBrowserNativeInputState({ ...identity, type: "cursor", cursor: "text" })).toEqual({ ...identity, type: "cursor", cursor: "text" });
    expect(parseBrowserNativeInputState({ ...identity, type: "cursor", cursor: "url(file:///private/cursor.png),pointer" })).toBeNull();
    expect(parseBrowserNativeInputState({ ...identity, type: "cursor", cursor: "text", css: "color:red" })).toBeNull();
  });

  it("accepts only bounded custom cursor images and in-image hotspots", () => {
    const cursor = { tabId: INPUT.tabId, webContentsId: INPUT.webContentsId, epoch: INPUT.epoch,
      type: "custom-cursor", dataUrl: CURSOR_IMAGE_DATA_URL, width: 1, height: 1, hotspot: { x: 0, y: 0 } };
    expect(parseBrowserNativeInputState(cursor)).toEqual(cursor);
    for (const patch of [{ dataUrl: "https://example.invalid/cursor.png" }, { dataUrl: "data:image/svg+xml;base64,YQ==" },
      { dataUrl: `data:image/png;base64,${"Y".repeat(BROWSER_NATIVE_CURSOR_MAX_BYTES * 2)}` }, { width: 129 },
      { hotspot: { x: 1, y: 0 } }, { hotspot: { x: 1.5, y: 0 } }, { width: 2 }, { dataUrl: "data:image/png;base64,YQ==" }]) {
      expect(parseBrowserNativeInputState({ ...cursor, ...patch })).toBeNull();
    }
  });
});
