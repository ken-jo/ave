import { describe, expect, it } from "vitest";
import { BROWSER_FAVICON_DATA_URL, browserControlFixture } from "../../__tests__/support/browser-control-fixture.js";
import { BROWSER_FAVICON_LIMITS, isBrowserFaviconDataUrl, parseBrowserTabControlState } from "../browser-surface.js";

describe("browser favicon snapshot validation", () => {
  it("accepts a small PNG and rejects remote, active, malformed and oversized data", () => {
    expect(isBrowserFaviconDataUrl(BROWSER_FAVICON_DATA_URL)).toBe(true);
    for (const value of [undefined, "https://example.test/favicon.png", "file:///icon.png", "data:image/svg+xml,<svg/>",
      "data:image/png;base64,broken", `data:image/png;base64,${"A".repeat(BROWSER_FAVICON_LIMITS.dataUrlBytes)}`]) {
      expect(isBrowserFaviconDataUrl(value)).toBe(false);
    }
    for (const width of [0, BROWSER_FAVICON_LIMITS.dimension + 1]) {
      const bytes = Buffer.from(BROWSER_FAVICON_DATA_URL.split(",")[1]!, "base64");
      bytes.writeUInt32BE(width, 16);
      expect(isBrowserFaviconDataUrl(`data:image/png;base64,${bytes.toString("base64")}`)).toBe(false);
    }
  });

  it("requires the bounded metadata field on every tab in the existing snapshot", () => {
    const state = browserControlFixture(["browser:one"]);
    for (const faviconDataUrl of [null, BROWSER_FAVICON_DATA_URL]) {
      const candidate = { ...state, tabs: state.tabs.map((tab) => ({ ...tab, faviconDataUrl })) };
      expect(parseBrowserTabControlState(candidate)).toEqual(candidate);
    }
    for (const faviconDataUrl of [undefined, "https://example.test/icon.png", "data:image/svg+xml,<svg/>"]) {
      expect(parseBrowserTabControlState({ ...state, tabs: state.tabs.map((tab) => ({ ...tab, faviconDataUrl })) })).toBeNull();
    }
  });
});
