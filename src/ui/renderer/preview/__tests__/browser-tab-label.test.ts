import { describe, expect, it } from "vitest";
import { browserTabFavicon, browserTabLabel } from "../browser-tab-label.js";
import { noteWebSurfaceFavicon, noteWebSurfaceLocation, noteWebSurfaceTitle } from "../web-surfaces.js";

describe("browser tab label", () => {
  it("names a tab by its page title, then by its host, and only then by the fallback", () => {
    expect(browserTabLabel("browser:label-1", "Browser")).toBe("Browser");
    expect(browserTabLabel("browser:label-1", "Browser", "https://docs.example/guide")).toBe("docs.example");
    expect(browserTabLabel("browser:label-1", "Browser", "about:blank")).toBe("Browser");
    noteWebSurfaceLocation("browser:label-1", "https://shop.example/cart");
    expect(browserTabLabel("browser:label-1", "Browser", "https://docs.example/guide")).toBe("shop.example");
    noteWebSurfaceTitle("browser:label-1", "  Your cart  ");
    expect(browserTabLabel("browser:label-1", "Browser")).toBe("Your cart");
    noteWebSurfaceTitle("browser:label-1", "about:blank");
    expect(browserTabLabel("browser:label-1", "Browser")).toBe("shop.example");
  });
  it("shows only an icon the host may load", () => {
    expect(browserTabFavicon("browser:label-2")).toBeNull();
    noteWebSurfaceFavicon("browser:label-2", "javascript:alert(1)");
    expect(browserTabFavicon("browser:label-2")).toBeNull();
    // A network address is not loaded by the host's own page; only image data the page handed over is.
    noteWebSurfaceFavicon("browser:label-2", "https://shop.example/favicon.ico");
    expect(browserTabFavicon("browser:label-2")).toBeNull();
    noteWebSurfaceFavicon("browser:label-2", "data:image/png;base64,AAAA");
    expect(browserTabFavicon("browser:label-2")).toBe("data:image/png;base64,AAAA");
  });
});
