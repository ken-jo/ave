// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// Mock the top-level runtime import; the protocol gate prevents the preload IIFE from running in jsdom.
vi.mock("electron", () => ({ ipcRenderer: { on: vi.fn(), sendToHost: vi.fn() } }));

import { createInnerAppFrame, readHostDeclaredAllow } from "../mcp-app-preload.js";
import { INNER_SANDBOX_ATTR, MCP_APP_ALLOW_META_NAME } from "../shared/mcp-app-bridge-contract.js";

describe("mcp-app-preload — the inner iframe containment flags are host-owned", () => {
  it("always sets the spec sandbox pair `allow-scripts allow-same-origin` (constant)", () => {
    const frame = createInnerAppFrame(document, "<h1>app</h1>");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.getAttribute("sandbox")).toBe(INNER_SANDBOX_ATTR);
    expect(frame.srcdoc).toBe("<h1>app</h1>");
  });

  it("sets the `allow` attribute from the HOST-computed value, and omits it when empty", () => {
    const withAllow = createInnerAppFrame(document, "<h1>app</h1>", "geolocation");
    expect(withAllow.getAttribute("allow")).toBe("geolocation");

    // An absent allow-list must delegate no frame features.
    const noAllow = createInnerAppFrame(document, "<h1>app</h1>");
    expect(noAllow.hasAttribute("allow")).toBe(false);
  });

  it("neither containment flag is influenced by wire input — both are host-owned", () => {
    // Wire HTML must affect neither the constant sandbox nor the host-computed allow-list.
    const a = createInnerAppFrame(document, "<p>a</p>", "geolocation");
    const b = createInnerAppFrame(document, "<p>b</p>", "geolocation");
    expect(a.getAttribute("sandbox")).toBe(b.getAttribute("sandbox"));
    expect(a.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(a.getAttribute("allow")).toBe(b.getAttribute("allow"));
  });
});

describe("mcp-app-preload — readHostDeclaredAllow reads the host-served meta, not the wire", () => {
  it("returns the meta content when present, empty string when absent", () => {
    const doc = document.implementation.createHTMLDocument("proxy");
    expect(readHostDeclaredAllow(doc)).toBe("");

    const meta = doc.createElement("meta");
    meta.setAttribute("name", MCP_APP_ALLOW_META_NAME);
    meta.setAttribute("content", "camera; microphone; geolocation");
    doc.head.appendChild(meta);
    expect(readHostDeclaredAllow(doc)).toBe("camera; microphone; geolocation");
  });
});
